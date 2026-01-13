
// utils/notifications/ticketNotifications.js
const Notification = require('../../models/Notification/Notification');
const User = require('../../models/User');
const Client = require('../../models/CMS/Client');
const { sendMail } = require('../mail');

/**
 * Get user ID (handle both formats)
 */
function getUserId(user) {
  return user.id || user._id?.toString() || user._id;
}

/**
 * Build ticket URL
 */
function getTicketUrl(ticketId) {
  const baseUrl = process.env.FRONTEND_URL || 'https://zerocarbon.greonxpert.com';
  return `${baseUrl}/tickets/${ticketId}`;
}

/**
 * Get notification targets for a ticket
 * Returns array of user IDs who should receive notification
 */
async function getNotificationTargets(ticket, excludeUserId = null) {
  const targets = new Set();

  // Add creator
  if (ticket.createdBy) {
    const creatorId = ticket.createdBy._id || ticket.createdBy;
    targets.add(creatorId.toString());
  }

  // Add assignee
  if (ticket.assignedTo) {
    const assigneeId = ticket.assignedTo._id || ticket.assignedTo;
    targets.add(assigneeId.toString());
  }

  // Add watchers
  if (ticket.watchers && ticket.watchers.length > 0) {
    ticket.watchers.forEach(watcher => {
      const watcherId = watcher._id || watcher;
      targets.add(watcherId.toString());
    });
  }

  // Remove excluded user (typically the one performing the action)
  if (excludeUserId) {
    targets.delete(excludeUserId.toString());
  }

  return Array.from(targets);
}

/**
 * Get admin users who should be notified for escalations
 */
async function getAdminTargets(clientId) {
  const targets = new Set();

  // Get client info
  const client = await Client.findOne({ clientId });
  if (!client) {
    return [];
  }

  // Add consultant admin who created the lead
  if (client.leadInfo?.createdBy) {
    targets.add(client.leadInfo.createdBy.toString());
  }

  // Add assigned consultant
  if (client.workflowTracking?.assignedConsultantId) {
    targets.add(client.workflowTracking.assignedConsultantId.toString());
  }

  // Get all super admins
  const superAdmins = await User.find({ 
    userType: 'super_admin',
    isActive: true 
  }).select('_id');
  
  superAdmins.forEach(admin => {
    targets.add(admin._id.toString());
  });

  return Array.from(targets);
}

/**
 * Create notification in database
 */
async function createNotification(data) {
  try {
    const notification = new Notification({
      title: data.title,
      message: data.message,
      priority: data.priority || 'medium',
      createdBy: data.createdBy,
      creatorType: data.creatorType,
      targetUsers: data.targetUsers || [],
      status: 'published',
      publishedAt: new Date(),
      isSystemNotification: true,
      systemAction: data.systemAction || 'ticket_update',
      relatedEntity: {
        type: 'ticket',
        id: data.ticketId
      },
      metadata: data.metadata || {}
    });

    await notification.save();

    // Broadcast via Socket.IO if available
    if (global.broadcastNotification) {
      await global.broadcastNotification(notification);
    }

    return notification;
  } catch (error) {
    console.error('[TICKET NOTIFICATION] Error creating notification:', error);
    throw error;
  }
}

/**
 * Send email notification
 */
async function sendEmailNotification(recipients, subject, htmlContent, textContent) {
  if (!recipients || recipients.length === 0) {
    return;
  }

  try {
    // Get recipient emails
    const users = await User.find({
      _id: { $in: recipients }
    }).select('email userName');

    for (const user of users) {
      if (user.email) {
        try {
          await sendMail(user.email, subject, textContent, htmlContent);
          console.log(`[TICKET EMAIL] Sent to ${user.email}: ${subject}`);
        } catch (emailError) {
          console.error(`[TICKET EMAIL] Failed to send to ${user.email}:`, emailError.message);
        }
      }
    }
  } catch (error) {
    console.error('[TICKET EMAIL] Error sending emails:', error);
  }
}

/**
 * Build email HTML template
 */
