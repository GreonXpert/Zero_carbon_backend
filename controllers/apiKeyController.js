const ApiKey = require('../models/ApiKey');
const ApiKeyRequest = require('../models/ApiKeyRequest');
const Client = require('../models/CMS/Client');
const User = require('../models/User');
const Reduction = require('../models/Reduction/Reduction');
const { generateKeyPackage, calculateExpiryDate } = require('../utils/ApiKey/keyGenerator');
const { createApiKeyNotification } = require('../utils/ApiKey/apiKeyNotifications');
const { generateApiKeyPDF } = require('../utils/ApiKey/apiKeyPdfGenerator');
const { sendApiKeyEmail } = require('../utils/ApiKey/apiKeyEmailService');
const { getActiveFlowchart } = require('../utils/DataCollection/dataCollection');
const path = require('path');
const fs = require('fs');
const Flowchart = require('../models/Organization/Flowchart');
const ProcessFlowchart = require('../models/Organization/ProcessFlowchart');
const {
  applyKeyToNetReductionProject,
  notifyClientApiKeyReady,
  notifyClientApiKeyRejected
} = require('../services/apiKeyLinker');
const {
  reflectSwitchInputTypeInClient
} = require('../controllers/Organization/dataCollectionController');


const mongoose = require("mongoose");

const SYSTEM_USER_ID_RAW = process.env.SYSTEM_USER_ID || "000000000000000000000001";

const SYSTEM_USER_ID = mongoose.Types.ObjectId.isValid(SYSTEM_USER_ID_RAW)
  ? SYSTEM_USER_ID_RAW
  : new mongoose.Types.ObjectId("000000000000000000000001");



// ============== HELPER FUNCTIONS ==============

/**
 * Safely extract user ID from user object
 */
const getUserId = (user) => {
  if (!user) return null;
  
  if (user.id) {
    return typeof user.id === 'string' ? user.id : user.id.toString();
  }
  
  if (user._id) {
    return typeof user._id === 'string' ? user._id : user._id.toString();
  }
  
  return null;
};

/**
 * Check if user has permission to manage API keys for a client
 */
const canManageApiKeys = async (user, clientId) => {
  const userId = getUserId(user);
  if (!userId) {
    console.error('[API Key] Invalid user object');
    return false;
  }

  if (user.userType === 'super_admin') {
    return true;
  }

  const client = await Client.findOne({ clientId })
    .select('leadInfo workflowTracking')
    .lean();

  if (!client) {
    console.error('[API Key] Client not found:', clientId);
    return false;
  }

  const getIdString = (field) => {
    if (!field) return null;
    if (field._id) return field._id.toString();
    if (field.$oid) return field.$oid;
    return field.toString();
  };

  if (user.userType === 'consultant_admin') {
    const consultantAdminId = getIdString(client.leadInfo?.consultantAdminId);
    const createdById = getIdString(client.leadInfo?.createdBy);
    
    if (consultantAdminId === userId || createdById === userId) {
      return true;
    }
  }

  if (user.userType === 'consultant') {
    const leadAssignedConsultantId = getIdString(client.leadInfo?.assignedConsultantId);
    const workflowAssignedConsultantId = getIdString(client.workflowTracking?.assignedConsultantId);
    
    if (leadAssignedConsultantId === userId || workflowAssignedConsultantId === userId) {
      return true;
    }
  }

  return false;
};

/**
 * Validate client status and sandbox rules
 */
const validateClientStatus = (client, isSandboxKey, durationDays) => {
  const invalidStatuses = ['lead', 'registered', 'proposal'];
  if (invalidStatuses.includes(client.status?.toLowerCase())) {
    throw new Error(`Cannot create API keys for clients in ${client.status} stage. Client must be Active or Sandbox.`);
  }

  if (isSandboxKey) {
    if (!client.sandbox) {
      throw new Error('Cannot create sandbox keys for non-sandbox clients');
    }
    if (![10, 30].includes(durationDays)) {
      throw new Error('Sandbox keys must have duration of exactly 10 or 30 days');
    }
  } else {
    if (client.sandbox && !client.leadInfo?.isSandboxApproved) {
      throw new Error('Cannot create regular keys for sandbox clients. Use 10 or 30 day sandbox keys.');
    }
  }
};

