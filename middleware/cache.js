const { getRedisClient, isRedisAvailable } = require('../config/redis');
const crypto = require('crypto');

/**
 * Cache middleware for GET requests
 * @param {number} ttl - Time to live in seconds (default: 60)
 * @returns {Function} Express middleware
 */
const cacheMiddleware = (ttl = 60) => {
  return async (req, res, next) => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }

    // Bypass cache if _t (timestamp) query param is present (cache-busting)
    if (req.query && req.query._t) {
      return next();
    }

    // Check if Redis is available
    const redisAvailable = await isRedisAvailable();
    if (!redisAvailable) {
      // If Redis is not available, skip caching
      return next();
    }

    try {
      const redisClient = getRedisClient();
      
      // Create cache key from request URL (including query params, excluding cache-busting _t param)
      const urlBase = (req.originalUrl || req.url).split('?')[0];
      const queryParams = new URLSearchParams(req.query);
      queryParams.delete('_t'); // Remove cache-busting param
      const queryString = queryParams.toString();
      const cacheKey = queryString 
        ? `cache:${urlBase}?${queryString}`
        : `cache:${urlBase}`;
      
      // Try to get cached response
      const cachedData = await redisClient.get(cacheKey);
      
      if (cachedData) {
        // Cache hit - return cached response
        const parsedData = JSON.parse(cachedData);
        res.setHeader('X-Cache', 'HIT');
        return res.json(parsedData);
      }

      // Cache miss - intercept response to cache it
      const originalJson = res.json.bind(res);
      res.json = function(data) {
        // Cache the response (non-blocking)
        redisClient.setEx(cacheKey, ttl, JSON.stringify(data))
          .catch((err) => {
            // Silently fail - don't block response
            console.error('Cache set error:', err.message);
          });
        
        res.setHeader('X-Cache', 'MISS');
        return originalJson(data);
      };

      next();
    } catch (error) {
      // If caching fails, continue without cache
      console.error('Cache middleware error:', error.message);
      next();
    }
  };
};

/**
 * Invalidate cache for a specific pattern
 * @param {string} pattern - Cache key pattern to invalidate (e.g., 'cache:/api/submissions*')
 */
const invalidateCache = async (pattern) => {
  try {
    const redisAvailable = await isRedisAvailable();
    if (!redisAvailable) {
      return;
    }

    const redisClient = getRedisClient();
    
    // Use SCAN to find matching keys (more efficient than KEYS for production)
    const keys = [];
    let cursor = 0;
    
    do {
      const result = await redisClient.scan(cursor, {
        MATCH: pattern,
        COUNT: 100
      });
      cursor = result.cursor;
      keys.push(...result.keys);
    } while (Number(cursor) !== 0);

    // Delete all matching keys
    if (keys.length > 0) {
      await redisClient.del(keys);
      console.log(`Invalidated ${keys.length} cache entries matching pattern: ${pattern}`);
    }
  } catch (error) {
    console.error('Cache invalidation error:', error.message);
  }
};

/**
 * Middleware to invalidate cache on POST/PUT/DELETE
 * @param {string|Array<string>} patterns - Cache patterns to invalidate
 */
const invalidateCacheOnChange = (patterns) => {
  return async (req, res, next) => {
    // Only invalidate on write operations
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return next();
    }

    // Intercept response to invalidate cache after successful operation
    const originalJson = res.json.bind(res);
    res.json = function(data) {
      // Only invalidate if operation was successful
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const patternsArray = Array.isArray(patterns) ? patterns : [patterns];
        // Perform invalidation in background - do not await
        Promise.all(patternsArray.map(pattern => invalidateCache(pattern)))
          .catch(err => console.error('Background cache invalidation error:', err));
      }
      return originalJson(data);
    };

    next();
  };
};

module.exports = {
  cacheMiddleware,
  invalidateCache,
  invalidateCacheOnChange
};
