'use strict';

const csv         = require('csvtojson');
const { XMLParser } = require('fast-xml-parser');
const submissionService = require('../services/submissionService');
const { getPeriodLabel } = require('../utils/esgFrequencyHelper');

// ── IST timestamp helpers ─────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30

/**
 * Resolve a timestamp to a Date whose local-time methods (getFullYear, getMonth, etc.)
 * return IST (UTC+5:30) values — used for period label generation.
 *
 * Accepted formats for `raw`:
 *   (none)                    → current IST date/time (auto)
 *   dd/mm/yyyy                → midnight IST on that date
 *   dd-mm-yyyy                → same with hyphen separator
 *   dd/mm/yyyy HH:MM:SS       → specific IST datetime
 *   dd-mm-yyyy HH:MM:SS       → same with hyphen separator
 *   ISO 8601 / any JS string  → converted to its IST equivalent
 */
function resolveISTDate(raw) {
  if (!raw) {
    // No timestamp supplied — use current IST time
    return new Date(Date.now() + IST_OFFSET_MS);
  }

  const s = String(raw).trim();

  // Indian format: dd/mm/yyyy or dd-mm-yyyy with optional HH:MM:SS
  const m = s.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/);
  if (m) {
    const [, dd, mm, yyyy, HH = '00', MM = '00', SS = '00'] = m;
    // Build a Date whose UTC values equal the given IST components
    // so that getFullYear()/getMonth() on a UTC server return IST values.
    return new Date(Date.UTC(
      parseInt(yyyy, 10),
      parseInt(mm, 10) - 1,
      parseInt(dd, 10),
      parseInt(HH, 10),
      parseInt(MM, 10),
      parseInt(SS, 10),
    ));
  }

  // ISO 8601 or any other parseable format — shift to IST
  const d = new Date(s);
  return new Date((isNaN(d.getTime()) ? Date.now() : d.getTime()) + IST_OFFSET_MS);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Check req.ip against an ipWhitelist array.
 * Empty / null whitelist → allow all.
 * Supports exact IP match and simple CIDR prefix match (first 3 octets).
 */
function isIpAllowed(remoteIp, ipWhitelist) {
  if (!ipWhitelist || ipWhitelist.length === 0) return true;
  return ipWhitelist.some((entry) => {
    if (entry.includes('/')) {
      return remoteIp.startsWith(entry.split('/')[0].split('.').slice(0, 3).join('.'));
    }
    return remoteIp === entry;
  });
}

/**
 * Parse the incoming request body according to the mapping's apiConfig.dataFormat.
 * Returns { dataValues, rawPayload } on success, or { error, status } on failure.
 *
 * - json      → req.body is already an object (Express JSON middleware)
 * - form_data → req.body is already an object (Express urlencoded middleware)
 * - xml       → req.body is a raw text string (rawTextParser middleware in ingestionR.js)
 * - csv       → req.body is a raw text string (rawTextParser middleware in ingestionR.js)
 */
async function parseApiPayload(req, dataFormat) {
  const body = req.body;

  if (dataFormat === 'json') {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { error: 'Invalid json payload: expected a JSON object body', status: 400 };
    }
    const { dataValues, timestamp, idempotencyKey } = body;
    if (!dataValues || typeof dataValues !== 'object') {
      return { error: 'dataValues object is required', status: 400 };
    }
    return { dataValues, rawPayload: body, timestamp, idempotencyKey };
  }

  if (dataFormat === 'form_data') {
    if (!body || typeof body !== 'object') {
      return { error: 'Invalid form_data payload: expected form-encoded body', status: 400 };
    }
    const { dataValues, timestamp, idempotencyKey } = body;
    if (!dataValues || typeof dataValues !== 'object') {
      return { error: 'dataValues object is required in form data', status: 400 };
    }
    return { dataValues, rawPayload: body, timestamp, idempotencyKey };
  }

  if (dataFormat === 'xml') {
    if (typeof body !== 'string' || !body.trim()) {
      return { error: 'Invalid xml payload: expected a raw XML string body (Content-Type: application/xml)', status: 400 };
    }
    try {
      const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
      const parsed = parser.parse(body);
      // Unwrap the root element — take the first child object as dataValues
      const keys = Object.keys(parsed);
      const dataValues = keys.length > 0 ? parsed[keys[0]] : parsed;
      if (typeof dataValues !== 'object' || Array.isArray(dataValues)) {
        return { error: 'Invalid xml payload: root element must be an object', status: 400 };
      }
      // Optional fields from XML attributes or sibling elements
      const timestamp     = parsed.timestamp     || parsed['@_timestamp']     || null;
      const idempotencyKey = parsed.idempotencyKey || parsed['@_idempotencyKey'] || null;
      return { dataValues, rawPayload: body, timestamp, idempotencyKey };
    } catch (err) {
      return { error: `Invalid xml payload: ${err.message}`, status: 400 };
    }
  }

  if (dataFormat === 'csv') {
    if (typeof body !== 'string' || !body.trim()) {
      return { error: 'Invalid csv payload: expected a raw CSV string body (Content-Type: text/csv)', status: 400 };
    }
    try {
      const rows = await csv().fromString(body);
      if (!rows || rows.length === 0) {
        return { error: 'Invalid csv payload: no rows found', status: 400 };
      }
      // Use the first row as dataValues; subsequent rows are ignored for single-entry ingestion
      const dataValues = rows[0];
      return { dataValues, rawPayload: body, timestamp: null, idempotencyKey: null };
    } catch (err) {
      return { error: `Invalid csv payload: ${err.message}`, status: 400 };
    }
  }

  return { error: `Unsupported dataFormat: ${dataFormat}`, status: 400 };
}

