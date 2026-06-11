'use strict';

// All AWS SDK calls are mocked in __tests__/rag/setup.js
// We re-mock here for fine-grained control

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

process.env.RAG_S3_BUCKET = 'test-rag-bucket';
process.env.AWS_REGION    = 'us-east-1';

// Build a fake readable stream for GetObject response
function makeStream(content) {
  const Readable = require('stream').Readable;
  const stream   = new Readable();
  stream.push(content);
  stream.push(null);
  stream.transformToString = async () => content;
  return stream;
}

// Provide a mock S3 send function
const mockSend = jest.fn();
S3Client.mockImplementation(() => ({ send: mockSend }));

let s3RagHelper;

beforeAll(() => {
  s3RagHelper = require('../../../src/modules/rag/utils/s3RagHelper').s3RagHelper;
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('s3RagHelper.uploadJSON', () => {
  it('calls PutObjectCommand with correct Bucket, Key, and ContentType', async () => {
    mockSend.mockResolvedValueOnce({});
    const data = { test: true };
    await s3RagHelper.uploadJSON('templates/test/v1/template.json', data);

    expect(PutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket:      'test-rag-bucket',
        Key:         'templates/test/v1/template.json',
        ContentType: 'application/json'
      })
    );
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('s3RagHelper.fetchJSON', () => {
  it('calls GetObjectCommand and returns parsed JSON', async () => {
    const payload = { hello: 'world' };
    mockSend.mockResolvedValueOnce({ Body: makeStream(JSON.stringify(payload)) });

    const result = await s3RagHelper.fetchJSON('some/key.json');
    expect(GetObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({ Bucket: 'test-rag-bucket', Key: 'some/key.json' })
    );
    expect(result).toEqual(payload);
  });
});

describe('s3RagHelper.getSignedDownloadUrl', () => {
  it('returns a string URL', async () => {
    const url = await s3RagHelper.getSignedDownloadUrl('reports/org1/report1/file.pdf');
    expect(typeof url).toBe('string');
    expect(url).toContain('signed-url');
  });
});

describe('s3RagHelper.uploadBuffer', () => {
  it('calls PutObjectCommand with buffer body and given contentType', async () => {
    mockSend.mockResolvedValueOnce({});
    const buf = Buffer.from('%PDF-1.4 header');
    await s3RagHelper.uploadBuffer('reports/org1/report1/export.pdf', buf, 'application/pdf');

    expect(PutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket:      'test-rag-bucket',
        Key:         'reports/org1/report1/export.pdf',
        ContentType: 'application/pdf',
        Body:        buf
      })
    );
  });
});
