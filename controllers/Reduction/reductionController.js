// controllers/reductionController.js
const Reduction = require('../../models/Reduction/Reduction');
const Client = require('../../models/Client');
const User = require('../../models/User');
const { canManageFlowchart } = require("../../utils/Permissions/permissions");
const { notifyReductionEvent } = require('../../utils/notifications/reductionNotifications');
const { syncReductionWorkflow } = require('../../utils/Workflow/workflow');
const { syncClientReductionProjects } = require('../../utils/Workflow/syncReductionProjects'); // <-- ADD THIS LINE
const { uploadReductionMedia, saveReductionFiles } = require('../../utils/uploads/reductionUpload');




/** Permission: consultant_admin who created the lead OR assigned consultant */
async function canCreateOrEdit(user, clientId) {
  if (!user) return { ok: false, reason: 'Unauthenticated' };
  if (!['consultant_admin', 'consultant'].includes(user.userType)) {
    return { ok: false, reason: 'Only consultants/consultant_admins' };
  }

  const client = await Client.findOne({ clientId }).select('leadInfo.createdBy leadInfo.assignedConsultantId');
  if (!client) return { ok: false, reason: 'Client not found' };

  if (user.userType === 'consultant_admin') {
    if (client.leadInfo?.createdBy?.toString() === user.id.toString()) return { ok: true };
    return { ok: false, reason: 'Only creator consultant_admin can manage' };
  }

  if (user.userType === 'consultant') {
    if (client.leadInfo?.assignedConsultantId?.toString() === user.id.toString()) return { ok: true };
    return { ok: false, reason: 'Consultant not assigned to this client' };
  }

  return { ok: false, reason: 'Forbidden' };
}
function escapeRegex(str='') {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function pick(obj, keys) {
  const out = {};
  keys.forEach(k => { if (obj && obj[k] != null) out[k] = obj[k]; });
  return out;
}
// Accept both reductionDataEntry and reductionDateEntry (typo-safe)
function readReductionEntryFromBody(body) {
  return body?.reductionDataEntry ?? body?.reductionDateEntry ?? {};
}

function normalizeReductionDataEntry(raw = {}) {
  const typeRaw = (raw.inputType || raw.originalInputType || raw.type || 'manual').toString().toLowerCase();
  const apiEndpoint = raw.apiEndpoint || raw.api || raw.endpoint || '';
  const iotDeviceId = raw.iotDeviceId || raw.deviceId || '';

  if (typeRaw === 'csv') {
    return {
      originalInputType: 'CSV',
      inputType: 'manual',
      apiEndpoint: '',
      iotDeviceId: ''
    };
  }
  if (typeRaw === 'api') {
    // No validation error here; model will auto-fill correct endpoint
    return {
      originalInputType: 'API',
      inputType: 'API',
      apiEndpoint, // may be '', will be overwritten in model pre('validate')
      iotDeviceId: ''
    };
  }
  if (typeRaw === 'iot') {
    // No validation error here; model will auto-fill correct endpoint
    return {
      originalInputType: 'IOT',
      inputType: 'IOT',
      apiEndpoint, // will be overwritten in model pre('validate') with .../iot
      iotDeviceId
    };
  }
  // manual (default)
  return {
    originalInputType: 'manual',
    inputType: 'manual',
    apiEndpoint: '',
    iotDeviceId: ''
  };
}



function normalizeM2FromBody(raw = {}) {
  const out = {};

  // ALD (same shape as M1 items)
  if (Array.isArray(raw.ALD)) {
    out.ALD = raw.ALD.map(normalizeUnitItem('L'));
  }

  // accept { m2: { formulaRef:{...} } } or flattened { m2:{ formulaId, version, ... } }
  const ref = raw.formulaRef || {};
  const formulaId = ref.formulaId || raw.formulaId;
  const version   = ref.version != null ? Number(ref.version)
                    : (raw.version != null ? Number(raw.version) : undefined);

  // ---- (A) variableKinds: { U:'frozen', fNRB:'realtime', ... }
  const incomingKinds = ref.variableKinds || raw.variableKinds || {};
  // normalize to plain object with safe values ('frozen'|'realtime'|'manual')
  const kindsObj = {};
  for (const [k, v] of Object.entries(incomingKinds)) {
    const role = String(v || '').toLowerCase();
    if (role) {
      // only allow expected roles; model will re-check as well
      kindsObj[k] = (role === 'frozen' || role === 'realtime' || role === 'manual')
        ? role
        : role; // keep as-is; model throws if invalid
    }
  }

  // ---- (B) frozen values: allow { variables:{ A:{value,..}, ... } } or { frozenValues:{ A: 123, ... } }
  const incomingVars = ref.variables || raw.frozenValues || {};
const varsObj = {};
for (const [k, v] of Object.entries(incomingVars)) {
  // support both { value: 1.23, policy:{...}, history:[...]} and plain number
  const baseVal = (v && typeof v === 'object' && 'value' in v) ? v.value : v;
  const pol     = (v && typeof v === 'object' && v.updatePolicy) ? v.updatePolicy : 'manual';
  const ts      = (v && typeof v === 'object' && v.lastUpdatedAt) ? new Date(v.lastUpdatedAt) : new Date();

  const policy  = (v && typeof v === 'object' && v.policy && typeof v.policy === 'object')
    ? {
        isConstant: v.policy.isConstant !== false, // default true
        schedule: {
          frequency: v.policy.schedule?.frequency || 'monthly',
          ...(v.policy.schedule?.fromDate ? { fromDate: new Date(v.policy.schedule.fromDate) } : {}),
          ...(v.policy.schedule?.toDate   ? { toDate:   new Date(v.policy.schedule.toDate)   } : {})
        }
      }
    : { isConstant: true, schedule: { frequency: 'monthly' } };

  const history = Array.isArray(v?.history)
    ? v.history.map(h => ({
        value: Number(h.value),
        from:  new Date(h.from),
        ...(h.to ? { to: new Date(h.to) } : {}),
        updatedAt: h.updatedAt ? new Date(h.updatedAt) : new Date()
      }))
    : undefined;
      const varRemark = (v && typeof v === 'object' && typeof v.remark === 'string') ? v.remark : '';

  varsObj[k] = {
    value: Number(baseVal ?? 0),
    updatePolicy: pol,
    lastUpdatedAt: ts,
    policy,
    ...(history ? { history } : {}),
    remark: varRemark
  };
}
const refRemark = typeof ref.remark === 'string' ? ref.remark : '';
  if (formulaId) {
    out.formulaRef = {
      formulaId,
      ...(version != null ? { version } : {}),
      ...(Object.keys(kindsObj).length ? { variableKinds: kindsObj } : {}),
      ...(Object.keys(varsObj).length   ? { variables: varsObj }     : {}),
      ...(refRemark ? { remark: refRemark } : {})
    };
  }
  return out;
}



/** ------------------------- */
/** METHODOLOGY 3 HELPERS     */
/** ------------------------- */

/** ----------------------------- */
/** M3 POLICY NORMALIZER (same as M2)
/** ----------------------------- */

// Normalize one variable of B/P/L with policy
// Normalize one variable of B/P/L with policy (supports manual | constant | internal)
function normalizeM3VariableFull(v = {}) {
  const name = String(v.name || '').trim();

  // Accept array from form-data: type = ["internal"]
  let rawType = Array.isArray(v.type) ? v.type[0] : v.type;

  let type = String(rawType || '').toLowerCase().trim();

  // If FE missed type or sent empty string → DO NOT default to manual.
  // Instead keep undefined so we can detect error.
  if (!type) type = v.type; // preserve original if FE sent 'internal'

  // Now validate allowed types
  if (!['manual', 'constant', 'internal'].includes(type)) {
    type = 'manual'; // default fallback
  }

  // Only constants store value
  const value = type === 'constant' ? Number(v.value ?? null) : null;

  return {
    name,
    type,                   // ✔ internal now preserved
    value,
    updatePolicy: v.updatePolicy || 'manual',
    defaultValue: v.defaultValue ?? null,
    lastValue: v.lastValue ?? null,
    lastUpdatedAt: v.lastUpdatedAt ? new Date(v.lastUpdatedAt) : new Date(),
    policy: {
      isConstant: v.policy?.isConstant !== false,
      schedule: {
        frequency: v.policy?.schedule?.frequency || 'none',
        fromDate: v.policy?.schedule?.fromDate ? new Date(v.policy.schedule.fromDate) : null,
        toDate: v.policy?.schedule?.toDate ? new Date(v.policy.schedule.toDate) : null
      },
      history: Array.isArray(v.policy?.history)
        ? v.policy.history.map(h => ({
            oldValue: Number(h.oldValue),
            newValue: Number(h.newValue),
            updatedAt: h.updatedAt ? new Date(h.updatedAt) : new Date()
          }))
        : []
    },
    internalSources: Array.isArray(v.internalSources)
      ? v.internalSources
      : [],
    computedInternalValue: null
  };
}


/** Normalize one B/P/L item */
function normalizeM3ItemFull(item = {}) {
  return {
    id: String(item.id || '').trim(),
    label: String(item.label || '').trim(),
    formulaId: item.formulaId,
    formulaExpression: item.formulaExpression || '',
    ssrType: item.ssrType || 'Source',
    remark: item.remark || '',
    Reference: item.Reference || '',
    variables: Array.isArray(item.variables)
      ? item.variables.map(normalizeM3VariableFull)
      : []
  };
}

/** ----------------------------- */
/** normalizeM3Body (final version)
/** ----------------------------- */
function normalizeM3Body(body = {}) {
  const m3 = body.m3 || body; // in case the FE sends direct m3:{}

  return {
    projectActivity: m3.projectActivity,
    buffer: Number(m3.buffer ?? 0),

    baselineEmissions: Array.isArray(m3.baselineEmissions)
      ? m3.baselineEmissions.map(normalizeM3ItemFull)
      : [],

    projectEmissions: Array.isArray(m3.projectEmissions)
      ? m3.projectEmissions.map(normalizeM3ItemFull)
      : [],

    leakageEmissions: Array.isArray(m3.leakageEmissions)
      ? m3.leakageEmissions.map(normalizeM3ItemFull)
      : []
  };
}




/** Validate payload for M3 */
function validateM3Input(body) {
  if (!body.projectActivity)
    throw new Error('projectActivity is required');

  if (!['Reduction','Removal'].includes(body.projectActivity))
    throw new Error('projectActivity must be Reduction or Removal');

  if (body.projectActivity === 'Removal') {
    if (body.m3?.buffer === undefined || body.m3?.buffer === null)
      throw new Error('Buffer is required for Removal projects');
  }
}

async function computeInternalValue(item, reductionDoc) {
  let sum = 0;

  for (const ref of (item.internalSources || [])) {
    // ref examples: "B1", "B2", "P1", "P3"
    const type = ref.startsWith("B") ? "baselineEmissions" :
                 ref.startsWith("P") ? "projectEmissions" :
                 null;

    if (!type) continue;

    const id = ref;
    const arr = reductionDoc.m3[type] || [];

    const found = arr.find(x => x.id === id);
    if (!found) continue;

    // evaluate found formula
    const formula = await ReductionFormula.findById(found.formulaId).lean();
    if (!formula) continue;

    // Build variables bag for that B/P item
    let bag = {};
    for (const v of (found.variables || [])) {
      if (v.type === "constant") {
        bag[v.name] = Number(v.value);
      }
      if (v.type === "manual") {
        // manual is provided in net reduction entry
        bag[v.name] = Number(item.variables?.find(m => m.name === v.name)?.value || 0);
      }
    }

    const parser = Parser.parse(formula.expression);
    const val = parser.evaluate(bag);

    sum += Number(val || 0);
  }

  return sum;
}
function cleanString(x) { return (typeof x === 'string') ? x.trim() : x; }

function normalizeProcessFlow(raw = {}, user) {
  // If literally nothing was sent, return undefined so we don't touch the document
  if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) return undefined;

  // mode/reference are optional; default to 'snapshot' but we won't force a snapshot
  const mode = (raw.mode || 'snapshot').toLowerCase();
  const out = {
    mode: ['snapshot','reference','both'].includes(mode) ? mode : 'snapshot',
    flowchartId: raw.flowchartId || null,
    snapshot: undefined,
    mapping: undefined,
    snapshotCreatedAt: new Date(),
    snapshotCreatedBy: user?.id
  };

  // Optional mapping
  if (raw.mapping) {
    out.mapping = {
      ABD: Array.isArray(raw.mapping.ABD) ? raw.mapping.ABD.map(m => ({ nodeId: String(m.nodeId||''), field: String(m.field||'') })) : undefined,
      APD: Array.isArray(raw.mapping.APD) ? raw.mapping.APD.map(m => ({ nodeId: String(m.nodeId||''), field: String(m.field||'') })) : undefined,
      ALD: Array.isArray(raw.mapping.ALD) ? raw.mapping.ALD.map(m => ({ nodeId: String(m.nodeId||''), field: String(m.field||'') })) : undefined
    };
  }

  // Optional snapshot
  if (raw.snapshot && typeof raw.snapshot === 'object') {
    const snapIn = raw.snapshot;
    const nodesIn = Array.isArray(snapIn.nodes) ? snapIn.nodes : undefined;
    const edgesIn = Array.isArray(snapIn.edges) ? snapIn.edges : undefined;

    out.snapshot = {
      metadata: {
        title: cleanString(snapIn.metadata?.title || ''),
        description: cleanString(snapIn.metadata?.description || ''),
        version: Number(snapIn.metadata?.version ?? 1)
      },
      // if user omits nodes/edges, we keep them undefined (field won't be persisted)
      ...(nodesIn ? {
        nodes: nodesIn.map(n => ({
          id: String(n.id || '').trim(),
          label: cleanString(n.label || ''),
          position: {
            x: Number(n.position?.x ?? 0),
            y: Number(n.position?.y ?? 0)
          },
          parentNode: n.parentNode ? String(n.parentNode) : null,
          details: (n.details && typeof n.details === 'object') ? n.details : {},
          kv: (n.kv && typeof n.kv === 'object') ? n.kv : undefined
        }))
      } : {}),
      ...(edgesIn ? {
        edges: edgesIn.map(e => ({
          id: String(e.id || '').trim(),
          source: String(e.source || '').trim(),
          target: String(e.target || '').trim(),
          kv: (e.kv && typeof e.kv === 'object') ? e.kv : undefined
        }))
      } : {})
    };
  }

  return out;
}



