const uploadCSVData = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;
    
    // Check permissions for CSV upload operations
    const permissionCheck = await checkOperationPermission(req.user, clientId, nodeId, scopeIdentifier, 'csv_upload');
    if (!permissionCheck.allowed) {
      return res.status(403).json({ 
        message: 'Permission denied', 
        reason: permissionCheck.reason 
      });
    
    }
        // Add after finding scopeConfig
    // Validate prerequisites for emission calculation
    const validation = await validateEmissionPrerequisites(clientId, nodeId, scopeIdentifier);
    if (!validation.isValid) {
      // Clean up file
      const fs = require('fs');
      fs.unlinkSync(req.file.path);
      
      return res.status(400).json({
        message: 'Cannot process CSV data: ' + validation.message
      });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'No CSV file uploaded' });
    }
    
    // Find scope configuration
    const flowchart = await Flowchart.findOne({ clientId, isActive: true });
    if (!flowchart) {
      return res.status(404).json({ message: 'Flowchart not found' });
    }
    
    let scopeConfig = null;
    for (const node of flowchart.nodes) {
      if (node.id === nodeId) {
        const scope = node.details.scopeDetails.find(
          s => s.scopeIdentifier === scopeIdentifier
        );
        if (scope && scope.inputType === 'manual') {
          scopeConfig = scope;
          break;
        }
      }
    }
    
    if (!scopeConfig) {
      return res.status(400).json({ message: 'Invalid manual scope configuration for CSV upload' });
    }
    
    // Process CSV file
    const csvData = await csvtojson().fromFile(req.file.path);
    
    if (!csvData || csvData.length === 0) {
      return res.status(400).json({ message: 'CSV file is empty or invalid' });
    }
    
    // Validate required columns
    const requiredColumns = ['date', 'time'];
    const firstRow = csvData[0];
    const missingColumns = requiredColumns.filter(col => !(col in firstRow));
    
    if (missingColumns.length > 0) {
      return res.status(400).json({ 
        message: `Missing required columns: ${missingColumns.join(', ')}` 
      });
    }
    
    // Process and prepare entries
    const processedEntries = [];
    const errors = [];
    
    for (const row of csvData) {
      const rawDate = row.date || moment().format('DD/MM/YYYY');
      const rawTime = row.time || moment().format('HH:mm:ss');
      
      let dateMoment = moment(rawDate, ['DD/MM/YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY'], true);
      const timeMoment = moment(rawTime, 'HH:mm:ss', true);
      
      if (!dateMoment.isValid() || !timeMoment.isValid()) {
        errors.push({
          row: csvData.indexOf(row) + 1,
          error: 'Invalid date/time format'
        });
        continue;
      }
      
      const formattedDate = dateMoment.format(['DD/MM/YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY']);
      const formattedTime = timeMoment.format('HH:mm:ss');
      
      const [day, month, year] = formattedDate.split(':').map(Number);
      const [hour, minute, second] = formattedTime.split(':').map(Number);
      const timestamp = new Date(year, month - 1, day, hour, minute, second);
      
      // Extract data values (exclude metadata fields)
      const dataObj = { ...row };
      delete dataObj.date;
      delete dataObj.time;
      delete dataObj.scopeIdentifier;
      delete dataObj.clientId;
      delete dataObj.scopeType;
      delete dataObj.emissionFactor;
      
     // Normalize via our CSV helper, then ensure a Map for cumulative tracking
      // Normalize via our comprehensive CSV helper, then ensure a Map for cumulative tracking
const processed = processCSVData(dataObj, scopeConfig);
let dataMap;
try {
  dataMap = ensureDataIsMap(processed);
} catch (err) {
  errors.push({
    row: csvData.indexOf(row) + 1,
    error: 'Invalid data shape after processing'
  });
  continue;
}
      
      processedEntries.push({
        clientId,
        nodeId,
        scopeIdentifier,
        scopeType: scopeConfig.scopeType,
        inputType: 'manual',
        date: formattedDate,
        time: formattedTime,
        timestamp,
        dataValues: dataMap,
        emissionFactor: row.emissionFactor || scopeConfig.emissionFactor || '',
        sourceDetails: {
          fileName: req.file.originalname,
          uploadedBy: req.user._id
        },
        isEditable: true,
        processingStatus: 'processed'
      });
    }
    
    // Sort by timestamp to ensure proper cumulative calculation
    processedEntries.sort((a, b) => a.timestamp - b.timestamp);
    
    // Save entries one by one to ensure proper cumulative calculation
    // Save entries one by one to ensure proper cumulative calculation and trigger emissions
