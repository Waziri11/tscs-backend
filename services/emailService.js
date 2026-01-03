const nodemailer = require('nodemailer');
const EmailLog = require('../models/EmailLog');

/**
 * Email Service
 *
 * Handles email sending using Gmail SMTP with Nodemailer
 * - Asynchronous, non-blocking email sending
 * - Comprehensive email logging
 * - Template support
 * - Error handling and retries
 */
class EmailService {
  constructor() {
    this.transporter = null;
    this.isInitialized = false;
  }

  /**
   * Initialize email transporter with Gmail SMTP
   */
  initialize() {
    if (this.isInitialized) return;

    try {
      this.transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.GMAIL_USER,
          pass: process.env.GMAIL_APP_PASSWORD // App-specific password, not regular password
        },
        // Security settings
        secure: true, // Use SSL
        tls: {
          rejectUnauthorized: false // For development only
        }
      });

      this.isInitialized = true;
      console.log('✅ Email service initialized with Gmail SMTP');
    } catch (error) {
      console.error('❌ Email service initialization failed:', error.message);
      this.isInitialized = false;
    }
  }

  /**
   * Send email asynchronously
   * @param {Object} options - Email options
   * @param {string} options.to - Recipient email
   * @param {string} options.subject - Email subject
   * @param {string} options.html - HTML content
   * @param {string} options.text - Plain text fallback
   * @param {string} options.type - Email type for logging
   * @param {Object} options.metadata - Additional metadata
   * @returns {Promise<boolean>} Success status
   */
  async sendEmail(options) {
    if (!this.isInitialized) {
      this.initialize();
    }

    if (!this.transporter) {
      console.error('Email transporter not available');
      return false;
    }

    // Create log entry first
    const logEntry = await EmailLog.logEmail({
      email: options.to,
      type: options.type || 'system_notification',
      subject: options.subject,
      status: 'pending',
      metadata: options.metadata || {}
    });

    try {
      const mailOptions = {
        from: `"TSCS" <${process.env.GMAIL_USER}>`,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text
      };

      // Send email
      const info = await this.transporter.sendMail(mailOptions);

      // Update log on success
      if (logEntry) {
        await EmailLog.updateStatus(logEntry._id, 'sent', null, info.response);
      }

      console.log(`📧 Email sent successfully to ${options.to}: ${info.messageId}`);
      return true;

    } catch (error) {
      // Update log on failure
      if (logEntry) {
        await EmailLog.updateStatus(logEntry._id, 'failed', error.message);
      }

      console.error(`❌ Email sending failed to ${options.to}:`, error.message);
      return false;
    }
  }

  /**
   * Send OTP verification email
   * @param {string} email - Recipient email
   * @param {string} otp - OTP code
   * @param {string} userName - User name
   * @returns {Promise<boolean>} Success status
   */
  async sendOTPVerification(email, otp, userName) {
    const subject = 'Verify Your TSCS Account';
    const html = this.generateOTPHTML(otp, userName);
    const text = this.generateOTPText(otp, userName);

    return await this.sendEmail({
      to: email,
      subject,
      html,
      text,
      type: 'email_verification_otp'
    });
  }

  /**
   * Send password reset OTP email
   * @param {string} email - Recipient email
   * @param {string} otp - OTP code
   * @param {string} userName - User name
   * @returns {Promise<boolean>} Success status
   */
  async sendPasswordResetOTP(email, otp, userName) {
    const subject = 'Password Reset - TSCS';
    const html = this.generatePasswordResetOTPHTML(otp, userName);
    const text = this.generatePasswordResetOTPText(otp, userName);

    return await this.sendEmail({
      to: email,
      subject,
      html,
      text,
      type: 'password_reset_otp'
    });
  }

  /**
   * Send system notification email
   * @param {string} email - Recipient email
   * @param {string} subject - Email subject
   * @param {string} message - Notification message
   * @param {string} userName - User name
   * @param {Object} metadata - Additional metadata
   * @returns {Promise<boolean>} Success status
   */
  async sendSystemNotification(email, subject, message, userName, metadata = {}) {
    const html = this.generateSystemNotificationHTML(message, userName, metadata);
    const text = this.generateSystemNotificationText(message, userName, metadata);

    return await this.sendEmail({
      to: email,
      subject,
      html,
      text,
      type: 'system_notification',
      metadata
    });
  }

  /**
   * Send submission successful email (Teacher)
   * @param {string} email - Recipient email
   * @param {string} userName - User name
   * @param {Object} metadata - Submission metadata
   * @returns {Promise<boolean>} Success status
   */
  async sendSubmissionSuccessfulEmail(email, userName, metadata) {
    const { roundName, subject, submissionId } = metadata;
    const subjectLine = `Submission Received - ${roundName}`;
    const html = this.generateSubmissionSuccessfulHTML(userName, metadata);
    const text = this.generateSubmissionSuccessfulText(userName, metadata);

    return await this.sendEmail({
      to: email,
      subject: subjectLine,
      html,
      text,
      type: 'submission_successful',
      metadata: { submissionId, roundName, subject }
    });
  }

  /**
   * Send submission result email (Teacher)
   * @param {string} email - Recipient email
   * @param {string} userName - User name
   * @param {string} result - 'promoted' or 'eliminated'
   * @param {Object} metadata - Submission metadata
   * @returns {Promise<boolean>} Success status
   */
  async sendSubmissionResultEmail(email, userName, result, metadata) {
    const { roundName, nextRound } = metadata;
    const subjectLine = result === 'promoted'
      ? `Congratulations! Submission Promoted - ${roundName}`
      : `Submission Results - ${roundName}`;

    const html = this.generateSubmissionResultHTML(userName, result, metadata);
    const text = this.generateSubmissionResultText(userName, result, metadata);

    return await this.sendEmail({
      to: email,
      subject: subjectLine,
      html,
      text,
      type: `submission_${result}`,
      metadata: { roundName, result, nextRound }
    });
  }

  /**
   * Send evaluation reminder email (Judge)
   * @param {string} email - Recipient email
   * @param {string} userName - User name
   * @param {Object} metadata - Evaluation metadata
   * @returns {Promise<boolean>} Success status
   */
  async sendEvaluationReminderEmail(email, userName, metadata) {
    const { roundName, deadline, hoursLeft } = metadata;
    const subjectLine = `Evaluation Reminder - ${hoursLeft} Hours Remaining`;
    const html = this.generateEvaluationReminderHTML(userName, metadata);
    const text = this.generateEvaluationReminderText(userName, metadata);

    return await this.sendEmail({
      to: email,
      subject: subjectLine,
      html,
      text,
      type: 'evaluation_reminder',
      metadata: { roundName, deadline, hoursLeft }
    });
  }

  /**
   * Send evaluation pending email (Judge)
   * @param {string} email - Recipient email
   * @param {string} userName - User name
   * @param {Object} metadata - Evaluation metadata
   * @returns {Promise<boolean>} Success status
   */
  async sendEvaluationPendingEmail(email, userName, metadata) {
    const { roundName, submissionCount, deadline } = metadata;
    const subjectLine = `New Evaluations Available - ${roundName}`;
    const html = this.generateEvaluationPendingHTML(userName, metadata);
    const text = this.generateEvaluationPendingText(userName, metadata);

    return await this.sendEmail({
      to: email,
      subject: subjectLine,
      html,
      text,
      type: 'evaluation_pending',
      metadata: { roundName, submissionCount, deadline }
    });
  }

  /**
   * Send judge assignment email (Judge)
   * @param {string} email - Recipient email
   * @param {string} userName - User name
   * @param {Object} metadata - Assignment metadata
   * @returns {Promise<boolean>} Success status
   */
  async sendJudgeAssignmentEmail(email, userName, metadata) {
    const { roundName, level } = metadata;
    const subjectLine = `Judge Assignment - ${roundName}`;
    const html = this.generateJudgeAssignmentHTML(userName, metadata);
    const text = this.generateJudgeAssignmentText(userName, metadata);

    return await this.sendEmail({
      to: email,
      subject: subjectLine,
      html,
      text,
      type: 'judge_assigned',
      metadata: { roundName, level }
    });
  }

  /**
   * Send admin notification email
   * @param {string} email - Recipient email
   * @param {string} userName - User name
   * @param {string} title - Notification title
   * @param {string} message - Notification message
   * @param {Object} metadata - Additional metadata
   * @returns {Promise<boolean>} Success status
   */
  async sendAdminNotificationEmail(email, userName, title, message, metadata) {
    const html = this.generateAdminNotificationHTML(userName, title, message, metadata);
    const text = this.generateAdminNotificationText(userName, title, message, metadata);

    return await this.sendEmail({
      to: email,
      subject: title,
      html,
      text,
      type: 'admin_notification',
      metadata
    });
  }

  /**
   * Send system critical email (Admin)
   * @param {string} email - Recipient email
   * @param {string} userName - User name
   * @param {string} title - Critical issue title
   * @param {string} message - Critical issue message
   * @param {Object} metadata - Additional metadata
   * @returns {Promise<boolean>} Success status
   */
  async sendSystemCriticalEmail(email, userName, title, message, metadata) {
    const html = this.generateSystemCriticalHTML(userName, title, message, metadata);
    const text = this.generateSystemCriticalText(userName, title, message, metadata);

    return await this.sendEmail({
      to: email,
      subject: title,
      html,
      text,
      type: 'system_critical',
      metadata
    });
  }

  /**
   * Generate OTP verification HTML template
   * @param {string} otp - OTP code
   * @param {string} userName - User name
   * @returns {string} HTML content
   */
  generateOTPHTML(otp, userName) {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Verify Your TSCS Account</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 30px; }
          .otp-code { font-size: 32px; font-weight: bold; color: #2c5aa0; text-align: center; margin: 30px 0; padding: 20px; background: #f8f9fa; border: 2px dashed #2c5aa0; border-radius: 8px; letter-spacing: 5px; }
          .warning { background: #fff3cd; border: 1px solid #ffeaa7; color: #856404; padding: 15px; border-radius: 5px; margin: 20px 0; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #666; font-size: 14px; }
          .support { margin-top: 15px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Welcome to TSCS!</h1>
            <p>Hi ${userName}, please verify your email address to complete your registration.</p>
          </div>

          <p>Your verification code is:</p>

          <div class="otp-code">${otp}</div>

          <div class="warning">
            <strong>Important:</strong> This code will expire in 10 minutes. Do not share this code with anyone.
          </div>

          <p>If you didn't request this verification, please ignore this email.</p>

          <div class="footer">
            <p><strong>Teacher Submission Competition System (TSCS)</strong></p>
            <p>This verification code was sent to complete your account setup.</p>
            <div class="support">
              <p>Need help? Contact our support team.</p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Generate OTP verification text template
   * @param {string} otp - OTP code
   * @param {string} userName - User name
   * @returns {string} Text content
   */
  generateOTPText(otp, userName) {
    return `
TSCS - Email Verification

Hi ${userName},

Welcome to the Teacher Submission Competition System!

Your verification code is: ${otp}

This code will expire in 10 minutes. Please use it to complete your account verification.

If you didn't request this verification, please ignore this email.

---
Teacher Submission Competition System (TSCS)
This verification code was sent to complete your account setup.
    `.trim();
  }

  /**
   * Generate system notification HTML template
   * @param {string} message - Notification message
   * @param {string} userName - User name
   * @param {Object} metadata - Additional data
   * @returns {string} HTML content
   */
  generateSystemNotificationHTML(message, userName, metadata = {}) {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>TSCS Notification</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 30px; color: #2c5aa0; }
          .message { background: #f8f9fa; padding: 20px; border-radius: 8px; border-left: 4px solid #2c5aa0; margin: 20px 0; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #666; font-size: 14px; }
          .metadata { background: #e9ecef; padding: 15px; border-radius: 5px; margin: 15px 0; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>TSCS Notification</h1>
            <p>Hello ${userName},</p>
          </div>

          <div class="message">
            ${message.replace(/\n/g, '<br>')}
          </div>

          ${metadata && Object.keys(metadata).length > 0 ? `
          <div class="metadata">
            <strong>Details:</strong><br>
            ${Object.entries(metadata).map(([key, value]) =>
              `${key}: ${value}`
            ).join('<br>')}
          </div>
          ` : ''}

          <div class="footer">
            <p><strong>Teacher Submission Competition System (TSCS)</strong></p>
            <p>You received this notification because you are registered with our system.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Generate system notification text template
   * @param {string} message - Notification message
   * @param {string} userName - User name
   * @param {Object} metadata - Additional data
   * @returns {string} Text content
   */
  generateSystemNotificationText(message, userName, metadata = {}) {
    let text = `
TSCS - System Notification

Hello ${userName},

${message}

---
Teacher Submission Competition System (TSCS)
You received this notification because you are registered with our system.
    `.trim();

    if (metadata && Object.keys(metadata).length > 0) {
      text += '\n\nDetails:\n' +
        Object.entries(metadata).map(([key, value]) => `${key}: ${value}`).join('\n');
    }

    return text;
  }

  /**
   * Generate submission successful HTML template
   * @param {string} userName - User name
   * @param {Object} metadata - Submission metadata
   * @returns {string} HTML content
   */
  generateSubmissionSuccessfulHTML(userName, metadata) {
    const { roundName, subject } = metadata;

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Submission Received - TSCS</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 30px; }
          .success-icon { font-size: 48px; color: #52c41a; margin-bottom: 16px; }
          .content { background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="success-icon">✅</div>
            <h1>Submission Received Successfully!</h1>
            <p>Hello ${userName},</p>
          </div>

          <div class="content">
            <h3>Your submission has been received and is now under review.</h3>
            <p><strong>Competition:</strong> ${roundName}</p>
            <p><strong>Subject:</strong> ${subject}</p>
            <p>You will receive an email notification once the evaluation process is complete.</p>
          </div>

          <div class="footer">
            <p><strong>Teacher Submission Competition System (TSCS)</strong></p>
            <p>Thank you for your participation!</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Generate submission successful text template
   * @param {string} userName - User name
   * @param {Object} metadata - Submission metadata
   * @returns {string} Text content
   */
  generateSubmissionSuccessfulText(userName, metadata) {
    const { roundName, subject } = metadata;

    return `
TSCS - Submission Received Successfully

Hello ${userName},

Your submission has been received and is now under review.

Competition: ${roundName}
Subject: ${subject}

You will receive an email notification once the evaluation process is complete.

---
Teacher Submission Competition System (TSCS)
Thank you for your participation!
    `.trim();
  }

  /**
   * Generate submission result HTML template
   * @param {string} userName - User name
   * @param {string} result - 'promoted' or 'eliminated'
   * @param {Object} metadata - Submission metadata
   * @returns {string} HTML content
   */
  generateSubmissionResultHTML(userName, result, metadata) {
    const { roundName, nextRound } = metadata;
    const isPromoted = result === 'promoted';
    const icon = isPromoted ? '🎉' : '📋';
    const color = isPromoted ? '#52c41a' : '#faad14';

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Submission Results - TSCS</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 30px; }
          .result-icon { font-size: 48px; margin-bottom: 16px; }
          .content { background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid ${color}; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="result-icon">${icon}</div>
            <h1>${isPromoted ? 'Congratulations!' : 'Evaluation Complete'}</h1>
            <p>Hello ${userName},</p>
          </div>

          <div class="content">
            <h3>${roundName} - Results</h3>
            <p>${isPromoted
              ? `Great news! Your submission has been selected to advance to ${nextRound || 'the next round'}.`
              : 'The evaluation period has ended. Unfortunately, your submission was not selected to advance to the next round.'
            }</p>
            ${isPromoted
              ? '<p>Keep up the excellent work and continue participating in future competitions!</p>'
              : '<p>Don\'t be discouraged! We encourage you to participate in future competitions and continue developing your teaching skills.</p>'
            }
          </div>

          <div class="footer">
            <p><strong>Teacher Submission Competition System (TSCS)</strong></p>
            <p>${isPromoted ? 'Congratulations on your success!' : 'Thank you for your participation!'}</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Generate submission result text template
   * @param {string} userName - User name
   * @param {Object} metadata - Submission metadata
   * @returns {string} Text content
   */
  generateSubmissionResultText(userName, result, metadata) {
    const { roundName, nextRound } = metadata;
    const isPromoted = result === 'promoted';

    return `
TSCS - Submission Results

Hello ${userName},

${roundName} - Results

${isPromoted
  ? `Congratulations! Your submission has been selected to advance to ${nextRound || 'the next round'}.`
  : 'The evaluation period has ended. Unfortunately, your submission was not selected to advance to the next round.'
}

${isPromoted
  ? 'Keep up the excellent work and continue participating in future competitions!'
  : 'Don\'t be discouraged! We encourage you to participate in future competitions and continue developing your teaching skills.'
}

---
Teacher Submission Competition System (TSCS)
${isPromoted ? 'Congratulations on your success!' : 'Thank you for your participation!'}
    `.trim();
  }

  /**
   * Generate evaluation reminder HTML template
   * @param {string} userName - User name
   * @param {Object} metadata - Evaluation metadata
   * @returns {string} HTML content
   */
  generateEvaluationReminderHTML(userName, metadata) {
    const { roundName, deadline, hoursLeft } = metadata;

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Evaluation Reminder - TSCS</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 30px; }
          .warning-icon { font-size: 48px; color: #faad14; margin-bottom: 16px; }
          .content { background: #fff3cd; border: 1px solid #ffeaa7; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .deadline { background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; font-weight: bold; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="warning-icon">⏰</div>
            <h1>Evaluation Reminder</h1>
            <p>Hello ${userName},</p>
          </div>

          <div class="content">
            <h3>You have pending evaluations that require your attention.</h3>
            <p><strong>Competition:</strong> ${roundName}</p>
            <p><strong>Time Remaining:</strong> ${hoursLeft} hours</p>

            <div class="deadline">
              📅 Deadline: ${deadline}
            </div>

            <p>Please complete your evaluations before the deadline to ensure fair and timely results for all participants.</p>
          </div>

          <div class="footer">
            <p><strong>Teacher Submission Competition System (TSCS)</strong></p>
            <p>Your evaluations are important for the competition's success.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Generate evaluation reminder text template
   * @param {string} userName - User name
   * @param {Object} metadata - Evaluation metadata
   * @returns {string} Text content
   */
  generateEvaluationReminderText(userName, metadata) {
    const { roundName, deadline, hoursLeft } = metadata;

    return `
TSCS - Evaluation Reminder

Hello ${userName},

You have pending evaluations that require your attention.

Competition: ${roundName}
Time Remaining: ${hoursLeft} hours
Deadline: ${deadline}

Please complete your evaluations before the deadline to ensure fair and timely results for all participants.

---
Teacher Submission Competition System (TSCS)
Your evaluations are important for the competition's success.
    `.trim();
  }

  /**
   * Generate evaluation pending HTML template
   * @param {string} userName - User name
   * @param {Object} metadata - Evaluation metadata
   * @returns {string} Text content
   */
  generateEvaluationPendingHTML(userName, metadata) {
    const { roundName, submissionCount, deadline } = metadata;

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>New Evaluations Available - TSCS</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 30px; }
          .notification-icon { font-size: 48px; color: #1890ff; margin-bottom: 16px; }
          .content { background: #e6f7ff; border: 1px solid #91d5ff; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .stats { background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="notification-icon">📋</div>
            <h1>New Evaluations Available</h1>
            <p>Hello ${userName},</p>
          </div>

          <div class="content">
            <h3>New submissions are ready for your evaluation.</h3>
            <p><strong>Competition:</strong> ${roundName}</p>

            <div class="stats">
              📊 Submissions to evaluate: ${submissionCount}
            </div>

            <p>Please review and evaluate these submissions at your earliest convenience.</p>
            <p><strong>Deadline:</strong> ${deadline}</p>
          </div>

          <div class="footer">
            <p><strong>Teacher Submission Competition System (TSCS)</strong></p>
            <p>Your expert evaluation helps maintain the quality of our competitions.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Generate evaluation pending text template
   * @param {string} userName - User name
   * @param {Object} metadata - Evaluation metadata
   * @returns {string} Text content
   */
  generateEvaluationPendingText(userName, metadata) {
    const { roundName, submissionCount, deadline } = metadata;

    return `
TSCS - New Evaluations Available

Hello ${userName},

New submissions are ready for your evaluation.

Competition: ${roundName}
Submissions to evaluate: ${submissionCount}
Deadline: ${deadline}

Please review and evaluate these submissions at your earliest convenience.

---
Teacher Submission Competition System (TSCS)
Your expert evaluation helps maintain the quality of our competitions.
    `.trim();
  }

  /**
   * Generate judge assignment HTML template
   * @param {string} userName - User name
   * @param {Object} metadata - Assignment metadata
   * @returns {string} HTML content
   */
  generateJudgeAssignmentHTML(userName, metadata) {
    const { roundName, level } = metadata;

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Judge Assignment - TSCS</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 30px; }
          .assignment-icon { font-size: 48px; color: #722ed1; margin-bottom: 16px; }
          .content { background: #f9f0ff; border: 1px solid #d3adf7; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .assignment-details { background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="assignment-icon">👨‍⚖️</div>
            <h1>Judge Assignment</h1>
            <p>Hello ${userName},</p>
          </div>

          <div class="content">
            <h3>You have been assigned as a judge!</h3>
            <p>You have been selected to evaluate submissions for an upcoming competition round.</p>

            <div class="assignment-details">
              🏆 <strong>Competition:</strong> ${roundName}<br>
              📊 <strong>Level:</strong> ${level}
            </div>

            <p>Your expertise and fair evaluation will help ensure the quality and integrity of our competition results.</p>
          </div>

          <div class="footer">
            <p><strong>Teacher Submission Competition System (TSCS)</strong></p>
            <p>Thank you for your service as a judge!</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Generate judge assignment text template
   * @param {string} userName - User name
   * @param {Object} metadata - Assignment metadata
   * @returns {string} Text content
   */
  generateJudgeAssignmentText(userName, metadata) {
    const { roundName, level } = metadata;

    return `
TSCS - Judge Assignment

Hello ${userName},

You have been assigned as a judge!

You have been selected to evaluate submissions for an upcoming competition round.

Competition: ${roundName}
Level: ${level}

Your expertise and fair evaluation will help ensure the quality and integrity of our competition results.

---
Teacher Submission Competition System (TSCS)
Thank you for your service as a judge!
    `.trim();
  }

  /**
   * Generate admin notification HTML template
   * @param {string} userName - User name
   * @param {string} title - Notification title
   * @param {string} message - Notification message
   * @param {Object} metadata - Additional metadata
   * @returns {string} HTML content
   */
  generateAdminNotificationHTML(userName, title, message, metadata) {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${title} - TSCS Admin</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 30px; }
          .admin-icon { font-size: 48px; color: #fa8c16; margin-bottom: 16px; }
          .content { background: #fff7e6; border: 1px solid #ffd591; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="admin-icon">🔔</div>
            <h1>${title}</h1>
            <p>Hello ${userName},</p>
          </div>

          <div class="content">
            ${message.replace(/\n/g, '<br>')}
          </div>

          <div class="footer">
            <p><strong>Teacher Submission Competition System (TSCS)</strong></p>
            <p>This is an official notification from the TSCS administration.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Generate admin notification text template
   * @param {string} userName - User name
   * @param {string} title - Notification title
   * @param {string} message - Notification message
   * @param {Object} metadata - Additional metadata
   * @returns {string} Text content
   */
  generateAdminNotificationText(userName, title, message, metadata) {
    return `
TSCS Admin Notification - ${title}

Hello ${userName},

${message}

---
Teacher Submission Competition System (TSCS)
This is an official notification from the TSCS administration.
    `.trim();
  }

  /**
   * Generate system critical HTML template
   * @param {string} userName - User name
   * @param {string} title - Critical issue title
   * @param {string} message - Critical issue message
   * @param {Object} metadata - Additional metadata
   * @returns {string} HTML content
   */
  generateSystemCriticalHTML(userName, title, message, metadata) {
    const { severity = 'high' } = metadata;
    const severityColor = severity === 'critical' ? '#ff4d4f' : '#faad14';

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${title} - TSCS CRITICAL</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 30px; }
          .critical-icon { font-size: 48px; color: ${severityColor}; margin-bottom: 16px; }
          .content { background: #fff2f0; border: 1px solid #ffccc7; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .severity { background: ${severityColor}; color: white; padding: 8px 16px; border-radius: 20px; display: inline-block; font-weight: bold; text-transform: uppercase; font-size: 12px; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="critical-icon">🚨</div>
            <h1>CRITICAL SYSTEM ALERT</h1>
            <p>Hello ${userName},</p>
            <span class="severity">${severity} priority</span>
          </div>

          <div class="content">
            <h3>${title}</h3>
            <p>${message.replace(/\n/g, '<br>')}</p>
            <p><strong>This requires immediate attention from system administrators.</strong></p>
          </div>

          <div class="footer">
            <p><strong>Teacher Submission Competition System (TSCS)</strong></p>
            <p>Critical system alerts require immediate action.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Generate system critical text template
   * @param {string} userName - User name
   * @param {string} message - Critical issue message
   * @param {Object} metadata - Additional metadata
   * @returns {string} Text content
   */
  generateSystemCriticalText(userName, title, message, metadata) {
    const { severity = 'high' } = metadata;

    return `
TSCS CRITICAL SYSTEM ALERT - ${severity.toUpperCase()} PRIORITY

Hello ${userName},

${title}

${message}

This requires immediate attention from system administrators.

---
Teacher Submission Competition System (TSCS)
Critical system alerts require immediate action.
    `.trim();
  }

  /**
   * Generate password reset OTP HTML template
   * @param {string} otp - OTP code
   * @param {string} userName - User name
   * @returns {string} HTML content
   */
  generatePasswordResetOTPHTML(otp, userName) {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Password Reset - TSCS</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f4f4f4; }
          .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
          .header { text-align: center; margin-bottom: 30px; }
          .warning-icon { font-size: 48px; color: #fa8c16; margin-bottom: 16px; }
          .otp-code { font-size: 32px; font-weight: bold; color: #1890ff; text-align: center; margin: 30px 0; padding: 20px; background: #f0f8ff; border: 2px dashed #1890ff; border-radius: 8px; letter-spacing: 5px; }
          .warning { background: #fff7e6; border: 1px solid #ffd591; color: #d46b08; padding: 15px; border-radius: 5px; margin: 20px 0; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #666; font-size: 14px; }
          .support { margin-top: 15px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="warning-icon">🔐</div>
            <h1>Password Reset Request</h1>
            <p>Hi ${userName},</p>
          </div>

          <p>You have requested to reset your password for your TSCS account. Use the verification code below to proceed:</p>

          <div class="otp-code">${otp}</div>

          <div class="warning">
            <strong>Security Notice:</strong> This code will expire in 10 minutes. Do not share this code with anyone. If you didn't request this password reset, please ignore this email.
          </div>

          <p>If you continue with the password reset, you will be able to set a new password for your account.</p>

          <div class="footer">
            <p><strong>Teacher Submission Competition System (TSCS)</strong></p>
            <p>This password reset was requested for your account security.</p>
            <div class="support">
              <p>Need help? Contact our support team.</p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Generate password reset OTP text template
   * @param {string} otp - OTP code
   * @param {string} userName - User name
   * @returns {string} Text content
   */
  generatePasswordResetOTPText(otp, userName) {
    return `
TSCS - Password Reset Request

Hi ${userName},

You have requested to reset your password for your TSCS account.

Your verification code is: ${otp}

This code will expire in 10 minutes. Do not share this code with anyone.

If you didn't request this password reset, please ignore this email.

If you continue with the password reset, you will be able to set a new password for your account.

---
Teacher Submission Competition System (TSCS)
This password reset was requested for your account security.
    `.trim();
  }

  /**
   * Test email configuration
   * @returns {Promise<boolean>} Test result
   */
  async testConnection() {
    if (!this.isInitialized) {
      this.initialize();
    }

    if (!this.transporter) {
      return false;
    }

    try {
      await this.transporter.verify();
      console.log('✅ Email service connection test passed');
      return true;
    } catch (error) {
      console.error('❌ Email service connection test failed:', error.message);
      return false;
    }
  }
}

// Singleton instance
const emailService = new EmailService();

module.exports = emailService;