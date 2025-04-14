const express = require("express");
const router = express.Router();
const upload = require("../utils/multer");
const calculateEmissionController = require("../controllers/CalculateEmissionCO2eController");

// Route for calculation and saving
router.post("/calculate-emission",upload.single("document"), calculateEmissionController.calculateAndSaveEmission);

// Get data by userId
router.get("/calculate-emission/:userId", calculateEmissionController.getEmissionDataByUserId);

// Edit data by userId
router.put("/calculate-emission/:userId", calculateEmissionController.editEmissionDataByUserId);

// Delete by userId and start/end dates
router.delete("/calculate-emission/:userId", calculateEmissionController.deleteEmissionDataByUserIdAndDates);

module.exports = router;
