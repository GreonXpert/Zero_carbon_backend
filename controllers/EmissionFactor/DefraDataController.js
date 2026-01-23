const DefraData = require('../../models/EmissionFactor/DefraData');
const csvtojson = require('csvtojson');
const XLSX = require('xlsx');
const multer = require('multer');
const fs = require('fs');

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
// Unified bulk upload function for CSV and Excel (HIGH-SCALE: 10k–100k+)
exports.bulkUpload = async (req, res) => {
  try {
    const userName = req.user?.userName || req.user?.email || req.user?.id || 'system';

    if (!req.file && !req.body.csv) {
      return res.status(400).json({
        success: false,
        error: 'No file provided. Please upload a CSV or Excel file.'
      });
    }

    // -----------------------------
    // Performance strategy
    // -----------------------------
    // - Stream parse CSV (no huge memory)
    // - Batch bulkWrite upserts (fast)
    // - Append conversionFactorHistory only when factor changes
    // - Do NOT update updatedAt when unchanged (so unchanged is real)
    // -----------------------------

    const BATCH_SIZE = 1000;           // tune 500–5000 based on your DB
    const MAX_ERROR_SAMPLES = 50;      // prevent huge API response

    const results = {
      fileType: '',
      totalRows: 0,
      validRows: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      duplicateRowsInFile: 0,
      errors: []
    };

    const clean = (v) => (v == null ? '' : String(v)).trim();

    const normalizeRow = (raw) => {
      const row = {
        scope: clean(raw.scope ?? raw.Scope),
        level1: clean(raw.level1 ?? raw['Level 1'] ?? raw.Level1),
        level2: clean(raw.level2 ?? raw['Level 2'] ?? raw.Level2),
        level3: clean(raw.level3 ?? raw['Level 3'] ?? raw.Level3),
        level4: clean(raw.level4 ?? raw['Level 4'] ?? raw.Level4),
        columnText: clean(raw.columnText ?? raw['Column Text'] ?? raw.ColumnText),
        uom: clean(raw.uom ?? raw.UOM),
        ghgUnit: clean(raw.ghgUnit ?? raw['GHG/Unit'] ?? raw['GHG Unit'] ?? raw.GHGUnit),
        ghgConversionFactor: raw.ghgConversionFactor
          ?? raw['GHG Conversion Factor 2025']
          ?? raw['GHG Conversion Factor']
          ?? raw['ghg conversion factor']
      };

      // DEFRA pattern: Column Text often equals UOM
      if (!row.columnText && row.uom) row.columnText = row.uom;

      const factorNum = parseFloat(String(row.ghgConversionFactor ?? '').trim());
      row.ghgConversionFactor = factorNum;

      return row;
    };

    const buildKey = (r) => [
      r.scope, r.level1, r.level2, r.level3, r.level4, r.columnText, r.uom, r.ghgUnit
    ].join('||');

    const buildUpsertOp = (r) => {
      const filter = {
        scope: r.scope,
        level1: r.level1,
        level2: r.level2,
        level3: r.level3,
        level4: r.level4,
        columnText: r.columnText,
        uom: r.uom,
        ghgUnit: r.ghgUnit
      };

      // Update pipeline:
      // - sets key fields (safe)
      // - checks if factor changed
      // - only updates + pushes history when changed
      return {
        updateOne: {
          filter,
          upsert: true,
          update: [
            {
              $set: {
                scope: r.scope,
                level1: r.level1,
                level2: r.level2,
                level3: r.level3,
                level4: r.level4,
                columnText: r.columnText,
                uom: r.uom,
                ghgUnit: r.ghgUnit,
                conversionFactorHistory: { $ifNull: ['$conversionFactorHistory', []] },
                createdBy: { $ifNull: ['$createdBy', userName] },
                createdAt: { $ifNull: ['$createdAt', '$$NOW'] }
              }
            },
            {
              $set: {
                __changed: { $ne: ['$ghgConversionFactor', r.ghgConversionFactor] },
                __old: '$ghgConversionFactor'
              }
            },
            {
              $set: {
                conversionFactorHistory: {
                  $cond: [
                    '$__changed',
                    {
                      $concatArrays: [
                        '$conversionFactorHistory',
                        [
                          {
                            oldValue: '$__old',
                            newValue: r.ghgConversionFactor,
                            changedAt: '$$NOW',
                            changedBy: userName
                          }
                        ]
                      ]
                    },
                    '$conversionFactorHistory'
                  ]
                },
                ghgConversionFactor: {
                  $cond: ['$__changed', r.ghgConversionFactor, '$ghgConversionFactor']
                },
                updatedBy: {
                  $cond: ['$__changed', userName, '$updatedBy']
                },
                updatedAt: {
                  $cond: ['$__changed', '$$NOW', '$updatedAt']
                }
              }
            },
            { $unset: ['__changed', '__old'] }
          ]
        }
      };
    };

    const flushBatch = async (ops) => {
      if (!ops.length) return;

      try {
        const r = await DefraData.bulkWrite(ops, { ordered: false });
        const upserted = r.upsertedCount ?? r.nUpserted ?? r.result?.nUpserted ?? 0;
        const modified = r.modifiedCount ?? r.nModified ?? r.result?.nModified ?? 0;
        results.created += upserted;
        results.updated += modified;
      } catch (err) {
        // still may have partial success
        if (err?.name === 'BulkWriteError') {
          const r = err.result || err;
          const upserted = r.upsertedCount ?? r.nUpserted ?? r.result?.nUpserted ?? 0;
          const modified = r.modifiedCount ?? r.nModified ?? r.result?.nModified ?? 0;
          results.created += upserted;
          results.updated += modified;

          const writeErrors = err.writeErrors || err.result?.writeErrors || [];
          writeErrors
            .slice(0, Math.max(0, MAX_ERROR_SAMPLES - results.errors.length))
            .forEach((e) => {
              results.errors.push({
                rowNumber: null,
                row: null,
                error: e.errmsg || e.message || 'Bulk write error'
              });
            });
          return;
        }
        throw err;
      }
    };

    const processRowsArray = async (rows, fileType) => {
      results.fileType = fileType;

      let batchMap = new Map();

      for (let i = 0; i < rows.length; i++) {
        results.totalRows += 1;

        const row = normalizeRow(rows[i]);

        if (!row.scope || !row.level1 || !row.uom || !row.ghgUnit || Number.isNaN(row.ghgConversionFactor)) {
          if (results.errors.length < MAX_ERROR_SAMPLES) {
            results.errors.push({
              rowNumber: i + 2,
              row,
              error: 'Missing/invalid fields. Required: scope, level1, uom, ghgUnit, ghgConversionFactor'
            });
          }
          continue;
        }

        results.validRows += 1;

        const key = buildKey(row);
        if (batchMap.has(key)) {
          results.duplicateRowsInFile += 1;
          batchMap.set(key, row);
          continue;
        }
        batchMap.set(key, row);

        if (batchMap.size >= BATCH_SIZE) {
          const ops = Array.from(batchMap.values()).map(buildUpsertOp);
          batchMap = new Map();
          // eslint-disable-next-line no-await-in-loop
          await flushBatch(ops);
        }
      }

      if (batchMap.size) {
        const ops = Array.from(batchMap.values()).map(buildUpsertOp);
        await flushBatch(ops);
      }

      results.unchanged = Math.max(0, results.validRows - (results.created + results.updated));
    };

    // ----------------------------
    // Parse input file & process
    // ----------------------------
    const { Readable } = require('stream');

    if (req.file) {
      const filename = (req.file.originalname || '').toLowerCase();
      const mimeType = req.file.mimetype || '';

      const isCSV = filename.endsWith('.csv') || mimeType === 'text/csv' || mimeType === 'application/csv';
      const isExcel =
        filename.endsWith('.xlsx') ||
        filename.endsWith('.xls') ||
        mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        mimeType === 'application/vnd.ms-excel';

      if (isCSV) {
        results.fileType = 'CSV';

        const stream = req.file.path
          ? fs.createReadStream(req.file.path)
          : Readable.from([req.file.buffer]);

        stream.setEncoding('utf8');

        // True streaming parse: sequential handling (backpressure-safe)
        let batchMap = new Map();
        let rowIndex = 0;
        let chain = Promise.resolve();

        await new Promise((resolve, reject) => {
          csvtojson({ trim: true })
            .fromStream(stream)
            .subscribe(
              (jsonObj) => {
                chain = chain.then(async () => {
                  rowIndex += 1;
                  results.totalRows += 1;

                  const row = normalizeRow(jsonObj);

                  if (!row.scope || !row.level1 || !row.uom || !row.ghgUnit || Number.isNaN(row.ghgConversionFactor)) {
                    if (results.errors.length < MAX_ERROR_SAMPLES) {
                      results.errors.push({
                        rowNumber: rowIndex + 1,
                        row,
                        error: 'Missing/invalid fields. Required: scope, level1, uom, ghgUnit, ghgConversionFactor'
                      });
                    }
                    return;
                  }

                  results.validRows += 1;

                  const key = buildKey(row);
                  if (batchMap.has(key)) {
                    results.duplicateRowsInFile += 1;
                    batchMap.set(key, row);
                    return;
                  }
                  batchMap.set(key, row);

                  if (batchMap.size >= BATCH_SIZE) {
                    const ops = Array.from(batchMap.values()).map(buildUpsertOp);
                    batchMap = new Map();
                    await flushBatch(ops);
                  }
                });

                return chain;
              },
              (err) => reject(err),
              () => resolve()
            );
        });

        if (batchMap.size) {
          const ops = Array.from(batchMap.values()).map(buildUpsertOp);
          await flushBatch(ops);
        }

        results.unchanged = Math.max(0, results.validRows - (results.created + results.updated));

        if (req.file.path) {
          try { fs.unlinkSync(req.file.path); } catch (_) {}
        }
      } else if (isExcel) {
        results.fileType = 'Excel';
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const excelRows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
        await processRowsArray(excelRows, 'Excel');
      } else {
        return res.status(400).json({
          success: false,
          error: 'Invalid file type. Please upload a CSV or Excel (.xlsx, .xls) file.'
        });
      }
    } else if (req.body.csv) {
      results.fileType = 'CSV';
      // raw CSV text: OK for smaller uploads; for 100k+ prefer file upload
      const rows = await csvtojson({ trim: true }).fromString(req.body.csv);
      await processRowsArray(rows, 'CSV');
    }

    return res.status(200).json({
      success: true,
      message: `Successfully processed ${results.fileType} file`,
      results
    });
  } catch (error) {
    console.error('Bulk upload error:', error);
    return res.status(500).json({
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