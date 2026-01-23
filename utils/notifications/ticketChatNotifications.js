// utils/notifications/ticketChatNotifications.js
const Notification = require('../../models/Notification/Notification');
const User = require('../../models/User');
const { sendMail } = require('../mail');

/**
 * Helper to get user ID
 */
const getUserId = (user) => {
  return user._id || user.id;
};

/**
 * Helper to get ticket URL
 */
const getTicketUrl = (ticketId) => {
  const baseUrl = process.env.FRONTEND_URL || 'https://zerocarbon.greonxpert.com';
  return `${baseUrl}/tickets/${ticketId}`;
};

/**
 * Get notification targets for ticket chat
 * Returns list of user IDs who should be notified
 */
async function getNotificationTargets(ticket, excludeUserId) {
  const targets = new Set();

  // Add ticket creator
  if (ticket.createdBy && ticket.createdBy.toString() !== excludeUserId) {
    targets.add(ticket.createdBy.toString());
  }

  // Add assigned support user
  if (ticket.assignedTo && ticket.assignedTo.toString() !== excludeUserId) {
    targets.add(ticket.assignedTo.toString());
  }

  // Add support manager
  if (ticket.supportManagerId && ticket.supportManagerId.toString() !== excludeUserId) {
    targets.add(ticket.supportManagerId.toString());
  }

  // Add consultant admin if exists
  if (ticket.consultantContext?.consultantAdminId && 
      ticket.consultantContext.consultantAdminId.toString() !== excludeUserId) {
    targets.add(ticket.consultantContext.consultantAdminId.toString());
  }

  // Add assigned consultant if exists
  if (ticket.consultantContext?.assignedConsultantId && 
      ticket.consultantContext.assignedConsultantId.toString() !== excludeUserId) {
    targets.add(ticket.consultantContext.assignedConsultantId.toString());
  }

  // Add watchers
  if (ticket.watchers && ticket.watchers.length > 0) {
    ticket.watchers.forEach(watcherId => {
      if (watcherId.toString() !== excludeUserId) {
        targets.add(watcherId.toString());
      }
    });
  }

  return Array.from(targets);
}

/**
 * Notify when a new comment is posted on a ticket
 * @param {Object} ticket - The ticket document
 * @param {Object} chatComment - The chat comment document
 * @param {Object} commenter - The user who posted the comment
 */