/** Create Reduction (Methodology-agnostic; we implement M1 math now) */
exports.createReduction = async (req, res) => {
  try {
    const { clientId } = req.params;

    // --- Permission ---
    const perm = await canCreateOrEdit(req.user, clientId);
    if (!perm.ok) {
      return res.status(403).json({ success:false, message: perm.reason });
    }

    // --- Extract body ---
    const {
      projectName, projectActivity, scope, location,
      category, commissioningDate, endDate, description,
      baselineMethod, baselineJustification,
      calculationMethodology, m1, m2
    } = req.body;

    // --- Process Flow (optional) ---
    let processFlowPayload;
    if (req.body.processFlow) {
      processFlowPayload = normalizeProcessFlow(req.body.processFlow, req.user);
    }

    // --- Basic validation ---
    if (!projectName) return res.status(400).json({ success:false, message:'projectName is required' });
    if (!projectActivity) return res.status(400).json({ success:false, message:'projectActivity is required' });
    if (!commissioningDate || !endDate) return res.status(400).json({ success:false, message:'commissioningDate & endDate required' });

    if (!calculationMethodology)
      return res.status(400).json({ success:false, message:'calculationMethodology is required' });

    if (!category)
      return res.status(400).json({ success:false, message:'category is required' });

    if (calculationMethodology === 'methodology3') {
      validateM3Input(req.body); // ensures buffer for “Removal”
    }

    // --- reductionDataEntry normalize ---
    let reductionEntryPayload = null;
    const hasEntry =
      Object.prototype.hasOwnProperty.call(req.body, 'reductionDataEntry') ||
      Object.prototype.hasOwnProperty.call(req.body, 'reductionDateEntry');

    if (hasEntry) {
      try {
        const incomingEntry = readReductionEntryFromBody(req.body);
        reductionEntryPayload = normalizeReductionDataEntry(incomingEntry);
      } catch (e) {
        return res.status(400).json({ success:false, message: e.message });
      }
    }

    // ============================================================
    //        UPSERT LOGIC — If same projectName already exists
    // ============================================================
    const existing = await Reduction.findOne({
      clientId,
      isDeleted: false,
      projectName: { $regex: new RegExp(`^${escapeRegex(projectName)}$`, 'i') }
    });

    if (existing) {
      // ===== UPDATE PATH =====
      existing.projectName = projectName;
      existing.projectActivity = projectActivity;
      existing.scope = scope ?? existing.scope;

      if (location) {
        existing.location.latitude = location.latitude ?? existing.location.latitude;
        existing.location.longitude = location.longitude ?? existing.location.longitude;
        existing.location.place = location.place || existing.location.place;
        existing.location.address = location.address || existing.location.address;
      }

      existing.commissioningDate = new Date(commissioningDate);
      existing.endDate = new Date(endDate);
      existing.description = description ?? existing.description;

      if (baselineMethod != null) existing.baselineMethod = baselineMethod;
      if (baselineJustification != null) existing.baselineJustification = baselineJustification;
      if (calculationMethodology) existing.calculationMethodology = calculationMethodology;

      // M1 update
      if (existing.calculationMethodology === 'methodology1') {
        existing.m1 = {
          ABD: (m1?.ABD || []).map(normalizeUnitItem('B')),
          APD: (m1?.APD || []).map(normalizeUnitItem('P')),
          ALD: (m1?.ALD || []).map(normalizeUnitItem('L')),
          bufferPercent: Number(m1?.bufferPercent ?? existing.m1?.bufferPercent ?? 0)
        };
      }

      // M2 update
      if (existing.calculationMethodology === 'methodology2' && req.body.m2) {
        existing.m2 = normalizeM2FromBody(req.body.m2);
      }

      // M3 update
      if (existing.calculationMethodology === 'methodology3' && req.body.m3) {
        validateM3Input(req.body);
        existing.m3 = normalizeM3Body(req.body.m3);
      }

      // Data entry
      if (reductionEntryPayload) {
        existing.reductionDataEntry = {
          ...(existing.reductionDataEntry?.toObject?.() ?? {}),
          ...reductionEntryPayload
        };
      }

      // Process flow
      if (processFlowPayload) {
        if (!existing.processFlow) existing.processFlow = {};
        if (processFlowPayload.mode) existing.processFlow.mode = processFlowPayload.mode;
        if ('flowchartId' in processFlowPayload) existing.processFlow.flowchartId = processFlowPayload.flowchartId;
        if (processFlowPayload.mapping) existing.processFlow.mapping = processFlowPayload.mapping;

        if (processFlowPayload.snapshot) {
          const prevVer = Number(existing.processFlow.snapshot?.metadata?.version || 0);
          const nextVer = prevVer > 0 ? prevVer + 1 : (processFlowPayload.snapshot.metadata?.version || 1);

          processFlowPayload.snapshot.metadata = processFlowPayload.snapshot.metadata || {};
          processFlowPayload.snapshot.metadata.version = nextVer;

          existing.processFlow.snapshot = processFlowPayload.snapshot;
          existing.processFlow.snapshotCreatedAt = new Date();
          existing.processFlow.snapshotCreatedBy = req.user?.id;
        }
      }

      await existing.validate();
      await existing.save();

      return res.status(200).json({
        success:true,
        message:'Reduction project updated (upsert on create)',
        data: existing
      });
    }

    // ============================================================
    //        CREATE NEW DOCUMENT
    // ============================================================
    const doc = await Reduction.create({
      clientId,
      createdBy: req.user.id,
      createdByType: req.user.userType,
      projectName,
      projectActivity,
      category,
      scope: scope || '',
      location: {
        latitude:  location?.latitude ?? null,
        longitude: location?.longitude ?? null,
        place: location?.place || '',
        address: location?.address || ''
      },
      commissioningDate: new Date(commissioningDate),
      endDate:           new Date(endDate),
      description: description || '',
      baselineMethod: baselineMethod || undefined,
      baselineJustification: baselineJustification || '',
      calculationMethodology,

      ...(reductionEntryPayload ? { reductionDataEntry: reductionEntryPayload } : {}),

      // M1
      m1: calculationMethodology === 'methodology1'
        ? {
            ABD: (m1?.ABD || []).map(normalizeUnitItem('B')),
            APD: (m1?.APD || []).map(normalizeUnitItem('P')),
            ALD: (m1?.ALD || []).map(normalizeUnitItem('L')),
            bufferPercent: Number(m1?.bufferPercent ?? 0)
          }
        : undefined,

      // M2
      ...(calculationMethodology === 'methodology2'
        ? { m2: normalizeM2FromBody(m2 || {}) }
        : {}),

      // M3  **FIXED**
      ...(calculationMethodology === 'methodology3'
        ? { m3: normalizeM3Body(req.body.m3) }
        : {}),

      ...(processFlowPayload ? { processFlow: processFlowPayload } : {})
    });

    // Save media files (images / cover)
    try {
      await saveReductionFiles(req, doc);
      await doc.save();
    } catch (moveErr) {
      console.warn("⚠ saveReductionFiles(create) warning:", moveErr.message);
    }

    // Notifications (async)
    notifyReductionEvent({
      actor: req.user,
      clientId,
      action: 'created',
      doc
    }).catch(() => {});
    Promise.all([
  syncReductionWorkflow(clientId, req.user?.id).catch(err => console.error('Workflow sync error:', err)),
  syncClientReductionProjects(clientId).catch(err => console.error('Project sync error:', err))
]);

    return res.status(201).json({
      success: true,
      message: 'Reduction project created',
      data: {
        clientId: doc.clientId,
        projectId: doc.projectId,
        reductionId: doc.reductionId,
        projectName: doc.projectName,
        projectActivity: doc.projectActivity,
        category: doc.category,
        scope: doc.scope,
        commissioningDate: doc.commissioningDate,
        endDate: doc.endDate,
        projectPeriodDays: doc.projectPeriodDays,
        projectPeriodFormatted: doc.projectPeriodFormatted,
        calculationMethodology: doc.calculationMethodology,
        ...(doc.reductionDataEntry ? { reductionDataEntry: doc.reductionDataEntry } : {}),
        ...(doc.m1 ? { m1: doc.m1 } : {}),
        ...(doc.m2 ? { m2: doc.m2 } : {}),
        ...(doc.m3 ? { m3: doc.m3 } : {})
      }
    });
  } catch (err) {
    console.error('createReduction error:', err);
    return res.status(500).json({ success:false, message:'Failed to create reduction', error: err.message });
  }
};


