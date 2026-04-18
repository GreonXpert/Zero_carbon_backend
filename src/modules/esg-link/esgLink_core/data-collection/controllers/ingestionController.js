'use strict';

const submissionService = require('../services/submissionService');
const { getPeriodLabel } = require('../utils/esgFrequencyHelper');

// ── POST /api/esg-ingest/:clientId/:nodeId/:mappingId/:apiKey/api-data ─────────
async function ingestApiData(req, res) {
  try {
    return _ingest(req, res, 'api', 'ESG_API');
  } catch (err) {
    console.error('[ingestionController.ingestApiData]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── POST /api/esg-ingest/:clientId/:nodeId/:mappingId/:apiKey/iot-data ─────────
async function ingestIotData(req, res) {
  try {
    return _ingest(req, res, 'iot', 'ESG_IOT');
  } catch (err) {
    console.error('[ingestionController.ingestIotData]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

async function _ingest(req, res, inputType, keyType) {
  const apiKeyInfo  = req.esgApiKey; // attached by esgApiKeyAuth middleware
  const { clientId, nodeId, mappingId } = req.params;
  const {
    dataValues,
    timestamp,
    idempotencyKey,
    rawPayload,
  } = req.body || {};

  if (!dataValues || typeof dataValues !== 'object') {
    return res.status(400).json({ success: false, message: 'dataValues object is required' });
  }

  // ── Determine period from timestamp or now ─────────────────────────────────
  // We need frequency from mapping — resolve it
  const resolved = await submissionService.resolveMapping(clientId, nodeId, mappingId);
  if (!resolved) {
    return res.status(404).json({ success: false, message: 'Mapping not found' });
  }

  const frequency   = resolved.mapping.frequency || 'monthly';
  const ts          = timestamp ? new Date(timestamp) : new Date();
  const periodLabel = getPeriodLabel(frequency, ts);
  const year        = ts.getFullYear();

  // ── Build a synthetic actor from the API key ──────────────────────────────
  const syntheticActor = {
    _id:      apiKeyInfo.id,
    userType: keyType === 'ESG_API' ? 'api_integration' : 'iot_integration',
    userName: `API Key ${apiKeyInfo.prefix}`,
  };

  const result = await submissionService.create(
    {
      clientId,
      nodeId,
      mappingId,
      period: { year, periodLabel },
      dataValues,
      inputType,
      submissionSource: inputType === 'api' ? 'api' : 'iot',
      submitImmediately: true,
      ingestionIdempotencyKey: idempotencyKey || null,
      rawPayload: rawPayload || null,
    },
    syntheticActor,
    { req }
  );

  // Idempotency key conflict (unique sparse index violation)
  if (result.error && result.error.includes('duplicate key')) {
    return res.status(409).json({ success: false, message: 'Duplicate ingestion: this idempotencyKey has already been processed' });
  }

  if (result.error) {
    return res.status(result.status || 400).json({ success: false, message: result.error });
  }

  return res.status(201).json({
    success: true,
    data: { submissionId: result.doc._id, workflowStatus: result.doc.workflowStatus },
    message: 'Data ingested successfully',
  });
}

module.exports = { ingestApiData, ingestIotData };
