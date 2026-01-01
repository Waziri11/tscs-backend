const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/tscs';
    
    // Warn if using default localhost URI
    if (!process.env.MONGODB_URI) {
      console.warn('⚠️  MONGODB_URI not set in .env, using default localhost connection');
      console.warn('   For MongoDB Atlas, set MONGODB_URI in your .env file');
    }
    
    const conn = await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    if (error.message.includes('authentication')) {
      console.error('💡 Tip: Check your Atlas username, password, and database user permissions');
    }
    if (error.message.includes('ENOTFOUND')) {
      console.error('💡 Tip: Verify your Atlas cluster connection string and network access');
    }
    process.exit(1);
  }
};

module.exports = connectDB;

