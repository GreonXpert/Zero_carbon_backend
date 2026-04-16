'use strict';

/**
 * formulaValidation.js
 * Pure validation helpers for the common formula module.
 * No database calls, no side effects — fully testable in isolation.
 */

const { Parser } = require('expr-eval');

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_MODULE_KEYS = ['zero_carbon', 'esg_link'];
const VALID_SCOPE_TYPES = ['client', 'team', 'global'];

// ─── Validators ───────────────────────────────────────────────────────────────

/**
 * Validates that moduleKey is one of the supported modules.
 * @param {string} moduleKey
 * @returns {string|null} error message or null if valid
 */
function validateModuleKey(moduleKey) {
  if (!moduleKey) return 'moduleKey is required';
  if (!VALID_MODULE_KEYS.includes(moduleKey)) {
    return `moduleKey must be one of: ${VALID_MODULE_KEYS.join(', ')}`;
  }
  return null;
}

/**
 * Validates scopeType and clientId combination.
 * @param {string} scopeType
 * @param {string|null} clientId
 * @returns {string|null} error message or null if valid
 */
function validateScopeType(scopeType, clientId) {
  if (!scopeType) return 'scopeType is required';
  if (!VALID_SCOPE_TYPES.includes(scopeType)) {
    return `scopeType must be one of: ${VALID_SCOPE_TYPES.join(', ')}`;
  }
  if (scopeType === 'client') {
    if (!clientId || typeof clientId !== 'string' || clientId.trim() === '') {
      return 'clientId is required when scopeType is "client"';
    }
  }
  return null;
}

/**
 * Validates that the math expression is parseable by expr-eval.
 * @param {string} expression
 * @returns {{ valid: boolean, error: string|null }}
 */
function validateExpression(expression) {
  if (!expression || typeof expression !== 'string' || expression.trim() === '') {
    return { valid: false, error: 'expression is required' };
  }
  try {
    Parser.parse(expression);
    return { valid: true, error: null };
  } catch (e) {
    return { valid: false, error: `Invalid expression: ${e.message}` };
  }
}

/**
 * For ESGLink formulas, label must equal name.
 * Returns the coerced label value (i.e. name) or throws if name is missing.
 * @param {string} moduleKey
 * @param {string} name
 * @param {string} label
 * @returns {string} the correct label to use
 */
function coerceEsgLinkLabel(moduleKey, name, label) {
  if (moduleKey === 'esg_link') {
    return name; // label is always forced = name for esg_link
  }
  return label !== undefined ? label : '';
}

/**
 * Validates a single clientId string.
 * @param {string} clientId
 * @returns {string|null} error or null
 */
function validateClientIdString(clientId) {
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    return `Invalid clientId (must be a non-empty string): ${clientId}`;
  }
  return null;
}

/**
 * Transitional: if request body has clientIds[] but not clientId,
 * extracts the first element as clientId and logs a deprecation warning.
 * @param {object} body - req.body
 * @returns {{ clientId: string|undefined, deprecated: boolean }}
 */
function resolveClientId(body) {
  if (body.clientId) {
    return { clientId: body.clientId, deprecated: false };
  }
  if (Array.isArray(body.clientIds) && body.clientIds.length > 0) {
    console.warn(
      '[DEPRECATION] clientIds[] is deprecated. Use clientId (string) instead. ' +
      'Using clientIds[0] as clientId for this request.'
    );
    return { clientId: body.clientIds[0], deprecated: true };
  }
  return { clientId: undefined, deprecated: false };
}

module.exports = {
  VALID_MODULE_KEYS,
  VALID_SCOPE_TYPES,
  validateModuleKey,
  validateScopeType,
  validateExpression,
  coerceEsgLinkLabel,
  validateClientIdString,
  resolveClientId
};
