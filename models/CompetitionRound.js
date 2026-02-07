const mongoose = require('mongoose');

const competitionRoundSchema = new mongoose.Schema({
  year: {
    type: Number,
    required: true
  },
  level: {
    type: String,
    enum: ['Council', 'Regional', 'National'],
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'active', 'ended', 'closed'],
    default: 'pending'
  },
  // Timing configuration
  timingType: {
    type: String,
    enum: ['fixed_time', 'countdown'],
    required: true
  },
  // For fixed_time: specific end date/time
  endTime: {
    type: Date,
    required: true
  },
  // For countdown: start time (if timingType is countdown)
  startTime: {
    type: Date,
    default: null
  },
  // Countdown duration in milliseconds (if countdown type)
  countdownDuration: {
    type: Number,
    default: null
  },
  // Location filters (null = nationwide)
  region: {
    type: String,
    default: null
  },
  council: {
    type: String,
    default: null
  },
  // Auto-advance settings
  autoAdvance: {
    type: Boolean,
    default: true
  },
  // Wait for all judges to finish before advancing
  waitForAllJudges: {
    type: Boolean,
    default: true
  },
  // Reminder settings
  reminderEnabled: {
    type: Boolean,
    default: true
  },
  reminderFrequency: {
    type: String,
    enum: ['daily', 'twice_daily', 'hourly'],
    default: 'daily'
  },
  // Round metadata
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  // Track when round was actually ended/closed
  endedAt: {
    type: Date,
    default: null
  },
  closedAt: {
    type: Date,
    default: null
  },
  closedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  // Leaderboard visibility mode: 'live' shows real-time scores, 'frozen' shows a snapshot
  leaderboardVisibility: {
    type: String,
    enum: ['live', 'frozen'],
    default: 'live'
  },
  // Frozen leaderboard data (captured when toggling to frozen mode)
  frozenLeaderboardSnapshot: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  // Snapshot of pending submissions when round was activated
  pendingSubmissionsSnapshot: {
    type: [mongoose.Schema.Types.ObjectId],
    ref: 'Submission',
    default: []
  },
  snapshotCreatedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
competitionRoundSchema.index({ year: 1, level: 1, status: 1 });
competitionRoundSchema.index({ year: 1, level: 1, region: 1, council: 1 });
competitionRoundSchema.index({ endTime: 1, status: 1 });
competitionRoundSchema.index({ status: 1 });

// Compound index for active rounds
competitionRoundSchema.index({ status: 1, endTime: 1 });

// Virtual: Check if round is currently active
competitionRoundSchema.virtual('isActive').get(function() {
  return this.status === 'active' && new Date() < this.endTime;
});

// Virtual: Get time remaining
competitionRoundSchema.virtual('timeRemaining').get(function() {
  if (this.status !== 'active') return null;
  const now = new Date();
  const remaining = this.endTime - now;
  return remaining > 0 ? remaining : 0;
});

// Method: Calculate actual end time based on timing type
competitionRoundSchema.methods.getActualEndTime = function() {
  if (this.timingType === 'fixed_time') {
    return this.endTime;
  } else if (this.timingType === 'countdown') {
    const start = this.startTime || this.createdAt;
    return new Date(start.getTime() + this.countdownDuration);
  }
  return this.endTime;
};

// Method: Check if round should end
competitionRoundSchema.methods.shouldEnd = function() {
  if (this.status !== 'active') return false;
  const now = new Date();
  const actualEndTime = this.getActualEndTime();
  return now >= actualEndTime;
};

module.exports = mongoose.model('CompetitionRound', competitionRoundSchema);