/**
 * Validate that the target (project/node+scope) exists
 */
const validateKeyTarget = async (keyType, clientId, metadata) => {
  if (keyType === 'NET_API' || keyType === 'NET_IOT') {
    const { projectId, calculationMethodology } = metadata;
    
    const project = await Reduction.findOne({ 
      clientId, 
      projectId, 
      calculationMethodology 
    });
    
    if (!project) {
      throw new Error(`Net Reduction project not found: ${projectId} with methodology ${calculationMethodology}`);
    }
  } 
  else if (keyType === 'DC_API' || keyType === 'DC_IOT') {
    const { nodeId, scopeIdentifier } = metadata;
    
    const activeChart = await getActiveFlowchart(clientId);
    
    if (!activeChart || !activeChart.chart) {
      throw new Error('No active flowchart found for this client');
    }
    
    const { chart } = activeChart;
    
    if (!chart.nodes || chart.nodes.length === 0) {
      throw new Error('Flowchart has no nodes. Please add nodes before creating API keys.');
    }
    
    const node = chart.nodes.find(n => n.id === nodeId);
    
    if (!node) {
      const availableNodeIds = chart.nodes.map(n => `${n.id} (${n.label || 'no label'})`).join(', ');
      throw new Error(`Node not found: ${nodeId}. Available nodes: ${availableNodeIds}`);
    }
    
    if (!node.details || !node.details.scopeDetails || node.details.scopeDetails.length === 0) {
      throw new Error(`Node ${nodeId} has no scope details. Please configure scopes before creating API keys.`);
    }
    
    const scope = node.details.scopeDetails.find(s => s.scopeIdentifier === scopeIdentifier);
    
    if (!scope) {
      const availableScopes = node.details.scopeDetails
        .map(s => `${s.scopeIdentifier} (${s.scopeType || 'no type'})`)
        .join(', ');
      throw new Error(`Scope not found: ${scopeIdentifier} in node ${nodeId}. Available scopes: ${availableScopes}`);
    }
  }
};

/**
 * ✅ Get email recipients for API key
 * Sends to:
 * 1. Client admins (users with client_admin role for this client)
 * 2. Consultant admin who created the key
 * 3. Consultant assigned to this client
 */
const getApiKeyRecipients = async (client, creator) => {
  const recipients = [];

  try {
    console.log('[Email Recipients] Starting recipient search for client:', client.clientId);
    console.log('[Email Recipients] Creator:', creator?.userName, creator?.userType);

    // 1. Get CLIENT ADMINS (users with client_admin role for this client)
    if (client.clientId) {
      const clientAdmins = await User.find({
        clientId: client.clientId,
        userType: 'client_admin'
      }).select('email userName').lean();

      console.log('[Email Recipients] Found', clientAdmins.length, 'client admins');

      clientAdmins.forEach(admin => {
        if (admin.email) {
          recipients.push({
            email: admin.email,
            name: admin.userName,
            role: 'client_admin'
          });
          console.log('[Email Recipients] ✅ Added client admin:', admin.email);
        }
      });
    }

    // 2. Add CONSULTANT ADMIN who created the key (if consultant_admin)
    if (creator && creator.userType === 'consultant_admin' && creator.email) {
      const exists = recipients.some(r => r.email === creator.email);
      if (!exists) {
        recipients.push({
          email: creator.email,
          name: creator.userName,
          role: 'consultant_admin'
        });
        console.log('[Email Recipients] ✅ Added consultant admin (creator):', creator.email);
      } else {
        console.log('[Email Recipients] Consultant admin already in list');
      }
    }

    // 3. Get ASSIGNED CONSULTANT from leadInfo
    if (client.leadInfo?.assignedConsultantId) {
      const consultant = await User.findById(client.leadInfo.assignedConsultantId)
        .select('email userName')
        .lean();
      
      if (consultant && consultant.email) {
        const exists = recipients.some(r => r.email === consultant.email);
        if (!exists) {
          recipients.push({
            email: consultant.email,
            name: consultant.userName,
            role: 'consultant'
          });
          console.log('[Email Recipients] ✅ Added assigned consultant:', consultant.email);
        } else {
          console.log('[Email Recipients] Assigned consultant already in list');
        }
      }
    }

    // 4. Get WORKFLOW CONSULTANT if different
    if (client.workflowTracking?.assignedConsultantId) {
      const workflowConsultant = await User.findById(client.workflowTracking.assignedConsultantId)
        .select('email userName')
        .lean();
      
      if (workflowConsultant && workflowConsultant.email) {
        const exists = recipients.some(r => r.email === workflowConsultant.email);
        if (!exists) {
          recipients.push({
            email: workflowConsultant.email,
            name: workflowConsultant.userName,
            role: 'consultant'
          });
          console.log('[Email Recipients] ✅ Added workflow consultant:', workflowConsultant.email);
        } else {
          console.log('[Email Recipients] Workflow consultant already in list');
        }
      }
    }

    console.log('[Email Recipients] ✅ Total recipients:', recipients.length);
    recipients.forEach(r => console.log(`  - ${r.role}: ${r.email}`));

    return recipients;

  } catch (error) {
    console.error('[Email Recipients] Error getting recipients:', error);
    return recipients;
  }
};

