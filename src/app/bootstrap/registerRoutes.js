'use strict';

// ============================================================================
// ROUTE IMPORTS
// ============================================================================

const userR                      = require('../../common/routes/userR');
const clientR                    = require('../../modules/client-management/client/clientR');
const sandboxRoutes              = require('../../modules/client-management/sandbox/sandboxRoutes');
const quotaRoutes                = require('../../modules/client-management/quota/quotaRoutes');
const cctsRoutes                 = require('../../modules/client-management/ccts/cctsRoutes');

const flowchartR                 = require('../../modules/zero-carbon/organization/routes/flowchartR');
const processFlowR               = require('../../modules/zero-carbon/organization/routes/processflowR');
const transportFlowRouter        = require('../../modules/zero-carbon/organization/routes/transportFlowR');
const { surveyAuthRouter,
        surveyPublicRouter }     = require('../../modules/zero-carbon/organization/routes/surveyRoutes');

const defraDataR                 = require('../../modules/zero-carbon/emission-factor/routes/defraData');
const gwpRoutes                  = require('../../modules/zero-carbon/emission-factor/routes/gwpRoutes');
const fuelCombustionRoutes       = require('../../modules/zero-carbon/emission-factor/routes/fuelCombustionRoutes');
const CountryemissionFactorRouter = require('../../modules/zero-carbon/emission-factor/routes/countryemissionFactorRouter');
const EmissionFactorHub          = require('../../modules/zero-carbon/emission-factor/routes/EmissionFactorHubRoutes');
const ipccDataRoutes             = require('../../modules/zero-carbon/emission-factor/routes/ipccDataRoutes');
const EPADataRoutes              = require('../../modules/zero-carbon/emission-factor/routes/EPADataRoutes');
const emissionFactorRoutes       = require('../../modules/zero-carbon/emission-factor/routes/emissionFactorRoutes');
const ipccConverstionCalculation = require('../../modules/zero-carbon/emission-factor/routes/IpccConversionCalculation');

const summaryRoutes              = require('../../modules/zero-carbon/calculation/routes/summaryRoutes');

const reductionRoutes            = require('../../modules/zero-carbon/reduction/routes/reductionR');
const netReductionRoutes         = require('../../modules/zero-carbon/reduction/routes/netReductionR');
const FormulaR                   = require('../../modules/zero-carbon/reduction/routes/FormulaR');
const netReductionSummaryR       = require('../../modules/zero-carbon/reduction/routes/netReductionSummaryR');

const DecarbonizationRoutes      = require('../../modules/zero-carbon/decarbonization/sbtiRoutes');
const verificationRoutes         = require('../../modules/zero-carbon/verification/verificationRoutes');

const { dataCollectionRouter,
        iotRouter }              = require('../../modules/zero-carbon/data-collection/routes/dataCollectionRoutes');
const iotRoutes                  = require('../../modules/zero-carbon/iot/iotRoutes');
const apiKeyRoutes               = require('../../modules/zero-carbon/api-key/apiKeyRoutes');

const notificationRoutes         = require('../../common/routes/Notification/notificationRoutes');
const ticketRoutes               = require('../../common/routes/Ticket/ticketRoutes');
const auditLogRoutes             = require('../../common/routes/AuditLog/auditLogRoutes');

// ── ESGLink ───────────────────────────────────────────────────────────────────
const esgLinkBoundaryR           = require('../../modules/esg-link/esgLink_core/boundary/routes/boundaryR');
const esgLinkMetricR             = require('../../modules/esg-link/esgLink_core/metric/routes/metricR');
const esgLinkMappingR            = require('../../modules/esg-link/esgLink_core/boundary/routes/mappingR');
const { submissionR: esgDataR,
        ingestionR: esgIngestR } = require('../../modules/esg-link/esgLink_core/data-collection/routes/index');

// ============================================================================
// REGISTER ALL ROUTES
// ============================================================================

/**
 * Mounts all API routes onto the Express application.
 * @param {import('express').Application} app
 */
function registerRoutes(app) {

  // ── User & client management ──────────────────────────────────────────────
  app.use('/api/users',   userR);
  app.use('/api/clients', clientR);   // includes subscription management — NO gate
  app.use('/api/sandbox', sandboxRoutes);
  app.use('/api/quota',   quotaRoutes);
  app.use('/api/ccts',    cctsRoutes);

  // ── ZeroCarbon feature routes ─────────────────────────────────────────────
  app.use('/api/flowchart',          flowchartR);
  app.use('/api/processflow',        processFlowR);
  app.use('/api/transport-flowchart', transportFlowRouter);
  app.use('/api/summaries',          summaryRoutes);
  app.use('/api/reductions',         reductionRoutes);
  app.use('/api/net-reduction',      netReductionRoutes);
  app.use('/api/formulas',           FormulaR);
  app.use('/api/sbti',               DecarbonizationRoutes);
  app.use('/api/data-collection',    dataCollectionRouter);
  app.use('/api/verification',       verificationRoutes);

  // ── Emission factor reference data ────────────────────────────────────────
  app.use('/api/defra',                    defraDataR);
  app.use('/api/gwp',                      gwpRoutes);
  app.use('/api/fuelCombustion',           fuelCombustionRoutes);
  app.use('/api/country-emission-factors', CountryemissionFactorRouter);
  app.use('/api/emission-factor-hub',      EmissionFactorHub);
  app.use('/api/ipcc',                     ipccDataRoutes);
  app.use('/api/epa',                      EPADataRoutes);
  app.use('/api/emission-factors',         emissionFactorRoutes);
  app.use('/api/emission-factor',          ipccConverstionCalculation);

  // ── IoT ───────────────────────────────────────────────────────────────────
  app.use('/api/iot', iotRoutes);
  app.use('/api/iot', iotRouter);

  // ── API keys, notifications, surveys ─────────────────────────────────────
  app.use('/api/api-keys-mgmt',  apiKeyRoutes);
  app.use('/api/notifications',  notificationRoutes);
  app.use('/api/surveys',        surveyAuthRouter);   // authenticated management
  app.use('/api/survey',         surveyPublicRouter); // public respondent endpoints

  // ── Support & audit ───────────────────────────────────────────────────────
  app.use('/api/tickets',    ticketRoutes);
  app.use('/api/audit-logs', auditLogRoutes);

  // ── ESGLink Core ──────────────────────────────────────────────────────────
  app.use('/api/esglink/core', esgLinkBoundaryR);
  app.use('/api/esglink/core', esgLinkMetricR);
  app.use('/api/esglink/core', esgLinkMappingR);

  // ── ESGLink Data Collection (JWT-protected) ───────────────────────────────
  app.use('/api/esglink/data', esgDataR);

  // ── ESGLink IoT / API Ingestion (API-key protected — no JWT) ─────────────
  app.use('/api/esg-ingest', esgIngestR);
}

module.exports = { registerRoutes };
