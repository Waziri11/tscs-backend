const SystemLog = require('../models/SystemLog');

// Middleware to log requests
const requestLogger = async (req, res, next) => {
  // Skip logging for health checks and static assets
  if (req.path === '/api/health') {
    return next();
  }

  // Log after response is sent
  const originalSend = res.send;
  res.send = function(data) {
    res.send = originalSend;
    
    // Log asynchronously (don't block response)
    (async () => {
      try {
        await SystemLog.create({
          type: 'system',
          severity: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warning' : 'info',
          message: `${req.method} ${req.path} - ${res.statusCode}`,
          userId: req.user?._id,
          metadata: {
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            query: req.query,
            body: req.method !== 'GET' ? req.body : undefined
          },
          ipAddress: req.ip || req.connection.remoteAddress,
          userAgent: req.get('user-agent')
        });
      } catch (error) {
        console.error('Error logging request:', error);
      }
    })();

    return originalSend.call(this, data);
  };

  next();
};

module.exports = { requestLogger };

