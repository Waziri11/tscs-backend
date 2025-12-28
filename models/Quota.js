const mongoose = require('mongoose');

const quotaSchema = new mongoose.Schema({
  year: {
    type: Number,
    required: true
  },
  level: {
    type: String,
    enum: ['Council', 'Regional', 'National'],
    required: true
  },
  quota: {
    type: Number,
    required: true,
    min: 1
  }
}, {
  timestamps: true
});

// Unique constraint on year and level
quotaSchema.index({ year: 1, level: 1 }, { unique: true });

module.exports = mongoose.model('Quota', quotaSchema);

