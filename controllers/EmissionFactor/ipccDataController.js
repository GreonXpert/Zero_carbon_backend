const IPCCData = require('../../models/EmissionFactor/IPCCData');
const csvtojson = require('csvtojson');
const XLSX = require('xlsx');
const multer = require('multer');

// Helper function to check user permissions
const checkUserPermission = (userType) => {
  const allowedTypes = ['super_admin', 'consultant_admin'];
  return allowedTypes.includes(userType);
};

// Add single IPCC data entry
exports.addIPCCData = async (req, res) => {
     const userName = req.user?.userName || req.user?.email || req.user?.id || 'system';
    try {
        // Normalize incoming payload to an array
        const ipccDataPayload = Array.isArray(req.body) ? req.body : [req.body];

        const docs = ipccDataPayload.map(item => {
            const data = {...item};
            return {
                ...data,
                createdBy:userName,
            }
        });

        //Bulk insert : Ordered : False means it will keep going past duplicates
        const inserted = await IPCCData.insertMany(docs, { ordered: false });
        res.status(201).json({
            success: true,
            created: inserted.length,
            data: Array.isArray(req.body) ? inserted : inserted[0],
        });
    } catch (error) {
        // Handle duplicate-key errors coming from insertMany 
        if (error.name === 'BulkWriteError' && error.code === 11000) {
            //count how many succeeeded vs failed
            const successCount = error.result?.nInserted || 0;
            return res.status(400).json({
                success:false,
                message: `Duplicate key on some records. ${successCount} inserted, ${docs.length - successCount} failed.`,
                errors: error.writeErrors?.map(e =>({
                    index:e.index,
                    errmsg: e.errmsg,
                }))
            })
        }

        //Single-document duplicate or any other error
        if (error.code === 11000) {
            return res.status(400).json({
                success: false,
                message: 'This IPCC data already exists.',
                error: error.message
            });
        }

        console.error('Error adding IPCC data:', error);
        res.status(500).json({ success: false, errror: error.message });
    }
};

