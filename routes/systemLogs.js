const express = require('express');
const SystemLog = require('../models/SystemLog');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication and superadmin role
router.use(protect);
router.use(authorize('superadmin'));

// @route   GET /api/system-logs
// @desc    Get all system logs (with filters)
// @access  Private (Superadmin)
router.get('/', async (req, res) => {
  try {
    const { type, severity, userId, startDate, endDate, limit = 1000, search } = req.query;
    
    let query = {};
    
    if (type && type !== 'all') query.type = type;
    if (severity && severity !== 'all') query.severity = severity;
    if (userId) query.userId = userId;
    
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    // Search filter
    if (search) {
      query.$or = [
        { action: { $regex: search, $options: 'i' } },
        { message: { $regex: search, $options: 'i' } }
      ];
    }

    const logs = await SystemLog.find(query)
      .populate('userId', 'name username email role')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));

    // Format logs to match frontend expectations
    const formattedLogs = logs.map(log => ({
      id: log._id.toString(),
      type: log.type,
      severity: log.severity,
      action: log.action,
      message: log.message || log.action,
      timestamp: log.createdAt.toISOString(),
      user: log.userId ? log.userId.name : 'System',
      userEmail: log.userId ? log.userId.email : 'system@tscs.local',
      userRole: log.userId ? log.userId.role : 'system',
      ipAddress: log.ipAddress || 'unknown',
      browser: log.userAgent || 'unknown',
      details: log.metadata || {}
    }));

    res.json({
      success: true,
      count: formattedLogs.length,
      logs: formattedLogs
    });
  } catch (error) {
    console.error('Get system logs error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/system-logs/:id
// @desc    Get single system log
// @access  Private (Superadmin)
router.get('/:id', async (req, res) => {
  try {
    const log = await SystemLog.findById(req.params.id)
      .populate('userId', 'name username email role');

    if (!log) {
      return res.status(404).json({
        success: false,
        message: 'System log not found'
      });
    }

    res.json({
      success: true,
      log
    });
  } catch (error) {
    console.error('Get system log error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   DELETE /api/system-logs
// @desc    Delete old system logs
// @access  Private (Superadmin)
router.delete('/', async (req, res) => {
  try {
    const { days = 90 } = req.query;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - parseInt(days));

    const result = await SystemLog.deleteMany({
      createdAt: { $lt: cutoffDate }
    });

    res.json({
      success: true,
      message: `Deleted ${result.deletedCount} system logs older than ${days} days`
    });
  } catch (error) {
    console.error('Delete system logs error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;

