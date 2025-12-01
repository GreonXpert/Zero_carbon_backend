// controllers/reductionController.js
const Reduction = require('../../models/Reduction/Reduction');
const Client = require('../../models/Client');
const User = require('../../models/User');
const { canManageFlowchart } = require("../../utils/Permissions/permissions");
const { notifyReductionEvent } = require('../../utils/notifications/reductionNotifications');
const { syncReductionWorkflow } = require('../../utils/Workflow/workflow');
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

/** Normalize a variable */
function normalizeM3Variable(v) {
  return {
    name: String(v.name || '').trim(),
    type: v.type === 'constant' ? 'constant' : 'manual',
    value: v.type === 'constant' ? Number(v.value ?? null) : null
  };
}

/** Normalize B/P/L Item */
function normalizeM3Item(item) {
  return {
    id: String(item.id || '').trim(),                 // B1 / P1 / L1
    label: String(item.label || '').trim(),
    formulaId: item.formulaId,
    formulaExpression: item.formulaExpression || '',
    variables: Array.isArray(item.variables)
      ? item.variables.map(normalizeM3Variable)
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
    const perm = await canCreateOrEdit(req.user, clientId);
    if (!perm.ok) return res.status(403).json({ success:false, message: perm.reason });

    const {
      projectName, projectActivity, scope, location,
      category,commissioningDate, endDate, description,
      baselineMethod, baselineJustification,
      calculationMethodology, m1, m2  
    } = req.body;

    // OPTIONAL: processFlow
let processFlowPayload;
if (req.body.processFlow) {
  processFlowPayload = normalizeProcessFlow(req.body.processFlow, req.user);
}


    if (!projectName) return res.status(400).json({ success:false, message:'projectName is required' });
    if (!projectActivity) return res.status(400).json({ success:false, message:'projectActivity is required' });
    if (!commissioningDate || !endDate) return res.status(400).json({ success:false, message:'commissioningDate & endDate required' });
    if (calculationMethodology === 'methodology3') {
  validateM3Input(req.body);
}
    if (!calculationMethodology) return res.status(400).json({ success:false, message:'calculationMethodology is required' });
    if (!category) return res.status(400).json({ success:false, message:'category is required' });

    // ✅ MOVE THIS BLOCK UP HERE
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

    // UPSERT: same client + same projectName (case-insensitive), not deleted
    const existing = await Reduction.findOne({
      clientId,
      isDeleted: false,
      projectName: { $regex: new RegExp(`^${escapeRegex(projectName)}$`, 'i') }
    });

    if (existing) {
      // ---- UPDATE path (same rules as updateReduction) ----
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

      if (existing.calculationMethodology === 'methodology1') {
        existing.m1 = {
          ABD: (m1?.ABD || []).map(normalizeUnitItem('B')),
          APD: (m1?.APD || []).map(normalizeUnitItem('P')),
          ALD: (m1?.ALD || []).map(normalizeUnitItem('L')),
          bufferPercent: Number(m1?.bufferPercent ?? existing.m1?.bufferPercent ?? 0)
        };
      }
      if (existing.calculationMethodology === 'methodology2' && req.body.m2) {
        existing.m2 = normalizeM2FromBody(req.body.m2);
      }

      /** -------------------------
 *  Methodology 3 UPDATE PATH
 * ------------------------- */
if (existing.calculationMethodology === 'methodology3' && req.body.m3) {
  validateM3Input(req.body); // Throws error if invalid

  const m3 = req.body.m3;

  existing.m3 = {
    projectActivity: req.body.projectActivity, // M3 duplicates activity
    buffer: Number(m3.buffer ?? 0),
    baselineEmissions: Array.isArray(m3.baselineEmissions)
      ? m3.baselineEmissions.map(normalizeM3Item)
      : [],
    projectEmissions: Array.isArray(m3.projectEmissions)
      ? m3.projectEmissions.map(normalizeM3Item)
      : [],
    leakageEmissions: Array.isArray(m3.leakageEmissions)
      ? m3.leakageEmissions.map(normalizeM3Item)
      : []
  };
}

      // ✅ Now this is safe; variable exists
      if (reductionEntryPayload) {
        existing.reductionDataEntry = {
          ...(existing.reductionDataEntry?.toObject?.() ?? {}),
          ...reductionEntryPayload
        };
      }
        // ✅ apply processFlow if sent (same semantics as updateReduction)
if (processFlowPayload) {
  if (!existing.processFlow) existing.processFlow = {};
  if (processFlowPayload.mode) existing.processFlow.mode = processFlowPayload.mode;

  if (Object.prototype.hasOwnProperty.call(processFlowPayload, 'flowchartId')) {
    existing.processFlow.flowchartId = processFlowPayload.flowchartId;
  }
  if (processFlowPayload.mapping) {
    existing.processFlow.mapping = processFlowPayload.mapping;
  }
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


      await existing.validate(); // triggers recompute
      await existing.save();


      return res.status(200).json({
        success: true,
        message: 'Reduction project updated (upsert on create)',
        data: existing
      });
    }

    // ---- CREATE path (unchanged; we only add the field if present) ----
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
      m1: calculationMethodology === 'methodology1' ? {
        ABD: (m1?.ABD || []).map(normalizeUnitItem('B')),
        APD: (m1?.APD || []).map(normalizeUnitItem('P')),
        ALD: (m1?.ALD || []).map(normalizeUnitItem('L')),
        bufferPercent: Number(m1?.bufferPercent ?? 0)
      } : undefined,
      ...(calculationMethodology === 'methodology2'
        ? { m2: normalizeM2FromBody(m2 || {}) }
        : {}),
            /** -------------------------
       *  Methodology 3 CREATE PATH
       * ------------------------- */
      ...(calculationMethodology === 'methodology3'
        ? {
            m3: {
              projectActivity,
              buffer: Number(req.body.m3?.buffer ?? 0),
              baselineEmissions: Array.isArray(req.body.m3?.baselineEmissions)
                ? req.body.m3.baselineEmissions.map(normalizeM3Item)
                : [],
              projectEmissions: Array.isArray(req.body.m3?.projectEmissions)
                ? req.body.m3.projectEmissions.map(normalizeM3Item)
                : [],
              leakageEmissions: Array.isArray(req.body.m3?.leakageEmissions)
                ? req.body.m3.leakageEmissions.map(normalizeM3Item)
                : []
            }
          }
        : {}),
            ...(processFlowPayload ? { processFlow: processFlowPayload } : {}) // ✅ correct source

    });

    /* ✅ INSERT THIS BLOCK HERE — after create(), before notifications/response */
try {
  // Ensure reductionId is present (set in schema pre('validate'))
  await saveReductionFiles(req, doc);
  await doc.save(); // persist coverImage/images if any
} catch (moveErr) {
  console.warn('⚠ saveReductionFiles(create) warning:', moveErr.message);
}
/* ✅ END INSERT */

      // fire-and-forget notification; don't block the response
      notifyReductionEvent({
        actor: req.user,
        clientId,
        action: 'created',
        doc
      }).catch(() => {});
      syncReductionWorkflow(clientId, req.user?.id).catch(() => {});

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
      ...(doc.m2 ? { m2: doc.m2 } : {})
      }
    });
  } catch (err) {
    console.error('createReduction error:', err);
    res.status(500).json({ success:false, message:'Failed to create reduction', error: err.message });
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
exports.getReduction = async (req, res) => {
  try {
    const { clientId, projectId } = req.params;

    // Client existence + view permission (same as list)
    const client = await Client.findOne({ clientId }).select("_id clientId");
    if (!client) return res.status(404).json({ success:false, message:'Client not found' });

    const access = await canAccessReductions(req.user, clientId);
    if (!access.allowed) {
      return res.status(403).json({ success:false, message:'Permission denied', reason: access.reason });
    }

    const doc = await Reduction.findOne({ clientId, projectId, isDeleted:false });
    if (!doc) return res.status(404).json({ success:false, message:'Not found' });

    res.status(200).json({ success:true, data: doc });
  } catch (err) {
    console.error('getReduction error:', err);
    res.status(500).json({ success:false, message:'Failed to fetch reduction', error: err.message });
  }
};


// controllers/Reduction/reductionController.js

exports.getAllReductions = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      clientId: clientIdFilter,
      q,                         // optional text query (projectName)
      includeDeleted = 'false',  // set to 'true' to include soft-deleted
      sort = '-createdAt'        // default newest first
    } = req.query;

    const role = req.user?.userType;
    const userId = req.user?.id;

    if (!role || !userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    // ---- Base filter (exclude soft-deleted by default) ----
    const filter = {};
    if (includeDeleted !== 'true') {
      filter.$or = [{ isDeleted: { $exists: false } }, { isDeleted: false }];
    }

    // quick text search on projectName (case-insensitive)
    if (q && String(q).trim()) {
      filter.projectName = { $regex: new RegExp(String(q).trim(), 'i') };
    }

    // optional hard client filter (allowed for super_admin & consultant roles; ignored otherwise)
    const applyClientIdFilter = (cid) => {
      if (cid && String(cid).trim()) filter.clientId = String(cid).trim();
    };

    // ---- Role-specific scoping ----
    if (role === 'super_admin') {
      // full access
      applyClientIdFilter(clientIdFilter);
    }

    else if (role === 'consultant_admin') {
      // Created by admin OR by any consultant under this admin
      const teamConsultants = await User.find({
        userType: 'consultant',
        consultantAdminId: userId,
        isActive: true
      }).select('_id');

      const ids = [userId, ...teamConsultants.map(u => u._id)];
      filter.$and = (filter.$and || []).concat([{ createdBy: { $in: ids } }]);

      applyClientIdFilter(clientIdFilter);
    }

    else if (role === 'consultant') {
      // (A) reductions created by this consultant
      // (B) reductions for clients assigned to this consultant
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

      applyClientIdFilter(clientIdFilter);
    }

    else if (
      role === 'client_admin' ||
      role === 'client_employee_head' ||
      role === 'employee' ||
      role === 'viewer' ||
      role === 'auditor'
    ) {
      // Restrict strictly to their organization
      if (!req.user.clientId) {
        return res.status(403).json({ success: false, message: 'No client scope for this user' });
      }
      filter.clientId = req.user.clientId;
    }

    else {
      return res.status(403).json({ success: false, message: 'Forbidden role' });
    }

    // ---- Query & pagination ----
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(100, Math.max(1, Number(limit)));

    const query = Reduction.find(filter)
      .sort(sort)
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .populate('createdBy', 'userName userType email') // nice-to-have context
      .lean();

    const [items, total] = await Promise.all([
      query,
      Reduction.countDocuments(filter)
    ]);

    return res.status(200).json({
      success: true,
      total,
      page: pageNum,
      limit: limitNum,
      data: items
    });
  } catch (err) {
    console.error('getAllReductions error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch reductions',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};





/** Update + recalc */
/** Update + recalc */
exports.updateReduction = async (req, res) => {
  try {
    const { clientId, projectId } = req.params;
    const perm = await canCreateOrEdit(req.user, clientId);
    if (!perm.ok) {
      return res.status(403).json({ success: false, message: perm.reason });
    }

    const doc = await Reduction.findOne({ clientId, projectId, isDeleted: false });
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Not found' });
    }

    // ---------- 1) Unpack body ----------
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

    // ---------- 2) Optional reductionDataEntry (manual / API / IOT) ----------
    let reductionEntryPayload = null;
    const hasEntry =
      Object.prototype.hasOwnProperty.call(body, 'reductionDataEntry') ||
      Object.prototype.hasOwnProperty.call(body, 'reductionDateEntry');

    if (hasEntry) {
      try {
        const incomingEntry = readReductionEntryFromBody(body);
        reductionEntryPayload = normalizeReductionDataEntry(incomingEntry);
      } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
      }
    }

    // ---------- 3) Optional processFlow payload ----------
    let processFlowPayload;
    if (body.processFlow) {
      processFlowPayload = normalizeProcessFlow(body.processFlow, req.user);
    }

    // ---------- 4) Patch basic project fields ----------
    if (projectName != null)       doc.projectName = projectName;
    if (projectActivity != null)   doc.projectActivity = projectActivity;
    if (scope != null)             doc.scope = scope;
    if (category != null)          doc.category = category;

    if (location) {
      doc.location.latitude  = location.latitude  ?? doc.location.latitude;
      doc.location.longitude = location.longitude ?? doc.location.longitude;

      if (Object.prototype.hasOwnProperty.call(location, 'place')) {
        doc.location.place = location.place ?? doc.location.place;
      }
      if (Object.prototype.hasOwnProperty.call(location, 'address')) {
        doc.location.address = location.address ?? doc.location.address;
      }
    }

    if (commissioningDate) doc.commissioningDate = new Date(commissioningDate);
    if (endDate)           doc.endDate           = new Date(endDate);
    if (description != null)           doc.description = description;
    if (baselineMethod != null)        doc.baselineMethod = baselineMethod;
    if (baselineJustification != null) doc.baselineJustification = baselineJustification;

    if (calculationMethodology) {
      doc.calculationMethodology = calculationMethodology;
    }

    // ---------- 5) Methodology-specific data (M1 / M2) ----------

    // M1 (ABD/APD/ALD + bufferPercent)
    if (doc.calculationMethodology === 'methodology1' && m1) {
      if (Array.isArray(m1.ABD)) {
        doc.m1.ABD = m1.ABD.map(normalizeUnitItem('B'));
      }
      if (Array.isArray(m1.APD)) {
        doc.m1.APD = m1.APD.map(normalizeUnitItem('P'));
      }
      if (Array.isArray(m1.ALD)) {
        doc.m1.ALD = m1.ALD.map(normalizeUnitItem('L'));
      }
      if (m1.bufferPercent != null) {
        doc.m1.bufferPercent = Number(m1.bufferPercent);
      }
      // (optional) leave doc.m2 as is; it is ignored when methodology1
    }

    // M2 (ALD + formulaRef)
    if (doc.calculationMethodology === 'methodology2' && m2) {
      doc.m2 = normalizeM2FromBody(m2);
      // (optional) M1 is kept as historical config; not used when methodology2
    }

    // ---------- 6) reductionDataEntry (input type / endpoint / device) ----------
    if (reductionEntryPayload) {
      doc.reductionDataEntry = {
        ...(doc.reductionDataEntry?.toObject?.() ?? {}),
        ...reductionEntryPayload
      };
    }

    // ---------- 7) processFlow (snapshot / mapping / version bump) ----------
    if (processFlowPayload) {
      if (!doc.processFlow) doc.processFlow = {};

      if (processFlowPayload.mode) {
        doc.processFlow.mode = processFlowPayload.mode;
      }

      if (Object.prototype.hasOwnProperty.call(processFlowPayload, 'flowchartId')) {
        doc.processFlow.flowchartId = processFlowPayload.flowchartId;
      }

      if (processFlowPayload.mapping) {
        doc.processFlow.mapping = processFlowPayload.mapping;
      }

      if (processFlowPayload.snapshot) {
        const prevVer = Number(doc.processFlow.snapshot?.metadata?.version || 0);
        const nextVer =
          prevVer > 0
            ? prevVer + 1
            : (processFlowPayload.snapshot.metadata?.version || 1);

        processFlowPayload.snapshot.metadata =
          processFlowPayload.snapshot.metadata || {};
        processFlowPayload.snapshot.metadata.version = nextVer;

        doc.processFlow.snapshot = processFlowPayload.snapshot;
        doc.processFlow.snapshotCreatedAt = new Date();
        doc.processFlow.snapshotCreatedBy = req.user?.id;
      }
    }

    // ---------- 8) Media uploads (coverImage + extra images) ----------
    try {
      await saveReductionFiles(req, doc);
    } catch (moveErr) {
      console.warn('⚠ saveReductionFiles(update) warning:', moveErr.message);
    }

    // ---------- 9) Recalculate + save ----------
    await doc.validate(); // invokes pre('validate') in model to recompute M1/M2, endpoints, etc.
    await doc.save();

    // ---------- 10) Notifications / workflow sync ----------
    notifyReductionEvent({
      actor: req.user,
      clientId,
      action: 'updated',
      doc
    }).catch(() => {});

    syncReductionWorkflow(clientId, req.user?.id).catch(() => {});

    return res.status(200).json({ success: true, message: 'Updated', data: doc });
  } catch (err) {
    console.error('updateReduction error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to update reduction',
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
    syncReductionWorkflow(clientId, req.user?.id).catch(() => {}); 

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
    syncReductionWorkflow(clientId, req.user?.id).catch(() => {}); // ✅ add thi

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
    syncReductionWorkflow(clientId, req.user?.id).catch(() => {}); 
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

