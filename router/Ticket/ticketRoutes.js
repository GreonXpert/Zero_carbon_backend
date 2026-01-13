// router/Ticket/ticketRoutes.js
const express = require('express');
const router = express.Router();
const { authenticate } = require('../../middleware/auth');
const { uploadTicketAttachments } = require('../../utils/uploads/ticketUploadS3');
const ticketController = require('../../controllers/Ticket/ticketController');

/**
 * Apply authentication to all ticket routes
 */
router.use(authenticate);

// ===== CORE TICKET OPERATIONS =====

/**
 * Create a new ticket
 * POST /api/tickets
 * Body: { clientId, category, subCategory, subject, description, priority, relatedEntities, tags }
 * Files: attachments (optional)
 */
router.post(
  '/',
  uploadTicketAttachments,
  ticketController.createTicket
);

/**
 * List tickets with filters
 * GET /api/tickets
 * Query params:
 *   - clientId: Filter by client
 *   - status: Filter by status (can be comma-separated)
 *   - priority: Filter by priority (can be comma-separated)
 *   - category: Filter by category
 *   - assignedTo: Filter by assignee (use 'me' for current user)
 *   - createdBy: Filter by creator (use 'me' for current user)
 *   - tags: Filter by tags (comma-separated)
 *   - hasAttachments: Filter tickets with attachments (true/false)
 *   - overdue: Filter overdue tickets (true/false)
 *   - dueSoon: Filter tickets due soon (true/false)
 *   - search: Text search in subject/description
 *   - fromDate: Filter from date
 *   - toDate: Filter to date
 *   - page: Page number (default: 1)
 *   - limit: Items per page (default: 20)
 *   - sortBy: Sort field (default: updatedAt)
 *   - sortOrder: Sort order asc/desc (default: desc)
 */
router.get(
  '/',
  ticketController.listTickets
);

/**
 * Get ticket statistics
 * GET /api/tickets/stats
 * Query params:
 *   - clientId: Filter by client
 *   - fromDate: Filter from date
 *   - toDate: Filter to date
 */
router.get(
  '/stats',
  ticketController.getStats
);

/**
 * Get ticket details
 * GET /api/tickets/:id
 * Includes ticket info, activities, and SLA info
 */
router.get(
  '/:id',
  ticketController.getTicket
);

/**
 * Update ticket
 * PATCH /api/tickets/:id
 * Body: { subject, description, category, subCategory, tags, priority }
 * Note: Limited fields for regular users, more for admins
 */
router.patch(
  '/:id',
  ticketController.updateTicket
);

/**
 * Delete ticket
 * DELETE /api/tickets/:id
 * Only super_admin or creator (for drafts) can delete
 */
router.delete(
  '/:id',
  ticketController.deleteTicket
);

// ===== WORKFLOW OPERATIONS =====

/**
 * Add comment to ticket
 * POST /api/tickets/:id/comments
 * Body: { text, isInternal, mentions }
 * Files: attachments (optional)
 */
router.post(
  '/:id/comments',
  uploadTicketAttachments,
  ticketController.addComment
);

/**
 * Assign ticket
 * POST /api/tickets/:id/assign
 * Body: { assignTo }
 */
router.post(
  '/:id/assign',
  ticketController.assignTicket
);

/**
 * Escalate ticket
 * POST /api/tickets/:id/escalate
 * Body: { reason }
 */
router.post(
  '/:id/escalate',
  ticketController.escalateTicket
);

/**
 * Resolve ticket
 * POST /api/tickets/:id/resolve
 * Body: { resolutionNotes }
 */
router.post(
  '/:id/resolve',
  ticketController.resolveTicket
);

/**
 * Close ticket
 * POST /api/tickets/:id/close
 * Body: { satisfactionRating, userFeedback }
 */
router.post(
  '/:id/close',
  ticketController.closeTicket
);

/**
 * Reopen ticket
 * POST /api/tickets/:id/reopen
 * Body: { reason }
 */
router.post(
  '/:id/reopen',
  ticketController.reopenTicket
);

// ===== ATTACHMENT OPERATIONS =====

/**
 * Upload attachments to ticket
 * POST /api/tickets/:id/attachments
 * Files: attachments (required, max 5 files, 10MB each)
 */
router.post(
  '/:id/attachments',
  uploadTicketAttachments,
  ticketController.uploadAttachment
);

/**
 * Delete attachment from ticket
 * DELETE /api/tickets/:id/attachments/:attachmentId
 */
router.delete(
  '/:id/attachments/:attachmentId',
  ticketController.deleteAttachment
);

// ===== WATCHER OPERATIONS =====

/**
 * Add watcher to ticket
 * POST /api/tickets/:id/watchers
 * Body: { watcherId }
 */
router.post(
  '/:id/watchers',
  ticketController.addWatcher
);

/**
 * Remove watcher from ticket
 * DELETE /api/tickets/:id/watchers/:watcherId
 */
router.delete(
  '/:id/watchers/:watcherId',
  ticketController.removeWatcher
);

// ===== ROUTE ERROR HANDLING =====

/**
 * Handle 404 for ticket routes
 */
router.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Ticket endpoint not found',
    path: req.originalUrl
  });
});

/**
 * Handle errors in ticket routes
 */
router.use((error, req, res, next) => {
  console.error('[TICKET ROUTES] Error:', error);

  // Handle multer errors
  if (error.name === 'MulterError') {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: 'File too large. Maximum size is 10MB per file.'
      });
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        message: 'Too many files. Maximum is 5 files per upload.'
      });
    }
  }

  // Handle other errors
  res.status(error.status || 500).json({
    success: false,
    message: error.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
  });
});

module.exports = router;