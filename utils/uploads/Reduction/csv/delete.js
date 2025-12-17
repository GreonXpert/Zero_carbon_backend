const { getS3 } = require('./_s3Client');

async function deleteReductionCSV({ key }) {
  const Bucket = process.env.S3_REDUCTION_CLIENT_CSV_BUCKET;
  const s3 = getS3();

  await s3.deleteObject({ Bucket, Key: key }).promise();
  return { deleted: true };
}

module.exports = { deleteReductionCSV };
