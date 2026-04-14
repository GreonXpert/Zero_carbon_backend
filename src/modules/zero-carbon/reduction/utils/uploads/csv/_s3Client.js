const AWS = require('aws-sdk');

function getS3() {
  const region = process.env.AWS_REGION || 'us-east-1';
  AWS.config.update({ region });

  return new AWS.S3({
    signatureVersion: 'v4'
  });
}

module.exports = { getS3 };
