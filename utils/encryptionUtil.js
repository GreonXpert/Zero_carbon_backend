'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;       // 96-bit IV — optimal for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit authentication tag
const ENCODING = 'hex';
const SEPARATOR = ':';      // v1:iv:authTag:ciphertext
const VERSION_PREFIX = 'v1';

/**
 * Loads and validates the 32-byte AES-256 key from FIELD_ENCRYPTION_KEY env var.
 * The env var must be a 64-character hex string.
 * Throws on startup if misconfigured so the server fails fast.
 */
function getKey() {
  const hex = process.env.FIELD_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      '[EncryptionUtil] FIELD_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypts any value using AES-256-GCM.
 *
 * Storage format: v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>
 *
 * A single-character type prefix is prepended to the plaintext before encryption
 * so the original JavaScript type can be restored on decrypt:
 *   s = String
 *   n = Number
 *   j = JSON (Object or Array)
 *   m = Map (converted to plain object before serialization)
 *
 * null / undefined are returned as-is (not encrypted).
 */
function encrypt(value) {
  if (value === null || value === undefined) return value;

  let plaintext;
  let typePrefix;

  if (typeof value === 'string') {
    plaintext = value;
    typePrefix = 's';
  } else if (typeof value === 'number') {
    plaintext = String(value);
    typePrefix = 'n';
  } else if (value instanceof Map) {
    plaintext = JSON.stringify(Object.fromEntries(value));
    typePrefix = 'm';
  } else {
    plaintext = JSON.stringify(value);
    typePrefix = 'j';
  }

  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(typePrefix + plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    VERSION_PREFIX,
    iv.toString(ENCODING),
    authTag.toString(ENCODING),
    encrypted.toString(ENCODING),
  ].join(SEPARATOR);
}

/**
 * Decrypts a value previously produced by encrypt().
 *
 * Detects unencrypted (legacy) values by checking for the v1:<iv>:<tag>:<data> pattern.
 * If the value does not match, it is returned as-is — this allows zero-downtime
 * deployment alongside existing unencrypted documents in MongoDB.
 *
 * Restores original JS type: String, Number, plain Object/Array, or Map.
 */
function decrypt(encryptedValue) {
  if (encryptedValue === null || encryptedValue === undefined) return encryptedValue;

  // Non-string values are already native types (legacy doc with numeric/object field)
  if (typeof encryptedValue !== 'string') return encryptedValue;

  // Detect encrypted format: v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>
  const parts = encryptedValue.split(SEPARATOR);
  if (parts.length !== 4 || parts[0] !== VERSION_PREFIX) {
    // Not encrypted — legacy plain-text value, return as-is
    return encryptedValue;
  }

  const [, ivHex, authTagHex, ciphertextHex] = parts;

  // Validate IV length
  if (!ivHex || ivHex.length !== IV_LENGTH * 2) {
    return encryptedValue; // treat as legacy
  }

  try {
    const key = getKey();
    const iv = Buffer.from(ivHex, ENCODING);
    const authTag = Buffer.from(authTagHex, ENCODING);
    const ciphertext = Buffer.from(ciphertextHex, ENCODING);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');

    // First character is the type prefix
    const typePrefix = decrypted[0];
    const payload = decrypted.slice(1);

    switch (typePrefix) {
      case 's': return payload;
      case 'n': return Number(payload);
      case 'm': {
        return JSON.parse(payload);
      }
      case 'j': return JSON.parse(payload);
      default:  return payload; // fallback
    }
  } catch (err) {
    // GCM auth tag mismatch → data integrity issue or wrong key
    console.error('[EncryptionUtil] Decryption failed (possible tamper or wrong key):', err.message);
    return null;
  }
}

/**
 * Returns true if the string looks like a value produced by encrypt().
 * Used by migration helpers and health-checks.
 */
function isEncrypted(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split(SEPARATOR);
  if (parts.length !== 4 || parts[0] !== VERSION_PREFIX) return false;
  return /^[0-9a-f]+$/i.test(parts[1]) && parts[1].length === IV_LENGTH * 2;
}

module.exports = { encrypt, decrypt, isEncrypted };
