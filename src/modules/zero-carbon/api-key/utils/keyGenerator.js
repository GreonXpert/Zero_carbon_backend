// utils/ApiKey/keyGenerator.js
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

/**
 * Generates a cryptographically secure API key with custom format requirements
 * 
 * Key Format Strategy:
 * - Uses base64url encoding to avoid special characters
 * - Incorporates non-reversible fragments of identifiers
 * - Adds random elements for security
 * - Total length: 32 characters (we'll display as two 16-char segments for readability)
 * 
 * @param {string} keyType - 'NET_API', 'NET_IOT', 'DC_API', or 'DC_IOT'
 * @param {Object} metadata - Contains clientId, and either {projectId} or {nodeId, scopeIdentifier}
 * @returns {string} - The generated API key
 */
function generateApiKey(keyType, metadata) {
  // Generate 24 bytes of random data (will be 32 chars in base64url)
  const randomBytes = crypto.randomBytes(24);
  
  // Create a deterministic but non-reversible fragment from metadata
  // This helps with debugging but doesn't expose sensitive info
  let metadataString = '';
  
  if (keyType === 'NET_API' || keyType === 'NET_IOT') {
    // For Net Reduction: clientId + projectId
    metadataString = `${metadata.clientId}:${metadata.projectId}:NET:${keyType}`;
  } else {
    // For Data Collection: clientId + nodeId + scopeIdentifier
    metadataString = `${metadata.clientId}:${metadata.nodeId}:${metadata.scopeIdentifier}:DC:${keyType}`;
  }
  
  // Create a short hash of the metadata (first 4 bytes = 8 hex chars)
  const metadataHash = crypto
    .createHash('sha256')
    .update(metadataString)
    .digest('hex')
    .substring(0, 8);
  
  // Combine random bytes with metadata hash
  const combined = Buffer.concat([
    randomBytes,
    Buffer.from(metadataHash, 'hex')
  ]);
  
  // Convert to base64url (URL-safe, no padding)
  const key = combined
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  
  // Return 32 characters
  return key.substring(0, 32);
}

/**
 * Alternative human-readable key format (if needed)
 * Format: XXXX-XXXX-XXXX-XXXX (16 chars total, 4 segments)
 * 
 * Uses alphanumeric + some symbols, structured as requested:
 * - For DC keys: includes fragments of clientId, nodeId, scopeIdentifier + 3 alpha + 3 numeric + 3 symbol
 * - For NET keys: includes fragments of clientId, projectId + 4 alpha + 3 numeric + 3 symbol
 * 
 * @param {string} keyType 
 * @param {Object} metadata 
 * @returns {string}
 */
function generateReadableKey(keyType, metadata) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // Excluding I, O to avoid confusion
  const nums = '23456789'; // Excluding 0, 1 to avoid confusion
  const symbols = '!@#$%&*';
  
  // Helper to get random char from string
  const getRandom = (str) => str[crypto.randomInt(0, str.length)];
  
  // Helper to encode string to 2-char code
  const encodeToCode = (str) => {
    const hash = crypto.createHash('sha256').update(str).digest('hex');
    return hash.substring(0, 2).toUpperCase();
  };
  
  let segments = [];
  
  if (keyType === 'NET_API' || keyType === 'NET_IOT') {
    // Net Reduction: clientId fragment + projectId fragment + 4 alpha + 3 numeric + 3 symbols = 16 chars
    const clientCode = encodeToCode(metadata.clientId); // 2 chars
    const projectCode = encodeToCode(metadata.projectId); // 2 chars
    
    // 4 random alphabets
    const alpha = Array.from({ length: 4 }, () => getRandom(chars)).join('');
    
    // 3 random numerics
    const numeric = Array.from({ length: 3 }, () => getRandom(nums)).join('');
    
    // 3 random symbols
    const symbol = Array.from({ length: 3 }, () => getRandom(symbols)).join('');
    
    // Combine and shuffle
    const combined = (clientCode + projectCode + alpha + numeric + symbol).split('');
    // Fisher-Yates shuffle
    for (let i = combined.length - 1; i > 0; i--) {
      const j = crypto.randomInt(0, i + 1);
      [combined[i], combined[j]] = [combined[j], combined[i]];
    }
    
    return combined.join('');
    
  } else {
    // Data Collection: clientId + nodeId + scopeId fragments + 3 alpha + 3 numeric + 3 symbols = 16 chars
    const clientCode = encodeToCode(metadata.clientId); // 2 chars
    const nodeCode = encodeToCode(metadata.nodeId); // 2 chars
    const scopeCode = encodeToCode(metadata.scopeIdentifier); // 2 chars
    
    // 3 random alphabets
    const alpha = Array.from({ length: 3 }, () => getRandom(chars)).join('');
    
    // 3 random numerics  
    const numeric = Array.from({ length: 3 }, () => getRandom(nums)).join('');
    
    // 3 random symbols
    const symbol = Array.from({ length: 3 }, () => getRandom(symbols)).join('');
    
    // Combine and shuffle (total 16 chars)
    const combined = (clientCode + nodeCode + scopeCode + alpha + numeric + symbol).split('');
    // Fisher-Yates shuffle
    for (let i = combined.length - 1; i > 0; i--) {
      const j = crypto.randomInt(0, i + 1);
      [combined[i], combined[j]] = [combined[j], combined[i]];
    }
    
    return combined.join('');
  }
}

