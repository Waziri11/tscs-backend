const rateLimit = require('express-rate-limit');
const { getRedisClient, isRedisAvailable } = require('../config/redis');

// Create a Redis store adapter for rate limiting
const createRedisStore = async () => {
  const redisAvailable = await isRedisAvailable();
  
  if (!redisAvailable) {
    // Return undefined to use default in-memory store
    return undefined;
  }

  return {
    async increment(key) {
      try {
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
        // Return undefined to fallback to default store
        return undefined;
      }
    },
    async decrement(key) {
      try {
        const redisClient = getRedisClient();
        await redisClient.decr(key);
      } catch (error) {
        // Silently fail
      }
    },
    async resetKey(key) {
      try {
        const redisClient = getRedisClient();
        await redisClient.del(key);
      } catch (error) {
        // Silently fail
      }
    }
  };
};

// Helper to create rate limiters with conditional Redis store
const createRateLimiter = (options) => {
  return rateLimit({
    ...options,
    // Store will be set dynamically based on Redis availability
    // Don't set store here - will be set asynchronously if Redis is available
  });
};

// General API rate limiter - 100 requests per 15 minutes
const generalLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    return req.path === '/api/health';
  }
});

// Auth endpoints rate limiter - 5 requests per 15 minutes (stricter)
const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs
  message: {
    success: false,
    message: 'Too many authentication attempts, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
});

// Upload endpoints rate limiter - 20 requests per hour
const uploadLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // Limit each IP to 20 requests per hour
  message: {
    success: false,
    message: 'Too many upload requests, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Try to upgrade to Redis store if available (non-blocking)
(async () => {
  try {
    const store = await createRedisStore();
    if (store) {
      generalLimiter.store = store;
      authLimiter.store = store;
      uploadLimiter.store = store;
      console.log('Rate limiting upgraded to Redis store');
    } else {
      console.log('Rate limiting using default in-memory store (Redis unavailable)');
    }
  } catch (error) {
    console.log('Rate limiting using default in-memory store (Redis unavailable)');
  }
})();

module.exports = {
  generalLimiter,
  authLimiter,
  uploadLimiter
};

