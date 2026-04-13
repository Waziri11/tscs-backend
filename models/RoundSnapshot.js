const mongoose = require('mongoose');

const snapshotAreaSchema = new mongoose.Schema({
  areaType: {
    type: String,
    enum: ['council', 'region', 'national'],
    required: true
  },
  areaId: {
    type: String,
    required: true,
    trim: true
  },
  region: {
    type: String,
    default: null
  },
  council: {
    type: String,
    default: null
  },
  submissionCount: {
    type: Number,
    default: 0
  }
}, { _id: false });

const roundSnapshotSchema = new mongoose.Schema({
  roundId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CompetitionRound',
    required: true,
    unique: true,
    index: true
  },
  year: {
    type: Number,
    required: true
  },
  level: {
    type: String,
    enum: ['Council', 'Regional', 'National'],
    required: true
  },
  submissionIds: {
    type: [mongoose.Schema.Types.ObjectId],
    ref: 'Submission',
    default: []
  },
  activeAreas: {
    type: [snapshotAreaSchema],
    default: []
  },
  totalSubmissions: {
    type: Number,
    default: 0
  },
  frozenAt: {
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

roundSnapshotSchema.index({ year: 1, level: 1 });
roundSnapshotSchema.index({ roundId: 1, 'activeAreas.areaId': 1 });

module.exports = mongoose.model('RoundSnapshot', roundSnapshotSchema);
