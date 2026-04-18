'use strict';

const express  = require('express');
const router   = express.Router();

const { esgKeyMiddleware } = require('../middleware/esgApiKeyAuth');
const ingestionCtrl        = require('../controllers/ingestionController');

// No JWT auth on these routes — protected by ESG API key in URL path
// Rate limited inside esgApiKeyAuth middleware (100 req/min per key)

router.post(
  '/:clientId/:nodeId/:mappingId/:apiKey/api-data',
  esgKeyMiddleware.esgAPI,
  ingestionCtrl.ingestApiData
);

router.post(
  '/:clientId/:nodeId/:mappingId/:apiKey/iot-data',
  esgKeyMiddleware.esgIoT,
  ingestionCtrl.ingestIotData
);

module.exports = router;
