const mongoose = require('mongoose');
const mongoosePaginate = require('mongoose-paginate-v2');

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

// Add pagination plugin
quotaSchema.plugin(mongoosePaginate);

module.exports = mongoose.model('Quota', quotaSchema);

