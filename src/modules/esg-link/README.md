# ESGLink Module — Scaffold

This folder is a scaffold for the ESGLink module, which is currently in expansion stage.

## Status
No business logic files have been moved here yet. ESGLink is not yet a standalone operational module.

## Shared Infrastructure Already Supporting ESGLink

The following shared files already contain ESGLink scaffolding:

| File | What it supports |
|------|-----------------|
| src/common/models/User.js | ESGLink user types: contributor, reviewer, approver |
| src/modules/client-management/client/Client.js | accessibleModules field with 'esg_link' value |
| src/modules/client-management/quota/ConsultantClientQuota.js | quota keys for ESGLink user types |
| src/common/utils/Permissions/modulePermission.js | MODULE_NAMES.ESG_LINK = 'esg_link' |
| src/modules/client-management/quota/quotaService.js | ESGLink user type quota enforcement |
| src/common/middleware/auth.js | isModuleSubscriptionActive checks for ESGLink |
| src/migrations/migrate_module_access.js | Backfills accessibleModules for existing clients |

## When to Populate This Module
Add controllers, models, routes, services, and utils here when ESGLink-specific business logic is developed.
Reference: implementation_document_of_New_Module_user.md at the root for context.
