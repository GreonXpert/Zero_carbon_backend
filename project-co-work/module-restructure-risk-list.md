# Module Restructure Risk List

## 1. Typo Folder/File Names
- controllers/Decabonization/ → Missing 'r'. Correct name: decarbonization. Corrected during move.
- controllers/EmissionFactor/IpccConverstionCalculation.js → "Converstion" typo. Renamed to IpccConversionCalculation.js.
- router/EmissionFactor/IpccConverstionCalculation.js → Same typo. Renamed simultaneously.

## 2. Misplaced Files
- controllers/Reduction/reductionSummaryCalculationService.js is a SERVICE not a controller.
  Moved to: src/modules/zero-carbon/reduction/services/reductionSummaryCalculationService.js

## 3. Orphan Routes (not registered in index.js)
- router/dataEntryRoutes.js — Commented out in index.js. Moved but kept commented.
- router/emissionRoutes.js — Not imported anywhere. REVIEW: verify before registering.
- router/fuelUsageRoutes.js — Not imported anywhere. REVIEW: verify before registering.

## 4. Duplicate Migration Files
- migrate_module_access.js exists at BOTH root AND migrations/
- Root copy deleted after confirming content is identical to migrations/ copy
- Canonical location: src/migrations/migrate_module_access.js

## 5. Uncertain Ownership
- utils/authenticate.js — Overlap with middleware/auth.js unclear. Moved to src/common/utils/ for now. Mark for manual review.

## 6. New Files (added after inventory was generated)
- utils/jobs/zeroCarbonExpiryChecker.js — Moved to src/modules/zero-carbon/workflow/jobs/
- utils/jobs/esgLinkExpiryChecker.js — Moved to src/modules/zero-carbon/workflow/jobs/ (despite name, no ESGLink module yet)
- utils/migrations/fixZeroCarbonExpiry.js — Moved to src/migrations/

## 7. Route Registration Concerns
- index.js registers 30+ route groups. After all moves, index.js updated to require from new src/ paths.
- registerRoutes.js extracted as bootstrap helper.

## 8. Migration Concerns
- All migrations consolidated to src/migrations/
- Root-level duplicate removed

## 9. Naming Cleanup
- IpccConverstionCalculation → IpccConversionCalculation (in both controller and route file)
- Decabonization folder → decarbonization (corrected in target path)
