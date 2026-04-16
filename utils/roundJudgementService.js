const mongoose = require('mongoose');
const CompetitionRound = require('../models/CompetitionRound');
const RoundSnapshot = require('../models/RoundSnapshot');
const RoundChunk = require('../models/RoundChunk');
const QuotaRule = require('../models/QuotaRule');
const Quota = require('../models/Quota');
const Submission = require('../models/Submission');
const Evaluation = require('../models/Evaluation');
const User = require('../models/User');
const SubmissionAssignment = require('../models/SubmissionAssignment');
const AreaLeaderboard = require('../models/AreaLeaderboard');
const PromotionRecord = require('../models/PromotionRecord');
const { getAdminScope } = require('./adminScope');
const { resolveSubmissionRoundContext, isRoundActionable } = require('./roundContext');

const ROUND_LEVELS = ['Council', 'Regional', 'National'];
const NEXT_LEVEL = {
  Council: 'Regional',
  Regional: 'National',
  National: null
};

const hasSubmissionVideo = (submission) => {
  const videoCandidates = [
    submission.videoFileUrl,
    submission.videoLink,
    submission.preferredLink
  ];
  return videoCandidates.some((value) => typeof value === 'string' && value.trim().length > 0);
};

const getAreaTypeForLevel = (level) => {
  if (level === 'Council') return 'council';
  if (level === 'Regional') return 'region';
  return 'national';
};

const buildAreaId = (level, region, council) => {
  if (level === 'Council') return `${region || 'unknown'}::${council || 'unknown'}`;
  if (level === 'Regional') return region || 'unknown';
  return 'national';
};

const parseAreaId = (level, areaId) => {
  if (level === 'Council') {
    const [region, council] = String(areaId || '').split('::');
    return { region: region || null, council: council || null };
  }
  if (level === 'Regional') {
    return { region: areaId || null, council: null };
  }
  return { region: null, council: null };
};

const buildAreaQuery = (level, areaId) => {
  const { region, council } = parseAreaId(level, areaId);
  const query = {};
  if (level === 'Council') {
    query.region = region;
    query.council = council;
  } else if (level === 'Regional') {
    query.region = region;
  }
  return query;
};

const deterministicRankSort = (a, b) => {
  const aScore = typeof a.averageScore === 'number' ? a.averageScore : 0;
  const bScore = typeof b.averageScore === 'number' ? b.averageScore : 0;
  if (bScore !== aScore) return bScore - aScore;

  const aEvaluations = typeof a.totalEvaluations === 'number' ? a.totalEvaluations : 0;
  const bEvaluations = typeof b.totalEvaluations === 'number' ? b.totalEvaluations : 0;
  if (bEvaluations !== aEvaluations) return bEvaluations - aEvaluations;

  const aCreatedAt = a.tieBreakCreatedAt ? new Date(a.tieBreakCreatedAt).getTime() : Number.MAX_SAFE_INTEGER;
  const bCreatedAt = b.tieBreakCreatedAt ? new Date(b.tieBreakCreatedAt).getTime() : Number.MAX_SAFE_INTEGER;
  if (aCreatedAt !== bCreatedAt) return aCreatedAt - bCreatedAt;

  const aSubmissionId = String(a.submissionId || '');
  const bSubmissionId = String(b.submissionId || '');
  return aSubmissionId.localeCompare(bSubmissionId);
};

const rankEntriesDeterministically = (entries) => {
  const rankedEntries = [...entries].sort(deterministicRankSort);
  rankedEntries.forEach((entry, index) => {
    entry.rank = index + 1;
  });
  return rankedEntries;
};

const getNextLevel = (level) => NEXT_LEVEL[level] || null;

const getRoundSnapshot = async (roundId) => {
  return RoundSnapshot.findOne({ roundId });
};

const getChunksForArea = async (roundId, areaType, areaId) => {
  if (!areaType || areaType === 'national') return [];
  const now = new Date();
  return RoundChunk.find({
    roundId,
    areaType,
    isActive: true,
    areas: areaId,
    $and: [
      {
        $or: [
          { scheduledActivationTime: null },
          { scheduledActivationTime: { $lte: now } }
        ]
      },
      {
        $or: [
          { scheduledEndTime: null },
          { scheduledEndTime: { $gt: now } }
        ]
      }
    ]
  }).select('_id name areaType areas scheduledActivationTime scheduledEndTime');
};

const getChunkActivationTime = (chunk) => {
  if (!chunk || !chunk.scheduledActivationTime) return null;
  const value = new Date(chunk.scheduledActivationTime);
  return Number.isNaN(value.getTime()) ? null : value;
};

const getChunkEndTime = (chunk) => {
  if (!chunk || !chunk.scheduledEndTime) return null;
  const value = new Date(chunk.scheduledEndTime);
  return Number.isNaN(value.getTime()) ? null : value;
};

const isChunkActiveAtTime = (chunk, now = new Date()) => {
  if (!chunk || chunk.isActive === false) return false;
  const activationTime = getChunkActivationTime(chunk);
  const endTime = getChunkEndTime(chunk);
  if (activationTime && activationTime > now) return false;
  if (endTime && endTime <= now) return false;
  return true;
};

const isChunkDueForActivation = (chunk, now = new Date()) => {
  return isChunkActiveAtTime(chunk, now);
};

const buildChunkAreaSet = (chunks = []) => {
  const set = new Set();
  for (const chunk of chunks) {
    for (const area of chunk.areas || []) {
      const normalized = String(area || '').trim();
      if (normalized) set.add(normalized);
    }
  }
  return set;
};

const ensureChunkAreasDoNotOverlap = async (roundId, areaType) => {
  if (!['council', 'region'].includes(areaType)) {
    return { valid: true };
  }

  const chunks = await RoundChunk.find({ roundId, areaType, isActive: true }).lean();
  const seen = new Map();
  for (const chunk of chunks) {
    for (const area of chunk.areas || []) {
      if (!area) continue;
      const key = String(area).trim();
      if (!key) continue;
      if (seen.has(key)) {
        return {
          valid: false,
          area: key,
          existingChunk: seen.get(key),
          conflictingChunk: chunk.name
        };
      }
      seen.set(key, chunk.name);
    }
  }
  return { valid: true };
};

