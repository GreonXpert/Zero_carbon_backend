# Module Restructure Map

| # | Current Path | Current Layer | Final Module | Final Target Path | Action | Reason | Risk |
|---|---|---|---|---|---|---|---|
| 1 | index.js | Common/Shared | Common/Shared | index.js | KEEP | App entry point | Low |
| 2 | config/db.js | Common/Shared | Common/Shared | src/common/config/db.js | MOVE | Shared DB config | Low |
| 3 | middleware/auth.js | Common/Shared | Common/Shared | src/common/middleware/auth.js | MOVE | Shared auth middleware | Low |
| 4 | middleware/apiKeyAuth.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/api-key/middleware/apiKeyAuth.js | MOVE | ZC-specific API key auth | Low |
| 5 | middleware/sandboxAuth.js | Client Management | Client Management | src/modules/client-management/sandbox/sandboxAuth.js | MOVE | Sandbox-specific middleware | Low |
| 6 | middleware/compression.js | Common/Shared | Common/Shared | src/common/middleware/compression.js | MOVE | Shared middleware | Low |
| 7 | middleware/errorHandler.js | Common/Shared | Common/Shared | src/common/middleware/errorHandler.js | MOVE | Shared middleware | Low |
| 8 | middleware/rateLimit.js | Common/Shared | Common/Shared | src/common/middleware/rateLimit.js | MOVE | Shared middleware | Low |
| 9 | middleware/validation.js | Common/Shared | Common/Shared | src/common/middleware/validation.js | MOVE | Shared middleware | Low |
| 10 | models/User.js | Common/Shared | Common/Shared | src/common/models/User.js | MOVE | Shared user model | Low |
| 11 | models/UserSession.js | Common/Shared | Common/Shared | src/common/models/UserSession.js | MOVE | Shared session model | Low |
| 12 | models/CMS/Client.js | Client Management | Client Management | src/modules/client-management/client/Client.js | MOVE | CMS client model | Low |
| 13 | models/CMS/ClientSandbox.js | Client Management | Client Management | src/modules/client-management/sandbox/ClientSandbox.js | MOVE | Sandbox model | Low |
| 14 | models/Quota/ConsultantClientQuota.js | Client Management | Client Management | src/modules/client-management/quota/ConsultantClientQuota.js | MOVE | Quota model | Low |
| 15 | models/CCTS/CCTSEntity.js | Client Management | Client Management | src/modules/client-management/ccts/CCTSEntity.js | MOVE | CCTS entity model | Low |
| 16 | models/AuditLog/AuditLog.js | Common/Shared | Common/Shared | src/common/models/AuditLog/AuditLog.js | MOVE | Shared audit model | Low |
| 17 | models/Notification/Notification.js | Common/Shared | Common/Shared | src/common/models/Notification/Notification.js | MOVE | Shared notification model | Low |
| 18 | models/Ticket/Ticket.js | Common/Shared | Common/Shared | src/common/models/Ticket/Ticket.js | MOVE | Support ticket model | Low |
| 19 | models/Ticket/TicketActivity.js | Common/Shared | Common/Shared | src/common/models/Ticket/TicketActivity.js | MOVE | Ticket activity model | Low |
| 20 | models/Ticket/TicketChat.js | Common/Shared | Common/Shared | src/common/models/Ticket/TicketChat.js | MOVE | Ticket chat model | Low |
| 21 | models/ApiKey.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/api-key/ApiKey.js | MOVE | ZC API key model | Low |
| 22 | models/ApiKeyRequest.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/api-key/ApiKeyRequest.js | MOVE | API key request model | Low |
| 23 | models/IOTData.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/iot/IOTData.js | MOVE | IoT data model | Low |
| 24 | models/CalculationEmission/EmissionSummary.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/calculation/EmissionSummary.js | MOVE | Calculation model | Low |
| 25 | models/Decarbonization/SbtiTarget.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/decarbonization/SbtiTarget.js | MOVE | SBTI target model | Low |
| 26 | models/EmissionFactor/DefraData.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/models/DefraData.js | MOVE | EF model | Low |
| 27 | models/EmissionFactor/EPAData.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/models/EPAData.js | MOVE | EF model | Low |
| 28 | models/EmissionFactor/EmissionFactorHub.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/models/EmissionFactorHub.js | MOVE | EF model | Low |
| 29 | models/EmissionFactor/FuelCombustion.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/models/FuelCombustion.js | MOVE | EF model | Low |
| 30 | models/EmissionFactor/GWP.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/models/GWP.js | MOVE | EF model | Low |
| 31 | models/EmissionFactor/IPCCData.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/models/IPCCData.js | MOVE | EF model | Low |
| 32 | models/EmissionFactor/countryEmissionFactorModel.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/models/countryEmissionFactorModel.js | MOVE | EF model | Low |
| 33 | models/Organization/AnonymousCode.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/models/AnonymousCode.js | MOVE | Org model | Low |
| 34 | models/Organization/DataCollectionConfig.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/models/DataCollectionConfig.js | MOVE | Org model | Low |
| 35 | models/Organization/DataEntry.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/models/DataEntry.js | MOVE | Data entry model | Low |
| 36 | models/Organization/Flowchart.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/models/Flowchart.js | MOVE | Org model | Low |
| 37 | models/Organization/OCRFeedback.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/models/OCRFeedback.js | MOVE | OCR feedback model | Low |
| 38 | models/Organization/ProcessEmissionDataEntry.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/models/ProcessEmissionDataEntry.js | MOVE | Process emission model | Low |
| 39 | models/Organization/ProcessFlowchart.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/models/ProcessFlowchart.js | MOVE | Process flow model | Low |
| 40 | models/Organization/SurveyCycle.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/models/SurveyCycle.js | MOVE | Survey model | Low |
| 41 | models/Organization/SurveyLink.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/models/SurveyLink.js | MOVE | Survey model | Low |
| 42 | models/Organization/SurveyResponse.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/models/SurveyResponse.js | MOVE | Survey model | Low |
| 43 | models/Organization/TransportFlowchart.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/models/TransportFlowchart.js | MOVE | Transport model | Low |
| 44 | models/PendingApproval/PendingApproval.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/verification/PendingApproval.js | MOVE | Approval workflow model | Low |
| 45 | models/Reduction/DeleteRequest.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/models/DeleteRequest.js | MOVE | Reduction model | Low |
| 46 | models/Reduction/Formula.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/models/Formula.js | MOVE | Reduction model | Low |
| 47 | models/Reduction/NetReductionEntry.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/models/NetReductionEntry.js | MOVE | Reduction model | Low |
| 48 | models/Reduction/Reduction.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/models/Reduction.js | MOVE | Reduction model | Low |
| 49 | models/Reduction/SummaryNetReduction.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/models/SummaryNetReduction.js | MOVE | Reduction model | Low |
| 50 | models/ThresholdConfig/ThresholdConfig.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/verification/ThresholdConfig.js | MOVE | Threshold config model | Low |
| 51 | controllers/userController.js | Common/Shared | Common/Shared | src/common/controllers/user/userController.js | MOVE | User management | Low |
| 52 | controllers/CMS/clientController.js | Client Management | Client Management | src/modules/client-management/client/clientController.js | MOVE | CMS client controller | Low |
| 53 | controllers/CMS/quotaController.js | Client Management | Client Management | src/modules/client-management/quota/quotaController.js | MOVE | Quota controller | Low |
| 54 | controllers/CMS/sandboxController.js | Client Management | Client Management | src/modules/client-management/sandbox/sandboxController.js | MOVE | Sandbox controller | Low |
| 55 | controllers/CCTS/CCTSController.js | Client Management | Client Management | src/modules/client-management/ccts/CCTSController.js | MOVE | CCTS controller | Low |
| 56 | controllers/AuditLog/auditLogController.js | Common/Shared | Common/Shared | src/common/controllers/audit-log/auditLogController.js | MOVE | Shared audit controller | Low |
| 57 | controllers/Notification/notificationControllers.js | Common/Shared | Common/Shared | src/common/controllers/notification/notificationControllers.js | MOVE | Notification controller | Low |
| 58 | controllers/Ticket/ticketController.js | Common/Shared | Common/Shared | src/common/controllers/ticket/ticketController.js | MOVE | Ticket controller | Low |
| 59 | controllers/Ticket/ticketChatController.js | Common/Shared | Common/Shared | src/common/controllers/ticket/ticketChatController.js | MOVE | Ticket chat controller | Low |
| 60 | controllers/Calculation/CalculationSummary.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/calculation/CalculationSummary.js | MOVE | Calculation controller | Low |
| 61 | controllers/Calculation/emissionCalculationController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/calculation/emissionCalculationController.js | MOVE | Emission calc controller | Low |
| 62 | controllers/Calculation/emissionIntegration.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/calculation/emissionIntegration.js | MOVE | Emission integration | Low |
| 63 | controllers/DataCollection/APIandIot.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/data-collection/controllers/APIandIot.js | MOVE | Data collection controller | Low |
| 64 | controllers/DataCollection/dataCompletionController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/data-collection/controllers/dataCompletionController.js | MOVE | Data completion controller | Low |
| 65 | controllers/DataCollection/monthlyDataSummaryController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/data-collection/controllers/monthlyDataSummaryController.js | MOVE | Monthly summary controller | Low |
| 66 | controllers/Decabonization/sbtiController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/decarbonization/sbtiController.js | MOVE+RENAME FOLDER | Typo: Decabonization→decarbonization | Medium |
| 67 | controllers/EmissionFactor/DefraDataController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/controllers/DefraDataController.js | MOVE | EF controller | Low |
| 68 | controllers/EmissionFactor/EPADataController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/controllers/EPADataController.js | MOVE | EF controller | Low |
| 69 | controllers/EmissionFactor/EmissionFactorHubController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/controllers/EmissionFactorHubController.js | MOVE | EF controller | Low |
| 70 | controllers/EmissionFactor/IpccConverstionCalculation.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/controllers/IpccConversionCalculation.js | MOVE+RENAME | Typo: Converstion→Conversion | Medium |
| 71 | controllers/EmissionFactor/countryEmissionFactorController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/controllers/countryEmissionFactorController.js | MOVE | EF controller | Low |
| 72 | controllers/EmissionFactor/emissionFactorController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/controllers/emissionFactorController.js | MOVE | EF controller | Low |
| 73 | controllers/EmissionFactor/fuelCombustionController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/controllers/fuelCombustionController.js | MOVE | EF controller | Low |
| 74 | controllers/EmissionFactor/gwpController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/controllers/gwpController.js | MOVE | EF controller | Low |
| 75 | controllers/EmissionFactor/ipccDataController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/controllers/ipccDataController.js | MOVE | EF controller | Low |
| 76 | controllers/Organization/DataCleanUp.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/controllers/DataCleanUp.js | MOVE | Org controller | Low |
| 77 | controllers/Organization/dataCollectionController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/controllers/dataCollectionController.js | MOVE | Org data collection | Low |
| 78 | controllers/Organization/dataEntryController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/controllers/dataEntryController.js | MOVE | Data entry — check paths | Medium |
| 79 | controllers/Organization/flowchartController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/controllers/flowchartController.js | MOVE | Org flowchart | Low |
| 80 | controllers/Organization/ocrDataCollectionController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/controllers/ocrDataCollectionController.js | MOVE | OCR data entry | Low |
| 81 | controllers/Organization/ocrFeedbackController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/controllers/ocrFeedbackController.js | MOVE | OCR feedback | Low |
| 82 | controllers/Organization/processflowController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/controllers/processflowController.js | MOVE | Process flow | Low |
| 83 | controllers/Organization/surveyController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/controllers/surveyController.js | MOVE | Survey controller | Low |
| 84 | controllers/Organization/transportFlowController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/controllers/transportFlowController.js | MOVE | Transport flow | Low |
| 85 | controllers/Reduction/FormulaController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/controllers/FormulaController.js | MOVE | Formula controller | Low |
| 86 | controllers/Reduction/netReductionController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/controllers/netReductionController.js | MOVE | Net reduction | Low |
| 87 | controllers/Reduction/netReductionSummaryController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/controllers/netReductionSummaryController.js | MOVE | Net reduction summary | Low |
| 88 | controllers/Reduction/reductionController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/controllers/reductionController.js | MOVE | Reduction controller | Low |
| 89 | controllers/Reduction/reductionSummaryCalculationService.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/services/reductionSummaryCalculationService.js | MOVE | Misplaced service in controllers | Medium |
| 90 | controllers/apiKeyController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/api-key/apiKeyController.js | MOVE | API key controller | Low |
| 91 | controllers/iotController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/iot/iotController.js | MOVE | IoT controller | Low |
| 92 | controllers/verification/thresholdVerificationController.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/verification/thresholdVerificationController.js | MOVE | Threshold verification | Low |
| 93 | router/userR.js | Common/Shared | Common/Shared | src/common/routes/userR.js | MOVE | User routes | Low |
| 94 | router/CMS/clientR.js | Client Management | Client Management | src/modules/client-management/client/clientR.js | MOVE | Client routes | Low |
| 95 | router/CMS/quotaRoutes.js | Client Management | Client Management | src/modules/client-management/quota/quotaRoutes.js | MOVE | Quota routes | Low |
| 96 | router/CMS/sandboxRoutes.js | Client Management | Client Management | src/modules/client-management/sandbox/sandboxRoutes.js | MOVE | Sandbox routes | Low |
| 97 | router/CCTS/cctsRoutes.js | Client Management | Client Management | src/modules/client-management/ccts/cctsRoutes.js | MOVE | CCTS routes | Low |
| 98 | router/AuditLog/auditLogRoutes.js | Common/Shared | Common/Shared | src/common/routes/AuditLog/auditLogRoutes.js | MOVE | Audit log routes | Low |
| 99 | router/Notification/notificationRoutes.js | Common/Shared | Common/Shared | src/common/routes/Notification/notificationRoutes.js | MOVE | Notification routes | Low |
| 100 | router/Ticket/ticketRoutes.js | Common/Shared | Common/Shared | src/common/routes/Ticket/ticketRoutes.js | MOVE | Ticket routes | Low |
| 101 | router/Decarbonization/sbtiRoutes.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/decarbonization/sbtiRoutes.js | MOVE | SBTI routes | Low |
| 102 | router/EmissionFactor/EPADataRoutes.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/routes/EPADataRoutes.js | MOVE | EF routes | Low |
| 103 | router/EmissionFactor/EmissionFactorHubRoutes.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/routes/EmissionFactorHubRoutes.js | MOVE | EF routes | Low |
| 104 | router/EmissionFactor/IpccConverstionCalculation.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/routes/IpccConversionCalculation.js | MOVE+RENAME | Typo fix | Medium |
| 105 | router/EmissionFactor/countryemissionFactorRouter.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/routes/countryemissionFactorRouter.js | MOVE | EF routes | Low |
| 106 | router/EmissionFactor/defraData.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/routes/defraData.js | MOVE | EF routes | Low |
| 107 | router/EmissionFactor/emissionFactorRoutes.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/routes/emissionFactorRoutes.js | MOVE | EF routes | Low |
| 108 | router/EmissionFactor/fuelCombustionRoutes.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/routes/fuelCombustionRoutes.js | MOVE | EF routes | Low |
| 109 | router/EmissionFactor/gwpRoutes.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/routes/gwpRoutes.js | MOVE | EF routes | Low |
| 110 | router/EmissionFactor/ipccDataRoutes.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/routes/ipccDataRoutes.js | MOVE | EF routes | Low |
| 111 | router/Organization/dataCollectionRoutes.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/data-collection/routes/dataCollectionRoutes.js | MOVE | Data collection routes | Low |
| 112 | router/Organization/flowchartR.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/routes/flowchartR.js | MOVE | Flowchart routes | Low |
| 113 | router/Organization/processflowR.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/routes/processflowR.js | MOVE | Process flow routes | Low |
| 114 | router/Organization/summaryRoutes.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/calculation/routes/summaryRoutes.js | MOVE | Summary routes | Low |
| 115 | router/Organization/surveyRoutes.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/routes/surveyRoutes.js | MOVE | Survey routes | Low |
| 116 | router/Organization/transportFlowR.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/routes/transportFlowR.js | MOVE | Transport routes | Low |
| 117 | router/Reduction/FormulaR.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/routes/FormulaR.js | MOVE | Formula routes | Low |
| 118 | router/Reduction/netReductionR.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/routes/netReductionR.js | MOVE | Net reduction routes | Low |
| 119 | router/Reduction/netReductionSummaryR.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/routes/netReductionSummaryR.js | MOVE | Net reduction summary routes | Low |
| 120 | router/Reduction/reductionR.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/routes/reductionR.js | MOVE | Reduction routes | Low |
| 121 | router/apiKeyRoutes.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/api-key/apiKeyRoutes.js | MOVE | API key routes | Low |
| 122 | router/iotRoutes.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/iot/iotRoutes.js | MOVE | IoT routes | Low |
| 123 | router/verification/verificationRoutes.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/verification/verificationRoutes.js | MOVE | Verification routes | Low |
| 124 | router/dataEntryRoutes.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/routes/dataEntryRoutes.js | MOVE | Commented-out legacy route | Medium |
| 125 | router/emissionRoutes.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/calculation/routes/emissionRoutes.js | MOVE | Not in index.js — review | High |
| 126 | router/fuelUsageRoutes.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/routes/fuelUsageRoutes.js | MOVE | Not in index.js — review | High |
| 127 | services/apiKeyLinker.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/api-key/apiKeyLinker.js | MOVE | API key service | Low |
| 128 | services/emissionFactorSearch.service.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/emission-factor/services/emissionFactorSearch.service.js | MOVE | EF search service | Low |
| 129 | services/audit/auditLogService.js | Common/Shared | Common/Shared | src/common/services/audit/auditLogService.js | MOVE | Shared audit service | Low |
| 130 | services/audit/dataEntryAuditLog.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/workflow/audit/dataEntryAuditLog.js | MOVE | ZC audit service | Low |
| 131 | services/audit/flowchartAuditLog.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/workflow/audit/flowchartAuditLog.js | MOVE | ZC audit service | Low |
| 132 | services/audit/netReductionAuditLog.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/workflow/audit/netReductionAuditLog.js | MOVE | ZC audit service | Low |
| 133 | services/audit/processFlowchartAuditLog.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/workflow/audit/processFlowchartAuditLog.js | MOVE | ZC audit service | Low |
| 134 | services/audit/reductionAuditLog.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/workflow/audit/reductionAuditLog.js | MOVE | ZC audit service | Low |
| 135 | services/audit/sbtiAuditLog.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/decarbonization/services/sbtiAuditLog.js | MOVE | SBTI audit service | Low |
| 136 | services/audit/transportFlowchartAuditLog.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/workflow/audit/transportFlowchartAuditLog.js | MOVE | ZC audit service | Low |
| 137 | services/quota/quotaService.js | Client Management | Client Management | src/modules/client-management/quota/quotaService.js | MOVE | Quota service | Low |
| 138 | services/survey/employeeCommutingUncertainty.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/survey/services/employeeCommutingUncertainty.js | MOVE | Survey service | Low |
| 139 | services/survey/surveyEFHelper.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/survey/services/surveyEFHelper.js | MOVE | Survey EF helper | Low |
| 140 | services/survey/surveyEmissionCalculator.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/survey/services/surveyEmissionCalculator.js | MOVE | Survey calc | Low |
| 141 | services/survey/surveyTokenService.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/survey/services/surveyTokenService.js | MOVE | Survey token service | Low |
| 142 | services/verification/historicalAverageService.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/verification/services/historicalAverageService.js | MOVE | Verification service | Low |
| 143 | services/verification/normalizationService.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/verification/services/normalizationService.js | MOVE | Verification service | Low |
| 144 | services/verification/thresholdVerificationService.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/verification/services/thresholdVerificationService.js | MOVE | Threshold service | Low |
| 145 | mqtt/mqttSubscriber.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/iot/mqttSubscriber.js | MOVE | MQTT IoT subscriber | Low |
| 146 | utils/Permissions/modulePermission.js | Common/Shared | Common/Shared | src/common/utils/Permissions/modulePermission.js | MOVE | Module subscription gate | Low |
| 147 | utils/Permissions/permissions.js | Common/Shared | Common/Shared | src/common/utils/Permissions/permissions.js | MOVE | Shared permissions | Low |
| 148 | utils/Permissions/accessControlPermission.js | Common/Shared | Common/Shared | src/common/utils/Permissions/accessControlPermission.js | MOVE | Access control | Low |
| 149 | utils/Permissions/logPermission.js | Common/Shared | Common/Shared | src/common/utils/Permissions/logPermission.js | MOVE | Log permission | Low |
| 150 | utils/Permissions/accessPermissionFlowchartandProcessflowchart.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/utils/Permissions/accessPermissionFlowchartandProcessflowchart.js | MOVE | ZC-specific permission | Low |
| 151 | utils/Permissions/dataEntryPermission.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/utils/Permissions/dataEntryPermission.js | MOVE | Data entry permission | Low |
| 152 | utils/Permissions/summaryAccessContext.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/utils/Permissions/summaryAccessContext.js | MOVE | Summary access context | Low |
| 153 | utils/Permissions/summaryPermission.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/utils/Permissions/summaryPermission.js | MOVE | Summary permission | Low |
| 154 | utils/mail.js | Common/Shared | Common/Shared | src/common/utils/mail.js | MOVE | Shared mail sender | Low |
| 155 | utils/emailQueue.js | Common/Shared | Common/Shared | src/common/utils/emailQueue.js | MOVE | Email queue | Low |
| 156 | utils/emailServiceClient.js | Common/Shared | Common/Shared | src/common/utils/emailServiceClient.js | MOVE | Email service client | Low |
| 157 | utils/emailHelper.js | Client Management | Client Management | src/modules/client-management/utils/emailHelper.js | MOVE | CMS email helper | Low |
| 158 | utils/encryptionUtil.js | Common/Shared | Common/Shared | src/common/utils/encryptionUtil.js | MOVE | Encryption utilities | Low |
| 159 | utils/mongooseEncryptionPlugin.js | Common/Shared | Common/Shared | src/common/utils/mongooseEncryptionPlugin.js | MOVE | Mongoose encryption | Low |
| 160 | utils/otpHelper.js | Common/Shared | Common/Shared | src/common/utils/otpHelper.js | MOVE | OTP generation | Low |
| 161 | utils/multer.js | Common/Shared | Common/Shared | src/common/utils/multer.js | MOVE | File upload config | Low |
| 162 | utils/pdfService.js | Common/Shared | Common/Shared | src/common/utils/pdfService.js | MOVE | PDF generation | Low |
| 163 | utils/pdfTemplates.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/workflow/pdfTemplates.js | MOVE | ZC report templates | Low |
| 164 | utils/queueUtils.js | Common/Shared | Common/Shared | src/common/utils/queueUtils.js | MOVE | Queue utilities | Low |
| 165 | utils/s3Helper.js | Common/Shared | Common/Shared | src/common/utils/s3Helper.js | MOVE | AWS S3 helper | Low |
| 166 | utils/sanitizers/userSanitizer.js | Common/Shared | Common/Shared | src/common/utils/sanitizers/userSanitizer.js | MOVE | User data sanitizer | Low |
| 167 | utils/sockets/ticketChatSocket.js | Common/Shared | Common/Shared | src/common/utils/sockets/ticketChatSocket.js | MOVE | Ticket chat socket | Low |
| 168 | utils/authenticate.js | Unknown | Common/Shared | src/common/utils/authenticate.js | MOVE | Auth helper — review overlap | High |
| 169 | utils/assessmentLevel.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/workflow/assessmentLevel.js | MOVE | Assessment level calc | Low |
| 170 | utils/dashboardEmitter.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/workflow/dashboardEmitter.js | MOVE | Dashboard real-time emitter | Low |
| 171 | utils/gwpHelper.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/workflow/gwpHelper.js | MOVE | GWP calculation helper | Low |
| 172 | utils/reductionSummaryTrigger.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/utils/reductionSummaryTrigger.js | MOVE | Reduction trigger | Low |
| 173 | utils/ApiKey/apiKeyEmailService.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/api-key/utils/apiKeyEmailService.js | MOVE | API key email | Low |
| 174 | utils/ApiKey/apiKeyNotifications.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/api-key/utils/apiKeyNotifications.js | MOVE | API key notifications | Low |
| 175 | utils/ApiKey/apiKeyPdfGenerator.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/api-key/utils/apiKeyPdfGenerator.js | MOVE | API key PDF | Low |
| 176 | utils/ApiKey/keyGenerator.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/api-key/utils/keyGenerator.js | MOVE | Key generation | Low |
| 177 | utils/Calculation/CalculateUncertainity.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/calculation/utils/CalculateUncertainity.js | MOVE | Uncertainty calculation | Low |
| 178 | utils/Calculation/recalculateHelpers.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/calculation/utils/recalculateHelpers.js | MOVE | Recalculation helpers | Low |
| 179 | utils/DataCollection/dataCollection.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/data-collection/utils/dataCollection.js | MOVE | Data collection util | Low |
| 180 | utils/DataCollection/dataFrequencyHelper.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/data-collection/utils/dataFrequencyHelper.js | MOVE | Frequency helper | Low |
| 181 | utils/OCR/extractTextFromImage.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/ocr/utils/extractTextFromImage.js | MOVE | OCR utility | Low |
| 182 | utils/OCR/extractTextFromPDF.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/ocr/utils/extractTextFromPDF.js | MOVE | OCR utility | Low |
| 183 | utils/OCR/fieldExtractor.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/ocr/utils/fieldExtractor.js | MOVE | OCR field extraction | Low |
| 184 | utils/OCR/geminiOCR.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/ocr/utils/geminiOCR.js | MOVE | Gemini OCR | Low |
| 185 | utils/OCR/modelMatcher.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/ocr/utils/modelMatcher.js | MOVE | OCR model matcher | Low |
| 186 | utils/OCR/ocrSessionStore.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/ocr/utils/ocrSessionStore.js | MOVE | OCR session store | Low |
| 187 | utils/OCR/preprocessImage.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/ocr/utils/preprocessImage.js | MOVE | Image preprocessing | Low |
| 188 | utils/OCR/textractOCR.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/ocr/utils/textractOCR.js | MOVE | AWS Textract OCR | Low |
| 189 | utils/OCR/universalFieldExtractor.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/ocr/utils/universalFieldExtractor.js | MOVE | Universal field extractor | Low |
| 190 | utils/ProcessEmission/createProcessEmissionDataEntry.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/utils/ProcessEmission/createProcessEmissionDataEntry.js | MOVE | Process emission util | Low |
| 191 | utils/Workflow/syncReductionProjects.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/utils/Workflow/syncReductionProjects.js | MOVE | Reduction workflow sync | Low |
| 192 | utils/Workflow/workflow.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/utils/Workflow/workflow.js | MOVE | Workflow logic | Low |
| 193 | utils/allocation/allocationHelpers.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/utils/allocation/allocationHelpers.js | MOVE | Allocation helpers | Low |
| 194 | utils/chart/chartHelpers.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/workflow/chart/chartHelpers.js | MOVE | Chart helpers | Low |
| 195 | utils/jobs/apiKeyExpiryChecker.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/workflow/jobs/apiKeyExpiryChecker.js | MOVE | API key expiry job | Low |
| 196 | utils/jobs/missedCycleDetector.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/workflow/jobs/missedCycleDetector.js | MOVE | Missed cycle job | Low |
| 197 | utils/jobs/summaryMaintenanceJob.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/workflow/jobs/summaryMaintenanceJob.js | MOVE | Summary maintenance job | Low |
| 198 | utils/jobs/ticketSlaChecker.js | Common/Shared | Common/Shared | src/common/utils/jobs/ticketSlaChecker.js | MOVE | Shared SLA checker job | Low |
| 199 | utils/jobs/zeroCarbonExpiryChecker.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/workflow/jobs/zeroCarbonExpiryChecker.js | MOVE | ZC expiry checker (new file) | Low |
| 200 | utils/jobs/esgLinkExpiryChecker.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/workflow/jobs/esgLinkExpiryChecker.js | MOVE | ESGLink expiry checker (new file) | Low |
| 201 | utils/notifications/formulaNotifications.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/workflow/notifications/formulaNotifications.js | MOVE | Formula notifications | Low |
| 202 | utils/notifications/notificationHelper.js | Client Management | Client Management | src/modules/client-management/utils/notificationHelper.js | MOVE | CMS notification helper | Low |
| 203 | utils/notifications/reductionNotifications.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/workflow/notifications/reductionNotifications.js | MOVE | Reduction notifications | Low |
| 204 | utils/notifications/supportNotifications.js | Common/Shared | Common/Shared | src/common/utils/notifications/supportNotifications.js | MOVE | Support notifications | Low |
| 205 | utils/notifications/thresholdNotifications.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/workflow/notifications/thresholdNotifications.js | MOVE | Threshold notifications | Low |
| 206 | utils/notifications/ticketChatNotifications.js | Common/Shared | Common/Shared | src/common/utils/notifications/ticketChatNotifications.js | MOVE | Ticket chat notifications | Low |
| 207 | utils/notifications/ticketNotifications.js | Common/Shared | Common/Shared | src/common/utils/notifications/ticketNotifications.js | MOVE | Ticket notifications | Low |
| 208 | utils/uploads/profileKeyBuilder.js | Common/Shared | Common/Shared | src/common/utils/uploads/profileKeyBuilder.js | MOVE | Profile key builder | Low |
| 209 | utils/uploads/reductionUpload.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/utils/reductionUpload.js | MOVE | Reduction upload | Low |
| 210 | utils/uploads/reductionUploadS3.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/utils/reductionUploadS3.js | MOVE | Reduction S3 upload | Low |
| 211 | utils/uploads/ticketUploadS3.js | Common/Shared | Common/Shared | src/common/utils/uploads/ticketUploadS3.js | MOVE | Ticket upload | Low |
| 212 | utils/uploads/userImageUpload.js | Common/Shared | Common/Shared | src/common/utils/uploads/userImageUpload.js | MOVE | User image upload | Low |
| 213 | utils/uploads/userImageUploadS3.js | Common/Shared | Common/Shared | src/common/utils/uploads/userImageUploadS3.js | MOVE | User image S3 upload | Low |
| 214 | utils/uploads/Reduction/csv/_key.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/utils/uploads/csv/_key.js | MOVE | Reduction CSV key | Low |
| 215 | utils/uploads/Reduction/csv/_s3Client.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/utils/uploads/csv/_s3Client.js | MOVE | Reduction CSV S3 client | Low |
| 216 | utils/uploads/Reduction/csv/create.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/utils/uploads/csv/create.js | MOVE | Reduction CSV create | Low |
| 217 | utils/uploads/Reduction/csv/delete.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/utils/uploads/csv/delete.js | MOVE | Reduction CSV delete | Low |
| 218 | utils/uploads/Reduction/csv/update.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/utils/uploads/csv/update.js | MOVE | Reduction CSV update | Low |
| 219 | utils/uploads/delete/deleteReductionMedia.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/utils/uploads/delete/deleteReductionMedia.js | MOVE | Reduction media delete | Low |
| 220 | utils/uploads/delete/deleteUserProfileImage.js | Common/Shared | Common/Shared | src/common/utils/uploads/delete/deleteUserProfileImage.js | MOVE | Profile image delete | Low |
| 221 | utils/uploads/update/replaceReductionMedia.js | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/reduction/utils/uploads/update/replaceReductionMedia.js | MOVE | Reduction media replace | Low |
| 222 | utils/uploads/update/replaceUserProfileImage.js | Common/Shared | Common/Shared | src/common/utils/uploads/update/replaceUserProfileImage.js | MOVE | Profile image replace | Low |
| 223 | utils/uploads/organisation/csv/ | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/organization/utils/uploads/csv/ | MOVE | Org CSV uploads | Low |
| 224 | utils/uploads/organisation/ocr/ | ZeroCarbon | ZeroCarbon | src/modules/zero-carbon/ocr/utils/uploads/ocr/ | MOVE | OCR uploads | Low |
| 225 | utils/migrations/fixZeroCarbonExpiry.js | ZeroCarbon | Migrations | src/migrations/fixZeroCarbonExpiry.js | MOVE | Migration script | Low |
| 226 | CCTS/app.js | Client Management | Client Management | CCTS/app.js | KEEP | Frontend mini-app at root | Low |
| 227 | CCTS/index.html | Client Management | Client Management | CCTS/index.html | KEEP | Frontend at root | Low |
| 228 | CCTS/style.css | Client Management | Client Management | CCTS/style.css | KEEP | Frontend at root | Low |
| 229 | CCTS/timeline.html | Client Management | Client Management | CCTS/timeline.html | KEEP | Frontend at root | Low |
| 230 | OCR-test/ocr-tester.html | ZeroCarbon | ZeroCarbon | OCR-test/ocr-tester.html | KEEP | Test harness at root | Low |
| 231 | OCR-test/ocr-tester.css | ZeroCarbon | ZeroCarbon | OCR-test/ocr-tester.css | KEEP | Test harness at root | Low |
| 232 | OCR-test/ocr-tester.js | ZeroCarbon | ZeroCarbon | OCR-test/ocr-tester.js | KEEP | Test harness at root | Low |
| 233 | migrate_conservativeMode.js | ZeroCarbon | Migrations | src/migrations/migrate_conservativeMode.js | MOVE | Migration script at root | Low |
| 234 | migrate_module_access.js (root) | Common/Shared | Migrations | DELETE (duplicate of migrations/) | DELETE | Duplicate of migrations/migrate_module_access.js | Medium |
| 235 | migrations/migrate_module_access.js | Common/Shared | Migrations | src/migrations/migrate_module_access.js | MOVE | Canonical copy | Low |
| 236 | db.clients.js | Client Management | Client Management | db.clients.js | KEEP | One-off script, keep at root | Low |
| 237 | flowchart.json (root) | Unknown | Tests | src/tests/flowchart.json | MOVE | Likely test/seed data | Medium |
| 238 | eng.traineddata | ZeroCarbon | ZeroCarbon | eng.traineddata | KEEP | OCR binary — keep at root | Low |
| 239 | test/flowchart.json | ZeroCarbon | Tests | src/tests/flowchart.json | MOVE | Test data | Low |
| 240 | test/oldCalculationSummary.js | ZeroCarbon | Tests | src/tests/oldCalculationSummary.js | MOVE | Legacy test | Low |
| 241 | test/oldDatCollection.js | ZeroCarbon | Tests | src/tests/oldDatCollection.js | MOVE | Legacy test | Low |
| 242 | test/testIoTSystem.js | ZeroCarbon | Tests | src/tests/testIoTSystem.js | MOVE | IoT test | Low |
