// utils/s3Helper.js
const { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

// Initialize S3 Client
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  // If using EC2 with IAM role, credentials are automatically loaded
  // If using access keys, add:
  // credentials: {
  //   accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  //   secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  // }
});

/**
 * Upload buffer to S3
 * @param {Buffer} buffer - File buffer from multer
 * @param {string} bucketName - S3 bucket name
 * @param {string} key - S3 object key (file path)
 * @param {string} contentType - MIME type
 * @returns {Promise<string>} - S3 URL
 */
async function uploadBufferToS3(buffer, bucketName, key, contentType) {
  try {
    console.log(`📤 Uploading to S3: ${bucketName}/${key}`);
    
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      // Make it publicly readable (optional - adjust based on your security needs)
      // ACL: 'public-read',
      // Or use bucket policy for public access
    });

    await s3Client.send(command);
    
    // Construct the S3 URL
    const s3Url = `https://${bucketName}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`;
    
    console.log(`✅ Successfully uploaded to S3: ${s3Url}`);
    return s3Url;
    
  } catch (error) {
    console.error('❌ S3 Upload Error:', error);
    throw new Error(`Failed to upload to S3: ${error.message}`);
  }
}

/**
 * Upload file to S3 (legacy method for file paths)
 * @param {string} bucketName - S3 bucket name
 * @param {string} key - S3 object key
 * @param {Buffer} body - File content
 * @param {string} contentType - MIME type
 */
async function uploadToS3(bucketName, key, body, contentType) {
  return uploadBufferToS3(body, bucketName, key, contentType);
}

/**
 * Delete object from S3
 * @param {string} bucketName - S3 bucket name
 * @param {string} key - S3 object key
 */
async function deleteFromS3(bucketName, key) {
  try {
    console.log(`🗑️ Deleting from S3: ${bucketName}/${key}`);
    
    const command = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key
    });

    await s3Client.send(command);
    console.log(`✅ Successfully deleted from S3: ${key}`);
    
  } catch (error) {
    console.error('❌ S3 Delete Error:', error);
    // Don't throw error for delete failures - just log it
    console.warn(`Failed to delete ${key} from S3: ${error.message}`);
  }
}

/**
 * Check if object exists in S3
 * @param {string} bucketName - S3 bucket name
 * @param {string} key - S3 object key
 * @returns {Promise<boolean>}
 */
async function objectExistsInS3(bucketName, key) {
  try {
    const command = new HeadObjectCommand({
      Bucket: bucketName,
      Key: key
    });
    
    await s3Client.send(command);
    return true;
    
  } catch (error) {
    if (error.name === 'NotFound') {
      return false;
    }
    throw error;
  }
}

/**
 * Extract S3 key from URL
 * @param {string} url - S3 URL
 * @returns {string|null} - S3 key or null
 */
function extractS3Key(url) {
  if (!url) return null;
  
  try {
    // Handle different S3 URL formats
    // Format 1: https://bucket.s3.region.amazonaws.com/key
    // Format 2: https://s3.region.amazonaws.com/bucket/key
    
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    
    // Remove leading slash
    return pathname.startsWith('/') ? pathname.substring(1) : pathname;
    
  } catch (error) {
    console.error('Error extracting S3 key:', error);
    return null;
  }
}

module.exports = {
  s3Client,
  uploadToS3,
  uploadBufferToS3,
  deleteFromS3,
  objectExistsInS3,
  extractS3Key
};