const resolveQuotaForArea = async ({ round, areaId, areaType }) => {
  const level = round.level;
  const defaultResult = { quota: 0, sourceType: 'none', sourceId: null };

  const areaRule = await QuotaRule.findOne({
    roundId: round._id,
    level,
    scopeType: 'area',
    scopeId: areaId,
    isActive: true
  }).sort({ priority: -1, createdAt: -1 });
  if (areaRule) {
    return {
      quota: areaRule.quota,
      sourceType: 'area',
      sourceId: areaRule.scopeId
    };
  }

  const chunks = await getChunksForArea(round._id, areaType, areaId);
  if (chunks.length > 0) {
    const chunkIds = chunks.map((chunk) => String(chunk._id));
    const chunkRule = await QuotaRule.findOne({
      roundId: round._id,
      level,
      scopeType: 'chunk',
      scopeId: { $in: chunkIds },
      isActive: true
    }).sort({ priority: -1, createdAt: -1 });
    if (chunkRule) {
      return {
        quota: chunkRule.quota,
        sourceType: 'chunk',
        sourceId: chunkRule.scopeId
      };
    }
  }

  const levelRule = await QuotaRule.findOne({
    roundId: round._id,
    level,
    scopeType: 'level',
    scopeId: 'default',
    isActive: true
  }).sort({ priority: -1, createdAt: -1 });
  if (levelRule) {
    return {
      quota: levelRule.quota,
      sourceType: 'level',
      sourceId: levelRule.scopeId
    };
  }

  const legacyQuota = await Quota.findOne({ year: round.year, level });
  if (legacyQuota) {
    return {
      quota: legacyQuota.quota,
      sourceType: 'level',
      sourceId: 'legacy'
    };
  }

  return defaultResult;
};

const buildActivationSubmissionQuery = (round) => {
  return {
    year: round.year,
    level: round.level,
    disqualified: { $ne: true },
    status: { $nin: ['eliminated', 'promoted'] }
  };
};

const getSubmissionAreaDescriptor = (level, submission) => {
  const areaId = buildAreaId(level, submission.region, submission.council);
  const areaType = getAreaTypeForLevel(level);
  return {
    areaId,
    areaType,
    region: submission.region || null,
    council: submission.council || null
  };
};

const assignRoundSubmissionsToJudges = async (round, submissions) => {
  if (!['Council', 'Regional'].includes(round.level)) {
    return { assigned: 0, unassigned: 0 };
  }

  const judgeQuery = {
    role: 'judge',
    status: 'active',
    assignedLevel: round.level
  };
  const judges = await User.find(judgeQuery).select('_id assignedRegion assignedCouncil');
  if (judges.length === 0) {
    return { assigned: 0, unassigned: submissions.length };
  }

  const judgesByArea = new Map();
  for (const judge of judges) {
    const judgeAreaId = buildAreaId(round.level, judge.assignedRegion, judge.assignedCouncil);
    if (!judgesByArea.has(judgeAreaId)) judgesByArea.set(judgeAreaId, []);
    judgesByArea.get(judgeAreaId).push(judge);
  }

  const submissionIds = submissions.map((submission) => submission._id);
  const existingAssignments = await SubmissionAssignment.find({
    roundId: round._id,
    submissionId: { $in: submissionIds }
  }).select('submissionId judgeId');
  const assignedSubmissionSet = new Set(existingAssignments.map((assignment) => String(assignment.submissionId)));

  const assignmentCountMap = new Map();
  for (const assignment of existingAssignments) {
    const key = String(assignment.judgeId);
    assignmentCountMap.set(key, (assignmentCountMap.get(key) || 0) + 1);
  }

  const newAssignments = [];
  let unassigned = 0;

  for (const submission of submissions) {
    if (assignedSubmissionSet.has(String(submission._id))) {
      continue;
    }

    const areaId = buildAreaId(round.level, submission.region, submission.council);
    const areaJudges = judgesByArea.get(areaId) || [];
    if (areaJudges.length === 0) {
      unassigned += 1;
      continue;
    }

    let selectedJudge = areaJudges[0];
    let minAssignments = assignmentCountMap.get(String(selectedJudge._id)) || 0;
    for (const judge of areaJudges) {
      const judgeCount = assignmentCountMap.get(String(judge._id)) || 0;
      if (judgeCount < minAssignments) {
        minAssignments = judgeCount;
        selectedJudge = judge;
      }
    }

    newAssignments.push({
      roundId: round._id,
      submissionId: submission._id,
      judgeId: selectedJudge._id,
      level: round.level,
      region: submission.region,
      council: submission.council || null,
      judgeNotified: false
    });
    assignmentCountMap.set(String(selectedJudge._id), minAssignments + 1);
  }

  if (newAssignments.length > 0) {
    await SubmissionAssignment.insertMany(newAssignments, { ordered: false });
  }

  return { assigned: newAssignments.length, unassigned };
};

