'use strict';
/**
 * metricService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Business-logic helpers for the ESGLink Metric Library.
 *
 * Responsibilities:
 *   - generateMetricCode: sequential ESG-X-XX-NNN code generation, scoped to
 *     global or per-client namespace. Includes a single collision retry.
 *   - validateSubcategoryCode: validates subcategoryCode belongs to esgCategory.
 *   - DEFINITION_FIELDS: the set of fields whose change bumps metric version.
 */

const EsgMetric = require('../models/EsgMetric');
const { SUBCATEGORY_CODES } = require('../models/EsgMetric');

// ── Definition-level fields (version bumps when any of these change) ──────────
const DEFINITION_FIELDS = [
  'metricName',
  'metricDescription',
  'primaryUnit',
  'allowedUnits',
  'dataType',
  'formulaId',
];

/**
 * validateSubcategoryCode
 * Checks that subcategoryCode is valid for the given esgCategory.
 *
 * @param {string} esgCategory    - 'E' | 'S' | 'G'
 * @param {string} subcategoryCode
 * @returns {{ valid: boolean, message: string }}
 */
const validateSubcategoryCode = (esgCategory, subcategoryCode) => {
  const allowed = SUBCATEGORY_CODES[esgCategory];
  if (!allowed) {
    return { valid: false, message: `Invalid esgCategory: ${esgCategory}. Must be E, S, or G.` };
  }
  if (!allowed.includes(subcategoryCode)) {
    return {
      valid: false,
      message: `subcategoryCode '${subcategoryCode}' is not valid for esgCategory '${esgCategory}'. ` +
               `Allowed codes: ${allowed.join(', ')}`,
    };
  }
  return { valid: true, message: '' };
};

/**
 * generateMetricCode
 * Produces the next sequential code: ESG-{esgCategory}-{subcategoryCode}-{NNN}
 *
 * Scoping:
 *   - Global metrics  (isGlobal = true):  sequence across ALL global metrics for
 *     that esgCategory + subcategoryCode.
 *   - Client metrics  (isGlobal = false): sequence per clientId + esgCategory +
 *     subcategoryCode.
 *
 * Collision safety: if the generated code already exists (race condition or
 * deleted metric occupying the slot), retries once with seq+1.
 *
 * @param {object} opts
 * @param {string}  opts.esgCategory
 * @param {string}  opts.subcategoryCode
 * @param {boolean} opts.isGlobal
 * @param {string|null} opts.clientId  - required when isGlobal = false
 * @returns {Promise<string>}          - e.g. 'ESG-E-EN-003'
 */
const generateMetricCode = async ({ esgCategory, subcategoryCode, isGlobal, clientId }) => {
  const buildFilter = (extra = {}) => ({
    esgCategory,
    subcategoryCode,
    isGlobal,
    ...(isGlobal ? {} : { clientId }),
    isDeleted: false,
    ...extra,
  });

  const buildCode = (seq) =>
    `ESG-${esgCategory}-${subcategoryCode}-${String(seq).padStart(3, '0')}`;

  // Count existing (non-deleted) metrics in this scope
  const count = await EsgMetric.countDocuments(buildFilter());
  let seq = count + 1;
  let code = buildCode(seq);

  // Collision retry — handles deleted-slot gaps or race conditions
  const exists = await EsgMetric.exists({ metricCode: code });
  if (exists) {
    seq += 1;
    code = buildCode(seq);
  }

  return code;
};

/**
 * hasDefinitionChange
 * Returns true when the update payload contains at least one definition-level
 * field (triggers a version bump).
 *
 * @param {object} updatePayload
 * @returns {boolean}
 */
const hasDefinitionChange = (updatePayload) => {
  return DEFINITION_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(updatePayload, field));
};

module.exports = {
  generateMetricCode,
  validateSubcategoryCode,
  hasDefinitionChange,
  DEFINITION_FIELDS,
};