// ============== MAIN CONTROLLER FUNCTIONS ==============

/**
 * Create new API key
 * ✅ INTEGRATED: Automatically generates PDF and sends email
 * ✅ NEW: If NET_API / NET_IOT -> updates Reduction.reductionDataEntry.apiEndpoint + notifies client users
 */
/**
 * Create new API key
 * FULLY INTEGRATED:
 * - Updates Reduction / Flowchart / workflowTracking
 * - Approves pending ApiKeyRequest
 * - Sends notifications + PDF + email
 */
const createKey = async (req, res) => {
  let pdfPath = null;

  try {
    const { clientId } = req.params;
    const {
      keyType,
      projectId,
      calculationMethodology,
      nodeId,
      scopeIdentifier,
      durationDays = 365,
      description = '',
      ipWhitelist = []
    } = req.body;

    if (!req.user) {
      return res.status(401).json({ success:false, message:'Authentication required' });
    }

    const userId = getUserId(req.user);

    // ---------------- VALIDATION ----------------
    const validKeyTypes = ['NET_API','NET_IOT','DC_API','DC_IOT'];
    if (!validKeyTypes.includes(keyType)) {
      return res.status(400).json({ success:false, message:'Invalid key type' });
    }

    if (keyType.startsWith('NET') && (!projectId || !calculationMethodology)) {
      return res.status(400).json({ success:false, message:'projectId and calculationMethodology required' });
    }

    if (keyType.startsWith('DC') && (!nodeId || !scopeIdentifier)) {
      return res.status(400).json({ success:false, message:'nodeId and scopeIdentifier required' });
    }

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ success:false, message:'Client not found' });

    const metadata = keyType.startsWith('NET')
      ? { projectId, calculationMethodology }
      : { nodeId, scopeIdentifier };

    const existingKey = await ApiKey.findOne({
      clientId,
      keyType,
      status: 'ACTIVE',
      ...metadata
    });

    if (existingKey) {
      return res.status(409).json({ success:false, message:'Active key already exists' });
    }

    // ---------------- GENERATE KEY ----------------
    const { key, hash, prefix } = await generateKeyPackage(keyType, metadata);
    const expiresAt = calculateExpiryDate(client.sandbox, durationDays);

    const apiKeyDoc = new ApiKey({
      clientId,
      keyType,
      keyHash: hash,
      keyPrefix: prefix,
      ...(keyType.startsWith('NET') && { projectId, calculationMethodology }),
      ...(keyType.startsWith('DC') && { nodeId, scopeIdentifier }),
      status: 'ACTIVE',
      expiresAt,
      description,
      ipWhitelist,
      createdBy: userId,
      creatorRole: req.user.userType
    });

    await apiKeyDoc.save();

    await createApiKeyNotification('created', apiKeyDoc, req.user, client);

    // =====================================================
    // 🔥 SINGLE SOURCE OF TRUTH — APPLY KEY
    // =====================================================
    await applyKeyToNetReductionProject({
      clientId,
      projectId,
      nodeId,
      scopeIdentifier,
      calculationMethodology,
      keyType,
      keyValue: prefix, // ✅ use keyPrefix in URLs
      apiKeyId: apiKeyDoc._id,
      approvedAt: new Date()
    });

    // Approve any pending request
    await ApiKeyRequest.updateMany(
      {
        clientId,
        keyType,
        ...(keyType.startsWith('NET') ? { projectId, calculationMethodology } : { nodeId, scopeIdentifier }),
        status: 'pending'
      },
      {
        $set: {
          status: 'approved',
          processedBy: userId,
          processedAt: new Date(),
          // keep intendedInputType as provided by the requester (if any)
        }
      }
    );

    // Notify client users
    await notifyClientApiKeyReady({
  clientId,
  keyType,
  projectId,
  nodeId,
  scopeIdentifier,
  apiKey: key,

  actorId: userId,
  actorType: req.user.userType
});

    // ---------------- PDF ----------------
    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive:true });

    pdfPath = path.join(tempDir, `API_KEY_${Date.now()}.pdf`);

    await generateApiKeyPDF(
      { ...apiKeyDoc.toObject(), apiKey:key },
      { clientId:client.clientId, clientName:client.clientName, companyName:client.companyName },
      pdfPath
    );

    // ---------------- EMAIL ----------------
    const recipients = await getApiKeyRecipients(client, req.user);

    await sendApiKeyEmail({
      recipients,
      pdfPath,
      apiKeyData: { ...apiKeyDoc.toObject(), apiKey:key },
      clientData: { clientId:client.clientId, clientName:client.clientName },
      creatorData: { userName:req.user.userName, email:req.user.email }
    });

    if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);

    return res.status(201).json({
      success:true,
      apiKey:key,
      keyType,
      clientId,
      keyPrefix: prefix,
      expiresAt
    });

  } catch (error) {
    console.error(error);
    if (pdfPath && fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    return res.status(500).json({ success:false, message:error.message });
  }
};