const activateRoundWithSnapshot = async (roundId, activatedBy) => {
  const round = await CompetitionRound.findById(roundId);
  if (!round) {
    return { success: false, status: 404, message: 'Competition round not found' };
  }

  if (!['draft', 'pending'].includes(round.status)) {
    return { success: false, status: 400, message: 'Round must be in draft or pending status to activate' };
  }

  const activationTime = new Date();
  const chunkAreaType = round.level === 'Council' ? 'council' : round.level === 'Regional' ? 'region' : null;
  let configuredChunks = [];
  let dueChunksAtActivation = [];
  let endedChunkIdsAtActivation = [];

  if (chunkAreaType) {
    const chunkValidation = await ensureChunkAreasDoNotOverlap(round._id, chunkAreaType);
    if (!chunkValidation.valid) {
      return {
        success: false,
        status: 400,
        message: `Chunk area overlap detected for "${chunkValidation.area}" between "${chunkValidation.existingChunk}" and "${chunkValidation.conflictingChunk}"`
      };
    }

    configuredChunks = await RoundChunk.find({
      roundId: round._id,
      areaType: chunkAreaType,
      isActive: true
    }).select('_id areas scheduledActivationTime scheduledEndTime activatedAt endedAt');

    dueChunksAtActivation = configuredChunks.filter((chunk) => isChunkDueForActivation(chunk, activationTime));
    endedChunkIdsAtActivation = configuredChunks
      .filter((chunk) => {
        const endTime = getChunkEndTime(chunk);
        return endTime && endTime <= activationTime;
      })
      .map((chunk) => chunk._id);
  }

  const query = buildActivationSubmissionQuery(round);
  const submissions = await Submission.find(query).select(
    '_id region council status year level videoFileUrl videoLink preferredLink createdAt'
  );

  const hasChunkConfiguration = configuredChunks.length > 0;
  const dueChunkAreaSet = hasChunkConfiguration ? buildChunkAreaSet(dueChunksAtActivation) : null;

  let eligibleSubmissions = submissions.filter(hasSubmissionVideo);
  if (hasChunkConfiguration) {
    eligibleSubmissions = eligibleSubmissions.filter((submission) => {
      const areaId = buildAreaId(round.level, submission.region, submission.council);
      return dueChunkAreaSet.has(areaId);
    });
  }

  if (eligibleSubmissions.length === 0 && !hasChunkConfiguration) {
    return {
      success: false,
      status: 400,
      message: 'No eligible submissions with videos found for this level'
    };
  }

  const activeAreaMap = new Map();
  for (const submission of eligibleSubmissions) {
    const descriptor = getSubmissionAreaDescriptor(round.level, submission);
    if (!activeAreaMap.has(descriptor.areaId)) {
      activeAreaMap.set(descriptor.areaId, {
        areaType: descriptor.areaType,
        areaId: descriptor.areaId,
        region: descriptor.region,
        council: descriptor.council,
        submissionCount: 0
      });
    }
    const current = activeAreaMap.get(descriptor.areaId);
    current.submissionCount += 1;
  }

  const snapshotPayload = {
    roundId: round._id,
    year: round.year,
    level: round.level,
    submissionIds: eligibleSubmissions.map((submission) => submission._id),
    activeAreas: [...activeAreaMap.values()],
    totalSubmissions: eligibleSubmissions.length,
    frozenAt: activationTime,
    metadata: {
      activatedBy: activatedBy ? String(activatedBy) : null,
      configuredChunkCount: configuredChunks.length,
      activatedChunkCount: dueChunksAtActivation.length,
      endedChunkCount: endedChunkIdsAtActivation.length
    }
  };

  const snapshot = await RoundSnapshot.findOneAndUpdate(
    { roundId: round._id },
    snapshotPayload,
    { upsert: true, new: true, runValidators: true }
  );

  await Submission.updateMany(
    { _id: { $in: snapshot.submissionIds } },
    { $set: { roundId: round._id } }
  );

  round.status = 'active';
  round.activationSnapshotId = snapshot._id;
  round.activeAreas = snapshot.activeAreas;
  round.pendingSubmissionsSnapshot = snapshot.submissionIds;
  round.snapshotCreatedAt = activationTime;
  if (!round.startTime) {
    round.startTime = activationTime;
  }
  if (round.timingType === 'countdown' && round.countdownDuration) {
    round.endTime = new Date(round.startTime.getTime() + round.countdownDuration);
  }
  await round.save();

  const assignmentResult = await assignRoundSubmissionsToJudges(round, eligibleSubmissions);
  if (dueChunksAtActivation.length > 0) {
    await RoundChunk.updateMany(
      {
        _id: { $in: dueChunksAtActivation.map((chunk) => chunk._id) },
        activatedAt: null
      },
      { $set: { activatedAt: activationTime } }
    );
  }

  if (endedChunkIdsAtActivation.length > 0) {
    await RoundChunk.updateMany(
      {
        _id: { $in: endedChunkIdsAtActivation },
        endedAt: null
      },
      { $set: { endedAt: activationTime } }
    );
  }

  return {
    success: true,
    round,
    snapshot,
    snapshotSize: snapshot.totalSubmissions,
    activeAreas: snapshot.activeAreas,
    assignments: assignmentResult,
    chunkSchedule: {
      configured: configuredChunks.length,
      activatedNow: dueChunksAtActivation.length,
      pending: Math.max(configuredChunks.length - dueChunksAtActivation.length - endedChunkIdsAtActivation.length, 0),
      endedNow: endedChunkIdsAtActivation.length
    }
  };
};

const activateDueChunksForRound = async (roundOrId, options = {}) => {
  const now = options.now ? new Date(options.now) : new Date();
  const round = (roundOrId && typeof roundOrId === 'object' && roundOrId._id)
    ? roundOrId
    : await CompetitionRound.findById(roundOrId);

  if (!round) {
    return { success: false, status: 404, message: 'Round not found' };
  }

  if (round.status !== 'active') {
    return {
      success: true,
      activatedChunks: 0,
      endedChunks: 0,
      addedSubmissions: 0,
      assignments: { assigned: 0, unassigned: 0 }
    };
  }

  const areaType = round.level === 'Council' ? 'council' : round.level === 'Regional' ? 'region' : null;
  if (!areaType) {
    return {
      success: true,
      activatedChunks: 0,
      endedChunks: 0,
      addedSubmissions: 0,
      assignments: { assigned: 0, unassigned: 0 }
    };
  }

  const endedChunks = await RoundChunk.find({
    roundId: round._id,
    areaType,
    isActive: true,
    endedAt: null,
    scheduledEndTime: { $ne: null, $lte: now }
  }).select('_id');

  if (endedChunks.length > 0) {
    await RoundChunk.updateMany(
      { _id: { $in: endedChunks.map((chunk) => chunk._id) }, endedAt: null },
      { $set: { endedAt: now } }
    );
  }

  const dueChunks = await RoundChunk.find({
    roundId: round._id,
    areaType,
    isActive: true,
    $or: [{ endedAt: null }, { endedAt: { $gt: now } }],
    activatedAt: null,
    $and: [
      {
        $or: [
          { scheduledActivationTime: null },
          { scheduledActivationTime: { $lte: now } }
        ]
      },
      {
        $or: [
          { scheduledEndTime: null },
          { scheduledEndTime: { $gt: now } }
        ]
      }
    ]
  }).select('_id areas');

  if (dueChunks.length === 0) {
    return {
      success: true,
      activatedChunks: 0,
      endedChunks: endedChunks.length,
      addedSubmissions: 0,
      assignments: { assigned: 0, unassigned: 0 }
    };
  }

  const areaSet = buildChunkAreaSet(dueChunks);
  const query = buildActivationSubmissionQuery(round);
  const candidates = await Submission.find(query).select(
    '_id region council status year level videoFileUrl videoLink preferredLink createdAt'
  );

  const snapshot = await RoundSnapshot.findOne({ roundId: round._id });
  const existingSubmissionIdSet = new Set([
    ...((round.pendingSubmissionsSnapshot || []).map((id) => String(id))),
    ...((snapshot?.submissionIds || []).map((id) => String(id)))
  ]);

  const dueSubmissions = candidates
    .filter(hasSubmissionVideo)
    .filter((submission) => {
      const areaId = buildAreaId(round.level, submission.region, submission.council);
      return areaSet.has(areaId);
    })
    .filter((submission) => !existingSubmissionIdSet.has(String(submission._id)));

  const dueSubmissionIds = dueSubmissions.map((submission) => submission._id);
  const mergedSubmissionIds = [
    ...existingSubmissionIdSet,
    ...dueSubmissionIds.map((id) => String(id))
  ];

  const existingAreaMap = new Map();
  const baseAreas = Array.isArray(snapshot?.activeAreas) && snapshot.activeAreas.length > 0
    ? snapshot.activeAreas
    : (round.activeAreas || []);

  for (const area of baseAreas) {
    if (!area?.areaId) continue;
    existingAreaMap.set(String(area.areaId), {
      areaType: area.areaType,
      areaId: area.areaId,
      region: area.region || null,
      council: area.council || null,
      submissionCount: Number(area.submissionCount) || 0
    });
  }

  for (const submission of dueSubmissions) {
    const descriptor = getSubmissionAreaDescriptor(round.level, submission);
    const current = existingAreaMap.get(descriptor.areaId) || {
      areaType: descriptor.areaType,
      areaId: descriptor.areaId,
      region: descriptor.region,
      council: descriptor.council,
      submissionCount: 0
    };
    current.submissionCount += 1;
    existingAreaMap.set(descriptor.areaId, current);
  }

  const snapshotPayload = {
    roundId: round._id,
    year: round.year,
    level: round.level,
    submissionIds: mergedSubmissionIds,
    activeAreas: [...existingAreaMap.values()],
    totalSubmissions: mergedSubmissionIds.length,
    frozenAt: snapshot?.frozenAt || round.snapshotCreatedAt || now,
    metadata: {
      ...(snapshot?.metadata || {}),
      lastChunkActivationAt: now,
      lastActivatedChunkIds: dueChunks.map((chunk) => String(chunk._id)),
      lastEndedChunkIds: endedChunks.map((chunk) => String(chunk._id))
    }
  };

  const updatedSnapshot = await RoundSnapshot.findOneAndUpdate(
    { roundId: round._id },
    snapshotPayload,
    { upsert: true, new: true, runValidators: true }
  );

  if (dueSubmissionIds.length > 0) {
    await Submission.updateMany(
      { _id: { $in: dueSubmissionIds } },
      { $set: { roundId: round._id } }
    );
  }

  round.pendingSubmissionsSnapshot = updatedSnapshot.submissionIds || [];
  round.activeAreas = updatedSnapshot.activeAreas || [];
  if (!round.activationSnapshotId) {
    round.activationSnapshotId = updatedSnapshot._id;
  }
  if (!round.snapshotCreatedAt) {
    round.snapshotCreatedAt = now;
  }
  await round.save();

  const assignments = await assignRoundSubmissionsToJudges(round, dueSubmissions);

  await RoundChunk.updateMany(
    { _id: { $in: dueChunks.map((chunk) => chunk._id) }, activatedAt: null },
    { $set: { activatedAt: now } }
  );

  return {
    success: true,
    activatedChunks: dueChunks.length,
    endedChunks: endedChunks.length,
    addedSubmissions: dueSubmissions.length,
    assignments
  };
};

