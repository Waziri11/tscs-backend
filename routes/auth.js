const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { logger } = require('../utils/logger');

const router = express.Router();

// Generate JWT Token
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: '30d'
  });
};

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and password'
      });
    }

    // Find user by email
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      // Log failed login attempt
      await logger.logSecurity(
        'Failed login attempt - user not found',
        null,
        req,
        { email: email.toLowerCase() },
        'warning'
      );
      
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Check if user is active
    if (user.status !== 'active') {
      // Log inactive account login attempt
      await logger.logSecurity(
        'Failed login attempt - inactive account',
        user._id,
        req,
        { email: email.toLowerCase(), status: user.status },
        'warning'
      );
      
      return res.status(401).json({
        success: false,
        message: 'Your account is not active. Please contact an administrator.'
      });
    }

    // Check password
    const isMatch = await user.comparePassword(password);

    if (!isMatch) {
      // Log failed login attempt
      await logger.logSecurity(
        'Failed login attempt - invalid password',
        user._id,
        req,
        { email: email.toLowerCase() },
        'warning'
      );
      
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Generate token
    const token = generateToken(user._id);

    // Log successful login
    await logger.logUserActivity(
      'User logged in',
      user._id,
      req,
      { role: user.role }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        username: user.username,
        name: user.name,
        email: user.email,
        phone: user.phone,
        gender: user.gender,
        role: user.role,
        ...(user.role === 'teacher' && {
          school: user.school,
          region: user.region,
          council: user.council,
          chequeNumber: user.chequeNumber,
          subject: user.subject
        }),
        ...(user.role === 'judge' && {
          assignedLevel: user.assignedLevel,
          assignedRegion: user.assignedRegion,
          assignedCouncil: user.assignedCouncil,
          specialization: user.specialization,
          experience: user.experience
        })
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during login'
    });
  }
});

// @route   POST /api/auth/register
// @desc    Register new user (teacher)
// @access  Public
router.post('/register', async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      phone,
      gender,
      schoolName,
      chequeNumber,
      region,
      council,
      password
    } = req.body;

    // Validate required fields
    if (!firstName || !lastName || !email || !password || !schoolName || !region || !council) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields'
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [
        { email: email.toLowerCase() }
      ]
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User with this email already exists'
      });
    }

    // Create username from email
    const username = email.toLowerCase();

    // Create user data
    const userData = {
      username,
      password,
      name: `${firstName} ${lastName}`,
      email: email.toLowerCase(),
      phone: phone || '',
      role: 'teacher',
      status: 'active',
      school: schoolName,
      region,
      council,
      ...(chequeNumber && { chequeNumber }),
      ...(gender && { gender })
    };

    const user = await User.create(userData);

    // Generate token
    const token = generateToken(user._id);

    // Log user registration
    await logger.logUserActivity(
      'User registered',
      user._id,
      req,
      { role: 'teacher', region, council, school: schoolName }
    );

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        username: user.username,
        name: user.name,
        email: user.email,
        phone: user.phone,
        gender: user.gender,
        role: user.role,
        school: user.school,
        region: user.region,
        council: user.council,
        chequeNumber: user.chequeNumber
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    
    // Handle duplicate key error
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(400).json({
        success: false,
        message: `${field} already exists`
      });
    }

    res.status(500).json({
      success: false,
      message: error.message || 'Server error during registration'
    });
  }
});

// @route   GET /api/auth/me
// @desc    Get current user
// @access  Private
router.get('/me', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');

    // Log profile view
    await logger.logUserActivity(
      'User viewed profile',
      user._id,
      req
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

// @route   PUT /api/auth/profile
// @desc    Update current user profile
// @access  Private
router.put('/profile', protect, async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      phone,
      gender,
      schoolName,
      chequeNumber,
      region,
      council
    } = req.body;

    // Build update object
    const updateData = {};
    if (firstName && lastName) updateData.name = `${firstName} ${lastName}`;
    if (email) updateData.email = email.toLowerCase();
    if (phone !== undefined) updateData.phone = phone;
    if (gender) updateData.gender = gender;
    if (schoolName !== undefined) updateData.school = schoolName;
    if (chequeNumber !== undefined) updateData.chequeNumber = chequeNumber;
    if (region !== undefined) updateData.region = region;
    if (council !== undefined) updateData.council = council;

    const user = await User.findByIdAndUpdate(
      req.user._id,
      updateData,
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Log profile update
    await logger.logUserActivity(
      'User updated profile',
      user._id,
      req,
      { updatedFields: Object.keys(updateData) }
    );

    res.json({
      success: true,
      user
    });
  } catch (error) {
    console.error('Update profile error:', error);
    
    // Handle duplicate key error
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(400).json({
        success: false,
        message: `${field} already exists`
      });
    }

    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;

