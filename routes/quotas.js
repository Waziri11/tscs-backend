const express = require('express');
const mongoSanitize = require('express-mongo-sanitize');
const helmet = require('helmet');
const Quota = require('../models/Quota');
const QuotaRule = require('../models/QuotaRule');
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

// @route   GET /api/quotas/quota-rules
// @desc    Get round-scoped quota rules (area/chunk/level)
// @access  Private (Superadmin)
router.get('/quota-rules', asyncHandler(async (req, res) => {
  const { roundId, level, scopeType } = req.query;
  const query = {};
  if (roundId) query.roundId = roundId;
  if (level) query.level = level;
  if (scopeType) query.scopeType = scopeType;

  const rules = await QuotaRule.find(query).sort({ priority: -1, createdAt: -1 });
  res.json({
    success: true,
    data: rules,
    count: rules.length
  });
}));

// @route   POST /api/quotas/quota-rules
// @desc    Create or update a round-scoped quota rule
// @access  Private (Superadmin)
router.post('/quota-rules', asyncHandler(async (req, res) => {
  const { roundId, level, scopeType, scopeId, areaType = null, quota, priority = 0, isActive = true } = req.body;

  if (!roundId || !level || !scopeType || !scopeId || !quota) {
    return res.status(400).json({
      success: false,
      message: 'roundId, level, scopeType, scopeId, and quota are required'
    });
  }

  if (!['level', 'chunk', 'area'].includes(scopeType)) {
    return res.status(400).json({
      success: false,
      message: 'scopeType must be one of: level, chunk, area'
    });
  }

  const payload = {
    roundId,
    level,
    scopeType,
    scopeId,
    areaType,
    quota: parseInt(quota, 10),
    priority: parseInt(priority, 10) || 0,
    isActive: Boolean(isActive),
    createdBy: req.user._id
  };

  const savedRule = await QuotaRule.findOneAndUpdate(
    { roundId, level, scopeType, scopeId },
    payload,
    {
      new: true,
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true
    }
  );

  await logger.logAdminAction(
    `${REQUIRED_ROLE} upserted quota rule`,
    req.user._id,
    req,
    {
      ruleId: savedRule._id.toString(),
      roundId,
      level,
      scopeType,
      scopeId,
      quota: savedRule.quota
    },
    'success',
    'create'
  );

  res.status(201).json({
    success: true,
    data: savedRule
  });
}));

// @route   PATCH /api/quotas/quota-rules/:id
// @desc    Update a quota rule
// @access  Private (Superadmin)
router.patch('/quota-rules/:id', asyncHandler(async (req, res) => {
  const updateData = {};
  ['quota', 'priority', 'isActive', 'areaType'].forEach((field) => {
    if (typeof req.body[field] !== 'undefined') {
      updateData[field] = req.body[field];
    }
  });

  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({
      success: false,
      message: 'No updatable fields provided'
    });
  }

  if (typeof updateData.quota !== 'undefined') {
    updateData.quota = parseInt(updateData.quota, 10);
  }
  if (typeof updateData.priority !== 'undefined') {
    updateData.priority = parseInt(updateData.priority, 10) || 0;
  }

  const rule = await QuotaRule.findByIdAndUpdate(
    req.params.id,
    updateData,
    { new: true, runValidators: true }
  );

  if (!rule) {
    return res.status(404).json({
      success: false,
      message: 'Quota rule not found'
    });
  }

  res.json({
    success: true,
    data: rule
  });
}));

// @route   DELETE /api/quotas/quota-rules/:id
// @desc    Delete a quota rule
// @access  Private (Superadmin)
router.delete('/quota-rules/:id', asyncHandler(async (req, res) => {
  const deleted = await QuotaRule.findByIdAndDelete(req.params.id);
  if (!deleted) {
    return res.status(404).json({
      success: false,
      message: 'Quota rule not found'
    });
  }

  res.json({
    success: true,
    message: 'Quota rule deleted successfully'
  });
}));

module.exports = router;
