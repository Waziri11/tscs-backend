const redis = require('redis');

let redisClient = null;
let redisEnabled = process.env.REDIS_ENABLED === 'true' || process.env.REDIS_URL;

// Create Redis client connection (only if Redis is enabled)
const createRedisClient = () => {
  if (redisClient) {
    return redisClient;
  }

  // Only create client if Redis is explicitly enabled
  if (!redisEnabled) {
    return null;
  }

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  
  redisClient = redis.createClient({
    url: redisUrl,
    socket: {
      reconnectStrategy: (retries) => {
        if (retries > 3) {
          // Silently give up after 3 attempts to reduce log noise
          return false; // Stop reconnecting
        }
        return Math.min(retries * 500, 2000);
      },
      connectTimeout: 5000 // 5 second timeout
    }
  });

  // Only log errors in development or if explicitly enabled
  const shouldLog = process.env.NODE_ENV === 'development' || process.env.REDIS_VERBOSE === 'true';

  redisClient.on('error', (err) => {
    if (shouldLog && err.code !== 'ECONNREFUSED') {
      // Only log non-connection errors to reduce noise
      console.error('Redis Client Error:', err.message);
    }
  });

  redisClient.on('connect', () => {
    if (shouldLog) {
      console.log('Redis Client Connected');
    }
  });

  redisClient.on('ready', () => {
    if (shouldLog) {
      console.log('Redis Client Ready');
    }
  });

  redisClient.on('reconnecting', () => {
    // Suppress reconnecting messages to reduce log noise
  });

  // Connect to Redis (non-blocking, silent failure)
  redisClient.connect().catch((err) => {
    // Only log if explicitly enabled or in verbose mode
    if (process.env.REDIS_VERBOSE === 'true') {
      console.error('Failed to connect to Redis:', err.message);
    }
    // Continue without Redis - caching will be disabled
  });

  return redisClient;
};

// Get Redis client (singleton)
const getRedisClient = () => {
  if (!redisEnabled) {
    return null;
  }
  if (!redisClient) {
    return createRedisClient();
  }
  return redisClient;
};

// Check if Redis is available
const isRedisAvailable = async () => {
  // If Redis is not enabled, return false immediately
  if (!redisEnabled) {
    return false;
  }
  
  try {
    const client = getRedisClient();
    if (!client || !client.isReady) {
      return false;
    }
    await client.ping();
    return true;
  } catch (error) {
    return false;
  }
};

// Gracefully close Redis connection
const closeRedisConnection = async () => {
  if (redisClient && redisClient.isReady) {
    try {
      await redisClient.quit();
      console.log('Redis connection closed');
    } catch (error) {
      console.error('Error closing Redis connection:', error);
    }
  }
};

module.exports = {
  getRedisClient,
  isRedisAvailable,
  closeRedisConnection,
  createRedisClient
};

