// controllers/Ticket/ticketChatController.js
const TicketChat = require('../../models/Ticket/TicketChat');
const { Ticket } = require('../../models/Ticket/Ticket');
const User = require('../../models/User');
const { saveTicketAttachments, deleteMultipleAttachments } = require('../../utils/uploads/ticketUploadS3');
const { emitTicketChatEvent } = require('../../utils/sockets/ticketChatSocket');
const { notifyTicketChatComment, notifyTicketChatReply } = require('../../utils/notifications/ticketChatNotifications');

/**
 * Helper function to get user ID from request
 */
const getUserId = (user) => {
  return user._id || user.id;
};

/**
 * Helper function to find ticket by ID or ticketId
 */
const findTicketByIdOrTicketId = async (id) => {
  const mongoose = require('mongoose');
  
  // Check if id is a valid MongoDB ObjectId (24 character hex string)
  // This prevents the CastError when passing ticketId strings like "TKT-2026-00002"
  if (mongoose.Types.ObjectId.isValid(id) && /^[0-9a-fA-F]{24}$/.test(id)) {
    // Try finding by MongoDB _id first
    const ticket = await Ticket.findById(id);
    if (ticket) return ticket;
  }
  
  // Otherwise, search by custom ticketId field (e.g., "TKT-2026-00002")
  return await Ticket.findOne({ ticketId: id });
};
/**
 * Check if user can access ticket chat
 */
const canAccessTicketChat = async (user, ticket) => {
  const userId = getUserId(user);
  const userType = user.userType;

  // Super admin can access all
  if (userType === 'super_admin') {
    return { allowed: true };
  }

  // Client-side users: check clientId match
  if (['client', 'client_admin', 'employee', 'auditor'].includes(userType)) {
    if (ticket.clientId !== user.clientId) {
      return { allowed: false, reason: 'Cannot access ticket from different client' };
    }
    return { allowed: true };
  }

  // Consultant-side users
  if (['consultant', 'consultant_admin'].includes(userType)) {
    // ✅ FIX: Convert userId to string for consistent comparison
    const userIdStr = userId.toString();
    
    // For internal support tickets (consultant's own issues)
    if (ticket.clientId === 'INTERNAL-SUPPORT' || ticket.consultantContext?.isConsultantIssue) {
      if (ticket.createdBy?.toString() === userIdStr) {
        return { allowed: true };
      }
    }
    
    // Check if consultant is related to this ticket
    const isRelated = 
      ticket.consultantContext?.consultantAdminId?.toString() === userIdStr ||
      ticket.consultantContext?.assignedConsultantId?.toString() === userIdStr ||
      ticket.createdBy?.toString() === userIdStr;

    if (!isRelated) {
      return { allowed: false, reason: 'Cannot access ticket from unrelated client' };
    }
    return { allowed: true };
  }

  // Support users: check assignment or team
  if (['support', 'supportManager'].includes(userType)) {
    const userIdStr = userId.toString();
    const isAssigned = ticket.assignedTo?.toString() === userIdStr;
    const isManager = ticket.supportManagerId?.toString() === userIdStr;
    
    if (userType === 'supportManager' && isManager) {
      return { allowed: true };
    }

    if (userType === 'support' && isAssigned) {
      return { allowed: true };
    }

    return { allowed: false, reason: 'Ticket not assigned to you' };
  }

  return { allowed: false, reason: 'Access denied' };
};

/**
 * Check if user can post comments
 * Comments are from: client, consultant, consultant_admin
 */
const canPostComment = (userType) => {
  return ['client', 'client_admin', 'employee', 'auditor', 'consultant', 'consultant_admin', 'super_admin'].includes(userType);
};

/**
 * Check if user can post replies
 * Replies are from: support (assigned), supportManager, super_admin
 */
/**
 * Check if user can post replies
 * Replies are from: support (assigned), supportManager, super_admin
 */
const canPostReply = (user, ticket) => {
  const userId = getUserId(user);
  const userType = user.userType;

  if (userType === 'super_admin') return true;

  // Convert userId to string for consistent comparison
  const userIdStr = userId.toString();

  if (userType === 'supportManager') {
    return ticket.supportManagerId?.toString() === userIdStr;
  }

  if (userType === 'support') {
    return ticket.assignedTo?.toString() === userIdStr;
  }

  return false;
};

// ===== CONTROLLER METHODS =====


/**
 * POST /api/tickets/:id/chat/comment
 * Create a new comment on a ticket
 */
