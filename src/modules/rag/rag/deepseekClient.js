'use strict';

// Reuses the existing Greon IQ DeepSeek provider via the low-level callRaw export.
// This avoids duplicating API key handling, retry logic, and error normalisation.
const { callRaw } = require('../../greon-iq/providers/deepseekProvider');

/**
 * Generate a single report section via DeepSeek.
 * Always requests JSON output (response_format: json_object).
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} options
 * @param {number} [options.temperature=0.2]
 * @param {number} [options.maxTokensPerSection=1500]
 * @returns {Promise<string>} — raw JSON string from DeepSeek
 */
async function generateSection(systemPrompt, userPrompt, options = {}) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: userPrompt }
  ];

  const result = await callRaw(messages, {
    response_format: { type: 'json_object' },
    temperature:     options.temperature         ?? 0.2,
    maxTokens:       options.maxTokensPerSection ?? 1500   // callRaw uses maxTokens (not max_tokens)
  });

  if (!result.success) {
    throw new Error(`DeepSeek API error: ${result.error || result.code || 'unknown'}`);
  }

  if (!result.content) {
    throw new Error('DeepSeek returned empty content');
  }

  return result.content;
}

module.exports = { generateSection };
