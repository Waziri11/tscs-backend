const mongoose = require('mongoose');

const landingPageSectionSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true
  },
  type: {
    type: String,
    enum: ['hero', 'stats', 'about', 'criteria', 'awards', 'cta', 'custom'],
    required: true
  },
  enabled: {
    type: Boolean,
    default: true
  },
  order: {
    type: Number,
    default: 0,
    required: true
  },
  content: {
    type: mongoose.Schema.Types.Mixed, // Flexible content structure based on type
    default: {}
  },
  styling: {
    type: mongoose.Schema.Types.Mixed, // Per-section styling overrides
    default: {}
  },
  animation: {
    type: {
      type: String,
      enum: ['none', 'fadeIn', 'slideUp', 'slideDown', 'slideLeft', 'slideRight', 'zoomIn', 'zoomOut'],
      default: 'none'
    },
    duration: {
      type: Number,
      default: 0.8,
      min: 0.1,
      max: 5
    },
    delay: {
      type: Number,
      default: 0,
      min: 0,
      max: 5
    },
    easing: {
      type: String,
      default: 'easeOut',
      enum: ['linear', 'easeIn', 'easeOut', 'easeInOut']
    }
  }
}, {
  timestamps: true
});

// Index for efficient querying
landingPageSectionSchema.index({ order: 1 });
landingPageSectionSchema.index({ enabled: 1, order: 1 });

// Landing Page Settings Schema
const landingPageSettingsSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    enum: ['siteName', 'footerText', 'header', 'footer', 'theme', 'navigation', 'seo']
  },
  value: {
    type: mongoose.Schema.Types.Mixed, // Can be String or Object for complex configs
    required: true
  }
}, {
  timestamps: true
});

const LandingPageSection = mongoose.model('LandingPage', landingPageSectionSchema);
const LandingPageSettings = mongoose.model('LandingPageSettings', landingPageSettingsSchema);

module.exports = {
  LandingPage: LandingPageSection,
  LandingPageSettings
};

