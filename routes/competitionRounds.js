const express = require('express');
const CompetitionRound = require('../models/CompetitionRound');
const Submission = require('../models/Submission');
const Evaluation = require('../models/Evaluation');
const User = require('../models/User');
const Quota = require('../models/Quota');
const { protect, authorize } = require('../middleware/auth');

// Safely import logger
let logger = null;
try {
  const loggerModule = require('../utils/logger');
  logger = loggerModule.logger;
} catch (error) {
  logger = {
    logAdminAction: () => Promise.resolve(),
    logSystemEvent: () => Promise.resolve()
  };
}

const router = express.Router();

// All routes require authentication and superadmin role
router.use(protect);
router.use(authorize('superadmin'));

// Helper: Get next level
const getNextLevel = (currentLevel) => {
  const levels = ['Council', 'Regional', 'National'];
  const index = levels.indexOf(currentLevel);
  return index >= 0 && index < levels.length - 1 ? levels[index + 1] : null;
};

// Helper: Check if all judges have completed evaluations for submissions at a level
const checkAllJudgesCompleted = async (level, year, region = null, council = null) => {
  try {
    // Build query for submissions at this level
    const submissionQuery = {
      level,
      year: parseInt(year),
      status: { $in: ['submitted', 'evaluated'] }
    };
    
    if (region) submissionQuery.region = region;
    if (council) submissionQuery.council = council;

    const submissions = await Submission.find(submissionQuery);
    
    if (submissions.length === 0) return { allCompleted: true, pendingCount: 0 };

    // Get all judges assigned to this level
    const judgeQuery = { role: 'judge', assignedLevel: level, status: 'active' };
    if (level === 'Council' && region && council) {
      judgeQuery.assignedRegion = region;
      judgeQuery.assignedCouncil = council;
    } else if (level === 'Regional' && region) {
      judgeQuery.assignedRegion = region;
    }
    
    const judges = await User.find(judgeQuery);
    
    if (judges.length === 0) {
      return { allCompleted: false, pendingCount: submissions.length, reason: 'No judges assigned' };
    }

    // Check if each submission has been evaluated by all assigned judges
    let pendingCount = 0;
    for (const submission of submissions) {
      const evaluations = await Evaluation.find({ submissionId: submission._id });
      const evaluatedJudgeIds = evaluations.map(e => e.judgeId.toString());
      
      // Check if all judges have evaluated this submission
      const allJudgesEvaluated = judges.every(judge => 
        evaluatedJudgeIds.includes(judge._id.toString())
      );
      
      if (!allJudgesEvaluated) {
        pendingCount++;
      }
    }

    return {
      allCompleted: pendingCount === 0,
      pendingCount,
      totalSubmissions: submissions.length,
      totalJudges: judges.length
    };
  } catch (error) {
    console.error('Error checking judge completion:', error);
    return { allCompleted: false, pendingCount: -1, error: error.message };
  }
};

// Helper: Advance submissions to next level based on quotas
const advanceSubmissions = async (level, year, region = null, council = null) => {
  try {
    const nextLevel = getNextLevel(level);
    if (!nextLevel) {
      return { success: false, error: 'Already at top level' };
    }

    // Build query
    const query = {
      level,
      year: parseInt(year),
      status: { $in: ['submitted', 'evaluated'] }
    };
    
    if (region) query.region = region;
    if (council) query.council = council;

    const submissions = await Submission.find(query)
      .populate('teacherId', 'name email')
      .sort({ averageScore: -1 });

    if (submissions.length === 0) {
      return { success: false, error: 'No submissions found' };
    }

    // Get quota for this level
    const quotaDoc = await Quota.findOne({ year: parseInt(year), level });
    const quota = quotaDoc ? quotaDoc.quota : 0;

    // Group by location if Council or Regional level
    const groups = {};
    submissions.forEach(sub => {
      let locationKey;
      if (level === 'Council') {
        locationKey = `${sub.region}::${sub.council}`;
      } else if (level === 'Regional') {
        locationKey = sub.region;
      } else {
        locationKey = 'national';
      }
      
      if (!groups[locationKey]) {
        groups[locationKey] = [];
      }
      groups[locationKey].push(sub);
    });

    const toPromote = [];
    const toEliminate = [];

    // Process each location group
    Object.keys(groups).forEach(locationKey => {
      const locationSubs = groups[locationKey].sort((a, b) => 
        (b.averageScore || 0) - (a.averageScore || 0)
      );

      if (locationSubs.length <= quota) {
        // All advance if within quota
        toPromote.push(...locationSubs);
      } else {
        // Top N advance, rest eliminated
        toPromote.push(...locationSubs.slice(0, quota));
        toEliminate.push(...locationSubs.slice(quota));
      }
    });

    // Update submissions
    const promotedIds = [];
    const eliminatedIds = [];

    for (const sub of toPromote) {
      await Submission.findByIdAndUpdate(sub._id, {
        level: nextLevel,
        status: 'approved'
      });
      promotedIds.push(sub._id.toString());
    }

    for (const sub of toEliminate) {
      await Submission.findByIdAndUpdate(sub._id, {
        status: 'eliminated'
      });
      eliminatedIds.push(sub._id.toString());
    }

    return {
      success: true,
      promoted: promotedIds.length,
      eliminated: eliminatedIds.length,
      promotedIds,
      eliminatedIds
    };
  } catch (error) {
    console.error('Error advancing submissions:', error);
    return { success: false, error: error.message };
  }
};

