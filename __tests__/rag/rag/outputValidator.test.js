'use strict';

let outputValidator;

beforeAll(() => {
  outputValidator = require('../../../src/modules/rag/rag/outputValidator');
});

const sampleSection = {
  id:     'executive_summary',
  fields: [
    { id: 'intro',   type: 'generated_text' },
    { id: 'summary', type: 'generated_text' }
  ]
};

function validOutput(overrides = {}) {
  return {
    sectionId:  'executive_summary',
    fields:     { intro: 'Some introduction text.', summary: 'A summary paragraph.' },
    confidence: 0.9,
    warnings:   [],
    ...overrides
  };
}

describe('outputValidator.validateOutput', () => {
  it('passes for a valid output matching the section schema', () => {
    const { valid } = outputValidator.validateOutput(validOutput(), sampleSection);
    expect(valid).toBe(true);
  });

  it('fails when a required generated_text field is missing', () => {
    const bad = validOutput({ fields: { intro: 'Only intro, missing summary.' } });
    const { valid, errors } = outputValidator.validateOutput(bad, sampleSection);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('fails when confidence is greater than 1', () => {
    const bad = validOutput({ confidence: 1.5 });
    const { valid } = outputValidator.validateOutput(bad, sampleSection);
    expect(valid).toBe(false);
  });

  it('fails when confidence is negative', () => {
    const bad = validOutput({ confidence: -0.1 });
    const { valid } = outputValidator.validateOutput(bad, sampleSection);
    expect(valid).toBe(false);
  });

  it('passes when output contains extra fields (not additionalProperties: false on fields)', () => {
    const out = validOutput({ fields: { intro: 'text', summary: 'text', extraField: 'extra' } });
    const { valid } = outputValidator.validateOutput(out, sampleSection);
    expect(valid).toBe(true);
  });
});

describe('outputValidator.parseRawOutput', () => {
  it('parses a plain JSON string', () => {
    const raw = JSON.stringify(validOutput());
    const result = outputValidator.parseRawOutput(raw);
    expect(result.sectionId).toBe('executive_summary');
  });

  it('parses output wrapped in markdown code block', () => {
    const raw = '```json\n' + JSON.stringify(validOutput()) + '\n```';
    const result = outputValidator.parseRawOutput(raw);
    expect(result.sectionId).toBe('executive_summary');
  });

  it('returns the object as-is when already parsed', () => {
    const obj    = validOutput();
    const result = outputValidator.parseRawOutput(obj);
    expect(result).toBe(obj);
  });
});
