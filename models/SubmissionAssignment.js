const mongoose = require('mongoose');

/**
 * SubmissionAssignment Model
 * 
 * Tracks 1-to-1 judge-submission assignments for Council and Regional levels.
 * At National level, multiple judges can evaluate the same submission (no assignment needed).
 */
const submissionAssignmentSchema = new mongoose.Schema({
  submissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Submission',
    required: true,
    unique: true,
    index: true
  },
  judgeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  level: {
    type: String,
    enum: ['Council', 'Regional'],
    required: true
  },
  region: {
    type: String,
    required: true,
    trim: true
  },
  council: {
    type: String,
    trim: true
  },
  assignedAt: {
    type: Date,
    default: Date.now
  },
  // Track if judge has been notified
  judgeNotified: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Compound indexes for efficient queries
submissionAssignmentSchema.index({ judgeId: 1, level: 1 });
submissionAssignmentSchema.index({ submissionId: 1, judgeId: 1 });
submissionAssignmentSchema.index({ level: 1, region: 1, council: 1 });

module.exports = mongoose.model('SubmissionAssignment', submissionAssignmentSchema);


















