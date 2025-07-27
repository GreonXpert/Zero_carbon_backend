const EmissionFactorHub = require('../../models/EmissionFactor/EmissionFactorHub');

// Add new emission factor
exports.addEmissionFactorHub = async (req, res) => {
  try {
    const {
      scope,
      category,
      activity,
      itemName,
      unit,
      Co2e,
      source,
      reference,
      year,
      region,
      notes
    } = req.body;

    // Validate required fields
    if (!category || !activity || !itemName || !unit || !Co2e || !source) {
      return res.status(400).json({
        message: 'Required fields: category, activity, itemName, unit, Co2e, source'
      });
    }

    // Check if entry already exists
    const existingEntry = await EmissionFactorHub.findOne({
      scope:scope.trim(),
      category: category.trim(),
      activity: activity.trim(),
      itemName: itemName.trim(),
      unit: unit.toLowerCase()
    });

    if (existingEntry) {
      return res.status(409).json({
        message: 'Emission factor for this category, activity, item, and unit already exists'
      });
    }

    // Create new emission factor
    const newEmissionFactor = new EmissionFactorHub({
      scope:scope.trim(),
      category: category.trim(),
      activity: activity.trim(),
      itemName: itemName.trim(),
      unit: unit.toLowerCase(),
      Co2e,
      source: source.trim(),
      reference: reference ? reference.trim() : '',
      year: year || new Date().getFullYear(),
      region: region ? region.trim() : 'Global',
      notes: notes ? notes.trim() : ''
    });

    const savedEmissionFactor = await newEmissionFactor.save();

    res.status(201).json({
      message: 'Emission factor added successfully',
      data: savedEmissionFactor
    });
  } catch (error) {
    console.error('Error adding emission factor:', error);
    res.status(500).json({
      message: 'Failed to add emission factor',
      error: error.message
    });
  }
};

// Get all emission factors
exports.getAllEmissionFactorsHub = async (req, res) => {
  try {
    const { page = 1, limit = 50, sortBy = 'createdAt', order = 'desc' } = req.query;
    
    const options = {
      page: parseInt(page),
      limit: parseInt(limit),
      sort: { [sortBy]: order === 'desc' ? -1 : 1 }
    };

    const emissionFactors = await EmissionFactorHub.find()
      .sort(options.sort)
      .limit(options.limit * 1)
      .skip((options.page - 1) * options.limit);

    const total = await EmissionFactorHub.countDocuments();

    res.status(200).json({
      message: 'Emission factors fetched successfully',
      data: emissionFactors,
      pagination: {
        currentPage: options.page,
        totalPages: Math.ceil(total / options.limit),
        totalItems: total,
        itemsPerPage: options.limit
      }
    });
  } catch (error) {
    console.error('Error fetching emission factors:', error);
    res.status(500).json({
      message: 'Failed to fetch emission factors',
      error: error.message
    });
  }
};

// Get emission factor by ID
exports.getEmissionFactorHubById = async (req, res) => {
  try {
    const { id } = req.params;

    const emissionFactor = await EmissionFactorHub.findById(id);

    if (!emissionFactor) {
      return res.status(404).json({
        message: 'Emission factor not found'
      });
    }

    res.status(200).json({
      message: 'Emission factor fetched successfully',
      data: emissionFactor
    });
  } catch (error) {
    console.error('Error fetching emission factor by ID:', error);
    res.status(500).json({
      message: 'Failed to fetch emission factor',
      error: error.message
    });
  }
};

// Update emission factor by ID
exports.updateEmissionFactorHub = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    // Clean up string fields
    if (updateData.scope) updateData.scope = updateData.scope.trim();
    if (updateData.category) updateData.category = updateData.category.trim();
    if (updateData.activity) updateData.activity = updateData.activity.trim();
    if (updateData.itemName) updateData.itemName = updateData.itemName.trim();
    if (updateData.unit) updateData.unit = updateData.unit.toLowerCase();
    if (updateData.source) updateData.source = updateData.source.trim();
    if (updateData.reference) updateData.reference = updateData.reference.trim();
    if (updateData.region) updateData.region = updateData.region.trim();
    if (updateData.notes) updateData.notes = updateData.notes.trim();

    const updatedEmissionFactor = await EmissionFactorHub.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!updatedEmissionFactor) {
      return res.status(404).json({
        message: 'Emission factor not found'
      });
    }

    res.status(200).json({
      message: 'Emission factor updated successfully',
      data: updatedEmissionFactor
    });
  } catch (error) {
    console.error('Error updating emission factor:', error);
    res.status(500).json({
      message: 'Failed to update emission factor',
      error: error.message
    });
  }
};

