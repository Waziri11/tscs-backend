const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const morgan = require("morgan");
const path = require("path");
const compression = require("compression");

// Load environment variables
dotenv.config();

// Import database connection
const { connectDB, isConnected } = require("./config/database");

// Import services
const emailService = require("./services/emailService");
const notificationService = require("./services/notificationService");

// Import routes
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const submissionRoutes = require("./routes/submissions");
const competitionRoutes = require("./routes/competitions");
const competitionRoundRoutes = require("./routes/competitionRounds");
const evaluationRoutes = require("./routes/evaluations");
const quotaRoutes = require("./routes/quotas");
const tieBreakingRoutes = require("./routes/tieBreaking");
const systemLogRoutes = require("./routes/systemLogs");
const landingPageRoutes = require("./routes/landingPage");
const uploadRoutes = require("./routes/uploads");
const notificationRoutes = require("./routes/notifications");
const leaderboardRoutes = require("./routes/leaderboard");
const { generalLimiter } = require("./middleware/rateLimiter");

const app = express();

// Trust proxy - needed for Render and other reverse proxies
// Set to 1 to trust only the first proxy (hosting provider) - prevents IP spoofing
app.set("trust proxy", 1);

// Middleware
// CORS configuration
const allowedOrigins = [];
if (process.env.CLIENT_URL) {
  allowedOrigins.push(process.env.CLIENT_URL);
}
// Allow localhost in development
if (process.env.NODE_ENV === "development") {
  allowedOrigins.push(/^http:\/\/localhost:\d+$/);
  allowedOrigins.push(/^http:\/\/127\.0\.0\.1:\d+$/);
}

// Logger
app.use((req, res, next) => {
  if (process.env.NODE_ENV === "development") {
    console.log(`${req.method} ${req.url} - IP: ${req.ip}`);
  }
  next();
});
app.use(
  morgan(
    process.env.NODE_ENV === "development" ? "dev" : "combined"
  )
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Compression middleware - compress responses > 1KB, skip health checks
app.use(compression({
  filter: (req, res) => {
    // Skip compression for health checks
    if (req.path === '/api/health') {
      return false;
    }
    // Use default compression filter (compresses if response size > 1KB)
    return compression.filter(req, res);
  }
}));

// Initialize email service
emailService.initialize();

// Test email connection (silent in production, verbose in development)
emailService.testConnection().catch((error) => {
  console.error("Email service connection test error:", error.message);
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/submissions", submissionRoutes);
app.use("/api/competitions", competitionRoutes);
app.use("/api/competition-rounds", competitionRoundRoutes);
app.use("/api/evaluations", evaluationRoutes);
app.use("/api/quotas", quotaRoutes);
app.use("/api/tie-breaking", tieBreakingRoutes);
app.use("/api/system-logs", systemLogRoutes);
app.use("/api/landing-page", landingPageRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/leaderboard", leaderboardRoutes);

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    message: "TSCS Backend API is running",
    timestamp: new Date().toISOString(),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Error:", err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal Server Error",
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
});

const PORT = process.env.PORT || 5000;

// Start server after MongoDB connection
const startServer = async () => {
  try {
    // Connect to MongoDB first
    await connectDB();

    // Start round scheduler only after connection is established
    const { startScheduler } = require("./utils/roundScheduler");
    startScheduler();

    // Start HTTP server
    app.listen(PORT, () => {
      if (process.env.NODE_ENV === "development") {
        console.log(
          `Server running on port ${PORT} (${
            process.env.NODE_ENV || "development"
          })`
        );
      }
    });
  } catch (error) {
    console.error("Failed to start server:", error.message);
    // Retry connection after 5 seconds
    setTimeout(() => {
      console.log("Retrying MongoDB connection...");
      startServer();
    }, 5000);
  }
};

// Start the server
startServer();
