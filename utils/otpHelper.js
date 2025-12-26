/**
 * OTP Helper Utility
 * Handles OTP generation, storage, validation, and cleanup
 * For 2-Factor Authentication during login
 */

const crypto = require('crypto');
const nodemailer = require('nodemailer');
require('dotenv').config();

// In-memory storage for OTPs (consider using Redis for production)
// Structure: { email: { otp, expiresAt, attempts, userId } }
const otpStore = new Map();

// Configuration
const OTP_CONFIG = {
  LENGTH: 6,
  EXPIRY_MINUTES: 10,
  MAX_ATTEMPTS: 3,
  RESEND_COOLDOWN_SECONDS: 60,
  CLEANUP_INTERVAL_MS: 5 * 60 * 1000 // Cleanup every 5 minutes
};

/**
 * Generate a random 6-digit OTP
 * @returns {string} - Generated OTP
 */
const generateOTP = () => {
  return crypto.randomInt(100000, 999999).toString();
};

/**
 * Store OTP with expiration and metadata
 * @param {string} email - User's email
 * @param {string} otp - Generated OTP
 * @param {string} userId - User's ID
 */
const storeOTP = (email, otp, userId) => {
  const expiresAt = new Date(Date.now() + OTP_CONFIG.EXPIRY_MINUTES * 60 * 1000);
  
  otpStore.set(email.toLowerCase(), {
    otp,
    expiresAt,
    attempts: 0,
    userId,
    createdAt: new Date(),
    lastResendAt: new Date()
  });
  
  console.log(`[OTP] Stored OTP for ${email}, expires at ${expiresAt}`);
};

/**
 * Verify OTP for a user
 * @param {string} email - User's email
 * @param {string} otp - OTP to verify
 * @returns {Object} - { success: boolean, message: string, userId?: string }
 */
const verifyOTP = (email, otp) => {
  const normalizedEmail = email.toLowerCase();
  const otpData = otpStore.get(normalizedEmail);

  // Check if OTP exists
  if (!otpData) {
    return {
      success: false,
      message: 'No OTP found. Please request a new one.',
      code: 'OTP_NOT_FOUND'
    };
  }

  // Check if OTP has expired
  if (new Date() > otpData.expiresAt) {
    otpStore.delete(normalizedEmail);
    return {
      success: false,
      message: 'OTP has expired. Please request a new one.',
      code: 'OTP_EXPIRED'
    };
  }

  // Check if max attempts exceeded
  if (otpData.attempts >= OTP_CONFIG.MAX_ATTEMPTS) {
    otpStore.delete(normalizedEmail);
    return {
      success: false,
      message: 'Maximum verification attempts exceeded. Please request a new OTP.',
      code: 'MAX_ATTEMPTS_EXCEEDED'
    };
  }

  // Verify OTP
  if (otpData.otp !== otp) {
    otpData.attempts += 1;
    const remainingAttempts = OTP_CONFIG.MAX_ATTEMPTS - otpData.attempts;
    
    return {
      success: false,
      message: `Invalid OTP. ${remainingAttempts} attempt(s) remaining.`,
      code: 'INVALID_OTP',
      remainingAttempts
    };
  }

  // OTP is valid - clean up and return success
  const userId = otpData.userId;
  otpStore.delete(normalizedEmail);
  
  console.log(`[OTP] Successfully verified OTP for ${email}`);
  
  return {
    success: true,
    message: 'OTP verified successfully',
    userId
  };
};

/**
 * Check if user can request a new OTP (cooldown check)
 * @param {string} email - User's email
 * @returns {Object} - { canResend: boolean, waitTime?: number }
 */
const canResendOTP = (email) => {
  const normalizedEmail = email.toLowerCase();
  const otpData = otpStore.get(normalizedEmail);

  if (!otpData) {
    return { canResend: true };
  }

  const timeSinceLastResend = (Date.now() - otpData.lastResendAt.getTime()) / 1000;
  
  if (timeSinceLastResend < OTP_CONFIG.RESEND_COOLDOWN_SECONDS) {
    const waitTime = Math.ceil(OTP_CONFIG.RESEND_COOLDOWN_SECONDS - timeSinceLastResend);
    return {
      canResend: false,
      waitTime,
      message: `Please wait ${waitTime} seconds before requesting a new OTP.`
    };
  }

  return { canResend: true };
};

/**
 * Update last resend timestamp
 * @param {string} email - User's email
 */
const updateResendTimestamp = (email) => {
  const normalizedEmail = email.toLowerCase();
  const otpData = otpStore.get(normalizedEmail);
  
  if (otpData) {
    otpData.lastResendAt = new Date();
  }
};

/**
 * Send OTP via email
 * @param {string} email - Recipient's email
 * @param {string} otp - OTP to send
 * @param {string} userName - User's name
 * @returns {Promise<boolean>} - Success status
 */
