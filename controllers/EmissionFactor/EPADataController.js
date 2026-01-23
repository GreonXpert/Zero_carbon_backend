const EPAData = require('../../models/EmissionFactor/EPAData');
const csvtojson = require('csvtojson');
const XLSX = require('xlsx');
const multer = require('multer');
const fs = require('fs');


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
// HIGH-SCALE upload: supports 10k–100k+ using streaming + bulkWrite
const uploadEPADataFromCSV = async (req, res) => {
  try {
    const userName = req.user?.userName || req.user?.email || req.user?.id || 'system';

    if (!req.file && !req.body.csv) {
      return res.status(400).json({ success: false, error: 'No file provided.' });
    }

    const BATCH_SIZE = 1000;        // tune 500–5000
    const MAX_ERROR_SAMPLES = 50;   // prevent huge response payloads

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

    const normalizeRow = (r) => {
      const row = {
        scopeEPA: clean(r.scopeEPA ?? r.Scope),
        level1EPA: clean(r.level1EPA ?? r['Level 1']),
        level2EPA: clean(r.level2EPA ?? r['Level 2']),
        level3EPA: clean(r.level3EPA ?? r['Level 3']),
        level4EPA: clean(r.level4EPA ?? r['Level 4']),
        columnTextEPA: clean(r.columnTextEPA ?? r['Column Text']),
        uomEPA: clean(r.uomEPA ?? r.UOM),
        ghgUnitEPA: clean(r.ghgUnitEPA ?? r['GHG/Unit']),
        ghgConversionFactorEPA: r.ghgConversionFactorEPA
          ?? r['GHG Conversion Factor 2025']
          ?? r['GHG Conversion Factor']
          ?? r['ghg conversion factor']
      };

      // Auto-fill columnTextEPA if blank
      if (!row.columnTextEPA && row.uomEPA) row.columnTextEPA = row.uomEPA;

      const factor = parseFloat(String(row.ghgConversionFactorEPA ?? '').trim());
      row.ghgConversionFactorEPA = factor;

      return row;
    };

    const buildKey = (r) => [
      r.scopeEPA, r.level1EPA, r.level2EPA, r.level3EPA, r.level4EPA,
      r.columnTextEPA, r.uomEPA, r.ghgUnitEPA
    ].join('||');

    const buildUpsertOp = (r) => {
      const filter = {
        scopeEPA: r.scopeEPA,
        level1EPA: r.level1EPA,
        level2EPA: r.level2EPA,
        level3EPA: r.level3EPA,
        level4EPA: r.level4EPA,
        columnTextEPA: r.columnTextEPA,
        uomEPA: r.uomEPA,
        ghgUnitEPA: r.ghgUnitEPA
      };

      // Uses update pipeline so we can:
      // - detect change
      // - push to conversionFactorHistoryEPA only when changed
      // - only update updatedAt when changed
      return {
        updateOne: {
          filter,
          upsert: true,
          update: [
            {
              $set: {
                scopeEPA: r.scopeEPA,
                level1EPA: r.level1EPA,
                level2EPA: r.level2EPA,
                level3EPA: r.level3EPA,
                level4EPA: r.level4EPA,
                columnTextEPA: r.columnTextEPA,
                uomEPA: r.uomEPA,
                ghgUnitEPA: r.ghgUnitEPA,

                conversionFactorHistoryEPA: { $ifNull: ['$conversionFactorHistoryEPA', []] },
                createdBy: { $ifNull: ['$createdBy', userName] },
                createdAt: { $ifNull: ['$createdAt', '$$NOW'] }
              }
            },
            {
              $set: {
                __changed: { $ne: ['$ghgConversionFactorEPA', r.ghgConversionFactorEPA] },
                __old: '$ghgConversionFactorEPA'
              }
            },
            {
              $set: {
                conversionFactorHistoryEPA: {
                  $cond: [
                    '$__changed',
                    {
                      $concatArrays: [
                        '$conversionFactorHistoryEPA',
                        [
                          {
                            oldValue: '$__old',
                            newValue: r.ghgConversionFactorEPA,
                            changedAt: '$$NOW',
                            changedBy: userName
                          }
                        ]
                      ]
                    },
                    '$conversionFactorHistoryEPA'
                  ]
                },
                ghgConversionFactorEPA: {
                  $cond: ['$__changed', r.ghgConversionFactorEPA, '$ghgConversionFactorEPA']
                },
                updatedBy: { $cond: ['$__changed', userName, '$updatedBy'] },
                updatedAt: { $cond: ['$__changed', '$$NOW', '$updatedAt'] }
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
        const r = await EPAData.bulkWrite(ops, { ordered: false });
        results.created += (r.upsertedCount || 0);
        results.updated += (r.modifiedCount || 0);
      } catch (err) {
        // partial success possible
        if (err?.name === 'BulkWriteError') {
          const r = err.result || err;
          results.created += (r.upsertedCount || r.result?.nUpserted || 0);
          results.updated += (r.modifiedCount || r.result?.nModified || 0);

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

    const processRowsArray = async (rawRows, fileType) => {
      results.fileType = fileType;

      let batchMap = new Map();

      for (let i = 0; i < rawRows.length; i++) {
        results.totalRows += 1;

        const row = normalizeRow(rawRows[i]);

        if (!row.scopeEPA || !row.level1EPA || !row.uomEPA || !row.ghgUnitEPA || Number.isNaN(row.ghgConversionFactorEPA)) {
          if (results.errors.length < MAX_ERROR_SAMPLES) {
            results.errors.push({ rowNumber: i + 2, row, error: 'Missing or invalid fields' });
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
    // Parse input
    // ----------------------------
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

        // If you move to diskStorage, multer provides req.file.path.
        // With memoryStorage, we stream from buffer.
        const { Readable } = require('stream');
        const stream = req.file.path
          ? fs.createReadStream(req.file.path)
          : Readable.from([req.file.buffer]);

        stream.setEncoding('utf8');

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

                  if (!row.scopeEPA || !row.level1EPA || !row.uomEPA || !row.ghgUnitEPA || Number.isNaN(row.ghgConversionFactorEPA)) {
                    if (results.errors.length < MAX_ERROR_SAMPLES) {
                      results.errors.push({ rowNumber: rowIndex + 1, row, error: 'Missing or invalid fields' });
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
        const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        await processRowsArray(rawRows, 'Excel');
      } else {
        return res.status(400).json({ success: false, error: 'Invalid file type. Upload CSV or Excel.' });
      }
    } else if (req.body.csv) {
      // Raw CSV text: okay for small uploads. For 100k+ use file upload.
      results.fileType = 'CSV';
      const rawRows = await csvtojson({ trim: true }).fromString(req.body.csv);
      await processRowsArray(rawRows, 'CSV');
    }

    return res.status(200).json({
      success: true,
      message: `Processed ${results.fileType}`,
      results
    });
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