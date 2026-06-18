'use strict';

/**
 * OTP Helper — MongoDB-backed, production-ready
 *
 * Storage: OTPRecord (MongoDB) — shared across all PM2 cluster workers.
 * Every storage function is async; callers must await them.
 *
 * NODE_ENV=test behaviour (load/functional testing):
 *   storeOTP    → stores '000000' so k6/Jest can verify without real emails
 *   verifyOTP   → does NOT delete the record (concurrent VUs reuse it)
 *   sendOTPEmail→ returns true immediately, no email sent
 *
 * NODE_ENV=production / development:
 *   storeOTP    → stores a real 6-digit random OTP
 *   verifyOTP   → deletes record after successful verify (one-time use)
 *   sendOTPEmail→ sends real email via Gmail SMTP (connection pool)
 */

const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const OTPRecord  = require('../models/OTPRecord');
require('dotenv').config();

// ─── Config ───────────────────────────────────────────────────────────────────
const OTP_CONFIG = {
  LENGTH:                  6,
  EXPIRY_MINUTES:          10,
  MAX_ATTEMPTS:            3,
  RESEND_COOLDOWN_SECONDS: 60,
};

const LOAD_TEST_OTP = '000000';

// ─── Singleton SMTP transporter ───────────────────────────────────────────────
// Created once at first use; connection-pooled for performance.
// In test mode this is never initialised.
let _transporter = null;

const getTransporter = () => {
  if (process.env.NODE_ENV === 'test') return null;
  if (_transporter) return _transporter;

  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;

  if (!user || !pass) {
    console.error('[OTP] CRITICAL: EMAIL_USER or EMAIL_PASS not set — emails will fail');
    return null;
  }

  _transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
    pool: true,
    maxConnections: 5,
    maxMessages:    100,
    rateDelta:      1000,
    rateLimit:      5,
  });

  // Verify SMTP connection once at startup so misconfiguration surfaces early
  _transporter.verify((err) => {
    if (err) {
      console.error('[OTP] SMTP connection failed:', err.message);
      _transporter = null;
    } else {
      console.log('[OTP] SMTP connection verified — ready to send emails');
    }
  });

  return _transporter;
};

// Warm up the transporter when the module loads (non-blocking)
if (process.env.NODE_ENV !== 'test') {
  getTransporter();
}

// ─── generateOTP ──────────────────────────────────────────────────────────────
const generateOTP = () => crypto.randomInt(100000, 999999).toString();

// ─── storeOTP ─────────────────────────────────────────────────────────────────
const storeOTP = async (email, otp, userId) => {
  const expiresAt = new Date(Date.now() + OTP_CONFIG.EXPIRY_MINUTES * 60 * 1000);
  // In test mode always store the fixed OTP so k6 VUs can verify without emails
  const storedOtp = process.env.NODE_ENV === 'test' ? LOAD_TEST_OTP : otp;

  await OTPRecord.findOneAndUpdate(
    { email: email.toLowerCase() },
    {
      $set: {
        otp:          storedOtp,
        expiresAt,
        attempts:     0,
        userId,
        lastResendAt: new Date(),
      },
    },
    { upsert: true, new: true }
  );

  console.log(`[OTP] Stored OTP for ${email}, expires at ${expiresAt.toISOString()}`);
};

// ─── verifyOTP ────────────────────────────────────────────────────────────────
const verifyOTP = async (email, otp) => {
  const normalizedEmail = email.toLowerCase();
  const otpData = await OTPRecord.findOne({ email: normalizedEmail });

  if (!otpData) {
    return { success: false, message: 'No OTP found. Please request a new one.', code: 'OTP_NOT_FOUND' };
  }

  if (new Date() > otpData.expiresAt) {
    await OTPRecord.deleteOne({ email: normalizedEmail });
    return { success: false, message: 'OTP has expired. Please request a new one.', code: 'OTP_EXPIRED' };
  }

  if (otpData.attempts >= OTP_CONFIG.MAX_ATTEMPTS) {
    await OTPRecord.deleteOne({ email: normalizedEmail });
    return {
      success: false,
      message: 'Maximum verification attempts exceeded. Please request a new OTP.',
      code:    'MAX_ATTEMPTS_EXCEEDED',
    };
  }

  if (otpData.otp !== otp) {
    await OTPRecord.updateOne({ email: normalizedEmail }, { $inc: { attempts: 1 } });
    const remainingAttempts = OTP_CONFIG.MAX_ATTEMPTS - (otpData.attempts + 1);
    return {
      success: false,
      message: `Invalid OTP. ${remainingAttempts} attempt(s) remaining.`,
      code:    'INVALID_OTP',
      remainingAttempts,
    };
  }

  // OTP is correct
  const userId = otpData.userId;

  // In test mode keep the record so concurrent VUs sharing the same user can all verify
  if (process.env.NODE_ENV !== 'test') {
    await OTPRecord.deleteOne({ email: normalizedEmail });
  }

  console.log(`[OTP] Successfully verified OTP for ${email}`);
  return { success: true, message: 'OTP verified successfully', userId };
};

// ─── canResendOTP ─────────────────────────────────────────────────────────────
const canResendOTP = async (email) => {
  const otpData = await OTPRecord.findOne({ email: email.toLowerCase() });
  if (!otpData) return { canResend: true };

  const timeSinceLastResend = (Date.now() - otpData.lastResendAt.getTime()) / 1000;
  if (timeSinceLastResend < OTP_CONFIG.RESEND_COOLDOWN_SECONDS) {
    const waitTime = Math.ceil(OTP_CONFIG.RESEND_COOLDOWN_SECONDS - timeSinceLastResend);
    return { canResend: false, waitTime, message: `Please wait ${waitTime} seconds before requesting a new OTP.` };
  }
  return { canResend: true };
};

