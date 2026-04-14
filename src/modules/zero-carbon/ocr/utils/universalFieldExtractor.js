// utils/OCR/universalFieldExtractor.js
// Extracts ALL key-value pairs from OCR text without pre-filtering.
// Unlike fieldExtractor.js (which only looks for pre-defined field names),
// this extractor returns everything it finds in the image and lets the
// model matcher decide what is relevant.
//
// Return shape:
// {
//   extractedPairs: [
//     {
//       rawLabel: string,       // label as found in the image
//       rawValue: string,       // value as found (string)
//       rawUnit: string|null,   // unit token if detected (e.g. "kWh", "kg", "L")
//       numericValue: number|null  // parsed float or null if non-numeric
//     }
//   ],
//   date: string|null,          // DD/MM/YYYY if found
//   time: string,               // HH:mm:ss
//   rawText: string
// }

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// UNIT TOKENS — used to detect and strip unit from numeric values
// ─────────────────────────────────────────────────────────────────────────────
const UNIT_TOKENS = [
  // Electricity
  'kwh', 'kw', 'mwh', 'gwh', 'wh',
  // Fuel / Volume
  'litres', 'liters', 'ltr', 'ltrs', 'l', 'ml',
  'gallons', 'gal',
  // Gas
  'scm', 'm3', 'm³', 'mmbtu', 'mmBTU', 'btu',
  // Mass
  'kg', 'kilograms', 'kilogram', 'grams', 'g',
  'tonnes', 'tonne', 'mt', 'ton', 'tons',
  'lbs', 'lb',
  // Water
  'kl', 'kilolitres', 'kiloliters',
  // Currency / financial — we extract but mark separately
  'inr', 'usd', 'eur', 'gbp', 'rs', '₹', '$', '€', '£',
  // Generic
  'units', 'pcs', 'nos', '%',
].map(u => u.toLowerCase());

// Date patterns (same as fieldExtractor)
const DATE_PATTERNS = [
  /(?:invoice\s+date|bill\s+date|date|period|as\s+of)[:\s]+(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
  /(?:invoice\s+date|bill\s+date|date|period|as\s+of)[:\s]+(\d{1,2}\s+\w+\s+\d{4})/i,
  /\b(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4})\b/,
  /\b(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})\b/,
  /\b(\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{4})\b/i
];

const TIME_PATTERNS = [
  /\b(\d{1,2}:\d{2}:\d{2})\b/,
  /\b(\d{1,2}:\d{2}\s*(?:am|pm))\b/i,
  /\b(\d{1,2}:\d{2})\b/
];

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function parseNumber(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/[,\s₹$€£]/g, '');
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : null;
}

function normalizeLabel(label) {
  return label
    .replace(/[:\-–_\/\\|]+$/, '')   // strip trailing punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

function detectUnit(token) {
  const t = token.toLowerCase().replace(/[^a-z₹$€£%³]/g, '');
  return UNIT_TOKENS.includes(t) ? token : null;
}

function extractDate(text) {
  for (const pat of DATE_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1]) {
      const raw = m[1].trim();
      const normalised = raw.replace(/[-\.]/g, '/');
      if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(normalised)) {
        const [y, mo, d] = normalised.split('/');
        return `${d.padStart(2, '0')}/${mo.padStart(2, '0')}/${y}`;
      }
      return normalised;
    }
  }
  return null;
}

function extractTime(text) {
  for (const pat of TIME_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1]) return m[1].trim();
  }
  return '00:00:00';
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTRACTION STRATEGIES
// Each returns an array of { rawLabel, rawValue, rawUnit, numericValue }
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strategy 0: Consumption table parser — HIGHEST PRIORITY
 *
 * Handles KSEB-style multi-tariff electricity bills where consumption is
 * stored in a columnar table like:
 *
 *   Unit      Curr   Prev   Cons   Avg
 *   KWH/NL    6223   5959   264    320
 *   KWH/OP/I  6513   6256   257    320
 *   KWH/PK/I  3011   2875   136    320
 *
 * Normal extractors pick the FIRST number per row (Curr = 6223) which is the
 * meter register reading, NOT the billing-period consumption.
 * This strategy finds the "Cons" column and extracts only that value.
 *
 * It also emits a synthetic "Total Cons" pair summing all sub-meter rows so
 * the model matcher can pick it directly as `consumed_electricity`.
 *
 * Works for any columnar table whose header contains both "prev" and "cons"
 * (catches KSEB MM, NL, OP, PK tariff tables, MSEDCL, BESCOM etc.).
 */
