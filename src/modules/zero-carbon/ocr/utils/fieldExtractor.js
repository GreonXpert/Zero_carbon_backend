// utils/OCR/fieldExtractor.js
// Rule-based extraction of emission-relevant numeric values from OCR text.
// Maps raw text into the dataValues format expected by saveOneEntry.
//
// IMPORTANT: Field keys here MUST match the canonical internal names used by
// normalizeDataPayload() and emissionCalculationController.js. Using any other
// name will cause the emission calculation to receive 0 for that field.

// ─────────────────────────────────────────────────────────────────────────────
// PATTERN REGISTRY
// Each key is a scope/activity category.
// Each value is an object of { canonicalFieldName: [regex, ...] }.
// The extractor tries each regex in order and takes the first match.
//
// rawFieldName is stored alongside for UI display / model-matching transparency.
// ─────────────────────────────────────────────────────────────────────────────
const FIELD_PATTERNS = {
  electricity: {
    // Canonical name: consumed_electricity (Scope 2, Purchased Electricity)
    consumed_electricity: [
      /(\d[\d,]*\.?\d*)\s*(?:kwh|kWh|KWh|kilowatt.?hours?)/i,
      /(?:total\s+consumption|consumption|units\s+consumed|usage)[:\s]+(\d[\d,]*\.?\d*)/i,
      /(?:electricity|power)[:\s]+(\d[\d,]*\.?\d*)/i,
      /(?:import\s+units|net\s+consumed|reading)[:\s]+(\d[\d,]*\.?\d*)/i
    ],
    demand_kw: [
      /(\d[\d,]*\.?\d*)\s*kW\b(?!h)/i,
      /(?:demand|peak\s+demand)[:\s]+(\d[\d,]*\.?\d*)/i
    ]
  },

  fuel: {
    // Canonical name: fuelConsumption (Scope 1, Stationary/Mobile Combustion)
    fuelConsumption: [
      /(\d[\d,]*\.?\d*)\s*(?:litres?|liters?|ltr?s?)\b/i,
      /(\d[\d,]*\.?\d*)\s*(?:kg|kilograms?)\b/i,
      /(?:quantity|volume|fill(?:ed)?|fuel\s+consumed?)[:\s]+(\d[\d,]*\.?\d*)/i
    ],
    amount_inr: [
      /(?:amount|total|rs\.?\s*|inr\s*|₹\s*)(\d[\d,]*\.?\d*)/i
    ]
  },

  natural_gas: {
    // Canonical name: fuelConsumption (natural gas is treated as fuel in Scope 1)
    fuelConsumption: [
      /(\d[\d,]*\.?\d*)\s*(?:scm|m3|m³|cubic\s+met(?:re|er)s?)\b/i,
      /(\d[\d,]*\.?\d*)\s*(?:mmbtu|mmBTU|MMBTU)\b/i,
      /(?:gas\s+consumed?|consumption)[:\s]+(\d[\d,]*\.?\d*)/i
    ]
  },

  refrigerant: {
    // Canonical name: activityData (Scope 1, Fugitive Emissions)
    activityData: [
      /(\d[\d,]*\.?\d*)\s*(?:kg|kilograms?)\b/i,
      /(?:refilled?|recharged?|amount\s+added)[:\s]+(\d[\d,]*\.?\d*)/i
    ]
  },

  water: {
    quantity_kl: [
      /(\d[\d,]*\.?\d*)\s*(?:kl|kilolitres?|kiloliters?|m3|m³|cubic\s+met(?:re|er)s?)\b/i,
      /(?:water\s+consumed?|consumption)[:\s]+(\d[\d,]*\.?\d*)/i
    ],
    quantity_liters: [
      /(\d[\d,]*\.?\d*)\s*(?:litres?|liters?|ltr?s?)\b/i
    ]
  },

  waste: {
    // Canonical name: wasteMass (Scope 3, Waste)
    wasteMass: [
      /(\d[\d,]*\.?\d*)\s*(?:kg|kilograms?)\b/i,
      /(\d[\d,]*\.?\d*)\s*(?:(?:metric\s+)?tonnes?|mt)\b/i,
      /(?:waste\s+weight|weight)[:\s]+(\d[\d,]*\.?\d*)/i
    ]
  },

  default: {
    value: [
      /(?:total|amount|quantity|reading|consumption|usage|output)[:\s]+(\d[\d,]*\.?\d*)/i,
      /(\d[\d,]*\.\d+)/ // decimal number as last resort
    ]
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DATE / TIME PATTERNS
// ─────────────────────────────────────────────────────────────────────────────
const DATE_PATTERNS = [
  // Explicit labels first
  /(?:invoice\s+date|bill\s+date|date|period|as\s+of)[:\s]+(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
  /(?:invoice\s+date|bill\s+date|date|period|as\s+of)[:\s]+(\d{1,2}\s+\w+\s+\d{4})/i,
  // Plain date formats
  /\b(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4})\b/,
  /\b(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})\b/, // ISO
  /\b(\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{4})\b/i
];

const TIME_PATTERNS = [
  /\b(\d{1,2}:\d{2}:\d{2})\b/,            // HH:mm:ss
  /\b(\d{1,2}:\d{2}\s*(?:am|pm))\b/i,     // HH:mm AM/PM
  /\b(\d{1,2}:\d{2})\b/                    // HH:mm
];

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sanitise a matched numeric string: remove commas, currency symbols, parse float.
 */
function sanitiseNumber(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/[,\s₹$€£]/g, '');
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : null;
}

