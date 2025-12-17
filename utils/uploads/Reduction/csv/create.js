const { getS3 } = require('./_s3Client');
const { buildReductionCsvKey } = require('./_key');

async function uploadReductionCSVCreate({
  clientId,
  projectId,
  calculationMethodology,
  fileName,
  buffer,
  contentType = 'text/csv'
}) {
  const Bucket = process.env.S3_REDUCTION_CLIENT_CSV_BUCKET;
  if (!Bucket) {
    throw new Error('Missing env: S3_REDUCTION_CLIENT_CSV_BUCKET');
  }

  const Key = buildReductionCsvKey({
    clientId,
    projectId,
    calculationMethodology,
    fileName
  });

  const s3 = getS3();
  const res = await s3
    .putObject({
      Bucket,
      Key,
      Body: buffer,
      ContentType: contentType,
      ContentDisposition: `attachment; filename="${fileName}"`
    })
    .promise();

  return {
    bucket: Bucket,
    key: Key,
    etag: res.ETag || null
  };
}

module.exports = { uploadReductionCSVCreate };
