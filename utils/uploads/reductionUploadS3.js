// utils/uploads/reductionUploadS3.js
const multer = require('multer');
const path = require('path');
const { uploadBufferToS3, deleteFromS3 } = require('../s3Helper');

const ALLOWED_IMAGE_TYPES = [
  'image/jpeg', 'image/png', 'image/jpg', 'image/webp',
  'image/gif', 'image/bmp', 'image/tiff', 'image/svg+xml'
];

const storage = multer.memoryStorage();

function fileFilter(req, file, cb) {
  if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    return cb(
      new Error(`Invalid file type: ${file.mimetype}. Only image files are allowed.`),
      false
    );
  }
  cb(null, true);
}

exports.uploadReductionMedia = multer({
  storage,
  fileFilter,
  limits: { 
    files: 6,
    fileSize: 10 * 1024 * 1024 // 10MB per file
  }
}).fields([
  { name: 'coverImage', maxCount: 1 },
  { name: 'images', maxCount: 5 }
]);

exports.saveReductionFiles = async function saveReductionFiles(req, doc) {
  if (!req.files || !doc) return;

  const userId = req.user?.id?.toString?.() || 'unknown';
  const clientId = doc.clientId || 'unknown';
  const reductionId = doc.reductionId;
  if (!reductionId) return;

  const bucketName = process.env.S3_UPLOADS_BUCKET || 'zerocarbon-uploads-prod';
  const results = { coverImage: null, galleryImages: [] };

  try {
    // Upload cover image
    if (req.files.coverImage?.[0]) {
      const file = req.files.coverImage[0];
      const ext = path.extname(file.originalname || '.jpg');
      const s3Key = `reductions/${clientId}/${reductionId}/cover/${Date.now()}_cover${ext}`;
      
      // Delete old cover if exists
      if (doc.coverImage?.s3Key) {
        try {
          await deleteFromS3(bucketName, doc.coverImage.s3Key);
        } catch (err) {
          console.error('Failed to delete old cover:', err);
        }
      }

      const s3Url = await uploadBufferToS3(file.buffer, bucketName, s3Key, file.mimetype);
      results.coverImage = {
        url: s3Url,
        s3Key: s3Key,
        bucket: bucketName,
        filename: path.basename(s3Key)
      };
      doc.coverImage = results.coverImage;
    }

    // Upload gallery images
    if (req.files.images) {
      // Delete old gallery images
      if (doc.images?.length) {
        for (const img of doc.images) {
          if (img.s3Key) {
            try {
              await deleteFromS3(bucketName, img.s3Key);
            } catch (err) {
              console.error('Failed to delete old gallery image:', err);
            }
          }
        }
      }

      for (const file of req.files.images) {
        const ext = path.extname(file.originalname || '.jpg');
        const s3Key = `reductions/${clientId}/${reductionId}/gallery/${Date.now()}_${Math.random().toString(36).substring(7)}${ext}`;
        
        const s3Url = await uploadBufferToS3(file.buffer, bucketName, s3Key, file.mimetype);
        const imageData = {
          url: s3Url,
          s3Key: s3Key,
          bucket: bucketName,
          filename: path.basename(s3Key)
        };
        results.galleryImages.push(imageData);
      }
      doc.images = results.galleryImages;
    }

    await doc.save();
  } catch (error) {
    console.error('Error saving reduction files to S3:', error);
    throw error;
  }
};