// controllers/CalculateEmissionCO2eController.js
const moment    = require("moment");
const csvtojson = require("csvtojson");
const CalculateEmissionCO2e = require("../models/CalculateEmissionCO2e");
const Flowchart             = require("../models/Flowchart");
const FuelCombustion        = require("../models/FuelCombustion");
const EmissionFactor        = require("../models/EmissionFactor");
const emissionFactor2 = require("../models/countryEmissionFactorModel");
const emissionFactor3 = require("../models/EmissionFactorScope3");

const User      = require("../models/User");
const DataEntry = require("../models/DataEntry")


// Normalize common unit variants to DB conventions
function normalizeUnit(u) {
  if (!u || typeof u !== 'string') return 'other';

  const low = u.trim().toLowerCase();

  // special handling for kWh (+ net/gross CV)
  const kwhMatch = low.match(/^kwh(?:\s*\((net|gross)\s*cv\))?$/);
  if (kwhMatch) {
    return kwhMatch[1]
      ? `kwh_${kwhMatch[1]}_cv`   // "kwh_net_cv" or "kwh_gross_cv"
      : 'kwh';                   // "kwh"
  }

  // map of all other accepted variants → normalized value
  const unitMap = {
    // currencies
    dollar:      'usd', dollars:   'usd', usd:       'usd', '$':        'usd',
    rupee:       'inr', rupees:    'inr', inr:       'inr', '₹':        'inr',
    dirham:      'aed', dirhams:   'aed', aed:       'aed', dh:         'aed',
    riyal:       'sar', riyals:    'sar', sar:       'sar', sr:         'sar',
    dinar:       'kwd', dinars:    'kwd', kwd:       'kwd', bhd:        'kwd', jod: 'kwd',
    'singapore dollar': 'sgd', 'singapore dollars':'sgd', sgd:'sgd','s$':'sgd',
    ringgit:     'myr','malaysian ringgit':'myr', myr:'myr','rm':'myr',

    // counts
    number:      'count', count:'count', pieces:'count',

    // mass
    tonnes:      'tonne', tons:'tonne', tonne:'tonne', ton:'tonne',
    kg:          'kg', kilogram:'kg', kilograms:'kg',

    // volume
    l:           'l', litre:'l', litres:'l', liter:'l', liters:'l', ltr:'l',
    gallon:      'gal', gallons:'gal', gal:'gal',
    cubic_meter: 'm3', m3:'m3', 'm³':'m3',

    // length/area
    km:          'km', kilometer:'km', kilometers:'km',
    mile:        'mile', miles:'mile',
    square_meter:'m2', m2:'m2', 'm²':'m2',

    // energy
    mwh:         'mwh', 'mwh':'mwh',

    // time
    hour:        'h', hours:'h', hr:'h', hrs:'h',

    // specialized
    'passenger-km':'pkm', pkm:'pkm',
    'tonne-km':'tkm', tkm:'tkm'
  };

  return unitMap[low] || 'other';
}

