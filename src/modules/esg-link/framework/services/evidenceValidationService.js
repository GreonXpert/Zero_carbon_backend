'use strict';

const EsgFrameworkQuestion = require('../models/FrameworkQuestion.model');
const EsgEvidenceLink      = require('../models/EvidenceLink.model');

/**
 * checkEvidenceRequirement
 * Validates that a DisclosureAnswer meets the evidence requirement of its question
 * before submission is allowed.
 *
 * @param {string|ObjectId} questionId
 * @param {string|ObjectId} answerId
 * @returns {Promise<{ valid: boolean, reason: string }>}
 */
const checkEvidenceRequirement = async (questionId, answerId) => {
  const question = await EsgFrameworkQuestion.findById(questionId, 'evidenceRequirement').lean();
  if (!question) {
    return { valid: false, reason: 'Question not found' };
  }

  const requirement = question.evidenceRequirement || 'optional';

  if (requirement === 'not_applicable') {
    return { valid: true, reason: 'Evidence not applicable for this question' };
  }
  if (requirement === 'optional') {
    return { valid: true, reason: 'Evidence is optional' };
  }

  const count = await EsgEvidenceLink.countDocuments({
    answerId,
    status: { $ne: 'rejected' },
  });

  if (requirement === 'required' && count === 0) {
    return {
      valid:  false,
      reason: 'At least one accepted evidence document is required before this answer can be submitted',
    };
  }

  if (requirement === 'recommended' && count === 0) {
    // Recommended but missing — allow submission with a warning (valid: true but reason explains)
    return { valid: true, reason: 'Evidence is recommended but not mandatory — submission allowed' };
  }

  return { valid: true, reason: 'Evidence requirement satisfied' };
};

module.exports = { checkEvidenceRequirement };
