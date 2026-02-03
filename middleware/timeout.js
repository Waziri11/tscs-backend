/**
 * HTTP Request Timeout Middleware
 * Automatically times out requests that exceed the specified duration
 * @param {number} timeoutMs - Timeout in milliseconds (default: 30000 = 30 seconds)
 */
const requestTimeout = (timeoutMs = 30000) => {
  return (req, res, next) => {
    // Set a timeout for the request
    const timeout = setTimeout(() => {
      if (!res.headersSent) {
        res.status(504).json({
          success: false,
          message: 'Request timeout. The server took too long to respond.'
        });
        res.end();
      }
    }, timeoutMs);

    // Clear timeout when response is sent
    const originalEnd = res.end;
    res.end = function(...args) {
      clearTimeout(timeout);
      originalEnd.apply(this, args);
    };

    next();
  };
};

module.exports = requestTimeout;
