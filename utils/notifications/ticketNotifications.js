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
 * Get frontend URL from environment
 */
const getFrontendUrl = () => {
  return process.env.FRONTEND_URL || 'https://zerocarbon.greonxpert.com';
};

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

  // 🆕 Add consultant admin if present
  if (ticket.consultantContext?.consultantAdminId) {
    const adminId = ticket.consultantContext.consultantAdminId._id || 
                   ticket.consultantContext.consultantAdminId;
    targets.add(adminId.toString());
  }

  // 🆕 Add assigned consultant if present
  if (ticket.consultantContext?.assignedConsultantId) {
    const consultantId = ticket.consultantContext.assignedConsultantId._id || 
                         ticket.consultantContext.assignedConsultantId;
    targets.add(consultantId.toString());
  }

  // Remove excluded user (typically the one performing the action)
  if (excludeUserId) {
    targets.delete(excludeUserId.toString());
  }

  return Array.from(targets);
}

/**
 * Notify support manager when a new ticket is created for their client
 */
async function notifySupportManagerNewTicket(ticket, supportManager, creator) {
  try {
    const ticketUrl = `${getFrontendUrl()}/tickets/${ticket._id}`;
    
    // Get client details
    const client = await Client.findOne({ clientId: ticket.clientId });
    
    const priorityEmoji = {
      critical: '🔴',
      high: '🟠',
      medium: '🟡',
      low: '🟢'
    };

    // Determine ticket source description
    let sourceDescription = '';
    if (ticket.consultantContext?.isConsultantIssue) {
      sourceDescription = `<p><strong>Issue Type:</strong> <span style="color: #6c63ff;">Consultant Internal Issue</span></p>`;
    } else {
      sourceDescription = `<p><strong>Client:</strong> ${client?.leadInfo?.companyName || ticket.clientId}</p>`;
    }

    // Email to support manager
    const emailSubject = `${priorityEmoji[ticket.priority]} New Ticket: ${ticket.subject}`;
    
    const emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">New Support Ticket Assigned to Your Team</h2>
        
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
          <p><strong>Subject:</strong> ${ticket.subject}</p>
          <p><strong>Priority:</strong> <span style="color: ${ticket.priority === 'critical' ? '#dc3545' : ticket.priority === 'high' ? '#ff6b6b' : ticket.priority === 'medium' ? '#ffa500' : '#28a745'};">${ticket.priority.toUpperCase()}</span></p>
          <p><strong>Category:</strong> ${ticket.category}</p>
          <p><strong>Status:</strong> ${ticket.status}</p>
          ${sourceDescription}
        </div>

        <div style="background-color: #fff; padding: 15px; border-left: 4px solid #007bff; margin: 20px 0;">
          <p><strong>Created By:</strong> ${creator?.userName || 'Unknown'} (${creator?.userType || 'Unknown'})</p>
          <p><strong>Created At:</strong> ${new Date(ticket.createdAt).toLocaleString()}</p>
          ${ticket.dueDate ? `<p><strong>Due Date:</strong> ${new Date(ticket.dueDate).toLocaleString()}</p>` : ''}
        </div>

        <div style="margin: 20px 0;">
          <p><strong>Description:</strong></p>
          <p style="background-color: #f8f9fa; padding: 15px; border-radius: 4px;">${ticket.description}</p>
        </div>

        <div style="margin: 30px 0; text-align: center;">
          <a href="${ticketUrl}" style="background-color: #007bff; color: white; padding: 12px 30px; text-decoration: none; border-radius: 4px; display: inline-block;">
            View Ticket
          </a>
        </div>

        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #dee2e6; color: #6c757d; font-size: 12px;">
          <p>This ticket requires your team's attention. Please review and assign to an appropriate support team member.</p>
        </div>
      </div>
    `;

    // Send email
    await sendMail(supportManager.email, emailSubject, emailBody);

    // Create in-app notification
    const notification = new Notification({
      userId: supportManager._id,
      type: 'ticket_assigned_to_team',
      title: `New Ticket: ${ticket.subject}`,
      message: `A new ${ticket.priority} priority ticket has been assigned to your support team`,
      relatedId: ticket._id,
      relatedModel: 'Ticket',
      metadata: {
        ticketId: ticket.ticketId,
        priority: ticket.priority,
        category: ticket.category,
        clientId: ticket.clientId,
        createdBy: creator?._id,
        isConsultantIssue: ticket.consultantContext?.isConsultantIssue || false
      }
    });

    await notification.save();

    console.log(`[NOTIFICATION] Support manager ${supportManager.userName} notified about ticket ${ticket.ticketId}`);

  } catch (error) {
    console.error('[NOTIFICATION] Error notifying support manager:', error);
    throw error;
  }
}

/**
 * 🆕 Notify consultant admin about tickets from their clients
 */
async function notifyConsultantAdminTicket(ticket, consultantAdmin, client) {
  try {
    const ticketUrl = `${getFrontendUrl()}/tickets/${ticket._id}`;
    
    const priorityEmoji = {
      critical: '🔴',
      high: '🟠',
      medium: '🟡',
      low: '🟢'
    };

    const emailSubject = `${priorityEmoji[ticket.priority]} Client Ticket Alert: ${client?.leadInfo?.companyName || ticket.clientId}`;
    
    const emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">New Ticket from Your Client</h2>
        
        <div style="background-color: #f0f7ff; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #007bff;">
          <p style="margin: 0; font-size: 14px; color: #6c757d;">Your client has raised a support ticket</p>
        </div>

        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Client:</strong> ${client?.leadInfo?.companyName || ticket.clientId}</p>
          <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
          <p><strong>Subject:</strong> ${ticket.subject}</p>
          <p><strong>Priority:</strong> <span style="color: ${ticket.priority === 'critical' ? '#dc3545' : ticket.priority === 'high' ? '#ff6b6b' : ticket.priority === 'medium' ? '#ffa500' : '#28a745'};">${ticket.priority.toUpperCase()}</span></p>
          <p><strong>Category:</strong> ${ticket.category}</p>
        </div>

        <div style="margin: 20px 0;">
          <p><strong>Description:</strong></p>
          <p style="background-color: #f8f9fa; padding: 15px; border-radius: 4px;">${ticket.description}</p>
        </div>

        ${ticket.supportManagerId ? `
        <div style="background-color: #fff; padding: 15px; border-left: 4px solid #28a745; margin: 20px 0;">
          <p style="margin: 0;"><strong>Support Team:</strong> This ticket has been assigned to the support team for resolution</p>
        </div>
        ` : ''}

        <div style="margin: 30px 0; text-align: center;">
          <a href="${ticketUrl}" style="background-color: #007bff; color: white; padding: 12px 30px; text-decoration: none; border-radius: 4px; display: inline-block;">
            View Ticket Details
          </a>
        </div>

        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #dee2e6; color: #6c757d; font-size: 12px;">
          <p>You're receiving this notification because you're the consultant admin for this client. You can track the ticket's progress in your dashboard.</p>
        </div>
      </div>
    `;

    // Send email
    await sendMail(consultantAdmin.email, emailSubject, emailBody);

    // Create in-app notification
    const notification = new Notification({
      userId: consultantAdmin._id,
      type: 'client_ticket_created',
      title: `Client Ticket: ${client?.leadInfo?.companyName || ticket.clientId}`,
      message: `Your client has raised a ${ticket.priority} priority ticket: ${ticket.subject}`,
      relatedId: ticket._id,
      relatedModel: 'Ticket',
      metadata: {
        ticketId: ticket.ticketId,
        priority: ticket.priority,
        category: ticket.category,
        clientId: ticket.clientId
      }
    });

    await notification.save();

    console.log(`[NOTIFICATION] Consultant admin ${consultantAdmin.userName} notified about client ticket ${ticket.ticketId}`);

  } catch (error) {
    console.error('[NOTIFICATION] Error notifying consultant admin:', error);
    // Don't throw - this is a supplementary notification
  }
}

