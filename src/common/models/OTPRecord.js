'use strict';

const mongoose = require('mongoose');

/**
 * OTPRecord — persists OTPs in MongoDB instead of in-memory Map.
 *
 * Why: the in-memory Map breaks under PM2 cluster mode because each worker
 * process has its own Map. Step 1 (login → storeOTP) may run on Worker A
 * but Step 2 (verify-otp) may hit Worker B where the Map is empty.
 *
 * MongoDB is already connected, requires no extra infrastructure, and the
 * TTL index on `expiresAt` auto-deletes records — equivalent to the old
 * setInterval cleanup.
 */
const otpRecordSchema = new mongoose.Schema(
  {
    email:        { type: String, required: true, unique: true, lowercase: true, trim: true },
    otp:          { type: String, required: true },
    expiresAt:    { type: Date,   required: true },
    attempts:     { type: Number, default: 0 },
    userId:       { type: String, required: true },
    lastResendAt: { type: Date,   default: Date.now },
  },
  { timestamps: true }
);

// TTL index: MongoDB background task deletes documents when expiresAt passes
otpRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('OTPRecord', otpRecordSchema);
