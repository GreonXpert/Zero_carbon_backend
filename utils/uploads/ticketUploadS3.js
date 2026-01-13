// utils/uploads/ticketUploadS3.js
const multer = require('multer');
const path = require('path');
const { uploadBufferToS3, deleteFromS3 } = require('../s3Helper');

// Allowed file types for tickets
const ALLOWED_FILE_TYPES = [
  // Images
  'image/jpeg', 'image/png', 'image/jpg', 'image/webp',
  'image/gif', 'image/bmp', 'image/tiff', 'image/svgxml',
  // Documents
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/msword', // doc
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.ms-excel', // xls
  'text/plain', // txt
  'text/csv',
  'application/json',
  // Logs
  'application/x-log',
  'text/x-log'
];

// Extension mapping for ambiguous mime types
const ALLOWED_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.csv', '.json', '.log'
];

const storage = multer.memoryStorage();

/**
 * File filter for ticket attachments
 */
function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  
  // Check both mime type and extension
  const isValidMime = ALLOWED_FILE_TYPES.includes(file.mimetype);
  const isValidExt = ALLOWED_EXTENSIONS.includes(ext);
  
  if (!isValidMime && !isValidExt) {
    return cb(
      new Error(`Invalid file type: ${file.mimetype}. Allowed: images, PDF, Office docs, text files, logs.`),
      false
    );
  }
  
  cb(null, true);
}

/**
 * Multer middleware for ticket attachments
 * Allows up to 5 files, 10MB each
 */
exports.uploadTicketAttachments = multer({
  storage,
  fileFilter,
  limits: { 
    files: 5,
    fileSize: 10 * 1024 * 1024 // 10MB per file
  }
}).array('attachments', 5);

/**
 * Save ticket attachment files to S3
 * @param {Object} req - Express request object with req.files
 * @param {Object} context - { clientId, ticketId, userId, type: 'ticket' | 'activity', activityId }
 * @returns {Promise<Array>} Array of saved file objects
 */
exports.saveTicketAttachments = async function saveTicketAttachments(req, context) {
  if (!req.files || req.files.length === 0) {
    return [];
  }

  const { clientId, ticketId, userId, type = 'ticket', activityId } = context;
  
  if (!clientId || !ticketId || !userId) {
    throw new Error('Missing required context: clientId, ticketId, userId');
  }

  const bucketName = process.env.S3_UPLOADS_BUCKET || 'zerocarbon-uploads-prod';
  const results = [];

  try {
    for (const file of req.files) {
      const ext = path.extname(file.originalname || '.file');
      const timestamp = Date.now();
      const random = Math.random().toString(36).substring(7);
      const sanitizedName = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9-_]/g, '_');
      
      // Build S3 key based on type
      let s3Key;
      if (type === 'activity' && activityId) {
        s3Key = `tickets/${clientId}/${ticketId}/activity/${activityId}/${timestamp}_${random}_${sanitizedName}${ext}`;
      } else {
        s3Key = `tickets/${clientId}/${ticketId}/attachments/${timestamp}_${random}_${sanitizedName}${ext}`;
      }

      // Upload to S3
      const s3Url = await uploadBufferToS3(file.buffer, bucketName, s3Key, file.mimetype);
      
      const attachmentData = {
        filename: file.originalname,
        fileUrl: s3Url,
        s3Key: s3Key,
        bucket: bucketName,
        uploadedBy: userId,
        uploadedAt: new Date(),
        fileSize: file.size,
        mimeType: file.mimetype
      };
      
      results.push(attachmentData);
    }

    return results;
  } catch (error) {
    console.error('Error saving ticket attachments to S3:', error);
    throw error;
  }
};

/**
 * Delete ticket attachment from S3
 * @param {String} bucket - S3 bucket name
 * @param {String} s3Key - S3 object key
 * @returns {Promise<void>}
 */
exports.deleteTicketAttachment = async function deleteTicketAttachment(bucket, s3Key) {
  try {
    await deleteFromS3(bucket, s3Key);
    console.log(`Deleted ticket attachment from S3: ${s3Key}`);
  } catch (error) {
    console.error('Error deleting ticket attachment:', error);
    throw error;
  }
};

/**
 * Delete multiple attachments
 * @param {Array} attachments - Array of attachment objects with bucket and s3Key
 * @returns {Promise<void>}
 */
exports.deleteMultipleAttachments = async function deleteMultipleAttachments(attachments) {
  if (!attachments || attachments.length === 0) {
    return;
  }

  const deletePromises = attachments.map(att => {
    if (att.bucket && att.s3Key) {
      return deleteFromS3(att.bucket, att.s3Key).catch(err => {
        console.error(`Failed to delete attachment ${att.s3Key}:`, err);
      });
    }
  });

  await Promise.all(deletePromises);
};

/**
 * Validate file size before upload
 * @param {Number} fileSize - File size in bytes
 * @param {Number} maxSize - Max allowed size in bytes (default 10MB)
 * @returns {Boolean}
 */
exports.validateFileSize = function validateFileSize(fileSize, maxSize = 10 * 1024 * 1024) {
  return fileSize <= maxSize;
};

/**
 * Get human-readable file size
 * @param {Number} bytes - File size in bytes
 * @returns {String}
 */
exports.formatFileSize = function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
};