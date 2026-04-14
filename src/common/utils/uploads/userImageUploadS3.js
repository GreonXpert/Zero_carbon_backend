// utils/uploads/userImageUploadS3.js
const multer = require('multer');
const path = require('path');
const { uploadBufferToS3, deleteFromS3, extractS3Key } = require('../s3Helper');

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
  console.log('[IMAGE UPLOAD] File filter check:', {
    fieldname: file.fieldname,
    mimetype: file.mimetype,
    originalname: file.originalname
  });
  
  if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    console.error(`[IMAGE UPLOAD] ❌ Invalid file type: ${file.mimetype}`);
    return cb(
      new Error(`Invalid file type: ${file.mimetype}. Only image files are allowed.`),
      false
    );
  }
  
  console.log('[IMAGE UPLOAD] ✅ File type valid');
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
  
  console.log('[IMAGE UPLOAD] Building S3 key:', {
    userType: user.userType,
    userId,
    teamName: user.teamName,
    clientId: user.clientId
  });
  
  let s3Key;
  
  switch (user.userType) {
    case 'super_admin':
      s3Key = `profiles/super_admin/${userId}_${timestamp}${ext}`;
      break;
    
    case 'consultant_admin':
      s3Key = `profiles/consultant_admin/${sanitize(user.teamName)}/${userId}_${timestamp}_${user.userName}_${ext}`;
      break;
    
    case 'consultant':
      s3Key = `profiles/consultant/${sanitize(user.teamName)}/${userId}_${timestamp}_${user.userName}_${ext}`;
      break;
    
    case 'client_admin':
      s3Key = `profiles/client_admin/${sanitize(user.clientId)}/${userId}_${timestamp}_${user.userName}_${ext}`;
      break;
    
    case 'client_employee_head':
      s3Key = `profiles/employee_head/${sanitize(user.clientId)}/${userId}_${timestamp}_${user.userName}_${ext}`;
      break;
    
    case 'employee':
      s3Key = `profiles/employee/${sanitize(user.clientId)}/${sanitize(user.employeeHeadId || 'unassigned')}/${userId}_${sanitize(user.userName)}_${timestamp}_${user.userName}_${ext}`;
      break;
    
    case 'auditor':
      s3Key = `profiles/auditor/${sanitize(user.clientId)}/${userId}_${timestamp}_${user.userName}_${ext}`;
      break;
    
    case 'viewer':
      s3Key = `profiles/viewer/${sanitize(user.clientId)}/${userId}_${timestamp}_${user.userName}_${ext}`;
      break;
    
    default:
      s3Key = `profiles/misc/${userId}_${timestamp}_${user.userName}_${ext}`;
  }
  
  console.log('[IMAGE UPLOAD] Generated S3 key:', s3Key);
  return s3Key;
}

/**
 * Save user profile image to S3
 */
exports.saveUserProfileImage = async function saveUserProfileImage(req, userDoc) {
  try {
    console.log('[IMAGE UPLOAD] ====== START saveUserProfileImage ======');
    console.log('[IMAGE UPLOAD] User ID:', userDoc._id);
    console.log('[IMAGE UPLOAD] User Type:', userDoc.userType);
    console.log('[IMAGE UPLOAD] Has req.file?', !!req.file);
    
    if (!req.file) {
      console.log('[IMAGE UPLOAD] ⚠️ No file in request, skipping upload');
      return userDoc;
    }
    
    if (!userDoc) {
      throw new Error('User document is required');
    }

    console.log('[IMAGE UPLOAD] File details:', {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      bufferLength: req.file.buffer ? req.file.buffer.length : 0
    });

    // Validate buffer
    if (!req.file.buffer || req.file.buffer.length === 0) {
      throw new Error('File buffer is empty or missing');
    }

    const ext = path.extname(req.file.originalname || '.jpg') || '.jpg';
    const bucketName = process.env.S3_PROFILE_IMAGES_BUCKET || 'zerocarbon-profile-images-prod';
    
    console.log('[IMAGE UPLOAD] Using bucket:', bucketName);
    console.log('[IMAGE UPLOAD] AWS Region:', process.env.AWS_REGION || 'us-east-1');
    
    const s3Key = buildS3Key(userDoc, ext);

    // Delete old profile image from S3 if exists
    if (userDoc.profileImage?.s3Key) {
      console.log('[IMAGE UPLOAD] 🗑️ Deleting old profile image:', userDoc.profileImage.s3Key);
      try {
        await deleteFromS3(bucketName, userDoc.profileImage.s3Key);
        console.log('[IMAGE UPLOAD] ✅ Old image deleted');
      } catch (err) {
        console.error('[IMAGE UPLOAD] ⚠️ Failed to delete old profile image:', err.message);
      }
    }

    // Upload new image to S3
    console.log('[IMAGE UPLOAD] 📤 Uploading to S3...');
    const s3Url = await uploadBufferToS3(
      req.file.buffer,
      bucketName,
      s3Key,
      req.file.mimetype
    );
    
    console.log('[IMAGE UPLOAD] ✅ Upload successful!');
    console.log('[IMAGE UPLOAD] S3 URL:', s3Url);

    // Update user document
    userDoc.profileImage = {
      filename: path.basename(s3Key),
      url: s3Url,
      s3Key: s3Key,
      bucket: bucketName,
      uploadedAt: new Date()
    };

    await userDoc.save();
    console.log('[IMAGE UPLOAD] ✅ User document updated with image metadata');
    console.log('[IMAGE UPLOAD] ====== END saveUserProfileImage ======');
    
    return userDoc;

  } catch (err) {
    console.error('[IMAGE UPLOAD] ❌ ERROR in saveUserProfileImage:', err);
    console.error('[IMAGE UPLOAD] Error stack:', err.stack);
    throw err;
  }
};

function sanitize(str) {
  const sanitized = (str || '').toString().trim().replace(/[^\w.-]+/g, '_') || 'unknown';
  console.log('[IMAGE UPLOAD] Sanitized:', str, '->', sanitized);
  return sanitized;
}