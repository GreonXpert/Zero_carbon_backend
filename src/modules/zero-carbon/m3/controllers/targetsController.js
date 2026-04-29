'use strict';

const targetService        = require('../services/targetService');
const pathwayService       = require('../services/pathwayService');
const progressService      = require('../services/progressService');
const forecastService      = require('../services/forecastService');
const trajectoryService    = require('../services/trajectoryService');
const dqService            = require('../services/dqService');
const outputActivityService= require('../services/outputActivityService');
const InitiativeAttribution= require('../models/InitiativeAttribution');
const EvidenceAttachment   = require('../models/EvidenceAttachment');
const DataQualityFlag      = require('../models/DataQualityFlag');
const PathwayAnnual            = require('../models/PathwayAnnual');
const UserLayoutPreference     = require('../models/UserLayoutPreference');
const { assertWriteAccess, assertCanApprove, resolveClientId } = require('../utils/m3Permission');
const OrgSettings = require('../models/OrgSettings');

const respond = (res, data, status = 200) => res.status(status).json({ success: true, data });
const err = (res, e) => res.status(e.status || 500).json({ success: false, message: e.message });

exports.createTarget = async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    await assertWriteAccess(req, clientId);
    const { target, baseYearNote } = await targetService.createTarget({ ...req.body, clientId }, req.user);
    const payload = baseYearNote ? { ...target.toObject(), _note: baseYearNote } : target;
    respond(res, payload, 201);
  } catch (e) { err(res, e); }
};

exports.listTargets = async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const data = await targetService.listTargets(clientId, req.query);
    respond(res, data);
  } catch (e) { err(res, e); }
};

exports.getTarget = async (req, res) => {
  try {
    const data = await targetService.getTargetById(req.params.targetId);
    respond(res, data);
  } catch (e) { err(res, e); }
};

exports.updateTarget = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);
    const updated = await targetService.updateTarget(req.params.targetId, req.body, req.user);
    respond(res, updated);
  } catch (e) { err(res, e); }
};

exports.submitTarget = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);
    const updated = await targetService.submitTarget(req.params.targetId, req.user);
    respond(res, updated);
  } catch (e) { err(res, e); }
};

exports.reviewTarget = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);
    assertCanApprove(req);
    const updated = await targetService.reviewTarget(req.params.targetId, req.user);
    respond(res, updated);
  } catch (e) { err(res, e); }
};

exports.returnTarget = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);
    assertCanApprove(req);
    const updated = await targetService.returnTarget(req.params.targetId, req.body.comment, req.user);
    respond(res, updated);
  } catch (e) { err(res, e); }
};

exports.approveTarget = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);
    assertCanApprove(req);
    const updated = await targetService.approveTarget(req.params.targetId, req.body.comment, req.user);
    respond(res, updated);
  } catch (e) { err(res, e); }
};

exports.publishTarget = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);
    assertCanApprove(req);
    const updated = await targetService.publishTarget(req.params.targetId, req.body.comment, req.user);
    respond(res, updated);
  } catch (e) { err(res, e); }
};

exports.archiveTarget = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);
    assertCanApprove(req);
    const updated = await targetService.archiveTarget(req.params.targetId, req.user);
    respond(res, updated);
  } catch (e) { err(res, e); }
};

exports.getRevisions = async (req, res) => {
  try {
    const data = await targetService.getRevisions(req.params.targetId);
    respond(res, data);
  } catch (e) { err(res, e); }
};

exports.getPathway = async (req, res) => {
  try {
    const data = await pathwayService.getPathway(req.params.targetId);
    respond(res, data);
  } catch (e) { err(res, e); }
};

exports.getOperationalBudgets = async (req, res) => {
  try {
    const data = await pathwayService.getOperationalBudgets(req.params.targetId, req.query.granularity);
    respond(res, data);
  } catch (e) { err(res, e); }
};

exports.getProgress = async (req, res) => {
  try {
    const data = await progressService.getProgress(req.params.targetId);
    respond(res, data);
  } catch (e) { err(res, e); }
};

exports.getForecast = async (req, res) => {
  try {
    const { snapshotType, isPrimary } = req.query;
    // Default: return primary (live tracking) snapshots only
    const isPrimaryBool = isPrimary === 'false' ? false : isPrimary === 'null' ? null : true;
    const data = await forecastService.getForecast(req.params.targetId, snapshotType || 'ANNUAL', isPrimaryBool);
    respond(res, data);
  } catch (e) { err(res, e); }
};

