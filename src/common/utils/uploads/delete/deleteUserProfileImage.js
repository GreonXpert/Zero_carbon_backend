const { deleteFromS3 } =require('../../s3Helper');

/**
 * Deletes user's profile image from S3 safely
 * - Does NOT throw if deletion fails
 * - Used during user deletion
 */
exports.deleteUserProfileImage = async function deleteUserProfileImage(userDoc) {
  if (!userDoc?.profileImage?.s3Key) return;

  const bucket =
    userDoc.profileImage.bucket ||
    process.env.S3_PROFILE_IMAGES_BUCKET ||
    'zerocarbon-profile-images-prod';

  try {
    await deleteFromS3(bucket, userDoc.profileImage.s3Key);
    console.log(
      '[PROFILE IMAGE DELETE] Deleted:',
      userDoc.profileImage.s3Key
    );
  } catch (err) {
    console.warn(
      '[PROFILE IMAGE DELETE] Failed:',
      err.message
    );
  }
};
