const TotalEmissionElectricity = require("../models/TotalEmissionElectricity");
const CalculationOfElectricity = require("../models/CalculationOfElectricity");
const mongoose = require("mongoose");

exports.calculateAndSaveTotalElectricityEmissions = async (req, res) => {
  try {
    const { userId, period } = req.body;

    if (!["monthly", "yearly"].includes(period)) {
      return res.status(400).json({ message: "Invalid period. Use 'monthly' or 'yearly'." });
    }

    // Group by period (month/year)
    const format = period === "monthly" ? "%m/%Y" : "%Y";

    // Fetch and aggregate data
    const emissions = await CalculationOfElectricity.aggregate([
      {
        $match: { userId: new mongoose.Types.ObjectId(userId) },
      },
      {
        $group: {
          _id: {
            periodValue: {
              $dateToString: {
                format,
                date: { $dateFromString: { dateString: "$startDate", format: "%d/%m/%Y" } },
              },
            },
          },
          totalEmissionCO2e: { $sum: "$emissionCO2e" },
        },
      },
      {
        $sort: { "_id.periodValue": 1 }, // Ensure sorting by period for cumulative calculation
      },
    ]);

    if (!emissions.length) {
      return res.status(404).json({ message: "No emission data found for the specified user." });
    }

    // Calculate cumulative totals
    let cumulativeCO2e = 0;

    const totalEmissions = emissions.map((emission) => {
      cumulativeCO2e += emission.totalEmissionCO2e;

      return {
        userId: userId,
        period,
        periodValue: emission._id.periodValue,
        totalEmissionCO2e: emission.totalEmissionCO2e,
        cumulativeEmissionCO2e: cumulativeCO2e,
      };
    });

    // Save or update totals
    for (const emission of totalEmissions) {
      await TotalEmissionElectricity.findOneAndUpdate(
        { userId: emission.userId, periodValue: emission.periodValue },
        emission,
        { upsert: true, new: true }
      );
    }

    res.status(201).json({
      message: "Total electricity emissions calculated and saved successfully.",
      data: totalEmissions,
    });
  } catch (error) {
    console.error("Error calculating and saving total electricity emissions:", error.message);
    res.status(500).json({ message: "An error occurred.", error: error.message });
  }
};

exports.getTotalElectricityEmissionsByUserId = async (req, res) => {
  try {
    const { userId } = req.params;

    const totals = await TotalEmissionElectricity.find({ userId }).sort({ periodValue: 1 });
    if (!totals.length) {
      return res.status(404).json({ message: "No total emissions data found for the specified user." });
    }

    res.status(200).json({ message: "Total electricity emissions fetched successfully.", data: totals });
  } catch (error) {
    console.error("Error fetching total electricity emissions:", error.message);
    res.status(500).json({ message: "An error occurred.", error: error.message });
  }
};
