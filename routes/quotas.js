const express = require('express');
const mongoSanitize = require('express-mongo-sanitize');
const helmet = require('helmet');
const Quota = require('../models/Quota');
const { protect, authorize } = require('../middleware/auth');
const { logger } = require('../utils/logger');
const { quotaValidations, validate, validateQuery, validateParams } = require('../validation/quotas');
const { sendErrorResponse, asyncHandler } = require('../utils/errorHandler');

const router = express.Router();

// Security middleware
router.use(helmet()); // Security headers
router.use(mongoSanitize()); // Prevent NoSQL injection

// Make role configurable via environment variable
const REQUIRED_ROLE = process.env.QUOTA_ADMIN_ROLE || 'superadmin';

// All routes require authentication and admin role
router.use(protect);
router.use(authorize(REQUIRED_ROLE));

// @route   GET /api/quotas
// @desc    Get all quotas with pagination
// @access  Private (Superadmin)
router.get('/', validateQuery(quotaValidations.query), asyncHandler(async (req, res) => {
  const { year, level, page, limit } = req.query;

  let query = {};
  if (year) query.year = year;
  if (level) query.level = level;

  const options = {
    page: page || 1,
    limit: limit || 50,
    sort: { year: -1, level: 1 },
    lean: true // Better performance
  };

  const result = await Quota.paginate(query, options);

  // Log quota list view (conditionally to avoid performance impact)
  if (process.env.NODE_ENV === 'development' || result.totalDocs > 10) {
    await logger.logAdminAction(
      `${REQUIRED_ROLE} viewed quotas list`,
      req.user._id,
      req,
      {
        filters: { year, level },
        pagination: { page: result.page, limit: result.limit, total: result.totalDocs }
      },
      undefined,
      'read'
    );
  }

  res.json({
    success: true,
    data: result.docs,
    pagination: {
      currentPage: result.page,
      totalPages: result.totalPages,
      totalItems: result.totalDocs,
      itemsPerPage: result.limit,
      hasNextPage: result.hasNextPage,
      hasPrevPage: result.hasPrevPage
    }
  });
}));

// @route   GET /api/quotas/:year/:level
// @desc    Get quota for specific year and level
// @access  Private (Superadmin)
router.get('/:year/:level', validateParams(quotaValidations.params), asyncHandler(async (req, res) => {
  const { year, level } = req.params;

  const quota = await Quota.findOne({
    year: year,
    level: level
  }).lean(); // Better performance

  if (!quota) {
    return res.status(404).json({
      success: false,
      message: 'Quota not found'
    });
  }

  // Log single quota view (conditionally)
  if (process.env.NODE_ENV === 'development') {
    await logger.logAdminAction(
      `${REQUIRED_ROLE} viewed single quota`,
      req.user._id,
      req,
      { year, level },
      undefined,
      'read'
    );
  }

  res.json({
    success: true,
    data: quota
  });
}));

// @route   POST /api/quotas
// @desc    Create or update quota
// @access  Private (Superadmin)
router.post('/', validate(quotaValidations.create), asyncHandler(async (req, res) => {
  const { year, level, quota } = req.body;

  // Use upsert to handle both create and update efficiently
  const savedQuota = await Quota.findOneAndUpdate(
    { year, level },
    { year, level, quota },
    {
      new: true,
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true
    }
  );

  // Determine if this was an update or create based on the __v field
  // New documents have __v = 0, updated documents have __v > 0
  const isUpdate = savedQuota.__v > 0;

  // Log quota creation/update
  await logger.logAdminAction(
    isUpdate ? `${REQUIRED_ROLE} updated quota` : `${REQUIRED_ROLE} created quota`,
    req.user._id,
    req,
    { year, level, quota },
    'success',
    isUpdate ? 'update' : 'create'
  );

  res.status(isUpdate ? 200 : 201).json({
    success: true,
    data: savedQuota,
    message: isUpdate ? 'Quota updated successfully' : 'Quota created successfully'
  });
}));

// @route   PUT /api/quotas/:year/:level
// @desc    Update quota
// @access  Private (Superadmin)
router.put('/:year/:level', validateParams(quotaValidations.params), validate(quotaValidations.update), asyncHandler(async (req, res) => {
  const { year, level } = req.params;
  const { quota } = req.body;

  // Explicitly define allowed fields to prevent mass assignment
  const updateData = { quota };

  const updatedQuota = await Quota.findOneAndUpdate(
    { year, level },
    updateData,
    { new: true, runValidators: true }
  );

  if (!updatedQuota) {
    return res.status(404).json({
      success: false,
      message: 'Quota not found'
    });
  }

  // Log quota update
  await logger.logAdminAction(
    `${REQUIRED_ROLE} updated quota`,
    req.user._id,
    req,
    { year, level, newQuota: quota },
    'info',
    'update'
  );

  res.json({
    success: true,
    data: updatedQuota,
    message: 'Quota updated successfully'
  });
}));

module.exports = router;

