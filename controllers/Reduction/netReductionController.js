// controllers/netReductionController.js
const moment = require('moment');
const csvtojson = require('csvtojson');
const NetReductionEntry = require('../../models/Reduction/NetReductionEntry');
const Reduction = require('../../models/Reduction/Reduction');
const Client = require('../../models/Client');
const User = require('../../models/User');

// --- permissions: only creator consultant_admin OR assigned consultant can write ---

async function canWriteReductionData(user, clientId) {
  if (!user) return { ok:false, reason:'Unauthenticated' };

  // 1) Client-side users from the same client can enter data
  // (restrict to roles allowed to write; exclude viewer/auditor)
  const clientWriteRoles = ['client_admin', 'client_employee_head', 'employee'];
  if (clientWriteRoles.includes(user.userType) && user.clientId === clientId) {
    return { ok: true };
  }

  // 2) consultant_admin who created the lead
  if (user.userType === 'consultant_admin') {
    const client = await Client.findOne({ clientId })
      .select('leadInfo.createdBy');
    if (!client) return { ok:false, reason:'Client not found' };
    if (client.leadInfo?.createdBy?.toString() === (user._id || user.id).toString()) {
      return { ok: true };
    }
    return { ok:false, reason:'Only creator consultant_admin can write' };
  }

  // 3) consultant assigned to this client
  if (user.userType === 'consultant') {
    const client = await Client.findOne({ clientId })
      .select('leadInfo.assignedConsultantId');
    if (!client) return { ok:false, reason:'Client not found' };
    if (client.leadInfo?.assignedConsultantId?.toString() === (user._id || user.id).toString()) {
      return { ok: true };
    }
    return { ok:false, reason:'Consultant not assigned to this client' };
  }

  return { ok:false, reason:'Forbidden' };
}
// Ensure the project exists, methodology matches, and data-entry channel matches this endpoint.
// Returns { doc, rate } with emissionReductionRate snapshot.
async function requireReductionForEntry(clientId, projectId, calculationMethodology, expectedType) {
  const doc = await Reduction.findOne({ clientId, projectId, isDeleted: false })
    .select('calculationMethodology m1.emissionReductionRate reductionDataEntry');

  if (!doc) throw new Error('Reduction project not found');

  if (doc.calculationMethodology !== calculationMethodology) {
    throw new Error(`Methodology mismatch. Project uses ${doc.calculationMethodology}`);
  }

  // Only methodology1 supported for now (as per your code)
  if (calculationMethodology !== 'methodology1') {
    throw new Error('Selected methodology not supported yet for net reduction');
  }

  const rate = Number(doc.m1?.emissionReductionRate || 0);
  if (!isFinite(rate)) {
    throw new Error('emissionReductionRate unavailable');
  }

  const actual = (doc.reductionDataEntry?.inputType || 'manual').toString().toLowerCase();
  const expected = expectedType.toString().toLowerCase(); // 'manual' | 'api' | 'iot'
  if (actual !== expected) {
    throw new Error(
      `Wrong data-entry channel for this project. Configured: '${doc.reductionDataEntry?.inputType || 'manual'}', ` +
      `but this endpoint expects '${expectedType.toUpperCase()}'. ` +
      `Update 'reductionDataEntry.inputType' in the Reduction to proceed.`
    );
  }

  return { doc, rate };
}




function parseDateTimeOrNowIST(rawDate, rawTime) {
  // Accept either provided or default IST now; enforce "DD/MM/YYYY" and "HH:mm"
  const now = moment().utcOffset('+05:30');
  let mDate = rawDate ? moment(rawDate, ['DD/MM/YYYY', 'YYYY-MM-DD'], true) : now;
  if (!mDate.isValid()) mDate = now;

  let mTime = rawTime ? moment(rawTime, ['HH:mm','HH:mm:ss'], true) : now;
  if (!mTime.isValid()) mTime = now;

  const date = mDate.format('DD/MM/YYYY');
  const time = mTime.format('HH:mm');
  const ts = moment(`${date} ${time}`, 'DD/MM/YYYY HH:mm', true).toDate();
  return { date, time, timestamp: ts };
}

