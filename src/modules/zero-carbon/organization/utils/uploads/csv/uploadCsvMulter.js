const multer = require('multer');

// ✅ Store file in memory (RAM)
const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.endsWith('.csv')) {
      return cb(new Error('Only CSV files allowed'), false);
    }
    cb(null, true);
  }
});

module.exports = uploadCsv;
