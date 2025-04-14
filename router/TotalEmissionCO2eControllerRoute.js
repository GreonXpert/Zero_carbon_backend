const express = require("express");
const router = express.Router();
const totalEmissionController = require("../controllers/TotalEmissionCO2eController");

// Calculate and save total emissions
router.post("/total-emissions", totalEmissionController.calculateAndSaveTotalEmissions);

// Get total emissions by userId
router.get("/total-emissions/:userId", totalEmissionController.getTotalEmissionsByUserId);

module.exports = router;
