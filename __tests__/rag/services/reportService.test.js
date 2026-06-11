'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// S3 helper mock — uploadJSON returns predictable key
jest.mock('../../../src/modules/rag/utils/s3RagHelper', () => ({
  s3RagHelper: {
    uploadJSON:  jest.fn().mockImplementation((key) => Promise.resolve({ s3Key: key, s3Url: `https://s3/${key}` })),
    fetchJSON:   jest.fn().mockResolvedValue({ sections: { exec: { fields: { intro: 'test content' } } } }),
    deleteObject: jest.fn().mockResolvedValue(true)
  }
}));

let mongod;
let reportService, RagReport;

const orgId      = new mongoose.Types.ObjectId();
const templateId = new mongoose.Types.ObjectId();
const versionId  = new mongoose.Types.ObjectId();
const userId     = new mongoose.Types.ObjectId();

function makeReport(overrides = {}) {
  return {
    templateId,
    templateVersionId: versionId,
    templateSnapshot:  { name: 'GHG Report', version: 1, type: 'emission_report' },
    organizationId:    orgId,
    createdBy:         userId,
    title:             'FY2024 GHG Report',
    reportingYear:     2024,
    ...overrides
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  ({ reportService } = require('../../../src/modules/rag/services/reportService'));
  RagReport     = require('../../../src/modules/rag/models/RagReport');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await RagReport.deleteMany({});
  jest.clearAllMocks();
});

describe('reportService.create', () => {
  it('creates report in queued status', async () => {
    const report = await reportService.create(makeReport());
    expect(report.status).toBe('queued');
    expect(report.organizationId.toString()).toBe(orgId.toString());
  });

  it('stores templateSnapshot correctly', async () => {
    const report = await reportService.create(makeReport());
    expect(report.templateSnapshot.name).toBe('GHG Report');
    expect(report.templateSnapshot.version).toBe(1);
  });
});

describe('reportService.saveGeneratedSnapshot', () => {
  it('sets status to draft and sets activeSnapshotId', async () => {
    const report  = await reportService.create(makeReport());
    const updated = await reportService.saveGeneratedSnapshot(
      report._id,
      { exec: { fields: { intro: 'Generated text here' } } },
      userId
    );

    expect(updated.status).toBe('draft');
    expect(updated.activeSnapshotId).toBeDefined();
    expect(updated.snapshots).toHaveLength(1);
    expect(updated.snapshots[0].type).toBe('generated');
  });
});

describe('reportService.saveEdit', () => {
  it('changes status to edited and adds a new snapshot', async () => {
    const report  = await reportService.create(makeReport());
    await reportService.saveGeneratedSnapshot(report._id, { exec: { fields: { intro: 'original' } } }, userId);

    const edited = await reportService.saveEdit({
      reportId: report._id,
      sections: { exec: { fields: { intro: 'edited text' } } },
      note:     'Clarified intro',
      editedBy: userId
    });

    expect(edited.status).toBe('edited');
    expect(edited.snapshots).toHaveLength(2);
    const prev = edited.snapshots[0];
    const curr = edited.snapshots[1];
    expect(prev.snapshotId).not.toBe(curr.snapshotId);
  });
});

describe('reportService.finalize', () => {
  it('sets status to finalized with finalizedAt and finalizedBy', async () => {
    const report = await reportService.create(makeReport());
    await reportService.saveGeneratedSnapshot(report._id, { exec: {} }, userId);
    const final  = await reportService.finalize(report._id, userId);

    expect(final.status).toBe('finalized');
    expect(final.finalizedAt).toBeDefined();
    expect(final.finalizedBy.toString()).toBe(userId.toString());
  });
});

describe('reportService.markFailed', () => {
  it('sets status to failed with error message', async () => {
    const report  = await reportService.create(makeReport());
    const failed  = await reportService.markFailed(report._id, 'LLM timeout');

    expect(failed.status).toBe('failed');
    expect(failed.generationJob.errorMessage).toBe('LLM timeout');
  });
});