// Delete emission factor by ID
exports.deleteEmissionFactorHub = async (req, res) => {
  try {
    const { id } = req.params;

    const deletedEmissionFactor = await EmissionFactorHub.findByIdAndDelete(id);

    if (!deletedEmissionFactor) {
      return res.status(404).json({
        message: 'Emission factor not found'
      });
    }

    res.status(200).json({
      message: 'Emission factor deleted successfully',
      data: deletedEmissionFactor
    });
  } catch (error) {
    console.error('Error deleting emission factor:', error);
    res.status(500).json({
      message: 'Failed to delete emission factor',
      error: error.message
    });
  }
};

// Filter/Search emission factors
exports.filterEmissionFactorsHub = async (req, res) => {
  try {
    const {
      scope,
      category,
      activity,
      itemName,
      unit,
      region,
      year,
      source,
      minCo2e,
      maxCo2e,
      page = 1,
      limit = 50
    } = req.query;

    // Build filter object
    const filter = {};

    
    if (scope) {
      filter.scope = { $regex: scope, $options: 'i' };
    }

    if (category) {
      filter.category = { $regex: category, $options: 'i' };
    }
    if (activity) {
      filter.activity = { $regex: activity, $options: 'i' };
    }
    if (itemName) {
      filter.itemName = { $regex: itemName, $options: 'i' };
    }
    if (unit) {
      filter.unit = unit.toLowerCase();
    }
    if (region) {
      filter.region = { $regex: region, $options: 'i' };
    }
    if (year) {
      filter.year = parseInt(year);
    }
    if (source) {
      filter.source = { $regex: source, $options: 'i' };
    }
    if (minCo2e || maxCo2e) {
      filter.Co2e = {};
      if (minCo2e) filter.Co2e.$gte = parseFloat(minCo2e);
      if (maxCo2e) filter.Co2e.$lte = parseFloat(maxCo2e);
    }

    const options = {
      page: parseInt(page),
      limit: parseInt(limit)
    };

    const emissionFactors = await EmissionFactorHub.find(filter)
      .sort({ createdAt: -1 })
      .limit(options.limit * 1)
      .skip((options.page - 1) * options.limit);

    const total = await EmissionFactorHub.countDocuments(filter);

    res.status(200).json({
      message: 'Filtered emission factors fetched successfully',
      data: emissionFactors,
      pagination: {
        currentPage: options.page,
        totalPages: Math.ceil(total / options.limit),
        totalItems: total,
        itemsPerPage: options.limit
      },
      appliedFilters: filter
    });
  } catch (error) {
    console.error('Error filtering emission factors:', error);
    res.status(500).json({
      message: 'Failed to filter emission factors',
      error: error.message
    });
  }
};