function normalizeUnitItem(prefix) {
  return (it, idx) => ({
    label: it?.label || `${prefix}${idx+1}`,
    value: Number(it?.value ?? 0),
    EF:    Number(it?.EF ?? 0),
    GWP:   Number(it?.GWP ?? 0),
    AF:    Number(it?.AF ?? 0),
    uncertainty: Number(it?.uncertainty ?? 0),
    remark: typeof it?.remark === 'string' ? it.remark : ''  
  });
}

async function canAccessReductions(user, clientId) {
  // 1) Super admin
  if (user.userType === "super_admin") return { allowed: true, reason: "Super admin" };

  // 2) Same client org users
  const clientSideRoles = [
    "client_admin",
    "client_employee_head",
    "employee",
    "auditor",
    "viewer"
  ];
  if (clientSideRoles.includes(user.userType) && user.clientId === clientId) {
    return { allowed: true, reason: "Same client organization" };
  }

  // 3) Consultants (re-use your proven helper for this client)
  //    canManageFlowchart already implements:
  //    - consultant_admin who created the lead or whose team is assigned
  //    - assigned consultant
  //    We'll just forward to it for consistency.
  const manage = await canManageFlowchart(user, clientId);
  if (manage.allowed) return { allowed: true, reason: manage.reason };

  return { allowed: false, reason: "Insufficient permissions for this client" };
}