const getRoundBySubmissionForEvaluation = async (submission) => {
  const context = await resolveSubmissionRoundContext(submission, {
    includeHistorical: false,
    allowFallbackByYearLevel: true
  });
  const round = context.round;

  if (!round || !isRoundActionable(round)) {
    return null;
  }

  const snapshot = await getRoundSnapshot(round._id);
  if (!snapshot) {
    return null;
  }

  const submissionId = String(submission._id);
  const inSnapshot = (snapshot.submissionIds || []).some((id) => String(id) === submissionId);
  if (!inSnapshot) {
    return null;
  }

  return round;
};

const recalculateSubmissionAverageForRound = async (submissionId, roundId) => {
  const evaluations = await Evaluation.find({ submissionId, roundId }).select('averageScore');
  if (evaluations.length === 0) {
    await Submission.findByIdAndUpdate(submissionId, {
      averageScore: 0,
      status: 'submitted'
    });
    return { averageScore: 0, totalEvaluations: 0 };
  }

  const totalAverage = evaluations.reduce((sum, evaluation) => sum + (evaluation.averageScore || 0), 0);
  const averageScore = Math.round((totalAverage / evaluations.length) * 100) / 100;

  await Submission.findByIdAndUpdate(submissionId, {
    averageScore,
    status: 'evaluated'
  });

  return { averageScore, totalEvaluations: evaluations.length };
};

const getAreaSubmissionIdsFromSnapshot = async (round, areaId) => {
  const snapshot = await getRoundSnapshot(round._id);
  if (!snapshot || !snapshot.submissionIds || snapshot.submissionIds.length === 0) {
    return [];
  }

  const areaQuery = buildAreaQuery(round.level, areaId);
  const submissions = await Submission.find({
    _id: { $in: snapshot.submissionIds },
    ...areaQuery
  }).select('_id');

  return submissions.map((submission) => submission._id);
};

const rebuildAreaLeaderboard = async (roundId, areaId, options = {}) => {
  const { forceUnlocked = false } = options;

  const round = await CompetitionRound.findById(roundId);
  if (!round) {
    return null;
  }

  const areaType = getAreaTypeForLevel(round.level);
  const existingLeaderboard = await AreaLeaderboard.findOne({
    roundId: round._id,
    level: round.level,
    areaType,
    areaId
  });

  if (existingLeaderboard && existingLeaderboard.isLocked && !forceUnlocked) {
    return existingLeaderboard;
  }

  const snapshot = await getRoundSnapshot(round._id);
  if (!snapshot || !snapshot.submissionIds || snapshot.submissionIds.length === 0) {
    return null;
  }

  const submissionIds = await getAreaSubmissionIdsFromSnapshot(round, areaId);
  if (submissionIds.length === 0) {
    return AreaLeaderboard.findOneAndUpdate(
      {
        roundId: round._id,
        level: round.level,
        areaType,
        areaId
      },
      {
        year: round.year,
        region: parseAreaId(round.level, areaId).region,
        council: parseAreaId(round.level, areaId).council,
        entries: [],
        totalSubmissions: 0,
        totalEvaluations: 0,
        state: existingLeaderboard && existingLeaderboard.state === 'published'
          ? 'published'
          : existingLeaderboard && existingLeaderboard.state === 'finalized'
            ? 'finalized'
            : 'provisional',
        isLocked: existingLeaderboard ? existingLeaderboard.isLocked : false,
        lastUpdated: new Date()
      },
      { upsert: true, new: true, runValidators: true }
    );
  }

  const submissions = await Submission.find({
    _id: { $in: submissionIds },
    disqualified: { $ne: true }
  })
    .populate('teacherId', 'name email')
    .lean();

  const evaluationGroups = await Evaluation.aggregate([
    {
      $match: {
        roundId: new mongoose.Types.ObjectId(round._id),
        submissionId: { $in: submissionIds.map((id) => new mongoose.Types.ObjectId(id)) }
      }
    },
    {
      $group: {
        _id: '$submissionId',
        averageScore: { $avg: '$averageScore' },
        totalEvaluations: { $sum: 1 }
      }
    }
  ]);

  const evaluationMap = new Map(
    evaluationGroups.map((item) => [
      String(item._id),
      {
        averageScore: Math.round((item.averageScore || 0) * 100) / 100,
        totalEvaluations: item.totalEvaluations || 0
      }
    ])
  );

  const entries = submissions.map((submission) => {
    const scoreData = evaluationMap.get(String(submission._id)) || {
      averageScore: submission.averageScore || 0,
      totalEvaluations: 0
    };
    const entry = {
      submissionId: submission._id,
      teacherId: submission.teacherId?._id || submission.teacherId,
      teacherName: submission.teacherId?.name || submission.teacherName || 'Unknown',
      teacherEmail: submission.teacherId?.email || '',
      school: submission.school || 'Unknown',
      region: submission.region || null,
      council: submission.council || null,
      category: submission.category || 'Unknown',
      class: submission.class || 'Unknown',
      subject: submission.subject || 'Unknown',
      areaOfFocus: submission.areaOfFocus || 'Unknown',
      rank: 0,
      averageScore: scoreData.averageScore,
      totalEvaluations: scoreData.totalEvaluations,
      status: scoreData.totalEvaluations > 0 ? 'evaluated' : 'pending',
      tieBreakCreatedAt: submission.createdAt || null
    };

    if (submission.status === 'eliminated') {
      entry.status = 'eliminated';
    } else if (submission.promotedFromRoundId && String(submission.promotedFromRoundId) === String(round._id)) {
      entry.status = 'promoted';
    }

    return entry;
  });

  const rankedEntries = rankEntriesDeterministically(entries);
  const quotaInfo = await resolveQuotaForArea({ round, areaId, areaType });
  const chunks = await getChunksForArea(round._id, areaType, areaId);

  const preservedState = existingLeaderboard && ['finalized', 'published'].includes(existingLeaderboard.state)
    ? existingLeaderboard.state
    : existingLeaderboard && existingLeaderboard.state === 'awaiting_superadmin_approval'
      ? 'awaiting_superadmin_approval'
      : 'provisional';

  const upsertPayload = {
    year: round.year,
    level: round.level,
    roundId: round._id,
    areaType,
    areaId,
    region: parseAreaId(round.level, areaId).region,
    council: parseAreaId(round.level, areaId).council,
    chunkIds: chunks.map((chunk) => chunk._id),
    entries: rankedEntries,
    totalSubmissions: rankedEntries.length,
    totalEvaluations: rankedEntries.reduce((sum, entry) => sum + (entry.totalEvaluations || 0), 0),
    quota: quotaInfo.quota,
    state: preservedState,
    isLocked: existingLeaderboard ? existingLeaderboard.isLocked : false,
    lastUpdated: new Date(),
    metadata: {
      ...(existingLeaderboard?.metadata || {}),
      quotaSourceType: quotaInfo.sourceType,
      quotaSourceId: quotaInfo.sourceId
    }
  };

  return AreaLeaderboard.findOneAndUpdate(
    { roundId: round._id, level: round.level, areaType, areaId },
    upsertPayload,
    { upsert: true, new: true, runValidators: true }
  );
};