// Get unique field values
exports.getUniqueFieldValues = async (req, res) => {
  try {
    const { field } = req.query;
    
    let result = {};
    let message = '';

    // If no field specified or field is 'all', fetch all unique values
    if (!field || field === 'all') {
      const [categories, activities, itemNames, units] = await Promise.all([
        EmissionFactorHub.distinct('category'),
        EmissionFactorHub.distinct('activity'),
        EmissionFactorHub.distinct('itemName'),
        EmissionFactorHub.distinct('unit')
      ]);

      result = {
        categories: categories.sort(),
        activities: activities.sort(),
        itemNames: itemNames.sort(),
        units: units.sort()
      };
      message = 'All unique field values fetched successfully';
    }
    // If specific field is requested
    else {
      let fieldName = '';
      let data = [];

      switch (field.toLowerCase()) {
        case 'category':
        case 'categories':
          data = await EmissionFactorHub.distinct('category');
          fieldName = 'categories';
          message = 'Unique categories fetched successfully';
          break;

        case 'activity':
        case 'activities':
          data = await EmissionFactorHub.distinct('activity');
          fieldName = 'activities';
          message = 'Unique activities fetched successfully';
          break;

        case 'item':
        case 'itemname':
        case 'itemnames':
          data = await EmissionFactorHub.distinct('itemName');
          fieldName = 'itemNames';
          message = 'Unique item names fetched successfully';
          break;

        case 'unit':
        case 'units':
          data = await EmissionFactorHub.distinct('unit');
          fieldName = 'units';
          message = 'Unique units fetched successfully';
          break;

        default:
          return res.status(400).json({
            message: 'Invalid field parameter. Use: category, activity, itemName, unit, or all',
            validFields: ['category', 'activity', 'itemName', 'unit', 'all']
          });
      }

      result = {
        [fieldName]: data.sort()
      };
    }

    res.status(200).json({
      message,
      data: result
    });

  } catch (error) {
    console.error('Error fetching unique field values:', error);
    res.status(500).json({
      message: 'Failed to fetch unique field values',
      error: error.message
    });
  }
};

// Get activities by category
exports.getActivitiesByCategory = async (req, res) => {
  try {
    const { category } = req.params;
    
    const activities = await EmissionFactorHub.distinct('activity', {
      category: { $regex: category, $options: 'i' }
    });

    res.status(200).json({
      message: 'Activities fetched successfully',
      data: activities.sort()
    });
  } catch (error) {
    console.error('Error fetching activities by category:', error);
    res.status(500).json({
      message: 'Failed to fetch activities',
      error: error.message
    });
  }
};

// Get items by category and activity
exports.getItemsByCategoryAndActivity = async (req, res) => {
  try {
    const { category, activity } = req.query;
    
    const filter = {};
    
    if (category) filter.category = { $regex: category, $options: 'i' };
    if (activity) filter.activity = { $regex: activity, $options: 'i' };

    const items = await EmissionFactorHub.distinct('itemName', filter);

    res.status(200).json({
      message: 'Items fetched successfully',
      data: items.sort()
    });
  } catch (error) {
    console.error('Error fetching items:', error);
    res.status(500).json({
      message: 'Failed to fetch items',
      error: error.message
    });
  }
};

