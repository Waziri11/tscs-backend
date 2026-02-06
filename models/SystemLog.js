const mongoose = require('mongoose');

const systemLogSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['user_activity', 'admin_action', 'system_event', 'security', 'api_request', 'error'],
    required: true
  },
  severity: {
    type: String,
    enum: ['info', 'success', 'warning', 'error', 'critical'],
    default: 'info'
  },
  action: {
    type: String,
    required: true,
    trim: true
  },
  actionCategory: {
    type: String,
    enum: ['create', 'update', 'delete', 'read', 'other'],
    default: 'other'
  },
  message: {
    type: String,
    trim: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
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
systemLogSchema.index({ 'metadata.submissionId': 1 });
systemLogSchema.index({ 'metadata.evaluationId': 1 });
systemLogSchema.index({ actionCategory: 1 });

module.exports = mongoose.model('SystemLog', systemLogSchema);

