// utils/upload/organisation/csv/delete.js
const { getS3 } = require('./_s3Client');
const { sanitizeSegment } = require('./_key');

async function deleteOrganisationCSV({
  clientId,
  nodeId,
  scopeIdentifier,
  key,            // optional: delete single file
  deleteFolder = false // if true: delete EVERYTHING under clientId/nodeId/scopeIdentifier/
}) {
  const Bucket = process.env.S3_ORGANISATION_CLIENT_CSV_BUCKET;
  if (!Bucket) throw new Error('Missing env: S3_ORGANISATION_CLIENT_CSV_BUCKET');

  const s3 = getS3();

  // 1) delete single object
  if (key) {
    await s3.deleteObject({ Bucket, Key: key }).promise();
    return { deleted: 1, bucket: Bucket };
  }

  // 2) delete entire "folder" prefix
  if (deleteFolder) {
    const prefix = `${sanitizeSegment(clientId)}/${sanitizeSegment(nodeId)}/${sanitizeSegment(scopeIdentifier)}/`;

    let deleted = 0;
    let ContinuationToken = undefined;

    while (true) {
      const listed = await s3
        .listObjectsV2({ Bucket, Prefix: prefix, ContinuationToken })
        .promise();

      const keys = (listed.Contents || []).map(o => ({ Key: o.Key }));
      if (keys.length) {
        await s3.deleteObjects({ Bucket, Delete: { Objects: keys, Quiet: true } }).promise();
        deleted += keys.length;
      }

      if (!listed.IsTruncated) break;
      ContinuationToken = listed.NextContinuationToken;
    }

    return { deleted, bucket: Bucket, prefix };
  }

  return { deleted: 0, bucket: Bucket };
}

module.exports = { deleteOrganisationCSV };
