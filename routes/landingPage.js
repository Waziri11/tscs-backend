const express = require('express');
const LandingPage = require('../models/LandingPage');
const { protect, authorize } = require('../middleware/auth');
const { logger } = require('../utils/logger');

const router = express.Router();

// All routes require authentication and admin/superadmin role
router.use(protect);
router.use(authorize('admin', 'superadmin'));

// @route   GET /api/landing-page
// @desc    Get all landing page sections (public endpoint also available)
// @access  Public (for display) or Private (for editing)
router.get('/', async (req, res) => {
  try {
    const sections = await LandingPage.find()
      .sort({ order: 1, createdAt: 1 });

    // If not authenticated, filter out invisible sections
    const visibleSections = req.user 
      ? sections 
      : sections.filter(section => section.visible);

    res.json({
      success: true,
      count: visibleSections.length,
      sections: visibleSections
    });
  } catch (error) {
    console.error('Get landing page sections error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/landing-page/:id
// @desc    Get single landing page section
// @access  Private (Admin/Superadmin)
router.get('/:id', async (req, res) => {
  try {
    const section = await LandingPage.findById(req.params.id);

    if (!section) {
      return res.status(404).json({
        success: false,
        message: 'Landing page section not found'
      });
    }

    res.json({
      success: true,
      section
    });
  } catch (error) {
    console.error('Get landing page section error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/landing-page
// @desc    Create new landing page section
// @access  Private (Admin/Superadmin)
router.post('/', async (req, res) => {
  try {
    const section = await LandingPage.create(req.body);

    // Log landing page section creation
    await logger.logAdminAction(
      'Admin created landing page section',
      req.user._id,
      req,
      { sectionId: section._id.toString(), sectionType: section.type },
      'success'
    );

    res.status(201).json({
      success: true,
      section
    });
  } catch (error) {
    console.error('Create landing page section error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   PUT /api/landing-page/:id
// @desc    Update landing page section
// @access  Private (Admin/Superadmin)
router.put('/:id', async (req, res) => {
  try {
    const section = await LandingPage.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!section) {
      return res.status(404).json({
        success: false,
        message: 'Landing page section not found'
      });
    }

    // Log landing page section update
    await logger.logAdminAction(
      'Admin updated landing page section',
      req.user._id,
      req,
      { sectionId: req.params.id, updatedFields: Object.keys(req.body) },
      'info'
    );

    res.json({
      success: true,
      section
    });
  } catch (error) {
    console.error('Update landing page section error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   DELETE /api/landing-page/:id
// @desc    Delete landing page section
// @access  Private (Admin/Superadmin)
router.delete('/:id', async (req, res) => {
  try {
    const section = await LandingPage.findById(req.params.id);

    if (!section) {
      return res.status(404).json({
        success: false,
        message: 'Landing page section not found'
      });
    }

    // Log landing page section deletion
    await logger.logAdminAction(
      'Admin deleted landing page section',
      req.user._id,
      req,
      { sectionId: req.params.id, sectionType: section.type },
      'warning'
    );

    await section.deleteOne();

    res.json({
      success: true,
      message: 'Landing page section deleted successfully'
    });
  } catch (error) {
    console.error('Delete landing page section error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;