/**
 * 🆕 Notify consultant about tickets from their assigned clients
 */
async function notifyConsultantTicket(ticket, consultant, client) {
  try {
    const ticketUrl = `${getFrontendUrl()}/tickets/${ticket._id}`;
    
    const priorityEmoji = {
      critical: '🔴',
      high: '🟠',
      medium: '🟡',
      low: '🟢'
    };

    const emailSubject = `${priorityEmoji[ticket.priority]} Assigned Client Ticket: ${client?.leadInfo?.companyName || ticket.clientId}`;
    
    const emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">New Ticket from Your Assigned Client</h2>
        
        <div style="background-color: #f0f7ff; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #007bff;">
          <p style="margin: 0; font-size: 14px; color: #6c757d;">A client you're managing has raised a support ticket</p>
        </div>

        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Client:</strong> ${client?.leadInfo?.companyName || ticket.clientId}</p>
          <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
          <p><strong>Subject:</strong> ${ticket.subject}</p>
          <p><strong>Priority:</strong> <span style="color: ${ticket.priority === 'critical' ? '#dc3545' : ticket.priority === 'high' ? '#ff6b6b' : ticket.priority === 'medium' ? '#ffa500' : '#28a745'};">${ticket.priority.toUpperCase()}</span></p>
          <p><strong>Category:</strong> ${ticket.category}</p>
        </div>

        <div style="margin: 20px 0;">
          <p><strong>Description:</strong></p>
          <p style="background-color: #f8f9fa; padding: 15px; border-radius: 4px;">${ticket.description}</p>
        </div>

        ${ticket.supportManagerId ? `
        <div style="background-color: #fff; padding: 15px; border-left: 4px solid #28a745; margin: 20px 0;">
          <p style="margin: 0;"><strong>Support Status:</strong> This ticket has been routed to the support team</p>
        </div>
        ` : ''}

        <div style="margin: 30px 0; text-align: center;">
          <a href="${ticketUrl}" style="background-color: #007bff; color: white; padding: 12px 30px; text-decoration: none; border-radius: 4px; display: inline-block;">
            View Ticket
          </a>
        </div>

        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #dee2e6; color: #6c757d; font-size: 12px;">
          <p>You're receiving this notification because this is one of your assigned clients. Monitor the ticket's progress and assist if needed.</p>
        </div>
      </div>
    `;

    // Send email
    await sendMail(consultant.email, emailSubject, emailBody);

    // Create in-app notification
    const notification = new Notification({
      userId: consultant._id,
      type: 'assigned_client_ticket',
      title: `Ticket from ${client?.leadInfo?.companyName || ticket.clientId}`,
      message: `Your assigned client has raised a ${ticket.priority} priority ticket: ${ticket.subject}`,
      relatedId: ticket._id,
      relatedModel: 'Ticket',
      metadata: {
        ticketId: ticket.ticketId,
        priority: ticket.priority,
        category: ticket.category,
        clientId: ticket.clientId
      }
    });

    await notification.save();

    console.log(`[NOTIFICATION] Consultant ${consultant.userName} notified about assigned client ticket ${ticket.ticketId}`);

  } catch (error) {
    console.error('[NOTIFICATION] Error notifying consultant:', error);
    // Don't throw - this is a supplementary notification
  }
}

/**
 * Notify support user when assigned to a ticket
 */
async function notifySupportUserAssigned(ticket, supportUser) {
  try {
    const ticketUrl = `${getFrontendUrl()}/tickets/${ticket._id}`;
    
    const client = await Client.findOne({ clientId: ticket.clientId });
    
    const priorityEmoji = {
      critical: '🔴',
      high: '🟠',
      medium: '🟡',
      low: '🟢'
    };

    const emailSubject = `${priorityEmoji[ticket.priority]} Ticket Assigned: ${ticket.subject}`;
    
    const emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">New Ticket Assigned to You</h2>
        
        <div style="background-color: #f0f7ff; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #007bff;">
          <p style="margin: 0; font-size: 16px;"><strong>You've been assigned a support ticket</strong></p>
        </div>

        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
          <p><strong>Subject:</strong> ${ticket.subject}</p>
          <p><strong>Priority:</strong> <span style="color: ${ticket.priority === 'critical' ? '#dc3545' : ticket.priority === 'high' ? '#ff6b6b' : ticket.priority === 'medium' ? '#ffa500' : '#28a745'};">${ticket.priority.toUpperCase()}</span></p>
          <p><strong>Category:</strong> ${ticket.category}</p>
          <p><strong>Client:</strong> ${client?.leadInfo?.companyName || ticket.clientId}</p>
          ${ticket.dueDate ? `<p><strong>Due Date:</strong> ${new Date(ticket.dueDate).toLocaleString()}</p>` : ''}
        </div>

        <div style="margin: 20px 0;">
          <p><strong>Description:</strong></p>
          <p style="background-color: #f8f9fa; padding: 15px; border-radius: 4px;">${ticket.description}</p>
        </div>

        <div style="margin: 30px 0; text-align: center;">
          <a href="${ticketUrl}" style="background-color: #007bff; color: white; padding: 12px 30px; text-decoration: none; border-radius: 4px; display: inline-block;">
            Start Working on Ticket
          </a>
        </div>

        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #dee2e6; color: #6c757d; font-size: 12px;">
          <p>Please acknowledge this ticket and begin working on it as soon as possible.</p>
        </div>
      </div>
    `;

    await sendMail(supportUser.email, emailSubject, emailBody);

    const notification = new Notification({
      userId: supportUser._id,
      type: 'ticket_assigned_to_me',
      title: `Ticket Assigned: ${ticket.subject}`,
      message: `You've been assigned a ${ticket.priority} priority ticket`,
      relatedId: ticket._id,
      relatedModel: 'Ticket',
      metadata: {
        ticketId: ticket.ticketId,
        priority: ticket.priority,
        category: ticket.category,
        clientId: ticket.clientId
      }
    });

    await notification.save();

    console.log(`[NOTIFICATION] Support user ${supportUser.userName} notified about assignment to ticket ${ticket.ticketId}`);

  } catch (error) {
    console.error('[NOTIFICATION] Error notifying support user:', error);
    throw error;
  }
}

