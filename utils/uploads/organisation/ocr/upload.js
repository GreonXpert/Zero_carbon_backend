// utils/uploads/organisation/ocr/upload.js
// Multer config + S3 key builder for OCR document uploads

const multer = require('multer');
const { uploadBufferToS3 } = require('../../../s3Helper');

const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/tiff',
  'application/pdf'
];

// Multer instance — memory storage, 20MB limit, OCR file types only
const uploadOcr = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024 // 20MB for multi-page PDFs
  },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return cb(
        new Error('Only JPEG, PNG, TIFF, and PDF files are allowed for OCR'),
        false
      );
    }
    cb(null, true);
  }
});

/**
 * Build a deterministic S3 key for an OCR source document
 * Pattern: {clientId}/{nodeId}/{scopeIdentifier}/ocr/{timestamp}_{sanitizedFilename}
 */
function buildOcrS3Key(clientId, nodeId, scopeIdentifier, originalname) {
  const timestamp = Date.now();
  const sanitized = (originalname || 'document')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 100);
  return `${clientId}/${nodeId}/${scopeIdentifier}/ocr/${timestamp}_${sanitized}`;
}

/**
 * Upload an OCR source document buffer to S3
 * Returns the S3 key used (for audit storage in sourceDetails.ocrDocumentKey)
 */
async function uploadOcrToS3(buffer, key, contentType = 'application/octet-stream') {
  const bucket = process.env.S3_ORGANISATION_OCR_BUCKET;
  if (!bucket) {
    throw new Error('S3_ORGANISATION_OCR_BUCKET is not configured in environment');
  }
  await uploadBufferToS3(buffer, bucket, key, contentType);
  return key;
}

module.exports = {
  uploadOcr,
  buildOcrS3Key,
  uploadOcrToS3
};