exports.createComment = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = getUserId(req.user);
    const { message, mentions = [] } = req.body;

    // Validate message
    if (!message || message.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Message is required'
      });
    }

    if (message.length > 5000) {
      return res.status(400).json({
        success: false,
        message: 'Message too long (max 5000 characters)'
      });
    }

    // Check if user can post comments
    if (!canPostComment(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to post comments. Only clients, consultants, and admins can post comments.'
      });
    }

    // Find ticket
    const ticket = await findTicketByIdOrTicketId(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Check access to ticket
    const access = await canAccessTicketChat(req.user, ticket);
    if (!access.allowed) {
      return res.status(403).json({
        success: false,
        message: access.reason || 'Access denied'
      });
    }

    // Handle attachments if present
    let attachments = [];
    if (req.files && req.files.length > 0) {
      attachments = await saveTicketAttachments(req, {
        clientId: ticket.clientId,
        ticketId: ticket.ticketId,
        userId,
        type: 'chat-comment'
      });
    }

    // Create chat comment
    const chatComment = new TicketChat({
      ticketId: ticket._id,
      messageType: 'comment',
      parentCommentId: null,
      message: message.trim(),
      sender: {
        userId: userId,
        userName: req.user.userName,
        userType: req.user.userType
      },
      attachments,
      mentions,
      clientId: ticket.clientId
    });

    await chatComment.save();

    // Populate mentions
    await chatComment.populate('mentions', 'userName email userType');

    // Emit socket event
    emitTicketChatEvent('ticket-chat-new-comment', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      chatMessage: chatComment.toObject()
    });

    // Send notifications
    try {
      await notifyTicketChatComment(ticket, chatComment, req.user);
    } catch (notifyError) {
      console.error('[TICKET CHAT] Error sending comment notifications:', notifyError);
    }

    res.status(201).json({
      success: true,
      message: 'Comment posted successfully',
      data: chatComment
    });

  } catch (error) {
    console.error('[TICKET CHAT] Error creating comment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to post comment',
      error: error.message
    });
  }
};

/**
 * POST /api/tickets/:id/chat/:commentId/reply
 * Reply to a specific comment
 */
exports.createReply = async (req, res) => {
  try {
    const { id, commentId } = req.params;
    const userId = getUserId(req.user);
    const { message, mentions = [] } = req.body;

    // Validate message
    if (!message || message.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Message is required'
      });
    }

    if (message.length > 5000) {
      return res.status(400).json({
        success: false,
        message: 'Message too long (max 5000 characters)'
      });
    }

    // Find ticket
    const ticket = await findTicketByIdOrTicketId(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Check if user can reply
    if (!canPostReply(req.user, ticket)) {
      return res.status(403).json({
        success: false,
        message: 'Only the assigned support user or support manager can reply to comments'
      });
    }

    // Find parent comment
    const parentComment = await TicketChat.findOne({
      _id: commentId,
      ticketId: ticket._id,
      messageType: 'comment',
      isDeleted: false
    });

    if (!parentComment) {
      return res.status(404).json({
        success: false,
        message: 'Parent comment not found or has been deleted'
      });
    }

    // Handle attachments if present
    let attachments = [];
    if (req.files && req.files.length > 0) {
      attachments = await saveTicketAttachments(req, {
        clientId: ticket.clientId,
        ticketId: ticket.ticketId,
        userId,
        type: 'chat-reply'
      });
    }

    // Create reply
    const chatReply = new TicketChat({
      ticketId: ticket._id,
      messageType: 'reply',
      parentCommentId: commentId,
      message: message.trim(),
      sender: {
        userId: userId,
        userName: req.user.userName,
        userType: req.user.userType
      },
      attachments,
      mentions,
      clientId: ticket.clientId
    });

    await chatReply.save();

    // Populate mentions
    await chatReply.populate('mentions', 'userName email userType');

    // Emit socket event
    emitTicketChatEvent('ticket-chat-new-reply', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      commentId: commentId,
      chatMessage: chatReply.toObject()
    });

    // Send notifications
    try {
      await notifyTicketChatReply(ticket, parentComment, chatReply, req.user);
    } catch (notifyError) {
      console.error('[TICKET CHAT] Error sending reply notifications:', notifyError);
    }

    res.status(201).json({
      success: true,
      message: 'Reply posted successfully',
      data: chatReply
    });

  } catch (error) {
    console.error('[TICKET CHAT] Error creating reply:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to post reply',
      error: error.message
    });
  }
};

/**
 * GET /api/tickets/:id/chat
 * Get all chat history for a ticket
 */
exports.getChatHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 100, includeDeleted = false } = req.query;

    // Find ticket
    const ticket = await findTicketByIdOrTicketId(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Check access to ticket
    const access = await canAccessTicketChat(req.user, ticket);
    if (!access.allowed) {
      return res.status(403).json({
        success: false,
        message: access.reason || 'Access denied'
      });
    }

    // Get chat history with nested replies
    const chatHistory = await TicketChat.getChatHistory(ticket._id, {
      includeDeleted: includeDeleted === 'true',
      limit: parseInt(limit),
      page: parseInt(page)
    });

    // Get total comment count
    const totalComments = await TicketChat.countDocuments({
      ticketId: ticket._id,
      messageType: 'comment',
      ...(includeDeleted === 'true' ? {} : { isDeleted: false })
    });

    // Get unread count for current user
    const unreadCount = await TicketChat.getUnreadCount(ticket._id, getUserId(req.user));

    res.json({
      success: true,
      data: {
        chatHistory,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          totalComments,
          totalPages: Math.ceil(totalComments / parseInt(limit))
        },
        unreadCount
      }
    });

  } catch (error) {
    console.error('[TICKET CHAT] Error getting chat history:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve chat history',
      error: error.message
    });
  }
};

