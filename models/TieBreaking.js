const mongoose = require('mongoose');

const tieBreakingSchema = new mongoose.Schema({
  year: {
    type: Number,
    required: true
  },
  level: {
    type: String,
    enum: ['Council', 'Regional', 'National'],
    required: true
  },
  location: {
    type: String,
    required: true,
    trim: true // Format: "region::council" for Council, "region" for Regional, "all" for National
  },
  submissionIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Submission',
    required: true
  }],
  votes: [{
    judgeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    submissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Submission',
      required: true
    },
    votedAt: {
      type: Date,
      default: Date.now
    }
  }],
  status: {
    type: String,
    enum: ['active', 'resolved'],
    default: 'active'
  },
  winners: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Submission'
  }],
  resolvedAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Indexes
tieBreakingSchema.index({ year: 1, level: 1, location: 1, status: 1 });
tieBreakingSchema.index({ status: 1 });

module.exports = mongoose.model('TieBreaking', tieBreakingSchema);

