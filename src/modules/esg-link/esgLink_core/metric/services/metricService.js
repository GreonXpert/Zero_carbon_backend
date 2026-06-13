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
const EsgSubcategory = require('../models/EsgSubcategory');

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
 * Checks that subcategoryCode is valid for the given esgCategory — either part
 * of the static register or a previously-created custom EsgSubcategory.
 *
 * @param {string} esgCategory    - 'E' | 'S' | 'G'
 * @param {string} subcategoryCode
 * @returns {Promise<{ valid: boolean, message: string }>}
 */
const validateSubcategoryCode = async (esgCategory, subcategoryCode) => {
  const allowed = SUBCATEGORY_CODES[esgCategory];
  if (!allowed) {
    return { valid: false, message: `Invalid esgCategory: ${esgCategory}. Must be E, S, or G.` };
  }
  if (allowed.includes(subcategoryCode)) {
    return { valid: true, message: '' };
  }

  const isCustom = await EsgSubcategory.exists({
    esgCategory, code: subcategoryCode, isDeleted: false,
  });
  if (isCustom) {
    return { valid: true, message: '' };
  }

  return {
    valid: false,
    message: `subcategoryCode '${subcategoryCode}' is not valid for esgCategory '${esgCategory}'. ` +
             `Allowed codes: ${allowed.join(', ')}`,
  };
};

/**
 * generateSubcategoryCode
 * Derives a short, unique (within existingCodes) uppercase code from a label.
 *
 * Strategy:
 *   1. Initials of each word (e.g. "Carbon Offsets" -> "CO"), 2-4 chars.
 *   2. First 3 / 2 letters of the first word.
 *   3. Numeric-suffixed fallback off the best candidate (e.g. "CO1", "CO2"...).
 *
 * @param {string} label
 * @param {Set<string>} existingCodes - codes already in use for this esgCategory
 * @returns {string}
 */
const generateSubcategoryCode = (label, existingCodes) => {
  const words = (label || '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean);

  const candidates = [];
  if (words.length >= 2) {
    candidates.push(words.map((w) => w[0]).join('').slice(0, 4));
  }
  if (words.length >= 1) {
    candidates.push(words[0].slice(0, 3));
    candidates.push(words[0].slice(0, 2));
  }

  for (const candidate of candidates) {
    if (candidate && candidate.length >= 2 && !existingCodes.has(candidate)) {
      return candidate;
    }
  }

  const base = (candidates[0] || 'XX').slice(0, 2) || 'XX';
  let seq = 1;
  let code = `${base}${seq}`;
  while (existingCodes.has(code)) {
    seq += 1;
    code = `${base}${seq}`;
  }
  return code;
};

/**
 * resolveSubcategory
 * Resolves the subcategoryCode to use for a new metric.
 *
 * If subcategoryCode is anything other than the 'OTHER' sentinel, it is
 * returned as-is (existing static/custom code). If it is 'OTHER', a new
 * custom EsgSubcategory is created (or an existing one with the same label is
 * reused) and its code is returned.
 *
 * @param {object} opts
 * @param {string} opts.esgCategory
 * @param {string} opts.subcategoryCode
 * @param {{ label?: string }|null|undefined} opts.newSubcategory
 * @param {*} opts.userId
 * @returns {Promise<{ code: string|null, error: string|null }>}
 */
const resolveSubcategory = async ({ esgCategory, subcategoryCode, newSubcategory, userId }) => {
  if (subcategoryCode !== 'OTHER') {
    return { code: subcategoryCode, error: null };
  }

  const label = (newSubcategory?.label || '').trim();
  if (!label) {
    return { code: null, error: "newSubcategory.label is required when subcategoryCode is 'OTHER'" };
  }

  const escaped = label.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
  const existing = await EsgSubcategory.findOne({
    esgCategory,
    label: new RegExp(`^${escaped}$`, 'i'),
    isDeleted: false,
  });
  if (existing) {
    return { code: existing.code, error: null };
  }

  const staticCodes = SUBCATEGORY_CODES[esgCategory] || [];
  const customDocs = await EsgSubcategory.find({ esgCategory, isDeleted: false }).select('code').lean();
  const existingCodes = new Set([...staticCodes, ...customDocs.map((d) => d.code)]);

  const code = generateSubcategoryCode(label, existingCodes);

  await EsgSubcategory.create({ esgCategory, code, label, createdBy: userId });

  return { code, error: null };
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
  generateSubcategoryCode,
  resolveSubcategory,
  hasDefinitionChange,
  DEFINITION_FIELDS,
};
