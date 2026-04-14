// controllers/Organization/ocrFeedbackController.js
// Handles saving and retrieving OCR field-mapping feedback (corrections).
//
// Called internally from confirmOCRSave after the user confirms/corrects
// model-matched field mappings. Stored corrections are used by modelMatcher.js
// to boost confidence on future uploads from the same client/scope.

'use strict';

const OCRFeedback = require('../models/OCRFeedback');

/**
 * Upsert OCRFeedback records for a batch of corrections.
 *
 * Each correction in the array should have:
 *   { rawLabel, confirmedField, confirmedDisplayLabel, wasAutoMatched }
 *
 * If a mapping for (clientId, scopeIdentifier, rawLabel) already exists,
 * we increment usedCount and update lastUsedAt.
 * If it does not exist, we create it.
 *
 * This is intentionally a fire-and-forget call — errors are logged but
 * do not fail the confirm-save response.
 *
 * @param {string} clientId
 * @param {string} nodeId
 * @param {string} scopeIdentifier
 * @param {string} scopeType
 * @param {string} categoryName
 * @param {Array}  corrections  Array of { rawLabel, confirmedField, confirmedDisplayLabel }
 */
async function saveFeedback(clientId, nodeId, scopeIdentifier, scopeType, categoryName, corrections = []) {
  if (!corrections || corrections.length === 0) return;

  const ops = corrections
    .filter(c => c.rawLabel && c.confirmedField)
    .map(c => {
      const normalizedLabel = (c.rawLabel || '').toLowerCase().trim();
      return {
        updateOne: {
          filter: {
            clientId,
            scopeIdentifier,
            rawLabel: normalizedLabel
          },
          update: {
            $set: {
              nodeId,
              scopeType,
              categoryName,
              mappedToField: c.confirmedField,
              mappedToDisplayLabel: c.confirmedDisplayLabel || '',
              lastUsedAt: new Date()
            },
            $inc: { usedCount: 1 },
            $setOnInsert: {
              clientId,
              scopeIdentifier,
              rawLabel: normalizedLabel,
              createdAt: new Date()
            }
          },
          upsert: true
        }
      };
    });

  if (ops.length === 0) return;

  try {
    await OCRFeedback.bulkWrite(ops, { ordered: false });
  } catch (err) {
    // Non-critical — log and continue
    console.warn('[saveFeedback] Failed to save OCR feedback:', err.message);
  }
}

/**
 * Fetch all feedback mappings for a client + scope combination.
 * Used by modelMatcher.js to boost match scores.
 *
 * @param {string} clientId
 * @param {string} scopeIdentifier
 * @returns {Promise<Array<OCRFeedback>>}
 */
async function getFeedbackForScope(clientId, scopeIdentifier) {
  try {
    return await OCRFeedback.find({ clientId, scopeIdentifier }).lean();
  } catch (err) {
    console.warn('[getFeedbackForScope] Failed to retrieve OCR feedback:', err.message);
    return [];
  }
}

/**
 * GET handler: return all learned mappings for a client (admin/debug endpoint).
 *
 * Route: GET /data-collection/clients/:clientId/ocr-field-mappings
 * Query: ?scopeIdentifier=xxx (optional filter)
 */
async function getOCRFieldMappings(req, res) {
  try {
    const { clientId } = req.params;
    const { scopeIdentifier } = req.query;

    const filter = { clientId };
    if (scopeIdentifier) filter.scopeIdentifier = scopeIdentifier;

    const mappings = await OCRFeedback.find(filter)
      .select('scopeIdentifier rawLabel mappedToField mappedToDisplayLabel usedCount lastUsedAt')
      .sort({ usedCount: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      clientId,
      scopeIdentifier: scopeIdentifier || 'all',
      count: mappings.length,
      mappings
    });
  } catch (err) {
    console.error('[getOCRFieldMappings] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to retrieve OCR field mappings' });
  }
}

module.exports = { saveFeedback, getFeedbackForScope, getOCRFieldMappings };
