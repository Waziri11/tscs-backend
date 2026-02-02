const bcrypt = require('bcryptjs');
const EmailOTP = require('../models/EmailOTP');
const User = require('../models/User');

/**
 * OTP Service
 *
 * Handles OTP generation, hashing, verification, and management
 * - Generates 6-digit numeric OTPs
 * - Hashes OTPs for secure storage
 * - Manages OTP expiration (10 minutes)
 * - Handles verification attempts (max 5)
 * - Manages resend logic (60s cooldown, max 5/hour)
 */
class OTPService {
  /**
   * Generate a 6-digit numeric OTP
   * @returns {string} 6-digit OTP
   */
  static generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  /**
   * Hash an OTP using bcrypt
   * @param {string} otp - Plain text OTP
   * @returns {Promise<string>} Hashed OTP
   */
  static async hashOTP(otp) {
    const saltRounds = 12; // Strong hashing for security
    return await bcrypt.hash(otp, saltRounds);
  }

  /**
   * Verify OTP by comparing with stored hash
   * @param {string} plainOTP - Plain text OTP from user
   * @param {string} hashedOTP - Stored hashed OTP
   * @returns {Promise<boolean>} True if OTP matches
   */
  static async verifyOTP(plainOTP, hashedOTP) {
    try {
      return await bcrypt.compare(plainOTP, hashedOTP);
    } catch (error) {
      console.error('OTP verification error:', error);
      return false;
    }
  }

  /**
   * Create and store a new OTP for email verification
   * @param {string} email - User email
   * @returns {Promise<{success: boolean, otp?: string, error?: string}>}
   */
  static async createOTP(email) {
    try {
      const normalizedEmail = email.toLowerCase();

      // Check if user exists and is not already verified
      const user = await User.findOne({ email: normalizedEmail });
      if (!user) {
        return { success: false, error: 'User not found' };
      }

      if (user.emailVerified) {
        return { success: false, error: 'Email already verified' };
      }

      // Invalidate any existing OTPs for this email
      await EmailOTP.invalidateOTPs(normalizedEmail);

      // Generate new OTP
      const otp = this.generateOTP();
      const otpHash = await this.hashOTP(otp);

      // Create new OTP record (expires in 10 minutes)
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await EmailOTP.create({
        email: normalizedEmail,
        otpHash,
        expiresAt,
        attempts: 0,
        resendCount: 0
      });

      return { success: true, otp };
    } catch (error) {
      console.error('Create OTP error:', error);
      return { success: false, error: 'Failed to create OTP' };
    }
  }

  /**
   * Create and store a new OTP for password reset
   * @param {string} email - User email
   * @returns {Promise<{success: boolean, otp?: string, error?: string}>}
   */
  static async createPasswordResetOTP(email) {
    try {
      const normalizedEmail = email.toLowerCase();

      // Check if user exists and is active
      const user = await User.findOne({ email: normalizedEmail });
      if (!user) {
        return { success: false, error: 'User not found' };
      }

      if (user.status !== 'active') {
        return { success: false, error: 'User account is not active' };
      }

      // Invalidate any existing OTPs for this email
      await EmailOTP.invalidateOTPs(normalizedEmail);

      // Generate new OTP
      const otp = this.generateOTP();
      const otpHash = await this.hashOTP(otp);

      // Create new OTP record (expires in 10 minutes)
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await EmailOTP.create({
        email: normalizedEmail,
        otpHash,
        expiresAt,
        attempts: 0,
        resendCount: 0
      });

      return { success: true, otp };
    } catch (error) {
      console.error('Create password reset OTP error:', error);
      return { success: false, error: 'Failed to create password reset OTP' };
    }
  }

  /**
   * Create and store a new OTP for email change verification
   * This is sent to the NEW email address the user wants to change to
   * @param {string} newEmail - New email address to verify
   * @returns {Promise<{success: boolean, otp?: string, error?: string}>}
   */
  static async createEmailChangeOTP(newEmail) {
    try {
      const normalizedEmail = newEmail.toLowerCase();

      // Check if this email is already taken by another user
      const existingUser = await User.findOne({ email: normalizedEmail });
      if (existingUser) {
        return { success: false, error: 'This email is already registered to another account' };
      }

      // Invalidate any existing OTPs for this email
      await EmailOTP.invalidateOTPs(normalizedEmail);

      // Generate new OTP
      const otp = this.generateOTP();
      const otpHash = await this.hashOTP(otp);

      // Create new OTP record (expires in 10 minutes)
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await EmailOTP.create({
        email: normalizedEmail,
        otpHash,
        expiresAt,
        attempts: 0,
        resendCount: 0
      });

      return { success: true, otp };
    } catch (error) {
      console.error('Create email change OTP error:', error);
      return { success: false, error: 'Failed to create verification code' };
    }
  }

