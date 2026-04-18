'use strict';

const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const EsgApiKey = require('../models/EsgApiKey');

const BCRYPT_ROUNDS = 12;
const PREFIX_LENGTH = 8;

/**
 * Generate a new plaintext key, hash, and prefix.
 */
async function generateKeyPackage(keyType) {
  const plaintext = `ESG_${uuidv4().replace(/-/g, '')}`;
  const hash      = await bcrypt.hash(plaintext, BCRYPT_ROUNDS);
  const prefix    = plaintext.substring(0, PREFIX_LENGTH);
  return { plaintext, hash, prefix };
}

/**
 * Create a new ESG API key for a specific mapping.
 */
async function createKey({ clientId, nodeId, mappingId, metricId, keyType, description, durationDays, ipWhitelist, actor }) {
  const { plaintext, hash, prefix } = await generateKeyPackage(keyType);

  const days      = Math.max(1, parseInt(durationDays, 10) || 365);
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const key = new EsgApiKey({
    clientId,
    nodeId,
    mappingId,
    metricId:    metricId || null,
    keyType,
    keyHash:     hash,
    keyPrefix:   prefix,
    status:      'ACTIVE',
    expiresAt,
    createdBy:   actor._id || actor.id,
    creatorRole: actor.userType,
    description: description || '',
    ipWhitelist: ipWhitelist || [],
  });

  await key.save();
  return { key, plaintext };
}

/**
 * Renew an existing key: revoke old, create new.
 */
async function renewKey(keyId, clientId, actor) {
  const oldKey = await EsgApiKey.findOne({ _id: keyId, clientId });
  if (!oldKey) return { error: 'Key not found', status: 404 };

  await oldKey.revoke(actor._id || actor.id, 'Renewed');

  const { plaintext, hash, prefix } = await generateKeyPackage(oldKey.keyType);
  const days      = 365;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const newKey = new EsgApiKey({
    clientId:    oldKey.clientId,
    nodeId:      oldKey.nodeId,
    mappingId:   oldKey.mappingId,
    metricId:    oldKey.metricId,
    keyType:     oldKey.keyType,
    keyHash:     hash,
    keyPrefix:   prefix,
    status:      'ACTIVE',
    expiresAt,
    createdBy:   actor._id || actor.id,
    creatorRole: actor.userType,
    description: oldKey.description,
    ipWhitelist: oldKey.ipWhitelist,
  });
  await newKey.save();

  return { key: newKey, plaintext };
}

/**
 * List keys for a client with optional filters.
 */
async function listKeys(clientId, filters = {}) {
  const query = { clientId };
  if (filters.status)    query.status    = filters.status;
  if (filters.keyType)   query.keyType   = filters.keyType;
  if (filters.nodeId)    query.nodeId    = filters.nodeId;
  if (filters.mappingId) query.mappingId = filters.mappingId;

  const keys  = await EsgApiKey.find(query).select('-keyHash').sort({ createdAt: -1 });
  return { keys, total: keys.length };
}

/**
 * Get one key (without hash).
 */
async function getKeyDetails(keyId, clientId) {
  const key = await EsgApiKey.findOne({ _id: keyId, clientId }).select('-keyHash');
  if (!key) return { error: 'Key not found', status: 404 };
  return { key };
}

/**
 * Revoke a key.
 */
async function revokeKey(keyId, clientId, actor, reason) {
  const key = await EsgApiKey.findOne({ _id: keyId, clientId });
  if (!key) return { error: 'Key not found', status: 404 };
  await key.revoke(actor._id || actor.id, reason || 'Manually revoked');
  return { success: true };
}

module.exports = { createKey, renewKey, listKeys, getKeyDetails, revokeKey };