// ─── updateResendTimestamp ────────────────────────────────────────────────────
const updateResendTimestamp = async (email) => {
  await OTPRecord.updateOne(
    { email: email.toLowerCase() },
    { $set: { lastResendAt: new Date() } }
  );
};

// ─── deleteOTP ────────────────────────────────────────────────────────────────
const deleteOTP = async (email) => {
  await OTPRecord.deleteOne({ email: email.toLowerCase() });
  console.log(`[OTP] Deleted OTP for ${email}`);
};

// ─── getOTPStats ──────────────────────────────────────────────────────────────
const getOTPStats = async () => {
  const now        = new Date();
  const activeOTPs = await OTPRecord.countDocuments({ expiresAt: { $gt: now } });
  const expiredOTPs= await OTPRecord.countDocuments({ expiresAt: { $lte: now } });
  return { totalStored: activeOTPs + expiredOTPs, activeOTPs, expiredOTPs, config: OTP_CONFIG };
};

// ─── sendOTPEmail ─────────────────────────────────────────────────────────────
const sendOTPEmail = async (email, otp, userName = 'User') => {
  // Test mode — skip email entirely
  if (process.env.NODE_ENV === 'test') {
    console.log(`[OTP TEST MODE] Skipped email to ${email}. Fixed OTP: ${LOAD_TEST_OTP}`);
    return true;
  }

  const transporter = getTransporter();
  if (!transporter) {
    console.error('[OTP] Cannot send email — transporter not initialised (check EMAIL_USER/EMAIL_PASS)');
    return false;
  }

  try {
    const emailHTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body        { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
    .container  { max-width: 600px; margin: 0 auto; padding: 20px; background: #f9f9f9; border-radius: 10px; }
    .header     { text-align: center; padding: 20px; background: #2d7d46; color: #fff; border-radius: 10px 10px 0 0; }
    .header h1  { margin: 0; font-size: 22px; }
    .content    { background: #fff; padding: 30px; border-radius: 0 0 10px 10px; }
    .otp-box    { text-align: center; margin: 30px 0; padding: 20px; background: #f0f8f4; border: 2px dashed #2d7d46; border-radius: 8px; }
    .otp-code   { font-size: 38px; font-weight: bold; color: #2d7d46; letter-spacing: 8px; margin: 8px 0; }
    .info-list  { padding-left: 20px; color: #555; }
    .warning    { color: #c0392b; font-size: 13px; margin-top: 20px; padding: 10px; background: #fdf2f2; border-radius: 4px; }
    .footer     { text-align: center; margin-top: 20px; font-size: 12px; color: #999; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Zero Carbon Platform</h1>
      <p style="margin:4px 0 0 0;font-size:14px;">Two-Factor Authentication</p>
    </div>
    <div class="content">
      <h2 style="margin-top:0;">Hello ${userName},</h2>
      <p>You requested a login verification code for your Zero Carbon Platform account. Use the code below to complete your sign-in.</p>
      <div class="otp-box">
        <p style="margin:0;color:#666;font-size:13px;">Your One-Time Password</p>
        <div class="otp-code">${otp}</div>
        <p style="margin:6px 0 0 0;color:#888;font-size:13px;">Valid for <strong>${OTP_CONFIG.EXPIRY_MINUTES} minutes</strong></p>
      </div>
      <ul class="info-list">
        <li>This code expires in ${OTP_CONFIG.EXPIRY_MINUTES} minutes</li>
        <li>You have ${OTP_CONFIG.MAX_ATTEMPTS} attempts to enter the correct code</li>
        <li>Never share this code with anyone — including Zero Carbon support staff</li>
      </ul>
      <div class="warning">
        <strong>Did not request this?</strong> If you did not try to sign in, your account may be at risk.
        Contact your administrator immediately and change your password.
      </div>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} Zero Carbon Platform &mdash; Greonxpert Pvt Ltd. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`;

    const info = await transporter.sendMail({
      from:    `"Zero Carbon Platform" <${process.env.EMAIL_USER}>`,
      to:      email,
      // OTP is intentionally NOT in the subject — it appears in push notifications
      // and mail server logs; body-only is the secure practice
      subject: `Your Verification Code — Zero Carbon Platform`,
      text:    `Hello ${userName},\n\nYour Zero Carbon Platform login verification code is: ${otp}\n\nValid for ${OTP_CONFIG.EXPIRY_MINUTES} minutes. Do not share this with anyone.\n\nIf you did not request this, contact your administrator immediately.\n\n© ${new Date().getFullYear()} Zero Carbon Platform`,
      html:    emailHTML,
    });

    console.log(`[OTP] Email sent to ${email} — Message-ID: ${info.messageId}`);
    return true;
  } catch (error) {
    console.error(`[OTP] Failed to send email to ${email}:`, error.message);
    return false;
  }
};

module.exports = {
  generateOTP,
  storeOTP,
  verifyOTP,
  sendOTPEmail,
  canResendOTP,
  updateResendTimestamp,
  deleteOTP,
  getOTPStats,
  OTP_CONFIG,
  LOAD_TEST_OTP,
};
