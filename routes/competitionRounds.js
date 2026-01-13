const express = require('express');
const CompetitionRound = require('../models/CompetitionRound');
const Submission = require('../models/Submission');
const Evaluation = require('../models/Evaluation');
const User = require('../models/User');
const Quota = require('../models/Quota');
const SubmissionAssignment = require('../models/SubmissionAssignment');
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

// All routes require authentication
router.use(protect);

// Public route for judges to get active rounds
router.get('/active', async (req, res) => {
  try {
    const { level } = req.query;
    const user = req.user;
    
    // Build query for active rounds
    let query = { status: 'active' };
    
    if (level) {
      query.level = level;
    }

    // Fetch all active rounds for the level (we'll filter by location in code for better reliability)
    const allRounds = await CompetitionRound.find(query)
      .sort({ createdAt: -1 })
      .limit(50); // Get more rounds, we'll filter them

    // If user is a judge, filter rounds based on their assignment and return only the most specific one
    let rounds = allRounds;
    if (user && user.role === 'judge' && user.assignedLevel) {
      const judgeLevel = user.assignedLevel;
      // Normalize region and council names for comparison (trim and lowercase)
      const judgeRegion = user.assignedRegion ? user.assignedRegion.trim().toLowerCase() : null;
      const judgeCouncil = user.assignedCouncil ? user.assignedCouncil.trim().toLowerCase() : null;
      
      // Filter eligible rounds and score them by specificity
      const eligibleRounds = allRounds.map(round => {
        // Normalize round location data
        const roundRegion = round.region ? round.region.toString().trim().toLowerCase() : null;
        const roundCouncil = round.council ? round.council.toString().trim().toLowerCase() : null;
        
        let matchScore = 0;
        let isEligible = false;
        
        // Match based on judge level
        if (judgeLevel === 'Council' && judgeRegion) {
          // Council judges should see:
          // 1. Rounds for all councils in their region (region matches, council is null/empty) - score: 50
          // 2. Rounds for their specific council (region and council both match) - score: 100 (most specific)
          if (roundRegion === judgeRegion) {
            if (!roundCouncil) {
              // Round is for all councils in region
              matchScore = 50;
              isEligible = true;
            } else if (judgeCouncil && roundCouncil === judgeCouncil) {
              // Specific council matches - most specific
              matchScore = 100;
              isEligible = true;
            }
          }
        } else if (judgeLevel === 'Regional' && judgeRegion) {
          // Regional judges should see rounds for their region (council must be null/empty)
          if (roundRegion === judgeRegion && !roundCouncil) {
            matchScore = 100;
            isEligible = true;
          }
        } else if (judgeLevel === 'National') {
          // National judges only see nationwide rounds
          if (!roundRegion && !roundCouncil) {
            matchScore = 100;
            isEligible = true;
          }
        }
        
        return { round, matchScore, isEligible };
      }).filter(item => item.isEligible);
      
      // Sort by match score (descending) and return only the most specific round
      if (eligibleRounds.length > 0) {
        eligibleRounds.sort((a, b) => b.matchScore - a.matchScore);
        rounds = [eligibleRounds[0].round]; // Return only the most specific round
      } else {
        rounds = [];
      }
    }

    res.json({
      success: true,
      count: rounds.length,
      rounds
    });
  } catch (error) {
    console.error('Get active rounds error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// All other routes require superadmin role
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

// Helper: Advance submissions for a specific round based on leaderboard and quota
const advanceSubmissionsForRound = async (round, submissions) => {
  try {
    const nextLevel = getNextLevel(round.level);
    if (!nextLevel) {
      return { success: false, error: 'Already at top level' };
    }

    if (submissions.length === 0) {
      return { success: false, error: 'No submissions found for this round' };
    }

    // Get quota for this level
    const quotaDoc = await Quota.findOne({ year: round.year, level: round.level });
    const quota = quotaDoc ? quotaDoc.quota : 0;

    // Group submissions by location for quota application
    // At council level, group by location AND area of focus for top 3 per area
    const groups = {};
    submissions.forEach(sub => {
      let locationKey;
      if (round.level === 'Council') {
        // Group by region, council, AND area of focus for top 3 per area
        locationKey = `${sub.region}::${sub.council}::${sub.areaOfFocus}`;
      } else if (round.level === 'Regional') {
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

    // Process each location group based on leaderboard ranking
    Object.keys(groups).forEach(locationKey => {
      // Submissions are already sorted by averageScore descending
      const locationSubs = groups[locationKey];

      if (locationSubs.length <= quota) {
        // All advance if within quota
        toPromote.push(...locationSubs);
      } else {
        // Top N advance based on leaderboard ranking, rest eliminated
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
        status: 'promoted',
        roundId: round._id // Set roundId for historical tracking
      });
      promotedIds.push(sub._id.toString());
    }

    for (const sub of toEliminate) {
      await Submission.findByIdAndUpdate(sub._id, {
        status: 'eliminated',
        roundId: round._id // Set roundId for historical tracking
      });
      eliminatedIds.push(sub._id.toString());
    }

    return {
      success: true,
      promoted: promotedIds.length,
      eliminated: eliminatedIds.length,
      promotedIds,
      eliminatedIds,
      leaderboard: submissions.map((sub, index) => ({
        rank: index + 1,
        submissionId: sub._id.toString(),
        teacherName: sub.teacherName,
        averageScore: sub.averageScore || 0,
        status: promotedIds.includes(sub._id.toString()) ? 'promoted' : 
               eliminatedIds.includes(sub._id.toString()) ? 'eliminated' : sub.status
      }))
    };
  } catch (error) {
    console.error('Error advancing submissions for round:', error);
    return { success: false, error: error.message };
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
// @desc    Activate a competition round and capture all submissions currently assigned to judges
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

    // Set start time when round is activated (for tracking when round actually started)
    // For countdown rounds, also recalculate endTime
    if (round.timingType === 'countdown' && !round.startTime) {
      round.startTime = new Date();
      round.endTime = new Date(round.startTime.getTime() + round.countdownDuration);
    } else if (!round.startTime) {
      // For fixed_time rounds, set startTime to track activation time
      // This helps with judge progress tracking (only count evaluations after activation)
      round.startTime = new Date();
    }

    // Get all judges assigned to this round's level and location
    const judgeQuery = { 
      role: 'judge', 
      assignedLevel: round.level, 
      status: 'active' 
    };
    
    if (round.level === 'Council' && round.region && round.council) {
      judgeQuery.assignedRegion = round.region;
      judgeQuery.assignedCouncil = round.council;
    } else if (round.level === 'Regional' && round.region) {
      judgeQuery.assignedRegion = round.region;
    }
    // For National level, no location filter needed

    const judges = await User.find(judgeQuery).select('_id assignedLevel assignedRegion assignedCouncil');
    
    if (judges.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No active judges found for this round. Please assign judges before activating the round.'
      });
    }

    // Note: Submissions are not captured here. The round will track submissions dynamically
    // based on judge assignments. Submissions are independent of rounds.

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
          level: round.level,
          region: round.region,
          council: round.council,
          judgesCount: judges.length
        },
        'success'
      ).catch(() => {});
    }

    res.json({
      success: true,
      round,
      message: 'Round activated. Judges can now evaluate submissions assigned to them.'
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

    // Get all submissions dynamically based on round's level/location
    // Submissions are not dependent on rounds - we query them based on judge assignments
    const submissionQuery = {
      year: round.year,
      level: round.level,
      status: { $nin: ['promoted', 'eliminated'] } // Exclude already processed submissions
    };
    
    if (round.region) submissionQuery.region = round.region;
    if (round.council) submissionQuery.council = round.council;

    const allSubmissions = await Submission.find(submissionQuery)
      .populate('teacherId', 'name email');

    // Get all judges assigned to this round's level and location
    const judgeQuery = { role: 'judge', assignedLevel: round.level, status: 'active' };
    if (round.level === 'Council' && round.region && round.council) {
      judgeQuery.assignedRegion = round.region;
      judgeQuery.assignedCouncil = round.council;
    } else if (round.level === 'Regional' && round.region) {
      judgeQuery.assignedRegion = round.region;
    }

    const judges = await User.find(judgeQuery);

    // Filter submissions to only include those assigned to the judges
    const roundSubmissions = allSubmissions.filter(submission => {
      return judges.some(judge => {
        if (round.level === 'Council') {
          return submission.region === judge.assignedRegion && 
                 submission.council === judge.assignedCouncil;
        } else if (round.level === 'Regional') {
          return submission.region === judge.assignedRegion;
        }
        return true; // National level
      });
    }).sort((a, b) => (b.averageScore || 0) - (a.averageScore || 0)); // Sort by average score for leaderboard

    if (roundSubmissions.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No submissions found for this round'
      });
    }

    // Check if all judges completed (if waitForAllJudges is enabled)
    if (round.waitForAllJudges) {
      const roundStartTime = round.startTime || round.createdAt;

      // Check if all submissions have been evaluated
      let pendingCount = 0;
      for (const submission of roundSubmissions) {
        // Skip disqualified submissions
        if (submission.disqualified) continue;

        const evaluations = await Evaluation.find({ 
          submissionId: submission._id,
          createdAt: { $gte: roundStartTime }
        });
        const evaluatedJudgeIds = evaluations.map(e => e.judgeId.toString());
        
        if (round.level === 'Council' || round.level === 'Regional') {
          // 1-to-1 judging: Check if the assigned judge has evaluated
          const assignment = await SubmissionAssignment.findOne({ submissionId: submission._id });
          if (!assignment) {
            pendingCount++;
            continue;
          }
          
          const assignedJudgeEvaluated = evaluatedJudgeIds.includes(assignment.judgeId.toString());
          if (!assignedJudgeEvaluated) {
            pendingCount++;
          }
        } else {
          // National level: 1-to-many judging - All National judges evaluate all National submissions
          // Judges see ALL submissions at National level (not filtered by areaOfFocus)
          const allJudgesEvaluated = judges.every(judge => 
            evaluatedJudgeIds.includes(judge._id.toString())
          );

          if (!allJudgesEvaluated) {
            pendingCount++;
          }
        }
      }

      if (pendingCount > 0) {
        return res.status(400).json({
          success: false,
          message: `Cannot close round - ${pendingCount} submissions still pending evaluation`,
          pendingCount,
          totalSubmissions: roundSubmissions.length
        });
      }
    }

    // Advance submissions based on leaderboard and quota
    const advanceResult = await advanceSubmissionsForRound(round, roundSubmissions);

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

    // Get final statistics for reporting
    const finalStats = {
      totalSubmissions: roundSubmissions.length,
      promoted: advanceResult.promoted,
      eliminated: advanceResult.eliminated,
      nextLevel: getNextLevel(round.level),
      roundDuration: round.closedAt - round.startTime,
      averageScore: roundSubmissions.length > 0 
        ? roundSubmissions.reduce((sum, s) => sum + (s.averageScore || 0), 0) / roundSubmissions.length 
        : 0
    };

    // Get judge statistics (reuse judges variable already fetched above)
    const roundStartTime = round.startTime || round.createdAt;
    const totalEvaluations = await Evaluation.countDocuments({
      submissionId: { $in: roundSubmissions.map(s => s._id) },
      createdAt: { $gte: roundStartTime }
    });

    finalStats.totalJudges = judges.length;
    finalStats.totalEvaluations = totalEvaluations;

    // Log round closure with comprehensive details
    if (logger) {
      logger.logAdminAction(
        'Superadmin closed competition round',
        req.user._id,
        req,
        {
          roundId: req.params.id,
          year: round.year,
          level: round.level,
          region: round.region,
          council: round.council,
          statistics: finalStats,
          promotedIds: advanceResult.promotedIds,
          eliminatedIds: advanceResult.eliminatedIds
        },
        'success'
      ).catch(() => {});
    }

    res.json({
      success: true,
      round,
      advancement: advanceResult,
      statistics: finalStats,
      leaderboard: advanceResult.leaderboard || []
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

// @route   GET /api/competition-rounds/:id/leaderboard
// @desc    Get leaderboard for a competition round (ranked by average rating)
// @access  Private (Superadmin)
router.get('/:id/leaderboard', async (req, res) => {
  try {
    const round = await CompetitionRound.findById(req.params.id);

    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    // Get submissions for this round
    // For closed rounds, use roundId (set when round closed)
    // For active rounds, query dynamically based on judge assignments
    let submissions;
    if (round.status === 'closed') {
      // Closed rounds: show submissions that were evaluated in this round
      submissions = await Submission.find({ roundId: round._id })
        .populate('teacherId', 'name email')
        .sort({ averageScore: -1 });
    } else {
      // Active rounds: query dynamically based on judge assignments
      const submissionQuery = {
        year: round.year,
        level: round.level,
        status: { $nin: ['promoted', 'eliminated'] }
      };
      
      if (round.region) submissionQuery.region = round.region;
      if (round.council) submissionQuery.council = round.council;

      const allSubmissions = await Submission.find(submissionQuery)
        .populate('teacherId', 'name email');

      // Get judges assigned to this round
      const judgeQuery = { role: 'judge', assignedLevel: round.level, status: 'active' };
      if (round.level === 'Council' && round.region && round.council) {
        judgeQuery.assignedRegion = round.region;
        judgeQuery.assignedCouncil = round.council;
      } else if (round.level === 'Regional' && round.region) {
        judgeQuery.assignedRegion = round.region;
      }

      const judges = await User.find(judgeQuery);

      // Filter submissions assigned to judges
      submissions = allSubmissions.filter(submission => {
        return judges.some(judge => {
          if (round.level === 'Council') {
            return submission.region === judge.assignedRegion && 
                   submission.council === judge.assignedCouncil;
          } else if (round.level === 'Regional') {
            return submission.region === judge.assignedRegion;
          }
          return true; // National level
        });
      }).sort((a, b) => (b.averageScore || 0) - (a.averageScore || 0));
    }

    // Build leaderboard with ranking
    const leaderboard = submissions.map((submission, index) => ({
      rank: index + 1,
      submissionId: submission._id.toString(),
      teacherName: submission.teacherName || submission.teacherId?.name || 'N/A',
      teacherEmail: submission.teacherId?.email || 'N/A',
      subject: submission.subject,
      class: submission.class,
      category: submission.category,
      region: submission.region,
      council: submission.council,
      school: submission.school,
      averageScore: submission.averageScore || 0,
      totalEvaluations: 0, // Will be populated below
      status: submission.status
    }));

    // Get evaluation counts for each submission
    for (let i = 0; i < leaderboard.length; i++) {
      const evaluationCount = await Evaluation.countDocuments({
        submissionId: leaderboard[i].submissionId
      });
      leaderboard[i].totalEvaluations = evaluationCount;
    }

    res.json({
      success: true,
      round: {
        id: round._id.toString(),
        year: round.year,
        level: round.level,
        status: round.status,
        region: round.region,
        council: round.council
      },
      leaderboard,
      totalSubmissions: leaderboard.length
    });
  } catch (error) {
    console.error('Get leaderboard error:', error);
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

    // Get round start time (when round was activated)
    // For countdown rounds, startTime is set when activated
    // For fixed_time rounds, use createdAt (rounds are typically activated soon after creation)
    // This ensures we only count evaluations that happened during this round
    const roundStartTime = round.startTime || round.createdAt;
    
    // Get all submissions dynamically based on round's level/location
    // Submissions are not dependent on rounds - we query them based on judge assignments
    const submissionQuery = {
      year: round.year,
      level: round.level,
      status: { $nin: ['promoted', 'eliminated'] } // Exclude already processed submissions
    };
    
    if (round.region) submissionQuery.region = round.region;
    if (round.council) submissionQuery.council = round.council;

    const allSubmissions = await Submission.find(submissionQuery);

    // Get all judges assigned to this round's level and location
    const judgeQuery = { role: 'judge', assignedLevel: round.level, status: 'active' };
    if (round.level === 'Council' && round.region && round.council) {
      judgeQuery.assignedRegion = round.region;
      judgeQuery.assignedCouncil = round.council;
    } else if (round.level === 'Regional' && round.region) {
      judgeQuery.assignedRegion = round.region;
    }

    // Get full judge details (including name, email, username) for both progress calculation and export
    const judges = await User.find(judgeQuery).select('_id name email username assignedLevel assignedRegion assignedCouncil areasOfFocus');

    // Get all submissions for this round (used for overall stats)
    let submissions;
    if (round.level === 'Council' || round.level === 'Regional') {
      // For Council/Regional: Get submissions that have assignments
      const assignments = await SubmissionAssignment.find({
        level: round.level,
        ...(round.level === 'Council' && round.region && round.council ? {
          region: round.region,
          council: round.council
        } : round.level === 'Regional' && round.region ? {
          region: round.region
        } : {})
      }).select('submissionId');
      
      const assignedSubmissionIds = assignments.map(a => a.submissionId);
      submissions = allSubmissions.filter(sub => 
        assignedSubmissionIds.some(id => id.toString() === sub._id.toString())
      );
    } else {
      // National level: Judges see all submissions at National level (not filtered by areaOfFocus)
      submissions = allSubmissions;
    }

    // Calculate progress for each judge
    const judgeProgress = await Promise.all(judges.map(async (judge) => {
      // Only get evaluations created AFTER the round started
      const evaluations = await Evaluation.find({ 
        judgeId: judge._id,
        createdAt: { $gte: roundStartTime }
      });
      const evaluatedSubmissionIds = evaluations.map(e => e.submissionId.toString());
      
      let assignedSubmissions;
      if (round.level === 'Council' || round.level === 'Regional') {
        // For Council/Regional: Get only submissions assigned to this judge
        const assignments = await SubmissionAssignment.find({
          judgeId: judge._id,
          level: round.level
        }).select('submissionId');
        
        const assignedIds = assignments.map(a => a.submissionId.toString());
        assignedSubmissions = submissions.filter(sub => 
          assignedIds.includes(sub._id.toString())
        );
      } else {
        // National level: Judges see ALL submissions at National level (not filtered by areaOfFocus)
        assignedSubmissions = submissions;
      }

      // Count completed: submissions evaluated by this judge AFTER round started
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
        assignedSubmissionIds: assignedSubmissions.map(sub => sub._id.toString()),
        pendingSubmissionIds: assignedSubmissions
          .filter(sub => !evaluatedSubmissionIds.includes(sub._id.toString()))
          .map(sub => sub._id.toString())
      };
    }));

    // Calculate overall statistics
    // Only count evaluations created AFTER the round started
    const totalSubmissions = submissions.length;
    const totalJudges = judges.length;
    const totalEvaluations = await Evaluation.countDocuments({
      submissionId: { $in: submissions.map(s => s._id) },
      createdAt: { $gte: roundStartTime }
    });
    const averageProgress = judgeProgress.length > 0
      ? Math.round(judgeProgress.reduce((sum, j) => sum + j.percentage, 0) / judgeProgress.length)
      : 0;

    // Calculate actual end time for time remaining
    const getActualEndTime = () => {
      if (round.timingType === 'fixed_time') {
        return round.endTime;
      } else if (round.timingType === 'countdown' && round.countdownDuration) {
        const start = round.startTime || round.createdAt;
        return new Date(start.getTime() + round.countdownDuration);
      }
      return round.endTime;
    };

    res.json({
      success: true,
      round: {
        id: round._id.toString(),
        year: round.year,
        level: round.level,
        status: round.status,
        endTime: getActualEndTime(),
        timingType: round.timingType,
        startTime: round.startTime,
        countdownDuration: round.countdownDuration
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

// @route   GET /api/competition-rounds/:id/judge-progress/export
// @desc    Export judge progress report as CSV
// @access  Private (Superadmin)
router.get('/:id/judge-progress/export', async (req, res) => {
  try {
    const round = await CompetitionRound.findById(req.params.id);

    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    // Get round start time
    const roundStartTime = round.startTime || round.createdAt;
    
    // Get all submissions for this round
    const submissionQuery = {
      roundId: round._id
    };
    
    const submissions = await Submission.find(submissionQuery);

    // Get all judges assigned to this round's level
    const judgeQuery = { role: 'judge', assignedLevel: round.level, status: 'active' };
    if (round.level === 'Council' && round.region && round.council) {
      judgeQuery.assignedRegion = round.region;
      judgeQuery.assignedCouncil = round.council;
    } else if (round.level === 'Regional' && round.region) {
      judgeQuery.assignedRegion = round.region;
    }

    const judges = await User.find(judgeQuery).select('name email username assignedLevel assignedRegion assignedCouncil areasOfFocus');

    // Calculate progress for each judge
    const judgeProgress = await Promise.all(judges.map(async (judge) => {
      const evaluations = await Evaluation.find({ 
        judgeId: judge._id,
        createdAt: { $gte: roundStartTime }
      });
      const evaluatedSubmissionIds = evaluations.map(e => e.submissionId.toString());
      
      const assignedSubmissions = submissions.filter(sub => {
        // Check if judge is assigned to this submission's location
        // Judges see ALL submissions in their location (not filtered by areaOfFocus)
        if (round.level === 'Council') {
          return sub.region === judge.assignedRegion && sub.council === judge.assignedCouncil;
        } else if (round.level === 'Regional') {
          return sub.region === judge.assignedRegion;
        } else {
          return true; // National level - see all submissions
        }
      });

      const completed = assignedSubmissions.filter(sub => 
        evaluatedSubmissionIds.includes(sub._id.toString())
      ).length;

      const total = assignedSubmissions.length;
      const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

      return {
        judgeName: judge.name,
        judgeEmail: judge.email,
        judgeUsername: judge.username,
        assignedLevel: judge.assignedLevel || '',
        assignedRegion: judge.assignedRegion || '',
        assignedCouncil: judge.assignedCouncil || '',
        totalAssigned: total,
        completed: completed,
        pending: total - completed,
        percentage: percentage
      };
    }));

    // Generate CSV
    const csvHeaders = [
      'Judge Name',
      'Email',
      'Username',
      'Assigned Level',
      'Assigned Region',
      'Assigned Council',
      'Total Assigned',
      'Completed',
      'Pending',
      'Completion Percentage (%)'
    ];

    const csvRows = judgeProgress.map(judge => [
      judge.judgeName,
      judge.judgeEmail,
      judge.judgeUsername,
      judge.assignedLevel,
      judge.assignedRegion,
      judge.assignedCouncil,
      judge.totalAssigned,
      judge.completed,
      judge.pending,
      judge.percentage
    ]);

    // Convert to CSV format
    const csvContent = [
      csvHeaders.join(','),
      ...csvRows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    // Set response headers for CSV download
    const filename = `judge-progress-round-${round._id}-${round.year}-${round.level}-${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Log export
    if (logger) {
      logger.logAdminAction(
        'Superadmin exported judge progress CSV',
        req.user._id,
        req,
        {
          roundId: req.params.id,
          judgesCount: judgeProgress.length
        },
        'success'
      ).catch(() => {});
    }

    res.send(csvContent);
  } catch (error) {
    console.error('Export judge progress error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/competition-rounds/:id/remind-judge/:judgeId
// @desc    Send custom reminder to a specific judge
// @access  Private (Superadmin)
router.post('/:id/remind-judge/:judgeId', async (req, res) => {
  try {
    const { id, judgeId } = req.params;
    const { message: reminderMessage } = req.body;

    if (!reminderMessage || !reminderMessage.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Reminder message is required'
      });
    }

    const round = await CompetitionRound.findById(id);
    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    const judge = await User.findById(judgeId);
    if (!judge || judge.role !== 'judge') {
      return res.status(404).json({
        success: false,
        message: 'Judge not found'
      });
    }

    // Send reminder via notification service
    const notificationService = require('../services/notificationService');
    await notificationService.sendCustomReminder(
      judgeId,
      reminderMessage.trim(),
      {
        roundId: round._id.toString(),
        roundName: `${round.level} Level Round (${round.year})`,
        level: round.level,
        year: round.year
      }
    );

    res.json({
      success: true,
      message: 'Reminder sent successfully'
    });
  } catch (error) {
    console.error('Send judge reminder error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/competition-rounds/:id/remind-location
// @desc    Send custom reminder to all judges in a location
// @access  Private (Superadmin)
router.post('/:id/remind-location', async (req, res) => {
  try {
    const { id } = req.params;
    const { message: reminderMessage, region, council } = req.body;

    if (!reminderMessage || !reminderMessage.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Reminder message is required'
      });
    }

    const round = await CompetitionRound.findById(id);
    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    // Build location query
    const locationQuery = {
      region: region || null,
      council: council || null
    };

    // Send reminder via notification service
    const notificationService = require('../services/notificationService');
    await notificationService.sendLocationReminder(
      locationQuery,
      reminderMessage.trim(),
      {
        roundId: round._id.toString(),
        roundName: `${round.level} Level Round (${round.year})`,
        level: round.level,
        year: round.year
      }
    );

    res.json({
      success: true,
      message: 'Reminder sent to all judges in the location successfully'
    });
  } catch (error) {
    console.error('Send location reminder error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;

