const User = require('../models/User');
const Submission = require('../models/Submission');
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

/**
 * Assign unassigned submissions to a newly created judge
 * Uses round-robin to distribute submissions evenly
 * 
 * @param {Object} judge - The judge user object
 * @returns {Object} - { success: boolean, assignedCount: number, error: string|null }
 */
async function assignUnassignedSubmissionsToJudge(judge) {
  try {
    // Only assign for Council and Regional levels
    if (judge.assignedLevel === 'National') {
      return { success: true, assignedCount: 0, message: 'National level does not require assignment' };
    }

    // Check if judge has required assignment data
    if (!judge.assignedLevel) {
      return { success: true, assignedCount: 0, message: 'Judge assignment not configured' };
    }

    if (judge.assignedLevel === 'Council' && (!judge.assignedRegion || !judge.assignedCouncil)) {
      return { success: true, assignedCount: 0, message: 'Judge assignment incomplete' };
    }

    if (judge.assignedLevel === 'Regional' && !judge.assignedRegion) {
      return { success: true, assignedCount: 0, message: 'Judge assignment incomplete' };
    }

    // Find unassigned submissions for this judge's location
    const submissionQuery = {
      level: judge.assignedLevel,
      status: { $nin: ['promoted', 'eliminated'] } // Only assign active submissions
    };

    if (judge.assignedLevel === 'Council') {
      submissionQuery.region = judge.assignedRegion;
      submissionQuery.council = judge.assignedCouncil;
    } else if (judge.assignedLevel === 'Regional') {
      submissionQuery.region = judge.assignedRegion;
    }

    // Get all submissions for this location
    const allSubmissions = await Submission.find(submissionQuery);

    // Get all existing assignments for this location
    const existingAssignments = await SubmissionAssignment.find({
      level: judge.assignedLevel,
      region: judge.assignedRegion,
      ...(judge.assignedLevel === 'Council' && { council: judge.assignedCouncil })
    }).select('submissionId judgeId');

    const assignedSubmissionIds = new Set(
      existingAssignments.map(a => a.submissionId.toString())
    );

    // Filter to get unassigned submissions
    const unassignedSubmissions = allSubmissions.filter(
      sub => !assignedSubmissionIds.has(sub._id.toString())
    );

    if (unassignedSubmissions.length === 0) {
      return { success: true, assignedCount: 0, message: 'No unassigned submissions found' };
    }

    // Get all active judges for this location (for round-robin)
    const judgeQuery = {
      role: 'judge',
      status: 'active',
      assignedLevel: judge.assignedLevel
    };

    if (judge.assignedLevel === 'Council') {
      judgeQuery.assignedRegion = judge.assignedRegion;
      judgeQuery.assignedCouncil = judge.assignedCouncil;
    } else if (judge.assignedLevel === 'Regional') {
      judgeQuery.assignedRegion = judge.assignedRegion;
    }

    const allJudges = await User.find(judgeQuery).select('_id');

    // Count current assignments per judge
    const assignmentCounts = {};
    allJudges.forEach(j => {
      assignmentCounts[j._id.toString()] = 0;
    });

    existingAssignments.forEach(assignment => {
      const judgeId = assignment.judgeId.toString();
      if (assignmentCounts[judgeId] !== undefined) {
        assignmentCounts[judgeId]++;
      }
    });

    // Assign unassigned submissions using round-robin
    let assignedCount = 0;
    for (const submission of unassignedSubmissions) {
      // Find judge with minimum assignments
      let selectedJudge = allJudges[0];
      let minCount = assignmentCounts[selectedJudge._id.toString()];

      for (const j of allJudges) {
        const count = assignmentCounts[j._id.toString()];
        if (count < minCount) {
          minCount = count;
          selectedJudge = j;
        }
      }

      // Create assignment
      await SubmissionAssignment.create({
        submissionId: submission._id,
        judgeId: selectedJudge._id,
        level: submission.level,
        region: submission.region,
        council: submission.council || null,
        judgeNotified: false
      });

      // Update count
      assignmentCounts[selectedJudge._id.toString()]++;
      assignedCount++;

      // Send notification if assigned to the new judge
      if (selectedJudge._id.toString() === judge._id.toString()) {
        notificationService.handleJudgeAssigned({
          userId: judge._id.toString(),
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
      }
    }

    return { 
      success: true, 
      assignedCount,
      message: `Assigned ${assignedCount} submission(s) to judges in this location`
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
 * Manually assign a submission to a specific judge
 * 
 * @param {ObjectId} submissionId - The submission ID
 * @param {ObjectId} judgeId - The judge ID
 * @returns {Object} - { success: boolean, assignment: Object|null, error: string|null }
 */
async function manuallyAssignSubmission(submissionId, judgeId) {
  try {
    const submission = await Submission.findById(submissionId);
    
    if (!submission) {
      return { success: false, assignment: null, error: 'Submission not found' };
    }

    // Only assign for Council and Regional levels
    if (submission.level === 'National') {
      return { success: false, assignment: null, error: 'National level does not require assignment' };
    }

    const judge = await User.findById(judgeId);
    if (!judge || judge.role !== 'judge' || judge.status !== 'active') {
      return { success: false, assignment: null, error: 'Invalid or inactive judge' };
    }

    // Verify judge is eligible for this submission
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

    // Check if submission is already assigned
    const existingAssignment = await SubmissionAssignment.findOne({ submissionId });
    if (existingAssignment) {
      // Update existing assignment
      existingAssignment.judgeId = judgeId;
      existingAssignment.judgeNotified = false;
      await existingAssignment.save();

      // Send notification
      notificationService.handleJudgeAssigned({
        userId: judgeId.toString(),
        submissionId: submissionId.toString(),
        teacherName: submission.teacherName,
        subject: submission.subject,
        areaOfFocus: submission.areaOfFocus,
        level: submission.level,
        region: submission.region,
        council: submission.council
      }).catch(error => {
        console.error('Error sending judge assignment notification:', error);
      });

      return { 
        success: true, 
        assignment: existingAssignment,
        message: 'Submission reassigned successfully'
      };
    }

    // Create new assignment
    const assignment = await SubmissionAssignment.create({
      submissionId,
      judgeId,
      level: submission.level,
      region: submission.region,
      council: submission.council || null,
      judgeNotified: false
    });

    // Send notification
    notificationService.handleJudgeAssigned({
      userId: judgeId.toString(),
      submissionId: submissionId.toString(),
      teacherName: submission.teacherName,
      subject: submission.subject,
      areaOfFocus: submission.areaOfFocus,
      level: submission.level,
      region: submission.region,
      council: submission.council
    }).catch(error => {
      console.error('Error sending judge assignment notification:', error);
    });

    return { 
      success: true, 
      assignment,
      message: 'Submission assigned successfully'
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
 * Get eligible judges for a submission
 * 
 * @param {ObjectId} submissionId - The submission ID
 * @returns {Object} - { success: boolean, judges: Array, error: string|null }
 */
async function getEligibleJudges(submissionId) {
  try {
    const submission = await Submission.findById(submissionId);
    
    if (!submission) {
      return { success: false, judges: [], error: 'Submission not found' };
    }

    // Only for Council and Regional levels
    if (submission.level === 'National') {
      return { success: true, judges: [], message: 'National level does not require assignment' };
    }

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




