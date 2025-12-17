// utils/upload/organisation/csv/create.js
const { getS3 } = require('./_s3Client');
const { buildCsvS3Key } = require('./_key');

async function uploadOrganisationCSVCreate({
  clientId,
  nodeId,
  scopeIdentifier,
  fileName,
  buffer,
  contentType = 'text/csv'
}) {
  const Bucket = process.env.S3_ORGANISATION_CLIENT_CSV_BUCKET;
  if (!Bucket) throw new Error('Missing env: S3_ORGANISATION_CLIENT_CSV_BUCKET');

  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error('uploadOrganisationCSVCreate: buffer is required (Buffer)');
  }

  const Key = buildCsvS3Key({ clientId, nodeId, scopeIdentifier, fileName });

  const s3 = getS3();
  const putRes = await s3
    .putObject({
      Bucket,
      Key,
      Body: buffer,
      ContentType: contentType,
      // Optional (nice for downloads):
      ContentDisposition: `attachment; filename="${fileName}"`
    })
    .promise();

  return {
    bucket: Bucket,
    key: Key,
    etag: putRes.ETag || null
  };
}

module.exports = { uploadOrganisationCSVCreate };
