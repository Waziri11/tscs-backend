const express = require('express');
const Feedback = require('../models/Feedback');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// @route   POST /api/feedback
// @desc    Submit feedback (teacher/judge only)
// @access  Private (Teacher/Judge)
router.post('/', protect, async (req, res) => {
  try {
    const { type, subject, message } = req.body;

    // Validate required fields
    if (!type || !subject || !message) {
      return res.status(400).json({
        success: false,
        message: 'Type, subject, and message are required'
      });
    }

    // Validate type
    if (!['feedback', 'suggestion', 'complaint'].includes(type)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid feedback type'
      });
    }

    // Ensure user is teacher or judge
    if (!['teacher', 'judge'].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Only teachers and judges can submit feedback'
      });
    }

    // Validate message length
    if (message.trim().length < 10) {
      return res.status(400).json({
        success: false,
        message: 'Message must be at least 10 characters long'
      });
    }

    const feedback = await Feedback.create({
      userId: req.user._id,
      userRole: req.user.role,
      type,
      subject: subject.trim(),
      message: message.trim(),
      status: 'new'
    });

    // Populate user info
    await feedback.populate('userId', 'name email');

    res.status(201).json({
      success: true,
      feedback
    });
  } catch (error) {
    console.error('Submit feedback error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// All admin routes require authentication and admin/superadmin role
router.use(protect);
router.use(authorize('admin', 'superadmin'));

// @route   GET /api/feedback
// @desc    Get all feedbacks (admin/superadmin only)
// @access  Private (Admin/Superadmin)
router.get('/', async (req, res) => {
  try {
    const { type, status, search } = req.query;
    
    let query = {};
    
    if (type) {
      query.type = type;
    }
    
    if (status) {
      query.status = status;
    }
    
    if (search) {
      query.$or = [
        { subject: { $regex: search, $options: 'i' } },
        { message: { $regex: search, $options: 'i' } }
      ];
    }

    const feedbacks = await Feedback.find(query)
      .populate('userId', 'name email role')
      .populate('respondedBy', 'name email')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      count: feedbacks.length,
      feedbacks
    });
  } catch (error) {
    console.error('Get feedbacks error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/feedback/:id
// @desc    Get single feedback (admin/superadmin only)
// @access  Private (Admin/Superadmin)
router.get('/:id', async (req, res) => {
  try {
    const feedback = await Feedback.findById(req.params.id)
      .populate('userId', 'name email role')
      .populate('respondedBy', 'name email');

    if (!feedback) {
      return res.status(404).json({
        success: false,
        message: 'Feedback not found'
      });
    }

    res.json({
      success: true,
      feedback
    });
  } catch (error) {
    console.error('Get feedback error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   PATCH /api/feedback/:id/status
// @desc    Update feedback status (admin/superadmin only)
// @access  Private (Admin/Superadmin)
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;

    if (!status || !['new', 'read', 'resolved'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Valid status is required (new, read, or resolved)'
      });
    }

    const feedback = await Feedback.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true, runValidators: true }
    ).populate('userId', 'name email role')
     .populate('respondedBy', 'name email');

    if (!feedback) {
      return res.status(404).json({
        success: false,
        message: 'Feedback not found'
      });
    }

    res.json({
      success: true,
      feedback
    });
  } catch (error) {
    console.error('Update feedback status error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   PATCH /api/feedback/:id/response
// @desc    Add admin response to feedback (admin/superadmin only)
// @access  Private (Admin/Superadmin)
router.patch('/:id/response', async (req, res) => {
  try {
    const { response } = req.body;

    if (!response || response.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Response is required'
      });
    }

    const feedback = await Feedback.findByIdAndUpdate(
      req.params.id,
      {
        adminResponse: response.trim(),
        respondedBy: req.user._id,
        respondedAt: new Date(),
        status: 'resolved' // Auto-resolve when admin responds
      },
      { new: true, runValidators: true }
    ).populate('userId', 'name email role')
     .populate('respondedBy', 'name email');

    if (!feedback) {
      return res.status(404).json({
        success: false,
        message: 'Feedback not found'
      });
    }

    res.json({
      success: true,
      feedback
    });
  } catch (error) {
    console.error('Add feedback response error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;
