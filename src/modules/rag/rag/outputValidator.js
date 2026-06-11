'use strict';

const Ajv = require('ajv');
const ajv = new Ajv({ allErrors: true });

function buildOutputSchema(section) {
  const generatedFieldIds = (section.fields || [])
    .filter(f => f.type === 'generated_text')
    .map(f => f.id);

  const fieldsProperties = {};
  for (const id of generatedFieldIds) {
    fieldsProperties[id] = { type: 'string' };
  }

  return {
    type: 'object',
    required: ['sectionId', 'fields', 'confidence', 'warnings'],
    properties: {
      sectionId:  { type: 'string' },
      fields: {
        type: 'object',
        properties: fieldsProperties,
        required: generatedFieldIds
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      warnings:   { type: 'array', items: { type: 'string' } }
    }
  };
}

function validateOutput(parsed, section) {
  const schema   = buildOutputSchema(section);
  const validate = ajv.compile(schema);
  const valid    = validate(parsed);

  if (valid) return { valid: true, errors: [] };
  return {
    valid:  false,
    errors: validate.errors.map(e => `${e.instancePath || e.schemaPath} ${e.message}`)
  };
}

function parseRawOutput(raw) {
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    // Try to extract JSON from markdown code block
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try { return JSON.parse(match[1]); } catch {}
    }
    throw new Error(`Failed to parse LLM output as JSON: ${raw.substring(0, 200)}`);
  }
}

module.exports = { validateOutput, parseRawOutput, buildOutputSchema };
