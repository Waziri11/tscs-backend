const Notification = require('../models/Notification');
const User = require('../models/User');
const Submission = require('../models/Submission');

// Safely import logger
let logger = null;
try {
  const loggerModule = require('./logger');
  logger = loggerModule.logger;
} catch (error) {
  logger = {
    logSystemEvent: () => Promise.resolve()
  };
}

/**
 * Create a notification for a user
 * @param {Object} options - Notification options
 * @param {String} options.userId - User ID to notify
 * @param {String} options.type - Notification type
 * @param {String} options.title - Notification title
 * @param {String} options.message - Notification message
 * @param {Object} options.metadata - Additional metadata
 * @returns {Promise<Object>} Created notification
 */
const createNotification = async ({ userId, type, title, message, metadata = {} }) => {
  try {
    const notification = await Notification.create({
      userId,
      type,
      title,
      message,
      metadata,
      read: false
    });

    // Log notification creation
    if (logger) {
      logger.logSystemEvent(
        'Notification created',
        null,
        {
          notificationId: notification._id.toString(),
          userId: userId.toString(),
          type,
          title
        }
      ).catch(() => {});
    }

    return notification;
  } catch (error) {
    console.error('Error creating notification:', error);
    throw error;
  }
};

/**
 * Notify teachers when their submission is promoted
 * @param {Array} submissionIds - Array of submission IDs that were promoted
 * @param {String} newLevel - New level (Regional or National)
 */
const notifyTeachersOnPromotion = async (submissionIds, newLevel) => {
  try {
    const submissions = await Submission.find({
      _id: { $in: submissionIds }
    }).populate('teacherId', 'name email');

    for (const submission of submissions) {
      if (submission.teacherId) {
        await createNotification({
          userId: submission.teacherId._id,
          type: 'submission_promoted',
          title: 'Submission Promoted!',
          message: `Congratulations! Your submission "${submission.title || submission._id}" has been promoted to ${newLevel} level.`,
          metadata: {
            submissionId: submission._id.toString(),
            newLevel,
            oldLevel: submission.level
          }
        });
      }
    }
  } catch (error) {
    console.error('Error notifying teachers on promotion:', error);
  }
};

/**
 * Notify teachers when their submission is eliminated
 * @param {Array} submissionIds - Array of submission IDs that were eliminated
 */
const notifyTeachersOnElimination = async (submissionIds) => {
  try {
    const submissions = await Submission.find({
      _id: { $in: submissionIds }
    }).populate('teacherId', 'name email');

    for (const submission of submissions) {
      if (submission.teacherId) {
        await createNotification({
          userId: submission.teacherId._id,
          type: 'submission_eliminated',
          title: 'Submission Status Update',
          message: `Your submission "${submission.title || submission._id}" did not advance to the next level. Thank you for participating!`,
          metadata: {
            submissionId: submission._id.toString(),
            level: submission.level
          }
        });
      }
    }
  } catch (error) {
    console.error('Error notifying teachers on elimination:', error);
  }
};

/**
 * Notify judges about pending evaluations
 * @param {String} judgeId - Judge user ID
 * @param {Number} pendingCount - Number of pending evaluations
 * @param {String} level - Competition level
 */
const notifyJudgePendingEvaluations = async (judgeId, pendingCount, level) => {
  try {
    await createNotification({
      userId: judgeId,
      type: 'evaluation_reminder',
      title: 'Pending Evaluations Reminder',
      message: `You have ${pendingCount} pending evaluation${pendingCount > 1 ? 's' : ''} for ${level} level. Please complete them before the round ends.`,
      metadata: {
        pendingCount,
        level
      }
    });
  } catch (error) {
    console.error('Error notifying judge about pending evaluations:', error);
  }
};

/**
 * Notify judges when round is ending soon
 * @param {String} judgeId - Judge user ID
 * @param {String} level - Competition level
 * @param {Date} endTime - Round end time
 * @param {Number} hoursRemaining - Hours remaining until round ends
 */
const notifyJudgeRoundEndingSoon = async (judgeId, level, endTime, hoursRemaining) => {
  try {
    await createNotification({
      userId: judgeId,
      type: 'round_ending_soon',
      title: 'Round Ending Soon',
      message: `The ${level} level round is ending in ${hoursRemaining} hour${hoursRemaining > 1 ? 's' : ''}. Please complete any pending evaluations.`,
      metadata: {
        level,
        endTime: endTime.toISOString(),
        hoursRemaining
      }
    });
  } catch (error) {
    console.error('Error notifying judge about round ending soon:', error);
  }
};

/**
 * Notify users when a round starts
 * @param {String} userId - User ID
 * @param {String} level - Competition level
 * @param {Number} year - Competition year
 */
const notifyRoundStarted = async (userId, level, year) => {
  try {
    await createNotification({
      userId,
      type: 'round_started',
      title: 'Round Started',
      message: `The ${level} level round for ${year} competition has started.`,
      metadata: {
        level,
        year
      }
    });
  } catch (error) {
    console.error('Error notifying round started:', error);
  }
};

/**
 * Notify all judges assigned to a level about pending evaluations
 * @param {String} level - Competition level
 * @param {String} region - Region (optional)
 * @param {String} council - Council (optional)
 */
const notifyAllJudgesPendingEvaluations = async (level, region = null, council = null) => {
  try {
    const judgeQuery = {
      role: 'judge',
      assignedLevel: level,
      status: 'active'
    };

    if (level === 'Council' && region && council) {
      judgeQuery.assignedRegion = region;
      judgeQuery.assignedCouncil = council;
    } else if (level === 'Regional' && region) {
      judgeQuery.assignedRegion = region;
    }

    const judges = await User.find(judgeQuery);

    // Get submissions at this level
    const submissionQuery = {
      level,
      status: { $in: ['submitted', 'evaluated'] }
    };
    if (region) submissionQuery.region = region;
    if (council) submissionQuery.council = council;

    const submissions = await Submission.find(submissionQuery);
    const Submission = require('../models/Submission');
    const Evaluation = require('../models/Evaluation');

    for (const judge of judges) {
      // Count pending evaluations for this judge
      const evaluations = await Evaluation.find({ judgeId: judge._id });
      const evaluatedSubmissionIds = evaluations.map(e => e.submissionId.toString());
      
      const assignedSubmissions = submissions.filter(sub => {
        if (level === 'Council') {
          return sub.region === judge.assignedRegion && sub.council === judge.assignedCouncil;
        } else if (level === 'Regional') {
          return sub.region === judge.assignedRegion;
        }
        return true;
      });

      const pendingCount = assignedSubmissions.filter(sub =>
        !evaluatedSubmissionIds.includes(sub._id.toString())
      ).length;

      if (pendingCount > 0) {
        await notifyJudgePendingEvaluations(judge._id, pendingCount, level);
      }
    }
  } catch (error) {
    console.error('Error notifying all judges:', error);
  }
};

module.exports = {
  createNotification,
  notifyTeachersOnPromotion,
  notifyTeachersOnElimination,
  notifyJudgePendingEvaluations,
  notifyJudgeRoundEndingSoon,
  notifyRoundStarted,
  notifyAllJudgesPendingEvaluations
};

