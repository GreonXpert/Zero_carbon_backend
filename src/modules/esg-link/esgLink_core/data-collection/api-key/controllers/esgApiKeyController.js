'use strict';

const esgApiKeyService  = require('../services/esgApiKeyService');
const { canManageApiKey } = require('../../utils/submissionPermissions');

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
    if (!await canManageApiKey(req.user, clientId)) {
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
    if (!await canManageApiKey(req.user, clientId)) {
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
    if (!await canManageApiKey(req.user, clientId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const result = await esgApiKeyService.renewKey(keyId, clientId, req.user);
    if (result.error) return res.status(result.status || 400).json({ success: false, message: result.error });
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
    if (!await canManageApiKey(req.user, clientId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const result = await esgApiKeyService.revokeKey(keyId, clientId, req.user, req.body?.reason);
    if (result.error) return res.status(result.status || 400).json({ success: false, message: result.error });
    return res.json({ success: true, message: 'Key revoked successfully' });
  } catch (err) {
    console.error('[esgApiKeyController.revokeKey]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

module.exports = { createKey, listKeys, getKeyDetails, renewKey, revokeKey };
