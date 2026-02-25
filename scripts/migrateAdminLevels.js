/**
 * Migration script for admin levels and location.
 * - Finds admins missing adminLevel
 * - Assigns adminLevel: 'National' to the first admin (only one National slot)
 * - Other existing admins are left without adminLevel - superadmin must reassign manually
 * - Prints warnings for manual review
 *
 * Run: node scripts/migrateAdminLevels.js
 * Requires: MongoDB connection (dotenv or MONGO_URI)
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

async function migrateAdminLevels() {
  try {
    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const adminsWithoutLevel = await User.find({
      role: 'admin',
      $or: [
        { adminLevel: null },
        { adminLevel: { $exists: false } }
      ]
    }).sort({ createdAt: 1 });

    if (adminsWithoutLevel.length === 0) {
      console.log('No admins found without adminLevel. Migration not needed.');
      return;
    }

    console.log(`Found ${adminsWithoutLevel.length} admin(s) without adminLevel.`);

    // Check if National slot is already taken
    const existingNational = await User.findOne({
      role: 'admin',
      adminLevel: 'National'
    });

    if (existingNational) {
      console.log('National admin slot already occupied. Remaining admins need manual assignment.');
      for (const admin of adminsWithoutLevel) {
        console.warn(`  - ${admin.email} (${admin.name}): adminLevel is null. Superadmin must assign level/region/council via Users UI.`);
      }
      return;
    }

    // Assign first admin to National
    const firstAdmin = adminsWithoutLevel[0];
    await User.findByIdAndUpdate(firstAdmin._id, {
      adminLevel: 'National',
      adminRegion: null,
      adminCouncil: null
    });
    console.log(`Assigned ${firstAdmin.email} (${firstAdmin.name}) as National admin.`);

    if (adminsWithoutLevel.length > 1) {
      console.warn('');
      console.warn('WARNING: The following admins have NOT been assigned a level (only one National slot exists):');
      for (let i = 1; i < adminsWithoutLevel.length; i++) {
        const admin = adminsWithoutLevel[i];
        console.warn(`  - ${admin.email} (${admin.name}): Superadmin must assign adminLevel (Council/Regional/National) and location via Users UI.`);
      }
      console.warn('Until assigned, these admins will have restricted access.');
    }

    console.log('');
    console.log('Migration complete.');
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
    process.exit(0);
  }
}

migrateAdminLevels();
