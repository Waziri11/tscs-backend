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
    enum: ['siteName', 'footerText']
  },
  value: {
    type: String,
    required: true,
    trim: true
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