/** Get list for a client */
/** Get list for a client */
exports.getReduction = async (req, res) => {
  try {
    const { clientId, projectId } = req.params;

    // -------- Permission Check --------
    const access = await canAccessReductions(req.user, clientId);
    if (!access.allowed) {
      return res.status(403).json({
        success: false,
        message: "Permission denied",
        reason: access.reason,
      });
    }

    // -------- Fetch Project --------
    const doc = await Reduction.findOne(
      { clientId, projectId, isDeleted: false }
    ).lean(); // lean = plain JSON

    if (!doc) {
      return res.status(404).json({
        success: false,
        message: "Reduction project not found",
      });
    }

    // --------------------------------------------------------------
    //  FIX: Guarantee methodology3 object is always returned
    // --------------------------------------------------------------
    if (doc.calculationMethodology === "methodology3") {
      doc.methodology3 = doc.methodology3 || {};

      doc.methodology3.baseline = doc.methodology3.baseline || [];
      doc.methodology3.project  = doc.methodology3.project  || [];
      doc.methodology3.leakage  = doc.methodology3.leakage  || [];

      doc.methodology3.totals = doc.methodology3.totals || {
        BE_total: 0,
        PE_total: 0,
        LE_total: 0,
        buffer: 0,
        final: 0,
      };
    }

    // --------------------------------------------------------------
    //  FIX: Ensure M2 return shape is clean
    // --------------------------------------------------------------
    if (doc.calculationMethodology === "methodology2") {
      if (!doc.m2) doc.m2 = {};
      if (!doc.m2.formulaRef) doc.m2.formulaRef = {};
    }

    // --------------------------------------------------------------
    //  FIX: Ensure M1 return values exist
    // --------------------------------------------------------------
    if (doc.calculationMethodology === "methodology1") {
      if (!doc.m1) doc.m1 = {};
      doc.m1.emissionReductionRate = doc.m1.emissionReductionRate || 0;
    }

    // --------------------------------------------------------------------
    //  🔥 FIX: APPEND PUBLIC URL TO IMAGES BEFORE SENDING RESPONSE
    // --------------------------------------------------------------------
    const BASE = process.env.SERVER_BASE_URL || "";

    // ---- Cover Image ----
    if (doc.coverImage?.path) {
      doc.coverImage.url = BASE + "/" + doc.coverImage.path.replace(/\\/g, "/");
    }

    // ---- Gallery Images ----
    if (Array.isArray(doc.images)) {
      doc.images = doc.images.map(img => ({
        ...img,
        url: BASE + "/" + img.path.replace(/\\/g, "/")
      }));
    }

    // --------------------------------------------------------------
    //  SEND BACK CLEAN RESPONSE
    // --------------------------------------------------------------
    return res.status(200).json({
      success: true,
      data: doc,
    });

  } catch (err) {
    console.error("getReduction error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch reduction",
      error: err.message,
    });
  }
};




// controllers/Reduction/reductionController.js

