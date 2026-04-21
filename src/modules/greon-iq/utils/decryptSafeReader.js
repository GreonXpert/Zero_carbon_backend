'use strict';

// ============================================================================
// decryptSafeReader.js — Safe Mongoose model reader for encrypted-field records
//
// RULE: Never use collection.aggregate() directly on collections that contain
// AES-256-GCM encrypted fields. Always read through the Mongoose model layer
// so that field-level decryption plugins run transparently.
//
// This utility wraps common read patterns with consistent error handling
// and a configurable record cap to prevent context overflow.
// ============================================================================

/**
 * Safely find documents through a Mongoose model with a cap on results.
 *
 * @param {object} Model          — Mongoose model
 * @param {object} filter         — MongoDB filter (query-safe fields only)
 * @param {object} [projection]   — fields to include/exclude
 * @param {object} [options]      — sort, limit override
 * @param {number} [maxRecords]   — cap results (default 50)
 * @returns {Promise<{ docs: object[], totalFound: number, wasTruncated: boolean }>}
 */
async function safeFindMany(Model, filter, projection = {}, options = {}, maxRecords = 50) {
  const sort  = options.sort  || { createdAt: -1 };
  const limit = Math.min(options.limit || maxRecords, maxRecords);

  // Count separately for truncation detection
  const [docs, totalFound] = await Promise.all([
    Model.find(filter, projection).sort(sort).limit(limit).lean(),
    Model.countDocuments(filter),
  ]);

  return {
    docs,
    totalFound,
    wasTruncated: totalFound > limit,
  };
}

/**
 * Safely find a single document through a Mongoose model.
 *
 * @param {object} Model
 * @param {object} filter
 * @param {object} [projection]
 * @returns {Promise<object|null>}
 */
async function safeFindOne(Model, filter, projection = {}) {
  return Model.findOne(filter, projection).lean();
}

/**
 * Safely count documents matching a filter.
 * @param {object} Model
 * @param {object} filter
 * @returns {Promise<number>}
 */
async function safeCount(Model, filter) {
  return Model.countDocuments(filter);
}

module.exports = { safeFindMany, safeFindOne, safeCount };
