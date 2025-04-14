const FuelCombustion = require('../models/FuelCombustion');
const GWP = require('../models/GWP'); // To fetch GWP values

// Add new Fuel Combustion data with calculations
// Add new Fuel Combustion data with calculations
// exports.addFuelCombustion = async (req, res) => {
//     try {
//       const {
//         category,
//         activity,
//         fuel,
//         NCV,
//         CO2,
//         CH4,
//         N2O,
//         unit,
//         fuelDensityLiter,
//         fuelDensityM3,
//         CO2Formula, // Chemical formula for CO2
//         CH4Formula, // Chemical formula for CH4
//         N2OFormula, // Chemical formula for N2O
//         CO2AssessmentType, // Assessment type for CO2 (e.g., AR5, AR6)
//         CH4AssessmentType, // Assessment type for CH4
//         N2OAssessmentType, // Assessment type for N2O
//         source,
//         reference
//       } = req.body;
  
//       // Helper function to fetch assessment value based on chemicalFormula and assessmentType
//       const findAssessmentValue = async (chemicalFormula, assessmentType) => {
//         const gwpData = await GWP.findOne({ chemicalFormula }).lean();
//         if (!gwpData) {
//           throw new Error(`GWP data not found for the chemical formula: ${chemicalFormula}`);
//         }
  
//         const assessmentValue = gwpData.assessments[assessmentType];
//         if (!assessmentValue) {
//           throw new Error(
//             `AssessmentType '${assessmentType}' not found for the chemical formula: ${chemicalFormula}`
//           );
//         }
  
//         return parseFloat(assessmentValue);
//       };
  
//       // Step 1: Find GWP values for each formula and assessment type
//       const CO2GWPValue = await findAssessmentValue(CO2Formula, CO2AssessmentType);
//       const CH4GWPValue = await findAssessmentValue(CH4Formula, CH4AssessmentType);
//       const N2OGWPValue = await findAssessmentValue(N2OFormula, N2OAssessmentType);
  
//       // Step 2: Calculate CO2, CH4, N2O per Kg/T
//       const CO2_KgT = (NCV * CO2) / 1000;
//       const CH4_KgT = (NCV * CH4) / 1000;
//       const N2O_KgT = (NCV * N2O) / 1000;
  
//       // Step 3: Calculate CO2e using the assessment values
//       const CO2e =
//         (CO2_KgT * CO2GWPValue) +
//         (CH4_KgT * CH4GWPValue) +
//         (N2O_KgT * N2OGWPValue);
  
//       // Step 4: Calculate densities for Kg/L and Kg/m³
//       let CO2_KgL = null,
//         CO2_Kgm3 = null,
//         CH4_KgL = null,
//         CH4_Kgm3 = null,
//         N2O_KgL = null,
//         N2O_Kgm3 = null,
//         CO2e_KgL = null,
//         CO2e_Kgm3 = null;
  
//       if (fuelDensityLiter) {
//         CO2_KgL = (CO2_KgT * fuelDensityLiter) / 1000;
//         CH4_KgL = (CH4_KgT * fuelDensityLiter) / 1000;
//         N2O_KgL = (N2O_KgT * fuelDensityLiter) / 1000;
  
//         // Calculate CO2e (Kg/L)
//         CO2e_KgL = (CO2e * fuelDensityLiter) / 1000;
//       }
  
//       if (fuelDensityM3) {
//         CO2_Kgm3 = (CO2_KgT * fuelDensityM3) / 1000;
//         CH4_Kgm3 = (CH4_KgT * fuelDensityM3) / 1000;
//         N2O_Kgm3 = (N2O_KgT * fuelDensityM3) / 1000;
  
//         // Calculate CO2e (Kg/m³)
//         CO2e_Kgm3 = (CO2e * fuelDensityM3) / 1000;
//       }
  