// Bulk import emission factors
exports.bulkImportEmissionFactorsHub = async (req, res) => {
  try {
    let emissionFactorsData = [];

    console.log('🔄 Starting bulk import process...');
    console.log('📋 Request details:', {
      hasFiles: !!req.files,
      filesLength: req.files ? req.files.length : 0,
      hasBody: !!req.body,
      bodyKeys: Object.keys(req.body || {}),
      contentType: req.headers['content-type']
    });

    // Check if it's a file upload (handle both upload.single and upload.any)
    const uploadedFile = req.file || (req.files && req.files[0]);
    
    if (uploadedFile) {
      const csvtojson = require('csvtojson');
      
      console.log('📁 CSV file detected:', {
        filename: uploadedFile.filename || uploadedFile.originalname,
        mimetype: uploadedFile.mimetype,
        size: uploadedFile.size,
        buffer: !!uploadedFile.buffer
      });
      
      try {
        console.log('🔍 Parsing CSV file...');
        
        let csvData;
        if (uploadedFile.buffer) {
          // For memoryStorage (upload.any())
          const csvString = uploadedFile.buffer.toString('utf8');
          csvData = await csvtojson().fromString(csvString);
        } else if (uploadedFile.path) {
          // For diskStorage (upload.single())
          csvData = await csvtojson().fromFile(uploadedFile.path);
        } else {
          throw new Error('Unable to read uploaded file');
        }

        console.log(`📊 Found ${csvData.length} rows in CSV`);
        
        // Debug: Log first row to see structure
        if (csvData.length > 0) {
          console.log('🎯 First CSV row structure:', Object.keys(csvData[0]));
          console.log('📝 First row data sample:', csvData[0]);
        }
        
        // Convert CSV data to our schema format
        emissionFactorsData = csvData.map((row, index) => {
          const mappedData = {
            scope: (row.Scope || row.scope || '').toString().trim(),
            category: (row.Category || row.category || '').toString().trim(),
            activity: (row['Activity'] || row.activity || row['Activity Description'] || '').toString().trim(),
            itemName: (row['Item Name'] || row.itemName || row['Item name'] || '').toString().trim(),
            unit: (row.Unit || row.unit || '').toString().trim().toLowerCase(),
            Co2e: parseFloat(row['Emission Factor'] || row.Co2e || row['emission factor'] || row['CO2e'] || 0),
            source: (row.Source || row.source || '').toString().trim(),
            reference: (row.Reference || row.reference || '').toString().trim(),
            year: parseInt(row.Year || row.year) || new Date().getFullYear(),
            region: (row.Region || row.region || 'Global').toString().trim(),
            notes: (row.Notes || row.notes || '').toString().trim()
          };
          
          // Debug log for first few rows
          if (index < 3) {
            console.log(`🔧 Mapped row ${index + 1}:`, JSON.stringify(mappedData, null, 2));
          }
          
          return mappedData;
        });

        console.log(`✅ Successfully converted ${emissionFactorsData.length} CSV rows to JSON format`);

        // Clean up uploaded file if it's on disk
        if (uploadedFile.path) {
          try {
            const fs = require('fs');
            fs.unlinkSync(uploadedFile.path);
            console.log('🗑️ Cleaned up uploaded CSV file');
          } catch (cleanupError) {
            console.warn('⚠️ Warning: Could not delete uploaded file:', cleanupError.message);
          }
        }
        
      } catch (csvError) {
        console.error('❌ CSV parsing error:', csvError);
        return res.status(400).json({
          message: 'Error parsing CSV file. Please check the file format and column headers.',
          error: csvError.message,
          expectedHeaders: ['Category', 'Activity', 'Item Name', 'Unit', 'Emission Factor', 'Source'],
          receivedHeaders: csvError.headers || 'Unknown'
        });
      }
    } else if (req.body.emissionFactors && Array.isArray(req.body.emissionFactors)) {
      // Manual data entry - already in JSON format
      console.log('📝 Manual JSON data detected');
      emissionFactorsData = req.body.emissionFactors;
      console.log(`📊 Received ${emissionFactorsData.length} JSON records`);
    } else {
      console.log('❌ No valid data source found');
      return res.status(400).json({
        message: 'Please provide either a CSV file or an array of emission factors in the request body',
        receivedFiles: req.files ? req.files.length : 0,
        receivedBodyKeys: Object.keys(req.body || {}),
        expectedFileField: 'csvFile or any file field',
        expectedBodyField: 'emissionFactors (array)'
      });
    }

    if (!Array.isArray(emissionFactorsData) || emissionFactorsData.length === 0) {
      return res.status(400).json({
        message: 'No valid emission factors data found. Please check your file or data format.',
        dataLength: emissionFactorsData.length,
        dataType: typeof emissionFactorsData
      });
    }

    console.log(`🎯 Processing ${emissionFactorsData.length} records for database insertion...`);

    const results = {
      inserted: [],
      errors: [],
      duplicates: []
    };

    // Process each record and save to MongoDB
    for (let i = 0; i < emissionFactorsData.length; i++) {
      try {
        const factor = emissionFactorsData[i];
        
        // Validate required fields
        if (!factor.scope||!factor.category || !factor.activity || !factor.itemName || 
            !factor.unit || !factor.Co2e || !factor.source) {
          results.errors.push({
            index: i + 1,
            data: factor,
            error: 'Missing required fields: category, activity, itemName, unit, Co2e, source'
          });
          continue;
        }

        // Validate Co2e is a valid positive number
        const co2eNum = parseFloat(factor.Co2e);
        if (isNaN(co2eNum) || co2eNum < 0) {
          results.errors.push({
            index: i + 1,
            data: factor,
            error: 'Co2e must be a positive number'
          });
          continue;
        }

        // Check for duplicates in database
        const existingFactor = await EmissionFactorHub.findOne({
          scope:factor.scope.trim(),
          category: factor.category.trim(),
          activity: factor.activity.trim(),
          itemName: factor.itemName.trim(),
          unit: factor.unit.toLowerCase().trim()
        });

        if (existingFactor) {
          results.duplicates.push({
            index: i + 1,
            data: factor,
            existingId: existingFactor._id,
            message: 'Entry already exists in database'
          });
          continue;
        }

        // Create new document for MongoDB
        const newFactor = new EmissionFactorHub({
          scope:factor.scope.trim(),
          category: factor.category.trim(),
          activity: factor.activity.trim(),
          itemName: factor.itemName.trim(),
          unit: factor.unit.toLowerCase().trim(),
          Co2e: co2eNum,
          source: factor.source.trim(),
          reference: factor.reference ? factor.reference.trim() : '',
          year: factor.year || new Date().getFullYear(),
          region: factor.region ? factor.region.trim() : 'Global',
          notes: factor.notes ? factor.notes.trim() : ''
        });

        // Save to MongoDB
        const saved = await newFactor.save();
        
        console.log(`✅ Saved record ${i + 1}: ${saved.category} - ${saved.itemName}`);
        
        results.inserted.push({
          index: i + 1,
          id: saved._id,
          category: saved.category,
          itemName: saved.itemName,
          Co2e: saved.Co2e
        });
        
      } catch (error) {
        console.error(`❌ Error processing record ${i + 1}:`, error.message);
        results.errors.push({
          index: i + 1,
          data: emissionFactorsData[i],
          error: error.message
        });
      }
    }

    console.log('🎉 Bulk import completed!');
    console.log(`📈 Summary: ${results.inserted.length} inserted, ${results.errors.length} errors, ${results.duplicates.length} duplicates`);

    res.status(200).json({
      message: 'Bulk import completed successfully',
      summary: {
        totalProvided: emissionFactorsData.length,
        successful: results.inserted.length,
        failed: results.errors.length,
        duplicates: results.duplicates.length
      },
      results: {
        inserted: results.inserted,
        errors: results.errors.length > 0 ? results.errors.slice(0, 10) : undefined, // Limit errors in response
        duplicates: results.duplicates.length > 0 ? results.duplicates.slice(0, 10) : undefined // Limit duplicates in response
      }
    });
  } catch (error) {
    console.error('💥 Critical error in bulk import:', error);
    res.status(500).json({
      message: 'Failed to perform bulk import',
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};

// Download CSV template for bulk import
exports.downloadCSVTemplate = async (req, res) => {
  try {
    console.log('🔄 Starting CSV export process...');

    // Fetch all emission factors from the database
    const emissionFactors = await EmissionFactorHub.find({}).sort({ createdAt: -1 });
    
    console.log(`📊 Found ${emissionFactors.length} records to export`);

    if (emissionFactors.length === 0) {
      return res.status(404).json({
        message: 'No emission factors found in the database to export'
      });
    }

    // Define CSV headers
    const csvHeaders = [
      'Scope',
      'Category',
      'Activity', 
      'Item Name',
      'Unit',
      'Emission Factor',
      'Source',
      'Reference',
      'Year',
      'Region',
      'Notes'
    ];

    // Create CSV content starting with headers
    let csvContent = csvHeaders.join(',') + '\n';

    // Add each emission factor as a row in the CSV
    emissionFactors.forEach((factor) => {
      const row = [
        factor.scope ||'',
        factor.category || '',
        factor.activity || '',
        factor.itemName || '',
        factor.unit || '',
        factor.Co2e || '',
        factor.source || '',
        factor.reference || '',
        factor.year || '',
        factor.region || '',
        factor.notes || ''
      ];

      // Wrap each field in quotes and escape any existing quotes
      const csvRow = row.map(field => {
        const fieldStr = String(field);
        // Escape quotes by doubling them and wrap in quotes
        return `"${fieldStr.replace(/"/g, '""')}"`;
      }).join(',');

      csvContent += csvRow + '\n';
    });

    console.log('✅ CSV content generated successfully');

    // Set response headers for file download
    const filename = `emission_factors_hub_${new Date().toISOString().split('T')[0]}.csv`;
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', Buffer.byteLength(csvContent, 'utf8'));

    console.log(`📁 Sending CSV file: ${filename}`);
    res.status(200).send(csvContent);

  } catch (error) {
    console.error('❌ Error generating CSV export:', error);
    res.status(500).json({
      message: 'Failed to export emission factors to CSV',
      error: error.message
    });
  }
};