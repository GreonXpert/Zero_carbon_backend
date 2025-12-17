const { getS3 } = require('./_s3Client');
const { uploadReductionCSVCreate } = require('./create');

async function uploadReductionCSVUpdate({
  previousKey,
  ...payload
}) {
  const Bucket = process.env.S3_REDUCTION_CLIENT_CSV_BUCKET;
  const s3 = getS3();

  if (previousKey) {
    await s3
      .deleteObject({ Bucket, Key: previousKey })
      .promise()
      .catch(() => null);
  }

  return uploadReductionCSVCreate(payload);
}

module.exports = { uploadReductionCSVUpdate };
