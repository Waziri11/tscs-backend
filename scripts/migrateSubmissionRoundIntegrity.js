/**
 * Migration script: submission/round/assignment integrity
 *
 * Goals:
 * 1. Ensure submission.roundId points to the canonical actionable round (active/ended) when resolvable
 * 2. Reconcile assignments onto canonical round context when possible
 * 3. Deduplicate SubmissionAssignment docs by (roundId, submissionId), keeping newest
 * 4. Rebuild SubmissionAssignment indexes for strict one-assignment-per-round-per-submission
 *
 * Usage:
 *   node scripts/migrateSubmissionRoundIntegrity.js          # dry run (default)
 *   node scripts/migrateSubmissionRoundIntegrity.js --apply  # apply changes
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Submission = require('../models/Submission');
const SubmissionAssignment = require('../models/SubmissionAssignment');
const CompetitionRound = require('../models/CompetitionRound');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tscs';
const APPLY = process.argv.includes('--apply');
const ACTIONABLE_STATUSES = new Set(['active', 'ended']);

const summary = {
  mode: APPLY ? 'apply' : 'dry-run',
  submissions: {
    scanned: 0,
    linkedToCanonicalRound: 0,
    clearedInvalidRoundPointer: 0,
    alreadyCanonical: 0,
    unresolvedNoActionableRound: 0
  },
  assignments: {
    scanned: 0,
    movedToCanonicalRound: 0,
    unresolvedMissingSubmission: 0,
    unresolvedMissingRound: 0,
    unresolvedNoCanonicalRound: 0,
    unresolvedRoundSubmissionMismatch: 0,
    historicalAssignmentsRetained: 0,
    duplicatePairs: 0,
    duplicateRowsRemoved: 0
  },
  indexes: {
    dropped: [],
    synced: false
  }
};

const statusPriority = (status) => {
  if (status === 'active') return 4;
  if (status === 'ended') return 3;
  if (status === 'closed') return 2;
  if (status === 'archived') return 1;
  return 0;
};

const sortRounds = (rounds) => {
  return [...rounds].sort((left, right) => {
    const statusDiff = statusPriority(right.status) - statusPriority(left.status);
    if (statusDiff !== 0) return statusDiff;
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  });
};

const isRoundMatchingSubmission = (round, submission) => {
  if (!round || !submission) return false;
  if (round.level !== submission.level) return false;
  if (Number(round.year) !== Number(submission.year)) return false;
  return true;
};

const dropIndexIfExists = async (collection, indexName) => {
  const indexes = await collection.indexes();
  const exists = indexes.some((index) => index.name === indexName);
  if (!exists) return false;
  await collection.dropIndex(indexName);
  return true;
};

async function run() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log(`[submission-round-integrity] Connected to MongoDB (${summary.mode})`);

    const [rounds, submissions] = await Promise.all([
      CompetitionRound.find({}).select('_id year level status createdAt').lean(),
      Submission.find({})
        .select('_id year level status disqualified roundId')
        .lean()
    ]);

    const roundById = new Map(rounds.map((round) => [String(round._id), round]));
    const roundsByYearLevel = new Map();
    for (const round of rounds) {
      const key = `${round.year}::${round.level}`;
      if (!roundsByYearLevel.has(key)) roundsByYearLevel.set(key, []);
      roundsByYearLevel.get(key).push(round);
    }
    for (const [key, value] of roundsByYearLevel.entries()) {
      roundsByYearLevel.set(key, sortRounds(value));
    }

    const submissionsById = new Map();
    const canonicalRoundIdBySubmissionId = new Map();

    for (const submission of submissions) {
      summary.submissions.scanned += 1;
      submissionsById.set(String(submission._id), submission);

      const key = `${submission.year}::${submission.level}`;
      const candidateRounds = roundsByYearLevel.get(key) || [];
      const actionableRounds = candidateRounds.filter((round) => ACTIONABLE_STATUSES.has(round.status));

      const currentRoundId = submission.roundId ? String(submission.roundId) : null;
      const currentRound = currentRoundId ? roundById.get(currentRoundId) : null;

      let canonicalRound = null;
      if (currentRound && ACTIONABLE_STATUSES.has(currentRound.status) && isRoundMatchingSubmission(currentRound, submission)) {
        canonicalRound = currentRound;
      } else if (actionableRounds.length > 0) {
        canonicalRound = actionableRounds[0];
      }

      const canonicalRoundId = canonicalRound ? String(canonicalRound._id) : null;
      canonicalRoundIdBySubmissionId.set(String(submission._id), canonicalRoundId);

      if (canonicalRoundId && canonicalRoundId !== currentRoundId) {
        summary.submissions.linkedToCanonicalRound += 1;
        if (APPLY) {
          await Submission.updateOne({ _id: submission._id }, { $set: { roundId: canonicalRound._id } });
        }
      } else if (!canonicalRoundId && currentRoundId) {
        summary.submissions.clearedInvalidRoundPointer += 1;
        if (APPLY) {
          await Submission.updateOne({ _id: submission._id }, { $set: { roundId: null } });
        }
      } else if (canonicalRoundId && canonicalRoundId === currentRoundId) {
        summary.submissions.alreadyCanonical += 1;
      }

      if (!canonicalRoundId) {
        summary.submissions.unresolvedNoActionableRound += 1;
      }
    }

    const assignments = await SubmissionAssignment.find({
      level: { $in: ['Council', 'Regional'] }
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();

    summary.assignments.scanned = assignments.length;

    const assignmentsBySubmissionId = new Map();
    for (const assignment of assignments) {
      const submissionId = String(assignment.submissionId);
      if (!assignmentsBySubmissionId.has(submissionId)) assignmentsBySubmissionId.set(submissionId, []);
      assignmentsBySubmissionId.get(submissionId).push(assignment);
    }

    for (const [submissionId, submissionAssignments] of assignmentsBySubmissionId.entries()) {
      const submission = submissionsById.get(submissionId);
      if (!submission) {
        summary.assignments.unresolvedMissingSubmission += submissionAssignments.length;
        continue;
      }

      const canonicalRoundId = canonicalRoundIdBySubmissionId.get(submissionId) || null;
      if (!canonicalRoundId) {
        summary.assignments.unresolvedNoCanonicalRound += submissionAssignments.length;
      }

      let canonicalAssignmentExists = false;
      let candidateToMove = null;

      for (const assignment of submissionAssignments) {
        const round = roundById.get(String(assignment.roundId));
        if (!round) {
          summary.assignments.unresolvedMissingRound += 1;
          continue;
        }

        const isMatchingRound = isRoundMatchingSubmission(round, submission) && assignment.level === submission.level;
        if (!isMatchingRound) {
          summary.assignments.unresolvedRoundSubmissionMismatch += 1;
        }

        if (!ACTIONABLE_STATUSES.has(round.status)) {
          summary.assignments.historicalAssignmentsRetained += 1;
        }

        if (canonicalRoundId && String(assignment.roundId) === canonicalRoundId) {
          canonicalAssignmentExists = true;
        }

        if (!candidateToMove && canonicalRoundId && String(assignment.roundId) !== canonicalRoundId) {
          candidateToMove = assignment;
        }
      }

      if (canonicalRoundId && !canonicalAssignmentExists && candidateToMove) {
        summary.assignments.movedToCanonicalRound += 1;
        if (APPLY) {
          await SubmissionAssignment.updateOne(
            { _id: candidateToMove._id },
            { $set: { roundId: new mongoose.Types.ObjectId(canonicalRoundId) } }
          );
        }
      }
    }

    const assignmentsAfterReconcile = await SubmissionAssignment.find({
      level: { $in: ['Council', 'Regional'] }
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .select('_id submissionId roundId')
      .lean();

    const seenPairs = new Set();
    const duplicateIds = [];
    const duplicatePairSet = new Set();
    for (const assignment of assignmentsAfterReconcile) {
      const pairKey = `${assignment.roundId}::${assignment.submissionId}`;
      if (seenPairs.has(pairKey)) {
        duplicateIds.push(assignment._id);
        duplicatePairSet.add(pairKey);
      } else {
        seenPairs.add(pairKey);
      }
    }

    summary.assignments.duplicatePairs = duplicatePairSet.size;
    summary.assignments.duplicateRowsRemoved = duplicateIds.length;

    if (APPLY && duplicateIds.length > 0) {
      await SubmissionAssignment.deleteMany({ _id: { $in: duplicateIds } });
    }

    if (APPLY) {
      const droppedUniqueByJudge = await dropIndexIfExists(
        SubmissionAssignment.collection,
        'roundId_1_submissionId_1_judgeId_1'
      );
      if (droppedUniqueByJudge) summary.indexes.dropped.push('roundId_1_submissionId_1_judgeId_1');

      const droppedPair = await dropIndexIfExists(
        SubmissionAssignment.collection,
        'roundId_1_submissionId_1'
      );
      if (droppedPair) summary.indexes.dropped.push('roundId_1_submissionId_1');

      await SubmissionAssignment.syncIndexes();
      summary.indexes.synced = true;
    }

    console.log(JSON.stringify(summary, null, 2));
    console.log('[submission-round-integrity] Done');
  } catch (error) {
    console.error('[submission-round-integrity] Failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

run();