const savedEntries = [];

for (const entryData of processedEntries) {
  try {
    const entry = new DataEntry(entryData);
    await entry.save(); // Pre-save hook will calculate cumulative values
    
    // Trigger emission calculation for each CSV entry
    await triggerEmissionCalculation(entry);
    
    savedEntries.push(entry);
  } catch (error) {
    errors.push({
      date: entryData.date,
      time: entryData.time,
      error: error.message
    });
  }
}
    
    // Update collection config
    if (savedEntries.length > 0) {
      const latestEntry = savedEntries[savedEntries.length - 1];
      const collectionConfig = await DataCollectionConfig.findOne({
        clientId,
        nodeId,
        scopeIdentifier
      });
      
      if (collectionConfig) {
        collectionConfig.updateCollectionStatus(latestEntry._id, latestEntry.timestamp);
        await collectionConfig.save();
      }
    }
    
    // Delete uploaded file
    const fs = require('fs');
    fs.unlinkSync(req.file.path);
    
    // Emit real-time update with detailed entry info
emitDataUpdate('csv-data-uploaded', {
  clientId,
  nodeId,
  scopeIdentifier,
  count: savedEntries.length,
  dataIds: savedEntries.map(e => e._id),
  entries: savedEntries.map(entry => {
    const { incoming: inMap, cumulative: cumMap, metadata } = entry.calculatedEmissions || {};
    const mapToObject = m => m instanceof Map ? Object.fromEntries(m) : (m || {});
    
    return {
      dataId: entry._id,
      timestamp: entry.timestamp,
      dataValues: Object.fromEntries(entry.dataValues),
      calculatedEmissions: {
        incoming: mapToObject(inMap),
        cumulative: mapToObject(cumMap),
        metadata: metadata || {}
      }
    };
  })
});
    
    const response = {
  message: 'CSV data uploaded successfully',
  totalRows: csvData.length,
  savedCount: savedEntries.length,
  dataIds: savedEntries.map(e => e._id)
};

// Include latest cumulative values with emissions
if (savedEntries.length > 0) {
  const lastEntry = savedEntries[savedEntries.length - 1];
  const { incoming: inMap, cumulative: cumMap, metadata } = lastEntry.calculatedEmissions || {};
  const mapToObject = m => m instanceof Map ? Object.fromEntries(m) : (m || {});
  
  response.latestCumulative = {
    cumulativeValues: Object.fromEntries(lastEntry.cumulativeValues),
    highData: Object.fromEntries(lastEntry.highData),
    lowData: Object.fromEntries(lastEntry.lowData),
    lastEnteredData: Object.fromEntries(lastEntry.lastEnteredData),
    calculatedEmissions: {
      incoming: mapToObject(inMap),
      cumulative: mapToObject(cumMap),
      metadata: metadata || {}
    }
  };
}
    
    if (errors.length > 0) {
      response.errors = errors;
      response.failedCount = errors.length;
    }
    
    res.status(201).json(response);
    
  } catch (error) {
    console.error('Upload CSV error:', error);
    
    // Clean up file on error
    if (req.file) {
      const fs = require('fs');
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.error('Failed to clean up file:', cleanupError);
      }
    }
    
    res.status(500).json({ 
      message: 'Failed to upload CSV data', 
      error: error.message 
    });
  }
};