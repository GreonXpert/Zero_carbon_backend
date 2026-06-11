'use strict';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Mock S3 helper before requiring the service
jest.mock('../../../src/modules/rag/utils/s3RagHelper', () => ({
  s3RagHelper: {
    uploadJSON:           jest.fn().mockResolvedValue({ s3Key: 'templates/mock/v1/template.json', s3Url: 'https://s3.example.com/mock' }),
    fetchJSON:            jest.fn().mockResolvedValue({ sections: [], dataMappings: {} }),
    getSignedDownloadUrl: jest.fn().mockResolvedValue('https://s3.example.com/signed')
  }
}));

let mongod;
let templateService, RagTemplate, RagTemplateVersion;

const userId = new mongoose.Types.ObjectId();

const sampleStructure = {
  sections: [
    {
      id:    'executive_summary',
      title: 'Executive Summary',
      order: 1,
      fields: [{ id: 'intro', label: 'Introduction', type: 'generated_text' }]
    }
  ],
  dataMappings: { bindings: ['org.name'] }
};

beforeAll(async () => {
  // templateService uses Mongoose sessions (transactions) → needs a replica set
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri());
  ({ templateService } = require('../../../src/modules/rag/services/templateService'));
  RagTemplate        = require('../../../src/modules/rag/models/RagTemplate');
  RagTemplateVersion = require('../../../src/modules/rag/models/RagTemplateVersion');
  // Pre-create collections to avoid "catalog changes" race on first write in a fresh replset
  await RagTemplate.createIndexes();
  await RagTemplateVersion.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await RagTemplate.deleteMany({});
  await RagTemplateVersion.deleteMany({});
  jest.clearAllMocks();
});

describe('templateService.createWithVersion', () => {
  it('creates Template + TemplateVersion documents and calls uploadJSON', async () => {
    const { s3RagHelper } = require('../../../src/modules/rag/utils/s3RagHelper');
    const result = await templateService.createWithVersion({
      name:      'GHG Report',
      slug:      'ghg-report',
      type:      'emission_report',
      platform:  'zero_carbon',
      structure: sampleStructure,
      createdBy: userId
    });

    expect(result.template).toBeDefined();
    expect(result.version).toBeDefined();
    expect(result.template.slug).toBe('ghg-report');
    expect(result.version.version).toBe(1);
    expect(s3RagHelper.uploadJSON).toHaveBeenCalledTimes(1);
  });
});

describe('templateService.createNewVersion', () => {
  it('increments version number and keeps previous version', async () => {
    const { template } = await templateService.createWithVersion({
      name: 'GHG Report 2', slug: 'ghg-report-2', type: 'emission_report',
      platform: 'zero_carbon', structure: sampleStructure, createdBy: userId
    });

    const result = await templateService.createNewVersion({
      templateId: template._id,
      structure:  sampleStructure,
      changelog:  'Added new section',
      createdBy:  userId
    });

    // createNewVersion returns { template, version } — same shape as createWithVersion
    expect(result.version.version).toBe(2);
    const allVersions = await RagTemplateVersion.find({ templateId: template._id });
    expect(allVersions).toHaveLength(2);
  });
});

describe('templateService.publish', () => {
  it('sets template + version status to published', async () => {
    const { template } = await templateService.createWithVersion({
      name: 'Publish Me', slug: 'publish-me', type: 'brsr',
      platform: 'zero_carbon', structure: sampleStructure, createdBy: userId
    });

    await templateService.publish(template._id, userId);
    const updated = await RagTemplate.findById(template._id);
    const version = await RagTemplateVersion.findOne({ templateId: template._id });

    expect(updated.status).toBe('published');
    expect(version.status).toBe('published');
  });
});

describe('templateService.archive', () => {
  it('sets template status to archived and isArchived to true', async () => {
    const { template } = await templateService.createWithVersion({
      name: 'Archive Me', slug: 'archive-me', type: 'gri',
      platform: 'zero_carbon', structure: sampleStructure, createdBy: userId
    });

    await templateService.archive(template._id, userId);
    const updated = await RagTemplate.findById(template._id);
    expect(updated.status).toBe('archived');
    expect(updated.isArchived).toBe(true);
  });
});

describe('templateService.getPublishedVersion', () => {
  it('returns version when template is published', async () => {
    const { template } = await templateService.createWithVersion({
      name: 'Published', slug: 'published-tmpl', type: 'emission_report',
      platform: 'zero_carbon', structure: sampleStructure, createdBy: userId
    });
    await templateService.publish(template._id, userId);

    const version = await templateService.getPublishedVersion(template._id);
    expect(version).not.toBeNull();
    expect(version.status).toBe('published');
  });

  it('returns null when template is in draft status', async () => {
    const { template } = await templateService.createWithVersion({
      name: 'Draft Only', slug: 'draft-only', type: 'emission_report',
      platform: 'zero_carbon', structure: sampleStructure, createdBy: userId
    });

    const version = await templateService.getPublishedVersion(template._id);
    expect(version).toBeNull();
  });
});
