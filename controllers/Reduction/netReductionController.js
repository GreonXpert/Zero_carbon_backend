  // controllers/netReductionController.js
  const moment = require('moment');
  const csvtojson = require('csvtojson');
  const NetReductionEntry = require('../../models/Reduction/NetReductionEntry');
  const Reduction = require('../../models/Reduction/Reduction');
  const ReductionFormula = require('../../models/Reduction/Formula');
  const { Parser } = require('expr-eval'); 
  const Client = require('../../models/Client');
  const User = require('../../models/User');

// controllers/Reduction/netReductionController.js
const { recomputeClientNetReductionSummary } = require('./netReductionSummaryController');

// --- Socket wiring (copy the pattern from dataCollectionController) ---
let io;
exports.setSocketIO = (socketIO) => { io = socketIO; };

// Emit to both room styles to be backward/forward compatible
function emitNR(eventType, payload) {
  if (!io || !payload?.clientId) return;
  const p = { eventType, timestamp: new Date().toISOString(), ...payload };

  // underscore room (current join code)
  io.to(`client_${payload.clientId}`).emit(eventType, p);
  // hyphen room (legacy)
  io.to(`client-${payload.clientId}`).emit(eventType, p);
}

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
  // Ensure the project exists, methodology matches, and data-entry channel matches this endpoint.
  // Returns an object describing the mode:
  //  - M1: { mode:'m1', doc, rate }
  //  - M2: { mode:'m2', doc, formula }
  async function requireReductionForEntry(clientId, projectId, calculationMethodology, expectedType) {
    const isM1 = calculationMethodology === 'methodology1';
    const selectFields = isM1
      ? 'calculationMethodology m1.emissionReductionRate reductionDataEntry'
      : 'calculationMethodology m2 reductionDataEntry';

    const doc = await Reduction.findOne({ clientId, projectId, isDeleted: false })
      .select(selectFields);

    if (!doc) throw new Error('Reduction project not found');

    if (doc.calculationMethodology !== calculationMethodology) {
      throw new Error(`Methodology mismatch. Project uses ${doc.calculationMethodology}`);
    }

    // channel guard (same for both methodologies)
    const actual = (doc.reductionDataEntry?.inputType || 'manual').toString().toLowerCase();
    const expected = expectedType.toString().toLowerCase(); // 'manual' | 'api' | 'iot'
    if (expected === 'manual' && actual !== 'manual') {
      // CSV normalizes to manual in Reduction model, so CSV uploads expect 'manual' configured
      throw new Error(
        `Wrong data-entry channel for this project. Configured: '${doc.reductionDataEntry?.inputType || 'manual'}', ` +
        `but this endpoint expects '${expectedType.toUpperCase()}'. ` +
        `Update 'reductionDataEntry.inputType' in the Reduction to proceed.`
      );
    }
    if (expected !== 'manual' && actual !== expected) {
      throw new Error(
        `Wrong data-entry channel for this project. Configured: '${doc.reductionDataEntry?.inputType || 'manual'}', ` +
        `but this endpoint expects '${expectedType.toUpperCase()}'. ` +
        `Update 'reductionDataEntry.inputType' in the Reduction to proceed.`
      );
    }

    if (isM1) {
      const rate = Number(doc.m1?.emissionReductionRate || 0);
      if (!isFinite(rate)) throw new Error('emissionReductionRate unavailable');
      return { mode:'m1', doc, rate };
    }

    // M2 path: must have formula attached
    if (!doc.m2?.formulaRef?.formulaId) {
      throw new Error('No formula attached to this reduction (m2.formulaRef.formulaId)');
    }
    const formula = await ReductionFormula.findById(doc.m2.formulaRef.formulaId);
    if (!formula || formula.isDeleted) {
      throw new Error('Formula not found');
    }

    return { mode:'m2', doc, formula };
  }


  function buildM2Context(red, formula, incomingVars = {}) {
    const ctx = {};

    // Seed frozen values from reduction.m2.formulaRef.variables (Map)
    if (red.m2?.formulaRef?.variables) {
      for (const [k, v] of red.m2.formulaRef.variables.entries()) {
        if (v && typeof v.value === 'number') ctx[k] = v.value;
      }
    }
    // Fallback to formula defaults for frozen vars if not present yet
    (formula.variables || []).forEach(v => {
      if (v.kind === 'frozen' && ctx[v.name] == null && typeof v.defaultValue === 'number') {
        ctx[v.name] = v.defaultValue;
      }
    });
    // Apply realtime variables from request body
    (formula.variables || []).forEach(v => {
      if (v.kind === 'realtime' && incomingVars[v.name] != null) {
        ctx[v.name] = Number(incomingVars[v.name]);
      }
    });

    return ctx;
  }

  function evaluateM2(red, formula, incomingVars) {
    const parser = new Parser();
    const expr = parser.parse(formula.expression);

    const ctx = buildM2Context(red, formula, incomingVars);
    const symbols = expr.variables();

    // require all symbols
    for (const s of symbols) {
      if (!(s in ctx)) {
        throw new Error(`Missing variable '${s}' for formula evaluation`);
      }
    }

    const netInFormula = Number(expr.evaluate(ctx)) || 0;
    const LE = Number(red.m2?.LE || 0); // <-- pull LE from Reduction.m2
    const finalNet = Math.round((netInFormula - LE) * 1e6) / 1e6;

    // return LE as well so the endpoints can show it
    return { netInFormula, LE, finalNet };
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

  /**
 * Recompute cumulativeNetReduction / highNetReduction / lowNetReduction
 * for ALL entries in a project+methodology after an update/delete.
 */
async function recomputeProjectCumulative(clientId, projectId, calculationMethodology) {
  const rows = await NetReductionEntry
    .find({ clientId, projectId, calculationMethodology })
    .sort({ timestamp: 1 }) // chronological
    .select('_id netReduction');

  let cum = 0;
  let hi = null;
  let lo = null;
  const ops = [];

  for (const r of rows) {
    const nr = Number(r.netReduction) || 0;
    cum = round6(cum + nr);
    hi = (hi == null) ? nr : Math.max(hi, nr);
    lo = (lo == null) ? nr : Math.min(lo, nr);

    ops.push({
      updateOne: {
        filter: { _id: r._id },
        update: {
          $set: {
            cumulativeNetReduction: cum,
            highNetReduction: hi,
            lowNetReduction: lo
          }
        }
      }
    });
  }

  if (ops.length) await NetReductionEntry.bulkWrite(ops);
}

  /** MANUAL: M1 { value } | M2 { variables:{} } + date?, time? */

  exports.saveManualNetReduction = async (req, res) => {
    try {
      const { clientId, projectId, calculationMethodology } = req.params;
      const can = await canWriteReductionData(req.user, clientId);
      if (!can.ok) return res.status(403).json({ success:false, message: can.reason });

      let ctx;
      try {
        ctx = await requireReductionForEntry(clientId, projectId, calculationMethodology, 'manual');
      } catch (e) {
        return res.status(400).json({ success:false, message: e.message });
      }

      const when = parseDateTimeOrNowIST(req.body.date, req.body.time);

      if (ctx.mode === 'm1') {
        const value = Number(req.body.value);
        if (!isFinite(value)) return res.status(400).json({ success:false, message:'value must be numeric' });

        const entry = await NetReductionEntry.create({
          clientId, projectId, calculationMethodology,
          inputType: 'manual',
          sourceDetails: {
            uploadedBy: req.user._id || req.user.id,
            dataSource: 'manual'
          },
          date: when.date, time: when.time, timestamp: when.timestamp,
          // M1 payload
          inputValue: value,
          emissionReductionRate: ctx.rate
        });
        try { await recomputeClientNetReductionSummary(clientId); } catch (e) { console.warn('summary recompute failed:', e.message); }

        emitNR('net-reduction:manual-saved', {
          clientId, projectId, calculationMethodology,
          mode: 'm1',
          entryId: entry._id,
          date: entry.date, time: entry.time,
          netReduction: entry.netReduction,
          cumulativeNetReduction: entry.cumulativeNetReduction,
          highNetReduction: entry.highNetReduction,
          lowNetReduction: entry.lowNetReduction
        });

        return res.status(201).json({
          success: true,
          message: 'Net reduction saved (manual, m1)',
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
      }

      // ---- M2 path ----
      const incoming = req.body.variables || {};
      try {
        const { netInFormula, LE, finalNet } = evaluateM2(ctx.doc, ctx.formula, incoming);
        const entry = await NetReductionEntry.create({
          clientId, projectId, calculationMethodology,
          // m2 specifics
          formulaId: ctx.formula._id,
          variables: incoming,
          netReductionInFormula: netInFormula,
          netReduction: finalNet,
          // provenance
          inputType: 'manual',
          sourceDetails: {
            uploadedBy: req.user._id || req.user.id,
            dataSource: 'manual'
          },
          // placeholders for m1 fields
          inputValue: 0,
          emissionReductionRate: 0,
          date: when.date, time: when.time, timestamp: when.timestamp
        });
        try { await recomputeClientNetReductionSummary(clientId); } catch (e) { console.warn('summary recompute failed:', e.message); }

         emitNR('net-reduction:manual-saved', {
          clientId, projectId, calculationMethodology,
          mode: 'm2',
          entryId: entry._id,
          date: entry.date, time: entry.time,
          netReductionInFormula: entry.netReductionInFormula,
          netReduction: entry.netReduction,
          cumulativeNetReduction: entry.cumulativeNetReduction,
          highNetReduction: entry.highNetReduction,
          lowNetReduction: entry.lowNetReduction
        });
        return res.status(201).json({
          success: true,
          message: 'Net reduction saved (manual, m2)',
          data: {
            clientId, projectId,
            date: entry.date, time: entry.time,
            variables: entry.variables,
            netReductionInFormula: entry.netReductionInFormula,
            LE, 
            netReduction: entry.netReduction,
            cumulativeNetReduction: entry.cumulativeNetReduction,
            highNetReduction: entry.highNetReduction,
            lowNetReduction: entry.lowNetReduction
          }
        });
      } catch (e) {
        return res.status(400).json({ success:false, message: e.message });
      }
    } catch (err) {
      return res.status(500).json({ success:false, message:'Failed to save net reduction (manual)', error: err.message });
    }
  };


  /** API: M1 { value, apiEndpoint? } | M2 { variables:{}, apiEndpoint? } + date?, time? */
  exports.saveApiNetReduction = async (req, res) => {
    try {
      const { clientId, projectId, calculationMethodology } = req.params;
      const can = await canWriteReductionData(req.user, clientId);
      if (!can.ok) return res.status(403).json({ success:false, message: can.reason });

      let ctx;
      try {
        ctx = await requireReductionForEntry(clientId, projectId, calculationMethodology, 'api');
      } catch (e) {
        return res.status(400).json({ success:false, message: e.message });
      }

      const when = parseDateTimeOrNowIST(req.body.date, req.body.time);
      const apiEndpoint = req.body.apiEndpoint || '';

      if (ctx.mode === 'm1') {
        const value = Number(req.body.value);
        if (!isFinite(value)) return res.status(400).json({ success:false, message:'value must be numeric' });

        const entry = await NetReductionEntry.create({
          clientId, projectId, calculationMethodology,
          inputType: 'API',
          sourceDetails: {
            uploadedBy: req.user._id || req.user.id,
            dataSource: 'API',
            apiEndpoint
          },
          date: when.date, time: when.time, timestamp: when.timestamp,
          inputValue: value,
          emissionReductionRate: ctx.rate
        });
        try { await recomputeClientNetReductionSummary(clientId); } catch (e) { console.warn('summary recompute failed:', e.message); }
       
        emitNR('net-reduction:api-saved', {
          clientId, projectId, calculationMethodology, mode: 'm1',
          entryId: entry._id, date: entry.date, time: entry.time,
          netReduction: entry.netReduction,
          cumulativeNetReduction: entry.cumulativeNetReduction,
          highNetReduction: entry.highNetReduction,
          lowNetReduction: entry.lowNetReduction
        });
        return res.status(201).json({ success: true, message: 'Net reduction saved (API, m1)', data: entry });
      }

      // ---- M2 path ----
      const incoming = req.body.variables || {};
      try {
        const { netInFormula, LE, finalNet } = evaluateM2(ctx.doc, ctx.formula, incoming);
        const entry = await NetReductionEntry.create({
          clientId, projectId, calculationMethodology,
          formulaId: ctx.formula._id,
          variables: incoming,
          netReductionInFormula: netInFormula,
          netReduction: finalNet,
          inputType: 'API',
          sourceDetails: {
            uploadedBy: req.user._id || req.user.id,
            dataSource: 'API',
            apiEndpoint
          },
          inputValue: 0,
          emissionReductionRate: 0,
          date: when.date, time: when.time, timestamp: when.timestamp
        });
        try { await recomputeClientNetReductionSummary(clientId); } catch (e) { console.warn('summary recompute failed:', e.message); }

        emitNR('net-reduction:api-saved', {
          clientId, projectId, calculationMethodology, mode: 'm2',
          entryId: entry._id, date: entry.date, time: entry.time,
          netReductionInFormula: entry.netReductionInFormula,
          netReduction: entry.netReduction,
          cumulativeNetReduction: entry.cumulativeNetReduction,
          highNetReduction: entry.highNetReduction,
          lowNetReduction: entry.lowNetReduction
        });
        

        return res.status(201).json({
    success: true,
    message: 'Net reduction saved (API, m2)',
    data: {
      clientId, projectId,
      date: entry.date, time: entry.time,
      variables: entry.variables,
      netReductionInFormula: entry.netReductionInFormula,
      LE,                         // <-- add this
      netReduction: entry.netReduction,
      cumulativeNetReduction: entry.cumulativeNetReduction,
      highNetReduction: entry.highNetReduction,
      lowNetReduction: entry.lowNetReduction
    }
  });
      } catch (e) {
        return res.status(400).json({ success:false, message: e.message });
      }
    } catch (err) {
      return res.status(500).json({ success:false, message:'Failed to save net reduction (API)', error: err.message });
    }
  };


  /** IOT: M1 { value, deviceId? } | M2 { variables:{}, deviceId? } + date?, time? */
  exports.saveIotNetReduction = async (req, res) => {
    try {
      const { clientId, projectId, calculationMethodology } = req.params;
      const can = await canWriteReductionData(req.user, clientId);
      if (!can.ok) return res.status(403).json({ success:false, message: can.reason });

      let ctx;
      try {
        ctx = await requireReductionForEntry(clientId, projectId, calculationMethodology, 'iot');
      } catch (e) {
        return res.status(400).json({ success:false, message: e.message });
      }

      const when = parseDateTimeOrNowIST(req.body.date, req.body.time);
      const deviceId = req.body.deviceId || '';

      if (ctx.mode === 'm1') {
        const value = Number(req.body.value);
        if (!isFinite(value)) return res.status(400).json({ success:false, message:'value must be numeric' });

        const entry = await NetReductionEntry.create({
          clientId, projectId, calculationMethodology,
          inputType: 'IOT',
          sourceDetails: {
            uploadedBy: req.user._id || req.user.id,
            dataSource: 'IOT',
            iotDeviceId: deviceId
          },
          date: when.date, time: when.time, timestamp: when.timestamp,
          inputValue: value,
          emissionReductionRate: ctx.rate
        });
        try { await recomputeClientNetReductionSummary(clientId); } catch (e) { console.warn('summary recompute failed:', e.message); }

        emitNR('net-reduction:iot-saved', {
          clientId, projectId, calculationMethodology, mode: 'm1',
          entryId: entry._id, date: entry.date, time: entry.time,
          netReduction: entry.netReduction,
          cumulativeNetReduction: entry.cumulativeNetReduction,
          highNetReduction: entry.highNetReduction,
          lowNetReduction: entry.lowNetReduction
        });

        return res.status(201).json({ success: true, message: 'Net reduction saved (IOT, m1)', data: entry });
      }

      // ---- M2 path ----
      const incoming = req.body.variables || {};
      try {
        const { netInFormula, LE, finalNet } = evaluateM2(ctx.doc, ctx.formula, incoming);
        const entry = await NetReductionEntry.create({
          clientId, projectId, calculationMethodology,
          formulaId: ctx.formula._id,
          variables: incoming,
          netReductionInFormula: netInFormula,
          netReduction: finalNet,
          inputType: 'IOT',
          sourceDetails: {
            uploadedBy: req.user._id || req.user.id,
            dataSource: 'IOT',
            iotDeviceId: deviceId
          },
          inputValue: 0,
          emissionReductionRate: 0,
          date: when.date, time: when.time, timestamp: when.timestamp
        });
          try { await recomputeClientNetReductionSummary(clientId); } catch (e) { console.warn('summary recompute failed:', e.message); }
            emitNR('net-reduction:iot-saved', {
              clientId, projectId, calculationMethodology, mode: 'm2',
              entryId: entry._id, date: entry.date, time: entry.time,
              netReductionInFormula: entry.netReductionInFormula,
              netReduction: entry.netReduction,
              cumulativeNetReduction: entry.cumulativeNetReduction,
              highNetReduction: entry.highNetReduction,
              lowNetReduction: entry.lowNetReduction
            });
              
              return res.status(201).json({
          success: true,
          message: 'Net reduction saved (IOT, m2)',
          data: {
            clientId, projectId,
            date: entry.date, time: entry.time,
            variables: entry.variables,
            netReductionInFormula: entry.netReductionInFormula,
            LE,                         // <-- add this
            netReduction: entry.netReduction,
            cumulativeNetReduction: entry.cumulativeNetReduction,
            highNetReduction: entry.highNetReduction,
            lowNetReduction: entry.lowNetReduction
          }
        });
      } catch (e) {
        return res.status(400).json({ success:false, message: e.message });
      }
    } catch (err) {
      return res.status(500).json({ success:false, message:'Failed to save net reduction (IOT)', error: err.message });
    }
  };



  /** CSV: M1 expects columns: value,date?,time?
   *      M2 expects columns named by formula variables (e.g., N,U,SFS,...) and optional date,time
   *      or a 'variables' JSON column. CSV is normalized to manual channel.
   *  multipart/form-data with field name: file
   */
  exports.uploadCsvNetReduction = async (req, res) => {
    try {
      const { clientId, projectId, calculationMethodology } = req.params;
      const can = await canWriteReductionData(req.user, clientId);
      if (!can.ok) return res.status(403).json({ success:false, message: can.reason });

      let ctx;
      try {
        ctx = await requireReductionForEntry(clientId, projectId, calculationMethodology, 'manual'); // CSV→manual
      } catch (e) {
        return res.status(400).json({ success:false, message: e.message });
      }

      if (!req.file) return res.status(400).json({ success:false, message:'No CSV file uploaded' });

      const rows = await csvtojson().fromFile(req.file.path);
      if (!rows?.length) return res.status(400).json({ success:false, message:'CSV empty' });

      const fs = require('fs');
      const saved = [];
      const errors = [];

      if (ctx.mode === 'm1') {
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
            sourceDetails: {
              uploadedBy: req.user._id || req.user.id,
              dataSource: 'CSV',
              fileName: req.file.originalname
            },
            date: when.date, time: when.time, timestamp: when.timestamp,
            inputValue: value,
            emissionReductionRate: ctx.rate
          });
          saved.push(entry);
        }
      } else {
        // ---- M2 CSV path ----
        // Build the list of variable names used by the formula
        const expr = new Parser().parse(ctx.formula.expression);
        const needed = expr.variables(); // array of symbol names

        for (let i=0; i<rows.length; i++) {
          try {
            const r = rows[i];

            // 1) Build incoming variables for this row
            let incoming = {};
            if (r.variables) {
              try { incoming = JSON.parse(r.variables); } catch { /* ignore */ }
            }
            // map columns that match variable names
            needed.forEach(vn => {
              if (r[vn] != null && r[vn] !== '') {
                incoming[vn] = Number(r[vn]);
              }
            });

            // 2) Evaluate formula
            const { netInFormula, LE, finalNet } = evaluateM2(ctx.doc, ctx.formula, incoming);

            // 3) Timestamps
            const when = parseDateTimeOrNowIST(r.date, r.time);

            // 4) Save entry
            const entry = await NetReductionEntry.create({
              clientId, projectId, calculationMethodology,
              formulaId: ctx.formula._id,
              variables: incoming,
              netReductionInFormula: netInFormula,
              netReduction: finalNet,
              inputType: 'CSV',
              sourceDetails: {
                uploadedBy: req.user._id || req.user.id,
                dataSource: 'CSV',
                fileName: req.file.originalname
              },
              inputValue: 0,
              emissionReductionRate: 0,
              date: when.date, time: when.time, timestamp: when.timestamp
            });

            saved.push(entry);
          } catch (rowErr) {
            errors.push({ row: i+1, error: rowErr.message });
          }
        }
      }

      try { fs.unlinkSync(req.file.path); } catch(e){}
      try { await recomputeClientNetReductionSummary(clientId); } catch (e) { console.warn('summary recompute failed:', e.message); }
      
      emitNR('net-reduction:csv-processed', {
        clientId, projectId, calculationMethodology,
        saved: saved.length,
        errors,
        lastSaved: saved[saved.length-1] ? {
          entryId: saved[saved.length-1]._id,
          date: saved[saved.length-1].date,
          time: saved[saved.length-1].time,
          netReductionInFormula: saved[saved.length-1].netReductionInFormula ?? null,
          netReduction: saved[saved.length-1].netReduction,
          cumulativeNetReduction: saved[saved.length-1].cumulativeNetReduction,
          highNetReduction: saved[saved.length-1].highNetReduction,
          lowNetReduction: saved[saved.length-1].lowNetReduction
        } : null
      });

      return res.status(201).json({
    success: true,
    message: 'CSV processed',
    saved: saved.length,
    errors,
    lastSaved: saved[saved.length-1] ? {
      date: saved[saved.length-1].date,
      time: saved[saved.length-1].time,
      netReductionInFormula: saved[saved.length-1].netReductionInFormula, // optional but useful
      LE,                                                                 // <-- add this
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

  /** Methodology-2: body { inputType, variables: {A:..,B:..}, date?, time?, apiEndpoint?, deviceId?, fileName? } */
  exports.saveM2NetReduction = async (req,res)=>{
    try {
      const { clientId, projectId, calculationMethodology } = req.params;
      if (calculationMethodology !== 'methodology2') {
        return res.status(400).json({ success:false, message:'Use methodology2 for this endpoint' });
      }

      // who can write (same policy you used earlier)
      const can = await canWriteReductionData(req.user, clientId);
      if (!can.ok) return res.status(403).json({ success:false, message: can.reason });

      // load reduction & formula
      const red = await Reduction.findOne({ clientId, projectId, isDeleted:false })
        .select('calculationMethodology m2');
      if (!red) return res.status(404).json({ success:false, message:'Reduction not found' });
      if (red.calculationMethodology !== 'methodology2') {
        return res.status(400).json({ success:false, message:`Project uses ${red.calculationMethodology}` });
      }
      if (!red.m2?.formulaRef?.formulaId) {
        return res.status(400).json({ success:false, message:'No formula attached to this reduction (m2.formulaRef.formulaId)' });
      }

      const formula = await ReductionFormula.findById(red.m2.formulaRef.formulaId);
      if (!formula || formula.isDeleted) {
        return res.status(404).json({ success:false, message:'Formula not found' });
      }

      // prepare variable context
      const incoming = req.body.variables || {};
      const ctx = {};

      // 1) seed frozen values from reduction.m2.formulaRef.variables (or variable default)
      if (red.m2.formulaRef.variables) {
        for (const [k, v] of red.m2.formulaRef.variables.entries()) {
          if (v && typeof v.value === 'number') ctx[k] = v.value;
        }
      }
      (formula.variables || []).forEach(v => {
        if (v.kind === 'frozen' && ctx[v.name] == null && typeof v.defaultValue === 'number') {
          ctx[v.name] = v.defaultValue;
        }
      });

      // 2) apply realtime variables from request
      (formula.variables || []).forEach(v => {
        if (v.kind === 'realtime') {
          if (incoming[v.name] == null) {
            // allow missing to be 0 or reject — here we enforce presence
            return;
          }
          ctx[v.name] = Number(incoming[v.name]);
        }
      });

      // sanity: all symbols used in expression must exist
      const parser = new Parser();
      const expr = parser.parse(formula.expression);
      const symbols = expr.variables();
      for (const s of symbols) {
        if (!(s in ctx)) {
          return res.status(400).json({ success:false, message:`Missing variable '${s}' for formula evaluation` });
        }
      }

      // evaluate
      const netInFormula = Number(expr.evaluate(ctx)) || 0;
      const LE = Number(red.m2?.LE || 0);
      const finalNet = Math.round((netInFormula - LE) * 1e6) / 1e6;

      // timestamps & source meta
      const when = parseDateTimeOrNowIST(req.body.date, req.body.time);
      const inputType = (req.body.inputType || 'manual').toString();

      const entry = await NetReductionEntry.create({
        clientId, projectId, calculationMethodology,
        // m2-specific fields
        formulaId: formula._id,
        variables: incoming,
        netReductionInFormula: netInFormula,

        // common provenance
        inputType,
        sourceDetails: {
          uploadedBy: req.user._id || req.user.id,
          dataSource: inputType.toUpperCase(),
          apiEndpoint: req.body.apiEndpoint || '',
          iotDeviceId: req.body.deviceId || '',
          fileName: req.body.fileName || ''
        },

        // we set the final netReduction directly for m2
        netReduction: finalNet,

        // placeholders to keep schema happy for m1 fields
        inputValue: 0,
        emissionReductionRate: 0,

        date: when.date,
        time: when.time,
        timestamp: when.timestamp
      });
      try { await recomputeClientNetReductionSummary(clientId); } catch (e) { console.warn('summary recompute failed:', e.message); }

            emitNR('net-reduction:iot-saved', {
        clientId, projectId, calculationMethodology, mode: 'm2',
        entryId: entry._id, date: entry.date, time: entry.time,
        netReductionInFormula: entry.netReductionInFormula,
        netReduction: entry.netReduction,
        cumulativeNetReduction: entry.cumulativeNetReduction,
        highNetReduction: entry.highNetReduction,
        lowNetReduction: entry.lowNetReduction
      });
      res.status(201).json({
        success:true,
        message:'Net reduction saved (m2, formula)',
        data:{
          clientId, projectId,
          date: entry.date, time: entry.time,
          variables: entry.variables,
          netReductionInFormula: entry.netReductionInFormula,
          LE,
          netReduction: entry.netReduction,
          cumulativeNetReduction: entry.cumulativeNetReduction,
          highNetReduction: entry.highNetReduction,
          lowNetReduction: entry.lowNetReduction
        }
      });
    } catch(e){
      res.status(500).json({ success:false, message:'Failed to save m2 net reduction', error: e.message });
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




  exports.listNetReductions = async (req, res) => {
    try {
      const user = req.user;
      if (!user) return res.status(401).json({ success:false, message: 'Unauthenticated' });

      // ✅ Allow super_admin, consultant_admin, consultant, client_admin
      const ALLOWED = ['super_admin','consultant_admin','consultant','client_admin'];
      if (!ALLOWED.includes(user.userType)) {
        return res.status(403).json({ success:false, message: 'Forbidden' });
      }

      const {
        clientId: clientIdParam,
        projectId,
        methodology,         // 'methodology1' | 'methodology2'
        inputType,           // 'manual' | 'API' | 'IOT' | 'CSV'
        from, to,            // date range (timestamp)
        q,                   // free-text search (clientId/projectId)
        minNet, maxNet,      // numeric filter on netReduction
        page = 1,
        limit = 20,
        sortBy = 'timestamp',
        sortOrder = 'desc'
      } = req.query;

      // ---- Access scope: which clientIds are allowed for this user ----
      let allowedClientIds = null; // null === all (super_admin)
      if (user.userType === 'super_admin') {
        allowedClientIds = null; // all clients
      } else if (user.userType === 'client_admin') {
        // ✅ client_admin can ONLY see their own client
        if (!user.clientId) {
          return res.status(400).json({ success:false, message:'Your account has no clientId bound' });
        }
        allowedClientIds = [user.clientId];
      } else if (user.userType === 'consultant_admin') {
        const created = await Client.find({ 'leadInfo.createdBy': user.id }).select('clientId');
        allowedClientIds = created.map(c => c.clientId);
      } else if (user.userType === 'consultant') {
        const assigned = await Client.find({ 'leadInfo.assignedConsultantId': user.id }).select('clientId');
        allowedClientIds = assigned.map(c => c.clientId);
      }

      // ---- Build filter ----
      const filter = {};

      // Client scoping
      if (clientIdParam) {
        // If restricted, enforce membership
        if (allowedClientIds && !allowedClientIds.includes(clientIdParam)) {
          return res.status(403).json({ success:false, message:'Permission denied for this clientId' });
        }
        filter.clientId = clientIdParam;
      } else if (allowedClientIds) {
        // If user is restricted and no clientId was specified, scope to theirs
        filter.clientId = { $in: allowedClientIds };
      }
      // (super_admin with no clientIdParam => all clients)

      // Project filter (case-insensitive contains)
      if (projectId) {
        const esc = projectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.projectId = { $regex: new RegExp(esc, 'i') };
      }

      if (methodology) filter.calculationMethodology = methodology;
      if (inputType)   filter.inputType = inputType;

      // Free-text search across clientId + projectId
      if (q && q.trim()) {
        const rx = { $regex: q.trim(), $options: 'i' };
        filter.$or = [{ clientId: rx }, { projectId: rx }];
      }

      // Date range on timestamp
      const parseDate = (raw) => {
        if (!raw) return null;
        const m = moment(raw, ['DD/MM/YYYY','YYYY-MM-DD','YYYY-MM-DDTHH:mm:ss.SSSZ'], true);
        return m.isValid() ? m.toDate() : null;
      };
      const fromDate = parseDate(from);
      const toDate   = parseDate(to);
      if (fromDate || toDate) {
        filter.timestamp = {};
        if (fromDate) filter.timestamp.$gte = fromDate;
        if (toDate)   filter.timestamp.$lte = toDate;
      }

      // Numeric filter on netReduction
      const minNR = Number(minNet);
      const maxNR = Number(maxNet);
      if (isFinite(minNR) || isFinite(maxNR)) {
        filter.netReduction = {};
        if (isFinite(minNR)) filter.netReduction.$gte = minNR;
        if (isFinite(maxNR)) filter.netReduction.$lte = maxNR;
      }

      // ---- Pagination / sorting ----
      const pageNum  = Math.max(1, parseInt(page, 10) || 1);
      const limNum   = Math.min(200, Math.max(1, parseInt(limit, 10) || 20));
      const skip     = (pageNum - 1) * limNum;
      const sort     = { [sortBy]: (String(sortOrder).toLowerCase() === 'asc') ? 1 : -1 };

      const [total, rows] = await Promise.all([
        NetReductionEntry.countDocuments(filter),
        NetReductionEntry.find(filter)
          .sort(sort)
          .skip(skip)
          .limit(limNum)
          .select('-__v')
          .lean()
      ]);

      return res.status(200).json({
        success: true,
        meta: {
          page: pageNum,
          limit: limNum,
          total,
          totalPages: Math.ceil(total / limNum),
          hasNextPage: pageNum < Math.ceil(total / limNum),
          hasPrevPage: pageNum > 1
        },
        filter,
        data: rows
      });
    } catch (err) {
      console.error('listNetReductions error:', err);
      return res.status(500).json({ success:false, message:'Failed to fetch net reductions', error: err.message });
    }
  };


  // --- ADD THIS HELPER NEAR THE TOP (below other helpers) ---
function round6(n){ return Math.round((Number(n)||0)*1e6)/1e6; }

/**
 * Recompute cumulativeNetReduction, highNetReduction, lowNetReduction
 * for the entire (clientId, projectId, methodology) series.
 * Does not change per-entry netReduction — only cumulative/high/low.
 */
async function recomputeSeries(clientId, projectId, calculationMethodology) {
  const rows = await NetReductionEntry.find({
    clientId, projectId, calculationMethodology
  }).sort({ timestamp: 1 }).select('_id netReduction');

  let cum = 0;
  let high = null;
  let low  = null;
  const ops = [];

  for (const r of rows) {
    const nr = Number(r.netReduction || 0);
    cum = round6(cum + nr);
    high = (high === null) ? nr : Math.max(high, nr);
    low  = (low === null)  ? nr : Math.min(low, nr);

    ops.push({
      updateOne: {
        filter: { _id: r._id },
        update: {
          $set: {
            cumulativeNetReduction: cum,
            highNetReduction: high,
            lowNetReduction: low
          }
        }
      }
    });
  }

  if (ops.length) await NetReductionEntry.bulkWrite(ops);
  return { count: rows.length, cumulative: cum, high, low };
}

// --- ADD THIS EXPORT ---
/**
 * Edit a MANUAL net-reduction entry.
 * Route (suggested):
 *   PATCH /net-reduction/:clientId/:projectId/:calculationMethodology/manual/:entryId
 *
 * Body (m1):
 *   { "value": 123.45, "date": "14/08/2025", "time": "11:00", "recalcRateFromProject": false }
 * Body (m2):
 *   { "variables": { "N": 12000, "U": 0.83 }, "date": "14/08/2025", "time": "11:05" }
 */
exports.updateManualNetReductionEntry = async (req, res) => {
  try {
    const { clientId, projectId, calculationMethodology, entryId } = req.params;

    // permission
    const can = await canWriteReductionData(req.user, clientId);
    if (!can.ok) return res.status(403).json({ success:false, message: can.reason });

    // must exist & be manual
    const entry = await NetReductionEntry.findOne({ _id: entryId, clientId, projectId, calculationMethodology });
    if (!entry) return res.status(404).json({ success:false, message: 'Entry not found' });
    if ((entry.inputType || '').toLowerCase() !== 'manual') {
      return res.status(400).json({ success:false, message: 'Only manual entries can be edited with this endpoint' });
    }

    // Ensure the project & channel are valid (and load formula for m2)
    let ctx;
    try {
      ctx = await requireReductionForEntry(clientId, projectId, calculationMethodology, 'manual');
    } catch (e) {
      return res.status(400).json({ success:false, message: e.message });
    }

    // If date/time provided, rebuild timestamp in IST
    const hasDateOrTime = (req.body.date != null) || (req.body.time != null);
    if (hasDateOrTime) {
      const when = parseDateTimeOrNowIST(req.body.date || entry.date, req.body.time || entry.time);
      entry.date = when.date;
      entry.time = when.time;
      entry.timestamp = when.timestamp;
    }

    if (ctx.mode === 'm1') {
      // Optional: update inputValue
      if (req.body.value != null) {
        const v = Number(req.body.value);
        if (!isFinite(v)) return res.status(400).json({ success:false, message: 'value must be numeric' });
        entry.inputValue = v;
      }
      // Optional: let the user re-snapshot the current ER rate from project
      if (req.body.recalcRateFromProject) {
        entry.emissionReductionRate = ctx.rate; // current project snapshot
      }
      // For m1, netReduction will be recomputed by pre('save')
      await entry.save();
    } else {
      // M2: update variables (merge or replace; here we replace if provided)
      if (req.body.variables && typeof req.body.variables === 'object') {
        entry.variables = req.body.variables;
      }

      // Re-evaluate using current formula + Reduction.m2.LE
      try {
        const { netInFormula, LE, finalNet } = evaluateM2(ctx.doc, ctx.formula, entry.variables || {});
        entry.formulaId = ctx.formula._id;
        entry.netReductionInFormula = netInFormula;
        entry.netReduction = finalNet;
        // Keep placeholders consistent for schema
        entry.inputValue = 0;
        entry.emissionReductionRate = 0;
      } catch (e) {
        return res.status(400).json({ success:false, message: e.message });
      }

      await entry.save({ validateBeforeSave: false });
    }

    // After changing an entry (could be in the past) — recompute the whole series
    const summary = await recomputeSeries(clientId, projectId, calculationMethodology);
    try { await recomputeClientNetReductionSummary(clientId); } catch (e) { console.warn('summary recompute failed:', e.message); }

    // Return the freshly-saved entry
    const fresh = await NetReductionEntry.findById(entry._id).lean();

        emitNR('net-reduction:manual-updated', {
          clientId, projectId, calculationMethodology,
          entryId: fresh._id, date: fresh.date, time: fresh.time,
          netReductionInFormula: fresh.netReductionInFormula ?? null,
          netReduction: fresh.netReduction,
          cumulativeNetReduction: fresh.cumulativeNetReduction,
          highNetReduction: fresh.highNetReduction,
          lowNetReduction: fresh.lowNetReduction
        });

    return res.status(200).json({
      success: true,
      message: 'Manual entry updated and series recomputed',
      series: summary,
      data: fresh
    });
  } catch (err) {
    return res.status(500).json({ success:false, message: 'Failed to update manual net reduction entry', error: err.message });
  }
};


// --- ADD THIS EXPORT ---
/**
 * Delete a MANUAL net-reduction entry and recompute the series.
 * Route (suggested):
 *   DELETE /net-reduction/:clientId/:projectId/:calculationMethodology/manual/:entryId
 */
exports.deleteManualNetReductionEntry = async (req, res) => {
  try {
    const { clientId, projectId, calculationMethodology, entryId } = req.params;

    // permission
    const can = await canWriteReductionData(req.user, clientId);
    if (!can.ok) return res.status(403).json({ success:false, message: can.reason });

    const entry = await NetReductionEntry.findOne({ _id: entryId, clientId, projectId, calculationMethodology });
    if (!entry) return res.status(404).json({ success:false, message: 'Entry not found' });
    if ((entry.inputType || '').toLowerCase() !== 'manual') {
      return res.status(400).json({ success:false, message: 'Only manual entries can be deleted with this endpoint' });
    }

    await NetReductionEntry.deleteOne({ _id: entry._id });

    const summary = await recomputeSeries(clientId, projectId, calculationMethodology);
    try { await recomputeClientNetReductionSummary(clientId); } catch (e) { console.warn('summary recompute failed:', e.message); }
    emitNR('net-reduction:manual-deleted', { clientId, projectId, calculationMethodology, entryId });
    return res.status(200).json({
      success: true,
      message: 'Manual entry deleted and series recomputed',
      series: summary
    });
  } catch (err) {
    return res.status(500).json({ success:false, message: 'Failed to delete manual net reduction entry', error: err.message });
  }
};
