const path = require('path');

/**
 * Builds S3 key in STRICT folder structure:
 *
 * {clientId}/{nodeId}/{scopeIdentifier}/data-<timestamp>.csv
 */
function buildCsvS3Key({ clientId, nodeId, scopeIdentifier, fileName }) {
  if (!clientId) throw new Error('buildCsvS3Key: clientId is required');
  if (!nodeId) throw new Error('buildCsvS3Key: nodeId is required');
  if (!scopeIdentifier) throw new Error('buildCsvS3Key: scopeIdentifier is required');

  // Sanitize filename (remove folders, spaces, etc.)
  const ext = path.extname(fileName || '.csv') || '.csv';
  const safeExt = ext.toLowerCase() === '.csv' ? '.csv' : ext;

  const timestamp = Date.now();

  // ✅ FINAL STRUCTURE
  return `${clientId}/${nodeId}/${scopeIdentifier}/data-${timestamp}${safeExt}`;
}

module.exports = { buildCsvS3Key };