function extractConsumptionTable(text) {
  const results = [];
  const lines   = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line    = lines[i].trim();
    const lineLow = line.toLowerCase();

    // Header must contain both "prev" and "cons" to be a consumption table
    if (!lineLow.includes('curr') || !lineLow.includes('prev') || !lineLow.includes('cons')) continue;

    // Split header by tab OR 2+ spaces
    const headers  = line.split(/\t|\s{2,}/).map(h => h.trim().toLowerCase()).filter(Boolean);
    const consIdx  = headers.findIndex(h => h === 'cons' || h.startsWith('cons'));
    if (consIdx < 2) continue;   // Cons must be at least the 3rd column (after Unit, Curr)

    // ── Scan following lines for data rows ───────────────────────────────────
    let totalCons = 0;
    let rowCount  = 0;

    for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
      const rowLine = lines[j].trim();
      if (!rowLine) continue;

      // Split same way as header
      const cells = rowLine.split(/\t|\s{2,}/).map(c => c.trim()).filter(Boolean);
      if (cells.length < consIdx + 1) continue;

      // Row label must look like a meter-unit identifier (has letters + digits/slash)
      // e.g. "KWH/NL", "KWH/OP/I", "KWH/PK/I", "EL/1", "MD" etc.
      const unitLabel = cells[0];
      if (unitLabel.length < 2 || !/[A-Z]/i.test(unitLabel)) continue;

      // Cons value must be a positive integer (kWh consumption is always > 0)
      const consVal = parseFloat(cells[consIdx]);
      if (!isFinite(consVal) || consVal <= 0) continue;

      // Extra sanity: Curr and Prev should also be numeric (not a junk row)
      const currVal = parseFloat(cells[1] || '');
      if (!isFinite(currVal) || currVal <= 0) continue;

      results.push({
        rawLabel:     `${unitLabel} Cons`,
        rawValue:     String(consVal),
        rawUnit:      'kWh',
        numericValue: consVal
      });

      totalCons += consVal;
      rowCount++;
    }

    // ── Emit synthetic total ──────────────────────────────────────────────────
    if (rowCount >= 1) {
      // "Total Cons" is placed FIRST so deduplication keeps it (it has the highest
      // priority) and the model matcher picks it as consumed_electricity.
      results.unshift({
        rawLabel:     'Total Cons',
        rawValue:     String(totalCons),
        rawUnit:      'kWh',
        numericValue: totalCons
      });
    }

    break;  // Only parse the first consumption table found
  }

  return results;
}

/**
 * Strategy 1: Colon-separated pattern
 * Matches "Label: value [unit]" or "Label : value [unit]"
 */
function extractColonPattern(text) {
  const results = [];
  // Match label followed by colon, then a value (possibly with unit)
  const re = /^([A-Za-z][A-Za-z0-9 ,.\-()/]*?)\s*:\s*([^\n\r]{1,80})/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const rawLabel = normalizeLabel(m[1]);
    const valueRaw = m[2].trim();
    if (!rawLabel || rawLabel.length < 2) continue;

    // Try to extract numeric + optional unit from valueRaw
    const numMatch = valueRaw.match(/^([₹$€£]?\s*[\d,]+\.?\d*)\s*([A-Za-z₹$€£%³°]+)?/);
    if (numMatch) {
      const numericValue = parseNumber(numMatch[1]);
      const rawUnit = numMatch[2] ? detectUnit(numMatch[2]) : null;
      results.push({
        rawLabel,
        rawValue: valueRaw.slice(0, 100),
        rawUnit: rawUnit || numMatch[2] || null,
        numericValue
      });
    } else if (valueRaw.length <= 80) {
      // Non-numeric pair (e.g. customer name, account number)
      results.push({
        rawLabel,
        rawValue: valueRaw.slice(0, 100),
        rawUnit: null,
        numericValue: null
      });
    }
  }
  return results;
}

