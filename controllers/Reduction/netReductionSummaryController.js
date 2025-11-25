// controllers/Reduction/netReductionSummaryController.js
const moment = require('moment');
const SummaryNetReduction = require('../../models/Reduction/SummaryNetReduction');
const NetReductionEntry   = require('../../models/Reduction/NetReductionEntry');
const Reduction           = require('../../models/Reduction/Reduction');
const Client              = require('../../models/Client');
const EmissionSummary    = require('../../models/CalculationEmission/EmissionSummary');

// --- Socket wiring for real-time net-reduction summary updates ---
let io;
exports.setSocketIO = (socketIO) => { io = socketIO; };

// Emit to both legacy & current client rooms + the summary room
function emitNRS(eventType, payload) {
  if (!io || !payload?.clientId) return;
  const data = { eventType, timestamp: new Date().toISOString(), ...payload };
  io.to(`client_${payload.clientId}`).emit(eventType, data); // current
  io.to(`client-${payload.clientId}`).emit(eventType, data); // legacy
  io.to(`summaries-${payload.clientId}`).emit(eventType, data); // summary stream
}



function round6(n){ return Math.round((Number(n)||0)*1e6)/1e6; }

// ---- access: same visibility model as listNetReductions (super_admin, consultant_admin for created leads,
//      consultant for assigned, client_admin for own org) ----
async function getAllowedClientIds(user, specificClientId) {
  if (!user) throw new Error('Unauthenticated');

  if (user.userType === 'super_admin') {
    return specificClientId ? [specificClientId] : null; // null = all
  }

  if (user.userType === 'client_admin') {
    if (!user.clientId) throw new Error('Your account has no clientId bound');
    if (specificClientId && specificClientId !== user.clientId) {
      throw new Error('Permission denied for this clientId');
    }
    return [user.clientId];
  }

  if (user.userType === 'consultant_admin') {
    const created = await Client.find({ 'leadInfo.createdBy': user.id }).select('clientId');
    const ids = created.map(c => c.clientId);
    if (specificClientId && !ids.includes(specificClientId)) {
      throw new Error('Permission denied for this clientId');
    }
    return specificClientId ? [specificClientId] : ids;
  }

  if (user.userType === 'consultant') {
    const assigned = await Client.find({ 'leadInfo.assignedConsultantId': user.id }).select('clientId');
    const ids = assigned.map(c => c.clientId);
    if (specificClientId && !ids.includes(specificClientId)) {
      throw new Error('Permission denied for this clientId');
    }
    return specificClientId ? [specificClientId] : ids;
  }

  throw new Error('Forbidden');
}

/**
 * Small helper: round to 6 decimals, like netReductionController.
 */

function round6(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6;
}

/**
 * Helper: accumulate totals in a Map keyed by string
 */
function bumpGroup(map, key, delta) {
  const k = key || 'Unknown';
  const prev = map.get(k) || { totalNetReduction: 0, entriesCount: 0 };
  prev.totalNetReduction = round6(prev.totalNetReduction + (Number(delta) || 0));
  prev.entriesCount += 1;
  map.set(k, prev);
}


/**
 * Core recompute for ONE clientId.
 * - Reads reductions for client (not deleted)
 * - Aggregates NetReductionEntry by project
 * - Builds project stats + 7/30 day windows + daily series (recent 30 days)
 * - Writes/Upserts SummaryNetReduction
 */
