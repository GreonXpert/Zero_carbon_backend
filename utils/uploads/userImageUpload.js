// utils/upload/userImageUpload.js
const fs = require('fs');
const path = require('path');
const multer = require('multer');

// ───────────────────────── Temp stash (same approach as reductionUpload) ─────────────────────────
const tmpDir = path.join('uploads', '_tmp');
fs.mkdirSync(tmpDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, tmpDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    const base = path.basename(file.originalname || 'profile', ext).replace(/\s+/g, '_');
    cb(null, `${Date.now()}_${base}${ext}`);
  }
});

// 🔎 DEBUG WRAPPER — logs content-type, whether a file was parsed, and common mistakes
const baseUpload = multer({ storage, limits: { files: 1 } }).single('profileImage');

exports.uploadUserImage = (req, res, next) => {
  baseUpload(req, res, (err) => {
    if (err) return next(err);
    const ct = req.headers['content-type'] || '';
    console.log('[UPLOAD DEBUG]',
      { contentType: ct, hasFile: !!req.file, bodyKeys: Object.keys(req.body || {}) });

    // Most common mistakes:
    // 1) Not using multipart/form-data
    // 2) Using a field name other than 'profileImage'
    // 3) Frontend forgot FormData append for the file
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

function sanitize(name) {
  return (name || '').toString().trim().replace(/[^\w.-]+/g, '_') || 'unknown';
}

// Build folder path by user hierarchy
function dirForUser(user) {
  const base = ['uploads', 'User'];
  const userId = user?._id?.toString?.() || 'unknown';

  switch (user.userType) {
    case 'super_admin':
      return path.join(...base, 'SuperAdmin');

    case 'consultant_admin':
      // store by team name
      return path.join(...base, 'ConsultantAdmin', sanitize(user.teamName));

    case 'consultant':
      // consultant under a team
      return path.join(...base, 'Consultant', sanitize(user.teamName));

    case 'client_admin':
      return path.join(...base, 'Client', sanitize(user.clientId), 'Admin');

    case 'client_employee_head':
      // head has its own folder inside the Client
      return path.join(...base, 'Client', sanitize(user.clientId), 'EmployeeHead', userId);

    case 'employee':
      // employee lives under its head folder when available
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

// Build filename rules
function fileNameFor(user, ext) {
  // requirement: employee file should carry name + clientId
  if (user.userType === 'employee') {
    return `${sanitize(user.userName)}_${sanitize(user.clientId)}${ext || '.jpg'}`;
  }
  // default: use userId
  const userId = user?._id?.toString?.() || 'unknown';
  return `${userId}${ext || '.jpg'}`;
}

/**
 * Move uploaded profile image from tmp into hierarchy folder,
 * update user.profileImage, and remove any previous file.
 * - Expects req.file (from uploadUserImage)
 * - Requires app.use('/uploads', express.static('uploads')) in your server
 */
exports.saveUserProfileImage = async function saveUserProfileImage(req, userDoc) {
  try {
    if (!req?.file || !userDoc) return userDoc;
    if (req._userImageConsumed) return userDoc;

    const ext = path.extname(req.file.originalname || '.jpg') || '.jpg';
    const targetDir = dirForUser(userDoc);
    ensureDir(targetDir);

    const filename = fileNameFor(userDoc, ext);
    const target = path.join(targetDir, filename);

    const prev = userDoc.profileImage?.path;
    if (prev && fs.existsSync(prev)) {
      try { fs.unlinkSync(prev); } catch (_) {}
    }

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
    try { if (req?.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch (_) {}
    throw err;
  }
};
