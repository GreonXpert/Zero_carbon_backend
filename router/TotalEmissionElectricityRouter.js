const express = require("express");
const router = express.Router();
const electricityController = require("../controllers/TotalEmissionElectricityController");

// Calculate and save total electricity emissions
router.post("/total-electricity-emissions", electricityController.calculateAndSaveTotalElectricityEmissions);

// Get total electricity emissions by userId
router.get("/total-electricity-emissions/:userId", electricityController.getTotalElectricityEmissionsByUserId);

module.exports = router;