async function recomputeForClient(clientId) {
  // 1) Pull reductions (metadata to enrich projects)
  const reductions = await Reduction.find({ clientId, isDeleted: false }).lean();
  const metaByProject = new Map();
  reductions.forEach(r => {
    metaByProject.set(r.projectId, {
      reductionId: r.reductionId,
      projectName: r.projectName,
      calculationMethodology: r.calculationMethodology,
      scope: r.scope || '',
      category: r.category || '',
      locationPlace: r?.location?.place || '',
      inputType: r?.reductionDataEntry?.inputType || 'manual'
    });
  });

  if (!reductions.length) {
    // no reductions → write empty summary
   const doc = await SummaryNetReduction.findOneAndUpdate(
  { clientId },
  {
    clientId,
    totals: { projects: 0, entries: 0, totalNetReduction: 0, avgPerProject: 0 },
    byProject: [],
    byScope: [], byCategory: [], byLocation: [],
    lastComputedAt: new Date()
  },
  { upsert: true, new: true }
);
// 🔔 notify listeners that summary changed
emitNRS('net-reduction:summary-updated', {
  clientId,
  summary: {
    totals: doc.totals,
    lastComputedAt: doc.lastComputedAt,
  }
});
return;
  }

  // 2) Aggregate entries by projectId for this client
  //    - totalNet, entries, firstDate, lastDate, last cumulative/high/low
  //    - plus 7/30 day window sums and daily series (last 30 d)
  const since30 = moment().utcOffset('+05:30').startOf('day').subtract(29, 'days').toDate();
  const entries = await NetReductionEntry.aggregate([
    { $match: { clientId } },
    {
      $group: {
        _id: '$projectId',
        entries: { $sum: 1 },
        totalNet: { $sum: '$netReduction' },
        firstDate: { $min: '$timestamp' },
        lastDate:  { $max: '$timestamp' }
      }
    }
  ]);

  // fetch latest doc per project to get latest cumulative/high/low
  const latestByProject = await NetReductionEntry.aggregate([
    { $match: { clientId } },
    { $sort: { projectId: 1, timestamp: -1 } },
    {
      $group: {
        _id: '$projectId',
        latestCumulative: { $first: '$cumulativeNetReduction' },
        high: { $first: '$highNetReduction' },
        low:  { $first: '$lowNetReduction' }
      }
    }
  ]);

  // 7 day and 30 day windows per project
  const since7 = moment().utcOffset('+05:30').startOf('day').subtract(6, 'days').toDate();
  const windows = await NetReductionEntry.aggregate([
    {
      $match: {
        clientId,
        timestamp: { $gte: since30 }
      }
    },
    {
      $project: {
        projectId: 1,
        netReduction: 1,
        day: { $dateToString: { format: '%d/%m/%Y', date: '$timestamp', timezone: '+05:30' } },
        ts: '$timestamp'
      }
    },
    {
      $group: {
        _id: { projectId: '$projectId', day: '$day' },
        dayTotal: { $sum: '$netReduction' },
        dayStart: { $min: '$ts' }
      }
    },
    { $sort: { '_id.projectId': 1, dayStart: 1 } }
  ]);

  const latestIdx = new Map(latestByProject.map(r => [r._id, r]));
  // build series + 7/30 totals
  const seriesByProject = new Map(); // projectId -> [{day, dayStart, dayTotal}]
  const win7ByProject = new Map();   // projectId -> total
  const win30ByProject = new Map();  // projectId -> total

  windows.forEach(w => {
    const pid = w._id.projectId;
    if (!seriesByProject.has(pid)) seriesByProject.set(pid, []);
    seriesByProject.get(pid).push({ day: w._id.day, dayStart: w.dayStart, dayTotal: round6(w.dayTotal) });

    // 30-day bucket (we already filtered since30)
    const prev30 = win30ByProject.get(pid) || 0;
    win30ByProject.set(pid, round6(prev30 + w.dayTotal));

    // 7-day bucket
    if (w.dayStart >= since7) {
      const prev7 = win7ByProject.get(pid) || 0;
      win7ByProject.set(pid, round6(prev7 + w.dayTotal));
    }
  });

  // 3) Assemble byProject
  const byProject = entries.map(e => {
    const pid = e._id;
    const meta = metaByProject.get(pid) || {};
    const last = latestIdx.get(pid) || {};
    return {
      projectId: pid,
      reductionId: meta.reductionId || '',
      projectName: meta.projectName || '',
      calculationMethodology: meta.calculationMethodology,
      scope: meta.scope,
      category: meta.category,
      locationPlace: meta.locationPlace,
      inputType: meta.inputType,

      stats: {
        entries: e.entries || 0,
        totalNet: round6(e.totalNet || 0),
        firstDate: e.firstDate || null,
        lastDate: e.lastDate || null,
        latestCumulative: round6(last.latestCumulative || 0),
        high: round6(last.high || 0),
        low:  round6(last.low || 0)
      },

      last7DaysTotal:  round6(win7ByProject.get(pid) || 0),
      last30DaysTotal: round6(win30ByProject.get(pid) || 0),
      timeseries: (seriesByProject.get(pid) || [])
        .sort((a,b)=>a.dayStart-b.dayStart)
        .slice(-30)
    };
  });

  // 4) Totals
  const totals = {
    projects: reductions.length,
    entries: byProject.reduce((s,p)=> s + (p.stats.entries||0), 0),
    totalNetReduction: round6(byProject.reduce((s,p)=> s + (p.stats.totalNet||0), 0))
  };
  totals.avgPerProject = totals.projects ? round6(totals.totalNetReduction / totals.projects) : 0;

  // 5) Rollups (scope/category/location)
  function rollup(key) {
    const map = new Map();
    byProject.forEach(p => {
      const k = (p[key] || '').trim();
      const item = map.get(k) || { key: k, projects: 0, totalNet: 0 };
      item.projects += 1;
      item.totalNet = round6(item.totalNet + (p.stats.totalNet || 0));
      map.set(k, item);
    });
    return Array.from(map.values()).sort((a,b)=> b.totalNet - a.totalNet);
  }

  const byScope    = rollup('scope');
  const byCategory = rollup('category');
  const byLocation = rollup('locationPlace');

  // 6) Upsert summary doc
  await SummaryNetReduction.findOneAndUpdate(
    { clientId },
    {
      clientId,
      totals,
      byProject,
      byScope,
      byCategory,
      byLocation,
      lastComputedAt: new Date()
    },
    { upsert: true, new: true }
  );
}