/**
 * Notify when ticket is created (general notification)
 */
async function notifyTicketCreated(ticket, creator) {
  try {
    const targets = await getNotificationTargets(ticket, getUserId(creator));
    
    if (targets.length === 0) {
      return;
    }

    const ticketUrl = getTicketUrl(ticket._id);
    const client = await Client.findOne({ clientId: ticket.clientId });

    // Create notifications for all targets
  const notifications = targets.map(userId => ({
  createdBy: creator._id,
  creatorType: creator.userType,
  targetUsers: [userId],
  title: `New Ticket: ${ticket.subject}`,
  message: `${creator.userName} created a new ticket for ${client?.leadInfo?.companyName || ticket.clientId}`,
  priority: ticket.priority === 'critical' || ticket.priority === 'high' ? 'high' : 'medium',
  status: 'published',
  isSystemNotification: true,
  systemAction: 'ticket_created',
  relatedEntity: {
    type: 'Ticket',
    id: ticket._id
  },
  publishDate: new Date()
}));

    await Notification.insertMany(notifications);

    console.log(`[NOTIFICATION] ${notifications.length} users notified about new ticket ${ticket.ticketId}`);

  } catch (error) {
    console.error('[NOTIFICATION] Error in notifyTicketCreated:', error);
  }
}

