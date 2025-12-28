const mongoose = require('mongoose');

const sectionContentSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['text', 'image', 'video', 'button', 'heading'],
    required: true
  },
  content: {
    type: String,
    trim: true
  },
  url: {
    type: String,
    trim: true
  },
  alt: {
    type: String,
    trim: true
  },
  style: {
    type: Map,
    of: String
  }
}, { _id: true });

const landingPageSectionSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  type: {
    type: String,
    enum: ['hero', 'about', 'features', 'testimonials', 'cta', 'custom'],
    default: 'custom'
  },
  content: {
    type: [sectionContentSchema],
    default: []
  },
  order: {
    type: Number,
    default: 0
  },
  visible: {
    type: Boolean,
    default: true
  },
  backgroundColor: {
    type: String,
    trim: true
  },
  textColor: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('LandingPage', landingPageSectionSchema);

