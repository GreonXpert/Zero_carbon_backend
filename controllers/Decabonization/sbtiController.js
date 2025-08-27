// controllers/Targets/sbtiController.js
const SbtiTarget = require('../../models/Decarbonization/SbtiTarget');
const { canManageFlowchart, canViewFlowchart } = require('../../utils/Permissions/permissions');

// Optional: real-time updates like your summaries do
let io;
const setSocketIO = (socketIO) => { io = socketIO; };
const emitSbtiUpdate = (clientId, payload) => {
  if (!io) return;
  io.to(`client-${clientId}`).emit('sbti-target-updated', { timestamp: new Date(), ...payload });
};

// ---------- Helpers (formulas from your doc) ----------
const safePct = (num, den) => {
  if (!den || den <= 0) return 0;
  return (num / den) * 100;
};
// clamp between 0 and 100
const clampPct = (v) => Math.max(0, Math.min(100, v));

// Absolute method:
// Annual rate % = MinimumReduction % / (TargetYear - BaseYear)  (linear)
// Emission_y = BaseEmission * (1 - annualRate% * k), where k = (y - baseYear)
function buildAbsoluteTrajectory(baseEmission, baseYear, targetYear, minimumReductionPercent) {
  const N = Math.max(1, targetYear - baseYear);
  const annualRatePercent = minimumReductionPercent / N;
  const points = [];
  for (let year = baseYear; year <= targetYear; year++) {
    const k = year - baseYear;
    const cumulativeReductionPercent = clampPct(annualRatePercent * k);
    const targetEmission = Math.max(0, baseEmission * (1 - (cumulativeReductionPercent / 100)));
    points.push({
      year, targetEmission_tCO2e: Number(targetEmission.toFixed(6)),
      cumulativeReductionPercent: Number(cumulativeReductionPercent.toFixed(4))
    });
  }
  return { annualRatePercent, points };
}

// SDA method (per doc):
// baseIntensity = baseEmission / baseActivity
// intensityReduction% = (1 - targetIntensity / baseIntensity) * 100
// absoluteTarget = targetIntensity * activityTarget
// absoluteReduction% = (1 - absoluteTarget / baseEmission) * 100
// annualReduction% = absoluteReduction% / N
// Then linearly interpolate each year like absolute method
function buildSdaTrajectory({
  baseEmission, baseActivity, targetIntensity, activityTarget,
  baseYear, targetYear
}) {
  const baseIntensity = baseActivity > 0 ? (baseEmission / baseActivity) : 0;
  const intensityReductionPercent = baseIntensity > 0
    ? (1 - (targetIntensity / baseIntensity)) * 100
    : 0;

  const absoluteTarget = (targetIntensity || 0) * (activityTarget || 0);
  const absoluteReductionPercent = baseEmission > 0
    ? (1 - (absoluteTarget / baseEmission)) * 100
    : 0;

  const N = Math.max(1, targetYear - baseYear);
  const annualReductionPercent = absoluteReductionPercent / N;

  const points = [];
  for (let year = baseYear; year <= targetYear; year++) {
    const k = year - baseYear;
    const cumulativeReductionPercent = clampPct(annualReductionPercent * k);
    const targetEmission = Math.max(0, baseEmission * (1 - (cumulativeReductionPercent / 100)));
    points.push({
      year, targetEmission_tCO2e: Number(targetEmission.toFixed(6)),
      cumulativeReductionPercent: Number(cumulativeReductionPercent.toFixed(4))
    });
  }

  return {
    baseIntensity,
    intensityReductionPercent: Number(intensityReductionPercent.toFixed(4)),
    absoluteTargetEmission_tCO2e: Number(absoluteTarget.toFixed(6)),
    absoluteReductionPercent: Number(absoluteReductionPercent.toFixed(4)),
    annualReductionPercent: Number(annualReductionPercent.toFixed(6)),
    points
  };
}