/**
 * List API keys for a client
 */
const listKeys = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { status, keyType } = req.query;

    const hasPermission = await canManageApiKeys(req.user, clientId);
    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        error: 'Permission denied',
        message: 'You do not have permission to view API keys for this client'
      });
    }

    const query = { clientId };
    if (status) query.status = status;
    if (keyType) query.keyType = keyType;

    const keys = await ApiKey.find(query)
      .select('-keyHash')
      .populate('createdBy', 'userName email')
      .sort({ createdAt: -1 });

    const now = new Date();
    const keysWithExpiry = keys.map(key => {
      const keyObj = key.toObject();
      if (keyObj.expiresAt) {
        keyObj.daysUntilExpiry = Math.ceil((keyObj.expiresAt - now) / (1000 * 60 * 60 * 24));
      }
      return keyObj;
    });

    res.json({
      success: true,
      data: {
        keys: keysWithExpiry,
        total: keys.length
      }
    });

  } catch (error) {
    console.error('[API Key] List error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list API keys',
      message: error.message
    });
  }
};

/**
 * Get API key details
 */
const getKeyDetails = async (req, res) => {
  try {
    const { clientId, keyId } = req.params;

    const hasPermission = await canManageApiKeys(req.user, clientId);
    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        error: 'Permission denied',
        message: 'You do not have permission to view API keys for this client'
      });
    }

    const key = await ApiKey.findOne({ _id: keyId, clientId })
      .select('-keyHash')
      .populate('createdBy', 'userName email')
      .populate('revokedBy', 'userName email')
      .populate('renewedFrom')
      .populate('renewedTo');

    if (!key) {
      return res.status(404).json({
        success: false,
        error: 'Key not found',
        message: 'API key not found'
      });
    }

    const keyObj = key.toObject();
    if (keyObj.expiresAt) {
      const now = new Date();
      keyObj.daysUntilExpiry = Math.ceil((keyObj.expiresAt - now) / (1000 * 60 * 60 * 24));
    }

    res.json({
      success: true,
      data: keyObj
    });

  } catch (error) {
    console.error('[API Key] Get details error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get API key details',
      message: error.message
    });
  }
};

/**
 * Renew API key
 */