exports.getAllReductions = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      clientId: clientIdFilter,
      q,                         // quick text filter
      includeDeleted = 'false',
      sort = '-createdAt'
    } = req.query;

    const role = req.user?.userType;
    const userId = req.user?.id;

    if (!role || !userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    // =====================================================
    // BASE FILTER
    // =====================================================
    const filter = {};

    if (includeDeleted !== 'true') {
      filter.$or = [
        { isDeleted: { $exists: false } },
        { isDeleted: false }
      ];
    }

    if (q && String(q).trim()) {
      filter.projectName = { $regex: new RegExp(String(q).trim(), 'i') };
    }

    const applyClientFilter = (cid) => {
      if (cid && String(cid).trim()) filter.clientId = String(cid).trim();
    };

    // =====================================================
    // ROLE-BASED ACCESS FILTERING
    // =====================================================

    if (role === 'super_admin') {
      applyClientFilter(clientIdFilter);
    }

    else if (role === 'consultant_admin') {
      const teamConsultants = await User.find({
        userType: 'consultant',
        consultantAdminId: userId,
        isActive: true
      }).select('_id');

      const ids = [userId, ...teamConsultants.map(u => u._id)];
      filter.$and = (filter.$and || []).concat([{ createdBy: { $in: ids } }]);
      applyClientFilter(clientIdFilter);
    }

    else if (role === 'consultant') {
      const myClients = await Client.find({
        $or: [
          { 'leadInfo.assignedConsultantId': userId },
          { 'workflowTracking.assignedConsultantId': userId }
        ]
      }).select('clientId');

      const myClientIds = myClients.map(c => c.clientId);

      const orList = [{ createdBy: userId }];
      if (myClientIds.length) orList.push({ clientId: { $in: myClientIds } });

      filter.$and = (filter.$and || []).concat([{ $or: orList }]);
      applyClientFilter(clientIdFilter);
    }

    else if (
      role === 'client_admin' ||
      role === 'client_employee_head' ||
      role === 'employee' ||
      role === 'viewer' ||
      role === 'auditor'
    ) {
      if (!req.user.clientId) {
        return res.status(403).json({
          success: false,
          message: 'No client scope for this user'
        });
      }
      filter.clientId = req.user.clientId;
    }

    else {
      return res.status(403).json({ success: false, message: 'Forbidden role' });
    }

    // =====================================================
    // PAGINATION
    // =====================================================
    const pageNum  = Math.max(1, Number(page));
    const limitNum = Math.min(100, Math.max(1, Number(limit)));

    const query = Reduction.find(filter)
      .sort(sort)
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .populate('createdBy', 'userName userType email')
      .lean();

    const [items, total] = await Promise.all([
      query,
      Reduction.countDocuments(filter),
    ]);

    // =====================================================
    //  FIX: FORMAT METHODOLOGY 3 FOR ALL ITEMS
    // =====================================================
    const cleanedItems = items.map(r => {
      // M3 ALWAYS must have clean structure
      if (r.calculationMethodology === "methodology3") {
        r.methodology3 = r.methodology3 || {};

        r.methodology3.baseline = Array.isArray(r.methodology3.baseline)
          ? r.methodology3.baseline
          : [];

        r.methodology3.project = Array.isArray(r.methodology3.project)
          ? r.methodology3.project
          : [];

        r.methodology3.leakage = Array.isArray(r.methodology3.leakage)
          ? r.methodology3.leakage
          : [];

        r.methodology3.totals = r.methodology3.totals || {
          BE_total: 0,
          PE_total: 0,
          LE_total: 0,
          buffer: 0,
          final: 0
        };
      }

      // M2 cleanup
      if (r.calculationMethodology === "methodology2") {
        r.m2 = r.m2 || {};
        r.m2.formulaRef = r.m2.formulaRef || {};
      }

      // M1 cleanup
      if (r.calculationMethodology === "methodology1") {
        r.m1 = r.m1 || {};
        r.m1.emissionReductionRate =
          r.m1.emissionReductionRate ?? 0;
      }

      return r;
    });

    // =====================================================
    // SEND RESULT
    // =====================================================
    return res.status(200).json({
      success: true,
      total,
      page: pageNum,
      limit: limitNum,
      data: cleanedItems,
    });

  } catch (err) {
    console.error("getAllReductions error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch reductions",
      error: process.env.NODE_ENV === "development" ? err.message : undefined
    });
  }
};






/** ------------------------- */
/** Update + recalc (FULL M1+M2+M3) */
/** ------------------------- */
exports.updateReduction = async (req, res) => {
  try {
    const { clientId, projectId } = req.params;

    // ---------------- Permission ----------------
    const perm = await canCreateOrEdit(req.user, clientId);
    if (!perm.ok) {
      return res.status(403).json({ success: false, message: perm.reason });
    }

    const doc = await Reduction.findOne({ clientId, projectId, isDeleted: false });
    if (!doc) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    // ---------------- Unpack body ----------------
    const body = req.body || {};
    const {
      projectName,
      projectActivity,
      scope,
      location,
      category,
      commissioningDate,
      endDate,
      description,
      baselineMethod,
      baselineJustification,
      calculationMethodology,
      m1,
      m2
    } = body;

    // ---------------- reductionDataEntry ----------------
    let reductionEntryPayload = null;
    const hasEntry =
      Object.prototype.hasOwnProperty.call(body, "reductionDataEntry") ||
      Object.prototype.hasOwnProperty.call(body, "reductionDateEntry");

    if (hasEntry) {
      try {
        const incomingEntry = readReductionEntryFromBody(body);
        reductionEntryPayload = normalizeReductionDataEntry(incomingEntry);
      } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
      }
    }

    // ---------------- processFlow ----------------
    let processFlowPayload;
    if (body.processFlow) {
      processFlowPayload = normalizeProcessFlow(body.processFlow, req.user);
    }

    // ---------------- Patch basic fields ----------------
    if (projectName != null) doc.projectName = projectName;
    if (projectActivity != null) doc.projectActivity = projectActivity;
    if (scope != null) doc.scope = scope;
    if (category != null) doc.category = category;

    if (location) {
      doc.location.latitude = location.latitude ?? doc.location.latitude;
      doc.location.longitude = location.longitude ?? doc.location.longitude;
      if ("place" in location) doc.location.place = location.place ?? doc.location.place;
      if ("address" in location) doc.location.address = location.address ?? doc.location.address;
    }

    if (commissioningDate) doc.commissioningDate = new Date(commissioningDate);
    if (endDate) doc.endDate = new Date(endDate);
    if (description != null) doc.description = description;
    if (baselineMethod != null) doc.baselineMethod = baselineMethod;
    if (baselineJustification != null) doc.baselineJustification = baselineJustification;
    if (calculationMethodology) doc.calculationMethodology = calculationMethodology;

    // ===================================================================
    //                     METHODOLOGY-SPECIFIC SECTION
    // ===================================================================

    // -------------------- M1 --------------------
    if (doc.calculationMethodology === "methodology1" && m1) {
      if (Array.isArray(m1.ABD)) doc.m1.ABD = m1.ABD.map(normalizeUnitItem("B"));
      if (Array.isArray(m1.APD)) doc.m1.APD = m1.APD.map(normalizeUnitItem("P"));
      if (Array.isArray(m1.ALD)) doc.m1.ALD = m1.ALD.map(normalizeUnitItem("L"));
      if (m1.bufferPercent != null) doc.m1.bufferPercent = Number(m1.bufferPercent);
    }

    // -------------------- M2 --------------------
    if (doc.calculationMethodology === "methodology2" && m2) {
      doc.m2 = normalizeM2FromBody(m2);
    }

    // -------------------- M3 (FULL UPDATE SUPPORT ADDED) --------------------
    if (doc.calculationMethodology === "methodology3" && body.m3) {
      // Validate required fields (buffer for Removal)
      validateM3Input(body);

      // Normalize the entire B/P/L structure + policy
      doc.m3 = normalizeM3Body(body.m3);
    }

    // ===================================================================
    //                     OTHER FIELDS
    // ===================================================================

    // -------------------- Data Entry Update --------------------
    if (reductionEntryPayload) {
      doc.reductionDataEntry = {
        ...(doc.reductionDataEntry?.toObject?.() ?? {}),
        ...reductionEntryPayload
      };
    }

    // -------------------- ProcessFlow Update --------------------
    if (processFlowPayload) {
      if (!doc.processFlow) doc.processFlow = {};

      if (processFlowPayload.mode) doc.processFlow.mode = processFlowPayload.mode;
      if ("flowchartId" in processFlowPayload)
        doc.processFlow.flowchartId = processFlowPayload.flowchartId;

      if (processFlowPayload.mapping) {
        doc.processFlow.mapping = processFlowPayload.mapping;
      }

      if (processFlowPayload.snapshot) {
        const prevVer = Number(doc.processFlow.snapshot?.metadata?.version || 0);
        const nextVer =
          prevVer > 0
            ? prevVer + 1
            : processFlowPayload.snapshot.metadata?.version || 1;

        processFlowPayload.snapshot.metadata =
          processFlowPayload.snapshot.metadata || {};
        processFlowPayload.snapshot.metadata.version = nextVer;

        doc.processFlow.snapshot = processFlowPayload.snapshot;
        doc.processFlow.snapshotCreatedAt = new Date();
        doc.processFlow.snapshotCreatedBy = req.user?.id;
      }
    }

    // -------------------- Media Uploads --------------------
    try {
      await saveReductionFiles(req, doc);
    } catch (moveErr) {
      console.warn("⚠ saveReductionFiles(update) warning:", moveErr.message);
    }

    // -------------------- Validate + Save --------------------
    await doc.validate(); // triggers recompute logic in model
    await doc.save();

    // -------------------- Notifications --------------------
    notifyReductionEvent({
      actor: req.user,
      clientId,
      action: "updated",
      doc
    }).catch(() => {});
    Promise.all([
  syncReductionWorkflow(clientId, req.user?.id).catch(err => console.error('Workflow sync error:', err)),
  syncClientReductionProjects(clientId).catch(err => console.error('Project sync error:', err))
]);

    // -------------------- Response --------------------
    return res.status(200).json({
      success: true,
      message: "Updated",
      data: doc
    });
  } catch (err) {
    console.error("updateReduction error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to update reduction",
      error: err.message
    });
  }
};




