const mongoose = require('mongoose');

const submissionSchema = new mongoose.Schema({
  teacherId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  teacherName: {
    type: String,
    required: true,
    trim: true
  },
  year: {
    type: Number,
    required: true,
    default: new Date().getFullYear()
  },
  category: {
    type: String,
    required: true,
    trim: true
  },
  class: {
    type: String,
    required: true,
    trim: true
  },
  subject: {
    type: String,
    required: true,
    trim: true
  },
  areaOfFocus: {
    type: String,
    required: true,
    trim: true
  },
  level: {
    type: String,
    enum: ['Council', 'Regional', 'National'],
    default: 'Council',
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'submitted', 'under_review', 'evaluated', 'approved', 'eliminated', 'promoted'],
    default: 'pending'
  },
  region: {
    type: String,
    required: true,
    trim: true
  },
  council: {
    type: String,
    trim: true
  },
  school: {
    type: String,
    required: true,
    trim: true
  },
  videoLink: {
    type: String,
    trim: true
  },
  preferredLink: {
    type: String,
    trim: true
  },
  lessonPlanFileName: {
    type: String,
    trim: true
  },
  lessonPlanFileUrl: {
    type: String,
    trim: true
  },
  videoFileName: {
    type: String,
    trim: true
  },
  videoFileUrl: {
    type: String,
    trim: true
  },
  videoProcessingJobId: {
    type: String,
    trim: true
  },
  videoProcessingStatus: {
    type: String,
    enum: ['IDLE', 'QUEUED', 'PROCESSING', 'READY', 'FAILED'],
    default: 'IDLE'
  },
  videoProcessingError: {
    type: String,
    trim: true
  },
  videoOriginalBytes: {
    type: Number
  },
  videoCompressedBytes: {
    type: Number
  },
  videoTargetMb: {
    type: Number
  },
  score: {
    type: Number,
    default: 0
  },
  averageScore: {
    type: Number,
    default: 0
  },
  deadline: {
    type: Date
  },
  date: {
    type: Date,
    default: Date.now
  },
  notes: {
    type: String,
    trim: true
  },
  roundId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CompetitionRound',
    default: null
  },
  disqualified: {
    type: Boolean,
    default: false
  },
  disqualificationReason: {
    type: String,
    trim: true
  },
  disqualifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  disqualifiedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Indexes for better query performance
submissionSchema.index({ teacherId: 1 });
submissionSchema.index({ level: 1, region: 1, council: 1 });
submissionSchema.index({ year: 1, category: 1, class: 1, subject: 1 });
submissionSchema.index({ status: 1 });
submissionSchema.index({ level: 1, status: 1 });
submissionSchema.index({ roundId: 1 });
submissionSchema.index({ roundId: 1, averageScore: -1 }); // For leaderboard queries
submissionSchema.index({ teacherId: 1, areaOfFocus: 1, year: 1 }); // For duplicate submission check
// Additional compound indexes for common query patterns
submissionSchema.index({ teacherId: 1, status: 1 });
submissionSchema.index({ year: 1, level: 1, status: 1 });
submissionSchema.index({ region: 1, council: 1, status: 1 });

module.exports = mongoose.model('Submission', submissionSchema);