async function getRate(clientId, projectId, calculationMethodology) {
  const doc = await Reduction.findOne({ clientId, projectId, isDeleted:false }).select('calculationMethodology m1.emissionReductionRate');
  if (!doc) throw new Error('Reduction project not found');
  if (doc.calculationMethodology !== calculationMethodology) {
    throw new Error(`Methodology mismatch. Project uses ${doc.calculationMethodology}`);
  }
  if (calculationMethodology === 'methodology1') {
    const rate = Number(doc.m1?.emissionReductionRate || 0);
    if (!isFinite(rate)) throw new Error('emissionReductionRate unavailable');
    return rate;
  }
  // extend here for methodology2 once you define its rate
  throw new Error('Selected methodology not supported yet for net reduction');
}

function makeEntryBase(req, rate, extraSource={}) {
  const { clientId, projectId, calculationMethodology } = req.params;
  const { date, time } = req.body;
  const when = parseDateTimeOrNowIST(date, time);
  return {
    clientId,
    projectId,
    calculationMethodology,
    emissionReductionRate: rate,
    date: when.date,
    time: when.time,
    timestamp: when.timestamp,
    sourceDetails: {
      uploadedBy: req.user._id || req.user.id,
      dataSource: extraSource.dataSource,
      apiEndpoint: extraSource.apiEndpoint,
      iotDeviceId: extraSource.iotDeviceId,
      fileName: extraSource.fileName
    }
  };
}

/** MANUAL: body { value, date?, time? } */
exports.saveManualNetReduction = async (req, res) => {
  try {
    const { clientId, projectId, calculationMethodology } = req.params;
    const can = await canWriteReductionData(req.user, clientId);
    if (!can.ok) return res.status(403).json({ success:false, message: can.reason });

    // ⬇️ Enforce manual channel and get rate
    let rate;
    try {
      ({ rate } = await requireReductionForEntry(clientId, projectId, calculationMethodology, 'manual'));
    } catch (e) {
      return res.status(400).json({ success:false, message: e.message });
    }

    const value = Number(req.body.value);
    if (!isFinite(value)) return res.status(400).json({ success:false, message:'value must be numeric' });

    const base = makeEntryBase(req, rate, { dataSource: 'manual' });
    const entry = await NetReductionEntry.create({
      ...base,
      inputType: 'manual',
      inputValue: value
    });

    return res.status(201).json({
      success: true,
      message: 'Net reduction saved (manual)',
      data: {
        clientId, projectId,
        date: entry.date, time: entry.time,
        inputValue: entry.inputValue,
        emissionReductionRate: entry.emissionReductionRate,
        netReduction: entry.netReduction,
        cumulativeNetReduction: entry.cumulativeNetReduction,
        highNetReduction: entry.highNetReduction,
        lowNetReduction: entry.lowNetReduction
      }
    });
  } catch (err) {
    return res.status(500).json({ success:false, message:'Failed to save net reduction (manual)', error: err.message });
  }
};

/** API: body { value, date?, time?, apiEndpoint? } */
exports.saveApiNetReduction = async (req, res) => {
  try {
    const { clientId, projectId, calculationMethodology } = req.params;
    const can = await canWriteReductionData(req.user, clientId);
    if (!can.ok) return res.status(403).json({ success:false, message: can.reason });

    // ⬇️ Enforce API channel and get rate
    let rate;
    try {
      ({ rate } = await requireReductionForEntry(clientId, projectId, calculationMethodology, 'api'));
    } catch (e) {
      return res.status(400).json({ success:false, message: e.message });
    }

    const value = Number(req.body.value);
    if (!isFinite(value)) return res.status(400).json({ success:false, message:'value must be numeric' });

    const base = makeEntryBase(req, rate, { dataSource:'API', apiEndpoint: req.body.apiEndpoint || '' });
    const entry = await NetReductionEntry.create({
      ...base,
      inputType: 'API',
      inputValue: value
    });

    return res.status(201).json({
      success: true,
      message: 'Net reduction saved (API)',
      data: {
        clientId, projectId,
        date: entry.date, time: entry.time,
        inputValue: entry.inputValue,
        emissionReductionRate: entry.emissionReductionRate,
        netReduction: entry.netReduction,
        cumulativeNetReduction: entry.cumulativeNetReduction,
        highNetReduction: entry.highNetReduction,
        lowNetReduction: entry.lowNetReduction
      }
    });
  } catch (err) {
    return res.status(500).json({ success:false, message:'Failed to save net reduction (API)', error: err.message });
  }
};