  /**
   * Verify OTP for email change (does not update user, just validates OTP)
   * @param {string} email - Email address the OTP was sent to
   * @param {string} otp - OTP to verify
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  static async verifyEmailChangeOTP(email, otp) {
    try {
      const normalizedEmail = email.toLowerCase();

      // Find active OTP
      const otpRecord = await EmailOTP.findActiveOTP(normalizedEmail);

      if (!otpRecord) {
        return { success: false, error: 'Invalid or expired verification code' };
      }

      // Check attempt limit
      if (otpRecord.attempts >= 5) {
        await EmailOTP.invalidateOTPs(normalizedEmail);
        return { success: false, error: 'Too many verification attempts. Please request a new code.' };
      }

      // Increment attempts
      otpRecord.attempts += 1;
      await otpRecord.save();

      // Verify OTP
      const isValid = await this.verifyOTP(otp, otpRecord.otpHash);

      if (!isValid) {
        if (otpRecord.attempts >= 5) {
          await EmailOTP.invalidateOTPs(normalizedEmail);
          return { success: false, error: 'Too many verification attempts. Please request a new code.' };
        }
        return { success: false, error: 'Invalid verification code' };
      }

      // OTP is valid - clean up
      await EmailOTP.invalidateOTPs(normalizedEmail);

      return { success: true };
    } catch (error) {
      console.error('Verify email change OTP error:', error);
      return { success: false, error: 'Verification failed' };
    }
  }

  /**
   * Verify OTP and update user verification status
   * @param {string} email - User email
   * @param {string} otp - OTP to verify
   * @returns {Promise<{success: boolean, error?: string, user?: object}>}
   */
  static async verifyOTPAndUpdate(email, otp) {
    try {
      const normalizedEmail = email.toLowerCase();

      // Find active OTP
      const otpRecord = await EmailOTP.findActiveOTP(normalizedEmail);

      if (!otpRecord) {
        return { success: false, error: 'Invalid or expired verification code' };
      }

      // Check attempt limit
      if (otpRecord.attempts >= 5) {
        await EmailOTP.invalidateOTPs(normalizedEmail);
        return { success: false, error: 'Too many verification attempts. Please request a new code.' };
      }

      // Increment attempts
      otpRecord.attempts += 1;
      await otpRecord.save();

      // Verify OTP
      const isValid = await this.verifyOTP(otp, otpRecord.otpHash);

      if (!isValid) {
        if (otpRecord.attempts >= 5) {
          await EmailOTP.invalidateOTPs(normalizedEmail);
          return { success: false, error: 'Too many verification attempts. Please request a new code.' };
        }
        return { success: false, error: 'Invalid verification code' };
      }

      // OTP is valid - update user verification status
      const user = await User.findOneAndUpdate(
        { email: normalizedEmail },
        { emailVerified: true },
        { new: true }
      ).select('-password');

      if (!user) {
        return { success: false, error: 'User not found' };
      }

      // Clean up used OTP
      await EmailOTP.invalidateOTPs(normalizedEmail);

      return {
        success: true,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          emailVerified: user.emailVerified,
          role: user.role
        }
      };
    } catch (error) {
      console.error('Verify OTP error:', error);
      return { success: false, error: 'Verification failed' };
    }
  }

  /**
   * Resend OTP with rate limiting
   * @param {string} email - User email
   * @returns {Promise<{success: boolean, otp?: string, error?: string, cooldownRemaining?: number}>}
   */
  static async resendOTP(email) {
    try {
      const normalizedEmail = email.toLowerCase();

      // Check if user exists and needs verification
      const user = await User.findOne({ email: normalizedEmail });
      if (!user) {
        return { success: false, error: 'User not found' };
      }

      if (user.emailVerified) {
        return { success: false, error: 'Email already verified' };
      }

      // Find existing OTP record
      const existingOTP = await EmailOTP.findActiveOTP(normalizedEmail);

      if (!existingOTP) {
        // No active OTP, create new one
        return await this.createOTP(normalizedEmail);
      }

      // Check 60-second cooldown
      if (!existingOTP.canResend()) {
        const cooldownRemaining = Math.ceil(
          (60 * 1000 - (Date.now() - existingOTP.lastResendAt.getTime())) / 1000
        );
        return {
          success: false,
          error: `Please wait ${cooldownRemaining} seconds before requesting another code`,
          cooldownRemaining
        };
      }

      // Check hourly resend limit (5 per hour)
      if (!existingOTP.canResendHourly()) {
        return {
          success: false,
          error: 'Too many resend requests. Please try again later.'
        };
      }

      // Generate new OTP and update existing record
      const otp = this.generateOTP();
      const otpHash = await this.hashOTP(otp);

      // Update existing record
      existingOTP.otpHash = otpHash;
      existingOTP.expiresAt = new Date(Date.now() + 10 * 60 * 1000); // Reset expiration
      existingOTP.attempts = 0; // Reset attempts
      await existingOTP.incrementResend();

      return { success: true, otp };
    } catch (error) {
      console.error('Resend OTP error:', error);
      return { success: false, error: 'Failed to resend verification code' };
    }
  }
}

module.exports = OTPService;