/**
 * Recompute the *reduction* side of CalculationSummary
 * for a client, using NetReductionEntry + Reduction metadata.
 *
 * This writes into EmissionSummary.reductionSummary
 * for period.type === 'all-time' (creating the doc if needed).
 */
async function recomputeClientNetReductionSummary(clientId) {
  if (!clientId) return null;

  // 1) Load all net reduction entries for this client
  const entries = await NetReductionEntry.find({ clientId }).lean();
  if (!entries || !entries.length) {
    // If no reduction data, clear the reductionSummary field
    await EmissionSummary.updateMany(
      { clientId, 'period.type': 'all-time' },
      {
        $unset: {
          reductionSummary: '',
          'metadata.hasReductionSummary': '',
          'metadata.lastReductionSummaryCalculatedAt': ''
        }
      }
    );
    return null;
  }

  // 2) Load project metadata (category, scope, location, projectActivity, etc.)
  const projectIds = [...new Set(entries.map(e => e.projectId).filter(Boolean))];
  const projects   = await Reduction
    .find({ clientId, projectId: { $in: projectIds }, isDeleted: { $ne: true } })
    .select('projectId projectName projectActivity category scope location calculationMethodology')
    .lean();

  const projectMeta = new Map();
  for (const p of projects) {
    projectMeta.set(p.projectId, p);
  }

  // 3) Aggregation containers
  let totalNetReduction = 0;
  const entriesCount    = entries.length;

  const byProject         = new Map(); // key=projectId -> big row
  const byCategory        = new Map();
  const byScope           = new Map();
  const byLocation        = new Map();
  const byProjectActivity = new Map();
  const byMethodology     = new Map();

  // 4) Walk through each NetReductionEntry and aggregate
  for (const e of entries) {
    const net = Number(e.netReduction || 0);
    totalNetReduction = round6(totalNetReduction + net);

    const projectId = e.projectId || 'unknown-project';
    const meta      = projectMeta.get(projectId) || {};

    const projectName     = meta.projectName     || projectId;
    const projectActivity = meta.projectActivity || null;
    const category        = meta.category        || null;
    const scope           = meta.scope           || null;

    let locationLabel = null;
    if (meta.location) {
      const { place, address, latitude, longitude } = meta.location;
      if (place) {
        locationLabel = place;
      } else if (address) {
        locationLabel = address;
      } else if (latitude != null && longitude != null) {
        locationLabel = `${latitude},${longitude}`;
      }
    }

    const methodology = e.calculationMethodology || meta.calculationMethodology || 'unknown';

    // ---- byProject ----
    const pRow = byProject.get(projectId) || {
      projectId,
      projectName,
      projectActivity,
      category,
      scope,
      location:   locationLabel,
      methodology,
      totalNetReduction: 0,
      entriesCount:      0
    };

    // Keep metadata consistent (if later entries have better meta)
    if (!pRow.projectActivity && projectActivity) pRow.projectActivity = projectActivity;
    if (!pRow.category && category)               pRow.category        = category;
    if (!pRow.scope && scope)                     pRow.scope           = scope;
    if (!pRow.location && locationLabel)          pRow.location        = locationLabel;
    if (!pRow.methodology && methodology)         pRow.methodology     = methodology;

    pRow.totalNetReduction = round6(pRow.totalNetReduction + net);
    pRow.entriesCount     += 1;
    byProject.set(projectId, pRow);

    // ---- other groupings ----
    bumpGroup(byCategory,        category,        net);
    bumpGroup(byScope,           scope,           net);
    bumpGroup(byLocation,        locationLabel,   net);
    bumpGroup(byProjectActivity, projectActivity, net);
    bumpGroup(byMethodology,     methodology,     net);
  }

  // 5) Convert Maps -> plain structures for Mongo/JSON
  const mapToPlainObject = (map) => {
    const obj = {};
    for (const [k, v] of map.entries()) {
      obj[k] = v;
    }
    return obj;
  };

  const reductionSummary = {
    totalNetReduction: round6(totalNetReduction),
    entriesCount,

    // List of projects
    byProject: Array.from(byProject.values()),

    // Grouped objects
    byCategory:        mapToPlainObject(byCategory),
    byScope:           mapToPlainObject(byScope),
    byLocation:        mapToPlainObject(byLocation),
    byProjectActivity: mapToPlainObject(byProjectActivity),
    byMethodology:     mapToPlainObject(byMethodology)
  };

  // 6) Upsert into EmissionSummary for "all-time" period
  const now = new Date();
  const query = { clientId, 'period.type': 'all-time' };
  const update = {
    $set: {
      reductionSummary,
      'metadata.hasReductionSummary': true,
      'metadata.lastReductionSummaryCalculatedAt': now
    },
    $setOnInsert: {
      clientId,
      period: { type: 'all-time' }
    }
  };

  await EmissionSummary.findOneAndUpdate(query, update, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true
  });

  return reductionSummary;
}

