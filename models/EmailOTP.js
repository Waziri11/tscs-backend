const mongoose = require('mongoose');

/**
 * EmailOTP Model
 *
 * Manages OTP verification for email verification
 * - Stores hashed OTPs for security
 * - Only one active OTP per email at a time
 * - OTP expires after 10 minutes
 * - Max 5 verification attempts per OTP
 */
const emailOTPSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    index: true // For faster lookups
  },
  otpHash: {
    type: String,
    required: true
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 } // Auto-delete expired documents
  },
  attempts: {
    type: Number,
    default: 0,
    max: 5 // Max verification attempts
  },
  // Track resend attempts for rate limiting
  resendCount: {
    type: Number,
    default: 0,
    max: 5 // Max resends per hour
  },
  lastResendAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Compound index to ensure only one active OTP per email
emailOTPSchema.index({ email: 1, expiresAt: -1 }, { unique: true });

// Remove expired OTPs automatically
emailOTPSchema.pre('save', function(next) {
  // Clean up expired OTPs for this email before saving new one
  if (this.isNew) {
    const EmailOTP = mongoose.model('EmailOTP');
    EmailOTP.deleteMany({
      email: this.email,
      expiresAt: { $lt: new Date() }
    }).exec().catch(err => {
      console.warn('Failed to cleanup expired OTPs:', err.message);
    });
  }
  next();
});

// Method to check if OTP can be resent (60 second cooldown)
emailOTPSchema.methods.canResend = function() {
  if (!this.lastResendAt) return true;
  const cooldownPeriod = 60 * 1000; // 60 seconds
  return (Date.now() - this.lastResendAt.getTime()) > cooldownPeriod;
};

// Method to check if max resend attempts reached (5 per hour)
emailOTPSchema.methods.canResendHourly = function() {
  if (this.resendCount < 5) return true;

  // Check if it's been more than an hour since first resend
  if (!this.lastResendAt) return true;
  const oneHour = 60 * 60 * 1000; // 1 hour
  return (Date.now() - this.lastResendAt.getTime()) > oneHour;
};

// Method to increment resend count
emailOTPSchema.methods.incrementResend = function() {
  this.resendCount += 1;
  this.lastResendAt = new Date();
  return this.save();
};

// Static method to find active OTP for email
emailOTPSchema.statics.findActiveOTP = function(email) {
  return this.findOne({
    email: email.toLowerCase(),
    expiresAt: { $gt: new Date() }
  });
};

// Static method to invalidate all OTPs for email
emailOTPSchema.statics.invalidateOTPs = function(email) {
  return this.deleteMany({
    email: email.toLowerCase()
  });
};

module.exports = mongoose.model('EmailOTP', emailOTPSchema);