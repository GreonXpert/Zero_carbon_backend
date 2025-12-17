const path = require('path');

const safe = (v = '') => String(v).replace(/[^\w\-@.]+/g, '_');

function buildReductionCsvKey({
  clientId,
  projectId,
  calculationMethodology,
  fileName
}) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${safe(clientId)}/${safe(projectId)}/${safe(calculationMethodology)}/${ts}_${safe(
    path.basename(fileName || 'uploaded.csv')
  )}`;
}

module.exports = { buildReductionCsvKey };