/**
 * Strategy 2: Dash/hyphen-separated pattern
 * Matches "Label - value [unit]" or "Label – value"
 */
function extractDashPattern(text) {
  const results = [];
  const re = /^([A-Za-z][A-Za-z0-9 ,.()/]*?)\s+[-–]\s+([^\n\r]{1,80})/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const rawLabel = normalizeLabel(m[1]);
    const valueRaw = m[2].trim();
    if (!rawLabel || rawLabel.length < 2) continue;

    const numMatch = valueRaw.match(/^([₹$€£]?\s*[\d,]+\.?\d*)\s*([A-Za-z₹$€£%³°]+)?/);
    if (numMatch) {
      const numericValue = parseNumber(numMatch[1]);
      const rawUnit = numMatch[2] ? detectUnit(numMatch[2]) : null;
      results.push({
        rawLabel,
        rawValue: valueRaw.slice(0, 100),
        rawUnit: rawUnit || numMatch[2] || null,
        numericValue
      });
    }
  }
  return results;
}

/**
 * Strategy 3: Labeled number pattern
 * Matches any line where a recognisable label is followed (on same line) by a number.
 * Useful for table rows where colon/dash may be absent.
 */
function extractLabeledNumbers(text) {
  const results = [];
  // Label (at least 3 chars, alpha) then whitespace then number [unit]
  const re = /([A-Za-z][A-Za-z0-9 ,.()/]{2,50})\s{1,10}([₹$€£]?\s*[\d,]+\.?\d*)\s*([A-Za-z₹$€£%³°]{0,10})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const rawLabel = normalizeLabel(m[1]);
    const numericValue = parseNumber(m[2]);
    if (!rawLabel || rawLabel.length < 3 || numericValue === null) continue;

    const rawUnit = m[3] ? (detectUnit(m[3]) || m[3] || null) : null;
    results.push({
      rawLabel,
      rawValue: m[2].trim() + (m[3] ? ' ' + m[3] : ''),
      rawUnit,
      numericValue
    });
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// DEDUPLICATION
// Keep the first occurrence of each normalized label.
// If a label appears in multiple strategies, prefer colon pattern over others.
// ─────────────────────────────────────────────────────────────────────────────
function deduplicatePairs(pairs) {
  const seen = new Map(); // normalized label → index in result
  const result = [];
  for (const pair of pairs) {
    const key = pair.rawLabel.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.set(key, result.length);
      result.push(pair);
    } else {
      // If the existing entry has no numericValue but this one does, replace
      const existingIdx = seen.get(key);
      if (result[existingIdx].numericValue === null && pair.numericValue !== null) {
        result[existingIdx] = pair;
      }
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract ALL key-value pairs from OCR text.
 * Returns every pair found — numeric and non-numeric alike.
 * The model matcher decides which are relevant to the emission scope.
 *
 * @param {string} text  Raw OCR output
 * @returns {{ extractedPairs, date, time, rawText }}
 */
function extractAllFields(text) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    return { extractedPairs: [], date: null, time: '00:00:00', rawText: '' };
  }

  const date = extractDate(text);
  const time = extractTime(text);

  // Run all strategies and combine.
  // Strategy 0 (consumption table) runs FIRST and has highest deduplication priority —
  // it correctly extracts the "Cons" column from multi-row meter tables like KSEB bills.
  const tablePairs   = extractConsumptionTable(text);  // ← MUST be first
  const colonPairs   = extractColonPattern(text);
  const dashPairs    = extractDashPattern(text);
  const labeledPairs = extractLabeledNumbers(text);

  // Priority: table > colon > dash > labeled
  const combined = [...tablePairs, ...colonPairs, ...dashPairs, ...labeledPairs];
  const extractedPairs = deduplicatePairs(combined);

  return {
    extractedPairs,
    date,
    time,
    rawText: text
  };
}

module.exports = { extractAllFields };
