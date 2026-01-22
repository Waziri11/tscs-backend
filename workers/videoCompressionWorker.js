require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const VideoProcessingJob = require('../models/VideoProcessingJob');
const Submission = require('../models/Submission');
const { compressToMaxMb } = require('../utils/videoCompression');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const TARGET_MB = Number(process.env.VIDEO_TARGET_MB || 100);
const CONCURRENCY = Number(process.env.VIDEO_WORKER_CONCURRENCY || 1);
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tscs';

const baseDir = path.join(__dirname, '..');
const uploadsDir = path.join(baseDir, 'uploads');
const videosDir = path.join(uploadsDir, 'videos');
const compressedDir = path.join(videosDir, 'compressed');

fs.mkdirSync(compressedDir, { recursive: true });

const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

const buildVideoFileUrl = (filename) => `/api/uploads/watch/${encodeURIComponent(filename)}/stream`;

async function connectMongo() {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(MONGODB_URI);
}

async function updateSubmissionFromJob(jobDoc, fields) {
  if (!jobDoc.submissionId) return;
  await Submission.findByIdAndUpdate(jobDoc.submissionId, fields, { new: false });
}

let workerInstance = null;

async function startVideoCompressionWorker() {
  if (workerInstance) return workerInstance;

  await connectMongo();

  workerInstance = new Worker(
    'video-compress',
    async ({ data }) => {
        const { videoId } = data;
        const jobDoc = await VideoProcessingJob.findOne({ videoId });
        if (!jobDoc) throw new Error('Video job not found');

        console.log(`[worker] Starting compression job=${videoId} input=${jobDoc.originalPath}`);

        await VideoProcessingJob.updateOne({ videoId }, { status: 'PROCESSING', error: null });
        await updateSubmissionFromJob(jobDoc, { videoProcessingStatus: 'PROCESSING', videoProcessingError: null });

        const outputFilename = jobDoc.videoFileName || `${videoId}.mp4`;
        const outputPath = path.join(compressedDir, outputFilename);

        try {
          const result = await compressToMaxMb({
            inputPath: jobDoc.originalPath,
            outputPath,
            maxMb: jobDoc.targetMb || TARGET_MB
          });

          const update = {
            status: 'READY',
            compressedPath: outputPath,
            compressedBytes: result.compressedBytes,
            error: result.warning || null,
            videoFileName: outputFilename,
            videoFileUrl: buildVideoFileUrl(outputFilename)
          };

          await VideoProcessingJob.updateOne({ videoId }, update);

          await updateSubmissionFromJob(jobDoc, {
            videoProcessingStatus: 'READY',
            videoProcessingError: result.warning || null,
            videoFileName: outputFilename,
            videoFileUrl: buildVideoFileUrl(outputFilename),
            videoCompressedBytes: result.compressedBytes
          });

          console.log(
            `[worker] Completed job=${videoId} compressed=${result.compressedBytes} bytes output=${outputPath}`
          );

          return result;
        } catch (error) {
          await VideoProcessingJob.updateOne({ videoId }, { status: 'FAILED', error: error.message });
          await updateSubmissionFromJob(jobDoc, { videoProcessingStatus: 'FAILED', videoProcessingError: error.message });
          console.error(`[worker] Failed job=${videoId}`, error);
          throw error;
        }
    },
    {
      connection,
      concurrency: CONCURRENCY
    }
  );

  workerInstance.on('failed', (job, err) => {
    console.error(`[worker] Job ${job?.id} FAILED`, err);
  });

  console.log(`Video compression worker online (concurrency=${CONCURRENCY}).`);
  return workerInstance;
}

if (require.main === module) {
  startVideoCompressionWorker().catch((error) => {
    console.error('Failed to start video compression worker:', error);
    process.exit(1);
  });
}

module.exports = {
  startVideoCompressionWorker
};
