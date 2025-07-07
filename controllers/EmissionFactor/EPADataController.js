const EPAData = require('../../models/EmissionFactor/EPAData');
const csvtojson = require('csvtojson');
const XLSX = require('xlsx');
const multer = require('multer');

const createEPAData = async (req, res) => {
    const userName = req.user.name || req.user?.email || req.user._id || 'system';

    try {
        // Normalize incoming payload to an array 
        const payload = Array.isArray(req.body) ? req.body : [req.body];

        // Auto-fill columnTextEPA and add createdBy on each item 
        const docs = payload.map(item => {
      const data = { ...item };
      if (!data.columnTextEPA && data.uomEPA) {
        data.columnText = data.uom;
      }
      return {
        ...data,
        createdBy: userName
      };
    });
    // Bulk insert: ordered:false means it will keep going past duplicates
        const inserted = await EPAData.insertMany(docs, { ordered: false });
        res.status(201).json({
          success: true,
          created: inserted.length,
          data: Array.isArray(req.body) ? inserted : inserted[0]
        });
    } catch (error) {
          // Handle duplicate-key errors coming from insertMany
    if (error.name === 'BulkWriteError' && error.code === 11000) {
      // count how many succeeded vs. failed
      const successCount = error.result?.nInserted || 0;
      return res.status(400).json({
        success: false,
        message: `Duplicate key on some records. ${successCount} inserted, ${docs.length - successCount} failed.`,
        errors: error.writeErrors?.map(e => ({
          index: e.index,
          errmsg: e.errmsg
        }))
      });
    }

    // Single-document duplicate or any other error
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        error: 'This combination of scopeEPA, levelsEPA, columnTextEPA, UOMEPA and GHG unitEPA already exists.'
      });
    }

    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
    }
//Get all EPA data with pagination and filtering

const getEPAData = async (req, res) =>{
    try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    // Build filter query
    const filter = {};
        if (req.query.scopeEPA) filter.scopeEPA = req.query.scopeEPA;
        if (req.query.level1EPA) filter.level1EPA = new RegExp(req.query.level1EPA, 'i');
        if (req.query.level2EPA) filter.level2EPA = new RegExp(req.query.level2EPA, 'i');
        if (req.query.level3EPA) filter.level3EPA = new RegExp(req.query.level3EPA, 'i');
        if (req.query.level4EPA) filter.level4EPA = new RegExp(req.query.level4EPA, 'i');
        if (req.query.columnTextEPA) filter.columnTextEPA = new RegExp(req.query.columnTextEPA, 'i');
        if (req.query.uomEPA) filter.uomEPA = new RegExp(req.query.uomEPA, 'i');
        if (req.query.ghgUnitEPA) filter.ghgUnitEPA = req.query.ghgUnitEPA;
    
        const total = await EPAData.countDocuments(filter);
        const data = await EPAData.find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit);
    
        res.status(200).json({
          success: true,
          data,
          pagination: {
            total,
            page,
            pages: Math.ceil(total / limit),
            limit
          }
        });
    } catch (error) {
        
    }
}