const renewKey = async (req, res) => {
  try {
    const { clientId, keyId } = req.params;
    const { durationDays = 365 } = req.body;

    const userId = getUserId(req.user);
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Invalid user session',
        message: 'User ID not found in session. Please login again.'
      });
    }

    const hasPermission = await canManageApiKeys(req.user, clientId);
    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        error: 'Permission denied',
        message: 'You do not have permission to renew API keys for this client'
      });
    }

    const oldKey = await ApiKey.findOne({ _id: keyId, clientId });
    if (!oldKey) {
      return res.status(404).json({
        success: false,
        error: 'Key not found',
        message: 'API key not found'
      });
    }

    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({
        success: false,
        error: 'Client not found',
        message: `Client ${clientId} not found`
      });
    }

    const isSandboxKey = client.sandbox && [10, 30].includes(durationDays);
    validateClientStatus(client, isSandboxKey, durationDays);

    const metadata = oldKey.keyType.startsWith('NET')
      ? { 
          projectId: oldKey.projectId, 
          calculationMethodology: oldKey.calculationMethodology 
        }
      : { 
          nodeId: oldKey.nodeId, 
          scopeIdentifier: oldKey.scopeIdentifier 
        };

    const { key, hash, prefix } = await generateKeyPackage(oldKey.keyType, metadata);
    const expiresAt = calculateExpiryDate(isSandboxKey, durationDays);

    const newKey = new ApiKey({
      clientId,
      keyType: oldKey.keyType,
      keyHash: hash,
      keyPrefix: prefix,
      ...(oldKey.keyType.startsWith('NET') && { 
        projectId: oldKey.projectId, 
        calculationMethodology: oldKey.calculationMethodology 
      }),
      ...(oldKey.keyType.startsWith('DC') && { 
        nodeId: oldKey.nodeId, 
        scopeIdentifier: oldKey.scopeIdentifier 
      }),
      status: 'ACTIVE',
      expiresAt,
      isSandboxKey,
      sandboxDuration: isSandboxKey ? durationDays : undefined,
      description: oldKey.description,
      ipWhitelist: oldKey.ipWhitelist,
      createdBy: userId,
      creatorRole: req.user.userType,
      renewedFrom: oldKey._id
    });

    await newKey.save();

    oldKey.status = 'REVOKED';
    oldKey.revokedAt = new Date();
    oldKey.revokedBy = userId;
    oldKey.revocationReason = 'Renewed - replaced with new key';
    oldKey.renewedTo = newKey._id;
    await oldKey.save();

    await createApiKeyNotification('renewed', newKey, req.user, client);

    const daysUntilExpiry = Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24));

    res.json({
      success: true,
      message: 'API key renewed successfully',
      warning: 'IMPORTANT: The old key has been revoked. Save the new key securely.',
      data: {
        apiKey: key,
        keyId: newKey._id,
        keyPrefix: prefix,
        keyType: newKey.keyType,
        clientId,
        metadata: newKey.keyType.startsWith('NET')
          ? { projectId: newKey.projectId, calculationMethodology: newKey.calculationMethodology }
          : { nodeId: newKey.nodeId, scopeIdentifier: newKey.scopeIdentifier },
        isSandbox: isSandboxKey,
        expiresAt,
        daysUntilExpiry,
        oldKeyPrefix: oldKey.keyPrefix,
        oldKeyRevoked: true,
        createdAt: newKey.createdAt
      }
    });

  } catch (error) {
    console.error('[API Key] Renew error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to renew API key',
      message: error.message
    });
  }
};

/**
 * Revoke API key
 */
const revokeKey = async (req, res) => {
  try {
    const { clientId, keyId } = req.params;
    const { reason } = req.body;

    const userId = getUserId(req.user);
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Invalid user session',
        message: 'User ID not found in session. Please login again.'
      });
    }

    const hasPermission = await canManageApiKeys(req.user, clientId);
    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        error: 'Permission denied',
        message: 'You do not have permission to revoke API keys for this client'
      });
    }

    const key = await ApiKey.findOne({ _id: keyId, clientId });
    if (!key) {
      return res.status(404).json({
        success: false,
        error: 'Key not found',
        message: 'API key not found'
      });
    }

    if (key.status === 'REVOKED') {
      return res.status(400).json({
        success: false,
        error: 'Key already revoked',
        message: 'This API key has already been revoked'
      });
    }

    await key.revoke(userId, reason);

    const client = await Client.findOne({ clientId });
    await createApiKeyNotification('revoked', key, req.user, client);

    res.json({
      success: true,
      message: 'API key revoked successfully',
      data: {
        keyId: key._id,
        keyPrefix: key.keyPrefix,
        keyType: key.keyType,
        status: key.status,
        revokedAt: key.revokedAt,
        revocationReason: key.revocationReason
      }
    });

  } catch (error) {
    console.error('[API Key] Revoke error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to revoke API key',
      message: error.message
    });
  }
};

