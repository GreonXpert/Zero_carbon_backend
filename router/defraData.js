const express = require('express');
const router = express.Router();
const defraController = require('../controllers/DefraDataController');
const { auth, checkRole } = require('../middleware/auth');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

router.use(auth);

// Routes

const viewRoles = ['consultant','consultant_admin','super_admin','client_admin','auditor'];

// Create a new category with userName
router.post('/categories',checkRole('consultant_admin','super_admin'), defraController.createCategory);

// Bulk CSV upload (file or raw CSV in body.csv)
router.post(
  '/categories/bulk',
  checkRole('consultant_admin','super_admin'),
  upload.single('file'),
  defraController.bulkUpload
);

// Get all categories
router.get('/categories', defraController.getCategories);

router.get(
  '/categories/download',
   checkRole(...viewRoles),
  defraController.downloadCSV
);

// Add a new activity to a category
router.post('/categories/activity',checkRole('consultant_admin','super_admin'), defraController.addActivity);

// Add a new fuel to an activity
// router.post('/categories/activity/fuel', defraController.addFuel);

// Filter data by category, activity, or fuel name
router.get('/categories/filter', checkRole(...viewRoles), defraController.filterData);

// Get category by ID
router.get('/categories/:categoryId', checkRole(...viewRoles), defraController.getCategoryById);

// Update category by ID
router.patch('/categories/:categoryId',checkRole('consultant_admin','super_admin'), defraController.updateCategoryById);

// Delete category by ID
router.delete('/categories/:categoryId', checkRole('consultant_admin','super_admin'), defraController.deleteCategoryById);



module.exports = router;
