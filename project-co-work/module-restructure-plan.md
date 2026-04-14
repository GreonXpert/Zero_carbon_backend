# Module Restructure Plan — ZeroCarbon Backend

## Executive Summary
Restructured from layer-first to module-first architecture.
Four classification buckets: Common/Shared, Client Management, ZeroCarbon, ESGLink (scaffold).

## Proposed Final Structure
src/
  app/bootstrap/  (registerRoutes.js, registerJobs.js, registerSockets.js)
  common/         (config, middleware, controllers, models, routes, services, utils)
  modules/
    client-management/  (client, quota, sandbox, ccts)
    zero-carbon/        (api-key, iot, emission-factor, calculation, data-collection, organization, survey, verification, reduction, decarbonization, ocr, workflow)
    esg-link/           (scaffold only)
  migrations/
  tests/

## Risk Items
1. controllers/Decabonization/ — typo folder (missing 'r') — corrected during move
2. IpccConverstionCalculation.js — typo "Converstion" — corrected to IpccConversionCalculation.js
3. reductionSummaryCalculationService.js in controllers/ — moved to reduction/services/
4. Duplicate migrate_module_access.js at root and migrations/ — consolidated to src/migrations/
5. dataEntryRoutes.js — commented-out route — preserved as-is
6. emissionRoutes.js / fuelUsageRoutes.js — not registered in index.js — REVIEW MANUALLY
7. utils/authenticate.js — overlap with middleware/auth.js — REVIEW MANUALLY
8. esgLinkExpiryChecker.js / zeroCarbonExpiryChecker.js — new files added post-inventory

## Approval Checklist
- [x] ESGLink treated as scaffold only
- [x] No business logic rewritten
- [x] All require() paths updated after moves
- [x] Typo folders/files corrected
