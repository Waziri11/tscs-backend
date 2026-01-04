const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * PasswordReset Model
 *
 * Manages password reset tokens for forgot password functionality
 * - Stores hashed reset tokens for security
 * - Tokens expire after 15 minutes
 * - One active token per user at a time
 * - Auto-deletes expired tokens
 */
const passwordResetSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    index: true
  },
  resetToken: {
    type: String,
    required: true
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 } // Auto-delete expired documents
  },
  used: {
    type: Boolean,
    default: false,
    index: true
  },
  usedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Compound index to ensure one active token per user
passwordResetSchema.index({ userId: 1, used: 1 }, { unique: true });
passwordResetSchema.index({ email: 1, used: 1 });

// Pre-save middleware to clean up expired tokens
passwordResetSchema.pre('save', async function(next) {
  if (this.isNew) {
    // Clean up expired tokens for this user before creating new one
    const PasswordReset = mongoose.model('PasswordReset');
    await PasswordReset.deleteMany({
      userId: this.userId,
      expiresAt: { $lt: new Date() }
    }).exec().catch(err => {
      // Silently fail - don't log errors about cleanup
    });
  }
  next();
});

// Method to check if token is expired
passwordResetSchema.methods.isExpired = function() {
  return new Date() > this.expiresAt;
};

// Method to check if token is valid
passwordResetSchema.methods.isValid = function() {
  return !this.used && !this.isExpired();
};

// Method to mark token as used
passwordResetSchema.methods.markUsed = function() {
  this.used = true;
  this.usedAt = new Date();
  return this.save();
};

// Static method to generate a secure reset token
passwordResetSchema.statics.generateResetToken = function() {
  return crypto.randomBytes(32).toString('hex');
};

// Static method to hash reset token
passwordResetSchema.statics.hashResetToken = function(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
};

// Static method to find valid reset token
passwordResetSchema.statics.findValidToken = function(hashedToken) {
  return this.findOne({
    resetToken: hashedToken,
    used: false,
    expiresAt: { $gt: new Date() }
  }).populate('userId');
};

// Static method to invalidate all tokens for a user
passwordResetSchema.statics.invalidateUserTokens = function(userId) {
  return this.updateMany(
    { userId, used: false },
    {
      used: true,
      usedAt: new Date()
    }
  );
};

// Static method to clean up expired tokens
passwordResetSchema.statics.cleanupExpired = function() {
  return this.deleteMany({
    expiresAt: { $lt: new Date() }
  });
};

module.exports = mongoose.model('PasswordReset', passwordResetSchema);
