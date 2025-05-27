const express = require('express');
const router = express.Router();
const emissionFactorController = require('../controllers/EmissionFactorController');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

// Routes

// Create a new category with userName
router.post('/categories', emissionFactorController.createCategory);

// Bulk CSV upload (file or raw CSV in body.csv)
router.post(
  '/categories/bulk',
  upload.single('file'),
  emissionFactorController.bulkUpload
);

// Get all categories
router.get('/categories', emissionFactorController.getCategories);

router.get(
  '/categories/download',
  emissionFactorController.downloadCSV
);

// Add a new activity to a category
router.post('/categories/activity', emissionFactorController.addActivity);

// Add a new fuel to an activity
// router.post('/categories/activity/fuel', emissionFactorController.addFuel);

// Filter data by category, activity, or fuel name
router.get('/categories/filter', emissionFactorController.filterData);

// Get category by ID
router.get('/categories/:categoryId', emissionFactorController.getCategoryById);

// Update category by ID
router.patch('/categories/:categoryId', emissionFactorController.updateCategoryById);

// Delete category by ID
router.delete('/categories/:categoryId', emissionFactorController.deleteCategoryById);



module.exports = router;