// Renewable Electricity %RE = (RenewableMWh / TotalMWh) * 100
function computeREPercent(yearRow) {
  const { renewableMWh = 0, totalMWh = 0 } = yearRow;
  if (totalMWh <= 0) return 0;
  return (renewableMWh / totalMWh) * 100;
}

// Supplier engagement: % = (covered / total) * 100
function computeSupplierPercent(row) {
  const { coveredEmissions_tCO2e = 0, totalSupplierEmissions_tCO2e = 0 } = row;
  if (totalSupplierEmissions_tCO2e <= 0) return 0;
  return (coveredEmissions_tCO2e / totalSupplierEmissions_tCO2e) * 100;
}

// Coverage checks (doc thresholds)
// S1+S2 coverage ≥95%; Scope 3 coverage ≥67% (near-term) and ≥90% (net-zero)
// Scope 3 materiality: share ≥40% of total
function evaluateCoverage(cov, targetType) {
  const meetsNearTermS3 = cov.scope3CoveragePercent >= 67;
  const meetsNetZeroS3 = cov.scope3CoveragePercent >= 90;
  return {
    ...cov,
    scope12CoveragePercent: Number(cov.scope12CoveragePercent || 0),
    scope3ShareOfTotalPercent: Number(cov.scope3ShareOfTotalPercent || 0),
    scope3CoveragePercent: Number(cov.scope3CoveragePercent || 0),
    meetsNearTermS3,
    meetsNetZeroS3
  };
}

// FLAG: target required if flagShare% ≥20% and coverage should be S1 ≥95% & S3 ≥67%
function evaluateFlag(flag) {
  const isReq = (flag.flagSharePercent || 0) >= 20;
  const coverageOk = (flag.scope1CoveragePercent || 0) >= 95 && (flag.scope3CoveragePercent || 0) >= 67;
  return {
    ...flag,
    isFlagTargetRequired: isReq,
    coverageOk: isReq ? coverageOk : true
  };
}

// SBTi defaults from your doc (examples):
// - Linear reduction example 4.2%/yr for a 1.5°C pathway
// - Near-term: minimum reduction 42% by 2030; Long-term: 90% by 2050
function inferDefaultMinimumReductionPercent(alignment, targetType, targetYear) {
  if (alignment !== 'SBTi') return null;
  if (targetType === 'near_term' && targetYear <= 2030) return 42;
  if (targetType === 'net_zero' && targetYear >= 2050) return 90;
  // fallback: null => must be provided by user
  return null;
}

// ---------- Controllers ----------

