// utils/OCR/modelMatcher.js
// Scores each extracted field pair against the canonical internal fields
// required by the emission calculation engine, and returns the best match
// with confidence scores and alternative candidates.
//
// Matching steps per extracted pair:
//   1. Check OCRFeedback (learned mappings for this client/scope) → if found, confidence = 100
//   2. Score against all canonical aliases using token overlap + unit match
//   3. Return best match, alternatives, and confidence tier

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL FIELDS REGISTRY
// Keyed by scopeType → categoryName → canonicalFieldName → metadata
// aliases: human-readable strings that appear in real bills/invoices
// unit: expected unit for bonus scoring
// required: whether this field is mandatory for emission calculation
// ─────────────────────────────────────────────────────────────────────────────
const CANONICAL_FIELDS = {
  'Scope 2': {
    'Purchased Electricity': {
      consumed_electricity: {
        displayLabel: 'Electricity Consumed',
        unit: 'kwh',
        required: true,
        aliases: [
          'units consumed', 'units kwh', 'kwh', 'kilowatt hours', 'kilowatt-hours',
          'electricity consumed', 'energy consumed', 'total consumption',
          'consumption', 'power consumption', 'import units',
          'electricity', 'energy units', 'net consumed',
          'total units', 'active energy', 'net energy', 'import energy',
          'energy consumption', 'electrical consumption', 'power used',
          'total kwh', 'bill units', 'units used', 'units billed',
          // ── KSEB consumption table column values (extracted by extractConsumptionTable) ──
          // "Total Cons" is the synthetic total emitted by the table parser (highest priority)
          'total cons', 'total consumption cons',
          // Individual sub-meter cons rows: "KWH/NL Cons", "KWH/OP/I Cons" etc.
          'cons', 'consumption mm', 'cons mm', 'readings cons',
          'kwh/nl cons', 'kwh/op/i cons', 'kwh/pk/i cons', 'kwh/a/i cons',
          'kwh/nl/i cons', 'kwh/a/i', 'kwh/nl/i', 'kwh/op/i', 'kwh/pk/i',
          'kwh a i', 'kwh nl i', 'kwh op i', 'kwh pk i',
          'net consumption', 'total consumption mm', 'unit consumption',
          'curr prev cons', 'recorded consumption', 'cons recorded',
          // ── Other Indian utility bill labels (BESCOM, MSEDCL, TPDDL etc.) ──
          'unit consumed', 'units billed kwh', 'sanctioned units', 'assessed units',
          'billed units', 'recorded units', 'metered units'
          // REMOVED: 'energy charge', 'energy charges' — these are ₹ monetary charges, NOT kWh
          // REMOVED: 'meter rent', 'reading', 'unit reading' — cause wrong monetary matches
        ]
      },
      demand_kw: {
        displayLabel: 'Demand (kW)',
        unit: 'kw',
        required: false,
        aliases: [
          'demand', 'peak demand', 'maximum demand', 'kw demand',
          'sanctioned load', 'contract demand', 'power demand',
          // ── KSEB demand labels ───────────────────────────────────────────
          'c demand', 'contracted demand', 'load kw',
          'recorded demand', 'billing demand', 'chargeable demand'
          // REMOVED: 'cd' — too short, causes "ACD" (Annual Compound Deposit) to match demand
          // REMOVED: 'md' — too short, matches "cmd", "rmd" etc. incorrectly
        ]
      }
    },
    'Purchased Steam': {
      consumed_steam: {
        displayLabel: 'Steam Consumed',
        unit: 'mj',
        required: true,
        aliases: [
          'steam consumed', 'steam consumption', 'steam used', 'steam quantity',
          'steam energy', 'purchased steam'
        ]
      }
    },
    'Purchased Heating': {
      consumed_heating: {
        displayLabel: 'Heating Consumed',
        unit: 'mj',
        required: true,
        aliases: [
          'heating consumed', 'heat consumed', 'district heating', 'heat energy',
          'heating energy', 'thermal energy'
        ]
      }
    },
    'Purchased Cooling': {
      consumed_cooling: {
        displayLabel: 'Cooling Consumed',
        unit: 'mj',
        required: true,
        aliases: [
          'cooling consumed', 'district cooling', 'chilled water', 'cooling energy',
          'cooling load', 'refrigeration load'
        ]
      }
    }
  },

  'Scope 1': {
    'Stationary Combustion': {
      fuelConsumption: {
        displayLabel: 'Fuel Consumption',
        unit: 'l',
        required: true,
        aliases: [
          'fuel consumed', 'fuel consumption', 'fuel quantity', 'quantity',
          'diesel consumed', 'petrol consumed', 'hsd consumed',
          'liters', 'litres', 'fuel used', 'total fuel', 'fuel volume',
          'consumption', 'fuel dispensed', 'fuel filled'
        ]
      }
    },
    'Mobile Combustion': {
      fuelConsumption: {
        displayLabel: 'Fuel Consumption',
        unit: 'l',
        required: true,
        aliases: [
          'fuel consumed', 'fuel consumption', 'fuel quantity', 'quantity',
          'diesel', 'petrol', 'liters', 'litres', 'fuel used', 'volume',
          'consumption', 'fuel filled', 'fuel dispensed'
        ]
      }
    },
    'Fugitive Emissions': {
      activityData: {
        displayLabel: 'Refrigerant Quantity',
        unit: 'kg',
        required: true,
        aliases: [
          'refrigerant quantity', 'refrigerant used', 'refrigerant consumed',
          'refrigerant charged', 'gas charged', 'gas refilled', 'refill quantity',
          'amount added', 'charge quantity', 'kg charged', 'refrigerant weight'
        ]
      }
    },
    'Process Emission': {
      productionOutput: {
        displayLabel: 'Production Output',
        unit: 'tonnes',
        required: true,
        aliases: [
          'production output', 'output', 'production quantity', 'manufactured',
          'product quantity', 'production', 'total output', 'finished goods'
        ]
      }
    }
  },

  'Scope 3': {
    'Waste Generated in Operations': {
      wasteMass: {
        displayLabel: 'Waste Mass',
        unit: 'kg',
        required: true,
        aliases: [
          'waste quantity', 'waste weight', 'waste mass', 'total waste',
          'waste generated', 'waste collected', 'waste disposed', 'kg waste',
          'tonnes waste', 'weight', 'gross weight'
        ]
      }
    },
    'Business Travel': {
      distance: {
        displayLabel: 'Distance Travelled',
        unit: 'km',
        required: true,
        aliases: [
          'distance', 'distance travelled', 'km travelled', 'miles',
          'kilometers', 'kilometres', 'trip distance', 'journey distance'
        ]
      }
    },
    'Employee Commuting': {
      employee_commuting: {
        displayLabel: 'Commute Distance',
        unit: 'km',
        required: true,
        aliases: [
          'commute distance', 'distance', 'daily commute', 'km per day',
          'commuting distance', 'travel distance'
        ]
      }
    },
    'Upstream Transportation and Distribution': {
      distance: {
        displayLabel: 'Transport Distance',
        unit: 'km',
        required: true,
        aliases: [
          'distance', 'transport distance', 'shipping distance', 'route distance',
          'km', 'miles', 'trip distance'
        ]
      }
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// UNIT NORMALIZER
// Maps raw unit strings to a simplified token for comparison
// ─────────────────────────────────────────────────────────────────────────────
function normalizeUnit(unit) {
  if (!unit) return '';
  const u = unit.toLowerCase().trim();
  if (['kwh', 'kilowatt-hour', 'kilowatt hours', 'kilowatt-hours'].includes(u)) return 'kwh';
  if (['kw', 'kilowatt'].includes(u)) return 'kw';
  if (['l', 'litre', 'liter', 'litres', 'liters', 'ltr', 'ltrs'].includes(u)) return 'l';
  if (['kg', 'kilogram', 'kilograms'].includes(u)) return 'kg';
  if (['t', 'mt', 'tonne', 'tonnes', 'ton', 'tons'].includes(u)) return 'tonne';
  if (['m3', 'm³', 'scm', 'cubic meter', 'cubic metre'].includes(u)) return 'm3';
  if (['mmbtu', 'mmBTU'].includes(u)) return 'mmbtu';
  if (['km', 'kilometers', 'kilometres'].includes(u)) return 'km';
  if (['kl', 'kiloliter', 'kilolitre'].includes(u)) return 'kl';
  return u;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORING ENGINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tokenize a string into lowercase words.
 */
function tokenize(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * Calculate token overlap score (0-100) between two strings.
 */
function tokenOverlapScore(a, b) {
  const tokA = new Set(tokenize(a));
  const tokB = new Set(tokenize(b));
  if (tokA.size === 0 || tokB.size === 0) return 0;

  let overlap = 0;
  for (const t of tokA) {
    if (tokB.has(t)) overlap++;
  }
  // Jaccard-like but biased toward the shorter set (label is usually shorter)
  const minLen = Math.min(tokA.size, tokB.size);
  return Math.round((overlap / minLen) * 100);
}

/**
 * Score a single raw label against a single canonical field definition.
 * Returns a score 0-100.
 */
function scoreAgainstField(rawLabel, rawUnit, fieldDef) {
  const normalized = (rawLabel || '').toLowerCase().trim();
  let score = 0;

  // Exact alias match
  for (const alias of fieldDef.aliases) {
    if (normalized === alias) {
      score = 100;
      break;
    }
  }

  if (score < 100) {
    // Check if any alias is contained in the raw label or vice versa
    for (const alias of fieldDef.aliases) {
      if (normalized.includes(alias) || alias.includes(normalized)) {
        score = Math.max(score, 90);
        break;
      }
    }
  }

  if (score < 90) {
    // Token overlap with each alias
    let bestOverlap = 0;
    for (const alias of fieldDef.aliases) {
      const overlap = tokenOverlapScore(normalized, alias);
      if (overlap > bestOverlap) bestOverlap = overlap;
    }
    // Map overlap 50-100% to score 50-85
    if (bestOverlap >= 50) {
      score = Math.max(score, Math.round(50 + bestOverlap * 0.35));
    }
  }

  // Unit match bonus (+10)
  if (rawUnit && fieldDef.unit) {
    const normUnit = normalizeUnit(rawUnit);
    const expectedUnit = normalizeUnit(fieldDef.unit);
    if (normUnit === expectedUnit) score = Math.min(100, score + 10);
  }

  return score;
}

/**
 * Get the canonical fields definition for a given scope type + category.
 * Returns a flat object: { fieldName: fieldDef } or {} if not found.
 */
function getFieldsForScope(scopeType, categoryName) {
  return CANONICAL_FIELDS[scopeType]?.[categoryName] || {};
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Match extracted pairs against canonical fields for a given scope.
 *
 * @param {Array}  extractedPairs  - From universalFieldExtractor.extractAllFields()
 * @param {string} scopeType       - e.g. 'Scope 2'
 * @param {string} categoryName    - e.g. 'Purchased Electricity'
 * @param {string} clientId        - for feedback history lookup
 * @param {string} scopeIdentifier - for feedback history lookup
 * @param {Array}  feedbackHistory - Array of OCRFeedback docs (pre-fetched, optional)
 *
 * @returns {Array} enriched pairs with bestMatch and alternativeMatches
 */
function matchFields(extractedPairs, scopeType, categoryName, clientId, scopeIdentifier, feedbackHistory = []) {
  const canonicalFields = getFieldsForScope(scopeType, categoryName);
  const canonicalKeys = Object.keys(canonicalFields);

  // Build a lookup map from normalized rawLabel → learned field
  const feedbackMap = {};
  for (const fb of feedbackHistory) {
    const key = (fb.rawLabel || '').toLowerCase().trim();
    if (key) feedbackMap[key] = fb.mappedToField;
  }

  return extractedPairs.map(pair => {
    const normalizedLabel = (pair.rawLabel || '').toLowerCase().trim();

    // ── Check learned feedback first ─────────────────────────────────────────
    if (feedbackMap[normalizedLabel]) {
      const learnedField = feedbackMap[normalizedLabel];
      const fieldDef = canonicalFields[learnedField];
      return {
        ...pair,
        bestMatch: fieldDef ? {
          canonicalField: learnedField,
          displayLabel: fieldDef.displayLabel,
          confidence: 100,
          matchReason: 'Learned from previous uploads'
        } : null,
        alternativeMatches: [],
        userAction: 'pending'
      };
    }

    // ── Score against all canonical fields ───────────────────────────────────
    if (canonicalKeys.length === 0 || pair.numericValue === null) {
      // Non-numeric pair or unknown scope — no match
      return {
        ...pair,
        bestMatch: null,
        alternativeMatches: [],
        userAction: 'pending'
      };
    }

    const scores = canonicalKeys.map(fieldName => {
      const score = scoreAgainstField(pair.rawLabel, pair.rawUnit, canonicalFields[fieldName]);
      return { canonicalField: fieldName, displayLabel: canonicalFields[fieldName].displayLabel, confidence: score };
    });

    // Sort descending
    scores.sort((a, b) => b.confidence - a.confidence);

    const best = scores[0];
    const alternatives = scores.slice(1).filter(s => s.confidence >= 20);

    let matchReason = 'No match';
    if (best.confidence === 100) matchReason = 'Exact alias match';
    else if (best.confidence >= 90) matchReason = 'Alias contains label (or vice versa)';
    else if (best.confidence >= 60) matchReason = 'Token overlap match';
    else if (best.confidence > 0 && pair.rawUnit) matchReason = 'Unit match hint';

    return {
      ...pair,
      bestMatch: best.confidence >= 20 ? {
        canonicalField: best.canonicalField,
        displayLabel: best.displayLabel,
        confidence: best.confidence,
        matchReason
      } : null,
      alternativeMatches: alternatives,
      userAction: 'pending'
    };
  });
}

/**
 * Build the suggestedDataValues object from matched pairs.
 * Only includes pairs where bestMatch.confidence >= minConfidence
 * and numericValue is not null.
 *
 * @param {Array}  matchedPairs
 * @param {number} minConfidence  default 60
 * @returns {object}  e.g. { consumed_electricity: 100 }
 */
function buildSuggestedDataValues(matchedPairs, minConfidence = 60) {
  const result = {};
  for (const pair of matchedPairs) {
    if (
      pair.numericValue !== null &&
      pair.bestMatch &&
      pair.bestMatch.confidence >= minConfidence
    ) {
      const field = pair.bestMatch.canonicalField;
      // If multiple pairs map to the same field, take the highest-confidence one
      if (!result[field] || pair.bestMatch.confidence > (result[`_conf_${field}`] || 0)) {
        result[field] = pair.numericValue;
        result[`_conf_${field}`] = pair.bestMatch.confidence;
      }
    }
  }
  // Remove internal _conf_ tracking keys
  for (const k of Object.keys(result)) {
    if (k.startsWith('_conf_')) delete result[k];
  }
  return result;
}

/**
 * Get canonical field definitions for a scope (used by frontend to show dropdown options).
 */
function getCanonicalFieldOptions(scopeType, categoryName) {
  const fields = getFieldsForScope(scopeType, categoryName);
  return Object.entries(fields).map(([fieldName, def]) => ({
    value: fieldName,
    label: def.displayLabel,
    unit: def.unit,
    required: def.required
  }));
}

module.exports = {
  matchFields,
  buildSuggestedDataValues,
  getCanonicalFieldOptions,
  CANONICAL_FIELDS
};