/**
 * PATCH /api/tickets/:id/chat/:chatId
 * Edit a chat message (own messages only, within 24 hours)
 */
exports.editChatMessage = async (req, res) => {
  try {
    const { id, chatId } = req.params;
    const userId = getUserId(req.user);
    const { message } = req.body;

    // Validate message
    if (!message || message.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Message is required'
      });
    }

    if (message.length > 5000) {
      return res.status(400).json({
        success: false,
        message: 'Message too long (max 5000 characters)'
      });
    }

    // Find ticket
    const ticket = await findTicketByIdOrTicketId(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Find chat message
    const chatMessage = await TicketChat.findOne({
      _id: chatId,
      ticketId: ticket._id
    });

    if (!chatMessage) {
      return res.status(404).json({
        success: false,
        message: 'Chat message not found'
      });
    }

    // Check if user can edit
    if (!chatMessage.canEdit(userId)) {
      return res.status(403).json({
        success: false,
        message: 'You can only edit your own messages within 24 hours of posting'
      });
    }

    // Update message
    chatMessage.message = message.trim();
    chatMessage.isEdited = true;
    chatMessage.editedAt = new Date();

    await chatMessage.save();

    // Emit socket event
    emitTicketChatEvent('ticket-chat-updated', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      chatMessage: chatMessage.toObject()
    });

    res.json({
      success: true,
      message: 'Chat message updated successfully',
      data: chatMessage
    });

  } catch (error) {
    console.error('[TICKET CHAT] Error editing chat message:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to edit chat message',
      error: error.message
    });
  }
};

/**
 * DELETE /api/tickets/:id/chat/:chatId
 * Delete a chat message (soft delete)
 */
exports.deleteChatMessage = async (req, res) => {
  try {
    const { id, chatId } = req.params;
    const userId = getUserId(req.user);

    // Find ticket
    const ticket = await findTicketByIdOrTicketId(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Find chat message
    const chatMessage = await TicketChat.findOne({
      _id: chatId,
      ticketId: ticket._id
    });

    if (!chatMessage) {
      return res.status(404).json({
        success: false,
        message: 'Chat message not found'
      });
    }

    // Check if user can delete
    if (!chatMessage.canDelete(userId, req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: 'You can only delete your own messages within 5 minutes of posting, or you must be a super admin'
      });
    }

    // Soft delete
    chatMessage.isDeleted = true;
    chatMessage.deletedAt = new Date();
    chatMessage.deletedBy = userId;

    await chatMessage.save();

    // If this is a comment, also soft delete all its replies
    if (chatMessage.messageType === 'comment') {
      await TicketChat.updateMany(
        { parentCommentId: chatId },
        { 
          isDeleted: true, 
          deletedAt: new Date(),
          deletedBy: userId 
        }
      );
    }

    // Emit socket event
    emitTicketChatEvent('ticket-chat-deleted', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      chatId: chatId,
      messageType: chatMessage.messageType
    });

    res.json({
      success: true,
      message: 'Chat message deleted successfully'
    });

  } catch (error) {
    console.error('[TICKET CHAT] Error deleting chat message:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete chat message',
      error: error.message
    });
  }
};

/**
 * POST /api/tickets/:id/chat/:chatId/read
 * Mark a chat message as read
 */
exports.markAsRead = async (req, res) => {
  try {
    const { id, chatId } = req.params;
    const userId = getUserId(req.user);

    // Find ticket
    const ticket = await findTicketByIdOrTicketId(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Check access
    const access = await canAccessTicketChat(req.user, ticket);
    if (!access.allowed) {
      return res.status(403).json({
        success: false,
        message: access.reason || 'Access denied'
      });
    }

    // Find and mark chat message as read
    const chatMessage = await TicketChat.findOne({
      _id: chatId,
      ticketId: ticket._id,
      isDeleted: false
    });

    if (!chatMessage) {
      return res.status(404).json({
        success: false,
        message: 'Chat message not found'
      });
    }

    chatMessage.markAsRead(userId);
    await chatMessage.save();

    res.json({
      success: true,
      message: 'Marked as read'
    });

  } catch (error) {
    console.error('[TICKET CHAT] Error marking as read:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark as read',
      error: error.message
    });
  }
};

/**
 * GET /api/tickets/:id/chat/unread-count
 * Get unread message count for a ticket
 */
exports.getUnreadCount = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = getUserId(req.user);

    // Find ticket
    const ticket = await findTicketByIdOrTicketId(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Check access
    const access = await canAccessTicketChat(req.user, ticket);
    if (!access.allowed) {
      return res.status(403).json({
        success: false,
        message: access.reason || 'Access denied'
      });
    }

    const unreadCount = await TicketChat.getUnreadCount(ticket._id, userId);

    res.json({
      success: true,
      data: {
        unreadCount
      }
    });

  } catch (error) {
    console.error('[TICKET CHAT] Error getting unread count:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get unread count',
      error: error.message
    });
  }
};

module.exports = exports;