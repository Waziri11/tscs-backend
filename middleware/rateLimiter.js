const rateLimit = require('express-rate-limit');
const { getRedisClient, isRedisAvailable } = require('../config/redis');

// Create a Redis store adapter for rate limiting
const createRedisStore = () => {
  return {
    async increment(key) {
      try {
        const redisAvailable = await isRedisAvailable();
        if (!redisAvailable) {
          // Fallback to in-memory if Redis unavailable
          return null;
        }

        const redisClient = getRedisClient();
        const count = await redisClient.incr(key);
        
        // Set expiration on first increment
        if (count === 1) {
          await redisClient.expire(key, 900); // 15 minutes
        }
        
        return {
          totalHits: count,
          resetTime: new Date(Date.now() + 900000) // 15 minutes from now
        };
      } catch (error) {
        console.error('Redis rate limit store error:', error.message);
        return null; // Fallback to in-memory
      }
    },
    async decrement(key) {
      try {
        const redisAvailable = await isRedisAvailable();
        if (!redisAvailable) {
          return;
        }
        const redisClient = getRedisClient();
        await redisClient.decr(key);
      } catch (error) {
        // Silently fail
      }
    },
    async resetKey(key) {
      try {
        const redisAvailable = await isRedisAvailable();
        if (!redisAvailable) {
          return;
        }
        const redisClient = getRedisClient();
        await redisClient.del(key);
      } catch (error) {
        // Silently fail
      }
    }
  };
};

// General API rate limiter - 100 requests per 15 minutes
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later.'
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  store: createRedisStore(),
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/api/health';
  }
});

// Auth endpoints rate limiter - 5 requests per 15 minutes (stricter)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs
  message: {
    success: false,
    message: 'Too many authentication attempts, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore(),
  skipSuccessfulRequests: false, // Count all requests, including successful ones
});

// Upload endpoints rate limiter - 20 requests per hour
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // Limit each IP to 20 requests per hour
  message: {
    success: false,
    message: 'Too many upload requests, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore(),
});

module.exports = {
  generalLimiter,
  authLimiter,
  uploadLimiter
};

