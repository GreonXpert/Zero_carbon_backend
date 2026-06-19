// controllers/sandboxController.js
// Simplified Sandbox controller – only approve, reject, and reset,
// operating directly on Client and User collections.

const Client = require('../client/Client');
const User = require('../../../common/models/User');
const Flowchart = require('../../zero-carbon/organization/models/Flowchart');
const ProcessFlowchart = require('../../zero-carbon/organization/models/ProcessFlowchart');
const Reduction = require('../../zero-carbon/reduction/models/Reduction');
const TargetMaster = require('../../zero-carbon/m3/models/TargetMaster');
const { updateClientIdReferencesOnActivation } = require('../client/clientController');

/**
 * Helper to find a client by clientId (string).
 */
async function findClientByIdOrFail(clientId) {
  const client = await Client.findOne({ clientId });
  if (!client) {
    const err = new Error('Client not found');
    err.statusCode = 404;
    throw err;
  }
  return client;
}

/**
 * APPROVE SANDBOX
 * - Promotes clientId: Sandbox_GreonXXX → GreonXXX
 * - Sets client.sandbox = false
 * - Updates clientId + sandbox flag on all related users and collections
 */
const approveSandboxClient = async (req, res) => {
  try {
    const { clientId } = req.params;

    if (!['super_admin', 'consultant_admin'].includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only super_admin and consultant_admin can approve sandbox clients',
      });
    }

    const client = await findClientByIdOrFail(clientId);

    if (!client.sandbox) {
      return res.status(400).json({
        success: false,
        message: 'Client is not currently in sandbox mode',
      });
    }

    const oldClientId = client.clientId;

    // Resolve sequence number (needed to build real GreonXXX id)
    if (!client.clientSequenceNumber) {
      const match = oldClientId && oldClientId.match(/(\d+)$/);
      if (match) {
        client.clientSequenceNumber = parseInt(match[1], 10);
      } else {
        return res.status(400).json({
          success: false,
          message: 'Cannot determine client sequence number for ID promotion',
        });
      }
    }

    // Promote Sandbox_GreonXXX → GreonXXX
    const newClientId = Client.buildClientIdForStage(client.clientSequenceNumber, 'active');

    client.clientId = newClientId;
    client.sandbox = false;

    if (!Array.isArray(client.timeline)) client.timeline = [];
    client.timeline.push({
      stage: client.stage,
      status: client.status,
      action: 'sandbox_approved',
      performedBy: req.user.id,
      notes: `Sandbox approved. Client ID promoted from ${oldClientId} to ${newClientId}.`,
      timestamp: new Date(),
    });

    await client.save();

    // Update clientId across all collections and activate all users
    try {
      await updateClientIdReferencesOnActivation(
        oldClientId,
        newClientId,
        req.user.id,
        'sandbox_approved'
      );
    } catch (err) {
      console.error('approveSandboxClient: reference update error:', err.message);
    }

    return res.status(200).json({
      success: true,
      message: `Sandbox approved. Client ID promoted to ${newClientId}.`,
      client: {
        clientId: client.clientId,
        sandbox: client.sandbox,
        stage: client.stage,
        status: client.status,
      },
    });
  } catch (err) {
    console.error('approveSandboxClient error:', err);
    const status = err.statusCode || 500;
    return res.status(status).json({
      success: false,
      message: err.statusCode === 404 ? err.message : 'Failed to approve sandbox client',
      error: err.message,
    });
  }
};


/**
 * REJECT SANDBOX
 * - Sets client.sandbox = true
 * - All users: sandbox = true, isActive = false
 * - HARD DELETE ALL MODULES:
 *   Flowchart, ProcessFlowchart, Reduction, Decarbonization
 * - No clientId / stage / status changes
 */
