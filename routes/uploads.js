const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { protect } = require('../middleware/auth');
const { uploadLimiter } = require('../middleware/rateLimiter');

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

function removeListenerCompat(emitter, event, handler) {
  if (!handler) return;
  if (typeof emitter.off === 'function') emitter.off(event, handler);
  else emitter.removeListener(event, handler);
}

function logUploadProgress(label = 'upload') {
  return (req, res, next) => {
    const totalBytes = Number(req.headers['content-length'] || 0);
    const start = Date.now();

    if (!totalBytes) {
      console.log(`[upload] ${label}: request started (unknown total size)`);
      return next();
    }

    console.log(`[upload] ${label}: request started. total=${totalBytes} bytes`);

    let loaded = 0;
    let lastLogged = Date.now();
    const logIntervalMs = 1000;

    const handleData = (chunk) => {
      loaded += chunk.length;
      const now = Date.now();
      if (now - lastLogged >= logIntervalMs) {
        const pct = ((loaded / totalBytes) * 100).toFixed(2);
        console.log(`[upload] ${label}: ${pct}% (${loaded}/${totalBytes} bytes)`);
        lastLogged = now;
      }
    };

    const handleEnd = () => {
      console.log(
        `[upload] ${label}: complete (${loaded} bytes) in ${Date.now() - start}ms`
      );
      cleanup();
    };

    const handleError = (err) => {
      console.error(`[upload] ${label}: stream error`, err.message);
      cleanup();
    };

    function cleanup() {
      removeListenerCompat(req, 'data', handleData);
      removeListenerCompat(req, 'end', handleEnd);
      removeListenerCompat(req, 'error', handleError);
    }

    req.on('data', handleData);
    req.on('end', handleEnd);
    req.on('error', handleError);

    next();
  };
}

// Ensure uploads directory and subdirectories exist
const uploadsDir = path.join(__dirname, '../uploads');
const lessonPlanDir = path.join(uploadsDir, 'lesson-plan');
const videosDir = path.join(uploadsDir, 'videos');
const MAX_VIDEO_UPLOAD_MB = Math.min(Number(process.env.MAX_VIDEO_UPLOAD_MB || 100), 100);
const MAX_VIDEO_UPLOAD_BYTES = MAX_VIDEO_UPLOAD_MB * 1024 * 1024;
const imagesDir = path.join(uploadsDir, 'images');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
if (!fs.existsSync(lessonPlanDir)) {
  fs.mkdirSync(lessonPlanDir, { recursive: true });
}
if (!fs.existsSync(videosDir)) {
  fs.mkdirSync(videosDir, { recursive: true });
}
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
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

// Configure multer for image storage
const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, imagesDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename: timestamp-random-originalname
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

// File filter for videos - only MP4 allowed
const videoFileFilter = (req, file, cb) => {
  if (file.mimetype === 'video/mp4') {
    cb(null, true);
  } else {
    cb(new Error('Only MP4 video files are allowed'), false);
  }
};

const videoUpload = multer({
  storage: videoStorage,
  fileFilter: videoFileFilter,
  limits: {
    fileSize: MAX_VIDEO_UPLOAD_BYTES
  }
});


// @route   GET /api/uploads/watch/:filename/stream
// @desc    Stream video file
// @access  Private
// router.get('/watch/:filename/stream', protect, (req, res) => {
//   const filename = decodeURIComponent(req.params.filename).split('?')[0];
//   const filePath = path.join(videosDir, filename);
//   if (!fs.existsSync(filePath)) return res.sendStatus(404);

//   res.setHeader('Content-Type', 'video/mp4');
//   res.setHeader('Content-Disposition', 'inline');
//   res.sendFile(filePath);
// });


// @route   GET /api/uploads/watch/lesson-plan/:filename/view
// @desc    View lesson plan PDF inline
// @access  Private
// router.get('/watch/lesson-plan/:filename/view', protect, (req, res) => {
//   const filename = decodeURIComponent(req.params.filename).split('?')[0];

//   // security: prevent ../
//   if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
//     return res.status(400).json({ success: false, message: 'Invalid filename' });
//   }

//   const filePath = path.join(lessonPlanDir, filename);
//   if (!fs.existsSync(filePath)) return res.sendStatus(404);