/** GET summary for a client (recompute=false by default) */
exports.getClientSummary = async (req, res) => {
  try {
    const { clientId } = req.params;
    // visibility check
    await getAllowedClientIds(req.user, clientId);

    const { refresh } = req.query; // &refresh=true to force recompute
    if (String(refresh).toLowerCase() === 'true') {
      await recomputeForClient(clientId);
    }

    const doc = await SummaryNetReduction.findOne({ clientId }).lean();
    if (!doc) {
      // compute first time
      await recomputeForClient(clientId);
      const fresh = await SummaryNetReduction.findOne({ clientId }).lean();
      return res.status(200).json({ success: true, data: fresh || null });
    }
    return res.status(200).json({ success: true, data: doc });
  } catch (err) {
    return res.status(500).json({ success:false, message:'Failed to fetch summary', error: err.message });
  }
};

/** POST recompute summary now */
exports.recomputeClientSummaryNow = async (req, res) => {
  try {
    const { clientId } = req.params;
    await getAllowedClientIds(req.user, clientId); // authz
    await recomputeForClient(clientId);
    const doc = await SummaryNetReduction.findOne({ clientId }).lean();
    return res.status(200).json({ success: true, message: 'Recomputed', data: doc });
  } catch (err) {
    return res.status(500).json({ success:false, message:'Failed to recompute summary', error: err.message });
  }
};

/** GET one project’s slice from the summary (handy for dashboards) */
exports.getProjectSummary = async (req, res) => {
  try {
    const { clientId, projectId } = req.params;
    await getAllowedClientIds(req.user, clientId);

    // Ensure summary exists (lazy compute)
    let doc = await SummaryNetReduction.findOne({ clientId }).lean();
    if (!doc) {
      await recomputeForClient(clientId);
      doc = await SummaryNetReduction.findOne({ clientId }).lean();
    }
    const proj = doc?.byProject?.find(p => p.projectId === projectId);
    if (!proj) return res.status(404).json({ success:false, message:'Project summary not found' });
    return res.status(200).json({ success:true, data: proj });
  } catch (err) {
    return res.status(500).json({ success:false, message:'Failed to fetch project summary', error: err.message });
  }
};