const sendOTPEmail = async (email, otp, userName = 'User') => {
  try {
    // Create transporter
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    // Email template
    const emailHTML = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f9f9f9;
            border-radius: 10px;
          }
          .header {
            text-align: center;
            padding: 20px;
            background-color: #4CAF50;
            color: white;
            border-radius: 10px 10px 0 0;
          }
          .content {
            background-color: white;
            padding: 30px;
            border-radius: 0 0 10px 10px;
          }
          .otp-box {
            text-align: center;
            margin: 30px 0;
            padding: 20px;
            background-color: #f0f8ff;
            border: 2px dashed #4CAF50;
            border-radius: 5px;
          }
          .otp-code {
            font-size: 32px;
            font-weight: bold;
            color: #4CAF50;
            letter-spacing: 5px;
          }
          .warning {
            color: #ff6b6b;
            font-size: 14px;
            margin-top: 20px;
          }
          .footer {
            text-align: center;
            margin-top: 20px;
            font-size: 12px;
            color: #666;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🔐 Zero Carbon Platform</h1>
            <p>Two-Factor Authentication</p>
          </div>
          <div class="content">
            <h2>Hello ${userName},</h2>
            <p>You have requested to login to your Zero Carbon Platform account. Please use the following One-Time Password (OTP) to complete your login:</p>
            
            <div class="otp-box">
              <p style="margin: 0; color: #666;">Your OTP Code:</p>
              <div class="otp-code">${otp}</div>
              <p style="margin: 10px 0 0 0; color: #666; font-size: 14px;">
                Valid for ${OTP_CONFIG.EXPIRY_MINUTES} minutes
              </p>
            </div>

            <p><strong>Security Information:</strong></p>
            <ul>
              <li>This OTP is valid for ${OTP_CONFIG.EXPIRY_MINUTES} minutes</li>
              <li>You have ${OTP_CONFIG.MAX_ATTEMPTS} attempts to enter the correct OTP</li>
              <li>Do not share this code with anyone</li>
              <li>If you didn't request this, please ignore this email and secure your account</li>
            </ul>

            <div class="warning">
              ⚠️ <strong>Important:</strong> If you did not attempt to login, please contact your administrator immediately as someone may be trying to access your account.
            </div>
          </div>
          <div class="footer">
            <p>This is an automated email from Zero Carbon Platform.</p>
            <p>© ${new Date().getFullYear()} Zero Carbon Platform. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    // Plain text version
    const emailText = `
Hello ${userName},

Your Zero Carbon Platform Login OTP: ${otp}

This OTP is valid for ${OTP_CONFIG.EXPIRY_MINUTES} minutes.
You have ${OTP_CONFIG.MAX_ATTEMPTS} attempts to enter the correct OTP.

Do not share this code with anyone.

If you didn't request this login, please contact your administrator immediately.

© ${new Date().getFullYear()} Zero Carbon Platform
    `;

    // Send email
    const info = await transporter.sendMail({
      from: `"Zero Carbon Platform" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `Your Login OTP: ${otp} - Zero Carbon Platform`,
      text: emailText,
      html: emailHTML
    });

    console.log(`[OTP] Email sent successfully to ${email}, Message ID: ${info.messageId}`);
    return true;

  } catch (error) {
    console.error('[OTP] Error sending email:', error);
    return false;
  }
};

/**
 * Clean up expired OTPs
 */
const cleanupExpiredOTPs = () => {
  const now = new Date();
  let cleanedCount = 0;

  for (const [email, otpData] of otpStore.entries()) {
    if (now > otpData.expiresAt) {
      otpStore.delete(email);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    console.log(`[OTP] Cleaned up ${cleanedCount} expired OTP(s)`);
  }
};

/**
 * Get OTP statistics (for monitoring)
 * @returns {Object} - Statistics object
 */
const getOTPStats = () => {
  const now = new Date();
  let activeOTPs = 0;
  let expiredOTPs = 0;

  for (const otpData of otpStore.values()) {
    if (now > otpData.expiresAt) {
      expiredOTPs++;
    } else {
      activeOTPs++;
    }
  }

  return {
    totalStored: otpStore.size,
    activeOTPs,
    expiredOTPs,
    config: OTP_CONFIG
  };
};

/**
 * Delete OTP for a specific email
 * @param {string} email - User's email
 */
const deleteOTP = (email) => {
  const normalizedEmail = email.toLowerCase();
  otpStore.delete(normalizedEmail);
  console.log(`[OTP] Deleted OTP for ${email}`);
};

// Start cleanup interval
setInterval(cleanupExpiredOTPs, OTP_CONFIG.CLEANUP_INTERVAL_MS);

module.exports = {
  generateOTP,
  storeOTP,
  verifyOTP,
  sendOTPEmail,
  canResendOTP,
  updateResendTimestamp,
  deleteOTP,
  getOTPStats,
  OTP_CONFIG
};