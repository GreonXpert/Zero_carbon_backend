'use strict';

const router = require('express').Router();
const c = require('../controllers/targetsController');

// ── Core CRUD ─────────────────────────────────────────────────────────────────
router.post  ('/',              c.createTarget);
router.get   ('/',              c.listTargets);
router.get   ('/:targetId',     c.getTarget);
router.patch ('/:targetId',     c.updateTarget);

// ── Workflow transitions ──────────────────────────────────────────────────────
router.post  ('/:targetId/submit',   c.submitTarget);
router.post  ('/:targetId/review',   c.reviewTarget);
router.post  ('/:targetId/return',   c.returnTarget);
router.post  ('/:targetId/approve',  c.approveTarget);
router.post  ('/:targetId/publish',  c.publishTarget);
router.post  ('/:targetId/archive',  c.archiveTarget);

// ── Sub-resources ─────────────────────────────────────────────────────────────
router.get   ('/:targetId/revisions',          c.getRevisions);
router.get   ('/:targetId/pathway',            c.getPathway);
router.get   ('/:targetId/operational-budgets',c.getOperationalBudgets);
router.get   ('/:targetId/progress',           c.getProgress);
router.get   ('/:targetId/forecast',           c.getForecast);
router.get   ('/:targetId/live',               c.getLive);
router.get   ('/:targetId/history',            c.getHistory);
router.get   ('/:targetId/initiatives',        c.getInitiatives);
router.get   ('/:targetId/attachments',        c.getAttachments);

// ── Phase 4 & 5: Compute triggers ────────────────────────────────────────────
router.post  ('/:targetId/progress/compute',   c.computeProgress);
router.post  ('/:targetId/forecast/compute',   c.computeForecast);

// ── Phase 6: DQ flags ─────────────────────────────────────────────────────────
router.get   ('/:targetId/dq-flags',                      c.listDqFlags);
router.post  ('/:targetId/dq-flags/:flagId/resolve',      c.resolveDqFlag);

// ── Phase 7: OutputActivityRecord CRUD ───────────────────────────────────────
router.post  ('/:targetId/output-records',                c.createOutputRecord);
router.get   ('/:targetId/output-records',                c.listOutputRecords);
router.patch ('/:targetId/output-records/:recordId',      c.updateOutputRecord);
router.delete('/:targetId/output-records/:recordId',      c.deleteOutputRecord);

module.exports = router;
