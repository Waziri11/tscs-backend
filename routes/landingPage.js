const express = require('express');
const { LandingPage, LandingPageSettings } = require('../models/LandingPage');
const { protect, authorize } = require('../middleware/auth');

// Safely import logger
let logger = null;
try {
  const loggerModule = require('../utils/logger');
  logger = loggerModule.logger;
} catch (error) {
  logger = {
    logAdminAction: () => Promise.resolve()
  };
}

const router = express.Router();

// @route   GET /api/landing-page
// @desc    Get all landing page content (sections + settings)
// @access  Public (for display) or Private (for editing)
router.get('/', protect, async (req, res) => {
  try {
    const sections = await LandingPage.find()
      .sort({ order: 1, createdAt: 1 });

    // Get settings
    const settingsArray = await LandingPageSettings.find();
    const settings = {};
    settingsArray.forEach(setting => {
      settings[setting.key] = setting.value;
    });

    // If not authenticated, filter out disabled sections
    const visibleSections = req.user 
      ? sections 
      : sections.filter(section => section.enabled);

    // Format response to match frontend structure
    const response = {
      success: true,
      settings: {
        siteName: settings.siteName || "Teacher's Skills Competition System",
        footerText: settings.footerText || "© 2024 Teacher's Skills Competition System. All rights reserved."
      },
      sections: visibleSections.map(section => ({
        id: section.id,
        type: section.type,
        enabled: section.enabled,
        order: section.order,
        content: section.content
      }))
    };

    res.json(response);
  } catch (error) {
    console.error('Get landing page content error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/landing-page/section/:id
// @desc    Get single landing page section by custom id
// @access  Private (Admin/Superadmin)
router.get('/section/:id', protect, authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const section = await LandingPage.findOne({ id: req.params.id });

    if (!section) {
      return res.status(404).json({
        success: false,
        message: 'Landing page section not found'
      });
    }

    res.json({
      success: true,
      section: {
        id: section.id,
        type: section.type,
        enabled: section.enabled,
        order: section.order,
        content: section.content
      }
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
// @desc    Save all landing page content (sections + settings) - bulk operation
// @access  Private (Admin/Superadmin)
router.post('/', protect, authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const { settings, sections } = req.body;

    // Validate input
    if (!sections || !Array.isArray(sections)) {
      return res.status(400).json({
        success: false,
        message: 'Sections array is required'
      });
    }

    // Save/update settings
    if (settings) {
      for (const [key, value] of Object.entries(settings)) {
        await LandingPageSettings.findOneAndUpdate(
          { key },
          { key, value },
          { upsert: true, new: true }
        );
      }
    }

    // Delete all existing sections
    await LandingPage.deleteMany({});

    // Create new sections
    const createdSections = await LandingPage.insertMany(
      sections.map(section => ({
        id: section.id,
        type: section.type,
        enabled: section.enabled !== undefined ? section.enabled : true,
        order: section.order,
        content: section.content || {}
      }))
    );

    // Log action
    if (logger) {
      logger.logAdminAction(
        'Admin saved landing page content',
        req.user._id,
        req,
        { sectionsCount: createdSections.length },
        'success'
      ).catch(() => {});
    }

    res.json({
      success: true,
      message: 'Landing page content saved successfully',
      count: createdSections.length
    });
  } catch (error) {
    console.error('Save landing page content error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/landing-page/section
// @desc    Create new landing page section
// @access  Private (Admin/Superadmin)
router.post('/section', protect, authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const section = await LandingPage.create({
      id: req.body.id || `section_${Date.now()}`,
      type: req.body.type,
      enabled: req.body.enabled !== undefined ? req.body.enabled : true,
      order: req.body.order || 0,
      content: req.body.content || {}
    });

    // Log landing page section creation
    if (logger) {
      logger.logAdminAction(
        'Admin created landing page section',
        req.user._id,
        req,
        { sectionId: section.id, sectionType: section.type },
        'success'
      ).catch(() => {});
    }

    res.status(201).json({
      success: true,
      section: {
        id: section.id,
        type: section.type,
        enabled: section.enabled,
        order: section.order,
        content: section.content
      }
    });
  } catch (error) {
    console.error('Create landing page section error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   PUT /api/landing-page/section/:id
// @desc    Update landing page section by custom id
// @access  Private (Admin/Superadmin)
router.put('/section/:id', protect, authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const section = await LandingPage.findOneAndUpdate(
      { id: req.params.id },
      {
        type: req.body.type,
        enabled: req.body.enabled,
        order: req.body.order,
        content: req.body.content
      },
      { new: true, runValidators: true }
    );

    if (!section) {
      return res.status(404).json({
        success: false,
        message: 'Landing page section not found'
      });
    }

    // Log landing page section update
    if (logger) {
      logger.logAdminAction(
        'Admin updated landing page section',
        req.user._id,
        req,
        { sectionId: req.params.id, updatedFields: Object.keys(req.body) },
        'info'
      ).catch(() => {});
    }

    res.json({
      success: true,
      section: {
        id: section.id,
        type: section.type,
        enabled: section.enabled,
        order: section.order,
        content: section.content
      }
    });
  } catch (error) {
    console.error('Update landing page section error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   DELETE /api/landing-page/section/:id
// @desc    Delete landing page section by custom id
// @access  Private (Admin/Superadmin)
router.delete('/section/:id', protect, authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const section = await LandingPage.findOne({ id: req.params.id });

    if (!section) {
      return res.status(404).json({
        success: false,
        message: 'Landing page section not found'
      });
    }

    // Log landing page section deletion
    if (logger) {
      logger.logAdminAction(
        'Admin deleted landing page section',
        req.user._id,
        req,
        { sectionId: req.params.id, sectionType: section.type },
        'warning'
      ).catch(() => {});
    }

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