const checkAreaJudgeCompletion = async (roundId, areaId) => {
  const round = await CompetitionRound.findById(roundId);
  if (!round) {
    return {
      ready: false,
      pendingCount: 0,
      totalSubmissions: 0,
      totalJudges: 0,
      blockers: ['Round not found']
    };
  }

  const submissionIds = await getAreaSubmissionIdsFromSnapshot(round, areaId);
  if (submissionIds.length === 0) {
    return {
      ready: true,
      pendingCount: 0,
      totalSubmissions: 0,
      totalJudges: 0,
      blockers: []
    };
  }

  const evaluationGroups = await Evaluation.aggregate([
    {
      $match: {
        roundId: new mongoose.Types.ObjectId(round._id),
        submissionId: { $in: submissionIds.map((id) => new mongoose.Types.ObjectId(id)) }
      }
    },
    {
      $group: {
        _id: '$submissionId',
        judgeIds: { $addToSet: '$judgeId' }
      }
    }
  ]);
  const evaluationMap = new Map(
    evaluationGroups.map((group) => [
      String(group._id),
      new Set(group.judgeIds.map((judgeId) => String(judgeId)))
    ])
  );

  const blockers = [];
  let pendingCount = 0;

  if (['Council', 'Regional'].includes(round.level)) {
    const assignments = await SubmissionAssignment.find({
      roundId: round._id,
      submissionId: { $in: submissionIds }
    }).select('submissionId judgeId');
    const assignmentMap = new Map(
      assignments.map((assignment) => [String(assignment.submissionId), String(assignment.judgeId)])
    );

    for (const submissionId of submissionIds) {
      const submissionKey = String(submissionId);
      const assignedJudgeId = assignmentMap.get(submissionKey);
      if (!assignedJudgeId) {
        pendingCount += 1;
        blockers.push(`No judge assignment for submission ${submissionKey}`);
        continue;
      }
      const evaluatedJudgeIds = evaluationMap.get(submissionKey) || new Set();
      if (!evaluatedJudgeIds.has(assignedJudgeId)) {
        pendingCount += 1;
      }
    }

    const uniqueJudges = new Set(assignments.map((assignment) => String(assignment.judgeId)));
    return {
      ready: pendingCount === 0,
      pendingCount,
      totalSubmissions: submissionIds.length,
      totalJudges: uniqueJudges.size,
      blockers
    };
  }

  const nationalJudges = await User.find({
    role: 'judge',
    status: 'active',
    assignedLevel: round.level
  }).select('_id');
  const judgeIds = nationalJudges.map((judge) => String(judge._id));

  if (judgeIds.length === 0) {
    return {
      ready: false,
      pendingCount: submissionIds.length,
      totalSubmissions: submissionIds.length,
      totalJudges: 0,
      blockers: ['No active judges assigned for this level']
    };
  }

  for (const submissionId of submissionIds) {
    const evaluatedJudgeIds = evaluationMap.get(String(submissionId)) || new Set();
    const allJudgesDone = judgeIds.every((judgeId) => evaluatedJudgeIds.has(judgeId));
    if (!allJudgesDone) {
      pendingCount += 1;
    }
  }

  return {
    ready: pendingCount === 0,
    pendingCount,
    totalSubmissions: submissionIds.length,
    totalJudges: judgeIds.length,
    blockers
  };
};

const updateAreaStateByCompletion = async (roundId, areaId) => {
  const round = await CompetitionRound.findById(roundId);
  if (!round) return null;

  const areaType = getAreaTypeForLevel(round.level);
  const leaderboard = await rebuildAreaLeaderboard(roundId, areaId);
  if (!leaderboard) return null;

  if (['finalized', 'published'].includes(leaderboard.state)) {
    return leaderboard;
  }

  const completion = await checkAreaJudgeCompletion(roundId, areaId);
  const state = completion.ready ? 'awaiting_superadmin_approval' : 'provisional';
  leaderboard.state = state;
  leaderboard.lastUpdated = new Date();
  await leaderboard.save();
  return leaderboard;
};

const refreshSubmissionAndAreaLeaderboard = async ({ submissionId, roundId }) => {
  const submission = await Submission.findById(submissionId);
  if (!submission) return null;

  await recalculateSubmissionAverageForRound(submissionId, roundId);
  const areaId = buildAreaId(submission.level, submission.region, submission.council);
  await rebuildAreaLeaderboard(roundId, areaId);
  await updateAreaStateByCompletion(roundId, areaId);

  return { submissionId, areaId };
};

