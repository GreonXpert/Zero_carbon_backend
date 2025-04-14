const moment = require("moment");
const CalculateEmissionCO2e = require("../models/CalculateEmissionCO2e");
const CalculationDataOfEmissionC02e = require("../models/CalculationDataOfEmissionC02e");
const FuelCombustion = require("../models/FuelCombustion");
const EmissionFactor = require("../models/EmissionFactor");

exports.calculateAndSaveEmission = async (req, res) => {
  try {
    const {
      periodOfDate,
      startDate,
      consumedData,
      assessmentType,
      uncertaintyLevelConsumedData = 0,
      uncertaintyLevelEmissionFactor = 0,
      userId,
      comments,
      fuelSupplier,

    } = req.body;
    // Handle document upload
    const document = req.file ? req.file.path : "";

    // Step 1: Calculate endDate
    let endDate;
    if (periodOfDate === "monthly") {
      endDate = moment(startDate, "DD/MM/YYYY").add(1, "month").format("DD/MM/YYYY");
    } else if (periodOfDate === "yearly") {
      endDate = moment(startDate, "DD/MM/YYYY").add(1, "year").format("DD/MM/YYYY");
    } else if (periodOfDate === "weekly") {
      endDate = moment(startDate, "DD/MM/YYYY").add(1, "week").format("DD/MM/YYYY");
    } else if (periodOfDate === "3-months") {
      endDate = moment(startDate, "DD/MM/YYYY").add(3, "months").format("DD/MM/YYYY");
    } else {
      return res.status(400).json({ message: "Invalid periodOfDate. Use 'weekly', 'monthly', '3-months', or 'yearly'." });
    }

    // Step 2: Check for overlapping data based on periodOfDate
    let existingRecord;

    if (periodOfDate === "weekly") {
      // Check if any record exists for the same user within the week
      const startOfWeek = moment(startDate, "DD/MM/YYYY").startOf("isoWeek").format("DD/MM/YYYY");
      const endOfWeek = moment(startOfWeek, "DD/MM/YYYY").add(6, "days").format("DD/MM/YYYY");

      existingRecord = await CalculateEmissionCO2e.findOne({
        userId,
        startDate: { $gte: startOfWeek, $lte: endOfWeek },
      });

      if (existingRecord) {
        return res.status(400).json({
          message: `A record for the week starting ${startOfWeek} already exists for this user.`,
        });
      }
    } else if (periodOfDate === "monthly") {
      // Check if any record exists for the same user within the month
      const month = moment(startDate, "DD/MM/YYYY").format("MM/YYYY");

      existingRecord = await CalculateEmissionCO2e.findOne({
        userId,
        startDate: { $regex: `.*${month}$`, $options: "i" },
      });

      if (existingRecord) {
        return res.status(400).json({
          message: `A record for the month ${month} already exists for this user.`,
        });
      }
    } else if (periodOfDate === "yearly") {
      // Check if any record exists for the same user within the year
      const year = moment(startDate, "DD/MM/YYYY").format("YYYY");

      existingRecord = await CalculateEmissionCO2e.findOne({
        userId,
        startDate: { $regex: `.*${year}$`, $options: "i" },
      });

      if (existingRecord) {
        return res.status(400).json({
          message: `A record for the year ${year} already exists for this user.`,
        });
      }
    } else if (periodOfDate === "3-months") {
      // Check for overlapping 3-month intervals
      const startMonth = moment(startDate, "DD/MM/YYYY").startOf("month").format("MM/YYYY");
      const endMonth = moment(startDate, "DD/MM/YYYY").add(2, "months").endOf("month").format("MM/YYYY");

      existingRecord = await CalculateEmissionCO2e.findOne({
        userId,
        $or: [
          { startDate: { $regex: `.*${startMonth}$`, $options: "i" } },
          { startDate: { $regex: `.*${endMonth}$`, $options: "i" } },
        ],
      });

      if (existingRecord) {
        return res.status(400).json({
          message: `A record for the interval ${startMonth} to ${endMonth} already exists for this user.`,
        });
      }
    }

    // Step 3: Fetch data from CalculationDataOfEmissionC02e
    const calculationData = await CalculationDataOfEmissionC02e.findOne({ userId });
    if (!calculationData) {
      return res.status(404).json({ message: "No data found for the given userId." });
    }

    const { standards, activity, fuel, unit } = calculationData;

    // Step 4: Fetch emission factors based on standards
    let emissionData;
    if (standards === "IPCC") {
      emissionData = await FuelCombustion.findOne({ activity, fuel });
      if (!emissionData) {
        return res.status(404).json({ message: "No matching FuelCombustion data found." });
      }

      const assessment = emissionData.assessments.find((a) => a.assessmentType === assessmentType);
      if (!assessment) {
        return res.status(404).json({ message: `Assessment type ${assessmentType} not found.` });
      }

      // Fetch values based on unit
      const { CO2_KgL, CH4_KgL, N2O_KgL, CO2e_KgL } = assessment;

      // Calculate emissions
      const adjustedConsumedData = consumedData * (1 + uncertaintyLevelConsumedData / 100);
      const adjustedEmissionFactor = (factor) => factor * (1 + uncertaintyLevelEmissionFactor / 100);

      const emissionCO2 = adjustedConsumedData * adjustedEmissionFactor(CO2_KgL);
      const emissionCH4 = adjustedConsumedData * adjustedEmissionFactor(CH4_KgL);
      const emissionN2O = adjustedConsumedData * adjustedEmissionFactor(N2O_KgL);
      const emissionCO2e = adjustedConsumedData * adjustedEmissionFactor(CO2e_KgL);

      // Save data
      const newCalculation = new CalculateEmissionCO2e({
        periodOfDate,
        startDate,
        endDate,
        consumedData,
        assessmentType,
        uncertaintyLevelConsumedData,
        uncertaintyLevelEmissionFactor,
        emissionCO2,
        emissionCH4,
        emissionN2O,
        emissionCO2e,
        standards,
        userId,
        comments,
        fuelSupplier,
        document,
      });

      await newCalculation.save();
      return res.status(201).json({ message: "Calculation saved successfully.", data: newCalculation });
    } else if (standards === "DEFRA") {
      emissionData = await EmissionFactor.findOne({ "activities.name": activity });
      if (!emissionData) {
        return res.status(404).json({ message: "No matching EmissionFactor data found." });
      }

      const fuelData = emissionData.activities.find((a) => a.name === activity).fuels.find((f) => f.name === fuel);

      if (!fuelData) {
        return res.status(404).json({ message: "Fuel not found in EmissionFactor data." });
      }

      const unitData = fuelData.units.find((u) => u.type === unit);
      if (!unitData) {
        return res.status(404).json({ message: `Unit ${unit} not found.` });
      }

      const { kgCO2, kgCH4, kgN2O, kgCO2e } = unitData;

      // Calculate emissions
      const adjustedConsumedData = consumedData * (1 + uncertaintyLevelConsumedData / 100);
      const adjustedEmissionFactor = (factor) => factor * (1 + uncertaintyLevelEmissionFactor / 100);

      const emissionCO2 = adjustedConsumedData * adjustedEmissionFactor(kgCO2);
      const emissionCH4 = adjustedConsumedData * adjustedEmissionFactor(kgCH4);
      const emissionN2O = adjustedConsumedData * adjustedEmissionFactor(kgN2O);
      const emissionCO2e = adjustedConsumedData * adjustedEmissionFactor(kgCO2e);

      // Save data
      const newCalculation = new CalculateEmissionCO2e({
        periodOfDate,
        startDate,
        endDate,
        consumedData,
        assessmentType,
        uncertaintyLevelConsumedData,
        uncertaintyLevelEmissionFactor,
        emissionCO2,
        emissionCH4,
        emissionN2O,
        emissionCO2e,
        standards,
        userId,
        comments,
        fuelSupplier,
        document,
      });

      await newCalculation.save();
      return res.status(201).json({ message: "Calculation saved successfully.", data: newCalculation });
    } else {
      return res.status(400).json({ message: "Invalid standards value. Use 'IPCC' or 'DEFRA'." });
    }
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ message: "An error occurred while calculating emissions.", error: error.message });
  }
};




