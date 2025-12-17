const { deleteFromS3 } =require('../../s3Helper');

/**
 * Deletes ALL media (cover + gallery) for a reduction from S3
 * Safe: logs errors but never throws
 */
exports.deleteReductionMedia = async function deleteReductionMedia(reductionDoc) {
  if (!reductionDoc) return;

  const bucket =
    process.env.S3_REDUCTION_MEDIA_BUCKET ||
    'zerocarbon-uploads-prod';

  // ---------------- DELETE COVER IMAGE ----------------
  if (reductionDoc.coverImage?.s3Key) {
    try {
      await deleteFromS3(bucket, reductionDoc.coverImage.s3Key);
      console.log('[REDUCTION MEDIA] Cover deleted:', reductionDoc.coverImage.s3Key);
    } catch (err) {
      console.warn('[REDUCTION MEDIA] Cover delete failed:', err.message);
    }
  }

  // ---------------- DELETE GALLERY IMAGES ----------------
  if (Array.isArray(reductionDoc.images)) {
    for (const img of reductionDoc.images) {
      if (!img?.s3Key) continue;
      try {
        await deleteFromS3(bucket, img.s3Key);
        console.log('[REDUCTION MEDIA] Gallery deleted:', img.s3Key);
      } catch (err) {
        console.warn('[REDUCTION MEDIA] Gallery delete failed:', err.message);
      }
    }
  }
};
