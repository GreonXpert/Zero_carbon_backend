const ApiKey = require('../models/ApiKey');
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
 */
const createKey = async (req, res) => {
  let pdfPath = null; // Track PDF path for cleanup
  
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

    console.log('[API Key] Create request:', {
      clientId,
      keyType,
      user: req.user?.userName
    });

    // ========== VALIDATION ==========
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required',
        message: 'No user found in request'
      });
    }

    const userId = getUserId(req.user);
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Invalid user session',
        message: 'User ID not found'
      });
    }

    // Validate key type
    const validKeyTypes = ['NET_API', 'NET_IOT', 'DC_API', 'DC_IOT'];
    if (!validKeyTypes.includes(keyType)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid key type',
        message: `Key type must be one of: ${validKeyTypes.join(', ')}`
      });
    }

    // Validate required fields
    if (keyType === 'NET_API' || keyType === 'NET_IOT') {
      if (!projectId || !calculationMethodology) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields',
          message: 'NET keys require projectId and calculationMethodology'
        });
      }
    } else if (keyType === 'DC_API' || keyType === 'DC_IOT') {
      if (!nodeId || !scopeIdentifier) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields',
          message: 'DC keys require nodeId and scopeIdentifier'
        });
      }
    }

    // Check permission
    const hasPermission = await canManageApiKeys(req.user, clientId);
    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        error: 'Permission denied',
        message: 'You do not have permission to manage API keys for this client'
      });
    }

    // Get client
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({
        success: false,
        error: 'Client not found',
        message: `Client ${clientId} not found`
      });
    }

    // Validate client status
    const isSandboxKey = client.sandbox && [10, 30].includes(durationDays);
    validateClientStatus(client, isSandboxKey, durationDays);

    // Prepare metadata
    const metadata = keyType.startsWith('NET')
      ? { projectId, calculationMethodology }
      : { nodeId, scopeIdentifier };

    // Validate target exists
    await validateKeyTarget(keyType, clientId, metadata);

    // Check for existing active key
    const existingKey = await ApiKey.findOne({
      clientId,
      keyType,
      status: 'ACTIVE',
      ...metadata
    });

    if (existingKey) {
      return res.status(409).json({
        success: false,
        error: 'Key already exists',
        message: `An active ${keyType} key already exists for this endpoint`,
        existingKeyId: existingKey._id,
        existingKeyPrefix: existingKey.keyPrefix
      });
    }

    // ========== GENERATE KEY ==========
    const { key, hash, prefix } = await generateKeyPackage(keyType, metadata);
    const expiresAt = calculateExpiryDate(isSandboxKey, durationDays);

    // Create API key document
    const apiKeyDoc = new ApiKey({
      clientId,
      keyType,
      keyHash: hash,
      keyPrefix: prefix,
      ...(keyType.startsWith('NET') && { projectId, calculationMethodology }),
      ...(keyType.startsWith('DC') && { nodeId, scopeIdentifier }),
      status: 'ACTIVE',
      expiresAt,
      isSandboxKey,
      sandboxDuration: isSandboxKey ? durationDays : undefined,
      description,
      ipWhitelist,
      createdBy: userId,
      creatorRole: req.user.userType
    });

    await apiKeyDoc.save();
    console.log('[API Key] ✅ Key created in database:', prefix);

    // Send notification
    await createApiKeyNotification('created', apiKeyDoc, req.user, client);

    // Calculate days until expiry
    const daysUntilExpiry = Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24));

    // ========== GENERATE PDF AUTOMATICALLY ==========
    let pdfGenerated = false;

    try {
      console.log('[API Key] Generating PDF...');
      
      const tempDir = path.join(__dirname, '../temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      pdfPath = path.join(tempDir, `API_Key_${keyType}_${clientId}_${Date.now()}.pdf`);

      const apiKeyDataForPDF = {
        ...apiKeyDoc.toObject(),
        apiKey: key, // Include full key for PDF
        keyId: apiKeyDoc._id,
        daysUntilExpiry,
        metadata
      };

      const clientDataForPDF = {
        clientId: client.clientId,
        clientName: client.clientName,
        companyName: client.companyName || client.organizationalOverview?.companyName
      };

      await generateApiKeyPDF(apiKeyDataForPDF, clientDataForPDF, pdfPath);
      pdfGenerated = true;
      console.log('[API Key] ✅ PDF generated successfully');

    } catch (error) {
      console.error('[API Key] ❌ PDF generation failed:', error);
      // Don't fail the request if PDF fails
    }

    // ========== SEND EMAIL AUTOMATICALLY ==========
// ========== SEND EMAIL AUTOMATICALLY ==========
let emailSent = false;
let emailResults = null;
let recipients = []; // ✅ MOVE THIS OUTSIDE

if (pdfGenerated && pdfPath) {
  try {
    console.log('[API Key] Sending email...');
    
    // Get recipients: client admins, consultant admin (creator), assigned consultant
    recipients = await getApiKeyRecipients(client, req.user); // ✅ REMOVE 'const'
        if (recipients.length > 0) {
          const apiKeyDataForEmail = {
            ...apiKeyDoc.toObject(),
            apiKey: key, // Include full key for email
            keyId: apiKeyDoc._id,
            daysUntilExpiry,
            metadata
          };

          const clientDataForEmail = {
            clientId: client.clientId,
            clientName: client.clientName,
            companyName: client.companyName
          };

          const creatorDataForEmail = {
            userName: req.user.userName,
            email: req.user.email,
            userType: req.user.userType
          };

          emailResults = await sendApiKeyEmail({
            recipients,
            pdfPath,
            apiKeyData: apiKeyDataForEmail,
            clientData: clientDataForEmail,
            creatorData: creatorDataForEmail
          });

          emailSent = emailResults.success;
          
          if (emailSent) {
            console.log('[API Key] ✅ Email sent to', emailResults.totalSent, 'recipients');
          } else {
            console.log('[API Key] ⚠️ Email sending had failures');
          }
          
        } else {
          console.log('[API Key] ⚠️ No recipients found for email');
        }

      } catch (error) {
        console.error('[API Key] ❌ Email sending failed:', error);
        // Don't fail the request if email fails
      } finally {
        // ✅ CLEANUP: Delete temp PDF file after email
        if (pdfPath && fs.existsSync(pdfPath)) {
          try {
            fs.unlinkSync(pdfPath);
            console.log('[API Key] ✅ Temp PDF file cleaned up');
            pdfPath = null;
          } catch (cleanupError) {
            console.error('[API Key] Failed to cleanup PDF:', cleanupError);
          }
        }
      }
    }

    // ========== RETURN RESPONSE ==========
    res.status(201).json({
      success: true,
      message: 'API key created successfully',
      warning: 'IMPORTANT: This is the only time the full API key will be displayed. Save it securely.',
      data: {
        apiKey: key,
        keyId: apiKeyDoc._id,
        keyPrefix: prefix,
        keyType,
        clientId,
        metadata: keyType.startsWith('NET')
          ? { projectId, calculationMethodology }
          : { nodeId, scopeIdentifier },
        isSandbox: isSandboxKey,
        expiresAt,
        daysUntilExpiry,
        description,
        ipWhitelist,
        createdAt: apiKeyDoc.createdAt,
        // PDF and email status
        pdfGenerated,
        emailSent,
        emailResults: emailSent ? {
          totalSent: emailResults.totalSent,
          totalFailed: emailResults.totalFailed,
          recipients: emailResults.results.map(r => ({
            email: r.recipient,
            role: recipients.find(rec => rec.email === r.recipient)?.role,
            success: r.success
          }))
        } : null
      }
    });

  } catch (error) {
    console.error('[API Key] Create error:', error);
    
    // Clean up PDF file if it exists
    if (pdfPath && fs.existsSync(pdfPath)) {
      try {
        fs.unlinkSync(pdfPath);
        console.log('[API Key] Cleaned up PDF after error');
      } catch (cleanupError) {
        console.error('[API Key] Failed to cleanup PDF:', cleanupError);
      }
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to create API key',
      message: error.message
    });
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

module.exports = {
  createKey,
  listKeys,
  getKeyDetails,
  renewKey,
  revokeKey
};