function buildEmailTemplate(content) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body {
          font-family: Arial, sans-serif;
          line-height: 1.6;
          color: #333;
          max-width: 600px;
          margin: 0 auto;
          padding: 20px;
        }
        .header {
          background-color: #4CAF50;
          color: white;
          padding: 20px;
          text-align: center;
          border-radius: 5px 5px 0 0;
        }
        .content {
          background-color: #f9f9f9;
          padding: 30px;
          border: 1px solid #ddd;
        }
        .ticket-info {
          background-color: white;
          padding: 15px;
          margin: 20px 0;
          border-left: 4px solid #4CAF50;
          border-radius: 4px;
        }
        .ticket-info strong {
          color: #4CAF50;
        }
        .button {
          display: inline-block;
          padding: 12px 24px;
          background-color: #4CAF50;
          color: white;
          text-decoration: none;
          border-radius: 5px;
          margin: 20px 0;
        }
        .footer {
          text-align: center;
          margin-top: 20px;
          padding-top: 20px;
          border-top: 1px solid #ddd;
          font-size: 12px;
          color: #666;
        }
        .priority-critical { color: #f44336; font-weight: bold; }
        .priority-high { color: #ff9800; font-weight: bold; }
        .priority-medium { color: #2196F3; }
        .priority-low { color: #4CAF50; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>🎫 Zero Carbon Platform - Support Ticket</h1>
      </div>
      <div class="content">
        ${content}
      </div>
      <div class="footer">
        <p>This is an automated email from Zero Carbon Platform.</p>
        <p>© ${new Date().getFullYear()} Zero Carbon Platform. All rights reserved.</p>
      </div>
    </body>
    </html>
  `;
}

/**
 * Get priority CSS class
 */
function getPriorityClass(priority) {
  return `priority-${priority}`;
}

// ===== NOTIFICATION FUNCTIONS =====

/**
 * Notify when ticket is created
 */
async function notifyTicketCreated(ticket, creator) {
  try {
    console.log('[TICKET NOTIFICATION] Ticket created:', ticket.ticketId);

    const creatorId = getUserId(creator);
    const ticketUrl = getTicketUrl(ticket._id);

    // Get targets (support staff and admins for new tickets)
    const adminTargets = await getAdminTargets(ticket.clientId);

    if (adminTargets.length === 0) {
      console.log('[TICKET NOTIFICATION] No admin targets found for ticket creation');
      return;
    }

    // Create notification
    await createNotification({
      title: `New Ticket: ${ticket.subject}`,
      message: `A new ${ticket.priority} priority ticket has been created by ${creator.userName}. Category: ${ticket.category}`,
      priority: ticket.priority === 'critical' ? 'high' : 'medium',
      createdBy: creatorId,
      creatorType: creator.userType,
      targetUsers: adminTargets,
      systemAction: 'ticket_created',
      ticketId: ticket._id,
      metadata: {
        ticketId: ticket.ticketId,
        category: ticket.category,
        priority: ticket.priority
      }
    });

    // Send email to admins
    const emailContent = `
      <h2>New Support Ticket Created</h2>
      <div class="ticket-info">
        <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
        <p><strong>Subject:</strong> ${ticket.subject}</p>
        <p><strong>Category:</strong> ${ticket.category}</p>
        <p><strong>Priority:</strong> <span class="${getPriorityClass(ticket.priority)}">${ticket.priority.toUpperCase()}</span></p>
        <p><strong>Created by:</strong> ${creator.userName} (${creator.userType})</p>
        <p><strong>Client ID:</strong> ${ticket.clientId}</p>
      </div>
      <p><strong>Description:</strong></p>
      <p>${ticket.description}</p>
      <a href="${ticketUrl}" class="button">View Ticket</a>
    `;

    const textContent = `
New Support Ticket Created

Ticket ID: ${ticket.ticketId}
Subject: ${ticket.subject}
Category: ${ticket.category}
Priority: ${ticket.priority.toUpperCase()}
Created by: ${creator.userName} (${creator.userType})
Client ID: ${ticket.clientId}

Description:
${ticket.description}

View ticket: ${ticketUrl}
    `;

    await sendEmailNotification(
      adminTargets,
      `New Ticket: ${ticket.subject} [${ticket.ticketId}]`,
      buildEmailTemplate(emailContent),
      textContent
    );

  } catch (error) {
    console.error('[TICKET NOTIFICATION] Error in notifyTicketCreated:', error);
  }
}

/**
 * Notify when ticket is assigned
 */
async function notifyTicketAssigned(ticket, assignee, assignedBy) {
  try {
    console.log('[TICKET NOTIFICATION] Ticket assigned:', ticket.ticketId, 'to', assignee.userName);

    const assignedById = getUserId(assignedBy);
    const assigneeId = getUserId(assignee);
    const ticketUrl = getTicketUrl(ticket._id);

    // Notify assignee
    await createNotification({
      title: `Ticket Assigned: ${ticket.subject}`,
      message: `You have been assigned to ticket ${ticket.ticketId} by ${assignedBy.userName}. Priority: ${ticket.priority}`,
      priority: ticket.priority === 'critical' ? 'high' : 'medium',
      createdBy: assignedById,
      creatorType: assignedBy.userType,
      targetUsers: [assigneeId],
      systemAction: 'ticket_assigned',
      ticketId: ticket._id,
      metadata: {
        ticketId: ticket.ticketId,
        assignedBy: assignedBy.userName
      }
    });

    // Also notify creator if different from assignee
    const creatorId = ticket.createdBy._id || ticket.createdBy;
    if (creatorId.toString() !== assigneeId.toString()) {
      await createNotification({
        title: `Your Ticket Has Been Assigned`,
        message: `Ticket ${ticket.ticketId} has been assigned to ${assignee.userName}.`,
        priority: 'medium',
        createdBy: assignedById,
        creatorType: assignedBy.userType,
        targetUsers: [creatorId.toString()],
        systemAction: 'ticket_assigned',
        ticketId: ticket._id,
        metadata: {
          ticketId: ticket.ticketId,
          assignedTo: assignee.userName
        }
      });
    }

    // Send email to assignee
    const emailContent = `
      <h2>Ticket Assigned to You</h2>
      <p>Hi ${assignee.userName},</p>
      <p>You have been assigned to a support ticket by ${assignedBy.userName}.</p>
      <div class="ticket-info">
        <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
        <p><strong>Subject:</strong> ${ticket.subject}</p>
        <p><strong>Category:</strong> ${ticket.category}</p>
        <p><strong>Priority:</strong> <span class="${getPriorityClass(ticket.priority)}">${ticket.priority.toUpperCase()}</span></p>
        <p><strong>Status:</strong> ${ticket.status}</p>
      </div>
      <p><strong>Description:</strong></p>
      <p>${ticket.description}</p>
      <a href="${ticketUrl}" class="button">View Ticket</a>
    `;

    const textContent = `
Ticket Assigned to You

Hi ${assignee.userName},

You have been assigned to a support ticket by ${assignedBy.userName}.

Ticket ID: ${ticket.ticketId}
Subject: ${ticket.subject}
Category: ${ticket.category}
Priority: ${ticket.priority.toUpperCase()}
Status: ${ticket.status}

Description:
${ticket.description}

View ticket: ${ticketUrl}
    `;

    await sendEmailNotification(
      [assigneeId],
      `Ticket Assigned: ${ticket.subject} [${ticket.ticketId}]`,
      buildEmailTemplate(emailContent),
      textContent
    );

  } catch (error) {
    console.error('[TICKET NOTIFICATION] Error in notifyTicketAssigned:', error);
  }
}

/**
 * Notify when comment is added
 */
async function notifyTicketCommented(ticket, activity, commenter) {
  try {
    console.log('[TICKET NOTIFICATION] Comment added to:', ticket.ticketId);

    const commenterId = getUserId(commenter);
    const ticketUrl = getTicketUrl(ticket._id);

    // Don't notify for internal comments to non-support users
    const isInternal = activity.comment?.isInternal;

    // Get targets (exclude commenter)
    const targets = await getNotificationTargets(ticket, commenterId);

    if (targets.length === 0) {
      return;
    }

    // Filter targets if comment is internal
    let finalTargets = targets;
    if (isInternal) {
      const supportRoles = ['super_admin', 'consultant_admin', 'consultant'];
      const users = await User.find({
        _id: { $in: targets }
      }).select('_id userType');
      
      finalTargets = users
        .filter(u => supportRoles.includes(u.userType))
        .map(u => u._id.toString());
    }

    if (finalTargets.length === 0) {
      return;
    }

    // Create notification
    await createNotification({
      title: `New Comment on Ticket: ${ticket.subject}`,
      message: `${commenter.userName} commented on ticket ${ticket.ticketId}${isInternal ? ' (Internal)' : ''}`,
      priority: 'medium',
      createdBy: commenterId,
      creatorType: commenter.userType,
      targetUsers: finalTargets,
      systemAction: 'ticket_commented',
      ticketId: ticket._id,
      metadata: {
        ticketId: ticket.ticketId,
        isInternal
      }
    });

    // Send email (only for non-internal or to support staff)
    if (!isInternal || finalTargets.length > 0) {
      const commentText = activity.comment?.text || '';
      const truncatedComment = commentText.length > 200 
        ? commentText.substring(0, 200)  + '...' 
        : commentText;

      const emailContent = `
        <h2>New Comment on Your Ticket</h2>
        <p>${commenter.userName} added a comment${isInternal ? ' (Internal Note)' : ''}:</p>
        <div class="ticket-info">
          <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
          <p><strong>Subject:</strong> ${ticket.subject}</p>
          <p><strong>Status:</strong> ${ticket.status}</p>
        </div>
        <p><strong>Comment:</strong></p>
        <p style="background-color: white; padding: 15px; border-left: 3px solid #4CAF50;">
          ${truncatedComment}
        </p>
        <a href="${ticketUrl}" class="button">View Ticket</a>
      `;

      const textContent = `
New Comment on Your Ticket

${commenter.userName} added a comment${isInternal ? ' (Internal Note)' : ''}:

Ticket ID: ${ticket.ticketId}
Subject: ${ticket.subject}
Status: ${ticket.status}

Comment:
${commentText}

View ticket: ${ticketUrl}
      `;

      await sendEmailNotification(
        finalTargets,
        `New Comment: ${ticket.subject} [${ticket.ticketId}]`,
        buildEmailTemplate(emailContent),
        textContent
      );
    }

  } catch (error) {
    console.error('[TICKET NOTIFICATION] Error in notifyTicketCommented:', error);
  }
}

/**
 * Notify when ticket status changes
 */
async function notifyTicketStatusChanged(ticket, oldStatus, newStatus, changedBy) {
  try {
    console.log('[TICKET NOTIFICATION] Status changed:', ticket.ticketId, oldStatus, '->', newStatus);

    const changedById = getUserId(changedBy);
    const ticketUrl = getTicketUrl(ticket._id);

    // Get targets (exclude changer)
    const targets = await getNotificationTargets(ticket, changedById);

    if (targets.length === 0) {
      return;
    }

    // Create notification
    await createNotification({
      title: `Ticket Status Updated: ${ticket.subject}`,
      message: `Ticket ${ticket.ticketId} status changed from ${oldStatus} to ${newStatus} by ${changedBy.userName}`,
      priority: 'medium',
      createdBy: changedById,
      creatorType: changedBy.userType,
      targetUsers: targets,
      systemAction: 'ticket_status_changed',
      ticketId: ticket._id,
      metadata: {
        ticketId: ticket.ticketId,
        oldStatus,
        newStatus
      }
    });

    // Send email for significant status changes
    const significantChanges = ['resolved', 'closed', 'reopened', 'escalated'];
    if (significantChanges.includes(newStatus)) {
      const emailContent = `
        <h2>Ticket Status Updated</h2>
        <p>${changedBy.userName} changed the status of your ticket:</p>
        <div class="ticket-info">
          <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
          <p><strong>Subject:</strong> ${ticket.subject}</p>
          <p><strong>Previous Status:</strong> ${oldStatus}</p>
          <p><strong>New Status:</strong> <strong>${newStatus}</strong></p>
        </div>
        <a href="${ticketUrl}" class="button">View Ticket</a>
      `;

      const textContent = `
Ticket Status Updated

${changedBy.userName} changed the status of your ticket:

Ticket ID: ${ticket.ticketId}
Subject: ${ticket.subject}
Previous Status: ${oldStatus}
New Status: ${newStatus}

View ticket: ${ticketUrl}
      `;

      await sendEmailNotification(
        targets,
        `Ticket ${newStatus}: ${ticket.subject} [${ticket.ticketId}]`,
        buildEmailTemplate(emailContent),
        textContent
      );
    }

  } catch (error) {
    console.error('[TICKET NOTIFICATION] Error in notifyTicketStatusChanged:', error);
  }
}

/**
 * Notify when ticket is escalated
 */
async function notifyTicketEscalated(ticket, reason, escalatedBy) {
  try {
    console.log('[TICKET NOTIFICATION] Ticket escalated:', ticket.ticketId);

    const escalatedById = getUserId(escalatedBy);
    const ticketUrl = getTicketUrl(ticket._id);

    // Get admin targets for escalation
    const adminTargets = await getAdminTargets(ticket.clientId);
    
    // Also include ticket watchers
    const watcherTargets = await getNotificationTargets(ticket, escalatedById);
    
    // Combine and deduplicate
    const allTargets = [...new Set([...adminTargets, ...watcherTargets])];

    if (allTargets.length === 0) {
      return;
    }

    // Create notification with high priority
    await createNotification({
      title: `⚠️ Ticket Escalated: ${ticket.subject}`,
      message: `URGENT: Ticket ${ticket.ticketId} has been escalated by ${escalatedBy.userName}. Escalation Level: ${ticket.escalationLevel}. Reason: ${reason}`,
      priority: 'high',
      createdBy: escalatedById,
      creatorType: escalatedBy.userType,
      targetUsers: allTargets,
      systemAction: 'ticket_escalated',
      ticketId: ticket._id,
      metadata: {
        ticketId: ticket.ticketId,
        escalationLevel: ticket.escalationLevel,
        reason
      }
    });

    // Send urgent email
    const emailContent = `
      <h2 style="color: #f44336;">⚠️ TICKET ESCALATED</h2>
      <p><strong>A support ticket has been escalated and requires immediate attention.</strong></p>
      <div class="ticket-info">
        <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
        <p><strong>Subject:</strong> ${ticket.subject}</p>
        <p><strong>Priority:</strong> <span class="${getPriorityClass(ticket.priority)}">${ticket.priority.toUpperCase()}</span></p>
        <p><strong>Escalation Level:</strong> ${ticket.escalationLevel}</p>
        <p><strong>Escalated by:</strong> ${escalatedBy.userName}</p>
        <p><strong>Reason:</strong> ${reason || 'Not specified'}</p>
      </div>
      <a href="${ticketUrl}" class="button" style="background-color: #f44336;">View Ticket Immediately</a>
    `;

    const textContent = `
⚠️ TICKET ESCALATED - IMMEDIATE ATTENTION REQUIRED

A support ticket has been escalated and requires immediate attention.

Ticket ID: ${ticket.ticketId}
Subject: ${ticket.subject}
Priority: ${ticket.priority.toUpperCase()}
Escalation Level: ${ticket.escalationLevel}
Escalated by: ${escalatedBy.userName}
Reason: ${reason || 'Not specified'}

View ticket immediately: ${ticketUrl}
    `;

    await sendEmailNotification(
      allTargets,
      `⚠️ ESCALATED: ${ticket.subject} [${ticket.ticketId}]`,
      buildEmailTemplate(emailContent),
      textContent
    );

  } catch (error) {
    console.error('[TICKET NOTIFICATION] Error in notifyTicketEscalated:', error);
  }
}

/**
 * Notify when ticket is resolved
 */
async function notifyTicketResolved(ticket, resolvedBy) {
  try {
    console.log('[TICKET NOTIFICATION] Ticket resolved:', ticket.ticketId);

    const resolvedById = getUserId(resolvedBy);
    const ticketUrl = getTicketUrl(ticket._id);

    // Get targets (exclude resolver)
    const targets = await getNotificationTargets(ticket, resolvedById);

    if (targets.length === 0) {
      return;
    }

    // Create notification
    await createNotification({
      title: `Ticket Resolved: ${ticket.subject}`,
      message: `Your ticket ${ticket.ticketId} has been resolved by ${resolvedBy.userName}. Please review the resolution.`,
      priority: 'medium',
      createdBy: resolvedById,
      creatorType: resolvedBy.userType,
      targetUsers: targets,
      systemAction: 'ticket_resolved',
      ticketId: ticket._id,
      metadata: {
        ticketId: ticket.ticketId
      }
    });

    // Send email
    const resolutionNotes = ticket.resolution?.resolutionNotes || 'No additional notes provided.';

    const emailContent = `
      <h2>✅ Your Ticket Has Been Resolved</h2>
      <p>Good news! Your support ticket has been resolved.</p>
      <div class="ticket-info">
        <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
        <p><strong>Subject:</strong> ${ticket.subject}</p>
        <p><strong>Resolved by:</strong> ${resolvedBy.userName}</p>
        <p><strong>Resolution Date:</strong> ${new Date(ticket.resolvedAt).toLocaleString()}</p>
      </div>
      <p><strong>Resolution Notes:</strong></p>
      <p style="background-color: white; padding: 15px; border-left: 3px solid #4CAF50;">
        ${resolutionNotes}
      </p>
      <p>If you're satisfied with the resolution, you can close the ticket. If the issue persists, please reopen it.</p>
      <a href="${ticketUrl}" class="button">View & Close Ticket</a>
    `;

    const textContent = `
✅ Your Ticket Has Been Resolved

Good news! Your support ticket has been resolved.

Ticket ID: ${ticket.ticketId}
Subject: ${ticket.subject}
Resolved by: ${resolvedBy.userName}
Resolution Date: ${new Date(ticket.resolvedAt).toLocaleString()}

Resolution Notes:
${resolutionNotes}

If you're satisfied with the resolution, you can close the ticket.
If the issue persists, please reopen it.

View & Close ticket: ${ticketUrl}
    `;

    await sendEmailNotification(
      targets,
      `✅ Ticket Resolved: ${ticket.subject} [${ticket.ticketId}]`,
      buildEmailTemplate(emailContent),
      textContent
    );

  } catch (error) {
    console.error('[TICKET NOTIFICATION] Error in notifyTicketResolved:', error);
  }
}

/**
 * Notify about SLA breach or warning
 */
async function notifySLAWarning(ticket, type = 'warning') {
  try {
    console.log('[TICKET NOTIFICATION] SLA warning:', ticket.ticketId, type);

    const ticketUrl = getTicketUrl(ticket._id);

    // Get admin targets  assignee
    const adminTargets = await getAdminTargets(ticket.clientId);
    const targets = ticket.assignedTo 
      ? [...adminTargets, ticket.assignedTo.toString()]
      : adminTargets;

    const uniqueTargets = [...new Set(targets)];

    if (uniqueTargets.length === 0) {
      return;
    }

    const isBreach = type === 'breach';
    const title = isBreach 
      ? `🚨 SLA BREACHED: ${ticket.subject}`
      : `⚠️ SLA Warning: ${ticket.subject}`;

    const message = isBreach
      ? `ALERT: Ticket ${ticket.ticketId} has breached its SLA deadline. Immediate action required.`
      : `WARNING: Ticket ${ticket.ticketId} is approaching its SLA deadline (80% elapsed).`;

    // Create notification
    await createNotification({
      title,
      message,
      priority: 'high',
      createdBy: null, // System notification
      creatorType: 'super_admin',
      targetUsers: uniqueTargets,
      systemAction: isBreach ? 'ticket_sla_breach' : 'ticket_sla_warning',
      ticketId: ticket._id,
      metadata: {
        ticketId: ticket.ticketId,
        dueDate: ticket.dueDate,
        type
      }
    });

    // Send email
    const timeInfo = ticket.getTimeRemaining();
    const timeDisplay = timeInfo < 0 
      ? `Overdue by ${Math.abs(Math.round(timeInfo / (1000 * 60)))} minutes`
      : `${Math.round(timeInfo / (1000 * 60))} minutes remaining`;

    const emailContent = `
      <h2 style="color: ${isBreach ? '#f44336' : '#ff9800'};">
        ${isBreach ? '🚨 SLA BREACH ALERT' : '⚠️ SLA WARNING'}
      </h2>
      <p><strong>${message}</strong></p>
      <div class="ticket-info">
        <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
        <p><strong>Subject:</strong> ${ticket.subject}</p>
        <p><strong>Priority:</strong> <span class="${getPriorityClass(ticket.priority)}">${ticket.priority.toUpperCase()}</span></p>
        <p><strong>Status:</strong> ${ticket.status}</p>
        <p><strong>Due Date:</strong> ${new Date(ticket.dueDate).toLocaleString()}</p>
        <p><strong>Time:</strong> ${timeDisplay}</p>
      </div>
      <a href="${ticketUrl}" class="button" style="background-color: ${isBreach ? '#f44336' : '#ff9800'};">
        Take Action Now
      </a>
    `;

    const textContent = `
${isBreach ? '🚨 SLA BREACH ALERT' : '⚠️ SLA WARNING'}

${message}

Ticket ID: ${ticket.ticketId}
Subject: ${ticket.subject}
Priority: ${ticket.priority.toUpperCase()}
Status: ${ticket.status}
Due Date: ${new Date(ticket.dueDate).toLocaleString()}
Time: ${timeDisplay}

Take action now: ${ticketUrl}
    `;

    await sendEmailNotification(
      uniqueTargets,
      `${isBreach ? '🚨 SLA BREACH' : '⚠️ SLA WARNING'}: ${ticket.subject} [${ticket.ticketId}]`,
      buildEmailTemplate(emailContent),
      textContent
    );

  } catch (error) {
    console.error('[TICKET NOTIFICATION] Error in notifySLAWarning:', error);
  }
}

module.exports = {
  notifyTicketCreated,
  notifyTicketAssigned,
  notifyTicketCommented,
  notifyTicketStatusChanged,
  notifyTicketEscalated,
  notifyTicketResolved,
  notifySLAWarning
};