const approveAreaLeaderboardAndPromote = async ({ roundId, areaId, approvedBy, force = false }) => {
  const round = await CompetitionRound.findById(roundId);
  if (!round) {
    return { success: false, status: 404, message: 'Competition round not found' };
  }

  const areaType = getAreaTypeForLevel(round.level);
  const leaderboard = await rebuildAreaLeaderboard(roundId, areaId, { forceUnlocked: force });
  if (!leaderboard) {
    return { success: false, status: 404, message: 'Area leaderboard not found for this round' };
  }

  if (leaderboard.state === 'published') {
    return {
      success: false,
      status: 400,
      message: 'Leaderboard is already published. Reopen it first if you need to recompute results.'
    };
  }

  const completion = await checkAreaJudgeCompletion(roundId, areaId);
  if (!completion.ready && !force) {
    return {
      success: false,
      status: 400,
      message: 'Area is not ready for finalization. Not all assigned judges have submitted.',
      completion
    };
  }

  const quotaInfo = await resolveQuotaForArea({ round, areaId, areaType });
  const rankedEntries = rankEntriesDeterministically(
    leaderboard.entries.filter((entry) => entry.status !== 'eliminated')
  );
  const quota = Math.max(0, Math.min(quotaInfo.quota || 0, rankedEntries.length));
  const promotedEntries = rankedEntries.slice(0, quota);
  const eliminatedEntries = rankedEntries.slice(quota);
  const nextLevel = getNextLevel(round.level);
  let targetRoundId = null;
  if (nextLevel) {
    const targetRound = await CompetitionRound.findOne({
      year: round.year,
      level: nextLevel,
      status: { $in: ['draft', 'pending', 'active', 'ended'] }
    })
      .sort({ createdAt: -1 })
      .select('_id');
    targetRoundId = targetRound?._id || null;
  }

  const promotedIds = promotedEntries.map((entry) => entry.submissionId);
  const eliminatedIds = eliminatedEntries.map((entry) => entry.submissionId);

  const session = await mongoose.startSession();
  let result = null;
  try {
    await session.withTransaction(async () => {
      if (promotedIds.length > 0) {
        if (nextLevel) {
          await Submission.updateMany(
            { _id: { $in: promotedIds } },
            {
              $set: {
                level: nextLevel,
                status: 'submitted',
                roundId: null,
                promotedFromRoundId: round._id
              }
            },
            { session }
          );
        } else {
          await Submission.updateMany(
            { _id: { $in: promotedIds } },
            {
              $set: {
                status: 'promoted',
                promotedFromRoundId: round._id
              }
            },
            { session }
          );
        }
      }

      if (eliminatedIds.length > 0) {
        await Submission.updateMany(
          { _id: { $in: eliminatedIds } },
          {
            $set: {
              status: 'eliminated'
            }
          },
          { session }
        );
      }

      const areaLocation = parseAreaId(round.level, areaId);
      const records = [];
      for (const entry of promotedEntries) {
        records.push({
          fromRoundId: round._id,
          toRoundId: targetRoundId,
          submissionId: entry.submissionId,
          teacherId: entry.teacherId,
          fromLevel: round.level,
          toLevel: nextLevel,
          fromAreaType: areaType,
          fromAreaId: areaId,
          toAreaType: nextLevel === 'Regional' ? 'region' : nextLevel === 'National' ? 'national' : null,
          toAreaId: nextLevel === 'Regional' ? (entry.region || areaLocation.region) : nextLevel === 'National' ? 'national' : null,
          status: 'promoted',
          rankAtDecision: entry.rank,
          scoreAtDecision: entry.averageScore,
          quotaScopeType: quotaInfo.sourceType,
          quotaScopeId: quotaInfo.sourceId,
          approvedBy
        });
      }

      for (const entry of eliminatedEntries) {
        records.push({
          fromRoundId: round._id,
          toRoundId: null,
          submissionId: entry.submissionId,
          teacherId: entry.teacherId,
          fromLevel: round.level,
          toLevel: nextLevel,
          fromAreaType: areaType,
          fromAreaId: areaId,
          toAreaType: null,
          toAreaId: null,
          status: 'eliminated',
          rankAtDecision: entry.rank,
          scoreAtDecision: entry.averageScore,
          quotaScopeType: quotaInfo.sourceType,
          quotaScopeId: quotaInfo.sourceId,
          approvedBy
        });
      }

      if (records.length > 0) {
        await PromotionRecord.bulkWrite(
          records.map((record) => ({
            updateOne: {
              filter: {
                fromRoundId: record.fromRoundId,
                submissionId: record.submissionId
              },
              update: { $set: record },
              upsert: true
            }
          })),
          { session }
        );
      }

      const updatedEntries = leaderboard.entries.map((entry) => {
        const id = String(entry.submissionId);
        const promoted = promotedEntries.some((candidate) => String(candidate.submissionId) === id);
        const eliminated = eliminatedEntries.some((candidate) => String(candidate.submissionId) === id);
        if (promoted) return { ...entry.toObject(), status: 'promoted' };
        if (eliminated) return { ...entry.toObject(), status: 'eliminated' };
        return { ...entry.toObject() };
      });

      leaderboard.entries = updatedEntries;
      leaderboard.quota = quotaInfo.quota || 0;
      leaderboard.state = 'finalized';
      leaderboard.isLocked = true;
      leaderboard.finalizedAt = new Date();
      leaderboard.finalizedBy = approvedBy;
      leaderboard.lastUpdated = new Date();
      leaderboard.metadata = {
        ...(leaderboard.metadata || {}),
        quotaSourceType: quotaInfo.sourceType,
        quotaSourceId: quotaInfo.sourceId
      };
      await leaderboard.save({ session });

      result = {
        success: true,
        leaderboard,
        promoted: promotedEntries.length,
        eliminated: eliminatedEntries.length,
        promotedIds: promotedEntries.map((entry) => String(entry.submissionId)),
        eliminatedIds: eliminatedEntries.map((entry) => String(entry.submissionId)),
        nextLevel
      };
    });
  } catch (error) {
    return {
      success: false,
      status: 500,
      message: error.message || 'Failed to finalize and promote area leaderboard'
    };
  } finally {
    await session.endSession();
  }

  return result;
};

