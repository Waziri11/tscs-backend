const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/tscs';
    
    if (!process.env.MONGODB_URI) {
      console.warn('MONGODB_URI not set, using default localhost connection');
    }
    
    // Configure Mongoose connection options
    const mongooseOptions = {
      // Disable buffering - throw errors immediately if not connected
      bufferCommands: false,
      bufferMaxEntries: 0,
      // Connection timeout
      serverSelectionTimeoutMS: 30000, // 30 seconds
      socketTimeoutMS: 45000, // 45 seconds
      // Retry configuration
      retryWrites: true,
      // Connection pool settings
      maxPoolSize: 10,
      minPoolSize: 2,
      // Keep connection alive
      keepAlive: true,
      keepAliveInitialDelay: 300000, // 5 minutes
    };
    
    const conn = await mongoose.connect(mongoUri, mongooseOptions);

    if (process.env.NODE_ENV === 'development') {
      console.log(`MongoDB Connected: ${conn.connection.host}`);
    }

    // Handle connection events
    mongoose.connection.on('error', (err) => {
      console.error(`MongoDB Connection Error: ${err.message}`);
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('MongoDB disconnected. Attempting to reconnect...');
    });

    mongoose.connection.on('reconnected', () => {
      console.log('MongoDB reconnected successfully');
    });

    return conn;
  } catch (error) {
    console.error(`MongoDB Connection Error: ${error.message}`);
    // Don't exit immediately - allow retry logic
    throw error;
  }
};

// Helper function to check if MongoDB is connected
const isConnected = () => {
  return mongoose.connection.readyState === 1; // 1 = connected
};

module.exports = { connectDB, isConnected };