/** Recalculate explicitly (useful after small edits) */
exports.recalculateReduction = async (req, res) => {
  try {
    const { clientId, projectId } = req.params;
    const perm = await canCreateOrEdit(req.user, clientId);
    if (!perm.ok) return res.status(403).json({ success:false, message: perm.reason });

    const doc = await Reduction.findOne({ clientId, projectId, isDeleted:false });
    if (!doc) return res.status(404).json({ success:false, message:'Not found' });

    // Trigger pre('validate') for recompute
    await doc.validate();
    await doc.save();

    res.status(200).json({ success:true, message:'Recalculated', data: doc });
  } catch (err) {
    res.status(500).json({ success:false, message:'Failed to recalculate', error: err.message });
  }
};

/** Soft delete */
exports.deleteReduction = async (req, res) => {
  try {
    const { clientId, projectId } = req.params;
    const perm = await canCreateOrEdit(req.user, clientId);
    if (!perm.ok) return res.status(403).json({ success:false, message: perm.reason });

    const doc = await Reduction.findOne({ clientId, projectId, isDeleted:false });
    if (!doc) return res.status(404).json({ success:false, message:'Not found' });

    doc.isDeleted = true;
    doc.deletedAt = new Date();
    doc.deletedBy = req.user.id;
    await doc.save();
        notifyReductionEvent({
      actor: req.user,
      clientId,
      action: 'deleted',
      doc
    }).catch(() => {});
    Promise.all([
  syncReductionWorkflow(clientId, req.user?.id).catch(err => console.error('Workflow sync error:', err)),
  syncClientReductionProjects(clientId).catch(err => console.error('Project sync error:', err))
]);


    res.status(200).json({ success:true, message:'Deleted' });
  } catch (err) {
    res.status(500).json({ success:false, message:'Failed to delete reduction', error: err.message });
  }
};

exports.deleteFromDB = async (req, res) => {
  try {
    const { clientId, projectId } = req.params;

    const client = await Client.findOne({ clientId }).select('leadInfo.createdBy');
    if (!client) return res.status(404).json({ success:false, message:'Client not found' });

    const u = req.user;
    const isSuper = u?.userType === 'super_admin';
    const isCreatorConsultantAdmin =
      u?.userType === 'consultant_admin' &&
      client.leadInfo?.createdBy?.toString() === u.id.toString();

    if (!isSuper && !isCreatorConsultantAdmin) {
      return res.status(403).json({ success:false, message:'Permission denied (hard delete restricted)' });
    }

    // fetch doc for notification context (name, etc.)
    const doc = await Reduction.findOne({ clientId, projectId });

    const result = await Reduction.deleteOne({ clientId, projectId });
    if (result.deletedCount === 0) {
      return res.status(404).json({ success:false, message:'Reduction not found or already deleted' });
    }

    // notify
    notifyReductionEvent({
      actor: req.user,
      clientId,
      action: 'hard_deleted',
      doc,
      projectId
    }).catch(() => {});
    Promise.all([
  syncReductionWorkflow(clientId, req.user?.id).catch(err => console.error('Workflow sync error:', err)),
  syncClientReductionProjects(clientId).catch(err => console.error('Project sync error:', err))
]);


    return res.status(200).json({ success:true, message:'Reduction permanently deleted' });
  } catch (err) {
    console.error('deleteFromDB error:', err);
    res.status(500).json({ success:false, message:'Failed to hard delete reduction', error: err.message });
  }
};


// --- ADD this helper near the other helpers ---
async function canViewSoftDeletedReduction(user, clientId, reductionDoc) {
  if (!user) return { ok: false, reason: 'Unauthenticated' };

  // 1) super_admin can view
  if (user.userType === 'super_admin') return { ok: true };

  // 2) creator of this reduction can view
  if (reductionDoc?.createdBy?.toString?.() === user.id?.toString?.()) {
    return { ok: true };
  }

  // 3) assigned consultant for this client can view
  if (user.userType === 'consultant') {
    const client = await Client.findOne({ clientId }).select('leadInfo.assignedConsultantId');
    if (client?.leadInfo?.assignedConsultantId?.toString?.() === user.id?.toString?.()) {
      return { ok: true };
    }
  }

  return { ok: false, reason: 'Not allowed to view soft-deleted reductions for this client' };
}


