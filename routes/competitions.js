const express = require('express');
const Competition = require('../models/Competition');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(protect);

// @route   GET /api/competitions
// @desc    Get all competition years
// @access  Private
router.get('/', async (req, res) => {
  try {
    const competitions = await Competition.find().sort({ year: -1 });

    res.json({
      success: true,
      count: competitions.length,
      competitions
    });
  } catch (error) {
    console.error('Get competitions error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/competitions/:year
// @desc    Get competition by year
// @access  Private
router.get('/:year', async (req, res) => {
  try {
    const competition = await Competition.findOne({ year: parseInt(req.params.year) });

    if (!competition) {
      return res.status(404).json({
        success: false,
        message: 'Competition not found'
      });
    }

    res.json({
      success: true,
      competition
    });
  } catch (error) {
    console.error('Get competition error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/competitions
// @desc    Create new competition year
// @access  Private (Superadmin only)
router.post('/', authorize('superadmin'), async (req, res) => {
  try {
    const competition = await Competition.create(req.body);

    res.status(201).json({
      success: true,
      competition
    });
  } catch (error) {
    console.error('Create competition error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   PUT /api/competitions/:year
// @desc    Update competition
// @access  Private (Superadmin only)
router.put('/:year', authorize('superadmin'), async (req, res) => {
  try {
    const competition = await Competition.findOneAndUpdate(
      { year: parseInt(req.params.year) },
      req.body,
      { new: true, runValidators: true }
    );

    if (!competition) {
      return res.status(404).json({
        success: false,
        message: 'Competition not found'
      });
    }

    res.json({
      success: true,
      competition
    });
  } catch (error) {
    console.error('Update competition error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   GET /api/competitions/:year/evaluation-criteria/:category/:class/:subject/:area
// @desc    Get evaluation criteria for a specific area
// @access  Private
router.get('/:year/evaluation-criteria/:category/:class/:subject/:area', async (req, res) => {
  try {
    const { year, category, class: classLevel, subject, area } = req.params;

    const competition = await Competition.findOne({ year: parseInt(year) });

    if (!competition) {
      return res.status(404).json({
        success: false,
        message: 'Competition not found'
      });
    }

    const categoryObj = competition.categories.find(c => c.name === category);
    if (!categoryObj) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    const classObj = categoryObj.classes.find(c => c.name === classLevel);
    if (!classObj) {
      return res.status(404).json({
        success: false,
        message: 'Class not found'
      });
    }

    const subjectObj = classObj.subjects.find(s => s.name === subject);
    if (!subjectObj) {
      return res.status(404).json({
        success: false,
        message: 'Subject not found'
      });
    }

    const areaObj = subjectObj.areasOfFocus.find(a => a.name === area);
    if (!areaObj) {
      return res.status(404).json({
        success: false,
        message: 'Area of focus not found'
      });
    }

    res.json({
      success: true,
      evaluationCriteria: areaObj.evaluationCriteria || []
    });
  } catch (error) {
    console.error('Get evaluation criteria error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;