const publishAreaLeaderboard = async ({ roundId, areaId, publishedBy, audiences = [] }) => {
  const round = await CompetitionRound.findById(roundId);
  if (!round) {
    return { success: false, status: 404, message: 'Competition round not found' };
  }

  const areaType = getAreaTypeForLevel(round.level);
  const leaderboard = await AreaLeaderboard.findOne({
    roundId: round._id,
    level: round.level,
    areaType,
    areaId
  });

  if (!leaderboard) {
    return { success: false, status: 404, message: 'Area leaderboard not found' };
  }

  if (!['finalized', 'published'].includes(leaderboard.state)) {
    return {
      success: false,
      status: 400,
      message: 'Only finalized leaderboards can be published'
    };
  }

  const sanitizedAudiences = [...new Set((audiences || []).filter((audience) => ['judges', 'teachers'].includes(audience)))];
  if (sanitizedAudiences.length === 0) {
    sanitizedAudiences.push('judges', 'teachers');
  }
  leaderboard.state = 'published';
  leaderboard.publishedAt = new Date();
  leaderboard.publishedBy = publishedBy;
  leaderboard.publishedAudiences = sanitizedAudiences;
  leaderboard.publishedVersion = (leaderboard.publishedVersion || 0) + 1;
  leaderboard.isLocked = true;
  leaderboard.lastUpdated = new Date();
  await leaderboard.save();

  return { success: true, leaderboard };
};

const reopenAreaLeaderboard = async ({ roundId, areaId }) => {
  const round = await CompetitionRound.findById(roundId);
  if (!round) {
    return { success: false, status: 404, message: 'Competition round not found' };
  }

  const areaType = getAreaTypeForLevel(round.level);
  const leaderboard = await AreaLeaderboard.findOne({
    roundId: round._id,
    level: round.level,
    areaType,
    areaId
  });

  if (!leaderboard) {
    return { success: false, status: 404, message: 'Area leaderboard not found' };
  }

  leaderboard.state = 'provisional';
  leaderboard.isLocked = false;
  leaderboard.finalizedAt = null;
  leaderboard.finalizedBy = null;
  leaderboard.publishedAt = null;
  leaderboard.publishedBy = null;
  leaderboard.publishedAudiences = [];
  leaderboard.lastUpdated = new Date();
  await leaderboard.save();

  return { success: true, leaderboard };
};

const getAreaReadiness = async ({ roundId, areaId }) => {
  const round = await CompetitionRound.findById(roundId);
  if (!round) {
    return { success: false, status: 404, message: 'Competition round not found' };
  }

  const leaderboard = await rebuildAreaLeaderboard(roundId, areaId);
  if (!leaderboard) {
    return { success: false, status: 404, message: 'Area leaderboard not found' };
  }

  const completion = await checkAreaJudgeCompletion(roundId, areaId);
  const updated = await updateAreaStateByCompletion(roundId, areaId);
  return {
    success: true,
    leaderboard: updated || leaderboard,
    readiness: completion
  };
};

const canAdminAccessLeaderboard = (adminUser, leaderboard) => {
  const scope = getAdminScope(adminUser);
  if (!scope || scope.level === 'None') return false;
  if (scope.level === 'National') return true;
  if (scope.level === 'Regional') {
    return leaderboard.level === 'Regional' && leaderboard.areaId === scope.region;
  }
  if (scope.level === 'Council') {
    const expected = buildAreaId('Council', scope.region, scope.council);
    return leaderboard.level === 'Council' && leaderboard.areaId === expected;
  }
  return false;
};

const listAreaLeaderboards = async ({ filters = {}, user }) => {
  const query = {};
  if (filters.roundId) query.roundId = filters.roundId;
  if (filters.year) query.year = parseInt(filters.year, 10);
  if (filters.level) query.level = filters.level;
  if (filters.areaType) query.areaType = filters.areaType;
  if (filters.areaId) query.areaId = filters.areaId;
  if (filters.state) query.state = filters.state;

  if (filters.chunkId) {
    query.chunkIds = new mongoose.Types.ObjectId(filters.chunkId);
  }

  if (user.role === 'judge' || user.role === 'teacher' || user.role === 'stakeholder') {
    query.state = 'published';
  }

  if (user.role === 'admin') {
    const scope = getAdminScope(user);
    if (!scope || scope.level === 'None') {
      query._id = { $in: [] };
    } else if (scope.level === 'Council' && scope.region && scope.council) {
      query.level = 'Council';
      query.areaType = 'council';
      query.areaId = buildAreaId('Council', scope.region, scope.council);
    } else if (scope.level === 'Regional' && scope.region) {
      query.level = 'Regional';
      query.areaType = 'region';
      query.areaId = scope.region;
    }
  }

  if (user.role === 'judge') {
    if (user.assignedLevel) query.level = user.assignedLevel;
    if (user.assignedLevel === 'Council' && user.assignedRegion && user.assignedCouncil) {
      query.areaType = 'council';
      query.areaId = buildAreaId('Council', user.assignedRegion, user.assignedCouncil);
    } else if (user.assignedLevel === 'Regional' && user.assignedRegion) {
      query.areaType = 'region';
      query.areaId = user.assignedRegion;
    } else if (user.assignedLevel === 'National') {
      query.areaType = 'national';
      query.areaId = 'national';
    }
    query.publishedAudiences = { $in: ['judges'] };
  }

  if (user.role === 'teacher') {
    query['entries.teacherId'] = user._id;
    query.publishedAudiences = { $in: ['teachers'] };
  }

  let leaderboards = await AreaLeaderboard.find(query).sort({
    year: -1,
    level: 1,
    areaType: 1,
    areaId: 1
  });

  if (filters.areaOfFocus) {
    leaderboards = leaderboards
      .map((leaderboard) => {
        const filteredEntries = leaderboard.entries.filter(
          (entry) => entry.areaOfFocus === filters.areaOfFocus
        );
        leaderboard.entries = rankEntriesDeterministically(
          filteredEntries.map((entry) => entry.toObject())
        );
        leaderboard.totalSubmissions = leaderboard.entries.length;
        leaderboard.totalEvaluations = leaderboard.entries.reduce(
          (sum, entry) => sum + (entry.totalEvaluations || 0),
          0
        );
        return leaderboard;
      })
      .filter((leaderboard) => leaderboard.entries.length > 0);
  }

  return leaderboards;
};