// --- ADD this new controller ---
/** Get ONE soft-deleted reduction by projectId (strict access) */
exports.restoreSoftDeletedReduction = async (req, res) => {
  try {
    const { clientId, projectId } = req.params;

    // Find soft-deleted doc
    const doc = await Reduction.findOne({ clientId, projectId, isDeleted: true });
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Soft-deleted reduction not found' });
    }

    // AuthZ: same as viewing soft-deleted
    const perm = await canViewSoftDeletedReduction(req.user, clientId, doc);
    if (!perm.ok) {
      return res.status(403).json({ success: false, message: 'Permission denied', reason: perm.reason });
    }

    // Flip flags
    doc.isDeleted = false;
    doc.deletedAt = undefined;
    doc.deletedBy = undefined;

    await doc.save();
    Promise.all([
  syncReductionWorkflow(clientId, req.user?.id).catch(err => console.error('Workflow sync error:', err)),
  syncClientReductionProjects(clientId).catch(err => console.error('Project sync error:', err))
]);
    return res.status(200).json({ success: true, message: 'Reduction restored', data: doc });
  } catch (err) {
    console.error('restoreSoftDeletedReduction error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to restore soft-deleted reduction',
      error: err.message
    });
  }
};


/**
 * PATCH /api/reduction/:clientId/:projectId/assign-employee-head
 * Role: client_admin
 * Body: { employeeHeadId: "<ObjectId>" }
 */
exports.assignEmployeeHeadToProject = async (req, res) => {
  try {
    const { clientId, projectId } = req.params;
    const { employeeHeadId } = req.body;

    // 1) Only client_admin can call this
    if (req.user?.userType !== 'client_admin') {
      return res.status(403).json({ message: 'Only Client Admin can assign Employee Head' });
    }
    // Client Admin must belong to same client
    if (req.user.clientId !== clientId) {
      return res.status(403).json({ message: 'You can assign heads only within your organization' });
    }

    // 2) Validate head exists, type matches and same client
    const head = await User.findOne({ _id: employeeHeadId, userType: 'client_employee_head', clientId });
    if (!head) {
      return res.status(404).json({ message: 'Employee Head not found in this client' });
    }

    // 3) Load project
    const reduction = await Reduction.findOne({ clientId, projectId });
    if (!reduction) {
      return res.status(404).json({ message: 'Reduction project not found' });
    }

    const previousHead = reduction.assignedTeam?.employeeHeadId?.toString();
    const isChange = previousHead && previousHead !== String(employeeHeadId);

    // 4) Assign / change head
    reduction.assignedTeam = reduction.assignedTeam || {};
    reduction.assignedTeam.employeeHeadId = head._id;

    // If head changed, drop any employees not under this head
    if (isChange) {
      reduction.assignedTeam.employeeIds = []; // fresh; head will add their own team
      reduction.assignedTeam.history = reduction.assignedTeam.history || [];
      reduction.assignedTeam.history.push({
        action: 'change_head',
        by: req.user.id,
        details: { from: previousHead, to: head._id }
      });
    } else {
      reduction.assignedTeam.history = reduction.assignedTeam.history || [];
      reduction.assignedTeam.history.push({
        action: 'assign_head',
        by: req.user.id,
        details: { headId: head._id }
      });
    }

    await reduction.save();

    return res.status(200).json({
      message: 'Employee Head assigned successfully',
      data: {
        projectId: reduction.projectId,
        employeeHeadId: reduction.assignedTeam.employeeHeadId,
        employeeIds: reduction.assignedTeam.employeeIds || []
      }
    });
  } catch (err) {
    console.error('assignEmployeeHeadToProject error:', err);
    return res.status(500).json({ message: 'Failed to assign employee head', error: err.message });
  }
};


/**
 * PATCH /api/reduction/:clientId/:projectId/assign-employees
 * Role: client_employee_head
 * Body: { employeeIds: ["<ObjectId>", ...] }  // full replace or additive (controlled by mode)
 * Optional query: ?mode=add | remove | set  (default: add)
 */
exports.assignEmployeesToProject = async (req, res) => {
  try {
    const { clientId, projectId } = req.params;
    const { employeeIds } = req.body;
    const mode = (req.query.mode || 'add').toLowerCase(); // 'add' | 'remove' | 'set'

    if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
      return res.status(400).json({ message: 'employeeIds must be a non-empty array' });
    }

    // 1) Only employee head can call
    if (req.user?.userType !== 'client_employee_head') {
      return res.status(403).json({ message: 'Only Employee Head can assign employees' });
    }
    if (req.user.clientId !== clientId) {
      return res.status(403).json({ message: 'You can assign employees only within your organization' });
    }

    // 2) Load project & basic checks
    const reduction = await Reduction.findOne({ clientId, projectId });
    if (!reduction) {
      return res.status(404).json({ message: 'Reduction project not found' });
    }
    if (!reduction.assignedTeam?.employeeHeadId || String(reduction.assignedTeam.employeeHeadId) !== String(req.user.id)) {
      return res.status(403).json({ message: 'You are not the assigned Employee Head for this project' });
    }

    // 3) Validate all employees: same client, userType 'employee', employeeHeadId == req.user.id
    const employees = await User.find({
      _id: { $in: employeeIds },
      userType: 'employee',
      clientId,
      employeeHeadId: req.user.id
    }).select('_id');

    if (employees.length !== employeeIds.length) {
      return res.status(400).json({ message: 'One or more employees are invalid or not under your team' });
    }

    reduction.assignedTeam = reduction.assignedTeam || {};
    const current = new Set((reduction.assignedTeam.employeeIds || []).map(String));
    const incoming = new Set(employeeIds.map(String));

    if (mode === 'set') {
      reduction.assignedTeam.employeeIds = Array.from(incoming);
    } else if (mode === 'remove') {
      incoming.forEach(id => current.delete(id));
      reduction.assignedTeam.employeeIds = Array.from(current);
    } else { // add
      incoming.forEach(id => current.add(id));
      reduction.assignedTeam.employeeIds = Array.from(current);
    }

    reduction.assignedTeam.history = reduction.assignedTeam.history || [];
    reduction.assignedTeam.history.push({
      action: mode === 'remove' ? 'unassign_employees' : 'assign_employees',
      by: req.user.id,
      details: { employeeIds, mode }
    });

    await reduction.save();

    return res.status(200).json({
      message: 'Employees updated for project',
      data: {
        projectId: reduction.projectId,
        employeeHeadId: reduction.assignedTeam.employeeHeadId,
        employeeIds: reduction.assignedTeam.employeeIds
      }
    });
  } catch (err) {
    console.error('assignEmployeesToProject error:', err);
    return res.status(500).json({ message: 'Failed to update employees', error: err.message });
  }
};

// ============================================================
// ADD THESE NEW FUNCTIONS TO reductionController.js
// Place them before the module.exports at the end of the file
// ============================================================

// IMPORTANT: Add this import at the top of reductionController.js (around line 8):
// const { syncClientReductionProjects, syncAllClientsReductionProjects } = require('../../utils/Workflow/syncReductionProjects');

/**
 * Update Reduction Status
 * PUT /api/reductions/:projectId/status
 */
