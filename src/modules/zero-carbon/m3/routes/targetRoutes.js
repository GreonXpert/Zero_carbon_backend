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

module.exports = router;
