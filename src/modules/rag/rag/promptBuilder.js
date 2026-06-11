'use strict';

const SYSTEM_PROMPTS = {
  emission_report: `You are a professional sustainability report writer specialising in GHG Emission Reports. You write accurate, regulatory-compliant content based strictly on the data provided. You NEVER invent numbers or facts. You follow the exact JSON output schema provided. Always output valid JSON only.`,
  brsr: `You are a professional sustainability report writer specialising in SEBI BRSR reports. You write accurate, regulatory-compliant content based strictly on the data provided. Use formal regulatory language appropriate for SEBI filings. You NEVER invent data. Always output valid JSON only.`,
  gri: `You are a professional sustainability report writer specialising in GRI Standards reports. You write accurate content following GRI Universal and Topic Standards. You NEVER invent data. Always output valid JSON only.`,
  default: `You are a professional sustainability report writer. You write accurate, fact-based content based strictly on the data provided. You NEVER invent numbers or facts. Always output valid JSON only.`
};

function interpolate(template, data) {
  if (!template) return '';
  return template.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    const val = getValueForKey(data, key.trim());
    return val !== undefined && val !== null ? String(val) : `[${key.trim()}: not available]`;
  });
}

/**
 * Resolve a key from a flat dot-notation map (e.g. { "org.name": "Acme" })
 * OR a nested object (e.g. { org: { name: "Acme" } }).
 * Always tries direct key first so flat maps like orgData["org.name"] work correctly.
 */
function getValueForKey(obj, key) {
  if (!obj || !key) return undefined;
  // 1. Direct exact-key lookup — handles flat keys like "org.name", "emissions.total"
  if (obj[key] !== undefined) return obj[key];
  // 2. Nested path — handles genuinely nested objects
  return key.split('.').reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj);
}

// Keep getNestedValue as an alias for backwards-compat with any other callers
const getNestedValue = getValueForKey;

function resolveFieldsForSection(section, resolvedData) {
  const result = {};
  for (const field of section.fields || []) {
    // Support both 'binding' (current template format) and legacy 'dataBinding'
    const bindingKey = field.binding || field.dataBinding;
    if (bindingKey && field.type !== 'generated_text') {
      const val = getValueForKey(resolvedData, bindingKey);
      result[field.id] = val !== undefined ? val : (field.fallback || null);
    }
  }
  return result;
}

function buildQueryText(section, resolvedData) {
  const parts = [section.title];
  if (section.generationPrompt) parts.push(section.generationPrompt.substring(0, 200));
  // Add a few key data values as context
  const dataSnippets = Object.entries(resolvedData)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .slice(0, 5)
    .map(([k, v]) => `${k}: ${v}`);
  if (dataSnippets.length) parts.push(dataSnippets.join(', '));
  return parts.join('. ');
}

/**
 * Format a resolved data value for display in the prompt.
 * Arrays (byCategory) are summarised as count; objects are JSON; primitives are plain.
 */
function formatDataValue(v) {
  if (v === null || v === undefined) return 'N/A';
  if (Array.isArray(v)) {
    if (v.length === 0) return '(no entries)';
    // Show first few items so the AI understands the shape
    const preview = v.slice(0, 5).map(item =>
      typeof item === 'object' ? `${item.category || item.name || ''}: ${item.value ?? item.CO2e ?? ''}` : String(item)
    ).join(', ');
    return `[${preview}${v.length > 5 ? ` ... +${v.length - 5} more` : ''}]`;
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function buildSectionPrompt(section, resolvedData, retrievedContext, templateMeta) {
  const templateType  = templateMeta?.type || 'default';
  const systemPrompt  = SYSTEM_PROMPTS[templateType] || SYSTEM_PROMPTS.default;

  const generatedFields = (section.fields || [])
    .filter(f => f.type === 'generated_text')
    .map(f => f.id);

  const interpolatedPrompt = interpolate(section.generationPrompt || '', resolvedData);

  const outputSchema = {
    sectionId:  section.id,
    fields:     Object.fromEntries(generatedFields.map(id => [id, '<generated text here>'])),
    confidence: 0.0,
    warnings:   []
  };

  // ── Build the full emission data context ──────────────────────────────────────
  // Pass ALL resolved bindings to the AI — not just field-specific ones.
  // This ensures the AI always has total emissions, scope totals, etc. even if
  // the section fields don't have explicit bindings.
  const LABEL_MAP = {
    'org.name':                   'Organisation Name',
    'org.reportingYear':          'Reporting Year',
    'org.country':                'Country',
    'org.industry':               'Industry',
    'org.baselineYear':           'Baseline Year',
    'emissions.total':            'Total GHG Emissions (tCO2e)',
    'emissions.scope1.total':     'Scope 1 Total (tCO2e)',
    'emissions.scope2.total':     'Scope 2 Total (tCO2e)',
    'emissions.scope2.locationBased': 'Scope 2 Location-Based (tCO2e)',
    'emissions.scope2.marketBased':   'Scope 2 Market-Based (tCO2e)',
    'emissions.scope3.total':     'Scope 3 Total (tCO2e)',
    'emissions.scope1.byCategory':'Scope 1 By Category',
    'emissions.scope2.byCategory':'Scope 2 By Category',
    'emissions.scope3.byCategory':'Scope 3 By Category',
    'emissions.allCategories':    'All Categories',
  };

  const allDataLines = Object.entries(resolvedData)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([key, val]) => {
      const label = LABEL_MAP[key] || key;
      return `  ${label}: ${formatDataValue(val)}`;
    });

  const userPrompt = [
    `## ORGANISATION & EMISSION DATA`,
    allDataLines.length > 0
      ? allDataLines.join('\n')
      : '  (no data available — use general knowledge to write the section)',
    ``,
    `## SECTION TO WRITE`,
    `Section ID: ${section.id}`,
    `Section Title: ${section.title}`,
    `Report Type: ${templateMeta?.name || templateType}`,
    `Fields to generate: ${generatedFields.join(', ') || '(none)'}`,
    ``,
    retrievedContext ? `## RELEVANT STANDARD CONTEXT (GHG Protocol / IPCC)\n${retrievedContext}\n` : '',
    `## WRITING INSTRUCTION`,
    interpolatedPrompt || `Write the "${section.title}" section for this sustainability report. Use the emission data above. Be specific with numbers.`,
    ``,
    `## IMPORTANT RULES`,
    `- Use the exact numbers from ORGANISATION & EMISSION DATA above. Do NOT say data is unavailable if it is listed above.`,
    `- Write in professional sustainability report language.`,
    `- Do not invent data that is not provided.`,
    ``,
    `## OUTPUT FORMAT`,
    `Return ONLY valid JSON — no markdown fences, no explanation. Exact shape:`,
    JSON.stringify(outputSchema, null, 2)
  ].filter(Boolean).join('\n');

  return { system: systemPrompt, user: userPrompt };
}

module.exports = { buildSectionPrompt, buildQueryText, interpolate };
