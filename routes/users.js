const express = require('express');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');
const { logger } = require('../utils/logger');
const { assignUnassignedSubmissionsToJudge } = require('../utils/judgeAssignment');

const router = express.Router();

// All routes require authentication and admin/superadmin role
router.use(protect);
router.use(authorize('admin', 'superadmin'));

// @route   GET /api/users
// @desc    Get all users (with filters)
// @access  Private (Admin/Superadmin)
router.get('/', async (req, res) => {
  try {
    const { role, status, search } = req.query;
    
    let query = {};
    
    if (role) {
      query.role = role;
    }
    
    if (status) {
      query.status = status;
    }
    
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { username: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    const users = await User.find(query).select('-password').sort({ createdAt: -1 });

    // Log user list view
    await logger.logAdminAction(
      'Admin viewed users list',
      req.user._id,
      req,
      { 
        filters: { role, status, search },
        count: users.length
      }
    );

    res.json({
      success: true,
      count: users.length,
      users
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/users/:id
// @desc    Get single user
// @access  Private (Admin/Superadmin)
router.get('/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Log user detail view
    await logger.logAdminAction(
      'Admin viewed user details',
      req.user._id,
      req,
      { 
        targetUserId: req.params.id,
        targetUserRole: user.role,
        targetUserEmail: user.email
      }
    );

    res.json({
      success: true,
      user
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/users
// @desc    Create new user
// @access  Private (Admin/Superadmin)
router.post('/', async (req, res) => {
  try {
    const userData = req.body;

    // Validate required fields
    if (!userData.password || userData.password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password is required and must be at least 6 characters'
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [
        { username: userData.username?.toLowerCase() },
        { email: userData.email?.toLowerCase() }
      ]
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User with this username or email already exists'
      });
    }

    const user = await User.create(userData);

    // If a judge was created, assign unassigned submissions to them (and other judges in the location)
    let assignmentResult = null;
    if (user.role === 'judge' && (user.assignedLevel === 'Council' || user.assignedLevel === 'Regional')) {
      try {
        // Assign unassigned submissions using round-robin
        assignmentResult = await assignUnassignedSubmissionsToJudge(user);
        if (assignmentResult.success && assignmentResult.assignedCount > 0) {
          console.log(`Auto-assigned ${assignmentResult.assignedCount} submission(s) for new judge ${user.name}`);
        }
      } catch (error) {
        console.error('Error auto-assigning submissions to new judge:', error);
        // Don't fail user creation if assignment fails
        assignmentResult = { success: false, assignedCount: 0, error: error.message };
      }
    }

    // Log user creation
    await logger.logAdminAction(
      'Admin created new user account',
      req.user._id,
      req,
      {
        targetUserId: user._id.toString(),
        targetUserRole: user.role,
        targetUserEmail: user.email,
        targetUserName: user.name,
        ...(assignmentResult && { autoAssignedSubmissions: assignmentResult.assignedCount })
      },
      'success'
    );

    const response = {
      success: true,
      user: user.toJSON()
    };

    // Include assignment info if available
    if (assignmentResult) {
      response.assignmentInfo = {
        assignedCount: assignmentResult.assignedCount,
        message: assignmentResult.message || assignmentResult.error
      };
    }

    res.status(201).json(response);
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   PUT /api/users/:id
// @desc    Update user
// @access  Private (Admin/Superadmin)
router.put('/:id', async (req, res) => {
  try {
    // Get original user data before update for logging
    const originalUser = await User.findById(req.params.id).select('-password');
    
    if (!originalUser) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    ).select('-password');

    const updatedFields = Object.keys(req.body);

    // Log user update
    await logger.logAdminAction(
      'Admin updated user account',
      req.user._id,
      req,
      {
        targetUserId: req.params.id,
        targetUserRole: user.role,
        targetUserEmail: user.email,
        updatedFields: updatedFields,
        statusChanged: req.body.status && req.body.status !== originalUser.status,
        roleChanged: req.body.role && req.body.role !== originalUser.role
      }
    );

    res.json({
      success: true,
      user
    });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   DELETE /api/users/:id
// @desc    Delete user
// @access  Private (Superadmin only)
router.delete('/:id', authorize('superadmin'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Log user deletion before deleting
    await logger.logAdminAction(
      'Superadmin deleted user account',
      req.user._id,
      req,
      {
        targetUserId: req.params.id,
        targetUserRole: user.role,
        targetUserEmail: user.email,
        targetUserName: user.name
      },
      'error'
    );

    await user.deleteOne();

    res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;

