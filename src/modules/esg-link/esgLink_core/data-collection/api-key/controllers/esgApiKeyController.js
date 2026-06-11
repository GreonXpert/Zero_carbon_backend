'use strict';

const esgApiKeyService  = require('../services/esgApiKeyService');
const { canManageApiKey, canReadApiKeys } = require('../../utils/submissionPermissions');
const EsgApiKey = require('../models/EsgApiKey');
const Client    = require('../../../../../client-management/client/Client');
const { createEsgApiKeyNotification } = require('../../../../../client-management/utils/notificationHelper');
const { logEventFireAndForget } = require('../../../../../../common/services/audit/auditLogService');

async function createKey(req, res) {
  try {
    const { clientId } = req.params;
    const actor = req.user;

    if (!await canManageApiKey(actor, clientId)) {
      return res.status(403).json({ success: false, message: 'Not authorized to manage API keys for this client' });
    }

    const { nodeId, mappingId, metricId, keyType, description, durationDays, ipWhitelist } = req.body;

    if (!nodeId || !mappingId || !keyType) {
      return res.status(400).json({ success: false, message: 'nodeId, mappingId, and keyType are required' });
    }
    if (!['ESG_API', 'ESG_IOT'].includes(keyType)) {
      return res.status(400).json({ success: false, message: 'keyType must be ESG_API or ESG_IOT' });
    }

    const result = await esgApiKeyService.createKey({
      clientId, nodeId, mappingId, metricId, keyType,
      description, durationDays, ipWhitelist, actor,
    });

    if (result.error) {
      return res.status(result.status || 400).json({ success: false, message: result.error });
    }

    return res.status(201).json({
      success: true,
      data: {
        apiKey:    result.plaintext,
        keyPrefix: result.key.keyPrefix,
        keyType:   result.key.keyType,
        expiresAt: result.key.expiresAt,
        nodeId:    result.key.nodeId,
        mappingId: result.key.mappingId,
        _id:       result.key._id,
      },
      message: 'API key created. This is the only time the full key will be shown.',
    });
  } catch (err) {
    console.error('[esgApiKeyController.createKey]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

async function listKeys(req, res) {
  try {
    const { clientId } = req.params;
    if (!await canReadApiKeys(req.user, clientId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const result = await esgApiKeyService.listKeys(clientId, req.query);
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('[esgApiKeyController.listKeys]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

async function getKeyDetails(req, res) {
  try {
    const { clientId, keyId } = req.params;
    if (!await canReadApiKeys(req.user, clientId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const result = await esgApiKeyService.getKeyDetails(keyId, clientId);
    if (result.error) return res.status(result.status || 404).json({ success: false, message: result.error });
    return res.json({ success: true, data: result.key });
  } catch (err) {
    console.error('[esgApiKeyController.getKeyDetails]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

async function renewKey(req, res) {
  try {
    const { clientId, keyId } = req.params;
    const actor = req.user;
    // client_admin may renew keys that belong to their own client
    const isClientAdminOwner = actor.userType === 'client_admin' && String(actor.clientId) === String(clientId);
    if (!await canManageApiKey(actor, clientId) && !isClientAdminOwner) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const result = await esgApiKeyService.renewKey(keyId, clientId, req.user);
    if (result.error) return res.status(result.status || 400).json({ success: false, message: result.error });

    Client.findOne({ clientId }).then((client) => {
      if (client) createEsgApiKeyNotification('renewed', result.key, client);
    }).catch((err) => console.error('[esgApiKeyController.renewKey] notification error:', err));

    return res.status(201).json({
      success: true,
      data: {
        apiKey:    result.plaintext,
        keyPrefix: result.key.keyPrefix,
        keyType:   result.key.keyType,
        expiresAt: result.key.expiresAt,
        _id:       result.key._id,
      },
      message: 'Key renewed. This is the only time the new full key will be shown.',
    });
  } catch (err) {
    console.error('[esgApiKeyController.renewKey]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

async function revokeKey(req, res) {
  try {
    const { clientId, keyId } = req.params;
    const actor = req.user;
    // client_admin may revoke keys that belong to their own client
    const isClientAdminOwner = actor.userType === 'client_admin' && String(actor.clientId) === String(clientId);
    if (!await canManageApiKey(actor, clientId) && !isClientAdminOwner) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const result = await esgApiKeyService.revokeKey(keyId, clientId, req.user, req.body?.reason);
    if (result.error) return res.status(result.status || 400).json({ success: false, message: result.error });

    EsgApiKey.findById(keyId).select('keyPrefix keyType nodeId mappingId expiresAt').then((revokedKey) => {
      if (!revokedKey) return;
      Client.findOne({ clientId }).then((client) => {
        if (client) createEsgApiKeyNotification('revoked', revokedKey, client);
      });
    }).catch((err) => console.error('[esgApiKeyController.revokeKey] notification error:', err));

    return res.json({ success: true, message: 'Key revoked successfully' });
  } catch (err) {
    console.error('[esgApiKeyController.revokeKey]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── Allowed roles for connect / disconnect ────────────────────────────────────
const CONN_ALLOWED_ROLES = new Set([
  'super_admin', 'consultant_admin', 'consultant', 'client_admin', 'contributor',
]);

/**
 * PATCH /:clientId/esg-api-keys/:keyId/disconnect
 * Pauses data ingestion for this key without revoking it.
 * Allowed: super_admin, consultant_admin, consultant, client_admin (own client), contributor.
 */
async function disconnectKey(req, res) {
  try {
    const { clientId, keyId } = req.params;
    const actor = req.user;

    if (!CONN_ALLOWED_ROLES.has(actor.userType)) {
      return res.status(403).json({ success: false, message: 'Insufficient permissions' });
    }
    if (actor.userType === 'client_admin' && actor.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Access denied: not your client' });
    }

    const key = await EsgApiKey.findOne({ _id: keyId, clientId, status: 'ACTIVE' });
    if (!key) {
      return res.status(404).json({ success: false, message: 'Active key not found' });
    }
    if (key.connectionStatus === 'disconnected') {
      return res.json({ success: true, message: 'Already disconnected', connectionStatus: 'disconnected' });
    }

    key.connectionStatus = 'disconnected';
    key.disconnectedAt   = new Date();
    key.disconnectedBy   = actor._id;
    await key.save();

    logEventFireAndForget({
      req,
      module:        key.keyType === 'ESG_IOT' ? 'iot_integration' : 'api_integration',
      action:        'disconnect',
      entityType:    'EsgApiKey',
      entityId:      String(key._id),
      clientId,
      changeSummary: `${actor.userName || actor.userType} disconnected ${key.keyType} key ${key.keyPrefix} (node: ${key.nodeId}, mapping: ${key.mappingId})`,
      metadata: { keyPrefix: key.keyPrefix, keyType: key.keyType, nodeId: key.nodeId, mappingId: key.mappingId },
      source:        key.keyType === 'ESG_IOT' ? 'iot' : 'api',
      severity:      'info',
    });

    return res.json({
      success: true,
      message: 'Source disconnected. Data ingestion paused.',
      connectionStatus: 'disconnected',
    });
  } catch (err) {
    console.error('[esgApiKeyController.disconnectKey]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

/**
 * PATCH /:clientId/esg-api-keys/:keyId/connect
 * Re-enables data ingestion for a previously disconnected key.
 * Allowed: same roles as disconnectKey.
 */
async function connectKey(req, res) {
  try {
    const { clientId, keyId } = req.params;
    const actor = req.user;

    if (!CONN_ALLOWED_ROLES.has(actor.userType)) {
      return res.status(403).json({ success: false, message: 'Insufficient permissions' });
    }
    if (actor.userType === 'client_admin' && actor.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Access denied: not your client' });
    }

    const key = await EsgApiKey.findOne({ _id: keyId, clientId, status: 'ACTIVE' });
    if (!key) {
      return res.status(404).json({ success: false, message: 'Active key not found' });
    }
    if (key.connectionStatus === 'connected') {
      return res.json({ success: true, message: 'Already connected', connectionStatus: 'connected' });
    }

    key.connectionStatus = 'connected';
    key.reconnectedAt    = new Date();
    key.reconnectedBy    = actor._id;
    await key.save();

    logEventFireAndForget({
      req,
      module:        key.keyType === 'ESG_IOT' ? 'iot_integration' : 'api_integration',
      action:        'connect',
      entityType:    'EsgApiKey',
      entityId:      String(key._id),
      clientId,
      changeSummary: `${actor.userName || actor.userType} connected ${key.keyType} key ${key.keyPrefix} (node: ${key.nodeId}, mapping: ${key.mappingId})`,
      metadata: { keyPrefix: key.keyPrefix, keyType: key.keyType, nodeId: key.nodeId, mappingId: key.mappingId },
      source:        key.keyType === 'ESG_IOT' ? 'iot' : 'api',
      severity:      'info',
    });

    return res.json({
      success: true,
      message: 'Source connected. Data ingestion active.',
      connectionStatus: 'connected',
    });
  } catch (err) {
    console.error('[esgApiKeyController.connectKey]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

module.exports = { createKey, listKeys, getKeyDetails, renewKey, revokeKey, connectKey, disconnectKey };
