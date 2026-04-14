const path = require('path');
const {
  uploadBufferToS3,
  deleteFromS3
} = require('../../s3Helper');
const { buildUserProfileS3Key } = require('../profileKeyBuilder');

/**
 * Replace user profile image in S3
 * - Deletes old image if exists
 * - Uploads new image
 * - Updates user.profileImage
 */
exports.replaceUserProfileImage = async function replaceUserProfileImage(req, userDoc) {
  if (!req.file) return userDoc;

  const bucketName =
    process.env.S3_PROFILE_IMAGES_BUCKET || 'zerocarbon-profile-images-prod';

  // --------------------------------------------------
  // 1. DELETE OLD IMAGE (IF EXISTS)
  // --------------------------------------------------
  if (userDoc.profileImage?.s3Key) {
    try {
      await deleteFromS3(bucketName, userDoc.profileImage.s3Key);
      console.log('[PROFILE IMAGE] Old image deleted:', userDoc.profileImage.s3Key);
    } catch (err) {
      console.warn(
        '[PROFILE IMAGE] Failed to delete old image:',
        err.message
      );
    }
  }

  // --------------------------------------------------
  // 2. UPLOAD NEW IMAGE
  // --------------------------------------------------
  const ext =
    path.extname(req.file.originalname || '.jpg') || '.jpg';

  const s3Key = buildUserProfileS3Key(userDoc, ext);

  const s3Url = await uploadBufferToS3(
    req.file.buffer,
    bucketName,
    s3Key,
    req.file.mimetype
  );

  // --------------------------------------------------
  // 3. UPDATE USER DOC
  // --------------------------------------------------
  userDoc.profileImage = {
    filename: path.basename(s3Key),
    url: s3Url,
    s3Key,
    bucket: bucketName,
    uploadedAt: new Date()
  };

  await userDoc.save();

  console.log('[PROFILE IMAGE] Image replaced successfully');

  return userDoc;
};
