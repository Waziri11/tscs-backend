require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Submission = require('../models/Submission');

const APPLY = process.argv.includes('--apply');
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tscs';

async function run() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log(`[backfill-soft-delete] Connected (${APPLY ? 'apply' : 'dry-run'})`);

    const [usersTotal, submissionsTotal, usersMissing, submissionsMissing] = await Promise.all([
      User.countDocuments({}),
      Submission.countDocuments({}),
      User.countDocuments({ isDeleted: { $exists: false } }),
      Submission.countDocuments({ isDeleted: { $exists: false } }),
    ]);

    console.log(JSON.stringify({
      phase: 'precheck',
      users: {
        total: usersTotal,
        missingIsDeleted: usersMissing,
      },
      submissions: {
        total: submissionsTotal,
        missingIsDeleted: submissionsMissing,
      },
    }, null, 2));

    if (APPLY) {
      const [usersUpdate, submissionsUpdate] = await Promise.all([
        User.updateMany(
          { isDeleted: { $exists: false } },
          { $set: { isDeleted: false } }
        ),
        Submission.updateMany(
          { isDeleted: { $exists: false } },
          { $set: { isDeleted: false } }
        ),
      ]);

      const [usersMissingAfter, submissionsMissingAfter, usersVisible, submissionsVisible] = await Promise.all([
        User.countDocuments({ isDeleted: { $exists: false } }),
        Submission.countDocuments({ isDeleted: { $exists: false } }),
        User.countDocuments({ isDeleted: false }),
        Submission.countDocuments({ isDeleted: false }),
      ]);

      console.log(JSON.stringify({
        phase: 'apply',
        updated: {
          usersModified: usersUpdate.modifiedCount,
          submissionsModified: submissionsUpdate.modifiedCount,
        },
        postcheck: {
          usersMissingIsDeleted: usersMissingAfter,
          submissionsMissingIsDeleted: submissionsMissingAfter,
          usersWithIsDeletedFalse: usersVisible,
          submissionsWithIsDeletedFalse: submissionsVisible,
        },
      }, null, 2));
    }

    console.log('[backfill-soft-delete] Done');
  } catch (error) {
    console.error('[backfill-soft-delete] Failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

run();