/**
 * Hash an API key for storage
 * @param {string} apiKey - Plaintext API key
 * @returns {Promise<string>} - Bcrypt hash
 */
async function hashApiKey(apiKey) {
  const saltRounds = 12; // High security
  return await bcrypt.hash(apiKey, saltRounds);
}

/**
 * Verify an API key against its hash
 * @param {string} plaintextKey 
 * @param {string} hash 
 * @returns {Promise<boolean>}
 */
async function verifyApiKey(plaintextKey, hash) {
  return await bcrypt.compare(plaintextKey, hash);
}

/**
 * Generate key prefix (first 6 characters) for user display
 * @param {string} apiKey 
 * @returns {string}
 */
function getKeyPrefix(apiKey) {
  return apiKey.substring(0, 6);
}

/**
 * Format key for display: KEY123***
 * @param {string} keyPrefix 
 * @returns {string}
 */
function formatKeyForDisplay(keyPrefix) {
  return `${keyPrefix}***`;
}

/**
 * Calculate expiry date based on client type and duration
 * @param {boolean} isSandbox 
 * @param {number} durationDays - For sandbox: 10 or 30; for active: custom (default 365)
 * @returns {Date}
 */
function calculateExpiryDate(isSandbox = false, durationDays = 365) {
  const now = new Date();
  
  if (isSandbox) {
    // Sandbox keys: 10 or 30 days only
    if (![10, 30].includes(durationDays)) {
      throw new Error('Sandbox keys must be either 10 or 30 days');
    }
  }
  
  // Add days to current date
  now.setDate(now.getDate() + durationDays);
  return now;
}

/**
 * Validate IP address against whitelist
 * @param {string} requestIp 
 * @param {Array<string>} whitelist 
 * @returns {boolean}
 */
function isIpWhitelisted(requestIp, whitelist) {
  if (!whitelist || whitelist.length === 0) {
    return true; // No whitelist = all IPs allowed
  }
  
  // Handle IPv6 localhost
  const normalizedIp = requestIp === '::1' ? '127.0.0.1' : requestIp;
  
  return whitelist.includes(normalizedIp) || whitelist.includes(requestIp);
}

/**
 * Generate complete API key package
 * @param {string} keyType 
 * @param {Object} metadata 
 * @param {boolean} readable - Use readable format instead of secure format
 * @returns {Promise<{key: string, hash: string, prefix: string}>}
 */
async function generateKeyPackage(keyType, metadata, readable = false) {
  // Generate the key
  const key = readable 
    ? generateReadableKey(keyType, metadata)
    : generateApiKey(keyType, metadata);
  
  // Hash the key
  const hash = await hashApiKey(key);
  
  // Get prefix
  const prefix = getKeyPrefix(key);
  
  return { key, hash, prefix };
}

module.exports = {
  generateApiKey,
  generateReadableKey,
  hashApiKey,
  verifyApiKey,
  getKeyPrefix,
  formatKeyForDisplay,
  calculateExpiryDate,
  isIpWhitelisted,
  generateKeyPackage
};