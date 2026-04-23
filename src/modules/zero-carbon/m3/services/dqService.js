'use strict';

const DataQualityFlag = require('../models/DataQualityFlag');

/**
 * Creates or updates a Data Quality Flag for an entity.
 * Idempotent — won't duplicate open flags of the same code.
 */
async function raiseFlag({ clientId, entityType, entityId, flagCode, severity, message, hint }) {
  return DataQualityFlag.findOneAndUpdate(
    {
      clientId,
      entity_type: entityType,
      entity_id:   String(entityId),
      flag_code:   flagCode,
      resolved:    false,
    },
    {
      $setOnInsert: {
        severity,
        message,
        remediation_hint: hint || null,
      },
    },
    { upsert: true, new: true }
  );
}

async function resolveFlag({ clientId, entityType, entityId, flagCode, resolvedBy }) {
  return DataQualityFlag.findOneAndUpdate(
    {
      clientId,
      entity_type: entityType,
      entity_id:   String(entityId),
      flag_code:   flagCode,
      resolved:    false,
    },
    {
      $set: {
        resolved:    true,
        resolved_by: resolvedBy,
        resolved_at: new Date(),
      },
    }
  );
}

async function listFlags({ clientId, entityType, entityId, severity, resolved }) {
  const query = { clientId };
  if (entityType) query.entity_type = entityType;
  if (entityId)   query.entity_id   = String(entityId);
  if (severity)   query.severity    = severity;
  if (resolved !== undefined) query.resolved = resolved;
  return DataQualityFlag.find(query).sort({ created_at: -1 });
}

async function hasBlockers(entityType, entityId) {
  const count = await DataQualityFlag.countDocuments({
    entity_type: entityType,
    entity_id:   String(entityId),
    severity:    'BLOCKER',
    resolved:    false,
  });
  return count > 0;
}

module.exports = { raiseFlag, resolveFlag, listFlags, hasBlockers };
