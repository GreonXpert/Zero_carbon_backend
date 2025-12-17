const path = require('path');
const {
  uploadBufferToS3,
  deleteFromS3
} =require('../../s3Helper');

/**
 * Replace reduction media safely:
 * - Deletes old S3 images only if new files are uploaded
 * - Uploads new images
 * - Updates doc.coverImage and doc.images
 */
exports.replaceReductionMedia = async function replaceReductionMedia(req, reductionDoc) {
  if (!req.files) return;

  const bucket =
    process.env.S3_REDUCTION_MEDIA_BUCKET ||
    'zerocarbon-uploads-prod';

  // --------------------------------------------------
  // 1. DELETE OLD COVER IMAGE
  // --------------------------------------------------
  if (req.files.coverImage?.length && reductionDoc.coverImage?.s3Key) {
    try {
      await deleteFromS3(bucket, reductionDoc.coverImage.s3Key);
    } catch (e) {
      console.warn('Cover image delete failed:', e.message);
    }
    reductionDoc.coverImage = undefined;
  }

  // --------------------------------------------------
  // 2. DELETE OLD GALLERY IMAGES
  // --------------------------------------------------
  if (req.files.images?.length && Array.isArray(reductionDoc.images)) {
    for (const img of reductionDoc.images) {
      if (!img?.s3Key) continue;
      try {
        await deleteFromS3(bucket, img.s3Key);
      } catch (e) {
        console.warn('Gallery image delete failed:', e.message);
      }
    }
    reductionDoc.images = [];
  }

  // --------------------------------------------------
  // 3. UPLOAD NEW COVER IMAGE
  // --------------------------------------------------
  if (req.files.coverImage?.[0]) {
    const file = req.files.coverImage[0];
    const ext = path.extname(file.originalname || '.jpg');
    const s3Key =
      `reductions/${reductionDoc.clientId}/${reductionDoc.reductionId}/cover/${Date.now()}${ext}`;

    const url = await uploadBufferToS3(
      file.buffer,
      bucket,
      s3Key,
      file.mimetype
    );

    reductionDoc.coverImage = {
      filename: path.basename(s3Key),
      url,
      s3Key,
      bucket,
      uploadedAt: new Date()
    };
  }

  // --------------------------------------------------
  // 4. UPLOAD NEW GALLERY IMAGES
  // --------------------------------------------------
  if (req.files.images?.length) {
    for (const file of req.files.images) {
      const ext = path.extname(file.originalname || '.jpg');
      const s3Key =
        `reductions/${reductionDoc.clientId}/${reductionDoc.reductionId}/gallery/${Date.now()}_${Math.random()
          .toString(36)
          .slice(2)}${ext}`;

      const url = await uploadBufferToS3(
        file.buffer,
        bucket,
        s3Key,
        file.mimetype
      );

      reductionDoc.images.push({
        filename: path.basename(s3Key),
        url,
        s3Key,
        bucket,
        uploadedAt: new Date()
      });
    }
  }

  await reductionDoc.save();
};
