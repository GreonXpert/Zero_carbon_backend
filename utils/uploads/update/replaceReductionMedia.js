const path = require('path');
const { uploadBufferToS3, deleteFromS3 } = require('../../s3Helper');

exports.replaceReductionMedia = async (req, doc) => {
  if (!req.files) return;

  const bucket =
    process.env.S3_REDUCTION_MEDIA_BUCKET || 'zerocarbon-uploads-prod';

  // ---------------- COVER IMAGE ----------------
  if (req.files.coverImage?.length) {
    // delete old
    if (doc.coverImage?.s3Key) {
      try {
        await deleteFromS3(bucket, doc.coverImage.s3Key);
      } catch (e) {
        console.warn('Old cover delete failed:', e.message);
      }
    }

    const file = req.files.coverImage[0];
    const ext = path.extname(file.originalname || '.jpg');
    const s3Key = `reductions/${doc.clientId}/${doc.reductionId}/cover/${Date.now()}${ext}`;

    const url = await uploadBufferToS3(
      file.buffer,
      bucket,
      s3Key,
      file.mimetype
    );

    doc.coverImage = {
      filename: path.basename(s3Key),
      url,
      s3Key,
      bucket,
      uploadedAt: new Date()
    };
  }

  // ---------------- GALLERY ----------------
  if (req.files.images?.length) {
    if (Array.isArray(doc.images)) {
      for (const img of doc.images) {
        if (!img?.s3Key) continue;
        try {
          await deleteFromS3(bucket, img.s3Key);
        } catch (e) {
          console.warn('Old gallery delete failed:', e.message);
        }
      }
    }

    doc.images = [];

    for (const file of req.files.images) {
      const ext = path.extname(file.originalname || '.jpg');
      const s3Key =
        `reductions/${doc.clientId}/${doc.reductionId}/gallery/${Date.now()}_${Math.random()
          .toString(36)
          .slice(2)}${ext}`;

      const url = await uploadBufferToS3(
        file.buffer,
        bucket,
        s3Key,
        file.mimetype
      );

      doc.images.push({
        filename: path.basename(s3Key),
        url,
        s3Key,
        bucket,
        uploadedAt: new Date()
      });
    }
  }
};
