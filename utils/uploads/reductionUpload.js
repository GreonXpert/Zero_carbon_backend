const fs = require('fs');
const path = require('path');
const multer = require('multer');

// temp stash; we rename+move after we know reductionId
const tmpDir = path.join('uploads', '_tmp');
fs.mkdirSync(tmpDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, tmpDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    const base = path.basename(file.originalname || 'file', ext).replace(/\s+/g, '_');
    cb(null, `${Date.now()}_${base}${ext}`);
  }
});

exports.uploadReductionMedia = multer({
  storage,
  limits: { files: 6 } // 1 cover + up to 5 images
}).fields([
  { name: 'coverImage', maxCount: 1 },
  { name: 'images',     maxCount: 5 }
]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function publicUrlFrom(absPath) {
  // assume app.use('/uploads', express.static('uploads'))
  const norm = absPath.replace(/\\/g, '/');
  const idx = norm.indexOf('uploads/');
  return idx >= 0 ? `/${norm.slice(idx)}` : '';
}

/**
 * Move uploaded files from _tmp into:
 *   uploads/Reduction/CoverImage/<userId>/<reductionId>.<ext>
 *   uploads/Reduction/images/<userId>/<reductionId>-<n>.<ext>
 * and update doc.coverImage / doc.images accordingly.
 */
exports.saveReductionFiles = async function saveReductionFiles(req, doc) {
  if (!req || !doc) return;
  const userId = req.user?.id?.toString?.() || 'unknown';
  const rid = doc.reductionId; // guaranteed after first create validate【turn2file2†L33-L45】

  if (!rid) return;

  const coverDir = path.join('uploads', 'Reduction', 'CoverImage', userId);
  const imgsDir  = path.join('uploads', 'Reduction', 'images', userId);
  ensureDir(coverDir);
  ensureDir(imgsDir);

  // --- Cover image (single) ---
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

  // --- Gallery images (up to 5) ---
  const incoming = Array.isArray(req.files?.images) ? req.files.images.slice(0, 5) : [];
  if (incoming.length) {
    // keep existing images if any, then append (max 5)
    const existing = Array.isArray(doc.images) ? doc.images : [];
    const slotsLeft = Math.max(0, 5 - existing.length);
    const toUse = incoming.slice(0, slotsLeft);

    const appended = toUse.map((file, i) => {
      const ext = path.extname(file.originalname || '.jpg') || '.jpg';
      const indexNum = existing.length + i + 1; // continue numbering
      const target = path.join(imgsDir, `${rid}-${indexNum}${ext}`);
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
