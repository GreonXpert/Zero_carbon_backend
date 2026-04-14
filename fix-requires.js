/**
 * fix-requires.js  (v2 — suffix-matching)
 * Rewrites all relative require() paths inside moved src/ files.
 * Strategy: strip leading ../ segments from each require string,
 * check if the remaining suffix matches a known old->new path mapping,
 * then recompute the correct relative path from the file's current location.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname);

// Map: old project-relative path suffix -> new project-relative path
const pathMap = {
  // Config
  'config/db': 'src/common/config/db',

  // Middleware
  'middleware/auth': 'src/common/middleware/auth',
  'middleware/apiKeyAuth': 'src/modules/zero-carbon/api-key/middleware/apiKeyAuth',
  'middleware/sandboxAuth': 'src/modules/client-management/sandbox/sandboxAuth',
  'middleware/compression': 'src/common/middleware/compression',
  'middleware/errorHandler': 'src/common/middleware/errorHandler',
  'middleware/rateLimit': 'src/common/middleware/rateLimit',
  'middleware/validation': 'src/common/middleware/validation',

  // Models - Common
  'models/User': 'src/common/models/User',
  'models/UserSession': 'src/common/models/UserSession',
  'models/AuditLog/AuditLog': 'src/common/models/AuditLog/AuditLog',
  'models/Notification/Notification': 'src/common/models/Notification/Notification',
  'models/Ticket/Ticket': 'src/common/models/Ticket/Ticket',
  'models/Ticket/TicketActivity': 'src/common/models/Ticket/TicketActivity',
  'models/Ticket/TicketChat': 'src/common/models/Ticket/TicketChat',

  // Models - Client Management
  'models/CMS/Client': 'src/modules/client-management/client/Client',
  'models/CMS/ClientSandbox': 'src/modules/client-management/sandbox/ClientSandbox',
  'models/Quota/ConsultantClientQuota': 'src/modules/client-management/quota/ConsultantClientQuota',
  'models/CCTS/CCTSEntity': 'src/modules/client-management/ccts/CCTSEntity',

  // Models - ZeroCarbon
  'models/ApiKey': 'src/modules/zero-carbon/api-key/ApiKey',
  'models/ApiKeyRequest': 'src/modules/zero-carbon/api-key/ApiKeyRequest',
  'models/IOTData': 'src/modules/zero-carbon/iot/IOTData',
  'models/CalculationEmission/EmissionSummary': 'src/modules/zero-carbon/calculation/EmissionSummary',
  'models/EmissionSummary': 'src/modules/zero-carbon/calculation/EmissionSummary',
  'models/Decarbonization/SbtiTarget': 'src/modules/zero-carbon/decarbonization/SbtiTarget',
  'models/EmissionFactor/DefraData': 'src/modules/zero-carbon/emission-factor/models/DefraData',
  'models/EmissionFactor/EPAData': 'src/modules/zero-carbon/emission-factor/models/EPAData',
  'models/EmissionFactor/EmissionFactorHub': 'src/modules/zero-carbon/emission-factor/models/EmissionFactorHub',
  'models/EmissionFactor/FuelCombustion': 'src/modules/zero-carbon/emission-factor/models/FuelCombustion',
  'models/EmissionFactor/GWP': 'src/modules/zero-carbon/emission-factor/models/GWP',
  'models/EmissionFactor/IPCCData': 'src/modules/zero-carbon/emission-factor/models/IPCCData',
  'models/EmissionFactor/countryEmissionFactorModel': 'src/modules/zero-carbon/emission-factor/models/countryEmissionFactorModel',
  'models/Organization/AnonymousCode': 'src/modules/zero-carbon/organization/models/AnonymousCode',
  'models/Organization/DataCollectionConfig': 'src/modules/zero-carbon/organization/models/DataCollectionConfig',
  'models/Organization/DataEntry': 'src/modules/zero-carbon/organization/models/DataEntry',
  'models/Organization/Flowchart': 'src/modules/zero-carbon/organization/models/Flowchart',
  'models/Organization/OCRFeedback': 'src/modules/zero-carbon/organization/models/OCRFeedback',
  'models/Organization/ProcessEmissionDataEntry': 'src/modules/zero-carbon/organization/models/ProcessEmissionDataEntry',
  'models/Organization/ProcessFlowchart': 'src/modules/zero-carbon/organization/models/ProcessFlowchart',
  'models/Organization/SurveyCycle': 'src/modules/zero-carbon/organization/models/SurveyCycle',
  'models/Organization/SurveyLink': 'src/modules/zero-carbon/organization/models/SurveyLink',
  'models/Organization/SurveyResponse': 'src/modules/zero-carbon/organization/models/SurveyResponse',
  'models/Organization/TransportFlowchart': 'src/modules/zero-carbon/organization/models/TransportFlowchart',
  'models/PendingApproval/PendingApproval': 'src/modules/zero-carbon/verification/PendingApproval',
  'models/Reduction/DeleteRequest': 'src/modules/zero-carbon/reduction/models/DeleteRequest',
  'models/Reduction/Formula': 'src/modules/zero-carbon/reduction/models/Formula',
  'models/Reduction/NetReductionEntry': 'src/modules/zero-carbon/reduction/models/NetReductionEntry',
  'models/Reduction/Reduction': 'src/modules/zero-carbon/reduction/models/Reduction',
  'models/Reduction/SummaryNetReduction': 'src/modules/zero-carbon/reduction/models/SummaryNetReduction',
  'models/ThresholdConfig/ThresholdConfig': 'src/modules/zero-carbon/verification/ThresholdConfig',

  // Controllers - Common
  'controllers/userController': 'src/common/controllers/user/userController',
  'controllers/AuditLog/auditLogController': 'src/common/controllers/audit-log/auditLogController',
  'controllers/Notification/notificationControllers': 'src/common/controllers/notification/notificationControllers',
  'controllers/Ticket/ticketController': 'src/common/controllers/ticket/ticketController',
  'controllers/Ticket/ticketChatController': 'src/common/controllers/ticket/ticketChatController',

  // Controllers - Client Management
  'controllers/CMS/clientController': 'src/modules/client-management/client/clientController',
  'controllers/CMS/quotaController': 'src/modules/client-management/quota/quotaController',
  'controllers/CMS/sandboxController': 'src/modules/client-management/sandbox/sandboxController',
  'controllers/CCTS/CCTSController': 'src/modules/client-management/ccts/CCTSController',

  // Controllers - ZeroCarbon
  'controllers/apiKeyController': 'src/modules/zero-carbon/api-key/apiKeyController',
  'controllers/iotController': 'src/modules/zero-carbon/iot/iotController',
  'controllers/Calculation/CalculationSummary': 'src/modules/zero-carbon/calculation/CalculationSummary',
  'controllers/Calculation/emissionCalculationController': 'src/modules/zero-carbon/calculation/emissionCalculationController',
  'controllers/Calculation/emissionIntegration': 'src/modules/zero-carbon/calculation/emissionIntegration',
  'controllers/DataCollection/APIandIot': 'src/modules/zero-carbon/data-collection/controllers/APIandIot',
  'controllers/DataCollection/dataCompletionController': 'src/modules/zero-carbon/data-collection/controllers/dataCompletionController',
  'controllers/DataCollection/monthlyDataSummaryController': 'src/modules/zero-carbon/data-collection/controllers/monthlyDataSummaryController',
  'controllers/Decabonization/sbtiController': 'src/modules/zero-carbon/decarbonization/sbtiController',
  'controllers/EmissionFactor/DefraDataController': 'src/modules/zero-carbon/emission-factor/controllers/DefraDataController',
  'controllers/EmissionFactor/EPADataController': 'src/modules/zero-carbon/emission-factor/controllers/EPADataController',
  'controllers/EmissionFactor/EmissionFactorHubController': 'src/modules/zero-carbon/emission-factor/controllers/EmissionFactorHubController',
  'controllers/EmissionFactor/IpccConverstionCalculation': 'src/modules/zero-carbon/emission-factor/controllers/IpccConversionCalculation',
  'controllers/EmissionFactor/IpccConversionCalculation': 'src/modules/zero-carbon/emission-factor/controllers/IpccConversionCalculation',
  'controllers/EmissionFactor/countryEmissionFactorController': 'src/modules/zero-carbon/emission-factor/controllers/countryEmissionFactorController',
  'controllers/EmissionFactor/emissionFactorController': 'src/modules/zero-carbon/emission-factor/controllers/emissionFactorController',
  'controllers/EmissionFactor/fuelCombustionController': 'src/modules/zero-carbon/emission-factor/controllers/fuelCombustionController',
  'controllers/EmissionFactor/gwpController': 'src/modules/zero-carbon/emission-factor/controllers/gwpController',
  'controllers/EmissionFactor/ipccDataController': 'src/modules/zero-carbon/emission-factor/controllers/ipccDataController',
  'controllers/Organization/DataCleanUp': 'src/modules/zero-carbon/organization/controllers/DataCleanUp',
  'controllers/Organization/dataCollectionController': 'src/modules/zero-carbon/organization/controllers/dataCollectionController',
  'controllers/Organization/dataEntryController': 'src/modules/zero-carbon/organization/controllers/dataEntryController',
  'controllers/Organization/flowchartController': 'src/modules/zero-carbon/organization/controllers/flowchartController',
  'controllers/Organization/ocrDataCollectionController': 'src/modules/zero-carbon/organization/controllers/ocrDataCollectionController',
  'controllers/Organization/ocrFeedbackController': 'src/modules/zero-carbon/organization/controllers/ocrFeedbackController',
  'controllers/Organization/processflowController': 'src/modules/zero-carbon/organization/controllers/processflowController',
  'controllers/Organization/surveyController': 'src/modules/zero-carbon/organization/controllers/surveyController',
  'controllers/Organization/transportFlowController': 'src/modules/zero-carbon/organization/controllers/transportFlowController',
  'controllers/Reduction/FormulaController': 'src/modules/zero-carbon/reduction/controllers/FormulaController',
  'controllers/Reduction/netReductionController': 'src/modules/zero-carbon/reduction/controllers/netReductionController',
  'controllers/Reduction/netReductionSummaryController': 'src/modules/zero-carbon/reduction/controllers/netReductionSummaryController',
  'controllers/Reduction/reductionController': 'src/modules/zero-carbon/reduction/controllers/reductionController',
  'controllers/Reduction/reductionSummaryCalculationService': 'src/modules/zero-carbon/reduction/services/reductionSummaryCalculationService',
  'controllers/verification/thresholdVerificationController': 'src/modules/zero-carbon/verification/thresholdVerificationController',

  // Routes - Common
  'router/userR': 'src/common/routes/userR',
  'router/AuditLog/auditLogRoutes': 'src/common/routes/AuditLog/auditLogRoutes',
  'router/Notification/notificationRoutes': 'src/common/routes/Notification/notificationRoutes',
  'router/Ticket/ticketRoutes': 'src/common/routes/Ticket/ticketRoutes',

  // Routes - Client Management
  'router/CMS/clientR': 'src/modules/client-management/client/clientR',
  'router/CMS/quotaRoutes': 'src/modules/client-management/quota/quotaRoutes',
  'router/CMS/sandboxRoutes': 'src/modules/client-management/sandbox/sandboxRoutes',
  'router/CCTS/cctsRoutes': 'src/modules/client-management/ccts/cctsRoutes',

  // Routes - ZeroCarbon
  'router/apiKeyRoutes': 'src/modules/zero-carbon/api-key/apiKeyRoutes',
  'router/iotRoutes': 'src/modules/zero-carbon/iot/iotRoutes',
  'router/Organization/dataCollectionRoutes': 'src/modules/zero-carbon/data-collection/routes/dataCollectionRoutes',
  'router/Organization/flowchartR': 'src/modules/zero-carbon/organization/routes/flowchartR',
  'router/Organization/processflowR': 'src/modules/zero-carbon/organization/routes/processflowR',
  'router/Organization/surveyRoutes': 'src/modules/zero-carbon/organization/routes/surveyRoutes',
  'router/Organization/transportFlowR': 'src/modules/zero-carbon/organization/routes/transportFlowR',
  'router/Organization/summaryRoutes': 'src/modules/zero-carbon/calculation/routes/summaryRoutes',
  'router/Decarbonization/sbtiRoutes': 'src/modules/zero-carbon/decarbonization/sbtiRoutes',
  'router/EmissionFactor/EPADataRoutes': 'src/modules/zero-carbon/emission-factor/routes/EPADataRoutes',
  'router/EmissionFactor/EmissionFactorHubRoutes': 'src/modules/zero-carbon/emission-factor/routes/EmissionFactorHubRoutes',
  'router/EmissionFactor/IpccConverstionCalculation': 'src/modules/zero-carbon/emission-factor/routes/IpccConversionCalculation',
  'router/EmissionFactor/countryemissionFactorRouter': 'src/modules/zero-carbon/emission-factor/routes/countryemissionFactorRouter',
  'router/EmissionFactor/defraData': 'src/modules/zero-carbon/emission-factor/routes/defraData',
  'router/EmissionFactor/emissionFactorRoutes': 'src/modules/zero-carbon/emission-factor/routes/emissionFactorRoutes',
  'router/EmissionFactor/fuelCombustionRoutes': 'src/modules/zero-carbon/emission-factor/routes/fuelCombustionRoutes',
  'router/EmissionFactor/gwpRoutes': 'src/modules/zero-carbon/emission-factor/routes/gwpRoutes',
  'router/EmissionFactor/ipccDataRoutes': 'src/modules/zero-carbon/emission-factor/routes/ipccDataRoutes',
  'router/Reduction/FormulaR': 'src/modules/zero-carbon/reduction/routes/FormulaR',
  'router/Reduction/netReductionR': 'src/modules/zero-carbon/reduction/routes/netReductionR',
  'router/Reduction/netReductionSummaryR': 'src/modules/zero-carbon/reduction/routes/netReductionSummaryR',
  'router/Reduction/reductionR': 'src/modules/zero-carbon/reduction/routes/reductionR',
  'router/verification/verificationRoutes': 'src/modules/zero-carbon/verification/verificationRoutes',
  'router/dataEntryRoutes': 'src/modules/zero-carbon/organization/routes/dataEntryRoutes',
  'router/emissionRoutes': 'src/modules/zero-carbon/calculation/routes/emissionRoutes',
  'router/fuelUsageRoutes': 'src/modules/zero-carbon/emission-factor/routes/fuelUsageRoutes',

  // Services - Common
  'services/audit/auditLogService': 'src/common/services/audit/auditLogService',

  // Services - Client Management
  'services/quota/quotaService': 'src/modules/client-management/quota/quotaService',

  // Services - ZeroCarbon
  'services/apiKeyLinker': 'src/modules/zero-carbon/api-key/apiKeyLinker',
  'services/emissionFactorSearch.service': 'src/modules/zero-carbon/emission-factor/services/emissionFactorSearch.service',
  'services/audit/dataEntryAuditLog': 'src/modules/zero-carbon/workflow/audit/dataEntryAuditLog',
  'services/audit/flowchartAuditLog': 'src/modules/zero-carbon/workflow/audit/flowchartAuditLog',
  'services/audit/netReductionAuditLog': 'src/modules/zero-carbon/workflow/audit/netReductionAuditLog',
  'services/audit/processFlowchartAuditLog': 'src/modules/zero-carbon/workflow/audit/processFlowchartAuditLog',
  'services/audit/reductionAuditLog': 'src/modules/zero-carbon/workflow/audit/reductionAuditLog',
  'services/audit/sbtiAuditLog': 'src/modules/zero-carbon/decarbonization/services/sbtiAuditLog',
  'services/audit/transportFlowchartAuditLog': 'src/modules/zero-carbon/workflow/audit/transportFlowchartAuditLog',
  'services/survey/employeeCommutingUncertainty': 'src/modules/zero-carbon/survey/services/employeeCommutingUncertainty',
  'services/survey/surveyEFHelper': 'src/modules/zero-carbon/survey/services/surveyEFHelper',
  'services/survey/surveyEmissionCalculator': 'src/modules/zero-carbon/survey/services/surveyEmissionCalculator',
  'services/survey/surveyTokenService': 'src/modules/zero-carbon/survey/services/surveyTokenService',
  'services/verification/historicalAverageService': 'src/modules/zero-carbon/verification/services/historicalAverageService',
  'services/verification/normalizationService': 'src/modules/zero-carbon/verification/services/normalizationService',
  'services/verification/thresholdVerificationService': 'src/modules/zero-carbon/verification/services/thresholdVerificationService',

  // Utils - Common
  'utils/authenticate': 'src/common/utils/authenticate',
  'utils/encryptionUtil': 'src/common/utils/encryptionUtil',
  'utils/mongooseEncryptionPlugin': 'src/common/utils/mongooseEncryptionPlugin',
  'utils/otpHelper': 'src/common/utils/otpHelper',
  'utils/mail': 'src/common/utils/mail',
  'utils/emailQueue': 'src/common/utils/emailQueue',
  'utils/emailServiceClient': 'src/common/utils/emailServiceClient',
  'utils/multer': 'src/common/utils/multer',
  'utils/pdfService': 'src/common/utils/pdfService',
  'utils/queueUtils': 'src/common/utils/queueUtils',
  'utils/s3Helper': 'src/common/utils/s3Helper',
  'utils/Permissions/modulePermission': 'src/common/utils/Permissions/modulePermission',
  'utils/Permissions/permissions': 'src/common/utils/Permissions/permissions',
  'utils/Permissions/accessControlPermission': 'src/common/utils/Permissions/accessControlPermission',
  'utils/Permissions/logPermission': 'src/common/utils/Permissions/logPermission',
  'utils/sanitizers/userSanitizer': 'src/common/utils/sanitizers/userSanitizer',
  'utils/sockets/ticketChatSocket': 'src/common/utils/sockets/ticketChatSocket',
  'utils/notifications/supportNotifications': 'src/common/utils/notifications/supportNotifications',
  'utils/notifications/ticketChatNotifications': 'src/common/utils/notifications/ticketChatNotifications',
  'utils/notifications/ticketNotifications': 'src/common/utils/notifications/ticketNotifications',
  'utils/uploads/profileKeyBuilder': 'src/common/utils/uploads/profileKeyBuilder',
  'utils/uploads/ticketUploadS3': 'src/common/utils/uploads/ticketUploadS3',
  'utils/uploads/userImageUpload': 'src/common/utils/uploads/userImageUpload',
  'utils/uploads/userImageUploadS3': 'src/common/utils/uploads/userImageUploadS3',
  'utils/uploads/delete/deleteUserProfileImage': 'src/common/utils/uploads/delete/deleteUserProfileImage',
  'utils/uploads/update/replaceUserProfileImage': 'src/common/utils/uploads/update/replaceUserProfileImage',
  'utils/jobs/ticketSlaChecker': 'src/common/utils/jobs/ticketSlaChecker',

  // Utils - Client Management
  'utils/emailHelper': 'src/modules/client-management/utils/emailHelper',
  'utils/notifications/notificationHelper': 'src/modules/client-management/utils/notificationHelper',

  // Utils - ZeroCarbon
  'utils/Permissions/accessPermissionFlowchartandProcessflowchart': 'src/modules/zero-carbon/organization/utils/Permissions/accessPermissionFlowchartandProcessflowchart',
  'utils/Permissions/dataEntryPermission': 'src/modules/zero-carbon/organization/utils/Permissions/dataEntryPermission',
  'utils/Permissions/summaryAccessContext': 'src/modules/zero-carbon/organization/utils/Permissions/summaryAccessContext',
  'utils/Permissions/summaryPermission': 'src/modules/zero-carbon/organization/utils/Permissions/summaryPermission',
  'utils/ProcessEmission/createProcessEmissionDataEntry': 'src/modules/zero-carbon/organization/utils/ProcessEmission/createProcessEmissionDataEntry',
  'utils/allocation/allocationHelpers': 'src/modules/zero-carbon/organization/utils/allocation/allocationHelpers',
  'utils/assessmentLevel': 'src/modules/zero-carbon/workflow/assessmentLevel',
  'utils/dashboardEmitter': 'src/modules/zero-carbon/workflow/dashboardEmitter',
  'utils/gwpHelper': 'src/modules/zero-carbon/workflow/gwpHelper',
  'utils/pdfTemplates': 'src/modules/zero-carbon/workflow/pdfTemplates',
  'utils/chart/chartHelpers': 'src/modules/zero-carbon/workflow/chart/chartHelpers',
  'utils/notifications/formulaNotifications': 'src/modules/zero-carbon/workflow/notifications/formulaNotifications',
  'utils/notifications/reductionNotifications': 'src/modules/zero-carbon/workflow/notifications/reductionNotifications',
  'utils/notifications/thresholdNotifications': 'src/modules/zero-carbon/workflow/notifications/thresholdNotifications',
  'utils/reductionSummaryTrigger': 'src/modules/zero-carbon/reduction/utils/reductionSummaryTrigger',
  'utils/uploads/reductionUpload': 'src/modules/zero-carbon/reduction/utils/reductionUpload',
  'utils/uploads/reductionUploadS3': 'src/modules/zero-carbon/reduction/utils/reductionUploadS3',
  'utils/Workflow/syncReductionProjects': 'src/modules/zero-carbon/reduction/utils/Workflow/syncReductionProjects',
  'utils/Workflow/workflow': 'src/modules/zero-carbon/reduction/utils/Workflow/workflow',
  'utils/uploads/Reduction/csv/_key': 'src/modules/zero-carbon/reduction/utils/uploads/csv/_key',
  'utils/uploads/Reduction/csv/_s3Client': 'src/modules/zero-carbon/reduction/utils/uploads/csv/_s3Client',
  'utils/uploads/Reduction/csv/create': 'src/modules/zero-carbon/reduction/utils/uploads/csv/create',
  'utils/uploads/Reduction/csv/delete': 'src/modules/zero-carbon/reduction/utils/uploads/csv/delete',
  'utils/uploads/Reduction/csv/update': 'src/modules/zero-carbon/reduction/utils/uploads/csv/update',
  'utils/uploads/delete/deleteReductionMedia': 'src/modules/zero-carbon/reduction/utils/uploads/delete/deleteReductionMedia',
  'utils/uploads/update/replaceReductionMedia': 'src/modules/zero-carbon/reduction/utils/uploads/update/replaceReductionMedia',
  'utils/ApiKey/apiKeyEmailService': 'src/modules/zero-carbon/api-key/utils/apiKeyEmailService',
  'utils/ApiKey/apiKeyNotifications': 'src/modules/zero-carbon/api-key/utils/apiKeyNotifications',
  'utils/ApiKey/apiKeyPdfGenerator': 'src/modules/zero-carbon/api-key/utils/apiKeyPdfGenerator',
  'utils/ApiKey/keyGenerator': 'src/modules/zero-carbon/api-key/utils/keyGenerator',
  'utils/Calculation/CalculateUncertainity': 'src/modules/zero-carbon/calculation/utils/CalculateUncertainity',
  'utils/Calculation/recalculateHelpers': 'src/modules/zero-carbon/calculation/utils/recalculateHelpers',
  'utils/DataCollection/dataCollection': 'src/modules/zero-carbon/data-collection/utils/dataCollection',
  'utils/DataCollection/dataFrequencyHelper': 'src/modules/zero-carbon/data-collection/utils/dataFrequencyHelper',
  'utils/OCR/extractTextFromImage': 'src/modules/zero-carbon/ocr/utils/extractTextFromImage',
  'utils/OCR/extractTextFromPDF': 'src/modules/zero-carbon/ocr/utils/extractTextFromPDF',
  'utils/OCR/fieldExtractor': 'src/modules/zero-carbon/ocr/utils/fieldExtractor',
  'utils/OCR/geminiOCR': 'src/modules/zero-carbon/ocr/utils/geminiOCR',
  'utils/OCR/modelMatcher': 'src/modules/zero-carbon/ocr/utils/modelMatcher',
  'utils/OCR/ocrSessionStore': 'src/modules/zero-carbon/ocr/utils/ocrSessionStore',
  'utils/OCR/preprocessImage': 'src/modules/zero-carbon/ocr/utils/preprocessImage',
  'utils/OCR/textractOCR': 'src/modules/zero-carbon/ocr/utils/textractOCR',
  'utils/OCR/universalFieldExtractor': 'src/modules/zero-carbon/ocr/utils/universalFieldExtractor',
  'utils/jobs/apiKeyExpiryChecker': 'src/modules/zero-carbon/workflow/jobs/apiKeyExpiryChecker',
  'utils/jobs/missedCycleDetector': 'src/modules/zero-carbon/workflow/jobs/missedCycleDetector',
  'utils/jobs/summaryMaintenanceJob': 'src/modules/zero-carbon/workflow/jobs/summaryMaintenanceJob',
  'utils/jobs/zeroCarbonExpiryChecker': 'src/modules/zero-carbon/workflow/jobs/zeroCarbonExpiryChecker',
  'utils/jobs/esgLinkExpiryChecker': 'src/modules/zero-carbon/workflow/jobs/esgLinkExpiryChecker',

  // MQTT
  'mqtt/mqttSubscriber': 'src/modules/zero-carbon/iot/mqttSubscriber',

  // Organisation uploads
  'utils/uploads/organisation/csv/create': 'src/modules/zero-carbon/organization/utils/uploads/csv/create',
  'utils/uploads/organisation/csv/delete': 'src/modules/zero-carbon/organization/utils/uploads/csv/delete',
  'utils/uploads/organisation/csv/update': 'src/modules/zero-carbon/organization/utils/uploads/csv/update',
  'utils/uploads/organisation/csv/uploadCsvMulter': 'src/modules/zero-carbon/organization/utils/uploads/csv/uploadCsvMulter',
  'utils/uploads/organisation/csv/uploadCsvToS3': 'src/modules/zero-carbon/organization/utils/uploads/csv/uploadCsvToS3',
  'utils/uploads/organisation/csv/_key': 'src/modules/zero-carbon/organization/utils/uploads/csv/_key',
  'utils/uploads/organisation/csv/_s3Client': 'src/modules/zero-carbon/organization/utils/uploads/csv/_s3Client',
  'utils/uploads/organisation/ocr/upload': 'src/modules/zero-carbon/ocr/utils/uploads/ocr/upload',
};

/**
 * Given a relative require string like '../../models/CMS/Client',
 * strip all leading '../' and './' to get the path suffix,
 * then try progressively removing leading path segments to find a map match.
 */
