// utils/uploads/userImageUploadS3.js
const multer = require('multer');
const path = require('path');
const { uploadToS3, deleteFromS3, extractS3Key } = require('../s3Helper');

// Allowed image types
const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'image/svg+xml'
];

// Use memory storage for temporary buffering
const storage = multer.memoryStorage();

// File filter
function fileFilter(req, file, cb) {
  if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    return cb(
      new Error(`Invalid file type: ${file.mimetype}. Only image files are allowed.`),
      false
    );
  }
  cb(null, true);
}

// Export multer middleware
exports.uploadUserImage = multer({
  storage,
  fileFilter,
  limits: { 
    files: 1,
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
}).single('profileImage');

/**
 * Build S3 key for user profile image
 */
function buildS3Key(user, ext) {
  const userId = user._id.toString();
  const timestamp = Date.now();
  
  switch (user.userType) {
    case 'super_admin':
      return `profiles/super_admin/${userId}_${timestamp}${ext}`;
    
    case 'consultant_admin':
      return `profiles/consultant_admin/${sanitize(user.teamName)}/${userId}_${timestamp}${ext}`;
    
    case 'consultant':
      return `profiles/consultant/${sanitize(user.teamName)}/${userId}_${timestamp}${ext}`;
    
    case 'client_admin':
      return `profiles/client_admin/${sanitize(user.clientId)}/${userId}_${timestamp}${ext}`;
    
    case 'client_employee_head':
      return `profiles/employee_head/${sanitize(user.clientId)}/${userId}_${timestamp}${ext}`;
    
    case 'employee':
      return `profiles/employee/${sanitize(user.clientId)}/${sanitize(user.employeeHeadId || 'unassigned')}/${userId}_${sanitize(user.userName)}_${timestamp}${ext}`;
    
    case 'auditor':
      return `profiles/auditor/${sanitize(user.clientId)}/${userId}_${timestamp}${ext}`;
    
    case 'viewer':
      return `profiles/viewer/${sanitize(user.clientId)}/${userId}_${timestamp}${ext}`;
    
    default:
      return `profiles/misc/${userId}_${timestamp}${ext}`;
  }
}

/**
 * Save user profile image to S3
 */
exports.saveUserProfileImage = async function saveUserProfileImage(req, userDoc) {
  try {
    if (!req.file || !userDoc) return userDoc;

    const ext = path.extname(req.file.originalname || '.jpg') || '.jpg';
    const bucketName = process.env.S3_PROFILE_IMAGES_BUCKET || 'zerocarbon-profile-images-prod';
    const s3Key = buildS3Key(userDoc, ext);

    // Delete old profile image from S3 if exists
    if (userDoc.profileImage?.s3Key) {
      try {
        await deleteFromS3(bucketName, userDoc.profileImage.s3Key);
      } catch (err) {
        console.error('Failed to delete old profile image:', err);
      }
    }

    // Upload new image to S3 using buffer
    const { uploadBufferToS3 } = require('../s3Helper');
    const s3Url = await uploadBufferToS3(
      req.file.buffer,
      bucketName,
      s3Key,
      req.file.mimetype
    );

    // Update user document
    userDoc.profileImage = {
      filename: path.basename(s3Key),
      url: s3Url,
      s3Key: s3Key,
      bucket: bucketName,
      uploadedAt: new Date()
    };

    await userDoc.save();
    return userDoc;

  } catch (err) {
    console.error('Error saving user profile image to S3:', err);
    throw err;
  }
};

function sanitize(str) {
  return (str || '').toString().trim().replace(/[^\w.-]+/g, '_') || 'unknown';
}