const mongoose = require('mongoose');
const User = require('./models/User');
require('dotenv').config();

// Superadmin credentials
const superadminData = {
  username: 'hassanwaziri@tie.go.tz',
  password: 'mimiadminwatie',
  name: 'Hassan Waziri',
  email: 'hassanwaziri@tie.go.tz',
  role: 'superadmin',
  status: 'active',
  phone: '+255712345900',
  permissions: ['all']
};

async function createSuperadmin() {
  try {
    console.log('🔄 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/tscs');

    console.log('✅ Connected to MongoDB');

    // Check if superadmin already exists
    const existingUser = await User.findOne({ username: superadminData.username });
    if (existingUser) {
      console.log('⚠️  Superadmin already exists:', existingUser.username);
      process.exit(0);
    }

    // Create new superadmin user
    const superadmin = new User(superadminData);
    await superadmin.save();

    console.log('✅ Superadmin created successfully!');
    console.log('👤 Username:', superadminData.username);
    console.log('🔑 Password:', superadminData.password);
    console.log('📧 Email:', superadminData.email);
    console.log('👑 Role: superadmin');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating superadmin:', error.message);
    process.exit(1);
  }
}

createSuperadmin();
