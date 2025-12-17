// utils/upload/organisation/csv/_s3Client.js
const AWS = require('aws-sdk');

function getS3() {
  // Uses envs like:
  // AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION (or AWS_DEFAULT_REGION)
  // If you're already configuring AWS elsewhere globally, this is still safe.
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1';

  AWS.config.update({ region });

  return new AWS.S3({
    signatureVersion: 'v4',
    // credentials will be picked up from env / IAM role automatically
  });
}

module.exports = { getS3 };
