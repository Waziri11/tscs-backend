const express = require('express');
const Quota = require('../models/Quota');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication and superadmin role
router.use(protect);
router.use(authorize('superadmin'));

// @route   GET /api/quotas
// @desc    Get all quotas
// @access  Private (Superadmin)
router.get('/', async (req, res) => {
  try {
    const { year, level } = req.query;
    
    let query = {};
    if (year) query.year = parseInt(year);
    if (level) query.level = level;

    const quotas = await Quota.find(query).sort({ year: -1, level: 1 });

    res.json({
      success: true,
      count: quotas.length,
      quotas
    });
  } catch (error) {
    console.error('Get quotas error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/quotas/:year/:level
// @desc    Get quota for specific year and level
// @access  Private (Superadmin)
router.get('/:year/:level', async (req, res) => {
  try {
    const quota = await Quota.findOne({
      year: parseInt(req.params.year),
      level: req.params.level
    });

    if (!quota) {
      return res.status(404).json({
        success: false,
        message: 'Quota not found'
      });
    }

    res.json({
      success: true,
      quota
    });
  } catch (error) {
    console.error('Get quota error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/quotas
// @desc    Create or update quota
// @access  Private (Superadmin)
router.post('/', async (req, res) => {
  try {
    const { year, level, quota } = req.body;

    if (!year || !level || !quota) {
      return res.status(400).json({
        success: false,
        message: 'Please provide year, level, and quota'
      });
    }

    const quotaDoc = await Quota.findOneAndUpdate(
      { year: parseInt(year), level },
      { year: parseInt(year), level, quota: parseInt(quota) },
      { new: true, upsert: true, runValidators: true }
    );

    res.json({
      success: true,
      quota: quotaDoc
    });
  } catch (error) {
    console.error('Create/update quota error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   PUT /api/quotas/:year/:level
// @desc    Update quota
// @access  Private (Superadmin)
router.put('/:year/:level', async (req, res) => {
  try {
    const quota = await Quota.findOneAndUpdate(
      { year: parseInt(req.params.year), level: req.params.level },
      req.body,
      { new: true, runValidators: true }
    );

    if (!quota) {
      return res.status(404).json({
        success: false,
        message: 'Quota not found'
      });
    }

    res.json({
      success: true,
      quota
    });
  } catch (error) {
    console.error('Update quota error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;

