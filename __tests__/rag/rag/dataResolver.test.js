'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Mock the Client model before dataResolver loads it
const mockClientFindById = jest.fn();
jest.mock('../../../src/modules/client-management/client/Client', () => ({
  findById: mockClientFindById
}));

// Mock DataEntry model
jest.mock('../../../src/modules/zero-carbon/organization/models/DataEntry', () => ({
  aggregate: jest.fn().mockResolvedValue([])
}));

let mongod;
let dataResolver;

const orgId = new mongoose.Types.ObjectId().toString();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  dataResolver = require('../../../src/modules/rag/rag/dataResolver');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(() => {
  jest.clearAllMocks();
});

// Chainable select().lean() mock helper
function mockClientDoc(data) {
  const lean = jest.fn().mockResolvedValue(data);
  const select = jest.fn().mockReturnValue({ lean });
  mockClientFindById.mockReturnValue({ select });
}

describe('dataResolver.resolveAllBindings', () => {
  it('resolves org.name from Client model', async () => {
    mockClientDoc({ projectProfile: { companyName: 'Acme Corp' }, leadInfo: {} });

    // bindings is an object keyed by alias (not an array)
    const { data } = await dataResolver.resolveAllBindings(
      { bindings: { 'org.name': {} } },
      orgId,
      2024
    );
    expect(data['org.name']).toBe('Acme Corp');
  });

  it('returns null for unknown binding and adds warning message', async () => {
    const { data, warnings } = await dataResolver.resolveAllBindings(
      { bindings: { 'unknown.binding': {} } },
      orgId,
      2024
    );
    expect(data['unknown.binding']).toBeNull();
    // warnings contains full message strings — check substring
    expect(warnings.some(w => w.includes('unknown.binding'))).toBe(true);
  });

  it('resolves org.reportingYear from job params directly', async () => {
    const { data } = await dataResolver.resolveAllBindings(
      { bindings: { 'org.reportingYear': {} } },
      orgId,
      2024
    );
    expect(data['org.reportingYear']).toBe(2024);
  });

  it('does not throw when client record is missing', async () => {
    mockClientDoc(null);

    const { data } = await dataResolver.resolveAllBindings(
      { bindings: { 'org.name': {}, 'org.industry': {} } },
      orgId,
      2024
    );
    expect(data['org.name']).toBeNull();
    // no throw — just nulls
  });
});
