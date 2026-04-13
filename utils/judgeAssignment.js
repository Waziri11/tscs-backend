const User = require('../models/User');
const Submission = require('../models/Submission');
const SubmissionAssignment = require('../models/SubmissionAssignment');
const CompetitionRound = require('../models/CompetitionRound');
const notificationService = require('../services/notificationService');

const buildAreaQueryByLevel = (level, region, council) => {
  if (level === 'Council') {
    return { region, council };
  }
  if (level === 'Regional') {
    return { region };
  }
  return {};
};

const getRoundForSubmission = async (submission, explicitRoundId = null) => {
  if (explicitRoundId) {
    return CompetitionRound.findById(explicitRoundId);
  }

  if (submission.roundId) {
    const bySubmissionRound = await CompetitionRound.findById(submission.roundId);
    if (bySubmissionRound) return bySubmissionRound;
  }

  const candidates = await CompetitionRound.find({
    year: submission.year,
    level: submission.level,
    status: { $in: ['active', 'ended'] }
  }).sort({ createdAt: -1 });

  return candidates.find((candidate) => candidate.status === 'active')
    || candidates.find((candidate) => candidate.status === 'ended')
    || null;
};

/**
 * Assign a judge to a submission using round-robin algorithm.
 * Only for Council and Regional levels.
 *
 * @param {Object} submission - Submission document
 * @param {Object} options - { roundId }
 */
async function assignJudgeToSubmission(submission, options = {}) {
  try {
    if (!submission) {
      return { success: false, assignment: null, error: 'Submission is required' };
    }

    if (submission.level === 'National') {
      return {
        success: true,
        assignment: null,
        message: 'National level does not require assignment'
      };
    }

    const round = await getRoundForSubmission(submission, options.roundId || null);
    if (!round) {
      return {
        success: false,
        assignment: null,
        error: 'No active or ended round found for this submission level'
      };
    }

    const roundId = round._id;

    const existingAssignment = await SubmissionAssignment.findOne({
      roundId,
      submissionId: submission._id
    });

    if (existingAssignment) {
      return {
        success: true,
        assignment: existingAssignment,
        message: 'Submission already assigned for this round'
      };
    }

    const judgeQuery = {
      role: 'judge',
      status: 'active',
      assignedLevel: submission.level,
      ...buildAreaQueryByLevel(submission.level, submission.region, submission.council)
    };

    const availableJudges = await User.find(judgeQuery).select('_id name email');
    if (availableJudges.length === 0) {
      return {
        success: false,
        assignment: null,
        error: `No active judges found for ${submission.level} level at ${submission.region}${submission.council ? ` - ${submission.council}` : ''}`
      };
    }

    const locationAssignmentQuery = {
      roundId,
      level: submission.level,
      region: submission.region,
      ...(submission.level === 'Council' ? { council: submission.council } : {})
    };

    const existingAssignments = await SubmissionAssignment.find(locationAssignmentQuery).select('judgeId');

    const assignmentCounts = {};
    availableJudges.forEach((judge) => {
      assignmentCounts[judge._id.toString()] = 0;
    });

    existingAssignments.forEach((assignment) => {
      const judgeId = assignment.judgeId.toString();
      if (assignmentCounts[judgeId] !== undefined) {
        assignmentCounts[judgeId] += 1;
      }
    });

    let selectedJudge = availableJudges[0];
    let minCount = assignmentCounts[selectedJudge._id.toString()];

    for (const judge of availableJudges) {
      const count = assignmentCounts[judge._id.toString()];
      if (count < minCount) {
        minCount = count;
        selectedJudge = judge;
      }
    }

    const assignment = await SubmissionAssignment.create({
      roundId,
      submissionId: submission._id,
      judgeId: selectedJudge._id,
      level: submission.level,
      region: submission.region,
      council: submission.council || null,
      judgeNotified: false
    });

    notificationService.handleJudgeAssigned({
      userId: selectedJudge._id.toString(),
      submissionId: submission._id.toString(),
      teacherName: submission.teacherName,
      subject: submission.subject,
      areaOfFocus: submission.areaOfFocus,
      level: submission.level,
      region: submission.region,
      council: submission.council
    }).catch((error) => {
      console.error('Error sending judge assignment notification:', error);
    });

    assignment.judgeNotified = true;
    await assignment.save();

    return {
      success: true,
      assignment,
      judge: selectedJudge,
      roundId: roundId.toString()
    };
  } catch (error) {
    console.error('Error assigning judge to submission:', error);
    return {
      success: false,
      assignment: null,
      error: error.message
    };
  }
}

/**
 * Get assigned judge for a submission.
 * If roundId is not provided, returns the latest assignment.
 */
async function getAssignedJudge(submissionId, roundId = null) {
  try {
    const query = { submissionId };
    if (roundId) query.roundId = roundId;

    const assignment = await SubmissionAssignment.findOne(query)
      .sort({ createdAt: -1 })
      .populate('judgeId', 'name email username')
      .populate('roundId', 'year level status');

    return assignment;
  } catch (error) {
    console.error('Error getting assigned judge:', error);
    return null;
  }
}

/**
 * Check if a judge is assigned to a submission in a round.
 */
async function isJudgeAssigned(submissionId, judgeId, roundId = null) {
  try {
    const query = { submissionId, judgeId };
    if (roundId) query.roundId = roundId;

    const assignment = await SubmissionAssignment.findOne(query).select('_id');
    return !!assignment;
  } catch (error) {
    console.error('Error checking judge assignment:', error);
    return false;
  }
}

