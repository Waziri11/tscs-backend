const SystemLog = require('../models/SystemLog');

// Only log requests that alter the database (skip GET/read)
const MUTATION_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
const METHOD_TO_CATEGORY = {
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete'
};

const requestLogger = async (req, res, next) => {
  if (req.path === '/api/health') {
    return next();
  }

  if (!MUTATION_METHODS.includes(req.method)) {
    return next();
  }

  const originalSend = res.send;
  res.send = function(data) {
    res.send = originalSend;

    (async () => {
      try {
        await SystemLog.create({
          type: 'api_request',
          severity: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warning' : 'info',
          action: `${req.method} ${req.path}`,
          actionCategory: METHOD_TO_CATEGORY[req.method] || 'other',
          message: `${req.method} ${req.path} - ${res.statusCode}`,
          userId: req.user?._id,
          metadata: {
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            query: req.query,
            body: req.body
          },
          ipAddress: req.ip || req.connection?.remoteAddress,
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

