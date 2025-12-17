// utils/upload/organisation/csv/update.js
const { getS3 } = require('./_s3Client');
const { uploadOrganisationCSVCreate } = require('./create');

async function uploadOrganisationCSVUpdate({
  clientId,
  nodeId,
  scopeIdentifier,
  previousKey,     // optional
  fileName,
  buffer,
  contentType
}) {
  const Bucket = process.env.S3_ORGANISATION_CLIENT_CSV_BUCKET;
  if (!Bucket) throw new Error('Missing env: S3_ORGANISATION_CLIENT_CSV_BUCKET');

  const s3 = getS3();

  // Delete old object if provided
  if (previousKey) {
    await s3
      .deleteObject({ Bucket, Key: previousKey })
      .promise()
      .catch(() => null); // don't block update if old key missing
  }

  // Upload new
  return uploadOrganisationCSVCreate({
    clientId,
    nodeId,
    scopeIdentifier,
    fileName,
    buffer,
    contentType: contentType || 'text/csv'
  });
}

module.exports = { uploadOrganisationCSVUpdate };