/**
 * Try to extract a date string from text.
 * Returns a DD/MM/YYYY string or null.
 */
function extractDate(text) {
  for (const pat of DATE_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1]) {
      const raw = m[1].trim();
      // Normalise separators
      const normalised = raw.replace(/[-\.]/g, '/');
      // Detect ISO format (YYYY/MM/DD) and flip to DD/MM/YYYY
      if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(normalised)) {
        const [y, mo, d] = normalised.split('/');
        return `${d.padStart(2, '0')}/${mo.padStart(2, '0')}/${y}`;
      }
      return normalised;
    }
  }
  return null;
}

/**
 * Try to extract a time string from text.
 * Returns HH:mm:ss string or '00:00:00'.
 */
function extractTime(text) {
  for (const pat of TIME_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1]) return m[1].trim();
  }
  return '00:00:00';
}

/**
 * Map a scope object to a category key for the FIELD_PATTERNS registry.
 */
function mapScopeToCategory(scope) {
  const cat = ((scope?.category || '') + ' ' + (scope?.categoryName || '') + ' ' + (scope?.scopeIdentifier || '')).toLowerCase();

  if (cat.includes('electric') || cat.includes('power') || cat.includes('kwh')) return 'electricity';
  if (cat.includes('fuel') || cat.includes('diesel') || cat.includes('petrol')
    || cat.includes('cng') || cat.includes('lpg') || cat.includes('gasoline')) return 'fuel';
  if (cat.includes('natural gas') || cat.includes('gas') || cat.includes('mmbtu')) return 'natural_gas';
  if (cat.includes('refrigerant') || cat.includes('coolant') || cat.includes('hfc') || cat.includes('hcfc')) return 'refrigerant';
  if (cat.includes('water')) return 'water';
  if (cat.includes('waste')) return 'waste';

  return 'default';
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract emission-relevant field values from OCR text.
 * Field keys in dataValues use the CANONICAL internal names required by
 * normalizeDataPayload() and emissionCalculationController.js.
 *
 * @param {string} text           - Raw OCR output
 * @param {string} category       - Category key from mapScopeToCategory()
 * @returns {{ dataValues, date, time, confidence, warnings, rawText }}
 */
function extractFields(text, category) {
  const warnings = [];
  const dataValues = {};

  if (!text || typeof text !== 'string' || !text.trim()) {
    return { dataValues, date: null, time: '00:00:00', confidence: 0, warnings: ['Empty OCR text'], rawText: '' };
  }

  // Pass 1 — date/time
  const date = extractDate(text);
  const time = extractTime(text);

  if (!date) warnings.push('Could not extract a date from the document');

  // Pass 2 — scope-specific fields
  const patterns = FIELD_PATTERNS[category] || FIELD_PATTERNS['default'];
  const fieldNames = Object.keys(patterns);
  let matchedCount = 0;

  for (const fieldName of fieldNames) {
    const regexList = patterns[fieldName];
    for (const regex of regexList) {
      const m = text.match(regex);
      if (m && m[1]) {
        const num = sanitiseNumber(m[1]);
        if (num !== null) {
          dataValues[fieldName] = num;
          matchedCount++;
          break;
        }
      }
    }
  }

  const confidence = fieldNames.length > 0
    ? Math.round((matchedCount / fieldNames.length) * 100)
    : 0;

  if (confidence < parseInt(process.env.OCR_MIN_CONFIDENCE || '30', 10)) {
    warnings.push(`Low extraction confidence (${confidence}%). Please verify the extracted values.`);
  }

  return {
    dataValues,
    date,
    time,
    confidence,
    warnings,
    rawText: text
  };
}

module.exports = { extractFields, mapScopeToCategory };
