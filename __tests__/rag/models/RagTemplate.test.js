'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod;
let RagTemplate;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  RagTemplate = require('../../../src/modules/rag/models/RagTemplate');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await RagTemplate.deleteMany({});
});

function validTemplate(overrides = {}) {
  return {
    name:        'GHG Protocol Report',
    slug:        'ghg-protocol-report',
    type:        'emission_report',
    platform:    'zero_carbon',
    status:      'draft',
    createdBy:   new mongoose.Types.ObjectId(),
    ...overrides
  };
}

describe('RagTemplate model', () => {
  it('creates a valid template successfully', async () => {
    const doc = await RagTemplate.create(validTemplate());
    expect(doc._id).toBeDefined();
    expect(doc.slug).toBe('ghg-protocol-report');
  });

  it('defaults status to draft', async () => {
    const doc = await RagTemplate.create(validTemplate({ status: undefined }));
    expect(doc.status).toBe('draft');
  });

  it('defaults isArchived to false', async () => {
    const doc = await RagTemplate.create(validTemplate());
    expect(doc.isArchived).toBe(false);
  });

  it('enforces slug uniqueness', async () => {
    await RagTemplate.create(validTemplate());
    await expect(RagTemplate.create(validTemplate())).rejects.toThrow(/duplicate key/i);
  });

  it('rejects an invalid type enum', async () => {
    const invalid = validTemplate({ type: 'invalid_type', slug: 'invalid-slug' });
    await expect(RagTemplate.create(invalid)).rejects.toThrow();
  });

  it('requires name field', async () => {
    const { name, ...rest } = validTemplate({ slug: 'no-name' });
    await expect(RagTemplate.create(rest)).rejects.toThrow();
  });

  it('accepts all valid type values', async () => {
    const types = ['emission_report', 'brsr', 'gri', 'issb', 'csrd', 'esg_summary', 'custom'];
    for (const [i, type] of types.entries()) {
      const doc = await RagTemplate.create(validTemplate({ type, slug: `slug-${i}` }));
      expect(doc.type).toBe(type);
    }
  });
});
