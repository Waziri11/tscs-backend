const mongoose = require('mongoose');

const evaluationSchema = new mongoose.Schema({
  submissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Submission',
    required: true
  },
  judgeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  scores: {
    type: Map,
    of: Number,
    required: true
  },
  totalScore: {
    type: Number,
    required: true,
    default: 0
  },
  averageScore: {
    type: Number,
    required: true,
    default: 0
  },
  comments: {
    type: String,
    trim: true
  },
  submittedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Indexes
evaluationSchema.index({ submissionId: 1, judgeId: 1 }, { unique: true });
evaluationSchema.index({ submissionId: 1 });
evaluationSchema.index({ judgeId: 1 });

module.exports = mongoose.model('Evaluation', evaluationSchema);

