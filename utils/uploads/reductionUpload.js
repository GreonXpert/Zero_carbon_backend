const fs = require('fs');
const path = require('path');
const multer = require('multer');

// ----------------------------------------------------
// ACCEPTED IMAGE MIME TYPES
// ----------------------------------------------------
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

// create temp folder
const tmpDir = path.join('uploads', '_tmp');
fs.mkdirSync(tmpDir, { recursive: true });

// ----------------------------------------------------
// MULTER STORAGE + FILTER
// ----------------------------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, tmpDir),

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    const base = path.basename(file.originalname || 'file', ext).replace(/\s+/g, '_');
    cb(null, `${Date.now()}_${base}${ext}`);
  }
});

// Validate File Type (ONLY IMAGES)
function fileFilter(req, file, cb) {
  if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    return cb(
      new Error(`Invalid file type: ${file.mimetype}. Only image files are allowed.`),
      false
    );
  }
  cb(null, true);
}

// Export Multer Middleware
exports.uploadReductionMedia = multer({
  storage,
  fileFilter,
  limits: { files: 6 }  // 1 cover + 5 gallery images
}).fields([
  { name: 'coverImage', maxCount: 1 },
  { name: 'images', maxCount: 5 }
]);

// ----------------------------------------------------
// HELPERS
// ----------------------------------------------------
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function publicUrlFrom(absPath) {
  const norm = absPath.replace(/\\/g, '/');
  const idx = norm.indexOf('uploads/');
  return idx >= 0 ? `/${norm.slice(idx)}` : '';
}

// ----------------------------------------------------
// MOVE FILES FROM TEMP TO FINAL FOLDERS
// ----------------------------------------------------
exports.saveReductionFiles = async function saveReductionFiles(req, doc) {
  if (!req || !doc) return;

  const userId = req.user?.id?.toString?.() || 'unknown';
  const rid = doc.reductionId;
  if (!rid) return;

  const coverDir = path.join('uploads', 'Reduction', 'CoverImage', userId);
  const imgsDir = path.join('uploads', 'Reduction', 'images', userId);

  ensureDir(coverDir);
  ensureDir(imgsDir);

  // ----------------------------------------------------
  // SAVE COVER IMAGE (1 FILE)
  // ----------------------------------------------------
  const cover = req.files?.coverImage?.[0];
  if (cover) {
    const ext = path.extname(cover.originalname || '.jpg') || '.jpg';
    const target = path.join(coverDir, `${rid}${ext}`);

    fs.renameSync(cover.path, target);

    doc.coverImage = {
      filename: path.basename(target),
      path: target,
      url: publicUrlFrom(target),
      uploadedAt: new Date()
    };
  }

  // ----------------------------------------------------
  // SAVE GALLERY IMAGES (MAX 5)
  // ----------------------------------------------------
  const incoming = Array.isArray(req.files?.images) ? req.files.images.slice(0, 5) : [];
  if (incoming.length) {
    const existing = Array.isArray(doc.images) ? doc.images : [];
    const slotsLeft = Math.max(0, 5 - existing.length);
    const toUse = incoming.slice(0, slotsLeft);

    const appended = toUse.map((file, i) => {
      const ext = path.extname(file.originalname || '.jpg') || '.jpg';
      const fileIndex = existing.length + i + 1;

      const target = path.join(imgsDir, `${rid}-${fileIndex}${ext}`);
      fs.renameSync(file.path, target);

      return {
        filename: path.basename(target),
        path: target,
        url: publicUrlFrom(target),
        uploadedAt: new Date()
      };
    });

    doc.images = [...existing, ...appended].slice(0, 5);
  }
};