// @route   GET /api/competition-rounds
// @desc    Get all competition rounds
// @access  Private (Superadmin)
router.get('/', async (req, res) => {
  try {
    const { year, level, status } = req.query;
    
    let query = {};
    if (year) query.year = parseInt(year);
    if (level) query.level = level;
    if (status) query.status = status;

    const rounds = await CompetitionRound.find(query)
      .populate('closedBy', 'name email')
      .sort({ year: -1, level: 1, createdAt: -1 });

    res.json({
      success: true,
      count: rounds.length,
      rounds
    });
  } catch (error) {
    console.error('Get competition rounds error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/competition-rounds/:id
// @desc    Get single competition round
// @access  Private (Superadmin)
router.get('/:id', async (req, res) => {
  try {
    const round = await CompetitionRound.findById(req.params.id)
      .populate('closedBy', 'name email');

    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    res.json({
      success: true,
      round
    });
  } catch (error) {
    console.error('Get competition round error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/competition-rounds
// @desc    Create new competition round
// @access  Private (Superadmin)
router.post('/', async (req, res) => {
  try {
    const {
      year,
      level,
      timingType,
      endTime,
      startTime,
      countdownDuration,
      region,
      council,
      autoAdvance,
      waitForAllJudges,
      reminderEnabled,
      reminderFrequency
    } = req.body;

    // Validate required fields
    if (!year || !level || !timingType || !endTime) {
      return res.status(400).json({
        success: false,
        message: 'Please provide year, level, timingType, and endTime'
      });
    }

    // Validate timing type
    if (timingType === 'countdown' && !countdownDuration) {
      return res.status(400).json({
        success: false,
        message: 'countdownDuration is required for countdown timing type'
      });
    }

    // Calculate end time for countdown
    let actualEndTime = new Date(endTime);
    if (timingType === 'countdown' && countdownDuration) {
      const start = startTime ? new Date(startTime) : new Date();
      actualEndTime = new Date(start.getTime() + parseInt(countdownDuration));
    }

    // Check if round already exists for this year/level/location
    const existingQuery = {
      year: parseInt(year),
      level,
      status: { $in: ['pending', 'active'] }
    };
    if (region) existingQuery.region = region;
    if (council) existingQuery.council = council;

    const existing = await CompetitionRound.findOne(existingQuery);
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'An active or pending round already exists for this year, level, and location'
      });
    }

    const roundData = {
      year: parseInt(year),
      level,
      timingType,
      endTime: actualEndTime,
      startTime: startTime ? new Date(startTime) : null,
      countdownDuration: countdownDuration ? parseInt(countdownDuration) : null,
      region: region || null,
      council: council || null,
      autoAdvance: autoAdvance !== undefined ? autoAdvance : true,
      waitForAllJudges: waitForAllJudges !== undefined ? waitForAllJudges : true,
      reminderEnabled: reminderEnabled !== undefined ? reminderEnabled : true,
      reminderFrequency: reminderFrequency || 'daily',
      status: 'pending'
    };

    const round = await CompetitionRound.create(roundData);

    // Log round creation
    if (logger) {
      logger.logAdminAction(
        'Superadmin created competition round',
        req.user._id,
        req,
        {
          roundId: round._id.toString(),
          year: round.year,
          level: round.level,
          timingType: round.timingType,
          endTime: round.endTime
        },
        'success'
      ).catch(() => {});
    }

    res.status(201).json({
      success: true,
      round
    });
  } catch (error) {
    console.error('Create competition round error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   PUT /api/competition-rounds/:id
// @desc    Update competition round
// @access  Private (Superadmin)
router.put('/:id', async (req, res) => {
  try {
    const round = await CompetitionRound.findById(req.params.id);

    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    // Don't allow updating ended/closed rounds
    if (round.status === 'ended' || round.status === 'closed') {
      return res.status(400).json({
        success: false,
        message: 'Cannot update ended or closed rounds'
      });
    }

    // Update fields
    const updateData = { ...req.body };
    
    // Recalculate end time if timing changed
    if (updateData.timingType === 'countdown' && updateData.countdownDuration) {
      const start = updateData.startTime ? new Date(updateData.startTime) : (round.startTime || round.createdAt);
      updateData.endTime = new Date(start.getTime() + parseInt(updateData.countdownDuration));
    }

    const updatedRound = await CompetitionRound.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    // Log round update
    if (logger) {
      logger.logAdminAction(
        'Superadmin updated competition round',
        req.user._id,
        req,
        {
          roundId: req.params.id,
          updatedFields: Object.keys(updateData)
        }
      ).catch(() => {});
    }

    res.json({
      success: true,
      round: updatedRound
    });
  } catch (error) {
    console.error('Update competition round error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/competition-rounds/:id/activate
// @desc    Activate a competition round
// @access  Private (Superadmin)
router.post('/:id/activate', async (req, res) => {
  try {
    const round = await CompetitionRound.findById(req.params.id);

    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    if (round.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Round must be in pending status to activate'
      });
    }

    // Update start time if countdown and not set
    if (round.timingType === 'countdown' && !round.startTime) {
      round.startTime = new Date();
      round.endTime = new Date(round.startTime.getTime() + round.countdownDuration);
    }

    round.status = 'active';
    await round.save();

    // Log activation
    if (logger) {
      logger.logAdminAction(
        'Superadmin activated competition round',
        req.user._id,
        req,
        {
          roundId: req.params.id,
          year: round.year,
          level: round.level
        },
        'success'
      ).catch(() => {});
    }

    res.json({
      success: true,
      round
    });
  } catch (error) {
    console.error('Activate competition round error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/competition-rounds/:id/close
// @desc    Close a competition round and advance submissions
// @access  Private (Superadmin)
router.post('/:id/close', async (req, res) => {
  try {
    const round = await CompetitionRound.findById(req.params.id);

    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    if (round.status === 'closed') {
      return res.status(400).json({
        success: false,
        message: 'Round is already closed'
      });
    }

    // Check if all judges completed (if waitForAllJudges is enabled)
    if (round.waitForAllJudges) {
      const completionStatus = await checkAllJudgesCompleted(
        round.level,
        round.year,
        round.region,
        round.council
      );

      if (!completionStatus.allCompleted) {
        return res.status(400).json({
          success: false,
          message: `Cannot close round - ${completionStatus.pendingCount} submissions still pending evaluation`,
          completionStatus
        });
      }
    }

    // Advance submissions
    const advanceResult = await advanceSubmissions(
      round.level,
      round.year,
      round.region,
      round.council
    );

    if (!advanceResult.success) {
      return res.status(400).json({
        success: false,
        message: advanceResult.error || 'Failed to advance submissions'
      });
    }

    // Send notifications to teachers
    const { notifyTeachersOnPromotion, notifyTeachersOnElimination } = require('../utils/notifications');
    if (advanceResult.promotedIds && advanceResult.promotedIds.length > 0) {
      const nextLevel = getNextLevel(round.level);
      if (nextLevel) {
        notifyTeachersOnPromotion(advanceResult.promotedIds, nextLevel).catch(err => 
          console.error('Error sending promotion notifications:', err)
        );
      }
    }
    if (advanceResult.eliminatedIds && advanceResult.eliminatedIds.length > 0) {
      notifyTeachersOnElimination(advanceResult.eliminatedIds).catch(err => 
        console.error('Error sending elimination notifications:', err)
      );
    }

    // Update round status
    round.status = 'closed';
    round.closedAt = new Date();
    round.closedBy = req.user._id;
    await round.save();

    // Log round closure
    if (logger) {
      logger.logAdminAction(
        'Superadmin closed competition round',
        req.user._id,
        req,
        {
          roundId: req.params.id,
          year: round.year,
          level: round.level,
          promoted: advanceResult.promoted,
          eliminated: advanceResult.eliminated
        },
        'success'
      ).catch(() => {});
    }

    res.json({
      success: true,
      round,
      advancement: advanceResult
    });
  } catch (error) {
    console.error('Close competition round error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/competition-rounds/:id/extend
// @desc    Extend a competition round's end time
// @access  Private (Superadmin)
router.post('/:id/extend', async (req, res) => {
  try {
    const { additionalTime } = req.body; // in milliseconds

    if (!additionalTime) {
      return res.status(400).json({
        success: false,
        message: 'Please provide additionalTime in milliseconds'
      });
    }

    const round = await CompetitionRound.findById(req.params.id);

    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    if (round.status === 'closed') {
      return res.status(400).json({
        success: false,
        message: 'Cannot extend closed round'
      });
    }

    const newEndTime = new Date(round.endTime.getTime() + parseInt(additionalTime));
    round.endTime = newEndTime;

    // Update countdown duration if it's a countdown type
    if (round.timingType === 'countdown' && round.startTime) {
      round.countdownDuration = newEndTime - round.startTime;
    }

    await round.save();

    // Log extension
    if (logger) {
      logger.logAdminAction(
        'Superadmin extended competition round',
        req.user._id,
        req,
        {
          roundId: req.params.id,
          additionalTime: parseInt(additionalTime),
          newEndTime: newEndTime
        }
      ).catch(() => {});
    }

    res.json({
      success: true,
      round
    });
  } catch (error) {
    console.error('Extend competition round error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   GET /api/competition-rounds/:id/judge-progress
// @desc    Get judge progress for a competition round
// @access  Private (Superadmin)
router.get('/:id/judge-progress', async (req, res) => {
  try {
    const round = await CompetitionRound.findById(req.params.id);

    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    // Get all submissions at this level
    const submissionQuery = {
      level: round.level,
      year: round.year,
      status: { $in: ['submitted', 'evaluated'] }
    };
    
    if (round.region) submissionQuery.region = round.region;
    if (round.council) submissionQuery.council = round.council;

    const submissions = await Submission.find(submissionQuery);

    // Get all judges assigned to this level
    const judgeQuery = { role: 'judge', assignedLevel: round.level, status: 'active' };
    if (round.level === 'Council' && round.region && round.council) {
      judgeQuery.assignedRegion = round.region;
      judgeQuery.assignedCouncil = round.council;
    } else if (round.level === 'Regional' && round.region) {
      judgeQuery.assignedRegion = round.region;
    }

    const judges = await User.find(judgeQuery).select('name email username assignedLevel assignedRegion assignedCouncil');

    // Calculate progress for each judge
    const judgeProgress = await Promise.all(judges.map(async (judge) => {
      const evaluations = await Evaluation.find({ judgeId: judge._id });
      const evaluatedSubmissionIds = evaluations.map(e => e.submissionId.toString());
      
      const assignedSubmissions = submissions.filter(sub => {
        // Check if judge is assigned to this submission's location
        if (round.level === 'Council') {
          return sub.region === judge.assignedRegion && sub.council === judge.assignedCouncil;
        } else if (round.level === 'Regional') {
          return sub.region === judge.assignedRegion;
        }
        return true; // National level - all judges see all
      });

      const completed = assignedSubmissions.filter(sub => 
        evaluatedSubmissionIds.includes(sub._id.toString())
      ).length;

      const total = assignedSubmissions.length;
      const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

      return {
        judgeId: judge._id.toString(),
        judgeName: judge.name,
        judgeEmail: judge.email,
        judgeUsername: judge.username,
        assignedLevel: judge.assignedLevel,
        assignedRegion: judge.assignedRegion,
        assignedCouncil: judge.assignedCouncil,
        totalAssigned: total,
        completed: completed,
        pending: total - completed,
        percentage: percentage,
        pendingSubmissionIds: assignedSubmissions
          .filter(sub => !evaluatedSubmissionIds.includes(sub._id.toString()))
          .map(sub => sub._id.toString())
      };
    }));

    // Calculate overall statistics
    const totalSubmissions = submissions.length;
    const totalJudges = judges.length;
    const totalEvaluations = await Evaluation.countDocuments({
      submissionId: { $in: submissions.map(s => s._id) }
    });
    const averageProgress = judgeProgress.length > 0
      ? Math.round(judgeProgress.reduce((sum, j) => sum + j.percentage, 0) / judgeProgress.length)
      : 0;

    res.json({
      success: true,
      round: {
        id: round._id.toString(),
        year: round.year,
        level: round.level,
        status: round.status
      },
      statistics: {
        totalSubmissions,
        totalJudges,
        totalEvaluations,
        averageProgress
      },
      judgeProgress
    });
  } catch (error) {
    console.error('Get judge progress error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;

