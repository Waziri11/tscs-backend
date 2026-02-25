const { getRedisClient, isRedisAvailable } = require('../config/redis');

const LOCKOUT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_TTL_SECONDS = 900; // 15 minutes

// In-memory fallback when Redis is unavailable
const memoryStore = new Map(); // ip -> { count, lockoutUntil }

/**
 * Check if an IP is currently locked out due to too many failed login attempts.
 * @param {string} ip - Client IP address
 * @returns {Promise<boolean>} - True if locked out
 */
async function isLockedOut(ip) {
  const redisAvailable = await isRedisAvailable();
  if (redisAvailable) {
    try {
      const client = getRedisClient();
      const exists = await client.exists(`login_lockout:${ip}`);
      return exists === 1;
    } catch (error) {
      // Fall through to memory store on Redis error
    }
  }

  const entry = memoryStore.get(ip);
  if (!entry) return false;
  if (entry.lockoutUntil && Date.now() < entry.lockoutUntil) return true;
  if (entry.lockoutUntil && Date.now() >= entry.lockoutUntil) {
    memoryStore.delete(ip);
    return false;
  }
  return false;
}

/**
 * Record a failed login attempt. Sets 15-minute lockout when count reaches 5.
 * @param {string} ip - Client IP address
 */
async function recordFailedAttempt(ip) {
  const redisAvailable = await isRedisAvailable();
  if (redisAvailable) {
    try {
      const client = getRedisClient();
      const countKey = `failed_login:${ip}`;
      const lockoutKey = `login_lockout:${ip}`;

      const count = await client.incr(countKey);
      if (count === 1) {
        await client.expire(countKey, LOCKOUT_TTL_SECONDS);
      }
      if (count >= MAX_FAILED_ATTEMPTS) {
        await client.setEx(lockoutKey, LOCKOUT_TTL_SECONDS, '1');
        await client.del(countKey);
      }
      return;
    } catch (error) {
      // Fall through to memory store on Redis error
    }
  }

  let entry = memoryStore.get(ip);
  if (!entry) {
    entry = { count: 0, lockoutUntil: null };
    memoryStore.set(ip, entry);
  }
  if (entry.lockoutUntil && Date.now() >= entry.lockoutUntil) {
    entry.count = 0;
    entry.lockoutUntil = null;
  }
  entry.count += 1;
  if (entry.count >= MAX_FAILED_ATTEMPTS) {
    entry.lockoutUntil = Date.now() + LOCKOUT_WINDOW_MS;
    entry.count = 0;
  }
}

/**
 * Clear failed attempts and lockout for an IP (e.g. on successful login).
 * @param {string} ip - Client IP address
 */
async function clearFailedAttempts(ip) {
  const redisAvailable = await isRedisAvailable();
  if (redisAvailable) {
    try {
      const client = getRedisClient();
      await client.del(`failed_login:${ip}`);
      await client.del(`login_lockout:${ip}`);
      return;
    } catch (error) {
      // Fall through to memory store on Redis error
    }
  }

  memoryStore.delete(ip);
}

/**
 * Middleware that blocks login requests from locked-out IPs.
 */
function failedLoginLockout(req, res, next) {
  isLockedOut(req.ip || req.connection?.remoteAddress)
    .then((locked) => {
      if (locked) {
        return res.status(429).json({
          success: false,
          message: 'Too many failed login attempts. Please try again in 15 minutes.'
        });
      }
      next();
    })
    .catch(() => next());
}

module.exports = {
  isLockedOut,
  recordFailedAttempt,
  clearFailedAttempts,
  failedLoginLockout
};