async function resolveAllowedClientIds(user) {
  let allowedClientIds = null;

  if (user.userType === "consultant") {
    const assigned = await Client.find({
      "leadInfo.assignedConsultantId": user.id
    }).select("clientId");

    allowedClientIds = assigned.map(c => c.clientId);
  }

  if (user.userType === "consultant_admin") {
    const consultants = await User.find({ consultantAdminId: user.id }).select("_id");
    const consultantIds = consultants.map(c => c._id.toString());
    consultantIds.push(user.id);

    const clients = await Client.find({
      $or: [
        { "leadInfo.consultantAdminId": user.id },
        { "leadInfo.assignedConsultantId": { $in: consultantIds } }
      ]
    }).select("clientId");

    allowedClientIds = clients.map(c => c.clientId);
  }

  return allowedClientIds;
}


const getApiKeyRequests = async (req, res) => {
  try {
    const { status = "pending", clientId } = req.query;

    const allowedClientIds = await resolveAllowedClientIds(req.user);

    const filter = { status };

    // Enforce consultant permission
    if (allowedClientIds) {
      filter.clientId = { $in: allowedClientIds };
    }

    // Optional UI filter
    if (clientId) {
      if (allowedClientIds && !allowedClientIds.includes(clientId)) {
        return res.status(403).json({
          success: false,
          message: "Permission denied for this client"
        });
      }
      filter.clientId = clientId;
    }

    const requests = await ApiKeyRequest.find(filter)
      .populate("requestedBy", "userName email userType")
      .sort({ createdAt: -1 });

    return res.json({ success: true, data: requests });

  } catch (err) {
    console.error("getApiKeyRequests", err);
    res.status(500).json({ success: false, message: err.message });
  }
};