const rejectSandboxClient = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { reason } = req.body || {};

    // Only super_admin & consultant_admin allowed
    if (!['super_admin', 'consultant_admin'].includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. Only super_admin and consultant_admin can reject sandbox clients",
      });
    }

    const client = await findClientByIdOrFail(clientId);

    // -------------------------------
    // 1. Update Client Flags
    // -------------------------------
    client.sandbox = true;

    if (!Array.isArray(client.timeline)) client.timeline = [];
    client.timeline.push({
      stage: client.stage,
      status: client.status,
      action: "sandbox_rejected",
      performedBy: req.user.id,
      notes: reason || "Sandbox client rejected",
      timestamp: new Date(),
    });

    await client.save();

    // -------------------------------
    // 2. Update User Flags
    // -------------------------------
    await User.updateMany(
      { clientId: client.clientId },
      { $set: { sandbox: true, isActive: false } }
    );

    // -------------------------------
    // 3. HARD DELETE ALL MODULE DATA
    // -------------------------------
    const deleteResults = {};

    // ORGANIZATION → Flowchart
    deleteResults.flowchart = await Flowchart.deleteMany({
      clientId: client.clientId,
    });

    // PROCESS → Process Flowchart
    deleteResults.processFlowchart = await ProcessFlowchart.deleteMany({
      clientId: client.clientId,
    });

    // REDUCTION
    deleteResults.reduction = await Reduction.deleteMany({
      clientId: client.clientId,
    });

    // DECARBONIZATION
    deleteResults.decarbonization = await TargetMaster.deleteMany({
      clientId: client.clientId,
    });

    return res.status(200).json({
      success: true,
      message:
        "Sandbox rejected. All related organization, process, reduction & decarbonization data wiped.",
      deleted: deleteResults,
      client: {
        clientId: client.clientId,
        sandbox: client.sandbox,
        stage: client.stage,
        status: client.status,
      },
    });

  } catch (err) {
    console.error("rejectSandboxClient error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to reject sandbox client",
      error: err.message,
    });
  }
};


/**
 * RESET SANDBOX
 * - Sets client.sandbox = true
 * - Sets User.sandbox = true and isActive = false
 * - DOES NOT change clientId / stage / status
 */

const resetSandboxClient = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { reason, deleteModules = [] } = req.body || {};

    if (!['super_admin', 'consultant_admin'].includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. Only super_admin and consultant_admin can reset sandbox clients",
      });
    }

    const client = await findClientByIdOrFail(clientId);

    // ------------------------------------------
    // 1. Update Client Sandbox Flags
    // ------------------------------------------
    client.sandbox = true;

    if (!Array.isArray(client.timeline)) client.timeline = [];
    client.timeline.push({
      stage: client.stage,
      status: client.status,
      action: "sandbox_reset",
      performedBy: req.user.id,
      notes: reason || "Sandbox client reset and module data deleted",
      timestamp: new Date(),
    });

    await client.save();

    // ------------------------------------------
    // 2. Update User Flags (sandbox = true)
    // ------------------------------------------
    await User.updateMany(
      { clientId: client.clientId },
      { $set: { sandbox: true, isActive: false } }
    );

    // ------------------------------------------
    // 3. Determine assessment levels
    // ------------------------------------------
    const clientLevels = [];

    if (Array.isArray(client.submissionData?.assessmentLevel)) {
      clientLevels.push(...client.submissionData.assessmentLevel.map(l => l.toLowerCase()));
    }
    if (Array.isArray(client.assessmentLevel)) {
      clientLevels.push(...client.assessmentLevel.map(l => l.toLowerCase()));
    }

    // ------------------------------------------
    // 4. Hard Delete Selected Modules
    // ------------------------------------------
    const deleteResults = {};

    // ORGANIZATION / FLOWCHART
    if (
      deleteModules.includes("organization") &&
      clientLevels.includes("organization")
    ) {
      deleteResults.flowchart = await Flowchart.deleteMany({ clientId: client.clientId });
    }

    // PROCESS / PROCESS FLOWCHART
    if (
      deleteModules.includes("process") &&
      clientLevels.includes("process")
    ) {
      deleteResults.processFlowchart = await ProcessFlowchart.deleteMany({
        clientId: client.clientId,
      });
    }

    // REDUCTION
    if (
      deleteModules.includes("reduction") &&
      clientLevels.includes("reduction")
    ) {
      deleteResults.reduction = await Reduction.deleteMany({
        clientId: client.clientId,
      });
    }

    // DECARBONIZATION
    if (
      deleteModules.includes("decarbonization") &&
      clientLevels.includes("decarbonization")
    ) {
      deleteResults.sbti = await TargetMaster.deleteMany({
        clientId: client.clientId,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Sandbox reset complete. Selected modules have been deleted.",
      deleted: deleteResults,
      client: {
        clientId: client.clientId,
        sandbox: client.sandbox,
      },
    });

  } catch (err) {
    console.error("resetSandboxClient error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to reset sandbox client",
      error: err.message,
    });
  }
};


module.exports = {
  approveSandboxClient,
  rejectSandboxClient,
  resetSandboxClient,
};
