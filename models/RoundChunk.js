const mongoose = require('mongoose');

const roundChunkSchema = new mongoose.Schema({
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
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true,
    default: ''
  },
  areaType: {
    type: String,
    enum: ['council', 'region'],
    required: true
  },
  areas: {
    type: [String],
    default: []
  },
  isOptional: {
    type: Boolean,
    default: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  order: {
    type: Number,
    default: 0
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true
});

roundChunkSchema.index({ roundId: 1, name: 1 }, { unique: true });
roundChunkSchema.index({ roundId: 1, areaType: 1 });
roundChunkSchema.index({ roundId: 1, areas: 1 });

module.exports = mongoose.model('RoundChunk', roundChunkSchema);
