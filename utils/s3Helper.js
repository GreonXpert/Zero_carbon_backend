// utils/s3Helper.js
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand
} = require('@aws-sdk/client-s3');

require('dotenv').config(); // ✅ VERY IMPORTANT

// ---------------- CONFIG ----------------
const REGION = process.env.AWS_REGION || 'us-east-1';

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  console.warn('⚠ AWS credentials are missing in environment variables');
}

// ✅ SINGLE SOURCE OF TRUTH
const s3Client = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

// ---------------- HELPERS ----------------

async function uploadBufferToS3(buffer, bucketName, key, contentType) {
  try {
    console.log(`📤 Uploading to S3: ${bucketName}/${key}`);

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: buffer,
      ContentType: contentType
    });

    await s3Client.send(command);

    const url = `https://${bucketName}.s3.${REGION}.amazonaws.com/${key}`;
    console.log(`✅ Uploaded: ${url}`);

    return url;
  } catch (error) {
    console.error('❌ S3 Upload Error:', error);
    throw new Error(`Failed to upload to S3: ${error.message}`);
  }
}

async function deleteFromS3(bucketName, key) {
  if (!key) return;

  try {
    const command = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key
    });

    await s3Client.send(command);
    console.log(`🗑 Deleted from S3: ${bucketName}/${key}`);
  } catch (err) {
    console.warn(`⚠ Failed to delete S3 object: ${key}`, err.message);
  }
}

async function objectExistsInS3(bucketName, key) {
  try {
    await s3Client.send(
      new HeadObjectCommand({ Bucket: bucketName, Key: key })
    );
    return true;
  } catch {
    return false;
  }
}

function extractS3Key(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.pathname.replace(/^\/+/, '');
  } catch {
    return null;
  }
}

module.exports = {
  s3Client,
  uploadBufferToS3,
  deleteFromS3,
  objectExistsInS3,
  extractS3Key
};
