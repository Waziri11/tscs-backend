const express = require('express');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');

// Safely import logger
let logger = null;
try {
  const loggerModule = require('../utils/logger');
  logger = loggerModule.logger;
} catch (error) {
  logger = {
    logUserActivity: () => Promise.resolve()
  };
}

const router = express.Router();

// All routes require authentication
router.use(protect);

// @route   GET /api/notifications
// @desc    Get user's notifications
// @access  Private
router.get('/', async (req, res) => {
  try {
    const { read, type, limit = 50 } = req.query;
    
    let query = { userId: req.user._id };
    
    if (read !== undefined) {
      query.read = read === 'true';
    }
    
    if (type) {
      query.type = type;
    }

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));

    // Get unread count
    const unreadCount = await Notification.countDocuments({
      userId: req.user._id,
      read: false
    });

    res.json({
      success: true,
      count: notifications.length,
      unreadCount,
      notifications
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/notifications/unread-count
// @desc    Get unread notification count
// @access  Private
router.get('/unread-count', async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      userId: req.user._id,
      read: false
    });

    res.json({
      success: true,
      count
    });
  } catch (error) {
    console.error('Get unread count error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/notifications/:id/read
// @desc    Mark notification as read
// @access  Private
router.put('/:id/read', async (req, res) => {
  try {
    const notification = await Notification.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    notification.read = true;
    notification.readAt = new Date();
    await notification.save();

    // Log activity
    if (logger) {
      logger.logUserActivity(
        'User marked notification as read',
        req.user._id,
        req,
        { notificationId: req.params.id }
      ).catch(() => {});
    }

    res.json({
      success: true,
      notification
    });
  } catch (error) {
    console.error('Mark notification as read error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PUT /api/notifications/read-all
// @desc    Mark all notifications as read
// @access  Private
router.put('/read-all', async (req, res) => {
  try {
    const result = await Notification.updateMany(
      { userId: req.user._id, read: false },
      { read: true, readAt: new Date() }
    );

    // Log activity
    if (logger) {
      logger.logUserActivity(
        'User marked all notifications as read',
        req.user._id,
        req,
        { count: result.modifiedCount }
      ).catch(() => {});
    }

    res.json({
      success: true,
      count: result.modifiedCount
    });
  } catch (error) {
    console.error('Mark all notifications as read error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   DELETE /api/notifications/:id
// @desc    Delete notification (cannot delete system notifications)
// @access  Private
router.delete('/:id', async (req, res) => {
  try {
    const notification = await Notification.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    // Prevent deletion of system notifications
    if (notification.isSystem) {
      return res.status(403).json({
        success: false,
        message: 'Cannot delete system notifications'
      });
    }

    await Notification.findByIdAndDelete(req.params.id);

    // Log activity
    if (logger) {
      logger.logUserActivity(
        'User deleted notification',
        req.user._id,
        req,
        { notificationId: req.params.id }
      ).catch(() => {});
    }

    res.json({
      success: true,
      message: 'Notification deleted'
    });
  } catch (error) {
    console.error('Delete notification error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/notifications/send
// @desc    Send notification to user(s) (Admin/Superadmin only)
// @access  Private (Admin/Superadmin)
router.post('/send', authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const { userIds, title, message, type = 'system_announcement' } = req.body;

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please provide at least one user ID'
      });
    }

    if (!title || !message) {
      return res.status(400).json({
        success: false,
        message: 'Please provide title and message'
      });
    }

    // Verify all users exist
    const users = await User.find({ _id: { $in: userIds } });
    if (users.length !== userIds.length) {
      return res.status(400).json({
        success: false,
        message: 'One or more users not found'
      });
    }

    // Create notifications for all users
    const notifications = userIds.map(userId => ({
      userId,
      type,
      title,
      message,
      isSystem: false, // Admin-created notifications are not system notifications
      createdBy: req.user._id,
      read: false
    }));

    const createdNotifications = await Notification.insertMany(notifications);

    // Log activity
    if (logger) {
      logger.logAdminAction(
        `Admin sent notification to ${userIds.length} user(s)`,
        req.user._id,
        req,
        {
          notificationCount: createdNotifications.length,
          title,
          userIds
        },
        'success'
      ).catch(() => {});
    }

    res.json({
      success: true,
      count: createdNotifications.length,
      notifications: createdNotifications
    });
  } catch (error) {
    console.error('Send notification error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;