//   res.setHeader('Content-Type', 'application/pdf');
//   res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
//   res.sendFile(filePath);
// });

// @route   POST /api/uploads/lesson-plan
// @desc    Upload lesson plan PDF
// @access  Private
router.post('/lesson-plan', protect, uploadLimiter, upload.single('file'), async (req, res) => {
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
const buildVideoFileUrl = (filename) => `/api/uploads/watch/${encodeURIComponent(filename)}/stream`;

router.post('/video', protect, uploadLimiter, logUploadProgress('video upload'), videoUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    const storedFilename = req.file.filename;
    const storedPath = req.file.path;

    console.log(`[video] Received upload for user=${req.user._id} name=${req.file.originalname} bytes=${req.file.size}`);

    if (logger) {
      logger.logUserActivity(
        'User uploaded video file',
        req.user._id,
        req,
        {
          filename: storedFilename,
          originalName: req.file.originalname,
          fileSize: req.file.size
        }
      ).catch(() => {});
    }

    res.status(201).json({
      success: true,
      video: {
        videoFileName: storedFilename,
        videoFileUrl: buildVideoFileUrl(storedFilename),
        originalName: req.file.originalname,
        originalBytes: req.file.size
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

// @route   POST /api/uploads/image
// @desc    Upload image file
// @access  Private
// NOTE: Image upload functionality has been removed - imageUpload is not defined
// router.post('/image', protect, imageUpload.single('file'), async (req, res) => {
//   try {
//     if (!req.file) {
//       return res.status(400).json({
//         success: false,
//         message: 'No file uploaded'
//       });
//     }

//     // Log file upload (non-blocking)
//     if (logger) {
//       logger.logUserActivity(
//         'User uploaded image file',
//         req.user._id,
//         req,
//         {
//           filename: req.file.filename,
//           originalName: req.file.originalname,
//           fileSize: req.file.size
//         }
//       ).catch(() => {}); // Silently fail
//     }

//     res.json({
//       success: true,
//       file: {
//         filename: req.file.filename,
//         originalName: req.file.originalname,
//         url: `/api/uploads/files/${req.file.filename}`
//       }
//     });
//   } catch (error) {
//     console.error('Image upload error:', error);
//     res.status(500).json({
//       success: false,
//       message: error.message || 'Image upload failed'
//     });
//   }
// });

// @route   GET /api/uploads/files/:filename
// @desc    Serve uploaded file (checks lesson-plan, videos, images subfolders, and root for backward compatibility)
// @access  Private (via token in query or header)
// router.get('/files/:filename', protect, (req, res) => {
//   try {
//     // Decode URL-encoded filename
//     let filename = decodeURIComponent(req.params.filename);
    
//     // Remove any query parameters that might be in the filename
//     filename = filename.split('?')[0];
    
//     // Security: Prevent directory traversal
//     if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
//       return res.status(400).json({
//         success: false,
//         message: 'Invalid filename'
//       });
//     }
    
//     // Determine file type by extension to know which folder to check
//     const ext = path.extname(filename).toLowerCase();
//     console.log("Requested file extension:", ext);
//     const isVideo = ext === '.mp4'; // Only MP4 videos allowed
//     const isPdf = ext === '.pdf';
    
//     // Try to find file in appropriate subfolder, or root for backward compatibility
//     let filePath = null;
    
//     if (isVideo) {
//       // Check videos folder first, then root for backward compatibility
//       const videoPath = path.join(videosDir, filename);
//       const rootPath = path.join(uploadsDir, filename);
//       if (fs.existsSync(videoPath)) {
//         filePath = videoPath;
//       } else if (fs.existsSync(rootPath)) {
//         filePath = rootPath;
//       }
//     } else if (isPdf) {
//       // Check lesson-plan folder first, then root for backward compatibility
//       const lessonPlanPath = path.join(lessonPlanDir, filename);
//       const rootPath = path.join(uploadsDir, filename);
//       if (fs.existsSync(lessonPlanPath)) {
//         filePath = lessonPlanPath;
//       } else if (fs.existsSync(rootPath)) {
//         filePath = rootPath;
//       }
//     } else {
//       // Unknown file type - check root folder
//       filePath = path.join(uploadsDir, filename);
//     }

//     // Check if file exists
//     if (!filePath || !fs.existsSync(filePath)) {
//       return res.status(404).json({
//         success: false,
//         message: 'File not found'
//       });
//     }

//     // Determine content type based on file extension (ext already declared above)
//     let contentType = 'application/octet-stream';
//     let disposition = 'inline';
    
//     if (ext === '.pdf') {
//       contentType = 'application/pdf';
//     } else if (ext === '.mp4') {
//       // Only MP4 videos allowed
//       contentType = 'video/mp4';
//       disposition = 'inline'; // Allow inline playback
//     }

//     // Set appropriate headers
//     res.setHeader('Content-Type', contentType);
//     res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
//     res.setHeader('Cache-Control', 'private, max-age=3600');
    
//     // For video files, add range support for seeking
//     if (contentType.startsWith('video/')) {
//       res.setHeader('Accept-Ranges', 'bytes');
//     }

//     // Send file
//     res.sendFile(filePath);
//   } catch (error) {
//     console.error('File serve error:', error);
//     res.status(500).json({
//       success: false,
//       message: 'Error serving file'
//     });
//   }
// });

router.get('/watch/:filename/stream', protect, (req, res) => {
  let filename = decodeURIComponent(req.params.filename).split('?')[0];

  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ success: false, message: 'Invalid filename' });
  }

  const ext = path.extname(filename).toLowerCase();
  const isVideo = ext === '.mp4';
  const isPdf = ext === '.pdf';

  let filePath = null;

  if (isVideo) {
    const candidatePaths = [
      path.join(videosDir, filename)
    ];
    filePath = candidatePaths.find((p) => fs.existsSync(p)) || null;
    res.setHeader('Content-Type', 'video/mp4');
  } else if (isPdf) {
    const p1 = path.join(lessonPlanDir, filename);
    const p2 = path.join(uploadsDir, filename);
    filePath = fs.existsSync(p1) ? p1 : (fs.existsSync(p2) ? p2 : null);
    res.setHeader('Content-Type', 'application/pdf');
  } else {
    return res.status(400).json({ success: false, message: 'Unsupported file type' });
  }

  if (!filePath) return res.sendStatus(404);

  res.setHeader('Content-Disposition', 'inline');
  res.sendFile(filePath);
});

// Image file filter - completely separate from existing filters
const imageFileFilter = (req, file, cb) => {
  const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
  const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
  const ext = path.extname(file.originalname).toLowerCase();
  
  if (allowedMimeTypes.includes(file.mimetype) && allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed (JPEG, PNG, GIF, WebP, SVG)'), false);
  }
};

// Image upload multer config - uses existing imageStorage (already defined)
const imageUpload = multer({
  storage: imageStorage,
  fileFilter: imageFileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

// @route   POST /api/uploads/image
// @desc    Upload image file
// @access  Private
router.post('/image', protect, uploadLimiter, imageUpload.single('file'), async (req, res) => {
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
        'User uploaded image file',
        req.user._id,
        req,
        {
          filename: req.file.filename,
          originalName: req.file.originalname,
          fileSize: req.file.size
        }
      ).catch(() => {});
    }

    res.json({
      success: true,
      file: {
        filename: req.file.filename,
        originalName: req.file.originalname,
        url: `/api/uploads/images/${req.file.filename}`
      }
    });
  } catch (error) {
    console.error('Image upload error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Image upload failed'
    });
  }
});

// @route   GET /api/uploads/images/:filename
// @desc    Serve uploaded image file
// @access  Private
router.get('/images/:filename', protect, (req, res) => {
  try {
    let filename = decodeURIComponent(req.params.filename).split('?')[0];
    
    // Security: Prevent directory traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({
        success: false,
        message: 'Invalid filename'
      });
    }
    
    const filePath = path.join(imagesDir, filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: 'Image not found'
      });
    }
    
    // Determine content type
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml'
    };
    const contentType = mimeTypes[ext] || 'image/jpeg';
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(filePath);
  } catch (error) {
    console.error('Image serve error:', error);
    res.status(500).json({
      success: false,
      message: 'Error serving image'
    });
  }
});


module.exports = router;