exports.getEmissionDataByUserId = async (req, res) => {
  try {
    const { userId } = req.params;

    const data = await CalculateEmissionCO2e.find({ userId }).populate("userId", "userName email");
    if (!data.length) {
      return res.status(404).json({ message: "No data found for the specified user." });
    }

    res.status(200).json({ message: "Data fetched successfully.", data });
  } catch (error) {
    res.status(500).json({ message: "Error fetching data.", error: error.message });
  }
};

exports.editEmissionDataByUserId = async (req, res) => {
  try {
    const { userId } = req.params;
    const { startDate, periodOfDate, ...otherFields } = req.body;

    let endDate;

    // Calculate endDate based on periodOfDate and startDate
    if (startDate && periodOfDate) {
      if (periodOfDate === "monthly") {
        endDate = moment(startDate, "DD/MM/YYYY").add(1, "month").format("DD/MM/YYYY");
      } else if (periodOfDate === "yearly") {
        endDate = moment(startDate, "DD/MM/YYYY").add(1, "year").format("DD/MM/YYYY");
      } else {
        return res.status(400).json({ message: "Invalid periodOfDate. Use 'monthly' or 'yearly'." });
      }
    }

    const updateData = { ...otherFields, startDate, endDate };

    const updatedData = await CalculateEmissionCO2e.findOneAndUpdate(
      { userId },
      updateData,
      { new: true, runValidators: true }
    );

    if (!updatedData) {
      return res.status(404).json({ message: "No data found for the specified user." });
    }

    res.status(200).json({ message: "Data updated successfully.", data: updatedData });
  } catch (error) {
    res.status(500).json({ message: "Error updating data.", error: error.message });
  }
};

exports.deleteEmissionDataByUserIdAndDates = async (req, res) => {
  try {
    const { userId } = req.params;
    const { startDate, endDate } = req.body;

    // Validate required fields
    if (!startDate || !endDate) {
      return res.status(400).json({ message: "Start date and end date are required." });
    }

    // Delete record based on userId, startDate, and endDate
    const deletedData = await CalculateEmissionCO2e.findOneAndDelete({
      userId,
      startDate,
      endDate,
    });

    if (!deletedData) {
      return res.status(404).json({ message: "No data found for the specified user and dates." });
    }

    res.status(200).json({ message: "Data deleted successfully.", data: deletedData });
  } catch (error) {
    res.status(500).json({ message: "Error deleting data.", error: error.message });
  }
};