// Compute emissions given override {standards, activity, fuel, unit}
async function computeEmissions(
  qty,
  assessmentType,
  uncQty = 0,
  uncFac = 0,
  override
) {
  let { standards, activity, fuel, unit } = override;
  if (!standards||!activity||!fuel||!unit)
    throw new Error("Override must include standards, activity, fuel, unit");

  unit = normalizeUnit(unit);
  const adjusted = qty * (1 + uncQty/100);
  const applyUnc = f => f * (1 + uncFac/100);

  if (standards === "IPCC") {
    const doc = await FuelCombustion.findOne({ activity, fuel });
    if (!doc) throw new Error("No IPCC data for this activity/fuel");
    const asmt = doc.assessments.find(a=>a.assessmentType===assessmentType);
    if (!asmt) throw new Error(`IPCC assessment "${assessmentType}" not found`);
    return {
      emissionCO2:  adjusted * applyUnc(asmt.CO2_KgL),
      emissionCH4:  adjusted * applyUnc(asmt.CH4_KgL),
      emissionN2O:  adjusted * applyUnc(asmt.N2O_KgL),
      emissionCO2e: adjusted * applyUnc(asmt.CO2e_KgL)
    };
  }

  if (standards === "DEFRA") {
    const doc = await EmissionFactor.findOne({ "activities.name": activity });
    if (!doc) throw new Error("No DEFRA data for this activity");
    const fuelObj = doc.activities
      .find(a=>a.name===activity)
      ?.fuels.find(f=>f.name===fuel);
    if (!fuelObj) throw new Error("Fuel not found in DEFRA data");

    const unitObj = fuelObj.units.find(u=>
      u.type.trim().toLowerCase() === unit.trim().toLowerCase()
    );
    if (!unitObj) {
      const avail = fuelObj.units.map(u=>u.type).join(", ");
      throw new Error(`Unit "${unit}" not in DEFRA data (available: ${avail})`);
    }
    return {
      emissionCO2:  adjusted * applyUnc(unitObj.kgCO2),
      emissionCH4:  adjusted * applyUnc(unitObj.kgCH4),
      emissionN2O:  adjusted * applyUnc(unitObj.kgN2O),
      emissionCO2e: adjusted * applyUnc(unitObj.kgCO2e)
    };
  }

  throw new Error("Unsupported standard: must be IPCC or DEFRA");
}