/**
 * Assign pending submissions from active rounds to judges in the same location.
 * This is useful when a new judge is created.
 */
async function assignUnassignedSubmissionsToJudge(judge) {
  try {
    if (!judge || !judge.assignedLevel || judge.assignedLevel === 'National') {
      return { success: true, assignedCount: 0, message: 'No round-scoped assignment required' };
    }

    const rounds = await CompetitionRound.find({
      level: judge.assignedLevel,
      status: 'active'
    }).select('_id year level pendingSubmissionsSnapshot');

    if (rounds.length === 0) {
      return { success: true, assignedCount: 0, message: 'No active rounds found for judge level' };
    }

    let assignedCount = 0;
    for (const round of rounds) {
      const areaQuery = buildAreaQueryByLevel(
        judge.assignedLevel,
        judge.assignedRegion,
        judge.assignedCouncil
      );

      const submissions = await Submission.find({
        _id: { $in: round.pendingSubmissionsSnapshot || [] },
        level: judge.assignedLevel,
        ...areaQuery,
        status: { $nin: ['promoted', 'eliminated'] }
      });

      for (const submission of submissions) {
        const existing = await SubmissionAssignment.findOne({
          roundId: round._id,
          submissionId: submission._id
        }).select('_id');

        if (existing) continue;

        const assignmentResult = await assignJudgeToSubmission(submission, { roundId: round._id });
        if (assignmentResult.success && assignmentResult.assignment) {
          assignedCount += 1;
        }
      }
    }

    return {
      success: true,
      assignedCount,
      message: `Assigned ${assignedCount} submission(s) across active rounds`
    };
  } catch (error) {
    console.error('Error assigning unassigned submissions to judge:', error);
    return {
      success: false,
      assignedCount: 0,
      error: error.message
    };
  }
}

/**
 * Manually assign or reassign a submission to a specific judge.
 * @param {ObjectId} submissionId
 * @param {ObjectId} judgeId
 * @param {Object} options - { roundId }
 */
async function manuallyAssignSubmission(submissionId, judgeId, options = {}) {
  try {
    const submission = await Submission.findById(submissionId);
    if (!submission) {
      return { success: false, assignment: null, error: 'Submission not found' };
    }

    if (submission.level === 'National') {
      return { success: false, assignment: null, error: 'National level does not require assignment' };
    }

    const judge = await User.findById(judgeId);
    if (!judge || judge.role !== 'judge' || judge.status !== 'active') {
      return { success: false, assignment: null, error: 'Invalid or inactive judge' };
    }

    if (judge.assignedLevel !== submission.level) {
      return { success: false, assignment: null, error: 'Judge level does not match submission level' };
    }

    if (submission.level === 'Council') {
      if (judge.assignedRegion !== submission.region || judge.assignedCouncil !== submission.council) {
        return { success: false, assignment: null, error: 'Judge location does not match submission location' };
      }
    } else if (submission.level === 'Regional') {
      if (judge.assignedRegion !== submission.region) {
        return { success: false, assignment: null, error: 'Judge region does not match submission region' };
      }
    }

    const round = await getRoundForSubmission(submission, options.roundId || null);
    if (!round) {
      return { success: false, assignment: null, error: 'No active or ended round found for this submission level' };
    }

    const assignmentQuery = {
      roundId: round._id,
      submissionId
    };

    let assignment = await SubmissionAssignment.findOne(assignmentQuery);
    let message = 'Submission assigned successfully';

    if (assignment) {
      assignment.judgeId = judgeId;
      assignment.judgeNotified = false;
      await assignment.save();
      message = 'Submission reassigned successfully';
    } else {
      assignment = await SubmissionAssignment.create({
        roundId: round._id,
        submissionId,
        judgeId,
        level: submission.level,
        region: submission.region,
        council: submission.council || null,
        judgeNotified: false
      });
    }

    notificationService.handleJudgeAssigned({
      userId: judgeId.toString(),
      submissionId: submissionId.toString(),
      teacherName: submission.teacherName,
      subject: submission.subject,
      areaOfFocus: submission.areaOfFocus,
      level: submission.level,
      region: submission.region,
      council: submission.council
    }).catch((error) => {
      console.error('Error sending judge assignment notification:', error);
    });

    return {
      success: true,
      assignment,
      message,
      roundId: round._id.toString()
    };
  } catch (error) {
    console.error('Error manually assigning submission:', error);
    return {
      success: false,
      assignment: null,
      error: error.message
    };
  }
}

/**
 * Get eligible judges for a submission.
 */
async function getEligibleJudges(submissionId) {
  try {
    const submission = await Submission.findById(submissionId);

    if (!submission) {
      return { success: false, judges: [], error: 'Submission not found' };
    }

    if (submission.level === 'National') {
      return {
        success: true,
        judges: [],
        message: 'National level does not require assignment'
      };
    }

    const judgeQuery = {
      role: 'judge',
      status: 'active',
      assignedLevel: submission.level,
      ...buildAreaQueryByLevel(submission.level, submission.region, submission.council)
    };

    const judges = await User.find(judgeQuery)
      .select('_id name email username assignedLevel assignedRegion assignedCouncil')
      .sort({ name: 1 });

    return { success: true, judges };
  } catch (error) {
    console.error('Error getting eligible judges:', error);
    return {
      success: false,
      judges: [],
      error: error.message
    };
  }
}

module.exports = {
  assignJudgeToSubmission,
  getAssignedJudge,
  isJudgeAssigned,
  assignUnassignedSubmissionsToJudge,
  manuallyAssignSubmission,
  getEligibleJudges
};