//       // Step 5: Save all data to the database
//       const newEntry = new FuelCombustion({
//         category,
//         activity,
//         fuel,
//         NCV,
//         CO2,
//         CH4,
//         N2O,
//         unit,
//         CO2_KgT,
//         CH4_KgT,
//         N2O_KgT,
//         CO2e,
//         fuelDensityLiter,
//         fuelDensityM3,
//         CO2_KgL,
//         CO2_Kgm3,
//         CH4_KgL,
//         CH4_Kgm3,
//         N2O_KgL,
//         N2O_Kgm3,
//         CO2e_KgL,
//         CO2e_Kgm3,
//         assessmentType: `CO2: ${CO2AssessmentType}, CH4: ${CH4AssessmentType}, N2O: ${N2OAssessmentType}`,
//         source,
//         reference
//       });
  
//       await newEntry.save();
//       res.status(201).json({ message: 'Fuel Combustion data added successfully!', data: newEntry });
//     } catch (error) {
//       console.error('Error:', error.message);
//       res.status(500).json({ message: 'Failed to add Fuel Combustion data', error: error.message });
//     }
//   };
 


exports.addFuelCombustion = async (req, res) => {
    try {
        const {
            category,
            activity,
            fuel,
            NCV,
            CO2,
            CH4,
            N2O,
            unit,
            fuelDensityLiter,
            fuelDensityM3,
            CO2Formula,
            CH4Formula,
            N2OFormula,
            source,
            reference,
        } = req.body;

        // Helper function to fetch GWP values for all assessment types
        const fetchGWPValues = async (chemicalFormula) => {
            const gwpData = await GWP.findOne({ chemicalFormula }).lean();
            if (!gwpData) throw new Error(`GWP data not found for formula: ${chemicalFormula}`);
            return gwpData.assessments;
        };

        // Fetch GWP values for each chemical formula
        const CO2GWPValues = await fetchGWPValues(CO2Formula);
        const CH4GWPValues = await fetchGWPValues(CH4Formula);
        const N2OGWPValues = await fetchGWPValues(N2OFormula);

        const assessments = [];

        // Calculate metrics for each assessment type
        for (const [assessmentType, CO2GWPValue] of Object.entries(CO2GWPValues)) {
            const CH4GWPValue = CH4GWPValues[assessmentType];
            const N2OGWPValue = N2OGWPValues[assessmentType];

            const CO2_KgT = (NCV * CO2) / 1000;
            const CH4_KgT = (NCV * CH4) / 1000;
            const N2O_KgT = (NCV * N2O) / 1000;

            const CO2e = (CO2_KgT * CO2GWPValue) + (CH4_KgT * CH4GWPValue) + (N2O_KgT * N2OGWPValue);

            const CO2_KgL = fuelDensityLiter ? (CO2_KgT * fuelDensityLiter) / 1000 : null;
            const CH4_KgL = fuelDensityLiter ? (CH4_KgT * fuelDensityLiter) / 1000 : null;
            const N2O_KgL = fuelDensityLiter ? (N2O_KgT * fuelDensityLiter) / 1000 : null;
            const CO2e_KgL = fuelDensityLiter ? (CO2e * fuelDensityLiter) / 1000 : null;

            const CO2_Kgm3 = fuelDensityM3 ? (CO2_KgT * fuelDensityM3) / 1000 : null;
            const CH4_Kgm3 = fuelDensityM3 ? (CH4_KgT * fuelDensityM3) / 1000 : null;
            const N2O_Kgm3 = fuelDensityM3 ? (N2O_KgT * fuelDensityM3) / 1000 : null;
            const CO2e_Kgm3 = fuelDensityM3 ? (CO2e * fuelDensityM3) / 1000 : null;

            assessments.push({
                assessmentType,
                CO2_KgT,
                CH4_KgT,
                N2O_KgT,
                CO2e,
                CO2_KgL,
                CH4_KgL,
                N2O_KgL,
                CO2e_KgL,
                CO2_Kgm3,
                CH4_Kgm3,
                N2O_Kgm3,
                CO2e_Kgm3,
            });
        }

        // Save data to the database
        const newEntry = new FuelCombustion({
            category,
            activity,
            fuel,
            NCV,
            CO2,
            CH4,
            N2O,
            unit,
            fuelDensityLiter,
            fuelDensityM3,
            source,
            reference,
            assessments,
        });

        await newEntry.save();
        res.status(201).json({ message: 'Fuel Combustion data added successfully!', data: newEntry });
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ message: 'Failed to add Fuel Combustion data', error: error.message });
    }
};

  
  
  