const approveApiKeyRequest = async (req, res) => {
  try {
    const { requestId } = req.params;
    const userId = getUserId(req.user);

    if (!userId) {
      return res.status(401).json({ success: false, message: "Invalid session" });
    }

    const request = await ApiKeyRequest.findById(requestId);
    if (!request || request.status !== "pending") {
      return res.status(404).json({
        success: false,
        message: "Invalid or already processed request",
      });
    }

    // ✅ Permission check (consistent with your other API key routes)
    const hasPermission = await canManageApiKeys(req.user, request.clientId);
    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        message: "Permission denied for this client",
      });
    }

    // ✅ Validate request payload based on key type
    const isNet = request.keyType && request.keyType.startsWith("NET");
    const isDc = request.keyType && request.keyType.startsWith("DC");

    if (!request.keyType || (!isNet && !isDc)) {
      return res.status(400).json({ success: false, message: "Invalid request.keyType" });
    }

    if (isNet) {
      if (!request.projectId || !request.calculationMethodology) {
        return res.status(400).json({
          success: false,
          message: "NET request missing projectId or calculationMethodology",
        });
      }
    }

    if (isDc) {
      if (!request.nodeId || !request.scopeIdentifier) {
        return res.status(400).json({
          success: false,
          message: "DC request missing nodeId or scopeIdentifier",
        });
      }
    }

    // ✅ Intended switch type (robust even if request schema does not store intendedInputType)
    const intendedInputType =
      request.keyType.endsWith("_API") ? "API" : "IOT";

    // ==========================================================
    // 1) Find existing ACTIVE key (avoid duplicates)
    // ==========================================================
    const keyFilter = {
      clientId: request.clientId,
      keyType: request.keyType,
      status: "ACTIVE",
      ...(isNet
        ? {
            projectId: request.projectId,
            calculationMethodology: request.calculationMethodology,
          }
        : {
            nodeId: request.nodeId,
            scopeIdentifier: request.scopeIdentifier,
          }),
    };

    let apiKeyDoc = await ApiKey.findOne(keyFilter).sort({ createdAt: -1 });

    // ==========================================================
    // 2) If no key exists, generate one using createKey(...)
    // ==========================================================
    let createKeyPayload = null;

    if (!apiKeyDoc) {
      const fakeReq = {
        params: { clientId: request.clientId },
        body: {
          keyType: request.keyType,
          projectId: request.projectId,
          calculationMethodology: request.calculationMethodology,
          nodeId: request.nodeId,
          scopeIdentifier: request.scopeIdentifier,
        },
        user: req.user,
      };

      const fakeRes = {
        status: (code) => ({
          json: (data) => {
            if (code >= 400) throw new Error(data.message || "createKey failed");
            createKeyPayload = data;
          },
        }),
        json: (data) => {
          createKeyPayload = data;
        },
      };

      await createKey(fakeReq, fakeRes);

      // Re-fetch saved key doc (source of truth)
      apiKeyDoc = await ApiKey.findOne(keyFilter).sort({ createdAt: -1 });
    }

    if (!apiKeyDoc) {
      return res.status(500).json({
        success: false,
        message: "Key creation succeeded but ApiKey document not found",
      });
    }

    // ✅ IMPORTANT: Use keyPrefix in endpoints (not plaintext apiKey)
    const keyPrefix = apiKeyDoc.keyPrefix;

    // ==========================================================
    // 3) Mark request approved
    // ==========================================================
    const processedAt = new Date();
    request.status = "approved";
    request.processedBy = userId;
    request.processedAt = processedAt;
    request.intendedInputType = intendedInputType;
    await request.save();

    // ==========================================================
    // 4) 🔥 APPLY KEY (THIS DOES THE ACTUAL SWITCH + SAVES ENDPOINT)
    //    Works for BOTH NET and DC
    // ==========================================================
    await applyKeyToNetReductionProject({
      clientId: request.clientId,
      projectId: request.projectId,
      calculationMethodology: request.calculationMethodology,
      nodeId: request.nodeId,
      scopeIdentifier: request.scopeIdentifier,
      keyType: request.keyType,
      keyValue: keyPrefix,
      apiKeyId: apiKeyDoc._id,
      requestId: request._id,
      approvedAt: processedAt,
    });

// ==========================================================
// 5) Return updated endpoint + inputType from DB (truth)
// ==========================================================
let updatedInputType = intendedInputType;
let updatedEndpoint = "";

if (isNet) {
  const reduction = await Reduction.findOne({
    clientId: request.clientId,
    projectId: request.projectId,
    calculationMethodology: request.calculationMethodology,
  }).lean();

  updatedInputType = reduction?.reductionDataEntry?.inputType || intendedInputType;
  updatedEndpoint  = reduction?.reductionDataEntry?.apiEndpoint || "";
} else {
  // ✅ Determine which DB contains the active chart
  const activeChart = await getActiveFlowchart(request.clientId); // returns chartType + merged chart
  if (!activeChart || !activeChart.chart) {
    // if applyKey worked but no active chart exists, still return safe values
    updatedInputType = intendedInputType;
    updatedEndpoint = "";
  } else {
    const { chartType } = activeChart;

    // Helper to extract scope from a chart doc
    const pickScopeFromChartDoc = (chartDoc) => {
      const node = chartDoc?.nodes?.find((n) => n.id === request.nodeId);
      return node?.details?.scopeDetails?.find(
        (s) => s.scopeIdentifier === request.scopeIdentifier
      );
    };

    let scope = null;

    // If assessmentLevel is "both", getActiveFlowchart() returns chartType="merged".
    // In that case, we must re-check real DB docs to read the persisted endpoint/inputType.
    if (chartType === "flowchart") {
      const org = await Flowchart.findOne({ clientId: request.clientId, isActive: true }).lean();
      scope = pickScopeFromChartDoc(org);
    } else if (chartType === "processflowchart") {
      const proc = await ProcessFlowchart.findOne({ clientId: request.clientId, isActive: true, isDeleted: { $ne: true } }).lean();
      scope = pickScopeFromChartDoc(proc);
    } else {
      // chartType === "merged" -> read BOTH DBs, prefer the one where the scope exists with apiEndpoint
      const org = await Flowchart.findOne({ clientId: request.clientId, isActive: true }).lean();
      const proc = await ProcessFlowchart.findOne({ clientId: request.clientId, isActive: true, isDeleted: { $ne: true } }).lean();

      const s1 = pickScopeFromChartDoc(org);
      const s2 = pickScopeFromChartDoc(proc);

      // Prefer whichever has endpoint saved (post-approval), otherwise fallback
      scope = (s1?.apiEndpoint ? s1 : null) || (s2?.apiEndpoint ? s2 : null) || s1 || s2;
    }

    updatedInputType = scope?.inputType || intendedInputType;
    updatedEndpoint  = scope?.apiEndpoint || "";
  }
}

    return res.json({
      success: true,
      message: `Approved. Input switched to ${updatedInputType} and endpoint saved.`,
      data: {
        requestId: request._id,
        clientId: request.clientId,
        keyType: request.keyType,
        keyPrefix,
        inputType: updatedInputType,
        apiEndpoint: updatedEndpoint,
        // if createKey returned plaintext apiKey it will be here:
        apiKey: createKeyPayload?.data?.apiKey || null,
      },
    });
  } catch (error) {
    console.error("approveApiKeyRequest error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to approve API key request",
      error: error.message,
    });
  }
};