/**
 * Notify when ticket is assigned
 */
async function notifyTicketAssigned(ticket, assignee, assigner) {
  try {
    const targets = await getNotificationTargets(ticket, getUserId(assigner));
    
    const ticketUrl = getTicketUrl(ticket._id);

    // Notify watchers
    const notifications = targets.map(userId => ({
  createdBy: assigner._id,
  creatorType: assigner.userType,
  targetUsers: [userId],
  title: `Ticket Assigned: ${ticket.subject}`,
  message: `${assigner.userName} assigned ticket ${ticket.ticketId} to ${assignee.userName}`,
  priority: 'medium',
  status: 'published',
  isSystemNotification: true,
  systemAction: 'ticket_assigned',
  relatedEntity: {
    type: 'Ticket',
    id: ticket._id
  },
  publishDate: new Date()
}));


    await Notification.insertMany(notifications);

    console.log(`[NOTIFICATION] Assignment notification sent for ticket ${ticket.ticketId}`);

  } catch (error) {
    console.error('[NOTIFICATION] Error in notifyTicketAssigned:', error);
  }
}

/**
 * Notify when ticket status changes
 */
async function notifyTicketStatusChanged(ticket, user, changes) {
  try {
    const targets = await getNotificationTargets(ticket, getUserId(user));
    
    if (targets.length === 0 || changes.length === 0) {
      return;
    }

    const ticketUrl = getTicketUrl(ticket._id);

    // Create change description
    const changeDesc = changes.map(c => `${c.field}: ${c.oldValue} → ${c.newValue}`).join(', ');

    const notifications = targets.map(userId => ({
  createdBy: updater._id,
  creatorType: updater.userType,
  targetUsers: [userId],
  title: `Ticket Status Changed: ${ticket.subject}`,
  message: `${updater.userName} changed status of ticket ${ticket.ticketId} to ${newStatus}`,
  priority: 'medium',
  status: 'published',
  isSystemNotification: true,
  systemAction: 'ticket_status_changed',
  relatedEntity: {
    type: 'Ticket',
    id: ticket._id
  },
  publishDate: new Date()
}));

    await Notification.insertMany(notifications);

    console.log(`[NOTIFICATION] Status change notification sent for ticket ${ticket.ticketId}`);

  } catch (error) {
    console.error('[NOTIFICATION] Error in notifyTicketStatusChanged:', error);
  }
}