// Create/Update a target definition
// POST /api/sbti/:clientId/targets
const upsertTarget = async (req, res) => {
  try {
        const { clientId } = req.params;

    // 0) auth required
if (!req.user || (!req.user._id && !req.user.id)) {
  return res.status(401).json({ success: false, message: 'Authentication required' });
}

// 1) role gate (same as flowchart manage)
if (!['super_admin','consultant_admin','consultant'].includes(req.user.userType)) {
  return res.status(403).json({ success: false, message: 'Only Super Admin, Consultant Admin, or Consultant can manage SBTi targets' });
}

// 2) permission check (client scoping)
const managePerm = await canManageFlowchart(req.user, clientId);
if (!managePerm.allowed) {
  return res.status(403).json({ success: false, message: 'Permission denied', reason: managePerm.reason });
}

    const {
      alignment = 'SBTi',
      targetType,               // 'near_term' | 'net_zero'
      method,                   // 'absolute' | 'sda'
      baseYear, targetYear,

       // NEW: considered scope and per-scope bases (tCO2e)
      scopeSet = 'S1S2',        // 'S1S2' or 'S3'
      baseScope1_tCO2e = 0,
      baseScope2_tCO2e = 0,
      baseScope3_tCO2e = 0,

      baseEmission_tCO2e,

      perScopeBase_tCO2e,       // optional map

      // absolute
      minimumReductionPercent,  // optional; defaulted if SBTi near/net
      annualRateHintPercent,    // optional override

      // sda
      baseActivity,
      targetIntensity,
      activityTarget,
      intensityUnit,

      // coverage
      coverage, // {scope12CoveragePercent, scope3ShareOfTotalPercent, scope3CoveragePercent}

      // flag
      flag,     // {flagSharePercent, scope1CoveragePercent, scope3CoveragePercent}

      // tool version
      toolVersion, toolUpdatedAt,
    } = req.body;

        // >>> INSERT THIS BLOCK RIGHT HERE (immediately after destructuring) <<<
    // Auto-compute base emission depending on considered scope
    const s1 = Number(baseScope1_tCO2e || 0);
    const s2 = Number(baseScope2_tCO2e || 0);
    const s3 = Number(baseScope3_tCO2e || 0);

    const baseEmissionComputed = (scopeSet === 'S3') ? s3 : (s1 + s2);
    const perScopeBaseMap = (scopeSet === 'S3')
      ? { 'Scope 3': s3 }
      : { 'Scope 1': s1, 'Scope 2': s2 };
    // >>> END INSERT <<<


    if (!['near_term', 'net_zero'].includes(targetType)) {
      return res.status(400).json({ success: false, message: 'Invalid targetType' });
    }
    if (!['absolute', 'sda'].includes(method)) {
      return res.status(400).json({ success: false, message: 'Invalid method' });
    }

    const N = Math.max(1, (targetYear - baseYear));
    let trajectory = [];
    const updateDoc = {
  clientId,
  alignment, targetType, method,
  baseYear, targetYear,

  // NEW: persist separate bases and which scope set is considered
  scopeSet,
  baseScope1_tCO2e: s1,
  baseScope2_tCO2e: s2,
  baseScope3_tCO2e: s3,

  // Auto-computed base and per-scope map (server is source of truth)
  baseEmission_tCO2e: baseEmissionComputed,
  perScopeBase_tCO2e: new Map(Object.entries(perScopeBaseMap)),

  updatedBy: req.user?._id
};

    // --- Compute trajectory by method ---
    if (method === 'absolute') {
      const minRed = (minimumReductionPercent != null)
        ? minimumReductionPercent
        : inferDefaultMinimumReductionPercent(alignment, targetType, targetYear);

      if (minRed == null) {
        return res.status(400).json({ success: false, message: 'minimumReductionPercent is required for absolute method (no default inferred)' });
      }

      const { annualRatePercent, points } = buildAbsoluteTrajectory(
        baseEmissionComputed, baseYear, targetYear, minRed
      );

      updateDoc.absolute = {
        minimumReductionPercent: minRed,
        annualRatePercent: (annualRateHintPercent != null) ? annualRateHintPercent : Number(annualRatePercent.toFixed(6))
      };
      trajectory = points;

    } else if (method === 'sda') {
      if (!(baseActivity > 0) || !(targetIntensity >= 0) || !(activityTarget >= 0)) {
        return res.status(400).json({ success: false, message: 'SDA requires baseActivity, targetIntensity, activityTarget' });
      }

      const out = buildSdaTrajectory({
        baseEmission:baseEmissionComputed,
        baseActivity, targetIntensity, activityTarget,
        baseYear, targetYear
      });

      updateDoc.sda = {
        baseActivity,
        targetIntensity,
        activityTarget,
        intensityUnit: intensityUnit || 'tCO2e/unit',
        baseIntensity: out.baseIntensity,
        intensityReductionPercent: out.intensityReductionPercent,
        absoluteTargetEmission_tCO2e: out.absoluteTargetEmission_tCO2e,
        absoluteReductionPercent: out.absoluteReductionPercent,
        annualReductionPercent: out.annualReductionPercent
      };
      trajectory = out.points;
    }

    updateDoc.trajectory = trajectory;

    // --- Coverage & FLAG checks ---
    if (coverage) updateDoc.coverage = evaluateCoverage(coverage, targetType);
    if (flag) updateDoc.flag = evaluateFlag(flag);

    // --- Versioning / grace handling ---
    if (toolVersion) updateDoc.toolVersion = toolVersion;
    if (toolUpdatedAt) updateDoc.toolUpdatedAt = new Date(toolUpdatedAt);
    // grace dates computed in pre-save

    // Upsert by clientId + targetType (so you can store near-term and net-zero separately)
    const saved = await SbtiTarget.findOneAndUpdate(
      { clientId, targetType },
      { $set: updateDoc, $setOnInsert: { createdBy: req.user?._id } },
      { upsert: true, new: true, runValidators: true }
    );

    emitSbtiUpdate(clientId, { type: 'sbti-upsert', targetType, id: saved._id });
    return res.status(200).json({ success: true, data: saved });

  } catch (err) {
    console.error('upsertTarget error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/sbti/:clientId/targets?targetType=near_term|net_zero
const getTargets = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { targetType } = req.query;
    const query = { clientId };
    if (targetType) query.targetType = targetType;
    const docs = await SbtiTarget.find(query).lean();
    return res.status(200).json({ success: true, data: docs });
  } catch (err) {
    console.error('getTargets error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/sbti/:clientId/trajectory?targetType=near_term|net_zero
const getTrajectory = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { targetType } = req.query;
    if (!targetType) return res.status(400).json({ success: false, message: 'targetType is required' });

    const doc = await SbtiTarget.findOne({ clientId, targetType }).lean();
    if (!doc) return res.status(404).json({ success: false, message: 'Target not found' });

    return res.status(200).json({
      success: true,
      data: {
        clientId, targetType,
        baseYear: doc.baseYear,
        targetYear: doc.targetYear,
        method: doc.method,
        trajectory: doc.trajectory
      }
    });
  } catch (err) {
    console.error('getTrajectory error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/sbti/:clientId/track/renewable
// body: { year, renewableMWh, totalMWh }
const addRenewableProgress = async (req, res) => {
  try {
            // 0) auth required
        if (!req.user || (!req.user._id && !req.user.id)) {
        return res.status(401).json({ success: false, message: 'Authentication required' });
        }

        // 1) role gate (same as flowchart manage)
        if (!['super_admin','consultant_admin','consultant'].includes(req.user.userType)) {
        return res.status(403).json({ success: false, message: 'Only Super Admin, Consultant Admin, or Consultant can manage SBTi targets' });
        }

        // 2) permission check (client scoping)
        const managePerm = await canManageFlowchart(req.user, clientId);
        if (!managePerm.allowed) {
        return res.status(403).json({ success: false, message: 'Permission denied', reason: managePerm.reason });
        }

    const { clientId } = req.params;
    const { targetType = 'near_term' } = req.query;
    const { year, renewableMWh, totalMWh } = req.body;
    if (!year) return res.status(400).json({ success: false, message: 'year is required' });

    const doc = await SbtiTarget.findOne({ clientId, targetType });
    if (!doc) return res.status(404).json({ success: false, message: 'Target not found' });

    const percentRE = Number(computeREPercent({ renewableMWh, totalMWh }).toFixed(4));
    const idx = doc.renewableElectricity.findIndex(r => r.year === Number(year));
    const row = { year, renewableMWh, totalMWh, percentRE };

    if (idx >= 0) doc.renewableElectricity[idx] = row;
    else doc.renewableElectricity.push(row);

    await doc.save();
    emitSbtiUpdate(clientId, { type: 'sbti-renewable-updated', targetType, year });
    return res.status(200).json({ success: true, data: doc });
  } catch (err) {
    console.error('addRenewableProgress error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/sbti/:clientId/track/supplier-engagement
// body: { year, coveredEmissions_tCO2e, totalSupplierEmissions_tCO2e }
const addSupplierEngagement = async (req, res) => {
  try {

    // 0) auth required
if (!req.user || (!req.user._id && !req.user.id)) {
  return res.status(401).json({ success: false, message: 'Authentication required' });
}

// 1) role gate (same as flowchart manage)
if (!['super_admin','consultant_admin','consultant'].includes(req.user.userType)) {
  return res.status(403).json({ success: false, message: 'Only Super Admin, Consultant Admin, or Consultant can manage SBTi targets' });
}

// 2) permission check (client scoping)
const managePerm = await canManageFlowchart(req.user, clientId);
if (!managePerm.allowed) {
  return res.status(403).json({ success: false, message: 'Permission denied', reason: managePerm.reason });
}
    const { clientId } = req.params;
    const { targetType = 'near_term' } = req.query;
    const { year, coveredEmissions_tCO2e, totalSupplierEmissions_tCO2e } = req.body;
    if (!year) return res.status(400).json({ success: false, message: 'year is required' });

    const doc = await SbtiTarget.findOne({ clientId, targetType });
    if (!doc) return res.status(404).json({ success: false, message: 'Target not found' });

    const percent = Number(computeSupplierPercent({ coveredEmissions_tCO2e, totalSupplierEmissions_tCO2e }).toFixed(4));
    const idx = doc.supplierEngagement.findIndex(r => r.year === Number(year));
    const row = { year, coveredEmissions_tCO2e, totalSupplierEmissions_tCO2e, percentSuppliersWithSBTs: percent };

    if (idx >= 0) doc.supplierEngagement[idx] = row;
    else doc.supplierEngagement.push(row);

    await doc.save();
    emitSbtiUpdate(clientId, { type: 'sbti-supplier-updated', targetType, year });
    return res.status(200).json({ success: true, data: doc });
  } catch (err) {
    console.error('addSupplierEngagement error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/sbti/:clientId/track/flag
// body: { flagSharePercent, scope1CoveragePercent, scope3CoveragePercent }
const setFlagInfo = async (req, res) => {
  try {
    // 0) auth required
if (!req.user || (!req.user._id && !req.user.id)) {
  return res.status(401).json({ success: false, message: 'Authentication required' });
}

// 1) role gate (same as flowchart manage)
if (!['super_admin','consultant_admin','consultant'].includes(req.user.userType)) {
  return res.status(403).json({ success: false, message: 'Only Super Admin, Consultant Admin, or Consultant can manage SBTi targets' });
}

// 2) permission check (client scoping)
const managePerm = await canManageFlowchart(req.user, clientId);
if (!managePerm.allowed) {
  return res.status(403).json({ success: false, message: 'Permission denied', reason: managePerm.reason });
}
    const { clientId } = req.params;
    const { targetType = 'near_term' } = req.query;
    const doc = await SbtiTarget.findOne({ clientId, targetType });
    if (!doc) return res.status(404).json({ success: false, message: 'Target not found' });

    doc.flag = evaluateFlag({
      flagSharePercent: req.body.flagSharePercent,
      scope1CoveragePercent: req.body.scope1CoveragePercent,
      scope3CoveragePercent: req.body.scope3CoveragePercent
    });

    await doc.save();
    emitSbtiUpdate(clientId, { type: 'sbti-flag-updated', targetType });
    return res.status(200).json({ success: true, data: doc });
  } catch (err) {
    console.error('setFlagInfo error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PATCH /api/sbti/:clientId/coverage
// body: { scope12CoveragePercent, scope3ShareOfTotalPercent, scope3CoveragePercent }
const setCoverageInfo = async (req, res) => {
  try {
    // 0) auth required
if (!req.user || (!req.user._id && !req.user.id)) {
  return res.status(401).json({ success: false, message: 'Authentication required' });
}

// 1) role gate (same as flowchart manage)
if (!['super_admin','consultant_admin','consultant'].includes(req.user.userType)) {
  return res.status(403).json({ success: false, message: 'Only Super Admin, Consultant Admin, or Consultant can manage SBTi targets' });
}

// 2) permission check (client scoping)
const managePerm = await canManageFlowchart(req.user, clientId);
if (!managePerm.allowed) {
  return res.status(403).json({ success: false, message: 'Permission denied', reason: managePerm.reason });
}
    const { clientId } = req.params;
    const { targetType = 'near_term' } = req.query;

    // 1) Parse + validate inputs (accept numbers or numeric strings)
    const s12 = Number(req.body?.scope12CoveragePercent);
    const s3share = Number(req.body?.scope3ShareOfTotalPercent);
    const s3cov = Number(req.body?.scope3CoveragePercent);

    if (![s12, s3share, s3cov].every(n => Number.isFinite(n))) {
      return res.status(400).json({
        success: false,
        message: 'Provide numeric scope12CoveragePercent, scope3ShareOfTotalPercent, scope3CoveragePercent'
      });
    }

    const doc = await SbtiTarget.findOne({ clientId, targetType });
    if (!doc) return res.status(404).json({ success: false, message: 'Target not found' });

    // 2) Compute flags & store
    const newCoverage = evaluateCoverage({
      scope12CoveragePercent: s12,
      scope3ShareOfTotalPercent: s3share,
      scope3CoveragePercent: s3cov
    }, targetType);

    doc.coverage = newCoverage;

    // 3) If coverage is Mixed/Map in schema, ensure change detection
    const covPath = doc.schema.path('coverage');
    if (covPath && (covPath.instance === 'Mixed' || covPath.$isMongooseMap)) {
      doc.markModified('coverage');
    }

    await doc.save();

    // 4) Return a fresh copy to avoid any stale values on the in-memory doc
    const fresh = await SbtiTarget.findById(doc._id).lean();
    return res.status(200).json({ success: true, data: fresh });

  } catch (err) {
    console.error('setCoverageInfo error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
const setInventoryCoverage = async (req, res) => {
  try {
    // 0) auth required
if (!req.user || (!req.user._id && !req.user.id)) {
  return res.status(401).json({ success: false, message: 'Authentication required' });
}

// 1) role gate (same as flowchart manage)
if (!['super_admin','consultant_admin','consultant'].includes(req.user.userType)) {
  return res.status(403).json({ success: false, message: 'Only Super Admin, Consultant Admin, or Consultant can manage SBTi targets' });
}

// 2) permission check (client scoping)
const managePerm = await canManageFlowchart(req.user, clientId);
if (!managePerm.allowed) {
  return res.status(403).json({ success: false, message: 'Permission denied', reason: managePerm.reason });
}
    const { clientId } = req.params;
    const { targetType = 'near_term' } = req.query;

    const doc = await SbtiTarget.findOne({ clientId, targetType });
    if (!doc) return res.status(404).json({ success: false, message: 'Target not found' });

    const {
      s12TargetBoundary_tCO2e = 0,
      s12TotalInclExcluded_tCO2e = 0,
      s3Reported_tCO2e = 0,
      s3Excluded_tCO2e = 0,
      s3CategoriesWithTargets_tCO2e = 0,
      s3Total_tCO2e = 0
    } = req.body || {};

    const percentS12Covered = Number(safePct(s12TargetBoundary_tCO2e, s12TotalInclExcluded_tCO2e).toFixed(4));
    const percentS3Reported = Number(safePct(s3Reported_tCO2e, (s3Reported_tCO2e + s3Excluded_tCO2e)).toFixed(4));
    const percentS3CoveredByTargets = Number(safePct(s3CategoriesWithTargets_tCO2e, s3Total_tCO2e).toFixed(4));
    const meetsS3TargetCoverage67 = percentS3CoveredByTargets >= 67;

    doc.inventoryCoverage = {
      s12TargetBoundary_tCO2e,
      s12TotalInclExcluded_tCO2e,
      percentS12Covered,

      s3Reported_tCO2e,
      s3Excluded_tCO2e,
      percentS3Reported,

      s3CategoriesWithTargets_tCO2e,
      s3Total_tCO2e,
      percentS3CoveredByTargets,
      meetsS3TargetCoverage67
    };

    await doc.save();

    emitSbtiUpdate?.(clientId, { type: 'sbti-inventory-coverage-updated', targetType });
    return res.status(200).json({ success: true, data: doc });
  } catch (err) {
    console.error('setInventoryCoverage error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
module.exports = {
  setSocketIO,
  upsertTarget,
  getTargets,
  getTrajectory,
  addRenewableProgress,
  addSupplierEngagement,
  setFlagInfo,
  setCoverageInfo,
  setInventoryCoverage,
};
