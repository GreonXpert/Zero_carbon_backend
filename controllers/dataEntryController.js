// controllers/dataEntryController.js

const DataEntry = require('../models/DataEntry');
const Flowchart = require('../models/Flowchart');
const {
  calculateAndSaveEmission
} = require('./CalculateEmissionCO2eController');

exports.createDataEntry = async (req, res) => {
  try {
    console.log('⏺ [createDataEntry] params:', req.params);
    console.log('⏺ [createDataEntry] body:  ', req.body);

    const { userId, nodeId } = req.params;
    let {
      date,
      time,
      quantity,
      assessmentType = '',
      uncertaintyLevelConsumedData = 0,
      uncertaintyLevelEmissionFactor = 0,
      comments = '',
      fuelSupplier = '',
      periodOfDate,
      startDate,
      scopeIndex
    } = req.body;

    // 1️⃣ Basic validation
    if (!userId || !nodeId) {
      return res.status(400).json({
        message: 'Both userId and nodeId are required in URL.'
      });
    }
    if (!date || !time || quantity == null) {
      return res.status(400).json({
        message: 'Fields date, time and quantity are required.'
      });
    }

    // 2️⃣ Load flowchart & verify node exists
    const flowchart = await Flowchart.findOne({ userId });
    if (!flowchart) {
      return res.status(400).json({ message: 'No flowchart found for this user.' });
    }
    const nodeConfig = flowchart.nodes.find(n => n.id === nodeId);
    if (!nodeConfig) {
      return res.status(400).json({
        message: `Node "${nodeId}" not in flowchart.`
      });
    }

    const apiOn = !!nodeConfig.details?.apiStatus;
    console.log('⏺ [createDataEntry] API mode ON?', apiOn);

    // 3️⃣ If API mode is ON, trigger emission calculation first
    if (apiOn) {
      // inject the fields that calculateAndSaveEmission expects
      req.body.consumedData                   = quantity;
      req.body.userId                         = userId;
      req.body.nodeId                         = nodeId;
      req.body.startDate                      = startDate || date;
      req.body.periodOfDate                   = periodOfDate || 'daily';
      req.body.assessmentType                 = assessmentType;
      req.body.uncertaintyLevelConsumedData   = uncertaintyLevelConsumedData;
      req.body.uncertaintyLevelEmissionFactor = uncertaintyLevelEmissionFactor;
      req.body.comments                       = comments;
      req.body.fuelSupplier                   = fuelSupplier;
      if (scopeIndex != null) {
        req.body.scopeIndex = scopeIndex;
      }

      // dummy res to catch calculateAndSaveEmission’s status/json
      let calcStatus = 200, calcPayload = null;
      const dummyRes = {
        status(code) { calcStatus = code; return this; },
        json(payload) { calcPayload = payload; return this; }
      };

      await calculateAndSaveEmission(req, dummyRes);

      console.log('   ↳ [calc] status=', calcStatus, 'payload=', calcPayload);
      if (calcStatus >= 400) {
        // forward calculation error to client
        return res.status(calcStatus).json(calcPayload);
      }
    }

    // 4️⃣ Save the raw DataEntry
    const entry = new DataEntry({
      userId,
      nodeId,
      date: new Date(date),
      time,
      quantity,
      assessmentType,
      uncertaintyLevelConsumedData,
      uncertaintyLevelEmissionFactor,
      comments,
      fuelSupplier
    });
    await entry.save();

    console.log('✅ [createDataEntry] saved entry', entry._id);
    return res.status(201).json(entry);

  } catch (err) {
    console.error('❌ [createDataEntry] error:', err);
    return res.status(500).json({
      message: 'Server error in createDataEntry.',
      error: err.message
    });
  }
};




/**
 * GET /api/data-entry/:companyName
 * Returns all entries for the given companyName
 */
exports.getDataByUserNode = async (req, res) => {
    try {
      const { userId, nodeId } = req.params;
      if (!userId || !nodeId) {
        return res.status(400).json({ message: 'Both userId and nodeId are required in URL.' });
      }
  
      const entries = await DataEntry
        .find({ userId, nodeId })
        .sort({ date: -1, time: 1 }); // newest date first, then time
  
      return res.json(entries);
    } catch (err) {
      console.error('Error fetching DataEntry:', err);
      return res.status(500).json({ message: 'Server error.' });
    }
  }