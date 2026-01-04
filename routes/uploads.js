const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { protect } = require('../middleware/auth');

// Safely import logger - if it fails, app should still work
let logger = null;
try {
  const loggerModule = require('../utils/logger');
  logger = loggerModule.logger;
} catch (error) {
  console.error('Warning: Logger not available:', error.message);
  // Create a no-op logger so the app doesn't crash
  logger = {
    logUserActivity: () => Promise.resolve(),
    logSecurity: () => Promise.resolve(),
    logAdminAction: () => Promise.resolve(),
    logSystemEvent: () => Promise.resolve(),
    logApiRequest: () => Promise.resolve(),
    logError: () => Promise.resolve(),
    log: () => Promise.resolve()
  };
}

const router = express.Router();

// Ensure uploads directory and subdirectories exist
const uploadsDir = path.join(__dirname, '../uploads');
const lessonPlanDir = path.join(uploadsDir, 'lesson-plan');
const videosDir = path.join(uploadsDir, 'videos');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
if (!fs.existsSync(lessonPlanDir)) {
  fs.mkdirSync(lessonPlanDir, { recursive: true });
}
if (!fs.existsSync(videosDir)) {
  fs.mkdirSync(videosDir, { recursive: true });
}

// Configure multer for lesson plan storage
const lessonPlanStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, lessonPlanDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename: timestamp-teacherId-originalname
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext);
    cb(null, `${uniqueSuffix}-${name}${ext}`);
  }
});

// Configure multer for video storage
const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, videosDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename: timestamp-teacherId-originalname
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext);
    cb(null, `${uniqueSuffix}-${name}${ext}`);
  }
});

// File filter - only allow PDFs
const fileFilter = (req, file, cb) => {
  if (file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    cb(new Error('Only PDF files are allowed'), false);
  }
};

const upload = multer({
  storage: lessonPlanStorage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

// File filter for videos - allow common video formats
const videoFileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    'video/mp4',
    'video/webm',
    'video/ogg',
    'video/quicktime',
    'video/x-msvideo' // avi
  ];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only video files (MP4, WebM, OGG, MOV, AVI) are allowed'), false);
  }
};

const videoUpload = multer({
  storage: videoStorage,
  fileFilter: videoFileFilter,
  limits: {
    fileSize: 500 * 1024 * 1024 // 500MB limit for videos
  }
});

// @route   POST /api/uploads/lesson-plan
// @desc    Upload lesson plan PDF
// @access  Private
router.post('/lesson-plan', protect, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    // Log file upload (non-blocking)
    if (logger) {
      logger.logUserActivity(
        'User uploaded lesson plan file',
        req.user._id,
        req,
        {
          filename: req.file.filename,
          originalName: req.file.originalname,
          fileSize: req.file.size
        }
      ).catch(() => {}); // Silently fail
    }

    res.json({
      success: true,
      file: {
        filename: req.file.filename,
        originalName: req.file.originalname,
        url: `/api/uploads/files/${req.file.filename}`
      }
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'File upload failed'
    });
  }
});

// @route   POST /api/uploads/video
// @desc    Upload video file
// @access  Private
router.post('/video', protect, videoUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    // Log file upload (non-blocking)
    if (logger) {
      logger.logUserActivity(
        'User uploaded video file',
        req.user._id,
        req,
        {
          filename: req.file.filename,
          originalName: req.file.originalname,
          fileSize: req.file.size
        }
      ).catch(() => {}); // Silently fail
    }

    res.json({
      success: true,
      file: {
        filename: req.file.filename,
        originalName: req.file.originalname,
        url: `/api/uploads/files/${req.file.filename}`
      }
    });
  } catch (error) {
    console.error('Video upload error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Video upload failed'
    });
  }
});

// @route   GET /api/uploads/files/:filename
// @desc    Serve uploaded file (checks both lesson-plan and videos subfolders, and root for backward compatibility)
// @access  Private (via token in query or header)
router.get('/files/:filename', protect, (req, res) => {
  try {
    // Decode URL-encoded filename
    let filename = decodeURIComponent(req.params.filename);
    
    // Remove any query parameters that might be in the filename
    filename = filename.split('?')[0];
    
    // Security: Prevent directory traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({
        success: false,
        message: 'Invalid filename'
      });
    }
    
    // Determine file type by extension to know which folder to check
    const ext = path.extname(filename).toLowerCase();
    const isVideo = ['.mp4', '.webm', '.ogg', '.mov', '.avi'].includes(ext);
    const isPdf = ext === '.pdf';
    
    // Try to find file in appropriate subfolder, or root for backward compatibility
    let filePath = null;
    
    if (isVideo) {
      // Check videos folder first, then root for backward compatibility
      const videoPath = path.join(videosDir, filename);
      const rootPath = path.join(uploadsDir, filename);
      if (fs.existsSync(videoPath)) {
        filePath = videoPath;
      } else if (fs.existsSync(rootPath)) {
        filePath = rootPath;
      }
    } else if (isPdf) {
      // Check lesson-plan folder first, then root for backward compatibility
      const lessonPlanPath = path.join(lessonPlanDir, filename);
      const rootPath = path.join(uploadsDir, filename);
      if (fs.existsSync(lessonPlanPath)) {
        filePath = lessonPlanPath;
      } else if (fs.existsSync(rootPath)) {
        filePath = rootPath;
      }
    } else {
      // Unknown file type - check root folder
      filePath = path.join(uploadsDir, filename);
    }

    // Check if file exists
    if (!filePath || !fs.existsSync(filePath)) {
      if (process.env.NODE_ENV === 'development') {
        console.log('File not found:', filePath || filename);
      }
        video: isVideo ? path.join(videosDir, filename) : 'N/A',
        lessonPlan: isPdf ? path.join(lessonPlanDir, filename) : 'N/A',
        root: path.join(uploadsDir, filename)
      });
      
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }

    // Determine content type based on file extension (ext already declared above)
    let contentType = 'application/octet-stream';
    let disposition = 'inline';
    
    if (ext === '.pdf') {
      contentType = 'application/pdf';
    } else if (['.mp4', '.webm', '.ogg', '.mov', '.avi'].includes(ext)) {
      // Video files
      if (ext === '.mp4') contentType = 'video/mp4';
      else if (ext === '.webm') contentType = 'video/webm';
      else if (ext === '.ogg') contentType = 'video/ogg';
      else if (ext === '.mov') contentType = 'video/quicktime';
      else if (ext === '.avi') contentType = 'video/x-msvideo';
      disposition = 'inline'; // Allow inline playback
    }

    // Set appropriate headers
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    
    // For video files, add range support for seeking
    if (contentType.startsWith('video/')) {
      res.setHeader('Accept-Ranges', 'bytes');
    }

    // Send file
    res.sendFile(filePath);
  } catch (error) {
    console.error('File serve error:', error);
    res.status(500).json({
      success: false,
      message: 'Error serving file'
    });
  }
});

module.exports = router;

