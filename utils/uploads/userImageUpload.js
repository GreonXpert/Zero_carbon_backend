// utils/upload/userImageUpload.js
const fs = require('fs');
const path = require('path');
const multer = require('multer');

// ───────────────────────────────────────────────────────────────
// ALLOWED IMAGE MIME TYPES
// ───────────────────────────────────────────────────────────────
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

// ───────────────────────── Temp folder ─────────────────────────
const tmpDir = path.join('uploads', '_tmp');
fs.mkdirSync(tmpDir, { recursive: true });

// ──────────────────────── Multer Storage ───────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, tmpDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    const base = path.basename(file.originalname || 'profile', ext)
      .replace(/\s+/g, '_');
    cb(null, `${Date.now()}_${base}${ext}`);
  }
});

// ──────────────────────── File Filter ──────────────────────────
function fileFilter(req, file, cb) {
  if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    return cb(
      new Error(`Invalid file type: ${file.mimetype}. Only image files are allowed.`),
      false
    );
  }
  cb(null, true);
}

// DEBUG WRAPPER
const baseUpload = multer({
  storage,
  fileFilter,
  limits: { files: 1 }
}).single('profileImage');

exports.uploadUserImage = (req, res, next) => {
  baseUpload(req, res, (err) => {
    if (err) return next(err);

    const ct = req.headers['content-type'] || '';
    console.log('[UPLOAD DEBUG]', {
      contentType: ct,
      hasFile: !!req.file,
      bodyKeys: Object.keys(req.body || {})
    });

    next();
  });
};

// ───────────────────────── Utilities ─────────────────────────
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function publicUrlFrom(absPath) {
  const norm = absPath.replace(/\\/g, '/');
  const idx = norm.indexOf('uploads/');
  return idx >= 0 ? `/${norm.slice(idx)}` : '';
}

function sanitize(str) {
  return (str || '').toString().trim().replace(/[^\w.-]+/g, '_') || 'unknown';
}

// ─────────────────────── User Directory Logic ───────────────────────
function dirForUser(user) {
  const base = ['uploads', 'User'];
  const userId = user?._id?.toString?.() || 'unknown';

  switch (user.userType) {
    case 'super_admin':
      return path.join(...base, 'SuperAdmin');

    case 'consultant_admin':
      return path.join(...base, 'ConsultantAdmin', sanitize(user.teamName));

    case 'consultant':
      return path.join(...base, 'Consultant', sanitize(user.teamName));

    case 'client_admin':
      return path.join(...base, 'Client', sanitize(user.clientId), 'Admin');

    case 'client_employee_head':
      return path.join(...base, 'Client', sanitize(user.clientId), 'EmployeeHead', userId);

    case 'employee':
      return path.join(
        ...base,
        'Client',
        sanitize(user.clientId),
        'EmployeeHead',
        sanitize(user.employeeHeadId || 'unassigned'),
        'Employees'
      );

    case 'auditor':
      return path.join(...base, 'Client', sanitize(user.clientId), 'Auditor');

    case 'viewer':
      return path.join(...base, 'Client', sanitize(user.clientId), 'Viewer');

    default:
      return path.join(...base, 'Misc');
  }
}

// ───────────────────────── Filename Logic ─────────────────────────
function fileNameFor(user, ext) {
  if (user.userType === 'employee') {
    return `${sanitize(user.userName)}_${sanitize(user.clientId)}${ext || '.jpg'}`;
  }
  const userId = user?._id?.toString?.() || 'unknown';
  return `${userId}${ext || '.jpg'}`;
}

// ───────────────────────── Save Image Logic ─────────────────────────
exports.saveUserProfileImage = async function saveUserProfileImage(req, userDoc) {
  try {
    if (!req?.file || !userDoc) return userDoc;
    if (req._userImageConsumed) return userDoc;

    const ext = path.extname(req.file.originalname || '.jpg') || '.jpg';
    const targetDir = dirForUser(userDoc);
    ensureDir(targetDir);

    const filename = fileNameFor(userDoc, ext);
    const target = path.join(targetDir, filename);

    // Remove previous image
    const prev = userDoc.profileImage?.path;
    if (prev && fs.existsSync(prev)) {
      try { fs.unlinkSync(prev); } catch (_) {}
    }

    // Move new file
    fs.renameSync(req.file.path, target);
    req._userImageConsumed = true;

    userDoc.profileImage = {
      filename,
      path: target,
      url: publicUrlFrom(target),
      uploadedAt: new Date(),
      storedAt: targetDir.replace(/\\/g, '/')
    };

    await userDoc.save();
    return userDoc;

  } catch (err) {
    try {
      if (req?.file?.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (_) {}
    throw err;
  }
};
