// controllers/reductionController.js
const Reduction = require('../../models/Reduction/Reduction');
const Client = require('../../models/Client');
const User = require('../../models/User');
const { canManageFlowchart } = require("../../utils/Permissions/permissions");
const { notifyReductionEvent } = require('../../utils/notifications/reductionNotifications');
const { syncReductionWorkflow } = require('../../utils/Workflow/workflow');




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

  // accept { m2: { formulaRef:{...} } } or flattened { m2:{ formulaId, version, frozenValues } }
  const ref = raw.formulaRef || {};
  const formulaId = ref.formulaId || raw.formulaId;
  const version   = ref.version != null ? Number(ref.version) :
                    (raw.version != null ? Number(raw.version) : undefined);

  // frozen values: allow { variables:{ A:{value,..}, ... } } or { frozenValues:{ A: 123, ... } }
  const incomingVars = ref.variables || raw.frozenValues || {};
  const varsObj = {};
  for (const [k, v] of Object.entries(incomingVars)) {
    const val = (v && typeof v === 'object' && 'value' in v) ? v.value : v;
    const pol = (v && typeof v === 'object' && v.updatePolicy) ? v.updatePolicy : 'manual';
    const ts  = (v && typeof v === 'object' && v.lastUpdatedAt) ? new Date(v.lastUpdatedAt) : new Date();
    varsObj[k] = { value: Number(val ?? 0), updatePolicy: pol, lastUpdatedAt: ts };
  }

  if (formulaId) {
    out.formulaRef = {
      formulaId,
      ...(version != null ? { version } : {}),
      ...(Object.keys(varsObj).length ? { variables: varsObj } : {})
    };
  }
  return out;
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
      ...(processFlowPayload ? { processFlow: processFlowPayload } : {}) // ✅ correct source

    });
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
    uncertainty: Number(it?.uncertainty ?? 0)
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
exports.updateReduction = async (req, res) => {
  try {
    const { clientId, projectId } = req.params;
    const perm = await canCreateOrEdit(req.user, clientId);
    if (!perm.ok) return res.status(403).json({ success:false, message: perm.reason });

    const doc = await Reduction.findOne({ clientId, projectId, isDeleted:false });
    if (!doc) return res.status(404).json({ success:false, message:'Not found' });

    // Patch allowed fields
    const body = req.body || {};
    if (body.projectName != null) doc.projectName = body.projectName;
    if (body.projectActivity != null) doc.projectActivity = body.projectActivity;
    if (body.scope != null) doc.scope = body.scope;
    if (body.location) {
  doc.location.latitude  = body.location.latitude  ?? doc.location.latitude;
  doc.location.longitude = body.location.longitude ?? doc.location.longitude;
  if (Object.prototype.hasOwnProperty.call(body.location, 'place')) {
    doc.location.place = body.location.place ?? doc.location.place;
  }
  if (Object.prototype.hasOwnProperty.call(body.location, 'address')) {
    doc.location.address = body.location.address ?? doc.location.address;
  }
}


    if (body.commissioningDate) doc.commissioningDate = new Date(body.commissioningDate);
    if (body.endDate)           doc.endDate           = new Date(body.endDate);
    if (body.description != null) doc.description = body.description;

    if (body.baselineMethod != null) doc.baselineMethod = body.baselineMethod;
    if (body.baselineJustification != null) doc.baselineJustification = body.baselineJustification;

    if (body.calculationMethodology) doc.calculationMethodology = body.calculationMethodology;

    if (doc.calculationMethodology === 'methodology1' && body.m1) {
      if (Array.isArray(body.m1.ABD)) doc.m1.ABD = body.m1.ABD.map(normalizeUnitItem('B'));
      if (Array.isArray(body.m1.APD)) doc.m1.APD = body.m1.APD.map(normalizeUnitItem('P'));
      if (Array.isArray(body.m1.ALD)) doc.m1.ALD = body.m1.ALD.map(normalizeUnitItem('L'));
      if (body.m1.bufferPercent != null) doc.m1.bufferPercent = Number(body.m1.bufferPercent);
    }

    if (req.body.processFlow) {
  const pf = normalizeProcessFlow(req.body.processFlow, req.user);

  if (pf) {
    if (!doc.processFlow) doc.processFlow = {};
    if (pf.mode) doc.processFlow.mode = pf.mode;
    if (pf.hasOwnProperty('flowchartId')) {
      doc.processFlow.flowchartId = pf.flowchartId;
    }
    if (pf.mapping) {
      doc.processFlow.mapping = pf.mapping;
    }
    if (pf.snapshot) {
      // version bump (if existing snapshot)
      const prevVer = Number(doc.processFlow.snapshot?.metadata?.version || 0);
      const nextVer = prevVer > 0 ? prevVer + 1 : (pf.snapshot.metadata?.version || 1);
      pf.snapshot.metadata = pf.snapshot.metadata || {};
      pf.snapshot.metadata.version = nextVer;

      doc.processFlow.snapshot = pf.snapshot;
      doc.processFlow.snapshotCreatedAt = new Date();
      doc.processFlow.snapshotCreatedBy = req.user?.id;
    }
  }
}


    await doc.validate(); // will recompute in pre('validate')
    await doc.save();
        notifyReductionEvent({
          actor: req.user,
          clientId,
          action: 'updated',
          doc
       }).catch(() => {});
       syncReductionWorkflow(clientId, req.user?.id).catch(() => {});

    res.status(200).json({ success:true, message:'Updated', data: doc });
  } catch (err) {
    console.error('updateReduction error:', err);
    res.status(500).json({ success:false, message:'Failed to update reduction', error: err.message });
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
