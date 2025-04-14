const TotalEmissionCO2e = require("../models/TotalEmissionCO2e");
const CalculateEmissionCO2e = require("../models/CalculateEmissionCO2e");
const mongoose = require("mongoose");

exports.calculateAndSaveTotalEmissions = async (req, res) => {
  try {
    const { userId, period } = req.body;

    if (!["monthly", "yearly"].includes(period)) {
      return res.status(400).json({ message: "Invalid period. Use 'monthly' or 'yearly'." });
    }

    // Group by period (month/year)
    const format = period === "monthly" ? "%m/%Y" : "%Y";

    // Fetch and aggregate data
    const emissions = await CalculateEmissionCO2e.aggregate([
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
          totalEmissionCO2: { $sum: "$emissionCO2" },
          totalEmissionCH4: { $sum: "$emissionCH4" },
          totalEmissionN2O: { $sum: "$emissionN2O" },
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
    let cumulativeCO2 = 0;
    let cumulativeCH4 = 0;
    let cumulativeN2O = 0;

    const totalEmissions = emissions.map((emission) => {
      cumulativeCO2e += emission.totalEmissionCO2e;
      cumulativeCO2 += emission.totalEmissionCO2;
      cumulativeCH4 += emission.totalEmissionCH4;
      cumulativeN2O += emission.totalEmissionN2O;

      return {
        userId: userId,
        period,
        periodValue: emission._id.periodValue,
        totalEmissionCO2e: emission.totalEmissionCO2e,
        totalEmissionCO2: emission.totalEmissionCO2,
        totalEmissionCH4: emission.totalEmissionCH4,
        totalEmissionN2O: emission.totalEmissionN2O,
        cumulativeEmissionCO2e: cumulativeCO2e,
        cumulativeEmissionCO2: cumulativeCO2,
        cumulativeEmissionCH4: cumulativeCH4,
        cumulativeEmissionN2O: cumulativeN2O,
      };
    });

    // Save or update totals
    for (const emission of totalEmissions) {
      await TotalEmissionCO2e.findOneAndUpdate(
        { userId: emission.userId, periodValue: emission.periodValue },
        emission,
        { upsert: true, new: true }
      );
    }

    res.status(201).json({
      message: "Total emissions calculated and saved successfully.",
      data: totalEmissions,
    });
  } catch (error) {
    console.error("Error calculating and saving total emissions:", error.message);
    res.status(500).json({ message: "An error occurred.", error: error.message });
  }
};

exports.getTotalEmissionsByUserId = async (req, res) => {
  try {
    const { userId } = req.params;

    const totals = await TotalEmissionCO2e.find({ userId }).sort({ periodValue: 1 });
    if (!totals.length) {
      return res.status(404).json({ message: "No total emissions data found for the specified user." });
    }

    res.status(200).json({ message: "Total emissions fetched successfully.", data: totals });
  } catch (error) {
    console.error("Error fetching total emissions:", error.message);
    res.status(500).json({ message: "An error occurred.", error: error.message });
  }
};
