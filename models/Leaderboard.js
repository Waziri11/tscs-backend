const mongoose = require('mongoose');

const leaderboardEntrySchema = new mongoose.Schema({
  submissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Submission',
    required: true
  },
  teacherId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  teacherName: {
    type: String,
    required: true
  },
  teacherEmail: {
    type: String
  },
  school: {
    type: String,
    required: true
  },
  region: {
    type: String,
    required: true
  },
  council: {
    type: String
  },
  category: {
    type: String,
    required: true
  },
  class: {
    type: String,
    required: true
  },
  subject: {
    type: String,
    required: true
  },
  areaOfFocus: {
    type: String,
    required: true
  },
  rank: {
    type: Number,
    required: true
  },
  averageScore: {
    type: Number,
    required: true,
    default: 0
  },
  totalEvaluations: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['evaluated', 'promoted', 'eliminated'],
    default: 'evaluated'
  }
}, { _id: false });

const leaderboardSchema = new mongoose.Schema({
  year: {
    type: Number,
    required: true
  },
  areaOfFocus: {
    type: String,
    required: true,
    trim: true
  },
  level: {
    type: String,
    enum: ['Council', 'Regional', 'National'],
    required: true
  },
  locationKey: {
    type: String,
    required: true,
    trim: true
  },
  entries: {
    type: [leaderboardEntrySchema],
    default: []
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  },
  isFinalized: {
    type: Boolean,
    default: false
  },
  totalSubmissions: {
    type: Number,
    default: 0
  },
  quota: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Unique compound index for year, areaOfFocus, level, locationKey
leaderboardSchema.index({ year: 1, areaOfFocus: 1, level: 1, locationKey: 1 }, { unique: true });

// Indexes for efficient queries
leaderboardSchema.index({ year: 1, areaOfFocus: 1 });
leaderboardSchema.index({ year: 1, level: 1 });
leaderboardSchema.index({ year: 1, areaOfFocus: 1, level: 1 });
leaderboardSchema.index({ isFinalized: 1 });
leaderboardSchema.index({ level: 1, isFinalized: 1 });

module.exports = mongoose.model('Leaderboard', leaderboardSchema);
