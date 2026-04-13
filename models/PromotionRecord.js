const mongoose = require('mongoose');

const promotionRecordSchema = new mongoose.Schema({
  fromRoundId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CompetitionRound',
    required: true,
    index: true
  },
  toRoundId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CompetitionRound',
    default: null,
    index: true
  },
  submissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Submission',
    required: true,
    index: true
  },
  teacherId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  fromLevel: {
    type: String,
    enum: ['Council', 'Regional', 'National'],
    required: true
  },
  toLevel: {
    type: String,
    enum: ['Council', 'Regional', 'National', null],
    default: null
  },
  fromAreaType: {
    type: String,
    enum: ['council', 'region', 'national'],
    required: true
  },
  fromAreaId: {
    type: String,
    required: true,
    trim: true
  },
  toAreaType: {
    type: String,
    enum: ['council', 'region', 'national', null],
    default: null
  },
  toAreaId: {
    type: String,
    default: null,
    trim: true
  },
  status: {
    type: String,
    enum: ['promoted', 'eliminated'],
    required: true
  },
  rankAtDecision: {
    type: Number,
    default: null
  },
  scoreAtDecision: {
    type: Number,
    default: null
  },
  quotaScopeType: {
    type: String,
    enum: ['level', 'chunk', 'area', null],
    default: null
  },
  quotaScopeId: {
    type: String,
    default: null
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  approvedAt: {
    type: Date,
    default: Date.now
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

promotionRecordSchema.index({ fromRoundId: 1, submissionId: 1 }, { unique: true });
promotionRecordSchema.index({ fromRoundId: 1, fromAreaType: 1, fromAreaId: 1, status: 1 });
promotionRecordSchema.index({ toRoundId: 1, status: 1 });

module.exports = mongoose.model('PromotionRecord', promotionRecordSchema);
