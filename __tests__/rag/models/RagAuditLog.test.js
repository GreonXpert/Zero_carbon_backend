'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod;
let RagAuditLog;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  RagAuditLog = require('../../../src/modules/rag/models/RagAuditLog');
  // Ensure all schema indexes (including TTL) are created on the in-memory server
  await RagAuditLog.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await RagAuditLog.deleteMany({});
});

function validLog(overrides = {}) {
  return {
    action: 'TEMPLATE_CREATED',
    actor: {
      userId:         new mongoose.Types.ObjectId().toString(),
      email:          'test@example.com',
      userType:       'consultant_admin',
      organizationId: new mongoose.Types.ObjectId().toString()
    },
    resource: {
      type: 'template',   // valid enum: template | templateVersion | report | branding
      id:   new mongoose.Types.ObjectId().toString()
    },
    ...overrides
  };
}

describe('RagAuditLog model', () => {
  it('inserts a log document successfully', async () => {
    const doc = await RagAuditLog.create(validLog());
    expect(doc._id).toBeDefined();
    expect(doc.action).toBe('TEMPLATE_CREATED');
    expect(doc.timestamp).toBeDefined();
  });

  it('throws immutability error on updateOne', async () => {
    const doc = await RagAuditLog.create(validLog());
    await expect(
      RagAuditLog.updateOne({ _id: doc._id }, { $set: { action: 'TEMPLATE_UPDATED' } })
    ).rejects.toThrow('RagAuditLog is immutable');
  });

  it('throws immutability error on updateMany', async () => {
    await RagAuditLog.create(validLog());
    await expect(
      RagAuditLog.updateMany({}, { $set: { action: 'MODIFIED' } })
    ).rejects.toThrow('RagAuditLog is immutable');
  });

  it('throws immutability error on findOneAndUpdate', async () => {
    const doc = await RagAuditLog.create(validLog());
    await expect(
      RagAuditLog.findOneAndUpdate({ _id: doc._id }, { $set: { action: 'MODIFIED' } })
    ).rejects.toThrow('RagAuditLog is immutable');
  });

  it('throws immutability error on deleteOne', async () => {
    const doc = await RagAuditLog.create(validLog());
    await expect(
      RagAuditLog.deleteOne({ _id: doc._id })
    ).rejects.toThrow('RagAuditLog is immutable');
  });

  it('has a TTL index on timestamp field', async () => {
    const indexes = await RagAuditLog.collection.indexes();
    const ttl = indexes.find(idx => idx.key && idx.key.timestamp !== undefined && idx.expireAfterSeconds !== undefined);
    expect(ttl).toBeDefined();
    expect(ttl.expireAfterSeconds).toBe(220752000);
  });
});