/** IOT: body { value, date?, time?, deviceId? } */
exports.saveIotNetReduction = async (req, res) => {
  try {
    const { clientId, projectId, calculationMethodology } = req.params;
    const can = await canWriteReductionData(req.user, clientId);
    if (!can.ok) return res.status(403).json({ success:false, message: can.reason });

    // ⬇️ Enforce IOT channel and get rate
    let rate;
    try {
      ({ rate } = await requireReductionForEntry(clientId, projectId, calculationMethodology, 'iot'));
    } catch (e) {
      return res.status(400).json({ success:false, message: e.message });
    }

    const value = Number(req.body.value);
    if (!isFinite(value)) return res.status(400).json({ success:false, message:'value must be numeric' });

    const base = makeEntryBase(req, rate, { dataSource:'IOT', iotDeviceId: req.body.deviceId || '' });
    const entry = await NetReductionEntry.create({
      ...base,
      inputType: 'IOT',
      inputValue: value
    });

    return res.status(201).json({
      success: true,
      message: 'Net reduction saved (IOT)',
      data: {
        clientId, projectId,
        date: entry.date, time: entry.time,
        inputValue: entry.inputValue,
        emissionReductionRate: entry.emissionReductionRate,
        netReduction: entry.netReduction,
        cumulativeNetReduction: entry.cumulativeNetReduction,
        highNetReduction: entry.highNetReduction,
        lowNetReduction: entry.lowNetReduction
      }
    });
  } catch (err) {
    return res.status(500).json({ success:false, message:'Failed to save net reduction (IOT)', error: err.message });
  }
};


/** CSV: upload a file with columns: value, date(optional), time(optional)
 *  multipart/form-data with field name: file
 */
exports.uploadCsvNetReduction = async (req, res) => {
  try {
    const { clientId, projectId, calculationMethodology } = req.params;
    const can = await canWriteReductionData(req.user, clientId);
    if (!can.ok) return res.status(403).json({ success:false, message: can.reason });

    // ⬇️ Enforce MANUAL channel (CSV is normalized to manual)
    let rate;
    try {
      ({ rate } = await requireReductionForEntry(clientId, projectId, calculationMethodology, 'manual'));
    } catch (e) {
      return res.status(400).json({ success:false, message: e.message });
    }

    if (!req.file) return res.status(400).json({ success:false, message:'No CSV file uploaded' });

    const rows = await csvtojson().fromFile(req.file.path);
    if (!rows?.length) return res.status(400).json({ success:false, message:'CSV empty' });

    const fs = require('fs');
    const saved = [];
    const errors = [];
    for (let i=0; i<rows.length; i++) {
      const r = rows[i];
      const value = Number(r.value);
      if (!isFinite(value)) {
        errors.push({ row: i+1, error: 'value must be numeric' });
        continue;
      }
      const when = parseDateTimeOrNowIST(r.date, r.time);
      const entry = await NetReductionEntry.create({
        clientId, projectId, calculationMethodology,
        inputType: 'CSV',
        inputValue: value,
        emissionReductionRate: rate,
        date: when.date,
        time: when.time,
        timestamp: when.timestamp,
        sourceDetails: {
          uploadedBy: req.user._id || req.user.id,
          dataSource: 'CSV',
          fileName: req.file.originalname
        }
      });
      saved.push(entry);
    }
    try { require('fs').unlinkSync(req.file.path); } catch(e){}

    return res.status(201).json({
      success: true,
      message: 'CSV processed',
      saved: saved.length,
      errors,
      lastSaved: saved[saved.length-1] ? {
        date: saved[saved.length-1].date,
        time: saved[saved.length-1].time,
        netReduction: saved[saved.length-1].netReduction,
        cumulativeNetReduction: saved[saved.length-1].cumulativeNetReduction,
        highNetReduction: saved[saved.length-1].highNetReduction,
        lowNetReduction: saved[saved.length-1].lowNetReduction
      } : null
    });
  } catch (err) {
    return res.status(500).json({ success:false, message:'Failed to upload CSV net reduction', error: err.message });
  }
};


/** Optional: quick stats */
exports.getNetReductionStats = async (req, res) => {
  try {
    const { clientId, projectId, calculationMethodology } = req.params;
    const latest = await NetReductionEntry.findOne({ clientId, projectId, calculationMethodology })
      .sort({ timestamp: -1 })
      .select('cumulativeNetReduction highNetReduction lowNetReduction date time');
    if (!latest) return res.status(404).json({ success:false, message:'No net reduction data' });
    res.status(200).json({ success:true, data: latest });
  } catch (err) {
    res.status(500).json({ success:false, message:'Failed to fetch net reduction stats', error: err.message });
  }
};
