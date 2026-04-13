const mongoose = require('mongoose');
const User = require('../models/User');
require('dotenv').config();

// Superadmin credentials from environment
const superadminData = {
  username: process.env.SUPERADMIN_EMAIL,
  password: process.env.SUPERADMIN_PASSWORD,
  name: process.env.SUPERADMIN_NAME || 'Super Admin',
  email: process.env.SUPERADMIN_EMAIL,
  role: 'superadmin',
  status: 'active',
  phone: process.env.SUPERADMIN_PHONE || '',
  permissions: ['all'],
  emailVerified: true
};

if (!superadminData.username || !superadminData.password) {
  console.error('❌ Missing SUPERADMIN_EMAIL or SUPERADMIN_PASSWORD in .env');
  process.exit(1);
}

async function createSuperadmin() {
  try {
    console.log('🔄 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/tscs');

    console.log('✅ Connected to MongoDB');

    // Remove existing superadmin(s)
    const deleteResult = await User.deleteMany({ role: 'superadmin' });
    if (deleteResult.deletedCount > 0) {
      console.log('🗑️  Removed existing superadmin(s):', deleteResult.deletedCount);
    }

    // Create new superadmin user
    const superadmin = new User(superadminData);
    await superadmin.save();

    console.log('✅ Superadmin created successfully!');
    console.log('👤 Username:', superadminData.username);
    console.log('📧 Email:', superadminData.email);
    console.log('👑 Role: superadmin');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating superadmin:', error.message);
    process.exit(1);
  }
}

createSuperadmin();