exports.calculateAndSaveEmission = async (req, res) => {
  try {
    const {
      periodOfDate,
      startDate,
      assessmentType,
      uncertaintyLevelConsumedData = 0,
      uncertaintyLevelEmissionFactor = 0,
      userId,
      nodeId,
      scopeIndex,
      comments = "",
      fuelSupplier = ""
    } = req.body;

    // 1. load flowchart
    const flowchart = await Flowchart.findOne({ userId });
    if (!flowchart) {
      return res.status(400).json({ message: "No flowchart for this user." });
    }
    //find the specific node and its API flag
   const nodeConfig = flowchart.nodes.find(n => n.id === nodeId);
   if (!nodeConfig) {
     return res.status(400).json({ message: `Node ${nodeId} not in flowchart.` });
   }
   
    // 2. collect rawData & totalQty
    let rawData = [], totalQty = 0;

     
    // CSV branch (file field must be named "document")
    if (req.file) {
      if (!nodeId) {
        return res.status(400).json({ message: "nodeId is required for CSV" });
      }
      const rows = await csvtojson().fromFile(req.file.path);
      for (const { date, quantity } of rows) {
        if (!date || !quantity) {
          return res.status(400).json({
            message: "CSV must have columns: date, quantity"
          });
        }
        const qty  = parseFloat(quantity);
        const node = flowchart.nodes.find(n=>n.id===nodeId);
        if (!node) {
          return res.status(400).json({ message:`No node ${nodeId}` });
        }
        totalQty += qty;
        rawData.push({
          nodeId,
          quantity:  qty,
          timestamp: moment(date,"DD/MM/YYYY").toDate(),
          inputType: node.details.inputType,
          scopeIndex: scopeIndex!=null ? +scopeIndex : undefined
        });
      }
    }

    // Manual/API/MQTT branch
    if (req.body.consumedData) {
      if (!nodeId) {
        return res.status(400).json({
          message: "nodeId is required for manual/API entries"
        });
      }
      const qty  = parseFloat(req.body.consumedData);
      const node = flowchart.nodes.find(n=>n.id===nodeId);
      if (!node) {
        return res.status(400).json({ message:`No node ${nodeId}` });
      }
      totalQty += qty;
      rawData.push({
        nodeId,
        quantity:  qty,
        timestamp: new Date(),
        inputType: node.details.inputType,
        scopeIndex: scopeIndex!=null ? +scopeIndex : undefined
      });
    }

    if (!rawData.length) {
      return res.status(400).json({
        message: "Provide a CSV file or consumedData in body."
      });
    }

    // 3. compute emissions per entry & sum
    let sumCO2=0, sumCH4=0, sumN2O=0, sumCO2e=0, metadataStandard=null;
    for (const entry of rawData) {
      const node   = flowchart.nodes.find(n=>n.id===entry.nodeId);
      const scopes = node.details.scopeDetails;
      if (!scopes?.length) {
        return res.status(400).json({
          message:`Node ${entry.nodeId} has no scopeDetails`
        });
      }
      let idx = entry.scopeIndex;
      if (scopes.length===1) idx=0;
      else if (idx==null||idx<0||idx>=scopes.length) {
        return res.status(400).json({
          message:
            `Node ${entry.nodeId} has ${scopes.length} scopes; `+
            `specify scopeIndex (0–${scopes.length-1})`
        });
      }
      const d = scopes[idx];
      const override = {
        standards: d.emissionFactor,
        activity:  d.activity,
        fuel:      d.fuel,
        unit:      d.units
      };

      const { emissionCO2, emissionCH4, emissionN2O, emissionCO2e } =
        await computeEmissions(
          entry.quantity,
          assessmentType,
          uncertaintyLevelConsumedData,
          uncertaintyLevelEmissionFactor,
          override
        );

      Object.assign(entry, { emissionCO2, emissionCH4, emissionN2O, emissionCO2e });

      sumCO2  += emissionCO2;
      sumCH4  += emissionCH4;
      sumN2O  += emissionN2O;
      sumCO2e += emissionCO2e;

      if (metadataStandard===null) metadataStandard = d.emissionFactor;
    }

    // 4. compute endDate
    const m = moment(startDate,"DD/MM/YYYY");
    let endDate;
    switch(periodOfDate) {
      case "daily":    endDate = m.clone().add(1,"day"  ).format("DD/MM/YYYY"); break;
      case "weekly":   endDate = m.clone().add(1,"week" ).format("DD/MM/YYYY"); break;
      case "monthly":  endDate = m.clone().add(1,"month").format("DD/MM/YYYY"); break;
      case "3-months": endDate = m.clone().add(3,"months").format("DD/MM/YYYY");break;
      case "yearly":   endDate = m.clone().add(1,"year" ).format("DD/MM/YYYY"); break;
      default:
        return res.status(400).json({
          message:
            "Invalid periodOfDate. Use 'daily','weekly','monthly','3-months','yearly'."
        });
    }

    // 5. pick just the one node + its edges
    const selectedNode = flowchart.nodes.find(n=>n.id===nodeId);
    const connectedEdges = flowchart.edges.filter(e=>
      e.source===nodeId || e.target===nodeId
    );

    // 6. save
    const newCalc = new CalculateEmissionCO2e({
      siteId: nodeId,
      periodOfDate,
      startDate,
      endDate,
      consumedData: totalQty,
      assessmentType,
      uncertaintyLevelConsumedData,
      uncertaintyLevelEmissionFactor,
      emissionCO2: sumCO2,
      emissionCH4: sumCH4,
      emissionN2O: sumN2O,
      emissionCO2e: sumCO2e,
      standards: metadataStandard,
      userId,
      comments,
      fuelSupplier,
      documents: req.file ? req.file.path : "",
      rawData,
      flowchartNodes: [ selectedNode ],
      flowchartEdges: connectedEdges
    });

    await newCalc.save();
    if (flowchart.apiStatus) {
           await DataEntry.deleteMany({
             companyName: user.companyName,
             date: { $gte: startOfDay, $lte: endOfDay }
           });
         }
    return res.status(201).json({ message:"Calculation saved.", data:newCalc });
  }
  catch(err) {
    console.error(err);
    return res.status(500).json({
      message:"Error processing emissions.",
      error:  err.message
    });
  }
};



