require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tscs';

const isTargetIndex = (index, field) => {
  if (!index || !index.key) return false;
  const keys = Object.keys(index.key);
  return keys.length === 1 && keys[0] === field && index.key[field] === 1;
};

const hasActiveOnlyPartialFilter = (index) =>
  index?.partialFilterExpression &&
  index.partialFilterExpression.isDeleted === false;

async function migrateFieldIndex(collection, field, targetName) {
  const indexes = await collection.indexes();
  const matchingIndexes = indexes.filter((index) => isTargetIndex(index, field) && index.unique);

  for (const index of matchingIndexes) {
    if (hasActiveOnlyPartialFilter(index)) {
      continue;
    }
    console.log(`[user-index-migrate] Dropping legacy index ${index.name}`);
    await collection.dropIndex(index.name);
  }

  console.log(`[user-index-migrate] Ensuring ${targetName}`);
  await collection.createIndex(
    { [field]: 1 },
    {
      name: targetName,
      unique: true,
      partialFilterExpression: { isDeleted: false }
    }
  );
}

async function run() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('[user-index-migrate] Connected');

    const collection = User.collection;
    await migrateFieldIndex(collection, 'email', 'email_active_unique');
    await migrateFieldIndex(collection, 'username', 'username_active_unique');

    console.log('[user-index-migrate] Done');
  } catch (error) {
    console.error('[user-index-migrate] Failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

run();
