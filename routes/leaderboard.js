const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const { cacheMiddleware, invalidateCacheOnChange } = require('../middleware/cache');
const CompetitionRound = require('../models/CompetitionRound');
const { calculateLeaderboard, getLeaderboardByLocation, getAvailableLocations } = require('../utils/leaderboardUtils');
const { advanceSubmissionsForLocation, advanceSubmissionsGlobal } = require('../utils/advancementService');

// Safely import logger
let logger = null;
try {
  const loggerModule = require('../utils/logger');
  logger = loggerModule.logger;
} catch (error) {
  logger = {
    logAdminAction: () => Promise.resolve(),
    logUserActivity: () => Promise.resolve()
  };
}

const router = express.Router();

// All routes require authentication
router.use(protect);

// @route   GET /api/leaderboard/:year/:level
// @desc    Get leaderboard for year and level (grouped by location)
// @access  Private (Admin, Superadmin)
router.get('/:year/:level', authorize('admin', 'superadmin'), cacheMiddleware(30), async (req, res) => {
  try {
    const { year, level } = req.params;
    const { region, council } = req.query;

    // Validate level
    if (!['Council', 'Regional', 'National'].includes(level)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid level. Must be Council, Regional, or National'
      });
    }

    // Validate year
    const yearNum = parseInt(year);
    if (isNaN(yearNum) || yearNum < 2000 || yearNum > 2100) {
      return res.status(400).json({
        success: false,
        message: 'Invalid year'
      });
    }

    // Build filters
    const filters = {};
    if (region) filters.region = region;
    if (council) filters.council = council;

    // If there's an active round in frozen mode, return its snapshot
    const frozenRound = await CompetitionRound.findOne({
      year: yearNum,
      level,
      status: 'active',
      leaderboardVisibility: 'frozen'
    }).select('frozenLeaderboardSnapshot');

    let leaderboard;
    if (frozenRound && frozenRound.frozenLeaderboardSnapshot) {
      leaderboard = frozenRound.frozenLeaderboardSnapshot;
    } else {
      leaderboard = await calculateLeaderboard(yearNum, level, filters);
    }

    // Get available locations
    const locations = await getAvailableLocations(yearNum, level);

    // Log leaderboard view
    if (logger) {
      logger.logUserActivity(
        `${req.user.role} viewed leaderboard`,
        req.user._id,
        req,
        {
          year: yearNum,
          level,
          filters,
          locationCount: Object.keys(leaderboard).length
        },
        'read'
      ).catch(() => {});
    }

    res.json({
      success: true,
      year: yearNum,
      level,
      leaderboard,
      locations,
      locationCount: Object.keys(leaderboard).length
    });
  } catch (error) {
    console.error('Get leaderboard error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   GET /api/leaderboard/:year/:level/:location
// @desc    Get leaderboard for specific location
// @access  Private (Admin, Superadmin)
router.get('/:year/:level/:location', authorize('admin', 'superadmin'), cacheMiddleware(30), async (req, res) => {
  try {
    const { year, level, location } = req.params;

    // Validate level
    if (!['Council', 'Regional', 'National'].includes(level)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid level. Must be Council, Regional, or National'
      });
    }

    // Validate year
    const yearNum = parseInt(year);
    if (isNaN(yearNum) || yearNum < 2000 || yearNum > 2100) {
      return res.status(400).json({
        success: false,
        message: 'Invalid year'
      });
    }

    // Decode location (URL encoded)
    const decodedLocation = decodeURIComponent(location);

    // If there's an active frozen round, use its snapshot
    const frozenRound = await CompetitionRound.findOne({
      year: yearNum,
      level,
      status: 'active',
      leaderboardVisibility: 'frozen'
    }).select('frozenLeaderboardSnapshot');

    let leaderboardEntries;
    if (frozenRound && frozenRound.frozenLeaderboardSnapshot) {
      leaderboardEntries = frozenRound.frozenLeaderboardSnapshot[decodedLocation] || [];
    } else {
      leaderboardEntries = await getLeaderboardByLocation(yearNum, level, decodedLocation);
    }

    // Log leaderboard view
    if (logger) {
      logger.logUserActivity(
        `${req.user.role} viewed leaderboard for location`,
        req.user._id,
        req,
        {
          year: yearNum,
          level,
          location: decodedLocation,
          entryCount: leaderboardEntries.length
        },
        'read'
      ).catch(() => {});
    }

    res.json({
      success: true,
      year: yearNum,
      level,
      location: decodedLocation,
      leaderboard: leaderboardEntries,
      count: leaderboardEntries.length
    });
  } catch (error) {
    console.error('Get leaderboard by location error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/leaderboard/:year/:level/advance
// @desc    Advance submissions to next level (per location or global)
// @access  Private (Admin, Superadmin)
router.post('/:year/:level/advance', authorize('admin', 'superadmin'), invalidateCacheOnChange('cache:/api/leaderboard*'), async (req, res) => {
  try {
    const { year, level } = req.params;
    const { location, global } = req.body;

    // Validate level
    if (!['Council', 'Regional', 'National'].includes(level)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid level. Must be Council, Regional, or National'
      });
    }

    // Validate year
    const yearNum = parseInt(year);
    if (isNaN(yearNum) || yearNum < 2000 || yearNum > 2100) {
      return res.status(400).json({
        success: false,
        message: 'Invalid year'
      });
    }

    // Validate request parameters
    if (!location && !global) {
      return res.status(400).json({
        success: false,
        message: 'Please provide either "location" or set "global" to true'
      });
    }

    if (location && global) {
      return res.status(400).json({
        success: false,
        message: 'Cannot specify both location and global. Use one or the other.'
      });
    }

    let result;

    if (global) {
      // Advance all locations
      result = await advanceSubmissionsGlobal(yearNum, level);
    } else {
      // Advance specific location
      const decodedLocation = decodeURIComponent(location);
      result = await advanceSubmissionsForLocation(yearNum, level, decodedLocation);
    }

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.error || 'Failed to advance submissions'
      });
    }

    // Log advancement action
    if (logger) {
      logger.logAdminAction(
        `${req.user.role} advanced submissions to next level`,
        req.user._id,
        req,
        {
          year: yearNum,
          level,
          location: location || 'global',
          promoted: result.promoted || result.totalPromoted || 0,
          eliminated: result.eliminated || result.totalEliminated || 0
        },
        'success',
        'update'
      ).catch(() => {});
    }

    res.json({
      success: true,
      message: global 
        ? `Successfully advanced submissions globally. ${result.totalPromoted} promoted, ${result.totalEliminated} eliminated.`
        : `Successfully advanced submissions for location. ${result.promoted} promoted, ${result.eliminated} eliminated.`,
      ...result
    });
  } catch (error) {
    console.error('Advance submissions error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;

