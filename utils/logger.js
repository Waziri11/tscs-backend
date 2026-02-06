// Safely require SystemLog - if it fails, logging will be disabled
let SystemLog = null;
try {
  SystemLog = require('../models/SystemLog');
} catch (error) {
  console.error('Warning: SystemLog model not available, logging disabled:', error.message);
}

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
 * LogBatcher - Batches log writes to reduce database operations
 */
class LogBatcher {
  constructor(batchSize = 50, batchDelay = 5000) {
    this.batchSize = batchSize;
    this.batchDelay = batchDelay;
    this.batch = [];
    this.flushTimer = null;
  }

  /**
   * Add log to batch
   */
  addLog(logData) {
    this.batch.push(logData);

    // Flush if batch is full
    if (this.batch.length >= this.batchSize) {
      this.flush();
    } else if (!this.flushTimer) {
      // Schedule flush after delay
      this.flushTimer = setTimeout(() => {
        this.flush();
      }, this.batchDelay);
    }
  }

  /**
   * Flush batch to database
   */
  async flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.batch.length === 0) {
      return;
    }

    const logsToWrite = [...this.batch];
    this.batch = [];

    try {
      if (SystemLog && SystemLog.insertMany) {
        await SystemLog.insertMany(logsToWrite, { ordered: false });
      }
    } catch (error) {
      // Silently fail - don't break the app if logging fails
      // Try to write logs individually as fallback
      if (SystemLog && SystemLog.create) {
        logsToWrite.forEach(log => {
          SystemLog.create(log).catch(() => {
            // Silently fail
          });
        });
      }
    }
  }

  /**
   * Force immediate flush (for critical logs)
   */
  async forceFlush() {
    await this.flush();
  }
}

// Create singleton instance
const logBatcher = new LogBatcher(50, 5000);

// Flush logs on process exit
process.on('SIGTERM', async () => {
  await logBatcher.forceFlush();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await logBatcher.forceFlush();
  process.exit(0);
});

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
 * @param {String} options.actionCategory - create | update | delete | read | other (for DB-altering filter/grouping)
 */
const createLog = async ({
  type,
  severity = LOG_SEVERITY.INFO,
  action,
  message = null,
  userId = null,
  metadata = {},
  req = null,
  actionCategory = 'other'
}) => {
  // Always return immediately - never block
  try {
    // Check if SystemLog model is available
    if (!SystemLog) {
      return Promise.resolve();
    }

    const logData = {
      type,
      severity,
      action,
      actionCategory: ['create', 'update', 'delete', 'read', 'other'].includes(actionCategory) ? actionCategory : 'other',
      message: message || action,
      userId,
      metadata,
      ipAddress: req ? getClientIp(req) : null,
      userAgent: req ? getUserAgent(req) : null
    };

    // Add to batch for efficient batch writes
    // Use setImmediate to ensure this doesn't block the event loop
    setImmediate(() => {
      try {
        if (SystemLog) {
          logBatcher.addLog(logData);
        }
      } catch (err) {
        // Silently fail
      }
    });
    
    // Return resolved promise immediately so awaiting doesn't block
    return Promise.resolve();
  } catch (error) {
    // Don't throw errors - logging should never break the application
    // Silently fail
    return Promise.resolve();
  }
};

/**
 * Helper functions for common log types
 */
const logger = {
  // User activity logs (optional actionCategory: 'create' | 'update' | 'delete' | 'read' | 'other')
  logUserActivity: (action, userId, req, metadata = {}, actionCategory = 'other') => {
    return createLog({
      type: LOG_TYPES.USER_ACTIVITY,
      severity: LOG_SEVERITY.INFO,
      action,
      userId,
      metadata,
      req,
      actionCategory
    });
  },

  // Admin action logs
  logAdminAction: (action, userId, req, metadata = {}, severity = LOG_SEVERITY.INFO, actionCategory = 'other') => {
    return createLog({
      type: LOG_TYPES.ADMIN_ACTION,
      severity,
      action,
      userId,
      metadata,
      req,
      actionCategory
    });
  },

  // System event logs
  logSystemEvent: (action, req, metadata = {}, severity = LOG_SEVERITY.INFO, actionCategory = 'other') => {
    return createLog({
      type: LOG_TYPES.SYSTEM_EVENT,
      severity,
      action,
      userId: null,
      metadata,
      req,
      actionCategory
    });
  },

  // Security logs
  logSecurity: (action, userId, req, metadata = {}, severity = LOG_SEVERITY.WARNING, actionCategory = 'other') => {
    return createLog({
      type: LOG_TYPES.SECURITY,
      severity,
      action,
      userId,
      metadata,
      req,
      actionCategory
    });
  },

  // API request logs
  logApiRequest: (action, userId, req, metadata = {}, actionCategory = 'other') => {
    return createLog({
      type: LOG_TYPES.API_REQUEST,
      severity: LOG_SEVERITY.INFO,
      action,
      userId,
      metadata,
      req,
      actionCategory
    });
  },

  // Error logs
  logError: (action, userId, req, metadata = {}, severity = LOG_SEVERITY.ERROR, actionCategory = 'other') => {
    return createLog({
      type: LOG_TYPES.ERROR,
      severity,
      action,
      userId,
      metadata,
      req,
      actionCategory
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