exports.getLive = async (req, res) => {
  try {
    const data = await progressService.getLiveSnapshot(req.params.targetId);
    respond(res, data);
  } catch (e) { err(res, e); }
};

exports.getHistory = async (req, res) => {
  try {
    const data = await targetService.getHistory(req.params.targetId);
    respond(res, data);
  } catch (e) { err(res, e); }
};

exports.getInitiatives = async (req, res) => {
  try {
    const data = await InitiativeAttribution.find({ target_id: req.params.targetId, isDeleted: false });
    respond(res, data);
  } catch (e) { err(res, e); }
};

exports.getAttachments = async (req, res) => {
  try {
    const data = await EvidenceAttachment.find({
      entity_type: 'TargetMaster',
      entity_id:   req.params.targetId,
    });
    respond(res, data);
  } catch (e) { err(res, e); }
};

// ── Phase 4: M1 Progress Compute ─────────────────────────────────────────────

exports.computeProgress = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);

    const { calendarYear } = req.body;
    if (!calendarYear) {
      return res.status(422).json({ success: false, message: 'calendarYear is required.' });
    }

    const m1 = await progressService.pullM1Emissions(target.clientId, Number(calendarYear), target.scope_boundary);
    if (!m1) {
      return res.status(404).json({ success: false, message: `No M1 EmissionSummary found for year ${calendarYear}.` });
    }

    const snapshot = await progressService.computeProgressSnapshot({
      targetId:           target._id,
      clientId:           target.clientId,
      snapshotDate:       new Date(),
      calendarYear:       Number(calendarYear),
      actualEmissions:    m1.CO2e,
      ingestionTimestamp: m1.ingestionTimestamp || m1.ingestion_timestamp,
      m1SummaryId:        m1.summaryId,
    });

    respond(res, snapshot, 201);
  } catch (e) { err(res, e); }
};

// ── Phase 6: Trajectory ───────────────────────────────────────────────────────

exports.getTrajectory = async (req, res) => {
  try {
    const data = await trajectoryService.getTargetTrajectory(req.params.targetId);
    respond(res, data);
  } catch (e) { err(res, e); }
};

exports.recomputeTrajectoryProgress = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);

    const pathwayRows = await PathwayAnnual
      .find({ target_id: target._id })
      .sort({ calendar_year: 1 })
      .lean();

    if (!pathwayRows.length) {
      return res.status(404).json({
        success: false,
        message: 'No pathway rows found. Publish the target first to generate a pathway.',
      });
    }

    const results = [];
    for (const row of pathwayRows) {
      const m1 = await progressService.pullM1Emissions(
        target.clientId, row.calendar_year, target.scope_boundary, target.scope3_coverage_pct ?? 100
      );
      if (!m1) {
        results.push({ calendar_year: row.calendar_year, status: 'skipped', reason: 'No M1 EmissionSummary data' });
        continue;
      }
      const snapshot = await progressService.computeProgressSnapshot({
        targetId:           target._id,
        clientId:           target.clientId,
        snapshotDate:       new Date(),
        calendarYear:       row.calendar_year,
        actualEmissions:    m1.CO2e,
        ingestionTimestamp: m1.ingestionTimestamp || m1.ingestion_timestamp,
        m1SummaryId:        m1.summaryId,
      });
      results.push({ calendar_year: row.calendar_year, status: 'computed', snapshot_id: snapshot._id });
    }

    // Broadcast real-time update to all clients in this client's room
    if (global.io) {
      global.io.to(`client_${target.clientId}`).emit('m3:trajectory:updated', {
        targetId: String(target._id),
        clientId: target.clientId,
        results,
        timestamp: new Date().toISOString(),
      });
    }

    respond(res, { target_id: target._id, results });
  } catch (e) { err(res, e); }
};

// ── Phase 5: Forecast Compute ─────────────────────────────────────────────────

