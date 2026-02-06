const express = require('express');
const { LandingPage, LandingPageSettings } = require('../models/LandingPage');
const { protect, authorize } = require('../middleware/auth');
const { cacheMiddleware, invalidateCacheOnChange } = require('../middleware/cache');

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

// Optional auth check helper
const optionalAuth = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.query.token) {
      token = req.query.token;
    }

    if (token) {
      try {
        const jwt = require('jsonwebtoken');
        const User = require('../models/User');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = await User.findById(decoded.id).select('-password');
      } catch (error) {
        // Invalid token, continue without user
        req.user = null;
      }
    }
    next();
  } catch (error) {
    next();
  }
};

// @route   GET /api/landing-page
// @desc    Get all landing page content (sections + settings) - Public endpoint
// @access  Public (for display)
router.get('/', optionalAuth, cacheMiddleware(3600), async (req, res) => {
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
      header: settings.header || null,
      footer: settings.footer || null,
      theme: settings.theme || null,
      navigation: settings.navigation || null,
      seo: settings.seo || null,
      sections: visibleSections.map(section => ({
        id: section.id,
        type: section.type,
        enabled: section.enabled,
        order: section.order,
        content: section.content,
        styling: section.styling || {},
        animation: section.animation || {}
      }))
    };

    res.json(response);
  } catch (error) {
    console.error('Get landing page content error:', error);
    // Ensure we always send a valid JSON response
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: error.message || 'Server error',
        error: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
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
router.post('/', protect, authorize('admin', 'superadmin'), invalidateCacheOnChange('cache:/api/landing-page*'), async (req, res) => {
  try {
    const { settings, sections, header, footer, theme, navigation, seo } = req.body;

    // Validate input - allow empty array but ensure it's an array
    if (sections === undefined || sections === null) {
      return res.status(400).json({
        success: false,
        message: 'Sections array is required'
      });
    }
    
    if (!Array.isArray(sections)) {
      return res.status(400).json({
        success: false,
        message: 'Sections must be an array'
      });
    }

    // Validate and normalize sections
    const validSections = sections.map((section, index) => {
      if (!section.id) {
        throw new Error(`Section at index ${index} is missing required field: id`);
      }
      if (!section.type) {
        throw new Error(`Section at index ${index} is missing required field: type`);
      }
      return {
        id: section.id,
        type: section.type,
        enabled: section.enabled !== undefined ? section.enabled : true,
        order: section.order !== undefined ? section.order : index,
        content: section.content || {},
        styling: section.styling || {},
        animation: section.animation || {}
      };
    });

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

    // Save header configuration
    if (header !== undefined) {
      await LandingPageSettings.findOneAndUpdate(
        { key: 'header' },
        { key: 'header', value: header },
        { upsert: true, new: true }
      );
    }

    // Save footer configuration
    if (footer !== undefined) {
      await LandingPageSettings.findOneAndUpdate(
        { key: 'footer' },
        { key: 'footer', value: footer },
        { upsert: true, new: true }
      );
    }

    // Save theme configuration
    if (theme !== undefined) {
      await LandingPageSettings.findOneAndUpdate(
        { key: 'theme' },
        { key: 'theme', value: theme },
        { upsert: true, new: true }
      );
    }

    // Save navigation configuration
    if (navigation !== undefined) {
      await LandingPageSettings.findOneAndUpdate(
        { key: 'navigation' },
        { key: 'navigation', value: navigation },
        { upsert: true, new: true }
      );
    }

    // Save SEO configuration
    if (seo !== undefined) {
      await LandingPageSettings.findOneAndUpdate(
        { key: 'seo' },
        { key: 'seo', value: seo },
        { upsert: true, new: true }
      );
    }

    // Delete all existing sections
    await LandingPage.deleteMany({});

    // Create new sections (only if there are any)
    let createdSections = [];
    if (validSections.length > 0) {
      createdSections = await LandingPage.insertMany(validSections);
    }

    // Log action
    if (logger) {
      logger.logAdminAction(
        'Admin saved landing page content',
        req.user._id,
        req,
        { sectionsCount: createdSections.length },
        'success',
        'update'
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
      message: error.message || 'Server error',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
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
        'success',
        'create'
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
    const updateData = {
      type: req.body.type,
      enabled: req.body.enabled,
      order: req.body.order,
      content: req.body.content
    };

    if (req.body.styling !== undefined) {
      updateData.styling = req.body.styling;
    }

    if (req.body.animation !== undefined) {
      updateData.animation = req.body.animation;
    }

    const section = await LandingPage.findOneAndUpdate(
      { id: req.params.id },
      updateData,
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
        'info',
        'update'
      ).catch(() => {});
    }

    res.json({
      success: true,
      section: {
        id: section.id,
        type: section.type,
        enabled: section.enabled,
        order: section.order,
        content: section.content,
        styling: section.styling || {},
        animation: section.animation || {}
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

// @route   GET /api/landing-page/header
// @desc    Get header configuration
// @access  Public
router.get('/header', optionalAuth, async (req, res) => {
  try {
    const setting = await LandingPageSettings.findOne({ key: 'header' });
    res.json({
      success: true,
      header: setting ? setting.value : null
    });
  } catch (error) {
    console.error('Get header configuration error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/landing-page/header
// @desc    Save header configuration
// @access  Private (Admin/Superadmin)
router.post('/header', protect, authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const header = req.body;
    await LandingPageSettings.findOneAndUpdate(
      { key: 'header' },
      { key: 'header', value: header },
      { upsert: true, new: true }
    );

    if (logger) {
      logger.logAdminAction(
        'Admin saved header configuration',
        req.user._id,
        req,
        {},
        'success',
        'update'
      ).catch(() => {});
    }

    res.json({
      success: true,
      message: 'Header configuration saved successfully'
    });
  } catch (error) {
    console.error('Save header configuration error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   GET /api/landing-page/footer
// @desc    Get footer configuration
// @access  Public
router.get('/footer', optionalAuth, async (req, res) => {
  try {
    const setting = await LandingPageSettings.findOne({ key: 'footer' });
    res.json({
      success: true,
      footer: setting ? setting.value : null
    });
  } catch (error) {
    console.error('Get footer configuration error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/landing-page/footer
// @desc    Save footer configuration
// @access  Private (Admin/Superadmin)
router.post('/footer', protect, authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const footer = req.body;
    await LandingPageSettings.findOneAndUpdate(
      { key: 'footer' },
      { key: 'footer', value: footer },
      { upsert: true, new: true }
    );

    if (logger) {
      logger.logAdminAction(
        'Admin saved footer configuration',
        req.user._id,
        req,
        {},
        'success',
        'update'
      ).catch(() => {});
    }

    res.json({
      success: true,
      message: 'Footer configuration saved successfully'
    });
  } catch (error) {
    console.error('Save footer configuration error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   GET /api/landing-page/theme
// @desc    Get theme configuration
// @access  Public
router.get('/theme', optionalAuth, async (req, res) => {
  try {
    const setting = await LandingPageSettings.findOne({ key: 'theme' });
    res.json({
      success: true,
      theme: setting ? setting.value : null
    });
  } catch (error) {
    console.error('Get theme configuration error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/landing-page/theme
// @desc    Save theme configuration
// @access  Private (Admin/Superadmin)
router.post('/theme', protect, authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const theme = req.body;
    await LandingPageSettings.findOneAndUpdate(
      { key: 'theme' },
      { key: 'theme', value: theme },
      { upsert: true, new: true }
    );

    if (logger) {
      logger.logAdminAction(
        'Admin saved theme configuration',
        req.user._id,
        req,
        {},
        'success',
        'update'
      ).catch(() => {});
    }

    res.json({
      success: true,
      message: 'Theme configuration saved successfully'
    });
  } catch (error) {
    console.error('Save theme configuration error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   GET /api/landing-page/navigation
// @desc    Get navigation configuration
// @access  Public
router.get('/navigation', optionalAuth, async (req, res) => {
  try {
    const setting = await LandingPageSettings.findOne({ key: 'navigation' });
    res.json({
      success: true,
      navigation: setting ? setting.value : null
    });
  } catch (error) {
    console.error('Get navigation configuration error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/landing-page/navigation
// @desc    Save navigation configuration
// @access  Private (Admin/Superadmin)
router.post('/navigation', protect, authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const navigation = req.body;
    await LandingPageSettings.findOneAndUpdate(
      { key: 'navigation' },
      { key: 'navigation', value: navigation },
      { upsert: true, new: true }
    );

    if (logger) {
      logger.logAdminAction(
        'Admin saved navigation configuration',
        req.user._id,
        req,
        {},
        'success',
        'update'
      ).catch(() => {});
    }

    res.json({
      success: true,
      message: 'Navigation configuration saved successfully'
    });
  } catch (error) {
    console.error('Save navigation configuration error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   GET /api/landing-page/seo
// @desc    Get SEO configuration
// @access  Public
router.get('/seo', optionalAuth, async (req, res) => {
  try {
    const setting = await LandingPageSettings.findOne({ key: 'seo' });
    res.json({
      success: true,
      seo: setting ? setting.value : null
    });
  } catch (error) {
    console.error('Get SEO configuration error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/landing-page/seo
// @desc    Save SEO configuration
// @access  Private (Admin/Superadmin)
router.post('/seo', protect, authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const seo = req.body;
    await LandingPageSettings.findOneAndUpdate(
      { key: 'seo' },
      { key: 'seo', value: seo },
      { upsert: true, new: true }
    );

    if (logger) {
      logger.logAdminAction(
        'Admin saved SEO configuration',
        req.user._id,
        req,
        {},
        'success',
        'update'
      ).catch(() => {});
    }

    res.json({
      success: true,
      message: 'SEO configuration saved successfully'
    });
  } catch (error) {
    console.error('Save SEO configuration error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   PUT /api/landing-page/section/:id/styling
// @desc    Update section-specific styling
// @access  Private (Admin/Superadmin)
router.put('/section/:id/styling', protect, authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const section = await LandingPage.findOneAndUpdate(
      { id: req.params.id },
      { styling: req.body },
      { new: true, runValidators: true }
    );

    if (!section) {
      return res.status(404).json({
        success: false,
        message: 'Landing page section not found'
      });
    }

    if (logger) {
      logger.logAdminAction(
        'Admin updated section styling',
        req.user._id,
        req,
        { sectionId: req.params.id },
        'info',
        'update'
      ).catch(() => {});
    }

    res.json({
      success: true,
      styling: section.styling || {}
    });
  } catch (error) {
    console.error('Update section styling error:', error);
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
        'warning',
        'delete'
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

