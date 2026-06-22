'use strict';

const express  = require('express');
const router   = express.Router();

const { esgKeyMiddleware } = require('../middleware/esgApiKeyAuth');
const ingestionCtrl        = require('../controllers/ingestionController');

// Parses XML and CSV request bodies as raw text strings so ingestionController
// can detect the format and parse accordingly. JSON is already handled globally.
const rawTextParser = express.text({
  type: ['text/xml', 'application/xml', 'text/csv', 'application/csv', 'text/plain'],
  limit: '10mb',
});

// No JWT auth on these routes — protected by X-API-Key header
// Rate limited inside esgApiKeyAuth middleware (100 req/min per key)

router.post(
  '/:clientId/:nodeId/:mappingId/api-data',
  rawTextParser,
  esgKeyMiddleware.esgAPI,
  ingestionCtrl.ingestApiData
);

router.post(
  '/:clientId/:nodeId/:mappingId/iot-data',
  esgKeyMiddleware.esgIoT,
  ingestionCtrl.ingestIotData
);

module.exports = router;