const listCouncilAreaLeaderboards = async ({ filters = {}, user }) => {
  const normalizedFilters = {
    ...filters,
    level: 'Council',
    areaType: 'council'
  };

  if (filters.region && filters.council && !filters.areaId) {
    normalizedFilters.areaId = buildAreaId('Council', filters.region, filters.council);
  }

  const areaLeaderboards = await listAreaLeaderboards({
    filters: normalizedFilters,
    user
  });
  const scopedAreaLeaderboards = areaLeaderboards.filter((leaderboard) => {
    if (filters.region && leaderboard.region !== filters.region) return false;
    if (filters.council && leaderboard.council !== filters.council) return false;
    return true;
  });

  const groupedLeaderboards = [];
  const regionSet = new Set();
  const councilKeySet = new Set();
  const competitionAreaSet = new Set();

  for (const leaderboard of scopedAreaLeaderboards) {
    const plainLeaderboard = leaderboard.toObject ? leaderboard.toObject() : leaderboard;
    const baseEntries = Array.isArray(plainLeaderboard.entries) ? plainLeaderboard.entries : [];

    if (plainLeaderboard.region) regionSet.add(plainLeaderboard.region);
    if (plainLeaderboard.region && plainLeaderboard.council) {
      councilKeySet.add(`${plainLeaderboard.region}::${plainLeaderboard.council}`);
    }

    const areaMap = new Map();
    for (const entry of baseEntries) {
      const competitionArea = String(entry.areaOfFocus || '').trim();
      if (!competitionArea) continue;
      competitionAreaSet.add(competitionArea);
      if (!areaMap.has(competitionArea)) {
        areaMap.set(competitionArea, []);
      }
      areaMap.get(competitionArea).push(entry);
    }

    for (const [competitionArea, entries] of areaMap.entries()) {
      if (filters.areaOfFocus && competitionArea !== filters.areaOfFocus) continue;

      const rankedEntries = rankEntriesDeterministically(
        entries.map((entry) => (entry && typeof entry.toObject === 'function' ? entry.toObject() : { ...entry }))
      );

      groupedLeaderboards.push({
        id: `${plainLeaderboard._id.toString()}::${competitionArea}`,
        sourceLeaderboardId: plainLeaderboard._id.toString(),
        roundId: plainLeaderboard.roundId?.toString?.() || String(plainLeaderboard.roundId),
        year: plainLeaderboard.year,
        level: plainLeaderboard.level,
        areaType: plainLeaderboard.areaType,
        areaId: plainLeaderboard.areaId,
        region: plainLeaderboard.region || null,
        council: plainLeaderboard.council || null,
        competitionArea,
        state: plainLeaderboard.state,
        isFinalized: ['finalized', 'published'].includes(plainLeaderboard.state),
        quota: plainLeaderboard.quota || 0,
        totalSubmissions: rankedEntries.length,
        totalEvaluations: rankedEntries.reduce((sum, entry) => sum + (entry.totalEvaluations || 0), 0),
        entries: rankedEntries,
        lastUpdated: plainLeaderboard.lastUpdated || plainLeaderboard.updatedAt || null
      });
    }
  }

  groupedLeaderboards.sort((left, right) => {
    if ((left.region || '') !== (right.region || '')) {
      return (left.region || '').localeCompare(right.region || '');
    }
    if ((left.council || '') !== (right.council || '')) {
      return (left.council || '').localeCompare(right.council || '');
    }
    return (left.competitionArea || '').localeCompare(right.competitionArea || '');
  });

  return {
    leaderboards: groupedLeaderboards,
    filters: {
      regions: [...regionSet].sort((a, b) => a.localeCompare(b)),
      councils: [...councilKeySet]
        .map((value) => {
          const [region, council] = String(value || '').split('::');
          return {
            value,
            region: region || null,
            council: council || null
          };
        })
        .sort((a, b) => {
          if ((a.region || '') !== (b.region || '')) {
            return (a.region || '').localeCompare(b.region || '');
          }
          return (a.council || '').localeCompare(b.council || '');
        }),
      competitionAreas: [...competitionAreaSet].sort((a, b) => a.localeCompare(b))
    }
  };
};

const listAvailableLocations = async ({ year, level, areaOfFocus, user }) => {
  const filters = {
    year,
    level
  };
  const leaderboards = await listAreaLeaderboards({ filters, user });

  const locationSet = new Set();
  for (const leaderboard of leaderboards) {
    if (areaOfFocus) {
      const hasArea = leaderboard.entries.some((entry) => entry.areaOfFocus === areaOfFocus);
      if (!hasArea) continue;
    }
    locationSet.add(leaderboard.areaId);
  }
  return [...locationSet];
};

const findAreaLeaderboardById = async ({ id, user }) => {
  const leaderboard = await AreaLeaderboard.findById(id);
  if (!leaderboard) return null;

  if (['judge', 'teacher', 'stakeholder', 'admin'].includes(user.role) && leaderboard.state !== 'published') {
    return null;
  }
  if (user.role === 'admin' && !canAdminAccessLeaderboard(user, leaderboard)) {
    return null;
  }
  if (user.role === 'judge' && !leaderboard.publishedAudiences.includes('judges')) {
    return null;
  }
  if (user.role === 'judge') {
    if (user.assignedLevel && leaderboard.level !== user.assignedLevel) {
      return null;
    }
    if (user.assignedLevel === 'Council') {
      const expectedAreaId = buildAreaId('Council', user.assignedRegion, user.assignedCouncil);
      if (leaderboard.areaId !== expectedAreaId) return null;
    } else if (user.assignedLevel === 'Regional') {
      if (leaderboard.areaId !== user.assignedRegion) return null;
    } else if (user.assignedLevel === 'National') {
      if (leaderboard.areaId !== 'national') return null;
    }
  }
  if (user.role === 'teacher' && !leaderboard.publishedAudiences.includes('teachers')) {
    return null;
  }
  if (user.role === 'teacher') {
    const hasTeacherEntry = leaderboard.entries.some(
      (entry) => String(entry.teacherId) === String(user._id)
    );
    if (!hasTeacherEntry) return null;
  }

  return leaderboard;
};

const getAreaIdFromSubmission = (submission) => {
  return buildAreaId(submission.level, submission.region, submission.council);
};

const markRoundEndedIfComplete = async (roundId) => {
  const round = await CompetitionRound.findById(roundId);
  if (!round) return null;

  const snapshot = await getRoundSnapshot(roundId);
  if (!snapshot || !snapshot.activeAreas) return round;

  const readinessResults = await Promise.all(
    snapshot.activeAreas.map((area) => checkAreaJudgeCompletion(roundId, area.areaId))
  );
  const allReady = readinessResults.every((result) => result.ready);

  if (allReady && round.status === 'active') {
    round.status = 'ended';
    round.endedAt = new Date();
    await round.save();
  }

  return round;
};

module.exports = {
  ROUND_LEVELS,
  getNextLevel,
  getAreaTypeForLevel,
  buildAreaId,
  parseAreaId,
  deterministicRankSort,
  rankEntriesDeterministically,
  ensureChunkAreasDoNotOverlap,
  resolveQuotaForArea,
  activateRoundWithSnapshot,
  activateDueChunksForRound,
  getRoundBySubmissionForEvaluation,
  recalculateSubmissionAverageForRound,
  refreshSubmissionAndAreaLeaderboard,
  getAreaReadiness,
  approveAreaLeaderboardAndPromote,
  publishAreaLeaderboard,
  reopenAreaLeaderboard,
  listAreaLeaderboards,
  listCouncilAreaLeaderboards,
  listAvailableLocations,
  findAreaLeaderboardById,
  getAreaIdFromSubmission,
  markRoundEndedIfComplete,
  rebuildAreaLeaderboard,
  updateAreaStateByCompletion,
  checkAreaJudgeCompletion
};