// Get single EPA record by ID
const getEPADataById = async (req, res) => {
  try {
    const data = await EPAData.findById(req.params.id);
    if (!data) {
      return res.status(404).json({ success: false, error: 'Data not found' });
    }
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Update EPA data by ID
const updateEPAData = async (req, res) => {
  try {
    const userName = req.user?.userName || req.user?.email || req.user?.id || 'system';
    const { id } = req.params;
    const { ghgConversionFactorEPA, ...otherFields } = req.body;

    const existingData = await EPAData.findById(id);
    if (!existingData) {
      return res.status(404).json({ success: false, error: 'Data not found' });
    }

    // Check if only conversion factor is being updated
    if (ghgConversionFactorEPA !== undefined) {
      const factorChanged = existingData.updateConversionFactorEPA(ghgConversionFactorEPA, userName);
      if (!factorChanged) {
        return res.status(200).json({ 
          success: true, 
          message: 'Conversion factor is the same. No update needed.',
          data: existingData 
        });
      }
    }

    // Update other fields if provided
    Object.keys(otherFields).forEach(key => {
      existingData[key] = otherFields[key];
    });
    existingData.updatedBy = userName;

    await existingData.save();
    res.status(200).json({ success: true, data: existingData });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Delete single or multiple EPA records
const deleteEPAData = async (req, res) => {
  try {
    const { ids } = req.body; // Expecting array of IDs for multiple delete
    const idArray = ids || [req.params.id]; // Support both single and multiple delete

    const result = await EPAData.deleteMany({ _id: { $in: idArray } });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, error: 'No data found to delete' });
    }

    res.status(200).json({ 
      success: true, 
      message: `${result.deletedCount} record(s) deleted successfully` 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Download all EPA data as CSV
const downloadEPADataCSV = async (req, res) => {
  try {
    const data = await EPAData.find();

    const fields = [
      'scopeEPA',
      'level1EPA',
      'level2EPA',
      'level3EPA',
      'level4EPA',
      'columnTextEPA',
      'uomEPA',
      'ghgUnitEPA',
      'ghgConversionFactorEPA'
    ];
    const header = fields.join(',');

    const rows = data.map(record => {
      return fields.map(field => {
        const val = record[field] == null ? '' : record[field].toString();
        return `"${val.replace(/"/g, '""')}"`;
      }).join(',');
    });

    const csv = [header, ...rows].join('\r\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="defra_data.csv"');
    return res.send(csv);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Unified bulk upload function for CSV and Excel
const uploadEPADataFromCSV = async (req, res) => {
  try {
    const userName = req.user.userName;

    if (!req.file && !req.body.csv) {
      return res.status(400).json({ success: false, error: 'No file provided.' });
    }

    let rawRows, fileType;
    if (req.file) {
      const name = req.file.originalname.toLowerCase();
      fileType = name.endsWith('.csv') ? 'CSV' : 'Excel';
      if (fileType === 'CSV') {
        rawRows = await csvtojson().fromString(req.file.buffer.toString('utf8'));
      } else {
        const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
        rawRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
      }
    } else {
      fileType = 'CSV';
      rawRows = await csvtojson().fromString(req.body.csv);
    }

    // Normalize everything to the same shape
    const rows = rawRows.map(r => ({
      scopeEPA:   (r.scopeEPA   ?? r.Scope   ?? '').toString().trim(),
      level1EPA:  (r.level1EPA  ?? r['Level 1'] ?? '').toString().trim(),
      level2EPA:  (r.level2EPA  ?? r['Level 2'] ?? '').toString().trim(),
      level3EPA:  (r.level3EPA  ?? r['Level 3'] ?? '').toString().trim(),
      level4EPA:  (r.level4EPA  ?? r['Level 4'] ?? '').toString().trim(),
      columnTextEPA: (r.columnTextEPA ?? r['Column Text'] ?? '').toString().trim(),
      uomEPA:     (r.uomEPA     ?? r.UOM     ?? '').toString().trim(),
      ghgUnitEPA: (r.ghgUnitEPA ?? r['GHG/Unit'] ?? '').toString().trim(),
      ghgConversionFactorEPA: parseFloat(
        r.ghgConversionFactorEPA
        ?? r['GHG Conversion Factor 2025']
        ?? r['GHG Conversion Factor']
        ?? r['ghg conversion factor']
        ?? ''
      )
    }));

    const results = { fileType, totalRows: rows.length, created: 0, updated: 0, unchanged: 0, errors: [] };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      // Auto-fill columnTextEPA if blank
      if (!row.columnTextEPA && row.uomEPA) {
        row.columnTextEPA = row.uomEPA;
      }

      // Validate
      if (!row.scopeEPA || !row.level1EPA || !row.uomEPA || !row.ghgUnitEPA || isNaN(row.ghgConversionFactorEPA)) {
        results.errors.push({ rowNumber: i + 2, row, error: 'Missing or invalid fields' });
        continue;
      }

      const query = {
        scopeEPA: row.scopeEPA, level1EPA: row.level1EPA,
        level2EPA: row.level2EPA, level3EPA: row.level3EPA,
        level4EPA: row.level4EPA, columnTextEPA: row.columnTextEPA,
        uomEPA: row.uomEPA, ghgUnitEPA: row.ghgUnitEPA
      };

      const existing = await EPAData.findOne(query);

      if (existing) {
        if (existing.updateConversionFactorEPA(row.ghgConversionFactorEPA, userName)) {
          await existing.save();
          results.updated++;
        } else {
          results.unchanged++;
        }
      } else {
        const doc = new EPAData({
          ...query,
          ghgConversionFactorEPA: row.ghgConversionFactorEPA,
          createdBy: userName
        });
        await doc.save();
        results.created++;
      }
    }

    return res.status(200).json({ success: true, message: `Processed ${fileType}`, results });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// Advanced filter with multiple criteria
const filterEPAData = async (req, res) => {
  try {
    const {
      scopes,
      levels,
      uoms,
      ghgUnits,
      minFactor,
      maxFactor,
      searchText,
      page = 1,
      limit = 50
    } = req.query;

    const filter = {};

    // Handle multiple values for filters
    if (scopes) filter.scopeEPA = { $in: scopes.split(',') };
    if (uoms) filter.uomEPA = { $in: uoms.split(',') };
    if (ghgUnits) filter.ghgUnitEPA = { $in: ghgUnits.split(',') };

    // Handle level filters
    if (levels) {
      const levelFilters = levels.split(',');
      const levelQuery = { $or: [] };
      levelFilters.forEach(level => {
        levelQuery.$or.push(
          { level1EPA: new RegExp(level, 'i') },
          { level2EPA: new RegExp(level, 'i') },
          { level3EPA: new RegExp(level, 'i') },
          { level4EPA: new RegExp(level, 'i') }
        );
      });
      Object.assign(filter, levelQuery);
    }

    // Handle conversion factor range
    if (minFactor || maxFactor) {
      filter.ghgConversionFactorEPA = {};
      if (minFactor) filter.ghgConversionFactorEPA.$gte = parseFloat(minFactor);
      if (maxFactor) filter.ghgConversionFactorEPA.$lte = parseFloat(maxFactor);
    }

    // Handle general search text
    if (searchText) {
      filter.$or = [
        { level1EPA: new RegExp(searchText, 'i') },
        { level2EPA: new RegExp(searchText, 'i') },
        { level3EPA: new RegExp(searchText, 'i') },
        { level4EPA: new RegExp(searchText, 'i') },
        { columnTextEPA: new RegExp(searchText, 'i') }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await EPAData.countDocuments(filter);
    const data = await EPAData.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    res.status(200).json({
      success: true,
      data,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit)),
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  createEPAData,
  getEPAData,
  getEPADataById,
  updateEPAData, 
  deleteEPAData,
  downloadEPADataCSV,
  uploadEPADataFromCSV,
  filterEPAData,

}   