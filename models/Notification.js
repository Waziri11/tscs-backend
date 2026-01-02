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
      // Competition events
      'round_started',
      'round_ending_soon',
      'round_ended',
      // Submission events (email enabled for teachers)
      'submission_successful', // Email: successful submission
      'submission_promoted',   // Email: approved/promoted
      'submission_eliminated', // Email: eliminated
      // Evaluation events (email enabled for judges)
      'evaluation_reminder',   // Email: time reminder
      'evaluation_pending',    // Email: new round available
      'judge_assigned',        // Email: assigned to round
      // System events
      'system_announcement',
      'admin_notification',    // Email: direct from admin
      'system_critical'        // Email: critical system issues
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

