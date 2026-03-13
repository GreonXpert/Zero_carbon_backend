const EmissionFactor = require('../../models/EmissionFactor/countryEmissionFactorModel');
const csvtojson = require('csvtojson');
const fs = require('fs');


const getMonthName = (month) => {
  const months = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'
  ];
  return months[parseInt(month, 10) - 1];
};


// Add new country emission factor
const addEmissionFactor = async (req, res) => {
  try {
    const r = req.body;

    if (Array.isArray(r)) {
      return res.status(400).json({
        message: 'For /add send a single object, not an array. Use /bulk-import for array payloads.'
      });
    }

    const country = (r.Country || r.country || '').trim();
    const regionGrid = (r.RegionGrid || r.regionGrid || '').trim();
    const emissionFactor = (r.EmissionFactor || r.emissionFactor || '').trim();
    const reference = (r.Reference || r.reference || '').trim();
    const unit = (r.Unit || r.unit || 'kWh').trim();
    const fromRaw = r.From || r.from;
    const toRaw = r.To || r.to;
    const valueRaw = r.Value ?? r.value;

    if (!country || !regionGrid || !emissionFactor) {
      return res.status(400).json({
        message: 'Missing required fields: Country, RegionGrid, or EmissionFactor.'
      });
    }

    let yearlyValues = [];

    if (Array.isArray(r.yearlyValues) && r.yearlyValues.length > 0) {
      yearlyValues = r.yearlyValues.map((value) => {
        const [fromDay, fromMonth, fromYear] = value.from.split('/');
        const [toDay, toMonth, toYear] = value.to.split('/');

        if (!fromDay || !fromMonth || !fromYear || !toDay || !toMonth || !toYear) {
          throw new Error('Invalid date format. Expected dd/mm/yyyy');
        }

        const fromLabel = `${getMonthName(fromMonth)}-${fromYear}`;
        const toLabel = `${getMonthName(toMonth)}-${toYear}`;

        return {
          from: `${fromDay}/${fromMonth}/${fromYear}`,
          to: `${toDay}/${toMonth}/${toYear}`,
          periodLabel: `${fromLabel} to ${toLabel}`,
          value: Number(value.value)
        };
      });
    } else if (fromRaw && toRaw && valueRaw != null) {
      const [fd, fm, fy] = fromRaw.split('/');
      const [td, tm, ty] = toRaw.split('/');

      if (![fd, fm, fy, td, tm, ty].every(Boolean)) {
        return res.status(400).json({
          message: 'Invalid date format in From/To, expected dd/mm/yyyy.'
        });
      }

      const value = parseFloat(valueRaw);
      if (isNaN(value)) {
        return res.status(400).json({ message: 'Invalid number in Value.' });
      }

      const fromLabel = `${getMonthName(fm)}-${fy}`;
      const toLabel = `${getMonthName(tm)}-${ty}`;

      yearlyValues = [{
        from: fromRaw,
        to: toRaw,
        periodLabel: `${fromLabel} to ${toLabel}`,
        value
      }];
    } else {
      return res.status(400).json({
        message: 'Provide either yearlyValues or From/To/Value.'
      });
    }

    const exists = await EmissionFactor.findOne({ country, regionGrid, emissionFactor });
    if (exists) {
      return res.status(409).json({
        message: 'Emission factor already exists for this country, region grid, and emission factor.'
      });
    }

    const newEmissionFactor = new EmissionFactor({
      country,
      regionGrid,
      emissionFactor,
      reference,
      unit,
      yearlyValues
    });

    await newEmissionFactor.save();

    return res.status(201).json({
      message: 'Emission factor added successfully',
      data: newEmissionFactor
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Error adding emission factor',
      error: error.message
    });
  }
};

