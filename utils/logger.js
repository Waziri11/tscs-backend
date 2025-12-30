const SystemLog = require('../models/SystemLog');

/**
 * System Logger Utility
 * Logs all system activities to the database
 */

// Log types matching frontend
const LOG_TYPES = {
  USER_ACTIVITY: 'user_activity',
  ADMIN_ACTION: 'admin_action',
  SYSTEM_EVENT: 'system_event',
  SECURITY: 'security',
  API_REQUEST: 'api_request',
  ERROR: 'error'
};

// Log severity levels
const LOG_SEVERITY = {
  INFO: 'info',
  SUCCESS: 'success',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical'
};

/**
 * Get client IP address from request
 */
const getClientIp = (req) => {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.headers['x-real-ip'] ||
         req.connection?.remoteAddress ||
         req.socket?.remoteAddress ||
         req.ip ||
         'unknown';
};

/**
 * Get user agent from request
 */
const getUserAgent = (req) => {
  return req.headers['user-agent'] || 'unknown';
};

/**
 * Create a system log entry
 * @param {Object} options - Log options
 * @param {String} options.type - Log type (user_activity, admin_action, etc.)
 * @param {String} options.severity - Log severity (info, success, warning, error, critical)
 * @param {String} options.action - Action description
 * @param {String} options.message - Optional detailed message
 * @param {Object} options.userId - User ID (can be null for system actions)
 * @param {Object} options.metadata - Additional metadata object
 * @param {Object} options.req - Express request object (for IP and user agent)
 */
const createLog = async ({
  type,
  severity = LOG_SEVERITY.INFO,
  action,
  message = null,
  userId = null,
  metadata = {},
  req = null
}) => {
  try {
    const logData = {
      type,
      severity,
      action,
      message: message || action,
      userId,
      metadata,
      ipAddress: req ? getClientIp(req) : null,
      userAgent: req ? getUserAgent(req) : null
    };

    // Create log asynchronously (don't block the request)
    SystemLog.create(logData).catch(err => {
      console.error('Error creating system log:', err);
    });
  } catch (error) {
    // Don't throw errors - logging should never break the application
    console.error('Error in createLog:', error);
  }
};

/**
 * Helper functions for common log types
 */
const logger = {
  // User activity logs
  logUserActivity: (action, userId, req, metadata = {}) => {
    return createLog({
      type: LOG_TYPES.USER_ACTIVITY,
      severity: LOG_SEVERITY.INFO,
      action,
      userId,
      metadata,
      req
    });
  },

  // Admin action logs
  logAdminAction: (action, userId, req, metadata = {}, severity = LOG_SEVERITY.INFO) => {
    return createLog({
      type: LOG_TYPES.ADMIN_ACTION,
      severity,
      action,
      userId,
      metadata,
      req
    });
  },

  // System event logs
  logSystemEvent: (action, req, metadata = {}, severity = LOG_SEVERITY.INFO) => {
    return createLog({
      type: LOG_TYPES.SYSTEM_EVENT,
      severity,
      action,
      userId: null,
      metadata,
      req
    });
  },

  // Security logs
  logSecurity: (action, userId, req, metadata = {}, severity = LOG_SEVERITY.WARNING) => {
    return createLog({
      type: LOG_TYPES.SECURITY,
      severity,
      action,
      userId,
      metadata,
      req
    });
  },

  // API request logs
  logApiRequest: (action, userId, req, metadata = {}) => {
    return createLog({
      type: LOG_TYPES.API_REQUEST,
      severity: LOG_SEVERITY.INFO,
      action,
      userId,
      metadata,
      req
    });
  },

  // Error logs
  logError: (action, userId, req, metadata = {}, severity = LOG_SEVERITY.ERROR) => {
    return createLog({
      type: LOG_TYPES.ERROR,
      severity,
      action,
      userId,
      metadata,
      req
    });
  },

  // Generic log function
  log: createLog
};

module.exports = {
  logger,
  LOG_TYPES,
  LOG_SEVERITY
};

