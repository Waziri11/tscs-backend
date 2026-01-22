const redis = require('redis');

let redisClient = null;

// Create Redis client connection
const createRedisClient = () => {
  if (redisClient) {
    return redisClient;
  }

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  
  redisClient = redis.createClient({
    url: redisUrl,
    socket: {
      reconnectStrategy: (retries) => {
        if (retries > 10) {
          console.error('Redis: Too many reconnection attempts, giving up');
          return new Error('Too many reconnection attempts');
        }
        return Math.min(retries * 100, 3000);
      }
    }
  });

  redisClient.on('error', (err) => {
    console.error('Redis Client Error:', err);
    // Don't crash the app if Redis is unavailable
  });

  redisClient.on('connect', () => {
    console.log('Redis Client Connected');
  });

  redisClient.on('ready', () => {
    console.log('Redis Client Ready');
  });

  redisClient.on('reconnecting', () => {
    console.log('Redis Client Reconnecting...');
  });

  // Connect to Redis (non-blocking)
  redisClient.connect().catch((err) => {
    console.error('Failed to connect to Redis:', err.message);
    // Continue without Redis - caching will be disabled
  });

  return redisClient;
};

// Get Redis client (singleton)
const getRedisClient = () => {
  if (!redisClient) {
    return createRedisClient();
  }
  return redisClient;
};

// Check if Redis is available
const isRedisAvailable = async () => {
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