// Bulk import country emission factors (CSV upload)
const bulkImportCountryEmissionFactors = async (req, res) => {
  try {
    let rows = [];

    // 1️⃣ CSV upload mode
    if (req.file) {
      rows = await csvtojson().fromFile(req.file.path);
      fs.unlinkSync(req.file.path);

    // 2️⃣ JSON-body mode
    } else if (Array.isArray(req.body)) {
      rows = req.body;

    // 3️⃣ neither: error out
    } else {
      return res.status(400).json({
        message: 'Provide either a CSV file under field "csvFile" or a JSON array in the request body.'
      });
    }

    const results = { inserted: [], errors: [], duplicates: [] };

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try {
        // normalize keys (whether CSV or JSON)
        const country       = (r.Country || r.country || '').trim();
        const regionGrid    = (r.RegionGrid || r.regionGrid || '').trim();
        const emissionFactor= (r.EmissionFactor || r.emissionFactor || '').trim();
        const reference     = (r.Reference || r.reference || '').trim();
        const unit          = (r.Unit || r.unit || 'kWh').trim();
        const fromRaw       = r.From  || r.from;
        const toRaw         = r.To    || r.to;
        const valueRaw      = r.Value || r.value;

        if (!country || !regionGrid || !emissionFactor) {
          throw new Error('Missing required fields: Country, RegionGrid, or EmissionFactor.');
        }

        // build yearlyValues if both dates+value present
        let yearlyValues = [];
        if (fromRaw && toRaw && valueRaw != null) {
          const value = parseFloat(valueRaw);
          if (isNaN(value)) throw new Error('Invalid number in "Value".');

          const [fd, fm, fy] = fromRaw.split('/');
          const [td, tm, ty] = toRaw.split('/');
          if (![fd,fm,fy,td,tm,ty].every(x => x)) {
            throw new Error('Invalid date format in From/To, expected dd/mm/yyyy.');
          }

          const fromLabel = `${getMonthName(fm)}-${fy}`;
          const toLabel   = `${getMonthName(tm)}-${ty}`;
          yearlyValues.push({
            from: fromRaw,
            to:   toRaw,
            periodLabel: `${fromLabel} to ${toLabel}`,
            value
          });
        }

        // skip if duplicate
        const exists = await EmissionFactor.findOne({ country, regionGrid });
        if (exists) {
          results.duplicates.push({ index: i+1, country, regionGrid });
          continue;
        }

        // save
        const doc = new EmissionFactor({
          country,
          regionGrid,
          emissionFactor,
          reference,
          unit,
          yearlyValues
        });
        const saved = await doc.save();
        results.inserted.push({ index: i+1, id: saved._id });

      } catch (err) {
        results.errors.push({ index: i+1, error: err.message });
      }
    }

    return res.status(200).json({
      message: 'Bulk import finished',
      summary: {
        total:    rows.length,
        inserted: results.inserted.length,
        duplicates: results.duplicates.length,
        errors:   results.errors.length
      },
      details: results
    });

  } catch (err) {
    return res.status(500).json({ message: 'Bulk import failed', error: err.message });
  }
};

// Download CSV template for country emission factors
const downloadCountryEmissionFactorsTemplate = async (req, res) => {
  try {
    const headers = [
      'Country',
      'RegionGrid',
      'EmissionFactor',   // tCO2/MWh
      'Reference',
      'Unit'              // default: kWh
    ];
    const sample = [
      ['India','Southern Grid','0.67','IEA 2021','kWh']
    ];

    let csv = headers.join(',') + '\n';
    sample.forEach(row => {
      csv += row.map(v => `"${v}"`).join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="country_emission_factors_template.csv"');
    res.send(csv);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Could not generate CSV template', error: error.message });
  }
};


// Get all emission factors
const getAllEmissionFactors = async (req, res) => {
    try {
        const emissionFactors = await EmissionFactor.find();
        return res.status(200).json({ data: emissionFactors });
    } catch (error) {
        return res.status(500).json({ message: 'Error fetching emission factors', error: error.message });
    }
};

// Get single emission factor by ID
const getEmissionFactorById = async (req, res) => {
    try {
        const { id } = req.params;
        const emissionFactor = await EmissionFactor.findById(id);
        if (!emissionFactor) return res.status(404).json({ message: 'Emission factor not found' });
        return res.status(200).json({ data: emissionFactor });
    } catch (error) {
        return res.status(500).json({ message: 'Error fetching emission factor', error: error.message });
    }
};

// Update an emission factor by ID
const updateEmissionFactor = async (req, res) => {
    try {
        const { id } = req.params;
        const data = req.body;

        // Generate periodLabel for each yearly value
        if (data.yearlyValues) {
            data.yearlyValues = data.yearlyValues.map(value => {
                const [fromDay, fromMonth, fromYear] = value.from.split('/');
                const [toDay, toMonth, toYear] = value.to.split('/');

                if (!fromDay || !fromMonth || !fromYear || !toDay || !toMonth || !toYear) {
                    throw new Error('Invalid date format. Expected dd/mm/yyyy');
                }

                const fromLabel = `${getMonthName(fromMonth)}-${fromYear}`;
                const toLabel = `${getMonthName(toMonth)}-${toYear}`;
                return {
                    ...value,
                    from: `${fromDay}/${fromMonth}/${fromYear}`,
                    to: `${toDay}/${toMonth}/${toYear}`,
                    periodLabel: `${fromLabel} to ${toLabel}`
                };
            });
        }

        const updatedData = await EmissionFactor.findByIdAndUpdate(id, data, { new: true });
        if (!updatedData) return res.status(404).json({ message: 'Emission factor not found' });

        return res.status(200).json({ message: 'Emission factor updated successfully', data: updatedData });
    } catch (error) {
        return res.status(500).json({ message: 'Error updating emission factor', error: error.message });
    }
};


// Delete an emission factor by ID
const deleteEmissionFactor = async (req, res) => {
    try {
        const { id } = req.params;
        const deletedData = await EmissionFactor.findByIdAndDelete(id);
        if (!deletedData) return res.status(404).json({ message: 'Emission factor not found' });
        return res.status(200).json({ message: 'Emission factor deleted successfully' });
    } catch (error) {
        return res.status(500).json({ message: 'Error deleting emission factor', error: error.message });
    }
};


module.exports = {
    addEmissionFactor,
    getAllEmissionFactors,
    getEmissionFactorById,
    updateEmissionFactor,
    deleteEmissionFactor,
    bulkImportCountryEmissionFactors,
    downloadCountryEmissionFactorsTemplate
};
