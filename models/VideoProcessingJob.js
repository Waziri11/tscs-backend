const mongoose = require('mongoose');

const videoProcessingJobSchema = new mongoose.Schema(
  {
    videoId: { type: String, unique: true, index: true },
    teacherId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    submissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission', default: null },
    originalName: String,
    originalPath: String,
    status: {
      type: String,
      enum: ['UPLOADED', 'QUEUED', 'PROCESSING', 'READY', 'FAILED'],
      default: 'UPLOADED'
    },
    originalBytes: Number,
    targetMb: { type: Number, default: 100 },
    error: String,
    videoFileName: String,
    videoFileUrl: String
  },
  { timestamps: true }
);

videoProcessingJobSchema.index({ submissionId: 1 });

module.exports = mongoose.model('VideoProcessingJob', videoProcessingJobSchema);
