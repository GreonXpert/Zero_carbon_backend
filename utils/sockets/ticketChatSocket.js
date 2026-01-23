// utils/sockets/ticketChatSocket.js

/**
 * Socket.IO instance for ticket chat events
 * This will be set from index.js
 */
let io = null;

/**
 * Set Socket.IO instance
 * Called from index.js during server initialization
 */
function setTicketChatSocketIO(socketIO) {
  io = socketIO;
  console.log('[TICKET CHAT SOCKET] Socket.IO instance configured');
}

/**
 * Emit ticket chat event to relevant rooms
 * @param {string} eventName - Name of the event
 * @param {object} eventData - Data to emit
 */
function emitTicketChatEvent(eventName, eventData) {
  if (!io) {
    console.warn('[TICKET CHAT SOCKET] Socket.IO not initialized, skipping event:', eventName);
    return;
  }

  try {
    const { clientId, ticketId, chatMessage, commentId, messageType } = eventData;

    console.log(`[TICKET CHAT SOCKET] Emitting ${eventName} for ticket ${ticketId}`);

    // Emit to ticket-specific room (all users watching this ticket)
    io.to(`ticket_${ticketId}`).emit(eventName, {
      ticketId,
      chatMessage,
      commentId,
      messageType,
      timestamp: new Date().toISOString()
    });

    // Emit to client room (for dashboard updates)
    if (clientId && clientId !== 'INTERNAL-SUPPORT') {
      io.to(`client_${clientId}`).emit('ticket-chat-activity', {
        ticketId,
        eventName,
        timestamp: new Date().toISOString()
      });
    }

    // For new comments or replies, also emit to specific user rooms
    if (chatMessage && (eventName === 'ticket-chat-new-comment' || eventName === 'ticket-chat-new-reply')) {
      // This could be used to notify specific users mentioned in the message
      if (chatMessage.mentions && chatMessage.mentions.length > 0) {
        chatMessage.mentions.forEach(mentionedUserId => {
          io.to(`user_${mentionedUserId}`).emit('ticket-chat-mentioned', {
            ticketId,
            chatMessage,
            timestamp: new Date().toISOString()
          });
        });
      }
    }

  } catch (error) {
    console.error(`[TICKET CHAT SOCKET] Error emitting ${eventName}:`, error);
  }
}

/**
 * Broadcast new comment event
 */
function broadcastNewComment(commentData) {
  emitTicketChatEvent('ticket-chat-new-comment', commentData);
}

/**
 * Broadcast new reply event
 */
function broadcastNewReply(replyData) {
  emitTicketChatEvent('ticket-chat-new-reply', replyData);
}

/**
 * Broadcast chat updated event
 */
function broadcastChatUpdated(updateData) {
  emitTicketChatEvent('ticket-chat-updated', updateData);
}

/**
 * Broadcast chat deleted event
 */
function broadcastChatDeleted(deleteData) {
  emitTicketChatEvent('ticket-chat-deleted', deleteData);
}

module.exports = {
  setTicketChatSocketIO,
  emitTicketChatEvent,
  broadcastNewComment,
  broadcastNewReply,
  broadcastChatUpdated,
  broadcastChatDeleted
};