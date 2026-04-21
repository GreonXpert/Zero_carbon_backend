// controllers/verification/thresholdVerificationController.js
const mongoose = require("mongoose");
const ThresholdConfig = require("./ThresholdConfig");
const PendingApproval = require("./PendingApproval");
const DataEntry = require("../organization/models/DataEntry");
const NetReductionEntry = require("../reduction/models/NetReductionEntry");
const { notifySubmitterOfOutcome } = require("../workflow/notifications/thresholdNotifications");

// ─────────────────────────────────────────────────────────────────────────────
// THRESHOLD CONFIG — CRUD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/verification/threshold-config
 * Create or upsert a threshold config.
 * Role: consultant_admin
 */
const createOrUpdateThresholdConfig = async (req, res) => {
  try {
    const {
      clientId,
      scopeIdentifier,
      nodeId = null,
      flowType,
      thresholdPercentage,
      isActive = true,
      baselineSampleSize = 10,
      appliesToInputTypes = []
    } = req.body;

    if (!clientId || !scopeIdentifier || !flowType || thresholdPercentage == null) {
      return res.status(400).json({
        success: false,
        message: "clientId, scopeIdentifier, flowType, and thresholdPercentage are required"
      });
    }

    if (!["dataEntry", "netReduction"].includes(flowType)) {
      return res.status(400).json({
        success: false,
        message: "flowType must be 'dataEntry' or 'netReduction'"
      });
    }

    if (thresholdPercentage < 0.1 || thresholdPercentage > 10000) {
      return res.status(400).json({
        success: false,
        message: "thresholdPercentage must be between 0.1 and 10000"
      });
    }

    if (baselineSampleSize < 3 || baselineSampleSize > 50) {
      return res.status(400).json({
        success: false,
        message: "baselineSampleSize must be between 3 and 50"
      });
    }

    // Upsert: one config per client+scope+flowType+node
    const config = await ThresholdConfig.findOneAndUpdate(
      { clientId, scopeIdentifier, flowType, nodeId: nodeId || null },
      {
        $set: {
          thresholdPercentage,
          isActive,
          baselineSampleSize,
          appliesToInputTypes,
          updatedBy: req.user._id
        },
        $setOnInsert: {
          createdBy: req.user._id,
          createdByType: req.user.userType
        }
      },
      { upsert: true, new: true, runValidators: true }
    );

    return res.status(200).json({
      success: true,
      message: "Threshold config saved",
      data: config
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "A threshold config already exists for this client+scope+flowType+node combination"
      });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/verification/threshold-config/:clientId
 * List all threshold configs for a client.
 * Role: consultant_admin, super_admin
 */
const getThresholdConfigs = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { flowType, isActive } = req.query;

    const filter = { clientId };
    if (flowType) filter.flowType = flowType;
    if (isActive !== undefined) filter.isActive = isActive === "true";

    const configs = await ThresholdConfig.find(filter)
      .sort({ scopeIdentifier: 1, flowType: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: configs.length,
      data: configs
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/verification/threshold-config/:id
 * Update threshold percentage, isActive, baselineSampleSize, or appliesToInputTypes.
 * Role: consultant_admin
 */
const updateThresholdConfig = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid config ID" });
    }

    const allowed = ["thresholdPercentage", "isActive", "baselineSampleSize", "appliesToInputTypes"];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (updates.thresholdPercentage != null) {
      if (updates.thresholdPercentage < 0.1 || updates.thresholdPercentage > 10000) {
        return res.status(400).json({
          success: false,
          message: "thresholdPercentage must be between 0.1 and 10000"
        });
      }
    }

    updates.updatedBy = req.user._id;

    const config = await ThresholdConfig.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    ).lean();

    if (!config) {
      return res.status(404).json({ success: false, message: "Threshold config not found" });
    }

    return res.status(200).json({ success: true, message: "Threshold config updated", data: config });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * DELETE /api/verification/threshold-config/:id
 * Soft-delete: sets isActive=false.
 * Role: consultant_admin
 */
const deleteThresholdConfig = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid config ID" });
    }

    const config = await ThresholdConfig.findByIdAndUpdate(
      id,
      { $set: { isActive: false, updatedBy: req.user._id } },
      { new: true }
    ).lean();

    if (!config) {
      return res.status(404).json({ success: false, message: "Threshold config not found" });
    }

    return res.status(200).json({
      success: true,
      message: "Threshold config deactivated",
      data: config
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Get consultant's assigned client IDs
// ─────────────────────────────────────────────────────────────────────────────

const getConsultantAssignedClients = async (userId) => {
  try {
    const User = require("../../../common/models/User");
    const user = await User.findById(userId)
      .select("assignedClients")
      .lean();
    return user?.assignedClients?.map(c => String(c)) || [];
  } catch (err) {
    console.error("[getConsultantAssignedClients] Error:", err.message);
    return [];
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PENDING APPROVALS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/verification/pending-approvals
 * List pending approvals (filterable by clientId, flowType, status).
 * consultant_admin: sees only their assigned clients
 * super_admin: sees all clients
 */
const listPendingApprovals = async (req, res) => {
  try {
    const {
      clientId,
      flowType,
      status = "Pending_Approval",
      page = 1,
      limit = 20
    } = req.query;

    const filter = {};

    // Authorization: consultant_admin can only see their assigned clients
    if (req.user.userType === "consultant_admin") {
      const assignedClientIds = await getConsultantAssignedClients(req.user._id);
      if (assignedClientIds.length === 0) {
        return res.status(200).json({
          success: true,
          total: 0,
          page: 1,
          pages: 0,
          message: "No clients assigned",
          data: []
        });
      }
      filter.clientId = { $in: assignedClientIds };

      // If specific clientId requested, verify it's assigned
      if (clientId && !assignedClientIds.includes(clientId)) {
        return res.status(403).json({
          success: false,
          message: `Client ${clientId} is not assigned to you`
        });
      }
    }

    // Apply optional filters
    if (clientId) filter.clientId = clientId;
    if (flowType) filter.flowType = flowType;
    if (status) filter.status = status;

    const skip = (Number(page) - 1) * Number(limit);

    const [records, total] = await Promise.all([
      PendingApproval.find(filter)
        .sort({ submittedAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .populate("submittedBy", "userName email userType")
        .populate("reviewedBy", "userName email userType")
        .lean(),
      PendingApproval.countDocuments(filter)
    ]);

    return res.status(200).json({
      success: true,
      total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit)),
      data: records
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/verification/pending-approvals/:id
 * Get full detail of one pending approval record.
 * consultant_admin: can only view their assigned clients
 * super_admin: can view all
 */
const getPendingApprovalDetail = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid ID" });
    }

    const record = await PendingApproval.findById(id)
      .populate("submittedBy", "userName email userType")
      .populate("reviewedBy", "userName email userType")
      .lean();

    if (!record) {
      return res.status(404).json({ success: false, message: "Pending approval not found" });
    }

    // Authorization: consultant_admin can only view their assigned clients
    if (req.user.userType === "consultant_admin") {
      const assignedClientIds = await getConsultantAssignedClients(req.user._id);
      if (!assignedClientIds.includes(record.clientId)) {
        return res.status(403).json({
          success: false,
          message: "You do not have access to this pending approval"
        });
      }
    }

    return res.status(200).json({ success: true, data: record });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// APPROVE — Finalize save
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/verification/pending-approvals/:id/approve
 * Approve a pending anomaly entry and finalize its save into the target collection.
 * Only consultant_admin can approve (super_admin cannot)
 */
const approvePendingEntry = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid ID" });
    }

    // Only consultant or consultant_admin can approve (not super_admin)
    if (!["consultant_admin", "consultant"].includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: "Only consultant or consultant_admin can approve pending entries"
      });
    }

    const record = await PendingApproval.findById(id);
    if (!record) {
      return res.status(404).json({ success: false, message: "Pending approval not found" });
    }

    // Verify consultant has access to this client
    const assignedClientIds = await getConsultantAssignedClients(req.user._id);
    if (!assignedClientIds.includes(record.clientId)) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to approve entries for this client"
      });
    }

    if (record.status !== "Pending_Approval") {
      return res.status(409).json({
        success: false,
        message: `Entry is already ${record.status} and cannot be approved again`
      });
    }

    const payload = record.originalPayload;
    let finalizedEntryId = null;
    let finalizedCollection = null;

    // ── DataEntry finalization ────────────────────────────────────────────────
    if (record.flowType === "dataEntry") {
      const {
        clientId, nodeId, scopeIdentifier, scopeType,
        inputType, date, time, timestamp,
        dataValues, emissionFactor, sourceDetails
      } = payload;

      // Reconstruct the dataValues Map
      const dataMap = new Map();
      if (dataValues && typeof dataValues === "object") {
        for (const [k, v] of Object.entries(dataValues)) {
          const n = Number(v);
          dataMap.set(k, isFinite(n) ? n : 0);
        }
      }

      const entry = new DataEntry({
        clientId,
        nodeId,
        scopeIdentifier,
        scopeType,
        inputType: inputType || "manual",
        date,
        time,
        timestamp: timestamp ? new Date(timestamp) : new Date(),
        dataValues: dataMap,
        emissionFactor: emissionFactor || "",
        sourceDetails: sourceDetails || {},
        approvalStatus: "approved",
        processingStatus: "pending",
        emissionCalculationStatus: "pending"
      });

      await entry.save();

      // Trigger emission calculation asynchronously (non-blocking)
      setImmediate(async () => {
        try {
          const { triggerEmissionCalculation } = require("../Calculation/emissionIntegration");
          const calcResult = await triggerEmissionCalculation(entry);

          const { createProcessEmissionDataEntry } = require("../organization/utils/ProcessEmission/createProcessEmissionDataEntry");
          const { updateSummariesOnDataChange } = require("../Calculation/CalculationSummary");
          const freshEntry = await DataEntry.findById(entry._id).lean();
          if (freshEntry?.calculatedEmissions) {
            await createProcessEmissionDataEntry(freshEntry);
            await updateSummariesOnDataChange(freshEntry);
          }
        } catch (e) {
          console.error("[approvePendingEntry] Emission calc failed:", e.message);
        }
      });

      finalizedEntryId = entry._id;
      finalizedCollection = "DataEntry";
    }

    // ── NetReductionEntry finalization ─────────────────────────────────────────
    else if (record.flowType === "netReduction") {
      const {
        clientId, projectId, calculationMethodology,
        inputType, date, time, timestamp,
        inputValue, emissionReductionRate, netReduction,
        formulaId, variables, netReductionInFormula,
        m3, sourceDetails
      } = payload;

      const methodology = calculationMethodology;

      const nrDoc = {
        clientId,
        projectId,
        calculationMethodology: methodology,
        inputType: inputType || "manual",
        date,
        time,
        timestamp: timestamp ? new Date(timestamp) : new Date(),
        netReduction: netReduction || 0,
        sourceDetails: sourceDetails || {}
      };

      if (methodology === "methodology1") {
        nrDoc.inputValue = inputValue || 0;
        nrDoc.emissionReductionRate = emissionReductionRate || 0;
        nrDoc.formulaId = null;
        nrDoc.variables = {};
        nrDoc.netReductionInFormula = 0;
      } else if (methodology === "methodology2") {
        nrDoc.formulaId = formulaId || null;
        nrDoc.variables = variables || {};
        nrDoc.netReductionInFormula = netReductionInFormula || 0;
        nrDoc.inputValue = 0;
        nrDoc.emissionReductionRate = 0;
      } else if (methodology === "methodology3") {
        nrDoc.m3 = m3 || {};
        nrDoc.inputValue = 0;
        nrDoc.emissionReductionRate = 0;
      }

      const entry = await NetReductionEntry.create(nrDoc);

      // Trigger NR summary recomputation asynchronously
      setImmediate(async () => {
        try {
          const { recomputeClientNetReductionSummary } = require("../reduction/controllers/netReductionSummaryController");
          await recomputeClientNetReductionSummary(clientId, projectId);
        } catch (e) {
          console.error("[approvePendingEntry] NR summary recompute failed:", e.message);
        }
      });

      finalizedEntryId = entry._id;
      finalizedCollection = "NetReductionEntry";
    } else {
      return res.status(400).json({ success: false, message: "Unknown flowType in pending record" });
    }

    // ── Update PendingApproval status ─────────────────────────────────────────
    record.status = "Approved";
    record.reviewedBy = req.user._id;
    record.reviewedAt = new Date();
    record.finalizedEntryId = finalizedEntryId;
    record.finalizedCollection = finalizedCollection;
    await record.save();

    // ── Notify submitter ───────────────────────────────────────────────────────
    await notifySubmitterOfOutcome({
      clientId: record.clientId,
      scopeIdentifier: record.scopeIdentifier || record.projectId,
      submittedBy: record.submittedBy,
      submittedByType: record.submittedByType,
      reviewedBy: req.user._id,
      reviewedByType: req.user.userType,
      outcome: "Approved",
      flowType: record.flowType,
      pendingApprovalId: record._id
    });

    return res.status(200).json({
      success: true,
      message: "Entry approved and saved successfully",
      data: {
        pendingApprovalId: record._id,
        finalizedEntryId,
        finalizedCollection,
        status: "Approved"
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// REJECT — Block final save
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/verification/pending-approvals/:id/reject
 * Reject a pending anomaly entry. Nothing is saved to DataEntry/NetReductionEntry.
 * Only consultant_admin can reject (super_admin cannot)
 */
const rejectPendingEntry = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid ID" });
    }

    // Only consultant or consultant_admin can reject (not super_admin)
    if (!["consultant_admin", "consultant"].includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: "Only consultant or consultant_admin can reject pending entries"
      });
    }

    const { reason } = req.body;

    const record = await PendingApproval.findById(id);
    if (!record) {
      return res.status(404).json({ success: false, message: "Pending approval not found" });
    }

    // Verify consultant has access to this client
    const assignedClientIds = await getConsultantAssignedClients(req.user._id);
    if (!assignedClientIds.includes(record.clientId)) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to reject entries for this client"
      });
    }

    if (record.status !== "Pending_Approval") {
      return res.status(409).json({
        success: false,
        message: `Entry is already ${record.status} and cannot be rejected again`
      });
    }

    record.status = "Rejected";
    record.reviewedBy = req.user._id;
    record.reviewedAt = new Date();
    if (reason) record.rejectionReason = reason;
    await record.save();

    // Notify submitter of rejection
    await notifySubmitterOfOutcome({
      clientId: record.clientId,
      scopeIdentifier: record.scopeIdentifier || record.projectId,
      submittedBy: record.submittedBy,
      submittedByType: record.submittedByType,
      reviewedBy: req.user._id,
      reviewedByType: req.user.userType,
      outcome: "Rejected",
      rejectionReason: reason || null,
      flowType: record.flowType,
      pendingApprovalId: record._id
    });

    return res.status(200).json({
      success: true,
      message: "Entry rejected. No data was saved to the main collection.",
      data: {
        pendingApprovalId: record._id,
        status: "Rejected",
        rejectionReason: record.rejectionReason || null
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// STATS — Dashboard overview
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/verification/pending-approvals/stats/overview
 * Get statistics for pending approvals
 */
const getPendingApprovalStats = async (req, res) => {
  try {
    const filter = {};

    // Authorization: consultant_admin sees only their assigned clients
    if (req.user.userType === "consultant_admin") {
      const assignedClientIds = await getConsultantAssignedClients(req.user._id);
      if (assignedClientIds.length === 0) {
        return res.status(200).json({
          success: true,
          data: {
            totalPending: 0,
            totalApproved: 0,
            totalRejected: 0,
            byFlowType: { dataEntry: 0, netReduction: 0 },
            oldestPending: null
          }
        });
      }
      filter.clientId = { $in: assignedClientIds };
    }

    // Get counts by status
    const stats = await PendingApproval.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    // Get counts by flow type (pending only)
    const flowStats = await PendingApproval.aggregate([
      { $match: { ...filter, status: 'Pending_Approval' } },
      {
        $group: {
          _id: '$flowType',
          count: { $sum: 1 }
        }
      }
    ]);

    // Get oldest pending
    const oldest = await PendingApproval.findOne({
      ...filter,
      status: 'Pending_Approval'
    })
      .sort({ submittedAt: 1 })
      .select('submittedAt')
      .lean();

    // Format response
    const statsObj = {
      totalPending: 0,
      totalApproved: 0,
      totalRejected: 0
    };

    stats.forEach(stat => {
      if (stat._id === 'Pending_Approval') statsObj.totalPending = stat.count;
      if (stat._id === 'Approved') statsObj.totalApproved = stat.count;
      if (stat._id === 'Rejected') statsObj.totalRejected = stat.count;
    });

    const byFlowType = { dataEntry: 0, netReduction: 0 };
    flowStats.forEach(fs => {
      if (fs._id === 'dataEntry') byFlowType.dataEntry = fs.count;
      if (fs._id === 'netReduction') byFlowType.netReduction = fs.count;
    });

    return res.status(200).json({
      success: true,
      data: {
        totalPending: statsObj.totalPending,
        totalApproved: statsObj.totalApproved,
        totalRejected: statsObj.totalRejected,
        byFlowType,
        oldestPending: oldest?.submittedAt || null
      }
    });

  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  createOrUpdateThresholdConfig,
  getThresholdConfigs,
  updateThresholdConfig,
  deleteThresholdConfig,
  listPendingApprovals,
  getPendingApprovalDetail,
  approvePendingEntry,
  rejectPendingEntry,
  getPendingApprovalStats
};
