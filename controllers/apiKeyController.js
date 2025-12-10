const ApiKey = require('../models/ApiKey');
const Client = require('../models/Client');
const Reduction = require('../models/Reduction/Reduction');
const Flowchart = require('../models/Flowchart');
const { generateKeyPackage, calculateExpiryDate } = require('../utils/ApiKey/keyGenerator');
const { createApiKeyNotification } = require('../utils/ApiKey/apiKeyNotifications');

/**
 * Check if user has permission to manage API keys for a client
 */
const canManageApiKeys = async (user, clientId) => {
  // ✅ CRITICAL FIX: Check if user and user._id exist
  if (!user || !user._id) {
    console.error('[API Key] Invalid user object:', user);
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
    return false;
  }

  // ✅ FIX: Add null/undefined checks before calling toString()
  const userId = user._id.toString();

  // Consultant admin: can manage keys for clients they created
  if (user.userType === 'consultant_admin') {
    // Check if consultantAdminId exists and matches
    if (client.leadInfo && 
        client.leadInfo.consultantAdminId && 
        client.leadInfo.consultantAdminId.toString() === userId) {
      return true;
    }
  }

  // Consultant: can manage keys for assigned clients
  if (user.userType === 'consultant') {
    // Check if assignedConsultantId exists and matches
    if (client.workflowTracking && 
        client.workflowTracking.assignedConsultantId && 
        client.workflowTracking.assignedConsultantId.toString() === userId) {
      return true;
    }
  }

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
    if (client.sandbox && ![10, 30].includes(durationDays)) {
      throw new Error('Keys for sandbox clients must have duration of 10 or 30 days');
    }
  }

  return true;
};

/**
 * Validate that the target (project or node/scope) exists
 */
const validateKeyTarget = async (keyType, clientId, metadata) => {
  if (keyType === 'NET_API' || keyType === 'NET_IOT') {
    // Validate project exists
    const project = await Reduction.findOne({
      clientId,
      projectId: metadata.projectId,
      isDeleted: false
    }).select('_id projectId calculationMethodology');

    if (!project) {
      throw new Error(`Project ${metadata.projectId} not found for client ${clientId}`);
    }

    // Validate methodology matches
    if (project.calculationMethodology !== metadata.calculationMethodology) {
      throw new Error(
        `Project ${metadata.projectId} uses ${project.calculationMethodology}, ` +
        `but key requested for ${metadata.calculationMethodology}`
      );
    }

    return project;
  }

  if (keyType === 'DC_API' || keyType === 'DC_IOT') {
    // Validate node and scope exist
    const flowchart = await Flowchart.findOne({
      clientId,
      'nodes.nodeId': metadata.nodeId,
      isDeleted: false
    }).select('nodes');

    if (!flowchart) {
      throw new Error(`Node ${metadata.nodeId} not found for client ${clientId}`);
    }

    const node = flowchart.nodes.find(n => n.nodeId === metadata.nodeId);
    if (!node) {
      throw new Error(`Node ${metadata.nodeId} not found`);
    }

    // Check if scope exists in node
    const scopeExists = node.emissionData?.some(
      scope => scope.scopeIdentifier === metadata.scopeIdentifier
    );

    if (!scopeExists) {
      throw new Error(
        `Scope ${metadata.scopeIdentifier} not found in node ${metadata.nodeId}`
      );
    }

    return { node, scopeIdentifier: metadata.scopeIdentifier };
  }

  throw new Error(`Invalid key type: ${keyType}`);
};

/**
 * Create API key
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
      description,
      ipWhitelist = []
    } = req.body;

    // ✅ CRITICAL: Log user object for debugging
    console.log('[API Key] Request user:', {
      exists: !!req.user,
      _id: req.user?._id,
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
        message: `An active ${keyType} key already exists for this endpoint. ` +
                 `Please revoke the existing key first or use the renew endpoint.`,
        data: {
          existingKeyId: existingKey._id,
          keyPrefix: existingKey.keyPrefix,
          expiresAt: existingKey.expiresAt,
          createdAt: existingKey.createdAt
        }
      });
    }

    // Generate API key
    const { key, hash, prefix } = await generateKeyPackage(keyType, metadata);

    // Calculate expiry
    const expiresAt = calculateExpiryDate(isSandboxKey, durationDays);

    // Create key document
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
      createdBy: req.user._id,
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
      warning: 'IMPORTANT: Save this key securely. It will not be shown again.',
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

    // Create new key
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
      createdBy: req.user._id,
      creatorRole: req.user.userType,
      renewedFrom: oldKey._id
    });

    await newKey.save();

    // Revoke old key
    oldKey.status = 'REVOKED';
    oldKey.revokedAt = new Date();
    oldKey.revokedBy = req.user._id;
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

    // Revoke key
    await key.revoke(req.user._id, reason);

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