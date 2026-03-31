const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const { auth, checkRole } = require('../../middleware/auth');
const cctsController = require('../../controllers/CCTS/CCTSController');

// ─── Multer ──────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(process.cwd(), 'uploads')),
    filename: (req, file, cb) => cb(null, `ccts-${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.xlsx', '.xls', '.csv'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error(`Only Excel (.xlsx, .xls) and CSV (.csv) files are allowed. Received: ${ext}`));
  },
});

// ─── Auth applied to all routes ──────────────────────────────────────────────
router.use(auth);

const editRoles = ['super_admin', 'consultant_admin'];
const viewRoles = ['super_admin', 'consultant_admin', 'consultant', 'client_admin'];

// ─── Routes ──────────────────────────────────────────────────────────────────

// Bulk routes BEFORE /:id to avoid param conflicts
router.post('/bulk-upload', checkRole(...editRoles), upload.single('file'), cctsController.bulkUpload);
router.post('/bulk-delete', checkRole(...editRoles), cctsController.bulkDeleteCCTSEntities);

// CRUD
router.post('/', checkRole(...editRoles), cctsController.createCCTSEntity);
router.get('/', checkRole(...viewRoles), cctsController.getCCTSEntities);
router.get('/:id', checkRole(...viewRoles), cctsController.getCCTSEntityById);
router.patch('/:id', checkRole(...editRoles), cctsController.updateCCTSEntity);
router.delete('/:id', checkRole(...editRoles), cctsController.deleteCCTSEntity);

module.exports = router;
