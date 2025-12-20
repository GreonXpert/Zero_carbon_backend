const { getS3 } = require('./_s3Client');

const uploadCsvToS3 = async ({
  file,
  clientId,
  nodeId,
  scopeIdentifier
}) => {
  const s3 = getS3();

  // ✅ REQUIRED FOLDER STRUCTURE
  const s3Key = `${clientId}/${nodeId}/${scopeIdentifier}/data-${Date.now()}.csv`;

  const params = {
    Bucket: process.env.S3_ORGANISATION_CLIENT_CSV_BUCKET,
    Key: s3Key,
    Body: file.buffer,              // ✅ BUFFER (not file path)
    ContentType: 'text/csv'
  };

  const result = await s3.upload(params).promise();

  return {
    s3Key,
    s3Url: result.Location
  };
};

module.exports = { uploadCsvToS3 };