// Update Fuel Combustion data and recalculate
// Update Fuel Combustion data and recalculate
// Update Fuel Combustion data and recalculate
// exports.updateFuelCombustion = async (req, res) => {
//   try {
//       const { id } = req.params; // Document ID to update
//       const {
//           NCV,
//           CO2,
//           CH4,
//           N2O,
//           fuelDensityLiter,
//           fuelDensityM3,
//           CO2Formula,
//           CH4Formula,
//           N2OFormula,
//       } = req.body;

//       // Step 1: Find the existing Fuel Combustion data
//       const fuelCombustion = await FuelCombustion.findById(id);
//       if (!fuelCombustion) {
//           return res.status(404).json({ message: 'Fuel Combustion data not found' });
//       }

//       // Step 2: Update fields if provided in the request
//       if (NCV !== undefined) fuelCombustion.NCV = NCV;
//       if (CO2 !== undefined) fuelCombustion.CO2 = CO2;
//       if (CH4 !== undefined) fuelCombustion.CH4 = CH4;
//       if (N2O !== undefined) fuelCombustion.N2O = N2O;
//       if (fuelDensityLiter !== undefined) fuelCombustion.fuelDensityLiter = fuelDensityLiter;
//       if (fuelDensityM3 !== undefined) fuelCombustion.fuelDensityM3 = fuelDensityM3;

//       // Helper function to fetch GWP values for all assessment types
//       const fetchGWPValues = async (chemicalFormula) => {
//           const gwpData = await GWP.findOne({ chemicalFormula }).lean();
//           if (!gwpData) throw new Error(`GWP data not found for formula: ${chemicalFormula}`);
//           return gwpData.assessments;
//       };

//       // Fetch GWP values for each chemical formula
//       const CO2GWPValues = await fetchGWPValues(CO2Formula);
//       const CH4GWPValues = await fetchGWPValues(CH4Formula);
//       const N2OGWPValues = await fetchGWPValues(N2OFormula);

//       const assessments = [];

//       // Recalculate metrics for all assessment types
//       for (const [assessmentType, CO2GWPValue] of Object.entries(CO2GWPValues)) {
//           const CH4GWPValue = CH4GWPValues[assessmentType];
//           const N2OGWPValue = N2OGWPValues[assessmentType];

//           const CO2_KgT = (fuelCombustion.NCV * fuelCombustion.CO2) / 1000;
//           const CH4_KgT = (fuelCombustion.NCV * fuelCombustion.CH4) / 1000;
//           const N2O_KgT = (fuelCombustion.NCV * fuelCombustion.N2O) / 1000;

//           const CO2e = (CO2_KgT * CO2GWPValue) + (CH4_KgT * CH4GWPValue) + (N2O_KgT * N2OGWPValue);

//           const CO2_KgL = fuelCombustion.fuelDensityLiter ? (CO2_KgT * fuelCombustion.fuelDensityLiter) / 1000 : null;
//           const CH4_KgL = fuelCombustion.fuelDensityLiter ? (CH4_KgT * fuelCombustion.fuelDensityLiter) / 1000 : null;
//           const N2O_KgL = fuelCombustion.fuelDensityLiter ? (N2O_KgT * fuelCombustion.fuelDensityLiter) / 1000 : null;
//           const CO2e_KgL = fuelCombustion.fuelDensityLiter ? (CO2e * fuelCombustion.fuelDensityLiter) / 1000 : null;

//           const CO2_Kgm3 = fuelCombustion.fuelDensityM3 ? (CO2_KgT * fuelCombustion.fuelDensityM3) / 1000 : null;
//           const CH4_Kgm3 = fuelCombustion.fuelDensityM3 ? (CH4_KgT * fuelCombustion.fuelDensityM3) / 1000 : null;
//           const N2O_Kgm3 = fuelCombustion.fuelDensityM3 ? (N2O_KgT * fuelCombustion.fuelDensityM3) / 1000 : null;
//           const CO2e_Kgm3 = fuelCombustion.fuelDensityM3 ? (CO2e * fuelCombustion.fuelDensityM3) / 1000 : null;

