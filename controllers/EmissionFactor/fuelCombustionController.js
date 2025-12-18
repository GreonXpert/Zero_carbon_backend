const FuelCombustion = require('../../models/EmissionFactor/FuelCombustion');
const GWP = require('../../models/EmissionFactor/GWP'); // To fetch GWP values
const csvtojson = require('csvtojson');


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

  
  /**
 * Bulk-upload CSV or JSON → compute assessments → save many.
 */
exports.bulkUploadFuelCombustion = async (req, res) => {
  try {
    let rows = [];

    // 1. FILE UPLOAD PATH
    if (req.files && req.files.length) {
      // take the first file they sent
      const file = req.files[0];
      const name = file.originalname.toLowerCase();

      if (name.endsWith('.csv')) {
        // CSV → JSON
        const text = file.buffer.toString('utf8');
        rows = await csvtojson().fromString(text);

      } else if (name.match(/\.xlsx?$/)) {
        // Excel → JSON
        const workbook = XLSX.read(file.buffer, { type: 'buffer' });
        const sheet    = workbook.Sheets[workbook.SheetNames[0]];
        // defval: '' ensures empty cells become empty strings
        rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      } else {
        return res.status(400).json({ error: 'Unsupported file type. Upload .csv or .xlsx' });
      }
    }
    // 2. RAW CSV in JSON
    else if (req.body.csv) {
      rows = await csvtojson().fromString(req.body.csv);

    // 3. JSON array path
    } else if (Array.isArray(req.body.bulkData)) {
      rows = req.body.bulkData;

    } else {
      return res.status(400).json({
        error: 'No file uploaded, no CSV text, and no bulkData array found.'
      });
    }

    // now rows[] is an array of flat objects.
    // Helper to fetch GWP table for a formula
    const fetchGWP = async formula => {
      const gwp = await GWP.findOne({ chemicalFormula: formula }).lean();
      if (!gwp) throw new Error(`No GWP data for formula "${formula}"`);
      return gwp.assessments;
    };

    const created = [];
    for (const r of rows) {
      // pull out all the fields (strings from CSV may need casting)
      const {
        category, activity, fuel,
        NCV, CO2, CH4, N2O, unit,
        fuelDensityLiter, fuelDensityM3,
        CO2Formula, CH4Formula, N2OFormula,
        source, reference
      } = r;

      // fetch all GWP tables in parallel
      const [CO2GWP, CH4GWP, N2OGWP] = await Promise.all([
        fetchGWP(CO2Formula),
        fetchGWP(CH4Formula),
        fetchGWP(N2OFormula)
      ]);

      // calculate assessments
      const assessments = [];
      const ncv = parseFloat(NCV);
      const co2 = parseFloat(CO2);
      const ch4 = parseFloat(CH4);
      const n2o = parseFloat(N2O);
      const fDL = parseFloat(fuelDensityLiter) || null;
      const fDM = parseFloat(fuelDensityM3)    || null;

      for (const [type, gwpCO2] of Object.entries(CO2GWP)) {
        const gwpCH4 = CH4GWP[type];
        const gwpN2O = N2OGWP[type];
        const CO2_KgT = (ncv * co2) / 1000;
        const CH4_KgT = (ncv * ch4) / 1000;
        const N2O_KgT = (ncv * n2o) / 1000;
        const CO2e    = CO2_KgT * gwpCO2 + CH4_KgT * gwpCH4 + N2O_KgT * gwpN2O;

        assessments.push({
          assessmentType: type,
          CO2_KgT, CH4_KgT, N2O_KgT, CO2e,
          CO2_KgL:  fDL ? CO2_KgT * fDL / 1000 : null,
          CH4_KgL:  fDL ? CH4_KgT * fDL / 1000 : null,
          N2O_KgL:  fDL ? N2O_KgT * fDL / 1000 : null,
          CO2e_KgL: fDL ? CO2e    * fDL / 1000 : null,
          CO2_Kgm3: fDM ? CO2_KgT * fDM / 1000 : null,
          CH4_Kgm3: fDM ? CH4_KgT * fDM / 1000 : null,
          N2O_Kgm3: fDM ? N2O_KgT * fDM / 1000 : null,
          CO2e_Kgm3:fDM ? CO2e    * fDM / 1000 : null
        });
      }

      // save one doc
      const doc = new FuelCombustion({
        category, activity, fuel,
        NCV: ncv, CO2: co2, CH4: ch4, N2O: n2o,
        unit, fuelDensityLiter: fDL, fuelDensityM3: fDM,
        source, reference,
        assessments
      });
      await doc.save();
      created.push(doc);
    }

    res.status(201).json({
      message: `Imported ${created.length} entries`,
      created
    });

  } catch (err) {
    console.error('Bulk upload error:', err);
    res.status(500).json({ error: err.message });
  }
};
  



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


/**
  * Download all Fuel Combustion entries as a flattened CSV.
  * One row per assessmentType.
  */
exports.downloadCSV = async (req, res) => {
  try {
    // 1. Fetch all docs
    const docs = await FuelCombustion.find().lean();

    // 2. Build flat records array
    const records = [];
    docs.forEach(doc => {
      (doc.assessments || []).forEach(a => {
        records.push({
          category:           doc.category,
          activity:           doc.activity,
          fuel:               doc.fuel,
          NCV:                doc.NCV,
          CO2:                doc.CO2,
          CH4:                doc.CH4,
          N2O:                doc.N2O,
          unit:               doc.unit,
          fuelDensityLiter:   doc.fuelDensityLiter,
          fuelDensityM3:      doc.fuelDensityM3,
          source:             doc.source,
          reference:          doc.reference,
          assessmentType:     a.assessmentType,
          CO2_KgT:            a.CO2_KgT,
          CH4_KgT:            a.CH4_KgT,
          N2O_KgT:            a.N2O_KgT,
          CO2e:               a.CO2e,
          CO2_KgL:            a.CO2_KgL,
          CH4_KgL:            a.CH4_KgL,
          N2O_KgL:            a.N2O_KgL,
          CO2e_KgL:           a.CO2e_KgL,
          CO2_Kgm3:           a.CO2_Kgm3,
          CH4_Kgm3:           a.CH4_Kgm3,
          N2O_Kgm3:           a.N2O_Kgm3,
          CO2e_Kgm3:          a.CO2e_Kgm3,
          createdAt:          doc.createdAt,
          updatedAt:          doc.updatedAt
        });
      });
    });

    if (!records.length) {
      return res.status(404).json({ message: 'No Fuel Combustion data available for download' });
    }

    // 3. Define CSV columns
    const fields = [
      'category','activity','fuel','NCV','CO2','CH4','N2O','unit',
      'fuelDensityLiter','fuelDensityM3','source','reference',
      'assessmentType','CO2_KgT','CH4_KgT','N2O_KgT','CO2e',
      'CO2_KgL','CH4_KgL','N2O_KgL','CO2e_KgL',
      'CO2_Kgm3','CH4_Kgm3','N2O_Kgm3','CO2e_Kgm3',
      'createdAt','updatedAt'
    ];
    const header = fields.join(',');

    // 4. Build each CSV row, escaping quotes
    const rows = records.map(rec =>
      fields.map(f => {
        const v = rec[f] != null
          ? rec[f].toString().replace(/"/g,'""')
          : '';
        return `"${v}"`;
      }).join(',')
    );

    // 5. Send CSV
    const csv = [header, ...rows].join('\r\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="fuel_combustion.csv"'
    );
    return res.send(csv);

  } catch (err) {
    console.error('Fuel CSV download error:', err);
    res.status(500).json({ error: err.message });
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
  