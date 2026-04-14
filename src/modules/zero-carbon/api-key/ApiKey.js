// models/ApiKey.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const ApiKeySchema = new mongoose.Schema({
  // ============== Core Identifiers ==============
  clientId: {
    type: String,
    required: true,
    index: true,
    description: 'Client this key belongs to'
  },

  // ============== Key Type & Scope ==============
  keyType: {
    type: String,
    required: true,
    enum: ['NET_API', 'NET_IOT', 'DC_API', 'DC_IOT'],
    index: true,
    description: 'NET_API: Net Reduction API, NET_IOT: Net Reduction IoT, DC_API: Data Collection API, DC_IOT: Data Collection IoT'
  },

  // ============== Net Reduction Specific (nullable for DC keys) ==============
  projectId: {
    type: String,
    default: null,
    index: true,
    description: 'For NET_API and NET_IOT keys only'
  },

  calculationMethodology: {
    type: String,
    enum: ['methodology1', 'methodology2', 'methodology3', null],
    default: null,
    description: 'For NET_API and NET_IOT keys only'
  },

  // ============== Data Collection Specific (nullable for NET keys) ==============
  nodeId: {
    type: String,
    default: null,
    index: true,
    description: 'For DC_API and DC_IOT keys only'
  },

  scopeIdentifier: {
    type: String,
    default: null,
    index: true,
    description: 'For DC_API and DC_IOT keys only'
  },

  // ============== Security Fields ==============
  keyHash: {
    type: String,
    required: true,
    unique: true,
    description: 'Bcrypt hash of the API key - NEVER store plaintext'
  },

  keyPrefix: {
    type: String,
    required: true,
    length: 6,
    index: true,
    description: 'First 6 characters of the key for user identification (safe to display)'
  },

  // ============== Status & Lifecycle ==============
  status: {
    type: String,
    required: true,
    enum: ['ACTIVE', 'REVOKED', 'EXPIRED'],
    default: 'ACTIVE',
    index: true
  },

  expiresAt: {
    type: Date,
    required: true,
    index: true,
    description: 'Key expiration date'
  },

  // ============== Sandbox Handling ==============
  isSandboxKey: {
    type: Boolean,
    default: false,
    description: 'True if this key was created for a sandbox client'
  },

  sandboxDuration: {
    type: Number,
    enum: [10, 30, null],
    default: null,
    description: 'Duration in days for sandbox keys (10 or 30)'
  },

  // ============== Audit Fields ==============
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    description: 'User who created this key'
  },

  creatorRole: {
    type: String,
    required: true,
    enum: ['super_admin', 'consultant_admin', 'consultant'],
    description: 'Role of the user who created this key'
  },

  lastUsedAt: {
    type: Date,
    default: null,
    description: 'Last time this key was successfully used'
  },

  usageCount: {
    type: Number,
    default: 0,
    description: 'Number of times this key has been used'
  },

  // ============== Revocation Tracking ==============
  revokedAt: {
    type: Date,
    default: null
  },

  revokedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },

  revocationReason: {
    type: String,
    default: null,
    description: 'Reason for revocation'
  },

  // ============== Renewal Tracking ==============
  renewedFrom: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ApiKey',
    default: null,
    description: 'If this key was renewed from another key, reference to the old key'
  },

  renewedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ApiKey',
    default: null,
    description: 'If this key was renewed into a new key, reference to the new key'
  },

  // ============== Notification Tracking ==============
  expiryWarningsSent: {
    type: [{
      daysBeforeExpiry: { type: Number, required: true },
      sentAt: { type: Date, default: Date.now }
    }],
    default: [],
    description: 'Track which expiry warnings have been sent'
  },

  expiryNotificationSent: {
    type: Boolean,
    default: false,
    description: 'True if final expiry notification has been sent'
  },

  // ============== Additional Metadata ==============
  description: {
    type: String,
    default: '',
    description: 'Optional description for this key'
  },

  ipWhitelist: {
    type: [String],
    default: [],
    description: 'Optional IP whitelist for additional security'
  },

  lastError: {
    type: String,
    default: null,
    description: 'Last error encountered when using this key'
  },

  lastErrorAt: {
    type: Date,
    default: null
  }

}, {
  timestamps: true,
  collection: 'apikeys'
});

// ============== Indexes for Performance ==============
ApiKeySchema.index({ clientId: 1, keyType: 1, status: 1 });
ApiKeySchema.index({ clientId: 1, projectId: 1, calculationMethodology: 1 });
ApiKeySchema.index({ clientId: 1, nodeId: 1, scopeIdentifier: 1 });
ApiKeySchema.index({ expiresAt: 1, status: 1 }); // For expiry checks
ApiKeySchema.index({ createdBy: 1 });
ApiKeySchema.index({ keyPrefix: 1 });

// ============== Virtual for Days Until Expiry ==============
ApiKeySchema.virtual('daysUntilExpiry').get(function() {
  if (!this.expiresAt) return null;
  const now = new Date();
  const diffMs = this.expiresAt.getTime() - now.getTime();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
});