// Bulk upload IPCC data
exports.bulkUploadIPCCData = async (req, res) => {
  try {
    const { userName } = req.user;

    // 1) Ensure a file or raw CSV was provided
    if (!req.file && !req.body.csv) {
      return res.status(400).json({
        success: false,
        error: 'No file provided. Please upload a CSV or Excel file.'
      });
    }

    let rawRows;
    let fileType = '';

    // 2) Parse CSV or Excel into rawRows
    if (req.file) {
      const name = req.file.originalname.toLowerCase();
      const mime = req.file.mimetype;

      // CSV
      if (name.endsWith('.csv') || mime === 'text/csv' || mime === 'application/csv') {
        fileType = 'CSV';
        rawRows  = await csvtojson().fromString(req.file.buffer.toString('utf8'));
      }
      // Excel
      else if (
        name.endsWith('.xlsx') ||
        name.endsWith('.xls') ||
        mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        mime === 'application/vnd.ms-excel'
      ) {
        fileType = 'Excel';
        const wb    = XLSX.read(req.file.buffer, { type: 'buffer' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        rawRows     = XLSX.utils.sheet_to_json(sheet);
      } else {
        return res.status(400).json({
          success: false,
          error: 'Invalid file type. Please upload CSV or Excel (.xlsx, .xls).'
        });
      }
    } else {
      // raw CSV in request body
      fileType = 'CSV';
      rawRows  = await csvtojson().fromString(req.body.csv);
    }

    // 3) Trim whitespace from raw header keys
    const trimmedRows = rawRows.map(row =>
      Object.fromEntries(
        Object.entries(row).map(([key, val]) => [ key.trim(), val ])
      )
    );

    // 4) Map incoming headers to schema fields
    //    NOTE: we now include lowercase 'level1', 'level2', 'level3'
    const colMap = {
      // explicit mappings for lower‐case headers
      'level1': 'level1',
      'level2': 'level2',
      'level3': 'level3',

      // legacy / spaced headers
      'Level 1': 'level1',
      'Level 2': 'level2',
      'Level 3': 'level3',
      'Cpool': 'Cpool',
      'Type Of Parameter': 'TypeOfParameter',
      'TypeOfParameter': 'TypeOfParameter',
      'Description': 'Description',
      'Technologies Or Practices': 'TechnologiesOrPractices',
      'TechnologiesOrPractices': 'TechnologiesOrPractices',
      'Parameters Or Conditions': 'ParametersOrConditions',
      'ParametersOrConditions': 'ParametersOrConditions',
      'Region Or Regional Conditions': 'RegionOrRegionalConditions',
      'RegionOrRegionalConditions': 'RegionOrRegionalConditions',
      'Abatement Or Control Technologies': 'AbatementOrControlTechnologies',
      'AbatementOrControlTechnologies': 'AbatementOrControlTechnologies',
      'Other Properties': 'OtherProperties',
      'OtherProperties': 'OtherProperties',
      'Value': 'Value',
      'Unit': 'Unit',
      'Equation': 'Equation',
      'IPCC Worksheet': 'IPCCWorksheet',
      'IPCCWorksheet': 'IPCCWorksheet',
      'Technical Reference': 'TechnicalReference',
      'TechnicalReference': 'TechnicalReference',
      'Source Of Data': 'SourceOfData',
      'SourceOfData': 'SourceOfData',
      'Data Provider': 'DataProvider',
      'DataProvider': 'DataProvider',
    };

    // apply the mapping
    const rows = trimmedRows.map(r => {
      const mapped = {};
      for (const [col, fld] of Object.entries(colMap)) {
        if (Object.prototype.hasOwnProperty.call(r, col)) {
          mapped[fld] = r[col];
        }
      }
      // fallback for any header containing “value”
      if (mapped.Value === undefined) {
        for (const k of Object.keys(r)) {
          if (k.toLowerCase().includes('value')) {
            mapped.Value = r[k];
            break;
          }
        }
      }
      return mapped;
    });

    // 5) No data?
    if (!rows.length) {
      return res.status(400).json({
        success: false,
        error: 'No data found in the uploaded file.'
      });
    }

    // 6) Prepare results accumulator
    const results = {
      fileType,
      totalRows: rows.length,
      created:   0,
      updated:   0,
      unchanged: 0,
      errors:    []
    };

    // 7) Process each row
    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i];
      try {
        // a) Normalize text fields (default to empty string)
        const row = {
          level1:                      (raw.level1   || '').toString().trim(),
          level2:                      (raw.level2   || '').toString().trim(),
          level3:                      (raw.level3   || '').toString().trim(),
          Cpool:                       (raw.Cpool    || '').toString().trim(),
          TypeOfParameter:             (raw.TypeOfParameter || '').toString().trim(),
          Description:                 (raw.Description      || '').toString().trim(),
          TechnologiesOrPractices:     (raw.TechnologiesOrPractices || '').toString().trim(),
          ParametersOrConditions:      (raw.ParametersOrConditions    || '').toString().trim(),
          RegionOrRegionalConditions:  (raw.RegionOrRegionalConditions || '').toString().trim(),
          AbatementOrControlTechnologies: (raw.AbatementOrControlTechnologies || '').toString().trim(),
          OtherProperties:             (raw.OtherProperties   || '').toString().trim(),
          Unit:                        (raw.Unit             || '').toString().trim(),
          Equation:                    (raw.Equation         || '').toString().trim(),
          IPCCWorksheet:               (raw.IPCCWorksheet    || '').toString().trim(),
          TechnicalReference:          (raw.TechnicalReference || '').toString().trim(),
          SourceOfData:                (raw.SourceOfData     || '').toString().trim(),
          DataProvider:                (raw.DataProvider     || '').toString().trim(),
        };

        // b) Parse numeric Value (“3 x 10-5” → 3e-5)
        const newVal = parseFloat(
          typeof raw.Value === 'string'
            ? raw.Value.replace(/\s*x\s*/, 'e')
            : raw.Value
        );
        if (isNaN(newVal)) {
          results.errors.push({
            rowNumber: i + 2,
            row: raw,
            error: 'Invalid numeric Value'
          });
          continue;
        }

        // c) Validate that Unit exists
        if (!row.Unit) {
          results.errors.push({
            rowNumber: i + 2,
            row: raw,
            error: 'Missing required field Unit'
          });
          continue;
        }

        // d) Build fullQuery INCLUDING Value for true deduplication
        const fullQuery = {
          level1: row.level1,
          level2: row.level2,
          level3: row.level3,
          Cpool:  row.Cpool,
          TypeOfParameter:           row.TypeOfParameter,
          TechnologiesOrPractices:   row.TechnologiesOrPractices,
          ParametersOrConditions:    row.ParametersOrConditions,
          RegionOrRegionalConditions:row.RegionOrRegionalConditions,
          AbatementOrControlTechnologies: row.AbatementOrControlTechnologies,
          OtherProperties:           row.OtherProperties,
          Description:               row.Description,
          Unit:                      row.Unit,
          Equation:                  row.Equation,
          IPCCWorksheet:             row.IPCCWorksheet,
          TechnicalReference:        row.TechnicalReference,
          SourceOfData:              row.SourceOfData,
          DataProvider:              row.DataProvider,
          Value:                     newVal,
          isActive: true
        };

        // e) Find exact duplicate (all fields + Value)
        const existing = await IPCCData.findOne(fullQuery);

        if (existing) {
          // e1) Perfect duplicate → record unchanged
          if (existing.updateValue(newVal, userName)) {
            await existing.save();
            results.updated++;
          } else {
            results.unchanged++;
          }
        } else {
          // e2) No match → create new document
          await new IPCCData({
            ...fullQuery,
            createdBy: userName
          }).save();
          results.created++;
        }
      } catch (err) {
        console.error(`Row ${i+2} error:`, err);
        results.errors.push({
          rowNumber: i + 2,
          row: raw,
          error: err.message
        });
      }
    }

    // 8) Send back the aggregated results
    return res.status(200).json({
      success: true,
      message: `Processed ${fileType} upload for IPCC data`,
      results
    });

  } catch (err) {
    console.error('bulkUploadIPCCData error:', err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
};



// Update single IPCC data entry
exports.updateIPCCData = async (req, res) => {
  try {
    // Determine actor
    const userName = req.user?.userName || req.user?.email || req.user?.id || 'system';
    const { id } = req.params;

    // Find existing document
    const existing = await IPCCData.findById(id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'IPCC data not found' });
    }

    // Destructure incoming fields
    const { Value, ...otherFields } = req.body;
    let didChange = false;

    // 1) Handle numeric Value update (if provided)
    if (Value !== undefined) {
      const newVal = parseFloat(Value);
      if (isNaN(newVal)) {
        return res.status(400).json({ success: false, error: 'Invalid numeric Value' });
      }
      // updateValue pushes history and returns true if changed
      if (existing.updateValue(newVal, userName)) {
        didChange = true;
      }
    }

    // 2) Update any other provided fields
    for (const [key, val] of Object.entries(otherFields)) {
      // only assign if field actually exists on the schema
      if (existing.schema.path(key)) {
        // trim strings for text fields
        existing[key] = typeof val === 'string' ? val.trim() : val;
        didChange = true;
      }
    }

    // If nothing changed, return early
    if (!didChange) {
      return res.status(200).json({
        success: true,
        message: 'No changes detected. IPCC data is up to date.',
        data: existing
      });
    }

    // 3) Record who updated
    existing.updatedBy = userName;
    await existing.save();

    res.status(200).json({
      success: true,
      message: 'IPCC data updated successfully.',
      data: existing
    });
  } catch (err) {
    console.error('updateIPCCData error:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

// Get all IPCC data with pagination and simple filters
exports.getAllIPCCData = async (req, res) => {
  try {
    // 1) Parse pagination params
    const page  = parseInt(req.query.page, 10)  || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const skip  = (page - 1) * limit;

    // 2) Build filter object
    const filter = { isActive: true };

    if (req.query.level1)            filter.level1           = new RegExp(req.query.level1, 'i');
    if (req.query.level2)            filter.level2           = new RegExp(req.query.level2, 'i');
    if (req.query.level3)            filter.level3           = new RegExp(req.query.level3, 'i');
    if (req.query.Cpool)             filter.Cpool            = new RegExp(req.query.Cpool, 'i');
    if (req.query.TypeOfParameter)   filter.TypeOfParameter  = new RegExp(req.query.TypeOfParameter, 'i');
    if (req.query.Unit)              filter.Unit             = new RegExp(req.query.Unit, 'i');
    if (req.query.IPCCWorksheet)     filter.IPCCWorksheet    = new RegExp(req.query.IPCCWorksheet, 'i');
    if (req.query.SourceOfData)      filter.SourceOfData     = new RegExp(req.query.SourceOfData, 'i');
    if (req.query.DataProvider)      filter.DataProvider     = new RegExp(req.query.DataProvider, 'i');

    // 3) Count total matching documents
    const total = await IPCCData.countDocuments(filter);

    // 4) Fetch page of data
    const data = await IPCCData.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    // 5) Return results with pagination info
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
    console.error('getAllIPCCData error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get IPCC data by ID
// Get single IPCC record by ID
exports.getIPCCDataById = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await IPCCData.findById(id);
    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'IPCC data not found'
      });
    }
    res.status(200).json({
      success: true,
      data
    });
  } catch (error) {
    console.error('getIPCCDataById error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Filter IPCC data
// Advanced filter with multiple criteria for IPCC data
exports.filterIPCCData = async (req, res) => {
  try {
    // 1) Destructure query params (all optional)
    const {
      level1s,            // comma-separated list of level1 values
      level2s,            // comma-separated list of level2 values
      level3s,            // comma-separated list of level3 values
      cpools,             // comma-separated list of Cpool values
      typeOfParameters,   // comma-separated list of TypeOfParameter values
      units,              // comma-separated list of Unit values
      minValue,           // numeric lower bound on Value
      maxValue,           // numeric upper bound on Value
      searchText,         // general text search across multiple fields
      page = 1,           // page number (1-based)
      limit = 50          // items per page
    } = req.query;

    // 2) Build the Mongo filter object
    const filter = {};

    // Exact-match / inclusion filters
    if (level1s)            filter.level1            = { $in: level1s.split(',') };
    if (level2s)            filter.level2            = { $in: level2s.split(',') };
    if (level3s)            filter.level3            = { $in: level3s.split(',') };
    if (cpools)             filter.Cpool             = { $in: cpools.split(',') };
    if (typeOfParameters)   filter.TypeOfParameter   = { $in: typeOfParameters.split(',') };
    if (units)              filter.Unit              = { $in: units.split(',') };

    // Numeric range filter for Value
    if (minValue || maxValue) {
      filter.Value = {};
      if (minValue) filter.Value.$gte = parseFloat(minValue);
      if (maxValue) filter.Value.$lte = parseFloat(maxValue);
    }

    // General full-text-style search across key text fields
    if (searchText) {
      const regex = new RegExp(searchText, 'i');
      filter.$or = [
        { level1: regex },
        { level2: regex },
        { level3: regex },
        { Cpool: regex },
        { TypeOfParameter: regex },
        { Description: regex },
        { TechnologiesOrPractices: regex },
        { ParametersOrConditions: regex },
        { RegionOrRegionalConditions: regex },
        { AbatementOrControlTechnologies: regex },
        { OtherProperties: regex },
        { Equation: regex },
        { IPCCWorksheet: regex },
        { TechnicalReference: regex },
        { SourceOfData: regex },
        { DataProvider: regex }
      ];
    }

    // Always only include active records
    filter.isActive = true;

    // 3) Pagination calculations
    const pg    = Math.max(parseInt(page, 10), 1);
    const lim   = Math.max(parseInt(limit, 10), 1);
    const skip  = (pg - 1) * lim;

    // 4) Run queries
    const [ total, data ] = await Promise.all([
      IPCCData.countDocuments(filter),
      IPCCData.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(lim)
    ]);

    // 5) Send response
    res.status(200).json({
      success: true,
      data,
      pagination: {
        total,
        page: pg,
        pages: Math.ceil(total / lim),
        limit: lim
      }
    });
  } catch (error) {
    console.error('filterIPCCData error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Delete single or multiple IPCCData records
exports.deleteIPCCData = async (req, res) => {
  try {
    // Accept an array of IDs in body.ids, or a single ID via URL param
    const idArray = Array.isArray(req.body.ids) 
      ? req.body.ids 
      : [ req.params.id ].filter(Boolean);

    if (idArray.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No ID(s) provided for deletion'
      });
    }

    // Perform deletion
    const result = await IPCCData.deleteMany({ _id: { $in: idArray } });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'No IPCC data found to delete'
      });
    }

    return res.status(200).json({
      success: true,
      message: `${result.deletedCount} record(s) deleted successfully`
    });
  } catch (err) {
    console.error('deleteIPCCData error:', err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

// Download IPCC data as CSV
exports.downloadIPCCDataCSV = async (req, res) => {
  try {
    // 1) Fetch all active records
    const data = await IPCCData.find({ isActive: true });

    // 2) Define the fields/columns you want in the CSV
    const fields = [
      'level1',
      'level2',
      'level3',
      'Cpool',
      'TypeOfParameter',
      'Description',
      'TechnologiesOrPractices',
      'ParametersOrConditions',
      'RegionOrRegionalConditions',
      'AbatementOrControlTechnologies',
      'OtherProperties',
      'Value',
      'Unit',
      'Equation',
      'IPCCWorksheet',
      'TechnicalReference',
      'SourceOfData',
      'DataProvider',
      'createdBy',
      'updatedBy',
      'createdAt',
      'updatedAt'
    ];

    // 3) Build CSV header row
    const header = fields.join(',');

    // 4) Map each record into a CSV row, with proper escaping
    const rows = data.map(record => {
      return fields.map(field => {
        let val = record[field];
        if (val == null) {
          val = '';
        } else if (val instanceof Date) {
          val = val.toISOString();
        } else {
          val = val.toString();
        }
        // escape any quotes
        return `"${val.replace(/"/g, '""')}"`;
      }).join(',');
    });

    // 5) Combine header + rows
    const csv = [header, ...rows].join('\r\n');

    // 6) Send CSV response
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="ipcc_data.csv"'
    );
    return res.send(csv);
  } catch (error) {
    console.error('downloadIPCCDataCSV error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};



// Get update history for a specific entry
exports.getIPCCDataHistory = async (req, res) => {
  try {
    const { id } = req.params;
    
    const data = await IPCCData.findById(id)
      .select('history')
      .populate('history.updatedBy', 'name email userType');

    if (!data) {
      return res.status(404).json({ message: 'IPCC data not found' });
    }

    res.status(200).json({
      message: 'IPCC data history fetched successfully',
      history: data.history
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ 
      message: 'Failed to fetch IPCC data history', 
      error: error.message 
    });
  }
};



// Test endpoint for debugging
exports.testIPCCData = async (req, res) => {
  try {
    // Count total records
    const totalCount = await IPCCData.countDocuments();
    const activeCount = await IPCCData.countDocuments({ isActive: true });
    const inactiveCount = await IPCCData.countDocuments({ isActive: false });

    // Get counts by level1
    const level1Counts = await IPCCData.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: '$level1', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // Get counts by TypeOfParameter
    const typeOfParameterCounts = await IPCCData.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: '$TypeOfParameter', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // Get recent entries
    const recentEntries = await IPCCData.find({ isActive: true })
      .select('level1 level2 level3 TypeOfParameter Value Unit createdAt')
      .sort({ createdAt: -1 })
      .limit(5);

    res.status(200).json({
      message: 'IPCC data test endpoint',
      statistics: {
        totalRecords: totalCount,
        activeRecords: activeCount,
        inactiveRecords: inactiveCount
      },
      level1Distribution: level1Counts,
      typeOfParameterDistribution: typeOfParameterCounts,
      recentEntries,
      databaseConnection: 'Connected',
      timestamp: new Date()
    });

  } catch (error) {
    console.error('Test endpoint error:', error);
    res.status(500).json({ 
      message: 'Test endpoint failed', 
      error: error.message,
      databaseConnection: 'Error'
    });
  }
};