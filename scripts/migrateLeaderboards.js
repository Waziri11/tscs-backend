/**
 * Migration script to populate Leaderboard collection from existing submissions data
 * 
 * This script:
 * 1. Groups submissions by year, areaOfFocus, level, and location
 * 2. Calculates rankings for each group
 * 3. Creates Leaderboard documents
 * 4. Sets isFinalized: true for closed rounds
 * 
 * Usage: node scripts/migrateLeaderboards.js [--dry-run]
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Submission = require('../models/Submission');
const Leaderboard = require('../models/Leaderboard');
const CompetitionRound = require('../models/CompetitionRound');
const Quota = require('../models/Quota');
const { calculateAndUpdateLeaderboard, generateLocationKey } = require('../utils/leaderboardUtils');

const DRY_RUN = process.argv.includes('--dry-run');

async function migrateLeaderboards() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/tscs';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    if (DRY_RUN) {
      console.log('🔍 DRY RUN MODE - No changes will be saved');
    }

    // Get all unique year/areaOfFocus/level combinations from submissions
    const submissions = await Submission.aggregate([
      {
        $match: {
          status: { $in: ['submitted', 'evaluated', 'promoted', 'eliminated'] },
          disqualified: { $ne: true }
        }
      },
      {
        $group: {
          _id: {
            year: '$year',
            areaOfFocus: '$areaOfFocus',
            level: '$level'
          }
        }
      }
    ]);

    console.log(`Found ${submissions.length} unique year/areaOfFocus/level combinations`);

    let totalCreated = 0;
    let totalUpdated = 0;
    let totalErrors = 0;

    // Process each combination
    for (const group of submissions) {
      const { year, areaOfFocus, level } = group._id;

      if (!year || !areaOfFocus || !level) {
        console.warn(`Skipping incomplete group:`, group._id);
        continue;
      }

      console.log(`\nProcessing: Year ${year}, Area: ${areaOfFocus}, Level: ${level}`);

      // Get all submissions for this combination
      const groupSubmissions = await Submission.find({
        year: parseInt(year),
        areaOfFocus,
        level,
        status: { $in: ['submitted', 'evaluated', 'promoted', 'eliminated'] },
        disqualified: { $ne: true }
      }).populate('teacherId', 'name email');

      if (groupSubmissions.length === 0) {
        console.log(`  No submissions found, skipping`);
        continue;
      }

      // Group by location
      const locationGroups = {};
      groupSubmissions.forEach(sub => {
        const locationKey = generateLocationKey(level, sub.region, sub.council);
        if (!locationGroups[locationKey]) {
          locationGroups[locationKey] = [];
        }
        locationGroups[locationKey].push(sub);
      });

      console.log(`  Found ${Object.keys(locationGroups).length} location(s)`);

      // Process each location
      for (const [locationKey, locationSubs] of Object.entries(locationGroups)) {
        try {
          console.log(`    Processing location: ${locationKey} (${locationSubs.length} submissions)`);

          if (DRY_RUN) {
            console.log(`    [DRY RUN] Would create/update leaderboard for ${locationKey}`);
            totalCreated++;
            continue;
          }

          // Calculate and update leaderboard
          const leaderboard = await calculateAndUpdateLeaderboard(
            parseInt(year),
            areaOfFocus,
            level,
            locationKey,
            {
              region: locationSubs[0].region,
              council: locationSubs[0].council
            }
          );

          // Check if round is closed for this year/level/location
          const roundQuery = {
            year: parseInt(year),
            level,
            status: 'closed'
          };

          if (level === 'Council' && locationSubs[0].region && locationSubs[0].council) {
            roundQuery.region = locationSubs[0].region;
            roundQuery.council = locationSubs[0].council;
          } else if (level === 'Regional' && locationSubs[0].region) {
            roundQuery.region = locationSubs[0].region;
          }

          const closedRound = await CompetitionRound.findOne(roundQuery);

          if (closedRound) {
            // Finalize leaderboard if round is closed
            leaderboard.isFinalized = true;
            await leaderboard.save();
            console.log(`      ✓ Leaderboard finalized (round closed)`);
          }

          if (leaderboard.isNew) {
            totalCreated++;
            console.log(`      ✓ Created leaderboard with ${leaderboard.entries.length} entries`);
          } else {
            totalUpdated++;
            console.log(`      ✓ Updated leaderboard with ${leaderboard.entries.length} entries`);
          }
        } catch (error) {
          totalErrors++;
          console.error(`      ✗ Error processing location ${locationKey}:`, error.message);
        }
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('Migration Summary:');
    console.log(`  Created: ${totalCreated}`);
    console.log(`  Updated: ${totalUpdated}`);
    console.log(`  Errors: ${totalErrors}`);
    console.log('='.repeat(60));

    if (!DRY_RUN) {
      console.log('\n✅ Migration completed successfully!');
    } else {
      console.log('\n✅ Dry run completed. Run without --dry-run to apply changes.');
    }

  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

// Run migration
migrateLeaderboards();