function findNewPath(requireStr) {
  // Strip leading ./  and ../
  let stripped = requireStr.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '');

  // Direct match first
  if (pathMap[stripped]) return pathMap[stripped];

  // Try removing leading segments (handles cases where relative path still has partial new prefix)
  const parts = stripped.split('/');
  for (let i = 1; i < parts.length; i++) {
    const suffix = parts.slice(i).join('/');
    if (pathMap[suffix]) return pathMap[suffix];
  }
  return null;
}

function rewriteRequire(fileAbsPath, requireStr) {
  if (!requireStr.startsWith('.')) return null;

  const newProjectRelative = findNewPath(requireStr);
  if (!newProjectRelative) return null;

  const fileDir = path.dirname(fileAbsPath);
  const newAbsTarget = path.join(ROOT, newProjectRelative);
  let newRelative = path.relative(fileDir, newAbsTarget).replace(/\\/g, '/');
  if (!newRelative.startsWith('.')) newRelative = './' + newRelative;

  if (newRelative === requireStr) return null;
  return newRelative;
}

function processFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  const newContent = content.replace(/require\((['"])(\.\.?\/[^'"]+)\1\)/g, (match, quote, requireStr) => {
    const newRequire = rewriteRequire(filePath, requireStr);
    if (newRequire && newRequire !== requireStr) {
      changed = true;
      return `require(${quote}${newRequire}${quote})`;
    }
    return match;
  });

  if (changed) {
    fs.writeFileSync(filePath, newContent, 'utf8');
    return true;
  }
  return false;
}

function walkDir(dir) {
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') continue;
      walkDir(fullPath);
    } else if (entry.endsWith('.js')) {
      const changed = processFile(fullPath);
      if (changed) console.log('UPDATED:', path.relative(ROOT, fullPath));
    }
  }
}

console.log('Starting require() path rewrite (v2 - suffix matching)...');
// Fix index.js at root
const rootIndexChanged = processFile(path.join(ROOT, 'index.js'));
if (rootIndexChanged) console.log('UPDATED: index.js');
// Fix all src/ files
walkDir(path.join(ROOT, 'src'));
console.log('Done.');
