const User = require('../models/User');
const SubmissionAssignment = require('../models/SubmissionAssignment');
const notificationService = require('../services/notificationService');

/**
 * Assign a judge to a submission using round-robin algorithm
 * Only for Council and Regional levels (National doesn't need assignments)
 * 
 * @param {Object} submission - The submission object
 * @returns {Object} - { success: boolean, assignment: Object|null, error: string|null }
 */
async function assignJudgeToSubmission(submission) {
  try {
    // Only assign for Council and Regional levels
    if (submission.level === 'National') {
      return { success: true, assignment: null, message: 'National level does not require assignment' };
    }

    // Check if already assigned
    const existingAssignment = await SubmissionAssignment.findOne({ submissionId: submission._id });
    if (existingAssignment) {
      return { 
        success: true, 
        assignment: existingAssignment, 
        message: 'Submission already assigned' 
      };
    }

    // Find available judges for this location
    const judgeQuery = {
      role: 'judge',
      status: 'active',
      assignedLevel: submission.level
    };

    if (submission.level === 'Council') {
      judgeQuery.assignedRegion = submission.region;
      judgeQuery.assignedCouncil = submission.council;
    } else if (submission.level === 'Regional') {
      judgeQuery.assignedRegion = submission.region;
    }

    const availableJudges = await User.find(judgeQuery).select('_id name email');

    if (availableJudges.length === 0) {
      return { 
        success: false, 
        assignment: null, 
        error: `No active judges found for ${submission.level} level at ${submission.region}${submission.council ? ` - ${submission.council}` : ''}` 
      };
    }

    // Get all existing assignments for this location to implement round-robin
    const existingAssignments = await SubmissionAssignment.find({
      level: submission.level,
      region: submission.region,
      ...(submission.level === 'Council' && { council: submission.council })
    }).select('judgeId');

    // Count assignments per judge
    const assignmentCounts = {};
    availableJudges.forEach(judge => {
      assignmentCounts[judge._id.toString()] = 0;
    });

    existingAssignments.forEach(assignment => {
      const judgeId = assignment.judgeId.toString();
      if (assignmentCounts[judgeId] !== undefined) {
        assignmentCounts[judgeId]++;
      }
    });

    // Find judge with minimum assignments (round-robin)
    let selectedJudge = availableJudges[0];
    let minCount = assignmentCounts[selectedJudge._id.toString()];

    for (const judge of availableJudges) {
      const count = assignmentCounts[judge._id.toString()];
      if (count < minCount) {
        minCount = count;
        selectedJudge = judge;
      }
    }

    // Create assignment
    const assignment = await SubmissionAssignment.create({
      submissionId: submission._id,
      judgeId: selectedJudge._id,
      level: submission.level,
      region: submission.region,
      council: submission.council || null,
      judgeNotified: false
    });

    // Send notification to judge (non-blocking)
    notificationService.handleJudgeAssigned({
      userId: selectedJudge._id.toString(),
      submissionId: submission._id.toString(),
      teacherName: submission.teacherName,
      subject: submission.subject,
      areaOfFocus: submission.areaOfFocus,
      level: submission.level,
      region: submission.region,
      council: submission.council
    }).catch(error => {
      console.error('Error sending judge assignment notification:', error);
    });

    // Mark as notified
    assignment.judgeNotified = true;
    await assignment.save();

    return { 
      success: true, 
      assignment: assignment,
      judge: selectedJudge
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
 * Get assigned judge for a submission
 * @param {ObjectId} submissionId - The submission ID
 * @returns {Object|null} - The assignment object or null
 */
async function getAssignedJudge(submissionId) {
  try {
    const assignment = await SubmissionAssignment.findOne({ submissionId })
      .populate('judgeId', 'name email username');
    return assignment;
  } catch (error) {
    console.error('Error getting assigned judge:', error);
    return null;
  }
}

/**
 * Check if a judge is assigned to a submission
 * @param {ObjectId} submissionId - The submission ID
 * @param {ObjectId} judgeId - The judge ID
 * @returns {boolean}
 */
async function isJudgeAssigned(submissionId, judgeId) {
  try {
    const assignment = await SubmissionAssignment.findOne({
      submissionId,
      judgeId
    });
    return !!assignment;
  } catch (error) {
    console.error('Error checking judge assignment:', error);
    return false;
  }
}

module.exports = {
  assignJudgeToSubmission,
  getAssignedJudge,
  isJudgeAssigned
};

