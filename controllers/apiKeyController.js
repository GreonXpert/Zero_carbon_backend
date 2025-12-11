const ApiKey = require('../models/ApiKey');
const Client = require('../models/Client');
const Reduction = require('../models/Reduction/Reduction');
const Flowchart = require('../models/Flowchart');
const { generateKeyPackage, calculateExpiryDate } = require('../utils/ApiKey/keyGenerator');
const { createApiKeyNotification } = require('../utils/ApiKey/apiKeyNotifications');

// ============== HELPER FUNCTION ==============
/**
 * Safely extract user ID from user object
 * Handles both req.user.id (from auth middleware) and user._id (from direct DB queries)
 * @param {Object} user - User object
 * @returns {string|null} - User ID as string, or null if not found
 */
const getUserId = (user) => {
  if (!user) return null;
  
  // Check for id field first (set by auth middleware)
  if (user.id) {
    return typeof user.id === 'string' ? user.id : user.id.toString();
  }
  
  // Check for _id field (Mongoose document)
  if (user._id) {
    return typeof user._id === 'string' ? user._id : user._id.toString();
  }
  
  return null;
};

/**
 * Check if user has permission to manage API keys for a client
 */
const canManageApiKeys = async (user, clientId) => {
  // ✅ FIXED: Check if user exists and extract userId safely
  const userId = getUserId(user);
  if (!userId) {
    console.error('[API Key] Invalid user object:', {
      hasUser: !!user,
      hasId: !!user?.id,
      has_Id: !!user?._id,
      userType: user?.userType
    });
    return false;
  }

  // Super admin can manage all keys
  if (user.userType === 'super_admin') {
    return true;
  }

  // Get client with all necessary fields
  const client = await Client.findOne({ clientId })
    .select('leadInfo workflowTracking')
    .lean();

  if (!client) {
    console.error('[API Key] Client not found:', clientId);
    return false;
  }

  // Helper to safely convert ObjectId to string
  const getIdString = (field) => {
    if (!field) return null;
    if (field._id) return field._id.toString();
    if (field.$oid) return field.$oid;
    return field.toString();
  };

  // Consultant admin: can manage keys for clients they created or are assigned to
  if (user.userType === 'consultant_admin') {
    const consultantAdminId = getIdString(client.leadInfo?.consultantAdminId);
    const createdById = getIdString(client.leadInfo?.createdBy);
    
    if (consultantAdminId === userId || createdById === userId) {
      return true;
    }
  }

  // Consultant: can manage keys for assigned clients
  if (user.userType === 'consultant') {
    const leadAssignedConsultantId = getIdString(client.leadInfo?.assignedConsultantId);
    const workflowAssignedConsultantId = getIdString(client.workflowTracking?.assignedConsultantId);
    
    if (leadAssignedConsultantId === userId || workflowAssignedConsultantId === userId) {
      return true;
    }
  }

  console.error('[API Key] Permission denied:', {
    userId,
    userType: user.userType,
    clientId,
    consultantAdminId: getIdString(client.leadInfo?.consultantAdminId),
    assignedConsultantId: getIdString(client.leadInfo?.assignedConsultantId)
  });

  return false;
};

/**
 * Validate client status and sandbox rules
 */
const validateClientStatus = (client, isSandboxKey, durationDays) => {
  // Cannot create keys for clients in lead/registered/proposal stages
  const invalidStatuses = ['lead', 'registered', 'proposal'];
  if (invalidStatuses.includes(client.status?.toLowerCase())) {
    throw new Error(`Cannot create API keys for clients in ${client.status} stage. Client must be Active or Sandbox.`);
  }

  // Sandbox key rules
  if (isSandboxKey) {
    if (!client.sandbox) {
      throw new Error('Cannot create sandbox keys for non-sandbox clients');
    }
    if (![10, 30].includes(durationDays)) {
      throw new Error('Sandbox keys must have duration of exactly 10 or 30 days');
    }
  } else {
    // Regular key for sandbox client
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
  } else if (keyType === 'DC_API' || keyType === 'DC_IOT') {
    const { nodeId, scopeIdentifier } = metadata;
    
    const flowchart = await Flowchart.findOne({ 
      clientId, 
      'versions.isActive': true 
    });
    
    if (!flowchart) {
      throw new Error('No active flowchart found for this client');
    }
    
    const activeVersion = flowchart.versions.find(v => v.isActive);
    const node = activeVersion.chart.nodes.find(n => n.id === nodeId);
    
    if (!node) {
      throw new Error(`Node not found: ${nodeId}`);
    }
    
    const scope = node.details.scopeDetails.find(s => s.scopeIdentifier === scopeIdentifier);
    if (!scope) {
      throw new Error(`Scope not found: ${scopeIdentifier} in node ${nodeId}`);
    }
  }
};

/**
 * Create new API key
 */