//           assessments.push({
//               assessmentType,
//               CO2_KgT,
//               CH4_KgT,
//               N2O_KgT,
//               CO2e,
//               CO2_KgL,
//               CH4_KgL,
//               N2O_KgL,
//               CO2e_KgL,
//               CO2_Kgm3,
//               CH4_Kgm3,
//               N2O_Kgm3,
//               CO2e_Kgm3,
//           });
//       }

//       // Update assessments in the document
//       fuelCombustion.assessments = assessments;

//       // Save updated document
//       const updatedFuelCombustion = await fuelCombustion.save();

//       res.status(200).json({
//           message: 'Fuel Combustion data updated successfully!',
//           data: updatedFuelCombustion,
//       });
//   } catch (error) {
//       console.error('Error:', error.message);
//       res.status(500).json({ message: 'Failed to update Fuel Combustion data', error: error.message });
//   }
// };

exports.updateFuelCombustion = async (req, res) => {
  try {
      const { id } = req.params; // Document ID to update
      const {
          category,
          activity,
          source,
          reference,
          NCV,
          CO2,
          CH4,
          N2O,
          fuelDensityLiter,
          fuelDensityM3,
          CO2Formula, // Chemical formula for CO2
          CH4Formula, // Chemical formula for CH4
          N2OFormula // Chemical formula for N2O
      } = req.body;

      // Step 1: Find the existing Fuel Combustion data
      const fuelCombustion = await FuelCombustion.findById(id);
      if (!fuelCombustion) {
          return res.status(404).json({ message: 'Fuel Combustion data not found' });
      }

      // Step 2: Update fields if provided in the request
      if (category !== undefined) fuelCombustion.category = category;
      if (activity !== undefined) fuelCombustion.activity = activity;
      if (source !== undefined) fuelCombustion.source = source;
      if (reference !== undefined) fuelCombustion.reference = reference;
      if (NCV !== undefined) fuelCombustion.NCV = NCV;
      if (CO2 !== undefined) fuelCombustion.CO2 = CO2;
      if (CH4 !== undefined) fuelCombustion.CH4 = CH4;
      if (N2O !== undefined) fuelCombustion.N2O = N2O;
      if (fuelDensityLiter !== undefined) fuelCombustion.fuelDensityLiter = fuelDensityLiter;
      if (fuelDensityM3 !== undefined) fuelCombustion.fuelDensityM3 = fuelDensityM3;

      // Helper function to fetch GWP values
      const fetchGWPValues = async (chemicalFormula) => {
          const gwpData = await GWP.findOne({ chemicalFormula }).lean();
          if (!gwpData) throw new Error(`GWP data not found for formula: ${chemicalFormula}`);
          return gwpData.assessments;
      };

      // Step 3: Fetch GWP values for each chemical formula
      const CO2GWPValues = await fetchGWPValues(CO2Formula);
      const CH4GWPValues = await fetchGWPValues(CH4Formula);
      const N2OGWPValues = await fetchGWPValues(N2OFormula);

      const assessments = [];

      // Step 4: Recalculate metrics for each assessment type
      for (const [assessmentType, CO2GWPValue] of Object.entries(CO2GWPValues)) {
          const CH4GWPValue = CH4GWPValues[assessmentType];
          const N2OGWPValue = N2OGWPValues[assessmentType];

          const CO2_KgT = (fuelCombustion.NCV * fuelCombustion.CO2) / 1000;
          const CH4_KgT = (fuelCombustion.NCV * fuelCombustion.CH4) / 1000;
          const N2O_KgT = (fuelCombustion.NCV * fuelCombustion.N2O) / 1000;

          const CO2e = (CO2_KgT * CO2GWPValue) + (CH4_KgT * CH4GWPValue) + (N2O_KgT * N2OGWPValue);

          const CO2_KgL = fuelCombustion.fuelDensityLiter ? (CO2_KgT * fuelCombustion.fuelDensityLiter) / 1000 : null;
          const CH4_KgL = fuelCombustion.fuelDensityLiter ? (CH4_KgT * fuelCombustion.fuelDensityLiter) / 1000 : null;
          const N2O_KgL = fuelCombustion.fuelDensityLiter ? (N2O_KgT * fuelCombustion.fuelDensityLiter) / 1000 : null;
          const CO2e_KgL = fuelCombustion.fuelDensityLiter ? (CO2e * fuelCombustion.fuelDensityLiter) / 1000 : null;

          const CO2_Kgm3 = fuelCombustion.fuelDensityM3 ? (CO2_KgT * fuelCombustion.fuelDensityM3) / 1000 : null;
          const CH4_Kgm3 = fuelCombustion.fuelDensityM3 ? (CH4_KgT * fuelCombustion.fuelDensityM3) / 1000 : null;
          const N2O_Kgm3 = fuelCombustion.fuelDensityM3 ? (N2O_KgT * fuelCombustion.fuelDensityM3) / 1000 : null;
          const CO2e_Kgm3 = fuelCombustion.fuelDensityM3 ? (CO2e * fuelCombustion.fuelDensityM3) / 1000 : null;

          assessments.push({
              assessmentType,
              CO2_KgT,
              CH4_KgT,
              N2O_KgT,
              CO2e,
              CO2_KgL,
              CH4_KgL,
              N2O_KgL,
              CO2e_KgL,
              CO2_Kgm3,
              CH4_Kgm3,
              N2O_Kgm3,
              CO2e_Kgm3
          });
      }

      // Step 5: Update assessments in the document
      fuelCombustion.assessments = assessments;

      // Step 6: Save updated document
      const updatedFuelCombustion = await fuelCombustion.save();

      res.status(200).json({
          message: 'Fuel Combustion data updated successfully!',
          data: updatedFuelCombustion
      });
  } catch (error) {
      console.error('Error:', error.message);
      res.status(500).json({ message: 'Failed to update Fuel Combustion data', error: error.message });
  }
};



  