// ── POST /:clientId/:nodeId/:mappingId/:apiKey/api-data ───────────────────────
async function ingestApiData(req, res) {
  try {
    return await _ingest(req, res, 'api', 'ESG_API');
  } catch (err) {
    console.error('[ingestionController.ingestApiData]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ── POST /:clientId/:nodeId/:mappingId/:apiKey/iot-data ───────────────────────
async function ingestIotData(req, res) {
  try {
    return await _ingest(req, res, 'iot', 'ESG_IOT');
  } catch (err) {
    console.error('[ingestionController.ingestIotData]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

async function _ingest(req, res, inputType, keyType) {
  const apiKeyInfo  = req.esgApiKey; // attached by esgApiKeyAuth middleware
  const { clientId, nodeId, mappingId } = req.params;

  // ── Resolve mapping ────────────────────────────────────────────────────────
  const resolved = await submissionService.resolveMapping(clientId, nodeId, mappingId);
  if (!resolved) {
    return res.status(404).json({ success: false, message: 'Mapping not found' });
  }

  // ── API path: apiConfig validation ────────────────────────────────────────
  let dataValues, rawPayload, timestamp, idempotencyKey;

  if (inputType === 'api') {
    const apiConfig  = resolved.mapping.apiConfig || {};
    const dataFormat = (apiConfig.dataFormat || 'json').toLowerCase();

    // IP whitelist check (config-level, separate from key-level check in middleware)
    const remoteIp = req.ip || req.connection?.remoteAddress || '';
    if (!isIpAllowed(remoteIp, apiConfig.ipWhitelist)) {
      return res.status(403).json({
        success: false,
        message: `IP address "${remoteIp}" is not permitted by this metric's API config whitelist`,
      });
    }

    // Parse body according to configured dataFormat
    const parsed = await parseApiPayload(req, dataFormat);
    if (parsed.error) {
      return res.status(parsed.status || 400).json({ success: false, message: parsed.error });
    }

    dataValues      = parsed.dataValues;
    rawPayload      = parsed.rawPayload;
    timestamp       = parsed.timestamp;
    idempotencyKey  = parsed.idempotencyKey;
  }

  // ── IoT path: iotConfig validation ────────────────────────────────────────
  if (inputType === 'iot') {
    const body      = req.body || {};
    const iotConfig = resolved.mapping.iotConfig || {};

    // deviceId check — enforced whenever iotConfig.deviceId is configured
    if (iotConfig.deviceId) {
      if (!body.deviceId) {
        return res.status(400).json({
          success: false,
          message: `deviceId is required. Expected "${iotConfig.deviceId}"`,
        });
      }
      if (body.deviceId !== iotConfig.deviceId) {
        return res.status(400).json({
          success: false,
          message: `deviceId mismatch: expected "${iotConfig.deviceId}", received "${body.deviceId}"`,
        });
      }
    }

    // protocol check — enforced only when both sides provide it
    if (iotConfig.protocol && body.protocol && body.protocol !== iotConfig.protocol) {
      return res.status(400).json({
        success: false,
        message: `Protocol mismatch: expected "${iotConfig.protocol}", received "${body.protocol}"`,
      });
    }

    // Extract data from IoT body (always JSON for IoT)
    if (!body.dataValues || typeof body.dataValues !== 'object') {
      return res.status(400).json({ success: false, message: 'dataValues object is required' });
    }
    dataValues     = body.dataValues;
    rawPayload     = body;
    timestamp      = body.timestamp     || null;
    idempotencyKey = body.idempotencyKey || null;
  }

  // ── Determine period — always in IST (UTC+5:30) ───────────────────────────
  // API & IoT: mapping frequency is irrelevant — every incoming payload is
  // accepted and saved.  Period is labelled by the actual submission date
  // (daily format: yyyy-mm-dd) so each call gets a meaningful timestamp-
  // based bucket, independent of how the metric was configured.
  const ts          = resolveISTDate(timestamp);          // auto-IST when omitted
  const periodLabel = getPeriodLabel('daily', ts);        // e.g. "2026-05-22"
  const year        = ts.getFullYear();

  // ── Build a synthetic actor from the API key ───────────────────────────────
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
      submitImmediately:   true,
      skipDuplicateCheck:  true,   // API/IoT: always accept every submission
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