async function notifyTicketChatComment(ticket, chatComment, commenter) {
  try {
    const targets = await getNotificationTargets(ticket, getUserId(commenter));
    if (targets.length === 0) return;

    const ticketUrl = getTicketUrl(ticket._id);

    // Create notifications
    const notifications = targets.map(userId => ({
      createdBy: commenter._id,
      creatorType: commenter.userType,
      targetUsers: [userId],
      title: `New Comment on Ticket: ${ticket.subject}`,
      message: `${commenter.userName} posted a comment on ticket ${ticket.ticketId}`,
      priority: 'medium',
      status: 'published',
      isSystemNotification: true,
      systemAction: 'ticket_chat_comment',
      relatedEntity: {
        type: 'Ticket',
        id: ticket._id
      },
      actionUrl: ticketUrl,
      publishDate: new Date()
    }));

    await Notification.insertMany(notifications);

    // Send email to mentioned users
    if (chatComment.mentions && chatComment.mentions.length > 0) {
      for (const mention of chatComment.mentions) {
        const mentionedUser = await User.findById(mention._id || mention);
        if (mentionedUser && mentionedUser.email) {
          const emailSubject = `You were mentioned in ticket: ${ticket.subject}`;
          const emailBody = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>You were mentioned in a ticket comment</h2>
              <p><strong>${commenter.userName}</strong> mentioned you in a comment on ticket <strong>${ticket.ticketId}</strong></p>
              <div style="background-color: #f8f9fa; padding: 15px; border-radius: 4px; margin: 20px 0;">
                <p>${chatComment.message}</p>
              </div>
              <a href="${ticketUrl}" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">
                View Ticket
              </a>
            </div>
          `;
          await sendMail(mentionedUser.email, emailSubject, emailBody);
        }
      }
    }

    console.log(`[NOTIFICATION] Chat comment notification sent for ticket ${ticket.ticketId}`);

  } catch (error) {
    console.error('[NOTIFICATION] Error in notifyTicketChatComment:', error);
  }
}

/**
 * Notify when a reply is posted to a comment
 * @param {Object} ticket - The ticket document
 * @param {Object} parentComment - The parent comment being replied to
 * @param {Object} chatReply - The reply document
 * @param {Object} replier - The user who posted the reply
 */
async function notifyTicketChatReply(ticket, parentComment, chatReply, replier) {
  try {
    const targets = new Set();

    // Always notify the original commenter
    const commenterId = parentComment.sender.userId.toString();
    const replierId = getUserId(replier).toString();

    if (commenterId !== replierId) {
      targets.add(commenterId);
    }

    // Also notify others who should know
    const otherTargets = await getNotificationTargets(ticket, replierId);
    otherTargets.forEach(id => targets.add(id));

    if (targets.size === 0) return;

    const ticketUrl = getTicketUrl(ticket._id);

    // Create notifications
    const notifications = Array.from(targets).map(userId => ({
      createdBy: replier._id,
      creatorType: replier.userType,
      targetUsers: [userId],
      title: `New Reply on Ticket: ${ticket.subject}`,
      message: `${replier.userName} replied to a comment on ticket ${ticket.ticketId}`,
      priority: 'medium',
      status: 'published',
      isSystemNotification: true,
      systemAction: 'ticket_chat_reply',
      relatedEntity: {
        type: 'Ticket',
        id: ticket._id
      },
      actionUrl: ticketUrl,
      publishDate: new Date()
    }));

    await Notification.insertMany(notifications);

    // Send email to the original commenter
    const commenter = await User.findById(commenterId);
    if (commenter && commenter.email) {
      const emailSubject = `New reply on your comment: ${ticket.subject}`;
      const emailBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Someone replied to your comment</h2>
          <p><strong>${replier.userName}</strong> replied to your comment on ticket <strong>${ticket.ticketId}</strong></p>
          
          <div style="background-color: #f8f9fa; padding: 15px; border-radius: 4px; margin: 20px 0;">
            <p><strong>Your comment:</strong></p>
            <p>${parentComment.message}</p>
          </div>
          
          <div style="background-color: #e7f3ff; padding: 15px; border-radius: 4px; margin: 20px 0;">
            <p><strong>Reply:</strong></p>
            <p>${chatReply.message}</p>
          </div>
          
          <a href="${ticketUrl}" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">
            View Ticket
          </a>
        </div>
      `;
      await sendMail(commenter.email, emailSubject, emailBody);
    }

    // Send email to mentioned users in the reply
    if (chatReply.mentions && chatReply.mentions.length > 0) {
      for (const mention of chatReply.mentions) {
        const mentionedUser = await User.findById(mention._id || mention);
        if (mentionedUser && mentionedUser.email && mentionedUser._id.toString() !== commenterId) {
          const emailSubject = `You were mentioned in a reply: ${ticket.subject}`;
          const emailBody = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>You were mentioned in a reply</h2>
              <p><strong>${replier.userName}</strong> mentioned you in a reply on ticket <strong>${ticket.ticketId}</strong></p>
              <div style="background-color: #e7f3ff; padding: 15px; border-radius: 4px; margin: 20px 0;">
                <p>${chatReply.message}</p>
              </div>
              <a href="${ticketUrl}" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">
                View Ticket
              </a>
            </div>
          `;
          await sendMail(mentionedUser.email, emailSubject, emailBody);
        }
      }
    }

    console.log(`[NOTIFICATION] Chat reply notification sent for ticket ${ticket.ticketId}`);

  } catch (error) {
    console.error('[NOTIFICATION] Error in notifyTicketChatReply:', error);
  }
}

module.exports = {
  notifyTicketChatComment,
  notifyTicketChatReply
};