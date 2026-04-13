const express = require('express');
const CompetitionRound = require('../models/CompetitionRound');
const Submission = require('../models/Submission');
const Evaluation = require('../models/Evaluation');
const User = require('../models/User');
const SubmissionAssignment = require('../models/SubmissionAssignment');
const AreaLeaderboard = require('../models/AreaLeaderboard');
const RoundChunk = require('../models/RoundChunk');
const RoundSnapshot = require('../models/RoundSnapshot');
const { protect, authorize, authorizeNationalAdminOrSuperadmin } = require('../middleware/auth');
const { cacheMiddleware, invalidateCacheOnChange } = require('../middleware/cache');
const { emitRoundStateChange, emitLeaderboardModeChange } = require('../utils/socketManager');
const {
  activateRoundWithSnapshot,
  getAreaReadiness,
  approveAreaLeaderboardAndPromote,
  rebuildAreaLeaderboard,
  ensureChunkAreasDoNotOverlap
} = require('../utils/roundJudgementService');

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
router.get('/active', cacheMiddleware(60), async (req, res) => {
  try {
    const user = req.user;
    
    // Only judges can use this endpoint
    if (!user || user.role !== 'judge' || !user.assignedLevel) {
      return res.json({
        success: true,
        count: 0,
        rounds: []
      });
    }

    // National single timeline per level:
    // Judges should see the latest active round for their level,
    // or latest ended round as fallback while finishing pending tasks.
    const levelRounds = await CompetitionRound.find({
      level: user.assignedLevel,
      status: { $in: ['active', 'ended'] }
    }).sort({ createdAt: -1 });

    const activeRound = levelRounds.find((round) => round.status === 'active') || null;
    const endedRound = levelRounds.find((round) => round.status === 'ended') || null;
    const rounds = activeRound ? [activeRound] : endedRound ? [endedRound] : [];

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

// All other routes require superadmin or national admin (only national admin can manage rounds)
router.use(authorize('superadmin', 'admin'));
router.use(authorizeNationalAdminOrSuperadmin);

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

// @route   GET /api/competition-rounds/:id/chunks
// @desc    Get optional chunks for a round
// @access  Private (Superadmin/National admin)
router.get('/:id/chunks', async (req, res) => {
  try {
    const round = await CompetitionRound.findById(req.params.id).select('_id level');
    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    const chunks = await RoundChunk.find({ roundId: round._id }).sort({ order: 1, name: 1 });
    return res.json({
      success: true,
      roundId: round._id,
      level: round.level,
      chunks
    });
  } catch (error) {
    console.error('Get round chunks error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/competition-rounds/:id/chunks
// @desc    Create an optional chunk for a round
// @access  Private (Superadmin/National admin)
router.post('/:id/chunks', async (req, res) => {
  try {
    const round = await CompetitionRound.findById(req.params.id).select('_id level');
    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    const { name, description = '', areaType, areas = [], isOptional = true, isActive = true, order = 0 } = req.body;
    if (!name || !areaType || !Array.isArray(areas) || areas.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'name, areaType, and non-empty areas array are required'
      });
    }

    const expectedAreaType = round.level === 'Council' ? 'council' : round.level === 'Regional' ? 'region' : null;
    if (!expectedAreaType) {
      return res.status(400).json({
        success: false,
        message: 'Chunks are only supported for Council and Regional rounds'
      });
    }
    if (areaType !== expectedAreaType) {
      return res.status(400).json({
        success: false,
        message: `Invalid areaType for ${round.level} round. Expected: ${expectedAreaType}`
      });
    }

    const chunk = await RoundChunk.create({
      roundId: round._id,
      level: round.level,
      name,
      description,
      areaType,
      areas,
      isOptional: Boolean(isOptional),
      isActive: Boolean(isActive),
      order: Number(order) || 0,
      createdBy: req.user._id
    });

    const overlapCheck = await ensureChunkAreasDoNotOverlap(round._id, areaType);
    if (!overlapCheck.valid) {
      await RoundChunk.findByIdAndDelete(chunk._id);
      return res.status(400).json({
        success: false,
        message: `Chunk area overlap detected for "${overlapCheck.area}" between "${overlapCheck.existingChunk}" and "${overlapCheck.conflictingChunk}"`
      });
    }

    return res.status(201).json({
      success: true,
      chunk
    });
  } catch (error) {
    console.error('Create round chunk error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   PUT /api/competition-rounds/:id/chunks/:chunkId
// @desc    Update a chunk
// @access  Private (Superadmin/National admin)
router.put('/:id/chunks/:chunkId', async (req, res) => {
  try {
    const round = await CompetitionRound.findById(req.params.id).select('_id level');
    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    const chunk = await RoundChunk.findOne({
      _id: req.params.chunkId,
      roundId: round._id
    });
    if (!chunk) {
      return res.status(404).json({
        success: false,
        message: 'Chunk not found for this round'
      });
    }

    const previousValues = {
      name: chunk.name,
      description: chunk.description,
      areas: [...(chunk.areas || [])],
      isOptional: chunk.isOptional,
      isActive: chunk.isActive,
      order: chunk.order
    };

    const allowedFields = ['name', 'description', 'areas', 'isOptional', 'isActive', 'order'];
    allowedFields.forEach((field) => {
      if (typeof req.body[field] !== 'undefined') {
        chunk[field] = req.body[field];
      }
    });
    await chunk.save();

    const overlapCheck = await ensureChunkAreasDoNotOverlap(round._id, chunk.areaType);
    if (!overlapCheck.valid) {
      Object.assign(chunk, previousValues);
      await chunk.save();
      return res.status(400).json({
        success: false,
        message: `Chunk area overlap detected for "${overlapCheck.area}" between "${overlapCheck.existingChunk}" and "${overlapCheck.conflictingChunk}"`
      });
    }

    return res.json({
      success: true,
      chunk
    });
  } catch (error) {
    console.error('Update round chunk error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   DELETE /api/competition-rounds/:id/chunks/:chunkId
// @desc    Delete a chunk from a round
// @access  Private (Superadmin/National admin)
router.delete('/:id/chunks/:chunkId', async (req, res) => {
  try {
    const chunk = await RoundChunk.findOneAndDelete({
      _id: req.params.chunkId,
      roundId: req.params.id
    });
    if (!chunk) {
      return res.status(404).json({
        success: false,
        message: 'Chunk not found for this round'
      });
    }

    return res.json({
      success: true,
      message: 'Chunk deleted successfully'
    });
  } catch (error) {
    console.error('Delete round chunk error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
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
      reminderFrequency,
      chunking,
      promotionPolicy
    } = req.body;

    // Validate required fields
    if (!year || !level || !timingType) {
      return res.status(400).json({
        success: false,
        message: 'Please provide year, level, and timingType'
      });
    }

    if (timingType === 'fixed_time' && !endTime) {
      return res.status(400).json({
        success: false,
        message: 'endTime is required for fixed_time timing type'
      });
    }

    if (timingType === 'countdown' && !countdownDuration) {
      return res.status(400).json({
        success: false,
        message: 'countdownDuration is required for countdown timing type'
      });
    }

    // Calculate end time for countdown
    let actualEndTime = new Date(endTime || Date.now());
    if (timingType === 'countdown' && countdownDuration) {
      const start = startTime ? new Date(startTime) : new Date();
      actualEndTime = new Date(start.getTime() + parseInt(countdownDuration));
    }

    // National single timeline: only one draft/pending/active round per year + level.
    const existingQuery = {
      year: parseInt(year),
      level,
      status: { $in: ['draft', 'pending', 'active'] }
    };

    const existing = await CompetitionRound.findOne(existingQuery);
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'An active, pending, or draft round already exists for this year and level'
      });
    }

    const roundData = {
      year: parseInt(year),
      level,
      timingType,
      endTime: actualEndTime,
      startTime: startTime ? new Date(startTime) : null,
      countdownDuration: countdownDuration ? parseInt(countdownDuration) : null,
      // Location-scoped rounds are deprecated: timeline is national per level.
      region: null,
      council: null,
      autoAdvance: autoAdvance !== undefined ? autoAdvance : true,
      waitForAllJudges: waitForAllJudges !== undefined ? waitForAllJudges : true,
      reminderEnabled: reminderEnabled !== undefined ? reminderEnabled : true,
      reminderFrequency: reminderFrequency || 'daily',
      chunking: chunking || undefined,
      promotionPolicy: promotionPolicy || undefined,
      metadata: {
        ...(req.body.metadata && typeof req.body.metadata === 'object' && !Array.isArray(req.body.metadata)
          ? req.body.metadata
          : {}),
        requestedRegion: region || null,
        requestedCouncil: council || null
      },
      status: 'draft'
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
        'success',
        'create'
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
    if (round.status === 'ended' || round.status === 'closed' || round.status === 'archived') {
      return res.status(400).json({
        success: false,
        message: 'Cannot update ended or closed rounds'
      });
    }

    // Update fields
    const updateData = { ...req.body };

    const hasLocationScopeValue = (value) =>
      typeof value !== 'undefined' && value !== null && String(value).trim() !== '';

    if (hasLocationScopeValue(updateData.region) || hasLocationScopeValue(updateData.council)) {
      return res.status(400).json({
        success: false,
        message: 'Location-scoped rounds are not supported. Use optional chunks for area grouping.'
      });
    }

    if (typeof updateData.region !== 'undefined') {
      updateData.region = null;
    }
    if (typeof updateData.council !== 'undefined') {
      updateData.council = null;
    }
    
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
        },
        undefined,
        'update'
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
    const activationResult = await activateRoundWithSnapshot(req.params.id, req.user._id);
    if (!activationResult.success) {
      return res.status(activationResult.status || 400).json({
        success: false,
        message: activationResult.message
      });
    }

    const { round, snapshotSize, activeAreas, assignments } = activationResult;

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
          snapshotSize,
          activeAreas: activeAreas.length,
          assignments
        },
        'success',
        'update'
      ).catch(() => {});
    }

    // Emit round state change via Socket.IO
    emitRoundStateChange(round.year, round.level, {
      roundId: round._id.toString(),
      status: 'active',
      action: 'activated',
      level: round.level,
      region: round.region,
      council: round.council,
    });

    res.json({
      success: true,
      round,
      snapshotSize,
      activeAreas,
      assignments,
      message: 'Round activated with a frozen national snapshot. Leaderboards now update provisionally per area.'
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
// @desc    Close a competition round after area finalization
// @access  Private (Superadmin)
router.post('/:id/close', invalidateCacheOnChange('cache:/api/leaderboard*'), async (req, res) => {
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
    const roundLeaderboards = await AreaLeaderboard.find({
      roundId: round._id,
      level: round.level
    }).select('areaId state');

    // Ensure area leaderboards exist for active areas in snapshot.
    if (roundLeaderboards.length === 0 && Array.isArray(round.activeAreas) && round.activeAreas.length > 0) {
      for (const area of round.activeAreas) {
        await rebuildAreaLeaderboard(round._id, area.areaId);
      }
    }

    const refreshedLeaderboards = await AreaLeaderboard.find({
      roundId: round._id,
      level: round.level
    }).select('areaId state totalSubmissions');

    const pendingFinalization = refreshedLeaderboards.filter(
      (leaderboard) => !['finalized', 'published'].includes(leaderboard.state)
    );

    const forceClose = req.body.force === true;
    if (pendingFinalization.length > 0 && !forceClose) {
      return res.status(400).json({
        success: false,
        message: 'Cannot close round: some areas are not finalized yet',
        pendingAreas: pendingFinalization.map((leaderboard) => ({
          areaId: leaderboard.areaId,
          state: leaderboard.state
        }))
      });
    }

    const now = new Date();
    round.status = 'closed';
    if (!round.endedAt) {
      round.endedAt = now;
    }
    round.closedAt = now;
    round.closedBy = req.user._id;
    await round.save();

    const stats = {
      totalAreas: refreshedLeaderboards.length,
      finalizedAreas: refreshedLeaderboards.filter((leaderboard) =>
        ['finalized', 'published'].includes(leaderboard.state)
      ).length,
      publishedAreas: refreshedLeaderboards.filter((leaderboard) =>
        leaderboard.state === 'published'
      ).length,
      totalSubmissions: refreshedLeaderboards.reduce(
        (sum, leaderboard) => sum + (leaderboard.totalSubmissions || 0),
        0
      )
    };

    if (logger) {
      logger.logAdminAction(
        'Superadmin closed competition round',
        req.user._id,
        req,
        {
          roundId: req.params.id,
          year: round.year,
          level: round.level,
          stats,
          forced: forceClose
        },
        'success',
        'update'
      ).catch(() => {});
    }

    emitRoundStateChange(round.year, round.level, {
      roundId: round._id.toString(),
      status: 'closed',
      action: 'closed',
      level: round.level
    });

    res.json({
      success: true,
      round,
      statistics: stats,
      message: 'Round closed successfully'
    });
  } catch (error) {
    console.error('Close competition round error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   GET /api/competition-rounds/:id/areas/:areaId/readiness
// @desc    Check if an area is ready for finalization (all assigned judges completed)
// @access  Private (Superadmin/National admin)
router.get('/:id/areas/:areaId/readiness', cacheMiddleware(20), async (req, res) => {
  try {
    const result = await getAreaReadiness({
      roundId: req.params.id,
      areaId: decodeURIComponent(req.params.areaId)
    });

    if (!result.success) {
      return res.status(result.status || 400).json({
        success: false,
        message: result.message
      });
    }

    return res.json({
      success: true,
      readiness: result.readiness,
      leaderboard: result.leaderboard
    });
  } catch (error) {
    console.error('Area readiness error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/competition-rounds/:id/areas/:areaId/approve
// @desc    Approve area results and promote according to quota
// @access  Private (Superadmin/National admin)
router.post('/:id/areas/:areaId/approve', invalidateCacheOnChange('cache:/api/leaderboard*'), async (req, res) => {
  try {
    if (req.user.role !== 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Only superadmin can approve area promotions'
      });
    }

    const result = await approveAreaLeaderboardAndPromote({
      roundId: req.params.id,
      areaId: decodeURIComponent(req.params.areaId),
      approvedBy: req.user._id,
      force: req.body.force === true
    });

    if (!result.success) {
      return res.status(result.status || 400).json({
        success: false,
        message: result.message,
        readiness: result.completion || null
      });
    }

    return res.json({
      success: true,
      message: `Area approved. ${result.promoted} promoted, ${result.eliminated} eliminated.`,
      ...result
    });
  } catch (error) {
    console.error('Area approval error:', error);
    return res.status(500).json({
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

    emitRoundStateChange(round.year, round.level, {
      roundId: round._id.toString(),
      status: round.status,
      action: 'extended',
      level: round.level,
      endTime: newEndTime,
    });

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
        },
        undefined,
        'update'
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

// @route   PATCH /api/competition-rounds/:id/leaderboard-visibility
// @desc    Toggle leaderboard visibility between live and frozen
// @access  Private (Superadmin)
router.patch('/:id/leaderboard-visibility', async (req, res) => {
  try {
    const { visibility } = req.body;
    if (!['live', 'frozen'].includes(visibility)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid visibility value. Must be "live" or "frozen".'
      });
    }

    const round = await CompetitionRound.findById(req.params.id);
    if (!round) {
      return res.status(404).json({
        success: false,
        message: 'Competition round not found'
      });
    }

    round.leaderboardVisibility = visibility;

    if (visibility === 'frozen') {
      const snapshot = await AreaLeaderboard.find({
        roundId: round._id,
        level: round.level
      }).sort({ areaType: 1, areaId: 1 });
      round.frozenLeaderboardSnapshot = snapshot.map((leaderboard) => ({
        id: leaderboard._id.toString(),
        areaType: leaderboard.areaType,
        areaId: leaderboard.areaId,
        state: leaderboard.state,
        entries: leaderboard.entries
      }));
    } else {
      round.frozenLeaderboardSnapshot = null;
    }

    await round.save();

    emitLeaderboardModeChange(round.year, round.level, {
      roundId: round._id.toString(),
      visibility,
      level: round.level,
      region: round.region,
      council: round.council,
    });

    res.json({
      success: true,
      round,
      message: `Leaderboard visibility set to ${visibility}.`
    });
  } catch (error) {
    console.error('Update leaderboard visibility error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   GET /api/competition-rounds/:id/leaderboard
// @desc    Get area leaderboards for a competition round
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

    const query = {
      roundId: round._id,
      level: round.level
    };

    if (req.query.state) query.state = req.query.state;
    if (req.query.areaId) query.areaId = req.query.areaId;
    if (req.query.areaType) query.areaType = req.query.areaType;

    const leaderboards = await AreaLeaderboard.find(query).sort({ areaType: 1, areaId: 1 });

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
      leaderboards: leaderboards.map((leaderboard) => ({
        ...leaderboard.toObject(),
        locationKey: leaderboard.areaId,
        isFinalized: ['finalized', 'published'].includes(leaderboard.state)
      })),
      totalAreas: leaderboards.length
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
    const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const normalize = (value) => (value ? value.toString().trim() : '');
    const toExactRegex = (value) => {
      const normalized = normalize(value);
      return normalized ? new RegExp(`^${escapeRegExp(normalized)}$`, 'i') : null;
    };

    const startTimeRaw = round.startTime || round.createdAt;
    let roundStartTime = new Date(startTimeRaw);
    const now = new Date();
    if (Number.isNaN(roundStartTime.getTime()) || roundStartTime > now) {
      roundStartTime = new Date(round.createdAt);
    }
    
    let snapshotSubmissionIds = Array.isArray(round.pendingSubmissionsSnapshot)
      ? round.pendingSubmissionsSnapshot
      : [];
    if (snapshotSubmissionIds.length === 0) {
      const snapshot = await RoundSnapshot.findOne({ roundId: round._id }).select('submissionIds');
      snapshotSubmissionIds = snapshot?.submissionIds || [];
    }

    const regionRegex = toExactRegex(round.region);
    const councilRegex = toExactRegex(round.council);

    const submissionQuery = snapshotSubmissionIds.length > 0
      ? { _id: { $in: snapshotSubmissionIds } }
      : {
          year: round.year,
          level: round.level,
          status: { $nin: ['promoted', 'eliminated'] }
        };
    if (snapshotSubmissionIds.length === 0) {
      if (regionRegex) submissionQuery.region = regionRegex;
      if (councilRegex) submissionQuery.council = councilRegex;
    }

    const allSubmissions = await Submission.find(submissionQuery);

    // Get all judges assigned to this round's level and location
    const judgeQuery = { role: 'judge', assignedLevel: round.level, status: 'active' };
    if (round.level === 'Council' && regionRegex && councilRegex) {
      judgeQuery.assignedRegion = regionRegex;
      judgeQuery.assignedCouncil = councilRegex;
    } else if (round.level === 'Regional' && regionRegex) {
      judgeQuery.assignedRegion = regionRegex;
    }

    // Get full judge details (including name, email, username) for both progress calculation and export
    const judges = await User.find(judgeQuery).select('_id name email username assignedLevel assignedRegion assignedCouncil areasOfFocus');

    // Get all submissions for this round (used for overall stats)
    let submissions;
    if (round.level === 'Council' || round.level === 'Regional') {
      // For Council/Regional: Get submissions that have assignments
      const assignments = await SubmissionAssignment.find({
        roundId: round._id,
        level: round.level,
        ...(round.level === 'Council' && regionRegex && councilRegex ? {
          region: regionRegex,
          council: councilRegex
        } : round.level === 'Regional' && regionRegex ? {
          region: regionRegex
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
    const submissionIds = submissions.map(sub => sub._id);
    const judgeProgress = await Promise.all(judges.map(async (judge) => {
      // Only get evaluations created AFTER the round started
      const evaluationQuery = { 
        roundId: round._id,
        judgeId: judge._id,
        createdAt: { $gte: roundStartTime }
      };
      if (submissionIds.length > 0) {
        evaluationQuery.submissionId = { $in: submissionIds };
      }
      const evaluations = await Evaluation.find(evaluationQuery);
      const evaluatedSubmissionIds = evaluations.map(e => e.submissionId.toString());
      
      let assignedSubmissions;
      if (round.level === 'Council' || round.level === 'Regional') {
        // For Council/Regional: Get only submissions assigned to this judge
        const assignments = await SubmissionAssignment.find({
          roundId: round._id,
          judgeId: judge._id,
          level: round.level,
          ...(round.level === 'Council' && regionRegex && councilRegex ? {
            region: regionRegex,
            council: councilRegex
          } : round.level === 'Regional' && regionRegex ? {
            region: regionRegex
          } : {})
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
      roundId: round._id,
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
    
    let snapshotSubmissionIds = Array.isArray(round.pendingSubmissionsSnapshot)
      ? round.pendingSubmissionsSnapshot
      : [];
    if (snapshotSubmissionIds.length === 0) {
      const snapshot = await RoundSnapshot.findOne({ roundId: round._id }).select('submissionIds');
      snapshotSubmissionIds = snapshot?.submissionIds || [];
    }

    const submissions = snapshotSubmissionIds.length > 0
      ? await Submission.find({ _id: { $in: snapshotSubmissionIds } })
      : await Submission.find({ year: round.year, level: round.level });

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
        roundId: round._id,
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
        'success',
        'read'
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
