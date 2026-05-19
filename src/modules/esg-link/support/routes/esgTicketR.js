'use strict';

const express = require('express');
const router  = express.Router();

const { authenticate }                    = require('../../../../common/middleware/auth');
const { requireActiveModuleSubscription } = require('../../../../common/utils/Permissions/modulePermission');
const { uploadTicketAttachments }         = require('../../../../common/utils/uploads/ticketUploadS3');
const ticketCtrl                          = require('../../../../common/controllers/ticket/ticketController');
const ticketChatCtrl                      = require('../../../../common/controllers/ticket/ticketChatController');

// Gate: JWT auth + active esg_link subscription
const gate = [authenticate, requireActiveModuleSubscription('esg_link')];

// ── Core CRUD ─────────────────────────────────────────────────────────────────
router.post('/',    ...gate, uploadTicketAttachments, ticketCtrl.createTicket);
router.get('/',     ...gate, ticketCtrl.listTickets);
router.get('/stats',...gate, ticketCtrl.getStats);
router.get('/:id',  ...gate, ticketCtrl.getTicket);
router.patch('/:id',...gate, ticketCtrl.updateTicket);
router.delete('/:id',...gate, ticketCtrl.deleteTicket);

// ── Workflow ──────────────────────────────────────────────────────────────────
router.post('/:id/comments',  ...gate, uploadTicketAttachments, ticketCtrl.addComment);
router.post('/:id/assign',    ...gate, ticketCtrl.assignTicket);
router.post('/:id/escalate',  ...gate, ticketCtrl.escalateTicket);
router.post('/:id/resolve',   ...gate, ticketCtrl.resolveTicket);
router.post('/:id/close',     ...gate, ticketCtrl.closeTicket);
router.post('/:id/reopen',    ...gate, ticketCtrl.reopenTicket);

// ── Attachments ───────────────────────────────────────────────────────────────
router.post('/:id/attachments',                   ...gate, uploadTicketAttachments, ticketCtrl.uploadAttachment);
router.delete('/:id/attachments/:attachmentId',   ...gate, ticketCtrl.deleteAttachment);

// ── Watchers ──────────────────────────────────────────────────────────────────
router.post('/:id/watchers',           ...gate, ticketCtrl.addWatcher);
router.delete('/:id/watchers/:watcherId', ...gate, ticketCtrl.removeWatcher);

// ── Chat ──────────────────────────────────────────────────────────────────────
router.get('/:id/chat',                          ...gate, ticketChatCtrl.getChatHistory);
router.get('/:id/chat/unread-count',             ...gate, ticketChatCtrl.getUnreadCount);
router.post('/:id/chat/comment',                 ...gate, uploadTicketAttachments, ticketChatCtrl.createComment);
router.post('/:id/chat/:commentId/reply',        ...gate, uploadTicketAttachments, ticketChatCtrl.createReply);
router.patch('/:id/chat/:chatId',                ...gate, ticketChatCtrl.editChatMessage);
router.delete('/:id/chat/:chatId',               ...gate, ticketChatCtrl.deleteChatMessage);
router.post('/:id/chat/:chatId/read',            ...gate, ticketChatCtrl.markAsRead);

// ── Activity & History ────────────────────────────────────────────────────────
router.get('/:id/activities',  ...gate, ticketCtrl.getTicketActivities);
router.get('/:id/history',     ...gate, ticketCtrl.getTicketHistory);
router.get('/:id/can-comment', ...gate, ticketCtrl.checkCanComment);

module.exports = router;
