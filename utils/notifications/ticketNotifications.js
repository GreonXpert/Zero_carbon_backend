
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

  // Remove excluded user (typically the one performing the action)
  if (excludeUserId) {
    targets.delete(excludeUserId.toString());
  }

  return Array.from(targets);
}

/**
 * Notify support manager when a new ticket is created for their client
 */
async function notifySupportManagerNewTicket(ticket, supportManager) {
  try {
    const ticketUrl = `${getFrontendUrl()}/tickets/${ticket._id}`;
    
    // Get creator details
    const creator = await User.findById(ticket.createdBy).select('userName email userType');
    
    // Get client details
    const client = await Client.findOne({ clientId: ticket.clientId });
    
    const priorityEmoji = {
      critical: '🔴',
      high: '🟠',
      medium: '🟡',
      low: '🟢'
    };

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
        </div>

        <div style="background-color: #e8f4fd; padding: 15px; border-left: 4px solid #0066cc; margin: 20px 0;">
          <p><strong>Client:</strong> ${client?.leadInfo?.companyName || ticket.clientId}</p>
          <p><strong>Created By:</strong> ${creator?.userName || 'Unknown'} (${creator?.userType || 'N/A'})</p>
          <p><strong>Created At:</strong> ${new Date(ticket.createdAt).toLocaleString()}</p>
        </div>

        <div style="margin: 20px 0;">
          <p><strong>Description:</strong></p>
          <div style="background-color: #ffffff; padding: 15px; border: 1px solid #dee2e6; border-radius: 4px;">
            ${ticket.description}
          </div>
        </div>

        ${ticket.priority === 'critical' || ticket.priority === 'high' ? `
          <div style="background-color: #fff3cd; padding: 15px; border-left: 4px solid #ff6b6b; margin: 20px 0;">
            <p style="color: #856404; margin: 0;">
              ⚠️ <strong>High Priority Ticket:</strong> This ticket requires immediate attention. 
              ${ticket.priority === 'critical' ? 'SLA: First response within 1 hour, resolution within 4 hours.' : 'SLA: First response within 4 hours, resolution within 24 hours.'}
            </p>
          </div>
        ` : ''}

        <div style="margin: 30px 0; text-align: center;">
          <a href="${ticketUrl}" style="background-color: #0066cc; color: white; padding: 12px 30px; text-decoration: none; border-radius: 4px; display: inline-block;">
            View Ticket & Assign to Team Member
          </a>
        </div>

        <div style="background-color: #f8f9fa; padding: 15px; border-radius: 4px; margin: 20px 0;">
          <p style="margin: 0; font-size: 12px; color: #6c757d;">
            <strong>Next Steps:</strong>
          </p>
          <ol style="margin: 10px 0; padding-left: 20px; font-size: 12px; color: #6c757d;">
            <li>Review the ticket details and priority</li>
            <li>Assign to appropriate support team member based on specialization</li>
            <li>Ensure first response within SLA timeframe</li>
            <li>Monitor progress and escalate if needed</li>
          </ol>
        </div>

        <hr style="border: none; border-top: 1px solid #dee2e6; margin: 20px 0;">
        
        <p style="font-size: 12px; color: #6c757d; text-align: center;">
          Zero Carbon Platform - Support Team Management<br>
          This is an automated notification. Please do not reply to this email.
        </p>
      </div>
    `;

    await sendMail(supportManager.email, emailSubject, emailBody);
    
    console.log(`[NOTIFICATIONS] Support manager ${supportManager.userName} notified about ticket ${ticket.ticketId}`);
    
    // In-app notification via Socket.IO
    if (global.io) {
      global.io.to(`user_${supportManager._id}`).emit('support-ticket-assigned', {
        type: 'new_ticket_for_team',
        ticketId: ticket._id,
        ticketNumber: ticket.ticketId,
        subject: ticket.subject,
        priority: ticket.priority,
        category: ticket.category,
        clientId: ticket.clientId,
        companyName: client?.leadInfo?.companyName,
        createdBy: creator?.userName,
        createdAt: ticket.createdAt,
        message: `New ${ticket.priority} priority ticket assigned to your support team`
      });
    }

  } catch (error) {
    console.error('[NOTIFICATIONS] Error notifying support manager:', error);
  }
}

/**
 * Notify support user when ticket is assigned to them
 */
async function notifySupportUserAssigned(ticket, supportUser, assignedBy) {
  try {
    const ticketUrl = `${getFrontendUrl()}/tickets/${ticket._id}`;
    
    const client = await Client.findOne({ clientId: ticket.clientId });
    
    const emailSubject = `Ticket Assigned: ${ticket.ticketId} - ${ticket.subject}`;
    
    const emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">New Ticket Assigned to You</h2>
        
        <div style="background-color: #e8f4fd; padding: 15px; border-left: 4px solid #0066cc; margin: 20px 0;">
          <p style="margin: 0;">
            Hi ${supportUser.userName},<br><br>
            A new ticket has been assigned to you by ${assignedBy.userName}.
          </p>
        </div>

        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
          <p><strong>Subject:</strong> ${ticket.subject}</p>
          <p><strong>Priority:</strong> <span style="color: ${ticket.priority === 'critical' ? '#dc3545' : ticket.priority === 'high' ? '#ff6b6b' : '#ffa500'};">${ticket.priority.toUpperCase()}</span></p>
          <p><strong>Client:</strong> ${client?.leadInfo?.companyName || ticket.clientId}</p>
          <p><strong>Due Date:</strong> ${ticket.dueDate ? new Date(ticket.dueDate).toLocaleString() : 'Not set'}</p>
        </div>

        <div style="margin: 20px 0;">
          <p><strong>Description:</strong></p>
          <div style="background-color: #ffffff; padding: 15px; border: 1px solid #dee2e6; border-radius: 4px;">
            ${ticket.description}
          </div>
        </div>

        <div style="margin: 30px 0; text-align: center;">
          <a href="${ticketUrl}" style="background-color: #0066cc; color: white; padding: 12px 30px; text-decoration: none; border-radius: 4px; display: inline-block;">
            View & Respond to Ticket
          </a>
        </div>

        <hr style="border: none; border-top: 1px solid #dee2e6; margin: 20px 0;">
        
        <p style="font-size: 12px; color: #6c757d; text-align: center;">
          Zero Carbon Platform<br>
          This is an automated notification. Please do not reply to this email.
        </p>
      </div>
    `;

    await sendMail(supportUser.email, emailSubject, emailBody);
    
    console.log(`[NOTIFICATIONS] Support user ${supportUser.userName} notified about assigned ticket ${ticket.ticketId}`);

    // In-app notification
    if (global.io) {
      global.io.to(`user_${supportUser._id}`).emit('ticket-assigned-to-me', {
        type: 'ticket_assigned',
        ticketId: ticket._id,
        ticketNumber: ticket.ticketId,
        subject: ticket.subject,
        priority: ticket.priority,
        assignedBy: assignedBy.userName,
        dueDate: ticket.dueDate,
        message: `You have been assigned to ticket ${ticket.ticketId}`
      });
    }

  } catch (error) {
    console.error('[NOTIFICATIONS] Error notifying support user:', error);
  }
}


