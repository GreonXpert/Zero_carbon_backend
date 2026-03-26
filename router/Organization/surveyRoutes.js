// router/Organization/surveyRoutes.js
// Two sub-routers:
//   surveyAuthRouter  – authenticated endpoints (Bearer token required)
//   surveyPublicRouter – public endpoints (no auth; survey respondents)
//
// Mount in index.js:
//   app.use('/api/surveys', surveyAuthRouter);
//   app.use('/api/survey',  surveyPublicRouter);

const express = require('express');
const { auth } = require('../../middleware/auth');

const {
  // Authenticated
  generateSurveyLinks,
  generateAnonymousCodes,
  getSurveySchedule,
  getSurveyStatistics,
  cancelSurvey,
  approveSurvey,
  updateSurveyThreshold,
  getSurveyResponses,
  getResponseRates,
  invalidateSurveyLink,
  resendSurveyLink,
  exportSurveyResults,
  // Missed cycle average fill
  calculateAverageSurvey,
  approveCycleAverage,
  rejectCycleAverage,
  // Public
  resolveUniqueToken,
  saveUniqueAutosave,
  submitUniqueSurvey,
  resolveAnonymousCode,
  submitAnonymousSurvey,
} = require('../../controllers/Organization/surveyController');

// ─────────────────────────────────────────────────────────────────────────────
// Public router  (prefix: /api/survey)
// No auth middleware — respondents access these via their survey link/code.
// ─────────────────────────────────────────────────────────────────────────────
const surveyPublicRouter = express.Router();

surveyPublicRouter.use((req, res, next) => {
  console.log('[PUBLIC SURVEY ROUTER HIT]', req.method, req.path);
  next();
});


// Unique mode
surveyPublicRouter.get('/resolve/:token',    resolveUniqueToken);
surveyPublicRouter.patch('/autosave/:token', saveUniqueAutosave);
surveyPublicRouter.post('/submit/:token',    submitUniqueSurvey);

// Anonymous mode
surveyPublicRouter.post('/anonymous/resolve', resolveAnonymousCode);
surveyPublicRouter.post('/anonymous/submit',  submitAnonymousSurvey);

// ─────────────────────────────────────────────────────────────────────────────
// Authenticated router  (prefix: /api/surveys)
// ─────────────────────────────────────────────────────────────────────────────
const surveyAuthRouter = express.Router();

surveyAuthRouter.use(auth);

// Link / code generation
surveyAuthRouter.post('/:clientId/generate-links',  generateSurveyLinks);
surveyAuthRouter.post('/:clientId/generate-codes',  generateAnonymousCodes);

// Schedule & statistics
surveyAuthRouter.get('/:clientId/schedule',                              getSurveySchedule);
surveyAuthRouter.get('/:clientId/cycles/:cycleIndex/statistics',        getSurveyStatistics);

// Cancel a cycle
surveyAuthRouter.post('/:clientId/cycles/:cycleIndex/cancel',            cancelSurvey);

// Approve a cycle (threshold-gated; runs average-fill + saves DataEntry)
surveyAuthRouter.post('/:clientId/cycles/:cycleIndex/approve',           approveSurvey);

// Missed cycle — cross-cycle average fill + consultant review
surveyAuthRouter.post('/:clientId/cycles/:cycleIndex/calculate-average', calculateAverageSurvey);
surveyAuthRouter.post('/:clientId/cycles/:cycleIndex/approve-average',   approveCycleAverage);
surveyAuthRouter.post('/:clientId/cycles/:cycleIndex/reject-average',    rejectCycleAverage);

// Update completion threshold % for a cycle
surveyAuthRouter.patch('/:clientId/cycles/:cycleIndex/threshold',        updateSurveyThreshold);

// Response data
surveyAuthRouter.get('/:clientId/responses',                            getSurveyResponses);
surveyAuthRouter.get('/:clientId/response-rates',                       getResponseRates);
surveyAuthRouter.get('/:clientId/export',                               exportSurveyResults);

// Individual link management
surveyAuthRouter.patch('/:clientId/links/:linkId/invalidate',          invalidateSurveyLink);
surveyAuthRouter.post('/:clientId/links/:linkId/resend',               resendSurveyLink);



module.exports = { surveyAuthRouter, surveyPublicRouter };
