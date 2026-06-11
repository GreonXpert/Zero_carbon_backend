'use strict';

let promptBuilder;

beforeAll(() => {
  promptBuilder = require('../../../src/modules/rag/rag/promptBuilder');
});

const sampleSection = {
  id:               'executive_summary',
  title:            'Executive Summary',
  level:             2,
  type:             'narrative',
  generationPrompt: 'Write a concise executive summary for the organisation.',
  fields: [
    { id: 'intro',     label: 'Introduction',       type: 'generated_text', fallback: 'No introduction available.' },
    { id: 'total_co2', label: 'Total CO2 Emissions', type: 'numeric',        unit: 'tCO2e' }
  ],
  ragContext: { enabled: false }
};

const resolvedData = {
  'org.name':            'Acme Corp',
  'org.reportingYear':   2024,
  'emissions.scope1.total': 12345.6
};

const templateMeta = {
  type:    'emission_report',
  version: 1
};

describe('promptBuilder.buildSectionPrompt', () => {
  it('returns both system and user keys', () => {
    const result = promptBuilder.buildSectionPrompt(sampleSection, resolvedData, [], templateMeta);
    expect(result).toHaveProperty('system');
    expect(result).toHaveProperty('user');
    expect(typeof result.system).toBe('string');
    expect(typeof result.user).toBe('string');
  });

  it('replaces {{org.name}} placeholder in user prompt', () => {
    const { user } = promptBuilder.buildSectionPrompt(sampleSection, resolvedData, [], templateMeta);
    expect(user).toContain('Acme Corp');
  });

  it('includes sectionId in the user prompt', () => {
    const { user } = promptBuilder.buildSectionPrompt(sampleSection, resolvedData, [], templateMeta);
    expect(user).toContain('executive_summary');
  });

  it('includes the generationPrompt text in user prompt', () => {
    const { user } = promptBuilder.buildSectionPrompt(sampleSection, resolvedData, [], templateMeta);
    expect(user).toContain('executive summary');
  });

  it('uses field fallback when binding is null', () => {
    const data = { ...resolvedData, 'org.name': null };
    const { user } = promptBuilder.buildSectionPrompt(sampleSection, data, [], templateMeta);
    // Should not crash; fallback value or placeholder should be used
    expect(typeof user).toBe('string');
  });

  it('includes retrieved context when provided', () => {
    // promptBuilder receives a pre-formatted string (ragService calls formatChunks before passing here)
    const formattedContext = '[1] GHG Protocol — Scope 1\nGHG Protocol scope 1 includes direct emissions from owned sources.';
    const { user } = promptBuilder.buildSectionPrompt(sampleSection, resolvedData, formattedContext, templateMeta);
    expect(user).toContain('GHG Protocol');
  });
});