const rejectApiKeyRequest = async (req, res) => {
  try {
    const { requestId } = req.params;
    const userId = getUserId(req.user);

    const request = await ApiKeyRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({ success:false, message:"Request not found" });
    }

    const allowedClientIds = await resolveAllowedClientIds(req.user);
    if (allowedClientIds && !allowedClientIds.includes(request.clientId)) {
      return res.status(403).json({ success:false, message:"No access to this client" });
    }

    request.status = "rejected";
    request.rejectedBy = userId;
    request.rejectedAt = new Date();
    await request.save();

    await notifyClientApiKeyRejected({
  clientId: request.clientId,
  keyType: request.keyType,
  projectId: request.projectId,
  nodeId: request.nodeId,
  scopeIdentifier: request.scopeIdentifier,

  actorId: userId,
  actorType: req.user.userType
});

    res.json({ success:true, message:"Request rejected" });

  } catch (err) {
    res.status(500).json({ success:false, message: err.message });
  }
};


const getApiKeyRequestStats = async (req, res) => {
  try {
    const { clientId } = req.query;

    const allowedClientIds = await resolveAllowedClientIds(req.user);

    const baseFilter = {};

    // Consultant restriction
    if (allowedClientIds) {
      baseFilter.clientId = { $in: allowedClientIds };
    }

    // Optional client filter
    if (clientId) {
      if (allowedClientIds && !allowedClientIds.includes(clientId)) {
        return res.status(403).json({
          success: false,
          message: "Permission denied for this client"
        });
      }
      baseFilter.clientId = clientId;
    }

    const [
      total,
      pending,
      approved,
      rejected,
      byKeyType
    ] = await Promise.all([
      ApiKeyRequest.countDocuments(baseFilter),
      ApiKeyRequest.countDocuments({ ...baseFilter, status: "pending" }),
      ApiKeyRequest.countDocuments({ ...baseFilter, status: "approved" }),
      ApiKeyRequest.countDocuments({ ...baseFilter, status: "rejected" }),

      ApiKeyRequest.aggregate([
        { $match: baseFilter },
        { $group: { _id: "$keyType", count: { $sum: 1 } } }
      ])
    ]);

    const recentRequests = await ApiKeyRequest.find(baseFilter)
      .populate("requestedBy", "userName email")
      .sort({ createdAt: -1 })
      .limit(10);

    const keyTypeMap = {};
    byKeyType.forEach(k => {
      keyTypeMap[k._id] = k.count;
    });

    return res.json({
      success: true,
      data: {
        total,
        pending,
        approved,
        rejected,
        byKeyType: keyTypeMap,
        recentRequests
      }
    });

  } catch (err) {
    console.error("getApiKeyRequestStats:", err);
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};



module.exports = {
  createKey,
  listKeys,
  getKeyDetails,
  renewKey,
  revokeKey,
  getApiKeyRequests,
  getApiKeyRequestStats,
  approveApiKeyRequest,
  rejectApiKeyRequest
};