// ============== Instance Methods ==============

/**
 * Check if the provided plaintext key matches the stored hash
 * @param {string} plaintextKey - The plaintext API key to verify
 * @returns {Promise<boolean>}
 */
ApiKeySchema.methods.verifyKey = async function(plaintextKey) {
  return await bcrypt.compare(plaintextKey, this.keyHash);
};

/**
 * Check if key is valid (active and not expired)
 * @returns {boolean}
 */
ApiKeySchema.methods.isValid = function() {
  return this.status === 'ACTIVE' && this.expiresAt > new Date();
};

/**
 * Record key usage
 */
ApiKeySchema.methods.recordUsage = async function() {
  this.lastUsedAt = new Date();
  this.usageCount += 1;
  await this.save();
};

/**
 * Revoke this key
 * @param {mongoose.Types.ObjectId} userId - User who is revoking the key
 * @param {string} reason - Reason for revocation
 */
ApiKeySchema.methods.revoke = async function(userId, reason = 'Manual revocation') {
  this.status = 'REVOKED';
  this.revokedAt = new Date();
  this.revokedBy = userId;
  this.revocationReason = reason;
  await this.save();
};

/**
 * Mark key as expired
 */
ApiKeySchema.methods.markExpired = async function() {
  if (this.status === 'ACTIVE') {
    this.status = 'EXPIRED';
    await this.save();
  }
};

// ============== Static Methods ==============

/**
 * Find an active key by prefix (for user reference)
 * @param {string} keyPrefix 
 * @param {string} clientId 
 * @returns {Promise<ApiKey|null>}
 */
ApiKeySchema.statics.findByPrefix = async function(keyPrefix, clientId) {
  return await this.findOne({ 
    keyPrefix, 
    clientId,
    status: 'ACTIVE'
  });
};

/**
 * Find all keys expiring within the specified days
 * @param {number} days - Number of days to look ahead
 * @returns {Promise<Array>}
 */
ApiKeySchema.statics.findExpiringSoon = async function(days = 7) {
  const now = new Date();
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + days);

  return await this.find({
    status: 'ACTIVE',
    expiresAt: { $gte: now, $lte: futureDate }
  }).populate('createdBy', 'userName email');
};

/**
 * Find all expired keys that haven't been marked as expired yet
 * @returns {Promise<Array>}
 */
ApiKeySchema.statics.findExpired = async function() {
  return await this.find({
    status: 'ACTIVE',
    expiresAt: { $lt: new Date() }
  });
};

/**
 * Validate that key metadata matches route parameters
 * @param {Object} keyDoc - The API key document
 * @param {Object} params - Route parameters to validate against
 * @returns {boolean}
 */
ApiKeySchema.statics.validateKeyScope = function(keyDoc, params) {
  // For Net Reduction keys
  if (keyDoc.keyType === 'NET_API' || keyDoc.keyType === 'NET_IOT') {
    return (
      keyDoc.clientId === params.clientId &&
      keyDoc.projectId === params.projectId &&
      keyDoc.calculationMethodology === params.calculationMethodology
    );
  }

  // For Data Collection keys
  if (keyDoc.keyType === 'DC_API' || keyDoc.keyType === 'DC_IOT') {
    return (
      keyDoc.clientId === params.clientId &&
      keyDoc.nodeId === params.nodeId &&
      keyDoc.scopeIdentifier === params.scopeIdentifier
    );
  }

  return false;
};

// ============== Pre-save Hook for Validation ==============
ApiKeySchema.pre('save', function(next) {
  // Validate that Net Reduction keys have required fields
  if (this.keyType === 'NET_API' || this.keyType === 'NET_IOT') {
    if (!this.projectId || !this.calculationMethodology) {
      return next(new Error('NET keys require projectId and calculationMethodology'));
    }
    // Clear DC-specific fields
    this.nodeId = null;
    this.scopeIdentifier = null;
  }

  // Validate that Data Collection keys have required fields
  if (this.keyType === 'DC_API' || this.keyType === 'DC_IOT') {
    if (!this.nodeId || !this.scopeIdentifier) {
      return next(new Error('DC keys require nodeId and scopeIdentifier'));
    }
    // Clear NET-specific fields
    this.projectId = null;
    this.calculationMethodology = null;
  }

  // Auto-expire check
  if (this.status === 'ACTIVE' && this.expiresAt < new Date()) {
    this.status = 'EXPIRED';
  }

  next();
});

// ============== Post-save Hook for Automatic Status Updates ==============
ApiKeySchema.post('save', function(doc) {
  // Log key lifecycle events (can be extended for audit trail)
  if (doc.status === 'REVOKED') {
    console.log(`[API Key] Key ${doc.keyPrefix}*** revoked at ${new Date()}`);
  }
  if (doc.status === 'EXPIRED') {
    console.log(`[API Key] Key ${doc.keyPrefix}*** expired at ${new Date()}`);
  }
});

module.exports = mongoose.model('ApiKey', ApiKeySchema);