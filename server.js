const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Import database connection
const connectDB = require('./config/database');

// Import services
const emailService = require('./services/emailService');
const notificationService = require('./services/notificationService');

// Import routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const submissionRoutes = require('./routes/submissions');
const competitionRoutes = require('./routes/competitions');
const competitionRoundRoutes = require('./routes/competitionRounds');
const evaluationRoutes = require('./routes/evaluations');
const quotaRoutes = require('./routes/quotas');
const tieBreakingRoutes = require('./routes/tieBreaking');
const systemLogRoutes = require('./routes/systemLogs');
const landingPageRoutes = require('./routes/landingPage');
const uploadRoutes = require('./routes/uploads');
const notificationRoutes = require('./routes/notifications');

const app = express();

// Middleware
// CORS configuration
const allowedOrigins = [];
if (process.env.CLIENT_URL) {
  allowedOrigins.push(process.env.CLIENT_URL);
}
// Allow localhost in development
if (process.env.NODE_ENV === 'development') {
  allowedOrigins.push(/^http:\/\/localhost:\d+$/);
  allowedOrigins.push(/^http:\/\/127\.0\.0\.1:\d+$/);
}

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Check if origin matches allowed origins
    const isAllowed = allowedOrigins.some(allowed => {
      if (typeof allowed === 'string') {
        return origin === allowed;
      } else if (allowed instanceof RegExp) {
        return allowed.test(origin);
      }
      return false;
    });
    
    if (isAllowed) {
      callback(null, true);
    } else {
      console.warn(`CORS blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// MongoDB Connection
connectDB();

// Initialize email service
emailService.initialize();

// Test email connection in development
if (process.env.NODE_ENV === 'development') {
  emailService.testConnection().catch(() => {
    console.warn('⚠️  Email service test failed. Check your Gmail credentials.');
  });
}

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/submissions', submissionRoutes);
app.use('/api/competitions', competitionRoutes);
app.use('/api/competition-rounds', competitionRoundRoutes);
app.use('/api/evaluations', evaluationRoutes);
app.use('/api/quotas', quotaRoutes);
app.use('/api/tie-breaking', tieBreakingRoutes);
app.use('/api/system-logs', systemLogRoutes);
app.use('/api/landing-page', landingPageRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/notifications', notificationRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'TSCS Backend API is running',
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    message: 'Route not found' 
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

const PORT = process.env.PORT || 5000;

// Start round scheduler
const { startScheduler } = require('./utils/roundScheduler');
startScheduler();

app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