const createKey = async (req, res) => {
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

    console.log('[API Key] Request user:', {
      exists: !!req.user,
      _id: req.user?._id,
      id: req.user?.id,
      userType: req.user?.userType,
      userName: req.user?.userName
    });

    // ✅ CRITICAL: Check if req.user exists
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required',
        message: 'No user found in request. Please login again.'
      });
    }

    // ✅ FIXED: Extract user ID safely
    const userId = getUserId(req.user);
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Invalid user session',
        message: 'User ID not found in session. Please login again.'
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

    // Validate required fields based on key type
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
        message: `An active ${keyType} key already exists for this endpoint. Please revoke the existing key first or use the renew endpoint.`,
        existingKeyId: existingKey._id,
        existingKeyPrefix: existingKey.keyPrefix
      });
    }

    // Generate key
    const { key, hash, prefix } = await generateKeyPackage(keyType, metadata);
    const expiresAt = calculateExpiryDate(isSandboxKey, durationDays);

    // Create API key document - ✅ FIXED: Use extracted userId
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
      createdBy: userId,  // ✅ FIXED: Use extracted userId
      creatorRole: req.user.userType
    });

    await apiKeyDoc.save();

    // Send notification
    await createApiKeyNotification('created', apiKeyDoc, req.user, client);

    // Calculate days until expiry
    const daysUntilExpiry = Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24));

    res.status(201).json({
      success: true,
      message: 'API key created successfully',
      warning: 'IMPORTANT: This is the only time the full API key will be displayed. Save it securely. It will not be shown again.',
      data: {
        apiKey: key, // ⚠️ Only time the actual key is shown
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
        createdAt: apiKeyDoc.createdAt
      }
    });

  } catch (error) {
    console.error('[API Key] Create error:', error);
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

    // Check permission
    const hasPermission = await canManageApiKeys(req.user, clientId);
    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        error: 'Permission denied',
        message: 'You do not have permission to view API keys for this client'
      });
    }

    // Build query
    const query = { clientId };
    if (status) query.status = status;
    if (keyType) query.keyType = keyType;

    // Get keys
    const keys = await ApiKey.find(query)
      .select('-keyHash') // Never expose hash
      .populate('createdBy', 'userName email')
      .sort({ createdAt: -1 });

    // Calculate days until expiry for each key
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

    // Check permission
    const hasPermission = await canManageApiKeys(req.user, clientId);
    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        error: 'Permission denied',
        message: 'You do not have permission to view API keys for this client'
      });
    }

    // Get key
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

    // Calculate days until expiry
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

    // ✅ FIXED: Extract user ID safely
    const userId = getUserId(req.user);
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Invalid user session',
        message: 'User ID not found in session. Please login again.'
      });
    }

    // Check permission
    const hasPermission = await canManageApiKeys(req.user, clientId);
    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        error: 'Permission denied',
        message: 'You do not have permission to renew API keys for this client'
      });
    }

    // Get old key
    const oldKey = await ApiKey.findOne({ _id: keyId, clientId });
    if (!oldKey) {
      return res.status(404).json({
        success: false,
        error: 'Key not found',
        message: 'API key not found'
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
    const metadata = oldKey.keyType.startsWith('NET')
      ? { 
          projectId: oldKey.projectId, 
          calculationMethodology: oldKey.calculationMethodology 
        }
      : { 
          nodeId: oldKey.nodeId, 
          scopeIdentifier: oldKey.scopeIdentifier 
        };

    // Generate new key
    const { key, hash, prefix } = await generateKeyPackage(oldKey.keyType, metadata);
    const expiresAt = calculateExpiryDate(isSandboxKey, durationDays);

    // Create new key - ✅ FIXED: Use extracted userId
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
      createdBy: userId,  // ✅ FIXED: Use extracted userId
      creatorRole: req.user.userType,
      renewedFrom: oldKey._id
    });

    await newKey.save();

    // Revoke old key - ✅ FIXED: Use extracted userId
    oldKey.status = 'REVOKED';
    oldKey.revokedAt = new Date();
    oldKey.revokedBy = userId;  // ✅ FIXED: Use extracted userId
    oldKey.revocationReason = 'Renewed - replaced with new key';
    oldKey.renewedTo = newKey._id;
    await oldKey.save();

    // Send notification
    await createApiKeyNotification('renewed', newKey, req.user, client);

    // Calculate days until expiry
    const daysUntilExpiry = Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24));

    res.json({
      success: true,
      message: 'API key renewed successfully',
      warning: 'IMPORTANT: The old key has been revoked. Save the new key securely.',
      data: {
        apiKey: key, // ⚠️ Only time the actual key is shown
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

    // ✅ FIXED: Extract user ID safely
    const userId = getUserId(req.user);
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Invalid user session',
        message: 'User ID not found in session. Please login again.'
      });
    }

    // Check permission
    const hasPermission = await canManageApiKeys(req.user, clientId);
    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        error: 'Permission denied',
        message: 'You do not have permission to revoke API keys for this client'
      });
    }

    // Get key
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

    // Revoke key - ✅ FIXED: Use extracted userId
    await key.revoke(userId, reason);  // ✅ FIXED: Pass userId string

    // Get client for notification
    const client = await Client.findOne({ clientId });

    // Send notification
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