/**
 * Notify support manager when a ticket in their queue breaches SLA
 */
async function notifySupportManagerSLABreach(ticket) {
  try {
    const client = await Client.findOne({ clientId: ticket.clientId });
    
    if (!client?.supportSection?.assignedSupportManagerId) {
      return; // No support manager assigned
    }

    const supportManager = await User.findById(client.supportSection.assignedSupportManagerId);
    if (!supportManager) {
      return;
    }

    const ticketUrl = `${getFrontendUrl()}/tickets/${ticket._id}`;
    
    const emailSubject = `🔴 SLA BREACH ALERT: ${ticket.ticketId} - ${ticket.subject}`;
    
    const emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #dc3545; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h2 style="margin: 0;">⚠️ SLA BREACH ALERT</h2>
        </div>
        
        <div style="border: 2px solid #dc3545; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
          <p style="font-size: 16px; color: #dc3545; font-weight: bold;">
            A ticket in your support queue has breached its SLA deadline!
          </p>

          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
            <p><strong>Subject:</strong> ${ticket.subject}</p>
            <p><strong>Priority:</strong> ${ticket.priority.toUpperCase()}</p>
            <p><strong>Client:</strong> ${client?.leadInfo?.companyName || ticket.clientId}</p>
            <p><strong>Status:</strong> ${ticket.status}</p>
            <p><strong>Due Date:</strong> ${new Date(ticket.dueDate).toLocaleString()}</p>
            <p><strong>Time Overdue:</strong> ${Math.floor((Date.now() - ticket.dueDate.getTime()) / (1000 * 60 * 60))} hours</p>
          </div>

          ${ticket.assignedTo ? `
            <div style="background-color: #fff3cd; padding: 15px; border-left: 4px solid #ffc107; margin: 20px 0;">
              <p style="margin: 0;">
                <strong>Currently Assigned To:</strong> ${ticket.assignedTo.userName || 'Unknown'}
              </p>
            </div>
          ` : `
            <div style="background-color: #f8d7da; padding: 15px; border-left: 4px solid #dc3545; margin: 20px 0;">
              <p style="margin: 0; color: #721c24;">
                ⚠️ <strong>WARNING:</strong> This ticket is unassigned!
              </p>
            </div>
          `}

          <div style="margin: 30px 0; text-align: center;">
            <a href="${ticketUrl}" style="background-color: #dc3545; color: white; padding: 12px 30px; text-decoration: none; border-radius: 4px; display: inline-block;">
              View Ticket & Take Action
            </a>
          </div>

          <div style="background-color: #f8f9fa; padding: 15px; border-radius: 4px; margin: 20px 0;">
            <p style="margin: 0; font-size: 12px; color: #6c757d;">
              <strong>Recommended Actions:</strong>
            </p>
            <ul style="margin: 10px 0; padding-left: 20px; font-size: 12px; color: #6c757d;">
              <li>Escalate to senior support or management</li>
              <li>Reassign to available team member if needed</li>
              <li>Contact client to provide status update</li>
              <li>Review internal processes to prevent future breaches</li>
            </ul>
          </div>
        </div>

        <hr style="border: none; border-top: 1px solid #dee2e6; margin: 20px 0;">
        
        <p style="font-size: 12px; color: #6c757d; text-align: center;">
          Zero Carbon Platform - Automated SLA Monitoring<br>
          This is an automated notification. Please do not reply to this email.
        </p>
      </div>
    `;

    await sendMail(supportManager.email, emailSubject, emailBody);
    
    console.log(`[NOTIFICATIONS] Support manager ${supportManager.userName} notified about SLA breach for ticket ${ticket.ticketId}`);

    // Critical in-app notification
    if (global.io) {
      global.io.to(`user_${supportManager._id}`).emit('sla-breach-alert', {
        type: 'sla_breach',
        severity: 'critical',
        ticketId: ticket._id,
        ticketNumber: ticket.ticketId,
        subject: ticket.subject,
        priority: ticket.priority,
        dueDate: ticket.dueDate,
        hoursOverdue: Math.floor((Date.now() - ticket.dueDate.getTime()) / (1000 * 60 * 60)),
        message: `URGENT: Ticket ${ticket.ticketId} has breached SLA deadline`
      });
    }

  } catch (error) {
    console.error('[NOTIFICATIONS] Error notifying support manager of SLA breach:', error);
  }
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
    const ticketUrl = `${getFrontendUrl()}/tickets/${ticket._id}`;
    const client = await Client.findOne({ clientId: ticket.clientId });
    
    // Notify client admins
    const clientAdmins = await User.find({
      clientId: ticket.clientId,
      userType: 'client_admin',
      isActive: true
    });

    for (const admin of clientAdmins) {
      if (admin._id.toString() === creator._id.toString()) continue; // Skip creator

      const emailSubject = `New Ticket Created: ${ticket.ticketId}`;
      const emailBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>New Support Ticket Created</h2>
          <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
          <p><strong>Subject:</strong> ${ticket.subject}</p>
          <p><strong>Priority:</strong> ${ticket.priority.toUpperCase()}</p>
          <p><strong>Created By:</strong> ${creator.userName}</p>
          <p><strong>Category:</strong> ${ticket.category}</p>
          <div style="margin: 20px 0;">
            <a href="${ticketUrl}" style="background-color: #0066cc; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
              View Ticket
            </a>
          </div>
        </div>
      `;

      await sendMail(admin.email, emailSubject, emailBody);
    }

    // Notify consultant if assigned
    if (client?.workflowTracking?.assignedConsultantId) {
      const consultant = await User.findById(client.workflowTracking.assignedConsultantId);
      if (consultant) {
        const emailSubject = `New Ticket from ${client.leadInfo.companyName}: ${ticket.ticketId}`;
        const emailBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>New Support Ticket</h2>
            <p>A new ticket has been created by your client <strong>${client.leadInfo.companyName}</strong>.</p>
            <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
            <p><strong>Subject:</strong> ${ticket.subject}</p>
            <p><strong>Priority:</strong> ${ticket.priority.toUpperCase()}</p>
            <div style="margin: 20px 0;">
              <a href="${ticketUrl}" style="background-color: #0066cc; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
                View Ticket
              </a>
            </div>
          </div>
        `;
        await sendMail(consultant.email, emailSubject, emailBody);
      }
    }

    console.log(`[NOTIFICATIONS] Ticket created notifications sent for ${ticket.ticketId}`);

  } catch (error) {
    console.error('[NOTIFICATIONS] Error in notifyTicketCreated:', error);
  }
}


/**
 * Notify when ticket is assigned
 */
async function notifyTicketAssigned(ticket, assignee, assignedBy) {
  try {
    const ticketUrl = `${getFrontendUrl()}/tickets/${ticket._id}`;

    // Notify assignee
    const emailSubject = `Ticket Assigned to You: ${ticket.ticketId}`;
    const emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Ticket Assigned to You</h2>
        <p>Hi ${assignee.userName},</p>
        <p>A ticket has been assigned to you by ${assignedBy.userName}.</p>
        <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
        <p><strong>Subject:</strong> ${ticket.subject}</p>
        <p><strong>Priority:</strong> ${ticket.priority.toUpperCase()}</p>
        <p><strong>Due Date:</strong> ${ticket.dueDate ? new Date(ticket.dueDate).toLocaleString() : 'Not set'}</p>
        <div style="margin: 20px 0;">
          <a href="${ticketUrl}" style="background-color: #0066cc; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
            View Ticket
          </a>
        </div>
      </div>
    `;

    await sendMail(assignee.email, emailSubject, emailBody);
    console.log(`[NOTIFICATIONS] Assignment notification sent to ${assignee.userName} for ticket ${ticket.ticketId}`);

  } catch (error) {
    console.error('[NOTIFICATIONS] Error in notifyTicketAssigned:', error);
  }
}

/**
 * Notify when comment is added
 */
async function notifyTicketCommented(ticket, activity, commenter) {
  try {
    const ticketUrl = `${getFrontendUrl()}/tickets/${ticket._id}`;
    
    // Don't notify for internal comments (only support staff see these)
    if (activity.comment?.isInternal) {
      return;
    }

    // Notify watchers
    if (ticket.watchers && ticket.watchers.length > 0) {
      const watchers = await User.find({
        _id: { $in: ticket.watchers }
      });

      for (const watcher of watchers) {
        if (watcher._id.toString() === commenter._id.toString()) continue; // Skip commenter

        const emailSubject = `New Comment on Ticket: ${ticket.ticketId}`;
        const emailBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>New Comment Added</h2>
            <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
            <p><strong>Subject:</strong> ${ticket.subject}</p>
            <p><strong>Commented By:</strong> ${commenter.userName}</p>
            <div style="background-color: #f8f9fa; padding: 15px; border-radius: 4px; margin: 20px 0;">
              <p style="margin: 0;">${activity.comment.text}</p>
            </div>
            <div style="margin: 20px 0;">
              <a href="${ticketUrl}" style="background-color: #0066cc; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
                View Ticket
              </a>
            </div>
          </div>
        `;

        await sendMail(watcher.email, emailSubject, emailBody);
      }
    }

    // Notify mentioned users
    if (activity.comment?.mentions && activity.comment.mentions.length > 0) {
      const mentionedUsers = await User.find({
        _id: { $in: activity.comment.mentions }
      });

      for (const user of mentionedUsers) {
        if (user._id.toString() === commenter._id.toString()) continue; // Skip commenter

        const emailSubject = `You were mentioned in Ticket: ${ticket.ticketId}`;
        const emailBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>You Were Mentioned</h2>
            <p><strong>${commenter.userName}</strong> mentioned you in ticket <strong>${ticket.ticketId}</strong>:</p>
            <div style="background-color: #f8f9fa; padding: 15px; border-radius: 4px; margin: 20px 0;">
              <p style="margin: 0;">${activity.comment.text}</p>
            </div>
            <div style="margin: 20px 0;">
              <a href="${ticketUrl}" style="background-color: #0066cc; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
                View Ticket
              </a>
            </div>
          </div>
        `;

        await sendMail(user.email, emailSubject, emailBody);
      }
    }

    console.log(`[NOTIFICATIONS] Comment notifications sent for ticket ${ticket.ticketId}`);

  } catch (error) {
    console.error('[NOTIFICATIONS] Error in notifyTicketCommented:', error);
  }
}


/**
 * Notify when ticket status changes
 */
async function notifyTicketStatusChanged(ticket, oldStatus, newStatus, changedBy) {
  try {
    const ticketUrl = `${getFrontendUrl()}/tickets/${ticket._id}`;
    
    // Notify watchers
    if (ticket.watchers && ticket.watchers.length > 0) {
      const watchers = await User.find({
        _id: { $in: ticket.watchers }
      });

      for (const watcher of watchers) {
        if (watcher._id.toString() === changedBy._id.toString()) continue; // Skip the person who made the change

        const emailSubject = `Ticket Status Updated: ${ticket.ticketId}`;
        const emailBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Ticket Status Updated</h2>
            <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
            <p><strong>Subject:</strong> ${ticket.subject}</p>
            <p><strong>Status Changed:</strong> ${oldStatus} → ${newStatus}</p>
            <p><strong>Changed By:</strong> ${changedBy.userName}</p>
            <div style="margin: 20px 0;">
              <a href="${ticketUrl}" style="background-color: #0066cc; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
                View Ticket
              </a>
            </div>
          </div>
        `;

        await sendMail(watcher.email, emailSubject, emailBody);
      }
    }

    console.log(`[NOTIFICATIONS] Status change notifications sent for ticket ${ticket.ticketId}`);

  } catch (error) {
    console.error('[NOTIFICATIONS] Error in notifyTicketStatusChanged:', error);
  }
}

/**
 * Notify when ticket is escalated
 */
async function notifyTicketEscalated(ticket, reason, escalatedBy) {
  try {
    const ticketUrl = `${getFrontendUrl()}/tickets/${ticket._id}`;
    const client = await Client.findOne({ clientId: ticket.clientId });

    // Notify consultant admin if exists
    if (client?.leadInfo?.consultantAdminId) {
      const consultantAdmin = await User.findById(client.leadInfo.consultantAdminId);
      if (consultantAdmin) {
        const emailSubject = `🚨 Ticket Escalated: ${ticket.ticketId}`;
        const emailBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background-color: #ff6b6b; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
              <h2 style="margin: 0;">Ticket Escalated</h2>
            </div>
            <div style="border: 2px solid #ff6b6b; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
              <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
              <p><strong>Subject:</strong> ${ticket.subject}</p>
              <p><strong>Client:</strong> ${client.leadInfo.companyName}</p>
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

        await sendMail(consultantAdmin.email, emailSubject, emailBody);
      }
    }

    // 🆕 Notify support manager if ticket is from their client
    if (client?.supportSection?.assignedSupportManagerId) {
      const supportManager = await User.findById(client.supportSection.assignedSupportManagerId);
      if (supportManager) {
        const emailSubject = `🚨 Ticket Escalated: ${ticket.ticketId}`;
        const emailBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #ff6b6b;">Ticket Escalation Alert</h2>
            <p>A ticket from your assigned client has been escalated.</p>
            <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
            <p><strong>Client:</strong> ${client.leadInfo.companyName}</p>
            <p><strong>Escalation Level:</strong> ${ticket.escalationLevel}</p>
            <p><strong>Reason:</strong> ${reason}</p>
            <div style="margin: 20px 0;">
              <a href="${ticketUrl}" style="background-color: #ff6b6b; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
                Review Ticket
              </a>
            </div>
          </div>
        `;
        await sendMail(supportManager.email, emailSubject, emailBody);
      }
    }

    console.log(`[NOTIFICATIONS] Escalation notifications sent for ticket ${ticket.ticketId}`);

  } catch (error) {
    console.error('[NOTIFICATIONS] Error in notifyTicketEscalated:', error);
  }
}
/**
 * Notify when ticket is resolved
 */
async function notifyTicketResolved(ticket, resolver) {
  try {
    const ticketUrl = `${getFrontendUrl()}/tickets/${ticket._id}`;
    
    // Notify creator
    const creator = await User.findById(ticket.createdBy);
    if (creator) {
      const emailSubject = `Ticket Resolved: ${ticket.ticketId}`;
      const emailBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #28a745;">Ticket Resolved</h2>
          <p>Your ticket has been resolved!</p>
          <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
          <p><strong>Subject:</strong> ${ticket.subject}</p>
          <p><strong>Resolved By:</strong> ${resolver.userName}</p>
          ${ticket.resolution?.resolutionNotes ? `
            <div style="background-color: #f8f9fa; padding: 15px; border-radius: 4px; margin: 20px 0;">
              <p style="margin: 0;"><strong>Resolution Notes:</strong></p>
              <p>${ticket.resolution.resolutionNotes}</p>
            </div>
          ` : ''}
          <p>Please review the resolution and close the ticket if you're satisfied.</p>
          <div style="margin: 20px 0;">
            <a href="${ticketUrl}" style="background-color: #28a745; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
              View & Close Ticket
            </a>
          </div>
        </div>
      `;

      await sendMail(creator.email, emailSubject, emailBody);
    }

    console.log(`[NOTIFICATIONS] Resolution notification sent for ticket ${ticket.ticketId}`);

  } catch (error) {
    console.error('[NOTIFICATIONS] Error in notifyTicketResolved:', error);
  }
}

/**
 * Notify about SLA breach or warning
 */
async function notifySLAWarning(ticket, type = 'warning') {
  try {
    const ticketUrl = `${getFrontendUrl()}/tickets/${ticket._id}`;
    const client = await Client.findOne({ clientId: ticket.clientId });

    // Notify assignee if exists
    if (ticket.assignedTo) {
      const assignee = await User.findById(ticket.assignedTo);
      if (assignee) {
        const emailSubject = type === 'breach' 
          ? `🔴 SLA BREACH: ${ticket.ticketId}` 
          : `⚠️ SLA Warning: ${ticket.ticketId}`;
        
        const emailBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: ${type === 'breach' ? '#dc3545' : '#ffa500'};">
              ${type === 'breach' ? 'SLA Deadline Breached' : 'SLA Deadline Approaching'}
            </h2>
            <p><strong>Ticket ID:</strong> ${ticket.ticketId}</p>
            <p><strong>Subject:</strong> ${ticket.subject}</p>
            <p><strong>Priority:</strong> ${ticket.priority.toUpperCase()}</p>
            <p><strong>Due Date:</strong> ${new Date(ticket.dueDate).toLocaleString()}</p>
            ${type === 'breach' ? `
              <p style="color: #dc3545;"><strong>Status:</strong> OVERDUE</p>
            ` : `
              <p style="color: #ffa500;"><strong>Status:</strong> Due Soon (80% elapsed)</p>
            `}
            <div style="margin: 20px 0;">
              <a href="${ticketUrl}" style="background-color: ${type === 'breach' ? '#dc3545' : '#ffa500'}; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
                View Ticket
              </a>
            </div>
          </div>
        `;

        await sendMail(assignee.email, emailSubject, emailBody);
      }
    }
    // 🆕 Also notify support manager if ticket has breached SLA
    if (type === 'breach') {
      await notifySupportManagerSLABreach(ticket);
    }

    console.log(`[NOTIFICATIONS] SLA ${type} notification sent for ticket ${ticket.ticketId}`);

  } catch (error) {
    console.error('[NOTIFICATIONS] Error in notifySLAWarning:', error);
  }
}

module.exports = {
 notifyTicketCreated,
  notifyTicketAssigned,
  notifyTicketStatusChanged,
  notifyTicketCommented,
  notifyTicketEscalated,
  notifyTicketResolved,
  notifySLAWarning,
  // 🆕 NEW SUPPORT FUNCTIONS
  notifySupportManagerNewTicket,
  notifySupportUserAssigned,
  notifySupportManagerSLABreach
};