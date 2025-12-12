// utils/s3Helper.js
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const path = require('path');

// Initialize S3 Client
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

/**
 * Upload file to S3 from local file path
 * @param {string} localFilePath - Path to local file
 * @param {string} bucketName - S3 bucket name
 * @param {string} s3Key - S3 object key (path in bucket)
 * @returns {Promise<string>} - S3 object URL
 */
async function uploadToS3(localFilePath, bucketName, s3Key) {
  try {
    const fileStream = fs.createReadStream(localFilePath);
    const contentType = getContentType(localFilePath);

    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: bucketName,
        Key: s3Key,
        Body: fileStream,
        ContentType: contentType
      }
    });

    const result = await upload.done();
    
    // Delete local file after successful upload
    if (fs.existsSync(localFilePath)) {
      fs.unlinkSync(localFilePath);
    }

    return `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;
  } catch (error) {
    console.error('S3 Upload Error:', error);
    throw error;
  }
}

/**
 * Upload file buffer to S3
 * @param {Buffer} buffer - File buffer
 * @param {string} bucketName - S3 bucket name
 * @param {string} s3Key - S3 object key
 * @param {string} contentType - MIME type
 * @returns {Promise<string>} - S3 object URL
 */
async function uploadBufferToS3(buffer, bucketName, s3Key, contentType) {
  try {
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
      Body: buffer,
      ContentType: contentType
    });

    await s3Client.send(command);
    return `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;
  } catch (error) {
    console.error('S3 Buffer Upload Error:', error);
    throw error;
  }
}

/**
 * Delete object from S3
 * @param {string} bucketName - S3 bucket name
 * @param {string} s3Key - S3 object key
 */
async function deleteFromS3(bucketName, s3Key) {
  try {
    const command = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: s3Key
    });
    await s3Client.send(command);
  } catch (error) {
    console.error('S3 Delete Error:', error);
    throw error;
  }
}

/**
 * Generate signed URL for private S3 objects
 * @param {string} bucketName - S3 bucket name
 * @param {string} s3Key - S3 object key
 * @param {number} expiresIn - URL expiration in seconds (default 1 hour)
 * @returns {Promise<string>} - Signed URL
 */
async function getSignedS3Url(bucketName, s3Key, expiresIn = 3600) {
  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: s3Key
    });
    return await getSignedUrl(s3Client, command, { expiresIn });
  } catch (error) {
    console.error('S3 Signed URL Error:', error);
    throw error;
  }
}

/**
 * Extract S3 key from full S3 URL
 * @param {string} s3Url - Full S3 URL
 * @returns {string} - S3 key
 */
function extractS3Key(s3Url) {
  if (!s3Url) return null;
  const match = s3Url.match(/amazonaws\.com\/(.+)$/);
  return match ? match[1] : null;
}

/**
 * Get content type from file extension
 * @param {string} filename - File name or path
 * @returns {string} - MIME type
 */
function getContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.csv': 'text/csv',
    '.json': 'application/json'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

module.exports = {
  uploadToS3,
  uploadBufferToS3,
  deleteFromS3,
  getSignedS3Url,
  extractS3Key,
  getContentType,
  s3Client
};