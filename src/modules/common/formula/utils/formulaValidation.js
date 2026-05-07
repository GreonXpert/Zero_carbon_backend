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

function validateModuleKey(moduleKey) {
  if (!moduleKey) return 'moduleKey is required';
  if (!VALID_MODULE_KEYS.includes(moduleKey)) {
    return `moduleKey must be one of: ${VALID_MODULE_KEYS.join(', ')}`;
  }
  return null;
}

/**
 * Module-aware scope + client field validation.
 *
 * zero_carbon:
 *   - scopeType must be 'client' (no global)
 *   - clientIds must be an array of non-empty strings (can be empty [])
 *
 * esg_link:
 *   - scopeType can be 'client' or 'global'
 *   - if 'client', clientId must be a non-empty string
 *   - if 'global', clientId is ignored
 *
 * @param {string} moduleKey
 * @param {string} scopeType
 * @param {{ clientId?: string, clientIds?: string[] }} opts
 * @returns {string|null} error message or null
 */
function validateScope(moduleKey, scopeType, { clientId, clientIds } = {}) {
  if (!scopeType) return 'scopeType is required';
  if (!VALID_SCOPE_TYPES.includes(scopeType)) {
    return `scopeType must be one of: ${VALID_SCOPE_TYPES.join(', ')}`;
  }

  if (moduleKey === 'zero_carbon') {
    if (scopeType !== 'client') {
      return 'zero_carbon formulas must use scopeType "client"';
    }
    if (!Array.isArray(clientIds)) {
      return 'clientIds must be an array for zero_carbon formulas';
    }
    for (const id of clientIds) {
      if (typeof id !== 'string' || id.trim() === '') {
        return `clientIds contains an invalid entry: "${id}"`;
      }
    }
    return null;
  }

  if (moduleKey === 'esg_link') {
    if (scopeType === 'client') {
      if (!clientId || typeof clientId !== 'string' || clientId.trim() === '') {
        return 'clientId is required when scopeType is "client" for esg_link';
      }
    }
    return null;
  }

  return null;
}

/**
 * Legacy shim — kept so existing callers (updateFormula) don't break.
 * New code should call validateScope() directly.
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

function coerceEsgLinkLabel(moduleKey, name, label) {
  if (moduleKey === 'esg_link') return name;
  return label !== undefined ? label : '';
}

function validateClientIdString(clientId) {
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    return `Invalid clientId (must be a non-empty string): ${clientId}`;
  }
  return null;
}

/**
 * Extracts clientId (esg_link) or clientIds (zero_carbon) from a request body.
 * moduleKey drives which field is read.
 *
 * @param {object} body     - req.body
 * @param {string} moduleKey
 * @returns {{ clientId: string|undefined, clientIds: string[]|undefined }}
 */
function resolveClientFields(body, moduleKey) {
  if (moduleKey === 'zero_carbon') {
    const clientIds = Array.isArray(body.clientIds) ? body.clientIds : undefined;
    return { clientIds };
  }

  // esg_link — single clientId
  if (body.clientId) return { clientId: body.clientId };
  return { clientId: undefined };
}

module.exports = {
  VALID_MODULE_KEYS,
  VALID_SCOPE_TYPES,
  validateModuleKey,
  validateScope,
  validateScopeType,
  validateExpression,
  coerceEsgLinkLabel,
  validateClientIdString,
  resolveClientFields,
};