exports.updateReductionStatus = async (req, res) => {
  try {
    const { projectId } = req.params;
    const { status } = req.body;
    
    // Validate status
    const validStatuses = ['not_started', 'on_going', 'pending', 'completed'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }

    // Find the reduction project
    const reduction = await Reduction.findOne({ 
      projectId,
      $or: [
        { isDeleted: { $exists: false } },
        { isDeleted: false }
      ]
    });

    if (!reduction) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // Check permissions
    const authCheck = await canCreateOrEdit(req.user, reduction.clientId);
    if (!authCheck.ok) {
      return res.status(403).json({
        success: false,
        message: authCheck.reason
      });
    }

    // Update status
    const previousStatus = reduction.status;
    reduction.status = status;
    await reduction.save();

    // Sync with client workflow tracking
    await syncClientReductionProjects(reduction.clientId);

    // Send notification
    await notifyReductionEvent(
      reduction.clientId,
      req.user.id,
      'reduction_status_updated',
      {
        projectId: reduction.projectId,
        projectName: reduction.projectName,
        previousStatus,
        newStatus: status
      }
    );

    return res.status(200).json({
      success: true,
      message: 'Project status updated successfully',
      data: {
        projectId: reduction.projectId,
        projectName: reduction.projectName,
        previousStatus,
        currentStatus: status
      }
    });

  } catch (error) {
    console.error('Update reduction status error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update project status',
      error: error.message
    });
  }
};

/**
 * Sync Reduction Projects for a Client
 * POST /api/reductions/sync/:clientId
 */
exports.syncReductionProjects = async (req, res) => {
  try {
    const { clientId } = req.params;

    // Validate user has access to this client
    const authCheck = await canCreateOrEdit(req.user, clientId);
    if (!authCheck.ok) {
      return res.status(403).json({
        success: false,
        message: authCheck.reason
      });
    }

    // Perform sync
    const result = await syncClientReductionProjects(clientId);

    if (!result.success) {
      return res.status(404).json({
        success: false,
        message: result.message
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Projects synced successfully',
      data: result
    });

  } catch (error) {
    console.error('Sync reduction projects error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to sync projects',
      error: error.message
    });
  }
};

/**
 * Get Reduction Projects Summary for a Client
 * GET /api/reductions/summary/:clientId
 */
exports.getReductionProjectsSummary = async (req, res) => {
  try {
    const { clientId } = req.params;

    // Validate user has access to this client
    const authCheck = await canCreateOrEdit(req.user, clientId);
    if (!authCheck.ok) {
      return res.status(403).json({
        success: false,
        message: authCheck.reason
      });
    }

    // Get client
    const client = await Client.findOne({ clientId })
      .select('clientId workflowTracking.reduction')
      .lean();

    if (!client) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }

    // Get all projects for this client with their status
    const projects = await Reduction.find({
      clientId,
      $or: [
        { isDeleted: { $exists: false } },
        { isDeleted: false }
      ]
    })
    .select('projectId projectName reductionId status createdAt updatedAt reductionDataEntry')
    .sort({ createdAt: -1 })
    .lean();

    // Format projects
    const formattedProjects = projects.map(p => ({
      projectId: p.projectId,
      projectName: p.projectName,
      reductionId: p.reductionId,
      status: p.status || 'not_started',
      inputType: p.reductionDataEntry?.inputType || 'manual',
      createdAt: p.createdAt,
      updatedAt: p.updatedAt
    }));

    return res.status(200).json({
      success: true,
      data: {
        clientId,
        summary: client.workflowTracking?.reduction || {
          status: 'not_started',
          projects: {
            totalCount: 0,
            activeCount: 0,
            completedCount: 0,
            pendingCount: 0,
            notStartedCount: 0
          }
        },
        projects: formattedProjects
      }
    });

  } catch (error) {
    console.error('Get reduction projects summary error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get projects summary',
      error: error.message
    });
  }
};


// ============================================================
// NEW CONTROLLER FUNCTION: Update Client-Level Reduction Workflow Status
// Add this to reductionController.js
// ============================================================

/**
 * @route   PATCH /api/reductions/workflow-status/:clientId
 * @desc    Update the overall reduction workflow status for a client
 *          (Different from individual project status)
 * @access  Private (consultant_admin/consultant)
 */
exports.updateClientReductionWorkflowStatus = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { status } = req.body;

    // Validate status
    const validStatuses = ['not_started', 'on_going', 'pending', 'completed'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }

    // Permission check
    const perm = await canCreateOrEdit(req.user, clientId);
    if (!perm.ok) {
      return res.status(403).json({
        success: false,
        message: perm.reason
      });
    }

    // Find and update client
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }

    // Store previous status
    const previousStatus = client.workflowTracking?.reduction?.status || 'not_started';

    // Update the workflow status
    if (!client.workflowTracking) {
      client.workflowTracking = {};
    }
    if (!client.workflowTracking.reduction) {
      client.workflowTracking.reduction = {
        status: 'not_started',
        projects: {
          totalCount: 0,
          activeCount: 0,
          completedCount: 0,
          pendingCount: 0,
          notStartedCount: 0
        }
      };
    }

    client.workflowTracking.reduction.status = status;
    client.workflowTracking.reduction.lastUpdated = new Date();

    await client.save();

    // Log the change
    console.log(`[Workflow Status] Client ${clientId}: ${previousStatus} → ${status}`);

    // Notify relevant users (optional)
    try {
      await notifyReductionEvent(
        'workflow_status_updated',
        clientId,
        null, // no specific project
        req.user.id,
        {
          previousStatus,
          currentStatus: status,
          updatedBy: req.user.email || req.user.id
        }
      );
    } catch (notifyErr) {
      console.error('Notification error:', notifyErr);
    }

    res.status(200).json({
      success: true,
      message: 'Workflow status updated successfully',
      data: {
        clientId,
        previousStatus,
        currentStatus: status,
        updatedAt: client.workflowTracking.reduction.lastUpdated,
        projectsSummary: client.workflowTracking.reduction.projects
      }
    });

  } catch (error) {
    console.error('[updateClientReductionWorkflowStatus] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error updating workflow status',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};


/**
 * @route   GET /api/reductions/workflow-status/:clientId
 * @desc    Get the current reduction workflow status for a client
 * @access  Private (consultant_admin/consultant)
 */
exports.getClientReductionWorkflowStatus = async (req, res) => {
  try {
    const { clientId } = req.params;

    // Permission check
    const perm = await canCreateOrEdit(req.user, clientId);
    if (!perm.ok) {
      return res.status(403).json({
        success: false,
        message: perm.reason
      });
    }

    // Find client
    const client = await Client.findOne({ clientId })
      .select('clientId workflowTracking.reduction');

    if (!client) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }

    const workflowData = client.workflowTracking?.reduction || {
      status: 'not_started',
      projects: {
        totalCount: 0,
        activeCount: 0,
        completedCount: 0,
        pendingCount: 0,
        notStartedCount: 0
      }
    };

    res.status(200).json({
      success: true,
      data: {
        clientId,
        status: workflowData.status,
        projects: workflowData.projects,
        lastUpdated: workflowData.lastUpdated || null
      }
    });

  } catch (error) {
    console.error('[getClientReductionWorkflowStatus] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error retrieving workflow status',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};








