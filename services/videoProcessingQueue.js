const IORedis = require('ioredis');
const { Queue } = require('bullmq');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

let connection;
let queue;

function getConnection() {
  if (!connection) {
    connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  }
  return connection;
}

function getVideoQueue() {
  if (!queue) {
    queue = new Queue('video-compress', { connection: getConnection() });
  }
  return queue;
}

async function enqueueVideoCompression(videoId) {
  const q = getVideoQueue();
  await q.add('compress', { videoId });
}

module.exports = {
  getVideoQueue,
  enqueueVideoCompression
};
