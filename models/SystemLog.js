const mongoose = require('mongoose');

const systemLogSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['auth', 'submission', 'evaluation', 'system', 'user', 'competition', 'other'],
    required: true
  },
  severity: {
    type: String,
    enum: ['info', 'warning', 'error', 'critical'],
    default: 'info'
  },
  message: {
    type: String,
    required: true,
    trim: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed
  },
  ipAddress: {
    type: String,
    trim: true
  },
  userAgent: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

// Indexes
systemLogSchema.index({ createdAt: -1 });
systemLogSchema.index({ type: 1, severity: 1 });
systemLogSchema.index({ userId: 1 });

// TTL index to auto-delete logs older than 90 days (optional)
// systemLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });

module.exports = mongoose.model('SystemLog', systemLogSchema);

