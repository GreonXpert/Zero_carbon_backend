'use strict';

const Ajv = require('ajv');
const ajv = new Ajv({ allErrors: true });

const FIELD_TYPES = ['numeric', 'text', 'generated_text', 'date', 'boolean', 'select', 'multi_select'];
const SECTION_TYPES = ['narrative', 'data_table', 'chart', 'combined', 'divider', 'appendix'];

const templateStructureSchema = {
  type: 'object',
  required: ['meta', 'sections'],
  properties: {
    meta: {
      type: 'object',
      required: ['name', 'type'],
      properties: {
        name:        { type: 'string', minLength: 1 },
        description: { type: 'string' },
        type:        { type: 'string', enum: ['emission_report', 'brsr', 'gri', 'issb', 'csrd', 'esg_summary', 'custom'] },
        platform:    { type: 'string', enum: ['zero_carbon', 'esglink', 'both'] },
        standards:   { type: 'array', items: { type: 'string' } },
        tags:        { type: 'array', items: { type: 'string' } }
      }
    },
    layout: {
      type: 'object',
      properties: {
        pageSize:       { type: 'string', enum: ['A4', 'Letter'] },
        orientation:    { type: 'string', enum: ['portrait', 'landscape'] },
        coverPage:      { type: 'boolean' },
        tableOfContents:{ type: 'boolean' },
        sectionNumbering:{ type: 'boolean' }
      }
    },
    dataMappings: {
      type: 'object',
      properties: {
        platform: { type: 'string' },
        bindings: { type: 'object' }
      }
    },
    ragConfig: {
      type: 'object',
      properties: {
        referenceDocuments:   { type: 'array', items: { type: 'string' } },
        generationModel:      { type: 'string' },
        temperature:          { type: 'number', minimum: 0, maximum: 1 },
        maxTokensPerSection:  { type: 'number', minimum: 100 }
      }
    },
    sections: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'title', 'type', 'order'],
        properties: {
          id:       { type: 'string', minLength: 1 },
          title:    { type: 'string', minLength: 1 },
          type:     { type: 'string', enum: SECTION_TYPES },
          order:    { type: 'number' },
          required: { type: 'boolean' },
          level:    { type: 'number', enum: [1, 2, 3] },
          parentId: { type: ['string', 'null'] },
          fields:   {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'type'],
              properties: {
                id:          { type: 'string' },
                type:        { type: 'string', enum: FIELD_TYPES },
                label:       { type: 'string' },
                dataBinding: { type: ['string', 'null'] },
                required:    { type: 'boolean' },
                editable:    { type: 'boolean' },
                fallback:    { type: 'string' }
              }
            }
          },
          generationPrompt: { type: 'string' },
          ragContext: {
            type: 'object',
            properties: {
              enabled:         { type: 'boolean' },
              filterStandards: { type: 'array', items: { type: 'string' } },
              filterTags:      { type: 'array', items: { type: 'string' } },
              topK:            { type: 'number', minimum: 1, maximum: 20 }
            }
          }
        }
      }
    }
  }
};

const validate = ajv.compile(templateStructureSchema);

function validateTemplateSchema(structure) {
  const valid = validate(structure);
  if (valid) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: validate.errors.map(e => `${e.instancePath} ${e.message}`)
  };
}

function extractSummary(structure) {
  const sections = structure.sections || [];
  let fieldCount = 0;
  let hasTables  = false;
  let hasCharts  = false;

  for (const sec of sections) {
    fieldCount += (sec.fields || []).length;
    if ((sec.tables || []).length)  hasTables = true;
    if ((sec.charts || []).length)  hasCharts = true;
  }

  const dataPlatforms = structure.dataMappings?.platform
    ? [structure.dataMappings.platform]
    : [];
  const standards = structure.meta?.standards || [];

  return { sectionCount: sections.length, fieldCount, hasTables, hasCharts, dataPlatforms, standards };
}

module.exports = { validateTemplateSchema, extractSummary };