exports.computeForecast = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);

    const { calendarYear, forecastMethod, snapshotType } = req.body;
    if (!calendarYear) {
      return res.status(422).json({ success: false, message: 'calendarYear is required.' });
    }

    // ── Method lock logic ──────────────────────────────────────────────────────
    // First time a client computes a forecast → lock their chosen method as the
    // active tracking method. All subsequent auto-recomputes use this method.
    // If they compute again with a DIFFERENT method, that is a comparison compute
    // (is_primary: false) and does not affect the live tracking forecast.
    let settings = await OrgSettings.findOne({ clientId: target.clientId });
    let isPrimary = true;

    if (!settings?.forecast_method_locked) {
      // First compute — lock the method (or default to LINEAR_EXTRAPOLATION)
      const methodToLock = forecastMethod || settings?.forecast_method_default || 'LINEAR_EXTRAPOLATION';
      settings = await OrgSettings.findOneAndUpdate(
        { clientId: target.clientId },
        { $set: { forecast_method_default: methodToLock, forecast_method_locked: true } },
        { upsert: true, new: true }
      );
    } else {
      // Method already locked — if using a different method, this is comparison only
      const activeMethod = settings.forecast_method_default;
      if (forecastMethod && forecastMethod !== activeMethod) {
        isPrimary = false;
      }
    }

    const result = await forecastService.computeForecastByMethod({
      targetId:      target._id,
      clientId:      target.clientId,
      calendarYear:  Number(calendarYear),
      forecastMethod,
      snapshotType:  snapshotType || 'ANNUAL',
      isPrimary,
    });

    // Annual returns single snapshot; sub-period returns array — always reply with the latest
    if (!result || (Array.isArray(result) && result.length === 0)) {
      return res.status(404).json({ success: false, message: `No pathway found for year ${calendarYear}.` });
    }

    const snapshot = Array.isArray(result) ? result[result.length - 1] : result;
    // Include metadata so frontend knows if this was primary or comparison
    respond(res, { snapshot, isPrimary, activeMethod: settings.forecast_method_default }, 201);
  } catch (e) { err(res, e); }
};

// ── Phase 6: DQ Flag Endpoints ────────────────────────────────────────────────

exports.listDqFlags = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    const { severity, resolved } = req.query;
    const flags = await dqService.listFlags({
      clientId:   target.clientId,
      entityType: 'TargetMaster',
      entityId:   String(target._id),
      severity,
      resolved:   resolved !== undefined ? resolved === 'true' : undefined,
    });
    respond(res, flags);
  } catch (e) { err(res, e); }
};

exports.resolveDqFlag = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);

    const flag = await DataQualityFlag.findOneAndUpdate(
      { _id: req.params.flagId, entity_id: String(target._id), resolved: false },
      { $set: { resolved: true, resolved_by: req.user._id, resolved_at: new Date() } },
      { new: true }
    );
    if (!flag) {
      return res.status(404).json({ success: false, message: 'DQ flag not found or already resolved.' });
    }
    respond(res, flag);
  } catch (e) { err(res, e); }
};

// ── Phase 7: OutputActivityRecord CRUD ───────────────────────────────────────

exports.createOutputRecord = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);
    const record = await outputActivityService.createRecord(
      { ...req.body, target_id: target._id, clientId: target.clientId },
      req.user
    );
    respond(res, record, 201);
  } catch (e) { err(res, e); }
};

exports.listOutputRecords = async (req, res) => {
  try {
    const data = await outputActivityService.listRecords(req.params.targetId, req.query);
    respond(res, data);
  } catch (e) { err(res, e); }
};

exports.updateOutputRecord = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);
    const updated = await outputActivityService.updateRecord(req.params.recordId, req.body, req.user);
    respond(res, updated);
  } catch (e) { err(res, e); }
};

exports.deleteOutputRecord = async (req, res) => {
  try {
    const target = await targetService.getTargetById(req.params.targetId);
    await assertWriteAccess(req, target.clientId);
    const result = await outputActivityService.deleteRecord(req.params.recordId);
    respond(res, result);
  } catch (e) { err(res, e); }
};

// ── User Layout Preferences ────────────────────────────────────────────────────

exports.getLayoutPreference = async (req, res) => {
  try {
    const pref = await UserLayoutPreference.findOne({
      userId:   req.user._id,
      targetId: req.params.targetId,
    }).lean();
    // Only return hidden_cards — drag positions are not persisted
    respond(res, pref ? { hidden_cards: pref.hidden_cards } : null);
  } catch (e) { err(res, e); }
};

exports.saveLayoutPreference = async (req, res) => {
  try {
    const { hidden_cards } = req.body;
    const pref = await UserLayoutPreference.findOneAndUpdate(
      { userId: req.user._id, targetId: req.params.targetId },
      { $set: { hidden_cards: Array.isArray(hidden_cards) ? hidden_cards : [] } },
      { upsert: true, new: true }
    );
    respond(res, { hidden_cards: pref.hidden_cards });
  } catch (e) { err(res, e); }
};
