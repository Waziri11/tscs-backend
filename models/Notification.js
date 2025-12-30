const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: [
      'round_started',
      'round_ending_soon',
      'round_ended',
      'submission_promoted',
      'submission_eliminated',
      'evaluation_reminder',
      'evaluation_pending',
      'judge_assigned',
      'system_announcement'
    ],
    required: true
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  message: {
    type: String,
    required: true,
    trim: true
  },
  read: {
    type: Boolean,
    default: false,
    index: true
  },
  readAt: {
    type: Date,
    default: null
  },
  // Metadata for linking to related entities
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  // Email notification status
  emailSent: {
    type: Boolean,
    default: false
  },
  emailSentAt: {
    type: Date,
    default: null
  },
  // System notification flag - prevents deletion
  isSystem: {
    type: Boolean,
    default: false,
    index: true
  },
  // Who created this notification (for admin-created notifications)
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ type: 1, createdAt: -1 });
notificationSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);

