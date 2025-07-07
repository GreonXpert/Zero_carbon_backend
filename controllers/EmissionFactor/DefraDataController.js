const DefraData = require('../../models/EmissionFactor/DefraData');
const csvtojson = require('csvtojson');
const XLSX = require('xlsx');
const multer = require('multer');


exports.createDefraData = async (req, res) => {
  const userName = req.user?.userName || req.user?.email || req.user?.id || 'system';

  try {
    // Normalize incoming payload to an array
    const payloads = Array.isArray(req.body) ? req.body : [req.body];

    // Auto-fill columnText and add createdBy on each item
    const docs = payloads.map(item => {
      const data = { ...item };
      if (!data.columnText && data.uom) {
        data.columnText = data.uom;
      }
      return {
        ...data,
        createdBy: userName
      };
    });

    // Bulk insert: ordered:false means it will keep going past duplicates
    const inserted = await DefraData.insertMany(docs, { ordered: false });
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
        error: 'This combination of scope, levels, columnText, UOM and GHG unit already exists.'
      });
    }

    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
};


// Get all DEFRA data with pagination and filters
exports.getDefraData = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    // Build filter query
    const filter = {};
    if (req.query.scope) filter.scope = req.query.scope;
    if (req.query.level1) filter.level1 = new RegExp(req.query.level1, 'i');
    if (req.query.level2) filter.level2 = new RegExp(req.query.level2, 'i');
    if (req.query.level3) filter.level3 = new RegExp(req.query.level3, 'i');
    if (req.query.level4) filter.level4 = new RegExp(req.query.level4, 'i');
    if (req.query.columnText) filter.columnText = new RegExp(req.query.columnText, 'i');
    if (req.query.uom) filter.uom = new RegExp(req.query.uom, 'i');
    if (req.query.ghgUnit) filter.ghgUnit = req.query.ghgUnit;

    const total = await DefraData.countDocuments(filter);
    const data = await DefraData.find(filter)
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
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get single DEFRA record by ID
exports.getDefraDataById = async (req, res) => {
  try {
    const data = await DefraData.findById(req.params.id);
    if (!data) {
      return res.status(404).json({ success: false, error: 'Data not found' });
    }
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Update DEFRA data by ID
exports.updateDefraData = async (req, res) => {
  try {
    const userName = req.user?.userName || req.user?.email || req.user?.id || 'system';
    const { id } = req.params;
    const { ghgConversionFactor, ...otherFields } = req.body;

    const existingData = await DefraData.findById(id);
    if (!existingData) {
      return res.status(404).json({ success: false, error: 'Data not found' });
    }

    // Check if only conversion factor is being updated
    if (ghgConversionFactor !== undefined) {
      const factorChanged = existingData.updateConversionFactor(ghgConversionFactor, userName);
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

// Delete single or multiple DEFRA records
exports.deleteDefraData = async (req, res) => {
  try {
    const { ids } = req.body; // Expecting array of IDs for multiple delete
    const idArray = ids || [req.params.id]; // Support both single and multiple delete

    const result = await DefraData.deleteMany({ _id: { $in: idArray } });
    
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

// Download all DEFRA data as CSV
exports.downloadDefraDataCSV = async (req, res) => {
  try {
    const data = await DefraData.find();

    const fields = [
      'scope',
      'level1',
      'level2',
      'level3',
      'level4',
      'columnText',
      'uom',
      'ghgUnit',
      'ghgConversionFactor'
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
exports.bulkUpload = async (req, res) => {
  try {
    const { userName } = req.user;
    
    // Check if file is provided
    if (!req.file && !req.body.csv) {
      return res.status(400).json({ 
        success: false, 
        error: 'No file provided. Please upload a CSV or Excel file.' 
      });
    }

    let rows = [];
    let fileType = '';

    // Determine file type and process accordingly
    if (req.file) {
      const filename = req.file.originalname.toLowerCase();
      const mimeType = req.file.mimetype;

      // Check if it's a CSV file
      if (filename.endsWith('.csv') || mimeType === 'text/csv' || mimeType === 'application/csv') {
        fileType = 'CSV';
        const csvText = req.file.buffer.toString('utf8');
        rows = await csvtojson().fromString(csvText);
      }
      // Check if it's an Excel file
      else if (
        filename.endsWith('.xlsx') || 
        filename.endsWith('.xls') || 
        mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        mimeType === 'application/vnd.ms-excel'
      ) {
        fileType = 'Excel';
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const excelRows = XLSX.utils.sheet_to_json(worksheet);

        // Map Excel columns to database fields
        const columnMapping = {
          'Scope': 'scope',
          'Level 1': 'level1',
          'Level 2': 'level2',
          'Level 3': 'level3',
          'Level 4': 'level4',
          'Column Text': 'columnText',
          'UOM': 'uom',
          'GHG/Unit': 'ghgUnit',
          'GHG Conversion Factor 2025': 'ghgConversionFactor',
          // Also support alternative column names
          'GHG Conversion Factor': 'ghgConversionFactor',
          'ghg conversion factor': 'ghgConversionFactor'
        };

        // Map Excel rows to standard format
        rows = excelRows.map(row => {
          const mappedRow = {};
          for (const [excelCol, dbField] of Object.entries(columnMapping)) {
            if (row.hasOwnProperty(excelCol)) {
              mappedRow[dbField] = row[excelCol];
            }
          }
          // Handle case where columns might have slightly different names
          if (!mappedRow.ghgConversionFactor) {
            // Try to find any column that contains 'conversion factor'
            for (const col in row) {
              if (col.toLowerCase().includes('conversion') && col.toLowerCase().includes('factor')) {
                mappedRow.ghgConversionFactor = row[col];
                break;
              }
            }
          }
          return mappedRow;
        });
      } else {
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid file type. Please upload a CSV or Excel (.xlsx, .xls) file.' 
        });
      }
    } else if (req.body.csv) {
      // Handle raw CSV text in request body
      fileType = 'CSV';
      rows = await csvtojson().fromString(req.body.csv);
    }

    // Validate that we have data
    if (!rows || rows.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'No data found in the uploaded file.' 
      });
    }

    // Process the rows
    const results = {
      fileType,
      totalRows: rows.length,
      created: 0,
      updated: 0,
      unchanged: 0,
      errors: []
    };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        // Auto-fill columnText with uom if empty (common pattern in DEFRA data)
        if (!row.columnText && row.uom) {
          row.columnText = row.uom;
        }

        // Validate required fields
        if (!row.scope || !row.level1 || !row.uom || !row.ghgUnit) {
          results.errors.push({ 
            rowNumber: i + 2, // +2 because Excel/CSV is 1-indexed and has header
            row, 
            error: 'Missing required fields (scope, level1, uom, ghgUnit)' 
          });
          continue;
        }

        const query = {
          scope: row.scope.toString().trim(),
          level1: row.level1.toString().trim(),
          level2: (row.level2 || '').toString().trim(),
          level3: (row.level3 || '').toString().trim(),
          level4: (row.level4 || '').toString().trim(),
          columnText: row.columnText.toString().trim(),
          uom: row.uom.toString().trim(),
          ghgUnit: row.ghgUnit.toString().trim()
        };

        const existingData = await DefraData.findOne(query);
        
        if (existingData) {
          // Check if conversion factor changed
          const newFactor = parseFloat(row.ghgConversionFactor);
          if (isNaN(newFactor)) {
            results.errors.push({ 
              rowNumber: i + 2, 
              row, 
              error: 'Invalid conversion factor value' 
            });
            continue;
          }

          if (existingData.updateConversionFactor(newFactor, userName)) {
            await existingData.save();
            results.updated++;
          } else {
            results.unchanged++;
          }
        } else {
          // Create new record
          const conversionFactor = parseFloat(row.ghgConversionFactor);
          if (isNaN(conversionFactor)) {
            results.errors.push({ 
              rowNumber: i + 2, 
              row, 
              error: 'Invalid conversion factor value' 
            });
            continue;
          }

          const newData = new DefraData({
            ...query,
            ghgConversionFactor: conversionFactor,
            createdBy: userName
          });
          await newData.save();
          results.created++;
        }
      } catch (error) {
        console.error(`Error processing row ${i + 2}:`, error);
        results.errors.push({ 
          rowNumber: i + 2, 
          row, 
          error: error.message 
        });
      }
    }

    // Return detailed results
    res.status(200).json({ 
      success: true, 
      message: `Successfully processed ${fileType} file`,
      results 
    });
  } catch (error) {
    console.error('Bulk upload error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
};

// Advanced filter with multiple criteria
exports.filterDefraData = async (req, res) => {
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
    if (scopes) filter.scope = { $in: scopes.split(',') };
    if (uoms) filter.uom = { $in: uoms.split(',') };
    if (ghgUnits) filter.ghgUnit = { $in: ghgUnits.split(',') };

    // Handle level filters
    if (levels) {
      const levelFilters = levels.split(',');
      const levelQuery = { $or: [] };
      levelFilters.forEach(level => {
        levelQuery.$or.push(
          { level1: new RegExp(level, 'i') },
          { level2: new RegExp(level, 'i') },
          { level3: new RegExp(level, 'i') },
          { level4: new RegExp(level, 'i') }
        );
      });
      Object.assign(filter, levelQuery);
    }

    // Handle conversion factor range
    if (minFactor || maxFactor) {
      filter.ghgConversionFactor = {};
      if (minFactor) filter.ghgConversionFactor.$gte = parseFloat(minFactor);
      if (maxFactor) filter.ghgConversionFactor.$lte = parseFloat(maxFactor);
    }

    // Handle general search text
    if (searchText) {
      filter.$or = [
        { level1: new RegExp(searchText, 'i') },
        { level2: new RegExp(searchText, 'i') },
        { level3: new RegExp(searchText, 'i') },
        { level4: new RegExp(searchText, 'i') },
        { columnText: new RegExp(searchText, 'i') }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await DefraData.countDocuments(filter);
    const data = await DefraData.find(filter)
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

// Test endpoint to verify database connection and model
exports.testDefraData = async (req, res) => {
  try {
    // Create a test record
    const testData = new DefraData({
      scope: 'Scope 1',
      level1: 'Test',
      level2: 'Test Level 2',
      level3: '',
      level4: '',
      columnText: 'test',
      uom: 'test',
      ghgUnit: 'kg CO2e',
      ghgConversionFactor: 1.0,
      createdBy: 'test'
    });

    // Try to save
    const saved = await testData.save();
    
    // Delete the test record
    await DefraData.deleteOne({ _id: saved._id });

    res.status(200).json({ 
      success: true, 
      message: 'Database connection and model are working correctly',
      testRecord: saved 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message,
      stack: error.stack 
    });
  }
};