// Get all Fuel Combustion data
exports.getAllFuelCombustion = async (req, res) => {
    try {
      const data = await FuelCombustion.find();
      res.status(200).json({ message: 'All Fuel Combustion data fetched successfully', data });
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ message: 'Failed to fetch Fuel Combustion data', error: error.message });
    }
  };

// Get Fuel Combustion data by ID
exports.getFuelCombustionById = async (req, res) => {
    try {
      const { id } = req.params;
      const data = await FuelCombustion.findById(id);
      if (!data) {
        return res.status(404).json({ message: 'Fuel Combustion data not found' });
      }
      res.status(200).json({ message: 'Fuel Combustion data fetched successfully', data });
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ message: 'Failed to fetch Fuel Combustion data', error: error.message });
    }
  };
// Filter Fuel Combustion data based on category, activity, or fuel
exports.filterFuelCombustion = async (req, res) => {
    try {
      const { category, activity, fuel } = req.query;
  
      // Build dynamic filter object based on the query parameters provided
      const filter = {};
      if (category) filter.category = { $regex: category, $options: 'i' }; // Case-insensitive
      if (activity) filter.activity = { $regex: activity, $options: 'i' }; // Case-insensitive
      if (fuel) filter.fuel = { $regex: fuel, $options: 'i' }; // Case-insensitive
  
      // Fetch data based on the filter
      const data = await FuelCombustion.find(filter);
  
      if (data.length === 0) {
        return res.status(404).json({ message: 'No Fuel Combustion data found matching the criteria' });
      }
  
      res.status(200).json({
        message: 'Filtered Fuel Combustion data fetched successfully',
        data,
      });
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ message: 'Failed to filter Fuel Combustion data', error: error.message });
    }
  };
// Delete Fuel Combustion data by ID
exports.deleteFuelCombustionById = async (req, res) => {
    try {
      const { id } = req.params;
      const deletedData = await FuelCombustion.findByIdAndDelete(id);
      if (!deletedData) {
        return res.status(404).json({ message: 'Fuel Combustion data not found' });
      }
      res.status(200).json({ message: 'Fuel Combustion data deleted successfully', data: deletedData });
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ message: 'Failed to delete Fuel Combustion data', error: error.message });
    }
  };
  