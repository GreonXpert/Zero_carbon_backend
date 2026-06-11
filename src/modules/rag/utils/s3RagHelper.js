'use strict';

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const BUCKET = process.env.RAG_S3_BUCKET || 'greon-rag-composer';

const s3RagHelper = {
  async uploadJSON(key, data) {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key:    key,
      Body:   JSON.stringify(data, null, 2),
      ContentType: 'application/json'
    }));
    return key;
  },

  async fetchJSON(key) {
    const res  = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const body = await res.Body.transformToString();
    return JSON.parse(body);
  },

  async uploadBuffer(key, buffer, contentType) {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key:    key,
      Body:   buffer,
      ContentType: contentType
    }));
    return key;
  },

  async getSignedDownloadUrl(key, expiresIn = 900) {
    return getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
      { expiresIn }
    );
  },

  async deleteObject(key) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  },

  getBucket() {
    return BUCKET;
  }
};

module.exports = { s3RagHelper };
