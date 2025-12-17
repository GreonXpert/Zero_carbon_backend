// utils/upload/organisation/csv/_key.js
const path = require('path');

function sanitizeSegment(seg = '') {
  return String(seg).replace(/[^\w\-@.]+/g, '_'); // removes /, spaces, etc.
}

function sanitizeFileName(name = 'uploaded.csv') {
  const base = path.basename(String(name));
  return base.replace(/[^\w\-@.]+/g, '_');
}

function buildCsvS3Key({ clientId, nodeId, scopeIdentifier, fileName }) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${sanitizeSegment(clientId)}/${sanitizeSegment(nodeId)}/${sanitizeSegment(scopeIdentifier)}/${ts}_${sanitizeFileName(fileName)}`;
}

module.exports = { buildCsvS3Key, sanitizeFileName, sanitizeSegment };
