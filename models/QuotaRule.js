const mongoose = require('mongoose');

const quotaRuleSchema = new mongoose.Schema({
  roundId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CompetitionRound',
    required: true,
    index: true
  },
  level: {
    type: String,
    enum: ['Council', 'Regional', 'National'],
    required: true
  },
  scopeType: {
    type: String,
    enum: ['level', 'chunk', 'area'],
    required: true
  },
  scopeId: {
    type: String,
    required: true,
    trim: true
  },
  areaType: {
    type: String,
    enum: ['council', 'region', 'national', null],
    default: null
  },
  quota: {
    type: Number,
    required: true,
    min: 1
  },
  priority: {
    type: Number,
    default: 0
  },
  isActive: {
    type: Boolean,
    default: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true
});

quotaRuleSchema.index(
  { roundId: 1, level: 1, scopeType: 1, scopeId: 1 },
  { unique: true }
);
quotaRuleSchema.index({ roundId: 1, level: 1, priority: -1 });
quotaRuleSchema.index({ roundId: 1, scopeType: 1, scopeId: 1, isActive: 1 });

module.exports = mongoose.model('QuotaRule', quotaRuleSchema);
