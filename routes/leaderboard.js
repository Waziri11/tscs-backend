const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const { cacheMiddleware, invalidateCacheOnChange } = require('../middleware/cache');
const Leaderboard = require('../models/Leaderboard');
const { getLeaderboard, getLeaderboards, getAvailableLocations, generateLocationKey } = require('../utils/leaderboardUtils');
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

// @route   GET /api/leaderboard
// @desc    Get leaderboards with filters (year, areaOfFocus, level, region, council)
// @access  Private (Admin, Superadmin, Stakeholder, Judge)
router.get('/', cacheMiddleware(30), async (req, res) => {
  try {
    const { year, areaOfFocus, level, region, council, isFinalized } = req.query;

    // Build filters
    const filters = {};
    if (year) filters.year = parseInt(year);
    if (areaOfFocus) filters.areaOfFocus = areaOfFocus;
    if (level) filters.level = level;
    if (region) filters.region = region;
    if (council) filters.council = council;
    if (isFinalized !== undefined) filters.isFinalized = isFinalized === 'true';

    // Judge-specific filtering: only finalized leaderboards for their assignment
    if (req.user.role === 'judge') {
      filters.isFinalized = true;
      
      // Filter by judge's assignment
      // Note: Judges may have areasOfFocus array, we'll filter after fetching
      if (req.user.assignedLevel) {
        filters.level = req.user.assignedLevel;
      }
      if (req.user.assignedRegion) {
        filters.region = req.user.assignedRegion;
      }
      if (req.user.assignedCouncil) {
        filters.council = req.user.assignedCouncil;
      }
    }

    let leaderboards = await getLeaderboards(filters);

    // For judges, filter by areasOfFocus array
    if (req.user.role === 'judge' && req.user.areasOfFocus && req.user.areasOfFocus.length > 0) {
      leaderboards = leaderboards.filter(lb => 
        req.user.areasOfFocus.includes(lb.areaOfFocus)
      );
    }

    // Log leaderboard view
    if (logger) {
      logger.logUserActivity(
        `${req.user.role} viewed leaderboards`,
        req.user._id,
        req,
        {
          filters,
          count: leaderboards.length
        },
        'read'
      ).catch(() => {});
    }

    res.json({
      success: true,
      leaderboards,
      count: leaderboards.length
    });
  } catch (error) {
    console.error('Get leaderboards error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   GET /api/leaderboard/:id
// @desc    Get specific leaderboard by ID
// @access  Private (Admin, Superadmin, Stakeholder, Judge)
router.get('/:id', cacheMiddleware(30), async (req, res) => {
  try {
    const leaderboard = await Leaderboard.findById(req.params.id);

    if (!leaderboard) {
      return res.status(404).json({
        success: false,
        message: 'Leaderboard not found'
      });
    }

    // Judge-specific check: must be finalized and match assignment
    if (req.user.role === 'judge') {
      if (!leaderboard.isFinalized) {
        return res.status(403).json({
          success: false,
          message: 'Leaderboard is not yet finalized'
        });
      }

      // Check if judge's assignment matches (check areasOfFocus array)
      if (req.user.areasOfFocus && req.user.areasOfFocus.length > 0) {
        if (!req.user.areasOfFocus.includes(leaderboard.areaOfFocus)) {
          return res.status(403).json({
            success: false,
            message: 'Not authorized to view this leaderboard'
          });
        }
      }
      if (req.user.assignedLevel && leaderboard.level !== req.user.assignedLevel) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to view this leaderboard'
        });
      }
    }

    // Log leaderboard view
    if (logger) {
      logger.logUserActivity(
        `${req.user.role} viewed leaderboard`,
        req.user._id,
        req,
        {
          leaderboardId: leaderboard._id.toString(),
          year: leaderboard.year,
          areaOfFocus: leaderboard.areaOfFocus,
          level: leaderboard.level
        },
        'read'
      ).catch(() => {});
    }

    res.json({
      success: true,
      leaderboard
    });
  } catch (error) {
    console.error('Get leaderboard error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/leaderboard/:id/finalize
// @desc    Finalize a leaderboard (Admin/Superadmin only)
// @access  Private (Admin, Superadmin)
router.post('/:id/finalize', authorize('admin', 'superadmin'), invalidateCacheOnChange('cache:/api/leaderboard*'), async (req, res) => {
  try {
    const leaderboard = await Leaderboard.findById(req.params.id);

    if (!leaderboard) {
      return res.status(404).json({
        success: false,
        message: 'Leaderboard not found'
      });
    }

    leaderboard.isFinalized = true;
    leaderboard.lastUpdated = new Date();
    await leaderboard.save();

    // Log finalization
    if (logger) {
      logger.logAdminAction(
        `${req.user.role} finalized leaderboard`,
        req.user._id,
        req,
        {
          leaderboardId: leaderboard._id.toString(),
          year: leaderboard.year,
          areaOfFocus: leaderboard.areaOfFocus,
          level: leaderboard.level,
          locationKey: leaderboard.locationKey
        },
        'success',
        'update'
      ).catch(() => {});
    }

    res.json({
      success: true,
      message: 'Leaderboard finalized successfully',
      leaderboard
    });
  } catch (error) {
    console.error('Finalize leaderboard error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/leaderboard/:year/:level/:areaOfFocus/advance
// @desc    Advance submissions to next level for a specific areaOfFocus
// @access  Private (Admin, Superadmin)
router.post('/:year/:level/:areaOfFocus/advance', authorize('admin', 'superadmin'), invalidateCacheOnChange('cache:/api/leaderboard*'), async (req, res) => {
  try {
    const { year, level, areaOfFocus } = req.params;
    const { locationKey, global } = req.body;

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

    // Decode areaOfFocus (URL encoded)
    const decodedAreaOfFocus = decodeURIComponent(areaOfFocus);

    let result;

    if (global) {
      // Advance all locations for this areaOfFocus
      result = await advanceSubmissionsGlobal(yearNum, decodedAreaOfFocus, level);
    } else {
      // Advance specific location
      if (!locationKey) {
        return res.status(400).json({
          success: false,
          message: 'Please provide locationKey or set global to true'
        });
      }
      const decodedLocationKey = decodeURIComponent(locationKey);
      result = await advanceSubmissionsForLocation(yearNum, decodedAreaOfFocus, level, decodedLocationKey);
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
          areaOfFocus: decodedAreaOfFocus,
          level,
          locationKey: locationKey || 'global',
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

// @route   GET /api/leaderboard/available-locations
// @desc    Get available locations for filters
// @access  Private (Admin, Superadmin, Stakeholder, Judge)
router.get('/available-locations', cacheMiddleware(60), async (req, res) => {
  try {
    const { year, level, areaOfFocus } = req.query;

    if (!year || !level) {
      return res.status(400).json({
        success: false,
        message: 'Year and level are required'
      });
    }

    const locations = await getAvailableLocations(
      parseInt(year),
      level,
      areaOfFocus ? decodeURIComponent(areaOfFocus) : null
    );

    res.json({
      success: true,
      locations,
      count: locations.length
    });
  } catch (error) {
    console.error('Get available locations error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;
