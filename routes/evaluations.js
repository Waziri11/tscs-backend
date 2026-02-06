const express = require('express');
const Evaluation = require('../models/Evaluation');
const Submission = require('../models/Submission');
const CompetitionRound = require('../models/CompetitionRound');
const SubmissionAssignment = require('../models/SubmissionAssignment');
const { protect, authorize } = require('../middleware/auth');
const { logger } = require('../utils/logger');
const { isJudgeAssigned } = require('../utils/judgeAssignment');
const { cacheMiddleware, invalidateCacheOnChange } = require('../middleware/cache');
const { emitScoreUpdate } = require('../utils/socketManager');

const router = express.Router();

// All routes require authentication
router.use(protect);

// @route   GET /api/evaluations
// @desc    Get all evaluations (with filters)
// @access  Private
router.get('/', cacheMiddleware(15), async (req, res) => {
  try {
    const { submissionId, judgeId } = req.query;
    
    let query = {};
    
    if (submissionId) {
      query.submissionId = submissionId;
    }
    
    // Judges only see their own evaluations
    if (req.user.role === 'judge') {
      query.judgeId = req.user._id;
    } else if (judgeId) {
      query.judgeId = judgeId;
    }

    const evaluations = await Evaluation.find(query)
      .populate('submissionId', 'teacherName category subject level')
      .populate('judgeId', 'name username')
      .sort({ submittedAt: -1 });

    // Log evaluation list view
    await logger.logUserActivity(
      'User viewed evaluations list',
      req.user._id,
      req,
      { 
        role: req.user.role,
        filters: { submissionId, judgeId },
        count: evaluations.length
      },
      'read'
    );

    res.json({
      success: true,
      count: evaluations.length,
      evaluations
    });
  } catch (error) {
    console.error('Get evaluations error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/evaluations/:id
// @desc    Get single evaluation
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const evaluation = await Evaluation.findById(req.params.id)
      .populate('submissionId')
      .populate('judgeId', 'name username');

    if (!evaluation) {
      return res.status(404).json({
        success: false,
        message: 'Evaluation not found'
      });
    }

    // Judges can only see their own evaluations
    if (req.user.role === 'judge' && evaluation.judgeId._id.toString() !== req.user._id.toString()) {
      // Log unauthorized access attempt
      await logger.logSecurity(
        'Unauthorized evaluation access attempt',
        req.user._id,
        req,
        { evaluationId: req.params.id },
        'warning'
      );
      
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this evaluation'
      });
    }

    // Log evaluation view
    await logger.logUserActivity(
      'User viewed evaluation details',
      req.user._id,
      req,
      { 
        evaluationId: evaluation._id.toString(),
        submissionId: evaluation.submissionId._id.toString(),
        judgeId: evaluation.judgeId._id.toString()
      },
      'read'
    );

    res.json({
      success: true,
      evaluation
    });
  } catch (error) {
    console.error('Get evaluation error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/evaluations
// @desc    Create/update evaluation (judges only)
// @access  Private (Judge)
router.post('/', authorize('judge'), invalidateCacheOnChange('cache:/api/leaderboard*'), async (req, res) => {
  try {
    const { submissionId, scores, comments } = req.body;

    // Validate input
    if (!submissionId || !scores) {
      return res.status(400).json({
        success: false,
        message: 'Please provide submissionId and scores'
      });
    }

    // Check if submission exists
    const submission = await Submission.findById(submissionId);
    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }

    // Check if submission belongs to an active round
    if (submission.roundId) {
      const round = await CompetitionRound.findById(submission.roundId);
      if (!round) {
        return res.status(400).json({
          success: false,
          message: 'Submission is associated with a round that no longer exists'
        });
      }
      
      // Check if round is active
      if (round.status !== 'active') {
        return res.status(403).json({
          success: false,
          message: `Cannot evaluate submission. Round is ${round.status}. Evaluations are only allowed when the round is active.`
        });
      }
      
      // Check if round has ended (use actual end time for countdown rounds)
      const now = new Date();
      const actualEndTime = typeof round.getActualEndTime === 'function'
        ? round.getActualEndTime()
        : round.endTime;
      if (now >= actualEndTime) {
        return res.status(403).json({
          success: false,
          message: 'Cannot evaluate submission. Round has ended.'
        });
      }
    } else {
      // If submission doesn't have a roundId, find active round using same matching logic as /active endpoint
      // This handles nationwide rounds and uses normalized matching
      
      // Fetch all active rounds
      const allActiveRounds = await CompetitionRound.find({ status: 'active' })
        .sort({ createdAt: -1 })
        .limit(50);
      
      // Normalize helper (same as /active endpoint)
      const normalize = (str) => {
        if (!str) return null;
        return str.toString().trim().toLowerCase() || null;
      };
      
      const submissionLevel = submission.level;
      const submissionRegion = normalize(submission.region);
      const submissionCouncil = normalize(submission.council);
      
      // Find best matching round using priority system
      let bestRound = null;
      let bestPriority = -1;
      
      for (const round of allActiveRounds) {
        const roundRegion = normalize(round.region);
        const roundCouncil = normalize(round.council);
        const isRoundNationwide = !roundRegion && !roundCouncil;
        
        let priority = -1;
        
        // Rule 1: Exact level + location match (highest priority = 100)
        if (round.level === submissionLevel) {
          if (submissionLevel === 'Council') {
            // Council: exact region + council match
            if (roundRegion === submissionRegion && roundCouncil === submissionCouncil) {
              priority = 100;
            }
            // Council: region match, no specific council (all councils in region)
            else if (roundRegion === submissionRegion && !roundCouncil) {
              priority = 80;
            }
          } else if (submissionLevel === 'Regional') {
            // Regional: exact region match, no council
            if (roundRegion === submissionRegion && !roundCouncil) {
              priority = 100;
            }
          } else if (submissionLevel === 'National') {
            // National: must be nationwide
            if (isRoundNationwide) {
              priority = 100;
            }
          }
        }
        
        // Rule 2: Nationwide rounds (lower priority, but still eligible)
        if (isRoundNationwide && priority === -1) {
          // Any submission can match nationwide rounds as fallback
          if (submissionLevel === 'National') {
            priority = 90;
          } else if (submissionLevel === 'Regional') {
            priority = 50;
          } else if (submissionLevel === 'Council') {
            priority = 30;
          }
        }
        
        // Keep track of best match
        if (priority > bestPriority) {
          bestPriority = priority;
          bestRound = round;
        }
      }
      
      if (!bestRound) {
        return res.status(403).json({
          success: false,
          message: 'Cannot evaluate submission. No active round found for this submission. Please wait for an admin to activate a round.'
        });
      }
      
      // Check if round has ended (use actual end time based on timing type)
      const now = new Date();
      let actualEndTime = bestRound.endTime;
      
      // Calculate actual end time for countdown rounds
      if (bestRound.timingType === 'countdown' && bestRound.countdownDuration) {
        const start = bestRound.startTime || bestRound.createdAt;
        actualEndTime = new Date(start.getTime() + bestRound.countdownDuration);
      }
      
      if (now >= actualEndTime) {
        return res.status(403).json({
          success: false,
          message: 'Cannot evaluate submission. Active round has ended.'
        });
      }
    }

    // For Council/Regional levels, enforce 1-to-1 judging: only assigned judge can evaluate
    if (submission.level === 'Council' || submission.level === 'Regional') {
      const isAssigned = await isJudgeAssigned(submissionId, req.user._id);
      if (!isAssigned) {
        return res.status(403).json({
          success: false,
          message: 'You are not assigned to evaluate this submission. Only the assigned judge can evaluate submissions at this level.'
        });
      }
    }
    // For National level, multiple judges can evaluate (no assignment check needed)

    // Calculate totals
    const scoreValues = Object.values(scores);
    const totalScore = scoreValues.reduce((sum, score) => sum + (score || 0), 0);
    const averageScore = scoreValues.length > 0 ? totalScore / scoreValues.length : 0;

    // Create or update evaluation
    const evaluation = await Evaluation.findOneAndUpdate(
      { submissionId, judgeId: req.user._id },
      {
        submissionId,
        judgeId: req.user._id,
        scores,
        totalScore,
        averageScore,
        comments: comments || '',
        submittedAt: new Date()
      },
      { new: true, upsert: true, runValidators: true }
    ).populate('submissionId', 'teacherName category subject');

    // Update submission average score (recalculate from all evaluations)
    await updateSubmissionAverageScore(submissionId);

    // Emit real-time score update via Socket.IO
    try {
      const updatedSub = await Submission.findById(submissionId).populate('teacherId', 'name');
      if (updatedSub) {
        emitScoreUpdate(updatedSub.year, updatedSub.level, {
          submissionId: submissionId.toString(),
          averageScore: updatedSub.averageScore,
          location: `${updatedSub.region || ''}::${updatedSub.council || ''}`,
          teacherName: updatedSub.teacherId?.name || updatedSub.teacherName,
          status: updatedSub.status,
        });
      }
    } catch (socketErr) {
      // Non-blocking: don't fail the evaluation if socket emit fails
      console.error('Socket emit error (non-blocking):', socketErr.message);
    }

    // Log evaluation creation/update
    const isUpdate = evaluation.createdAt && evaluation.updatedAt && 
                     evaluation.createdAt.getTime() !== evaluation.updatedAt.getTime();
    
    await logger.logUserActivity(
      isUpdate ? 'Judge updated evaluation' : 'Judge submitted evaluation',
      req.user._id,
      req,
      {
        evaluationId: evaluation._id.toString(),
        submissionId: submissionId.toString(),
        averageScore: averageScore,
        totalScore: totalScore,
        criteriaCount: Object.keys(scores).length
      },
      isUpdate ? 'update' : 'create'
    );

    res.status(201).json({
      success: true,
      evaluation
    });
  } catch (error) {
    console.error('Create evaluation error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// Helper function to update submission average score
// For Council/Regional: use single judge's score (1-to-1)
// For National: average all judges' scores (1-to-many)
async function updateSubmissionAverageScore(submissionId) {
  try {
    const submission = await Submission.findById(submissionId);
    if (!submission) return;

    const evaluations = await Evaluation.find({ submissionId });
    
    if (evaluations.length === 0) {
      await Submission.findByIdAndUpdate(submissionId, { averageScore: 0 });
      return;
    }

    let finalScore;
    
    if (submission.level === 'Council' || submission.level === 'Regional') {
      // 1-to-1 judging: use the single judge's score directly
      // There should only be one evaluation, but if multiple exist, use the first one
      finalScore = evaluations[0].averageScore;
    } else {
      // National level: 1-to-many judging - average all judges' scores
      const totalAverage = evaluations.reduce((sum, eval) => sum + eval.averageScore, 0);
      finalScore = totalAverage / evaluations.length;
    }

    await Submission.findByIdAndUpdate(submissionId, {
      averageScore: Math.round(finalScore * 100) / 100,
      status: 'evaluated'
    });
  } catch (error) {
    console.error('Error updating submission average score:', error);
  }
}

// @route   GET /api/evaluations/submission/:submissionId
// @desc    Get all evaluations for a submission
// @access  Private
router.get('/submission/:submissionId', async (req, res) => {
  try {
    const evaluations = await Evaluation.find({ submissionId: req.params.submissionId })
      .populate('judgeId', 'name username assignedLevel')
      .sort({ submittedAt: -1 });

    // Log submission evaluations view
    await logger.logUserActivity(
      'User viewed submission evaluations',
      req.user._id,
      req,
      { 
        submissionId: req.params.submissionId,
        count: evaluations.length
      },
      'read'
    );

    res.json({
      success: true,
      count: evaluations.length,
      evaluations
    });
  } catch (error) {
    console.error('Get submission evaluations error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/evaluations/:submissionId/disqualify
// @desc    Flag a submission for disqualification (judges only, Council/Regional levels)
// @access  Private (Judge)
router.post('/:submissionId/disqualify', authorize('judge'), async (req, res) => {
  try {
    const { submissionId } = req.params;
    const { reason } = req.body;

    const submission = await Submission.findById(submissionId);
    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }

    // Only allow disqualification at Council/Regional levels
    if (submission.level !== 'Council' && submission.level !== 'Regional') {
      return res.status(403).json({
        success: false,
        message: 'Disqualification is only allowed at Council and Regional levels'
      });
    }

    // Check if judge is assigned to this submission
    const isAssigned = await isJudgeAssigned(submissionId, req.user._id);
    if (!isAssigned) {
      return res.status(403).json({
        success: false,
        message: 'You are not assigned to evaluate this submission'
      });
    }

    // Update submission with disqualification
    submission.disqualified = true;
    submission.disqualificationReason = reason || 'Disqualified by judge';
    submission.disqualifiedBy = req.user._id;
    submission.disqualifiedAt = new Date();
    await submission.save();

    // Log disqualification
    await logger.logUserActivity(
      'Judge disqualified submission',
      req.user._id,
      req,
      {
        submissionId: submissionId.toString(),
        reason: reason || 'No reason provided',
        level: submission.level
      },
      'update'
    );

    res.json({
      success: true,
      message: 'Submission has been flagged for disqualification',
      submission
    });
  } catch (error) {
    console.error('Disqualify submission error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;