/**
 * Notify when comment is added
 */
async function notifyTicketCommented(ticket, activity, commenter) {
  try {
    const targets = await getNotificationTargets(ticket, getUserId(commenter));
    if (targets.length === 0) return;

    let finalTargets = targets;

    // Internal comments => only notify support/supportManager/super_admin
    if (activity.comment?.isInternal) {
      const supportUsers = await User.find({
        _id: { $in: targets },
        userType: { $in: ['support', 'supportManager', 'super_admin'] }
      }).select('_id');

      const supportUserIds = supportUsers.map(u => u._id.toString());
      finalTargets = targets.filter(t => supportUserIds.includes(t));

      if (finalTargets.length === 0) return;
    }

    const ticketUrl = getTicketUrl(ticket._id);

    const notifications = finalTargets.map(userId => ({
  createdBy: commenter._id,
  creatorType: commenter.userType,
  targetUsers: [userId],
  title: `New Comment: ${ticket.subject}`,
  message: `${commenter.userName} added a comment to ticket ${ticket.ticketId}`,
  priority: activity.comment?.isInternal ? 'low' : 'medium',
  status: 'published',
  isSystemNotification: true,
  systemAction: 'ticket_commented',
  relatedEntity: {
    type: 'Ticket',
    id: ticket._id
  },
  publishDate: new Date()
}));

    await Notification.insertMany(notifications);

    // Email mentioned users (keep as-is, or optionally restrict for internal comments)
    if (activity.comment?.mentions?.length > 0) {
      for (const mentionId of activity.comment.mentions) {
        const mentionedUser = await User.findById(mentionId);
        if (mentionedUser && mentionedUser.email) {
          const emailSubject = `You were mentioned in ticket: ${ticket.subject}`;
          const emailBody = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>You were mentioned in a ticket</h2>
              <p><strong>${commenter.userName}</strong> mentioned you in a comment on ticket <strong>${ticket.ticketId}</strong></p>
              <div style="background-color: #f8f9fa; padding: 15px; border-radius: 4px; margin: 20px 0;">
                <p>${activity.comment.text}</p>
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

    console.log(`[NOTIFICATION] Comment notification sent for ticket ${ticket.ticketId}`);

  } catch (error) {
    console.error('[NOTIFICATION] Error in notifyTicketCommented:', error);
  }
}


/**
 * Notify when ticket is escalated
 */
async function notifyTicketEscalated(ticket, reason, escalatedBy) {
  try {
    const ticketUrl = getTicketUrl(ticket._id);
    
    // Get client
    const client = await Client.findOne({ clientId: ticket.clientId });

    // Notify support manager
    if (ticket.supportManagerId) {
      const supportManager = await User.findById(ticket.supportManagerId);
      if (supportManager) {
        const emailSubject = `🚨 Ticket Escalated: ${ticket.ticketId}`;
        const emailBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background-color: #ff6b6b; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
              <h2 style="margin: 0;">Ticket Escalated</h2>
            </div>
            <div style="border: 2px solid #ff6b6b; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
              <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
              <p><strong>Subject:</strong> ${ticket.subject}</p>
              <p><strong>Client:</strong> ${client?.leadInfo?.companyName || ticket.clientId}</p>
              <p><strong>Priority:</strong> ${ticket.priority.toUpperCase()}</p>
              <p><strong>Escalation Level:</strong> ${ticket.escalationLevel}</p>
              <p><strong>Reason:</strong> ${reason}</p>
              <p><strong>Escalated By:</strong> ${escalatedBy.userName || 'System'}</p>
              <div style="margin: 20px 0;">
                <a href="${ticketUrl}" style="background-color: #ff6b6b; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
                  View Ticket
                </a>
              </div>
            </div>
          </div>
        `;

        await sendMail(supportManager.email, emailSubject, emailBody);
      }
    }

    // 🆕 Notify consultant admin if client ticket
    if (client?.leadInfo?.consultantAdminId && !ticket.consultantContext?.isConsultantIssue) {
      const consultantAdmin = await User.findById(client.leadInfo.consultantAdminId);
      if (consultantAdmin) {
        const emailSubject = `🚨 Client Ticket Escalated: ${ticket.ticketId}`;
        const emailBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background-color: #ff6b6b; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
              <h2 style="margin: 0;">Client Ticket Escalated</h2>
            </div>
            <div style="border: 2px solid #ff6b6b; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
              <p>A ticket from your client has been escalated:</p>
              <p><strong>Client:</strong> ${client.leadInfo.companyName}</p>
              <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
              <p><strong>Subject:</strong> ${ticket.subject}</p>
              <p><strong>Escalation Level:</strong> ${ticket.escalationLevel}</p>
              <p><strong>Reason:</strong> ${reason}</p>
              <div style="margin: 20px 0;">
                <a href="${ticketUrl}" style="background-color: #ff6b6b; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
                  View Ticket
                </a>
              </div>
            </div>
          </div>
        `;

        await sendMail(consultantAdmin.email, emailSubject, emailBody);
      }
    }

    // Notify all watchers
    const targets = await getNotificationTargets(ticket);
    
    const notifications = targets.map(userId => ({
  createdBy: escalator._id,
  creatorType: escalator.userType,
  targetUsers: [userId],
  title: `Ticket Escalated: ${ticket.subject}`,
  message: `${escalator.userName} escalated ticket ${ticket.ticketId}. Reason: ${reason}`,
  priority: 'high',
  status: 'published',
  isSystemNotification: true,
  systemAction: 'ticket_escalated',
  relatedEntity: {
    type: 'Ticket',
    id: ticket._id
  },
  publishDate: new Date()
}));

    await Notification.insertMany(notifications);

    console.log(`[NOTIFICATION] Escalation notification sent for ticket ${ticket.ticketId}`);

  } catch (error) {
    console.error('[NOTIFICATION] Error in notifyTicketEscalated:', error);
  }
}

/**
 * Notify when ticket is resolved
 */
async function notifyTicketResolved(ticket, resolver) {
  try {
    const targets = await getNotificationTargets(ticket, getUserId(resolver));
    
    if (targets.length === 0) {
      return;
    }

    const ticketUrl = getTicketUrl(ticket._id);
    const client = await Client.findOne({ clientId: ticket.clientId });

    // Send emails to key stakeholders
    const creator = await User.findById(ticket.createdBy);
    if (creator && creator.email) {
      const emailSubject = `✅ Ticket Resolved: ${ticket.subject}`;
      const emailBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #28a745; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
            <h2 style="margin: 0;">Ticket Resolved</h2>
          </div>
          <div style="border: 2px solid #28a745; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
            <p>Your ticket has been resolved!</p>
            <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
            <p><strong>Subject:</strong> ${ticket.subject}</p>
            <p><strong>Resolved By:</strong> ${resolver.userName}</p>
            ${ticket.resolution?.resolutionNotes ? `
              <div style="background-color: #f8f9fa; padding: 15px; border-radius: 4px; margin: 20px 0;">
                <p><strong>Resolution Notes:</strong></p>
                <p>${ticket.resolution.resolutionNotes}</p>
              </div>
            ` : ''}
            <div style="margin: 20px 0;">
              <a href="${ticketUrl}" style="background-color: #28a745; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
                View Ticket & Provide Feedback
              </a>
            </div>
            <p style="font-size: 12px; color: #6c757d;">Please review the resolution and provide feedback if needed.</p>
          </div>
        </div>
      `;

      await sendMail(creator.email, emailSubject, emailBody);
    }

    // Create notifications
    const notifications = targets.map(userId => ({
  createdBy: resolver._id,
  creatorType: resolver.userType,
  targetUsers: [userId],
  title: `Ticket Resolved: ${ticket.subject}`,
  message: `${resolver.userName} resolved ticket ${ticket.ticketId}`,
  priority: 'medium',
  status: 'published',
  isSystemNotification: true,
  systemAction: 'ticket_resolved',
  relatedEntity: {
    type: 'Ticket',
    id: ticket._id
  },
  publishDate: new Date()
}));

    await Notification.insertMany(notifications);

    console.log(`[NOTIFICATION] Resolution notification sent for ticket ${ticket.ticketId}`);

  } catch (error) {
    console.error('[NOTIFICATION] Error in notifyTicketResolved:', error);
  }
}

/**
 * Notify about SLA warnings/breaches
 */
async function notifySLAWarning(ticket, type) {
  try {
    const ticketUrl = getTicketUrl(ticket._id);
    const client = await Client.findOne({ clientId: ticket.clientId });

    let emailSubject = '';
    let priority = '';
    let bgColor = '';

    if (type === 'warning') {
      emailSubject = `⚠️ SLA Warning: ${ticket.ticketId}`;
      priority = 'warning';
      bgColor = '#ffa500';
    } else {
      emailSubject = `🚨 SLA Breach: ${ticket.ticketId}`;
      priority = 'breach';
      bgColor = '#dc3545';
    }

    // Notify support manager
    if (ticket.supportManagerId) {
      const supportManager = await User.findById(ticket.supportManagerId);
      if (supportManager && supportManager.email) {
        const emailBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background-color: ${bgColor}; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
              <h2 style="margin: 0;">SLA ${type === 'warning' ? 'Warning' : 'Breach'}</h2>
            </div>
            <div style="border: 2px solid ${bgColor}; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
              <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
              <p><strong>Subject:</strong> ${ticket.subject}</p>
              <p><strong>Client:</strong> ${client?.leadInfo?.companyName || ticket.clientId}</p>
              <p><strong>Priority:</strong> ${ticket.priority.toUpperCase()}</p>
              <p><strong>Due Date:</strong> ${new Date(ticket.dueDate).toLocaleString()}</p>
              <p><strong>Status:</strong> ${ticket.status}</p>
              <div style="margin: 20px 0;">
                <a href="${ticketUrl}" style="background-color: ${bgColor}; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
                  View Ticket
                </a>
              </div>
              <p style="font-size: 12px; color: #6c757d;">
                ${type === 'warning' ? 'This ticket is approaching its SLA deadline. Please prioritize.' : 'This ticket has breached its SLA deadline. Immediate action required.'}
              </p>
            </div>
          </div>
        `;

        await sendMail(supportManager.email, emailSubject, emailBody);
      }
    }

    // Notify assignee
    if (ticket.assignedTo) {
      const assignee = await User.findById(ticket.assignedTo);
      if (assignee && assignee.email) {
        const emailBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background-color: ${bgColor}; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
              <h2 style="margin: 0;">SLA ${type === 'warning' ? 'Warning' : 'Breach'} - Action Required</h2>
            </div>
            <div style="border: 2px solid ${bgColor}; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
              <p>A ticket assigned to you ${type === 'warning' ? 'is approaching' : 'has breached'} its SLA deadline:</p>
              <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
              <p><strong>Subject:</strong> ${ticket.subject}</p>
              <p><strong>Due Date:</strong> ${new Date(ticket.dueDate).toLocaleString()}</p>
              <div style="margin: 20px 0;">
                <a href="${ticketUrl}" style="background-color: ${bgColor}; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
                  View Ticket
                </a>
              </div>
            </div>
          </div>
        `;

        await sendMail(assignee.email, emailSubject, emailBody);
      }
    }

    console.log(`[NOTIFICATION] SLA ${type} notification sent for ticket ${ticket.ticketId}`);

  } catch (error) {
    console.error('[NOTIFICATION] Error in notifySLAWarning:', error);
  }
}

module.exports = {
  notifyTicketCreated,
  notifyTicketAssigned,
  notifyTicketStatusChanged,
  notifyTicketCommented,
  notifyTicketEscalated,
  notifyTicketResolved,
  notifySupportManagerNewTicket,
  notifySupportUserAssigned,
  notifySLAWarning,
  // 🆕 New consultant notifications
  notifyConsultantAdminTicket,
  notifyConsultantTicket
};