// Save Manual Data Entry (will be aggregated monthly)
const saveManualData = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = req.params;
    const { date: rawDateInput, time: rawTimeInput, dataValues, emissionFactor } = req.body;
    
    // Check permissions for manual data operations
    const permissionCheck = await checkOperationPermission(req.user, clientId, nodeId, scopeIdentifier, 'manual_data');
    if (!permissionCheck.allowed) {
      return res.status(403).json({ 
        message: 'Permission denied', 
        reason: permissionCheck.reason 
      });
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
      return res.status(400).json({ message: 'Invalid manual scope configuration' });
    }
    
    // Process date/time
    const rawDate = rawDateInput || moment().format('DD/MM/YYYY');
    const rawTime = rawTimeInput || moment().format('HH:mm:ss');
    
    const dateMoment = moment(rawDate, 'DD/MM/YYYY', true);
    const timeMoment = moment(rawTime, 'HH:mm:ss', true);
    
    if (!dateMoment.isValid() || !timeMoment.isValid()) {
      return res.status(400).json({ message: 'Invalid date/time format' });
    }
    
    const formattedDate = dateMoment.format('DD:MM:YYYY');
    const formattedTime = timeMoment.format('HH:mm:ss');
    
    const [day, month, year] = formattedDate.split(':').map(Number);
    const [hour, minute, second] = formattedTime.split(':').map(Number);
    const timestamp = new Date(year, month - 1, day, hour, minute, second);
    
    // Ensure dataValues is a Map
    let dataMap;
    try {
      dataMap = ensureDataIsMap(dataValues);
    } catch (error) {
      return res.status(400).json({ 
        message: 'Invalid format: Please update dataValues to be key-value structured for cumulative tracking.',
        error: error.message 
      });
    }
    
    // Create data entry (no cumulative calculation for manual - will be done monthly)
    const entry = new DataEntry({
      clientId,
      nodeId,
      scopeIdentifier,
      scopeType: scopeConfig.scopeType,
      inputType: 'manual',
      date: formattedDate,
      time: formattedTime,
      timestamp,
      dataValues: dataMap,
      emissionFactor: emissionFactor || scopeConfig.emissionFactor || '',
      sourceDetails: {
        uploadedBy: req.user._id
      },
      isEditable: true,
      processingStatus: 'processed'
    });
    
    await entry.save();
    
    // Update collection config
    const collectionConfig = await DataCollectionConfig.findOneAndUpdate(
      { clientId, nodeId, scopeIdentifier },
      {
        $setOnInsert: {
          scopeType: scopeConfig.scopeType,
          inputType: 'manual',
          collectionFrequency: scopeConfig.collectionFrequency || 'monthly',
          createdBy: req.user._id
        }
      },
      { upsert: true, new: true }
    );
    
    collectionConfig.updateCollectionStatus(entry._id, timestamp);
    await collectionConfig.save();
    
    // Emit real-time update
    emitDataUpdate('manual-data-saved', {
      clientId,
      nodeId,
      scopeIdentifier,
      dataId: entry._id,
      timestamp,
      dataValues: Object.fromEntries(entry.dataValues)
    });
    
    res.status(201).json({
      message: 'Manual data saved successfully',
      dataId: entry._id
    });
    
  } catch (error) {
    console.error('Save manual data error:', error);
    res.status(500).json({ 
      message: 'Failed to save manual data', 
      error: error.message 
    });
  }
};



// Upload CSV Data (will be aggregated monthly)
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
    
    // Process each row
    const dataEntries = [];
    const savedEntries = [];
    
    for (const row of csvData) {
      const rawDate = row.date || moment().format('DD/MM/YYYY');
      const rawTime = row.time || moment().format('HH:mm:ss');
      
      const dateMoment = moment(rawDate, 'DD/MM/YYYY', true);
      const timeMoment = moment(rawTime, 'HH:mm:ss', true);
      
      if (!dateMoment.isValid() || !timeMoment.isValid()) {
        continue; // Skip invalid rows
      }
      
      const formattedDate = dateMoment.format('DD:MM:YYYY');
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
      
      // Convert to Map
      const dataMap = new Map(Object.entries(dataObj));
      
      const entry = new DataEntry({
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
      
      const savedEntry = await entry.save();
      savedEntries.push(savedEntry);
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
    
    // Emit real-time update
    emitDataUpdate('csv-data-uploaded', {
      clientId,
      nodeId,
      scopeIdentifier,
      count: savedEntries.length,
      dataIds: savedEntries.map(e => e._id)
    });
    
    res.status(201).json({
      message: 'CSV data uploaded successfully',
      count: savedEntries.length,
      dataIds: savedEntries.map(e => e._id)
    });
    
  } catch (error) {
    console.error('Upload CSV error:', error);
    res.status(500).json({ 
      message: 'Failed to upload CSV data', 
      error: error.message 
    });
  }
};