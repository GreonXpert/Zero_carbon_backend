const { sendMail } = require("../utils/mail");

/**
 * Send email to super admin when a new lead is created
 * @param {Object} lead - The lead/client object
 * @param {String} createdByName - Name of the user who created the lead
 */
const sendLeadCreatedEmail = async (lead, createdByName) => {
  try {
    const superAdminEmail = process.env.SUPER_ADMIN_EMAIL;
    
    const subject = `New Lead Created: ${lead.clientId} - ZeroCarbon`;
    const message = `
Dear Super Admin,

A new lead has been created in the ZeroCarbon system:

Lead Details:
• Lead ID: ${lead.clientId}
• Company Name: ${lead.leadInfo.companyName}
• Contact Person: ${lead.leadInfo.contactPersonName}
• Email: ${lead.leadInfo.email}
• Mobile Number: ${lead.leadInfo.mobileNumber}
• Lead Source: ${lead.leadInfo.leadSource || 'Direct'}
• Created By: ${createdByName}
• Created At: ${new Date().toLocaleString()}

Notes: ${lead.leadInfo.notes || 'No additional notes'}

You can view and manage this lead in the ZeroCarbon dashboard.

Best regards,
ZeroCarbon System
    `.trim();
    
    await sendMail(superAdminEmail, subject, message);
  } catch (error) {
    console.error("Failed to send lead created email:", error);
  }
};

/**
 * Send email when a consultant is assigned to a client
 * @param {Object} consultant - The consultant user object
 * @param {Object} client - The client object
 * @param {String} assignedByName - Name of the user who assigned
 */
const sendConsultantAssignedEmail = async (consultant, client, assignedByName) => {
  try {
    const subject = `New Client Assignment: ${client.clientId} - ZeroCarbon`;
    const message = `
Dear ${consultant.userName},

You have been assigned to a new client in the ZeroCarbon system:

Client Details:
• Client ID: ${client.clientId}
• Company Name: ${client.leadInfo.companyName}
• Contact Person: ${client.leadInfo.contactPersonName}
• Email: ${client.leadInfo.email}
• Mobile Number: ${client.leadInfo.mobileNumber}
• Current Stage: ${client.stage}
• Current Status: ${client.status}

Assignment Details:
• Assigned By: ${assignedByName}
• Assignment Date: ${new Date().toLocaleString()}

Action Required:
Please log in to the ZeroCarbon platform to review the client details and take appropriate action based on their current stage.

Best regards,
ZeroCarbon Team
    `.trim();
    
    await sendMail(consultant.email, subject, message);
  } catch (error) {
    console.error("Failed to send consultant assignment email:", error);
  }
};

/**
 * Send email when a notification requires approval
 * @param {Object} notification - The notification object
 * @param {Object} consultant - The consultant who created it
 * @param {Object} consultantAdmin - The consultant admin who needs to approve
 */
const sendNotificationApprovalEmail = async (notification, consultant, consultantAdmin) => {
  try {
    const subject = `Notification Approval Required - ZeroCarbon`;
    const message = `
Dear ${consultantAdmin.userName},

A notification created by your team member requires your approval:

Notification Details:
• Title: ${notification.title}
• Created By: ${consultant.userName} (${consultant.email})
• Priority: ${notification.priority}
• Target Clients: ${notification.targetClients.length > 0 ? notification.targetClients.join(', ') : 'All assigned clients'}
• Created At: ${new Date(notification.createdAt).toLocaleString()}

Message Preview:
${notification.message.substring(0, 300)}${notification.message.length > 300 ? '...' : ''}

Action Required:
Please log in to the ZeroCarbon platform to review and approve/reject this notification.

Best regards,
ZeroCarbon System
    `.trim();
    
    await sendMail(consultantAdmin.email, subject, message);
  } catch (error) {
    console.error("Failed to send notification approval email:", error);
  }
};

/**
 * Send email when consultant admin creates notification for clients
 * @param {Object} consultantAdmin - The consultant admin creating the notification
 * @param {Array} targetClients - Array of client IDs
 * @param {String} notificationTitle - Title of the notification
 * @param {String} notificationMessage - Message content
 */
const sendClientNotificationAlertToSuperAdmin = async (consultantAdmin, targetClients, notificationTitle, notificationMessage) => {
  try {
    const superAdminEmail = process.env.SUPER_ADMIN_EMAIL;
    const clientList = Array.isArray(targetClients) ? targetClients.join(', ') : targetClients;
    
    const subject = `Consultant Admin Created Client Notification - ZeroCarbon`;
    const message = `
Dear Super Admin,

A Consultant Admin has created a notification for clients:

Created By:
• Name: ${consultantAdmin.userName}
• Email: ${consultantAdmin.email}
• User Type: Consultant Admin

Notification Details:
• Title: ${notificationTitle}
• Target Clients: ${clientList}
• Created At: ${new Date().toLocaleString()}
• Scheduled Publication: ${new Date(Date.now() + 30 * 60 * 1000).toLocaleString()} (30 minutes from creation)

Message Content:
${notificationMessage}

Important Note:
This notification will be automatically published in 30 minutes. You have the ability to cancel this notification from the ZeroCarbon dashboard if needed.

Best regards,
ZeroCarbon System
    `.trim();
    
    await sendMail(superAdminEmail, subject, message);
  } catch (error) {
    console.error("Failed to send client notification alert to super admin:", error);
  }
};

/**
 * Send notification status update emails
 * @param {String} status - 'approved', 'rejected', 'cancelled'
 * @param {Object} notification - The notification object
 * @param {Object} recipient - The recipient user object
 * @param {Object} performedBy - The user who performed the action
 * @param {String} reason - Reason for rejection/cancellation (optional)
 */
const sendNotificationStatusEmail = async (status, notification, recipient, performedBy, reason = null) => {
  try {
    let subject, message;
    
    switch (status) {
      case 'approved':
        subject = `Notification Approved - ZeroCarbon`;
        message = `
Dear ${recipient.userName},

Your notification has been approved:

Notification Details:
• Title: ${notification.title}
• Approved By: ${performedBy.userName}
• Approval Date: ${new Date().toLocaleString()}
• Scheduled Publication: ${new Date(notification.scheduledPublishDate).toLocaleString()}

Your notification will be automatically published at the scheduled time.

Best regards,
ZeroCarbon Team
        `.trim();
        break;
        
      case 'rejected':
        subject = `Notification Rejected - ZeroCarbon`;
        message = `
Dear ${recipient.userName},

Your notification has been rejected:

Notification Details:
• Title: ${notification.title}
• Rejected By: ${performedBy.userName}
• Rejection Date: ${new Date().toLocaleString()}
• Reason: ${reason || 'No specific reason provided'}

You may create a new notification after addressing the concerns mentioned above.

Best regards,
ZeroCarbon Team
        `.trim();
        break;
        
      case 'cancelled':
        subject = `Notification Cancelled - ZeroCarbon`;
        message = `
Dear ${recipient.userName},

Your scheduled notification has been cancelled:

Notification Details:
• Title: ${notification.title}
• Cancelled By: ${performedBy.userName} (${performedBy.userType.replace(/_/g, ' ')})
• Cancellation Date: ${new Date().toLocaleString()}
• Original Scheduled Time: ${new Date(notification.scheduledPublishDate).toLocaleString()}

If you believe this was done in error, please contact your administrator.

Best regards,
ZeroCarbon Team
        `.trim();
        break;
    }
    
    await sendMail(recipient.email, subject, message);
  } catch (error) {
    console.error(`Failed to send notification ${status} email:`, error);
  }
};

/**
 * Send subscription reminder emails
 * @param {String} reminderType - 'expiring_soon', 'expired', 'grace_period'
 * @param {Object} client - The client object
 * @param {Object} clientAdmin - The client admin user object
 * @param {Number} daysRemaining - Days until expiry (for expiring_soon)
 */
const sendSubscriptionReminderEmail = async (reminderType, client, clientAdmin, daysRemaining = null) => {
  try {
    let subject, message;
    
    switch (reminderType) {
      case 'expiring_soon':
        subject = `Subscription Expiring Soon - ZeroCarbon`;
        message = `
Dear ${clientAdmin.userName},

Your ZeroCarbon subscription is expiring soon:

Subscription Details:
• Company: ${client.leadInfo.companyName}
• Client ID: ${client.clientId}
• Expiry Date: ${new Date(client.accountDetails.subscriptionEndDate).toLocaleDateString()}
• Days Remaining: ${daysRemaining}

Action Required:
Please contact your consultant to renew your subscription and ensure uninterrupted access to ZeroCarbon services.

Renewal Benefits:
• Continuous access to all features
• Historical data preservation
• Uninterrupted carbon tracking
• Priority support

Best regards,
ZeroCarbon Team
        `.trim();
        break;
        
      case 'expired':
        subject = `Subscription Expired - ZeroCarbon`;
        message = `
Dear ${clientAdmin.userName},

Your ZeroCarbon subscription has expired:

Subscription Details:
• Company: ${client.leadInfo.companyName}
• Client ID: ${client.clientId}
• Expired On: ${new Date(client.accountDetails.subscriptionEndDate).toLocaleDateString()}

Impact:
• Your account access has been restricted
• Data entry and reporting features are disabled
• User accounts under your organization are deactivated

Action Required:
Please contact your consultant immediately to renew your subscription and restore access.

Best regards,
ZeroCarbon Team
        `.trim();
        break;
        
      case 'grace_period':
        subject = `Subscription Grace Period - ZeroCarbon`;
        message = `
Dear ${clientAdmin.userName},

Your ZeroCarbon subscription has expired and you are now in the grace period:

Subscription Details:
• Company: ${client.leadInfo.companyName}
• Client ID: ${client.clientId}
• Grace Period Ends: ${new Date(new Date(client.accountDetails.subscriptionEndDate).getTime() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString()}

Important:
You have 30 days to renew your subscription. After the grace period ends, your account and all associated data may be permanently suspended.

Action Required:
Contact your consultant today to renew your subscription and avoid service interruption.

Best regards,
ZeroCarbon Team
        `.trim();
        break;
    }
    
    await sendMail(clientAdmin.email, subject, message);
  } catch (error) {
    console.error(`Failed to send subscription ${reminderType} email:`, error);
  }
};

module.exports = {
  sendLeadCreatedEmail,
  sendConsultantAssignedEmail,
  sendNotificationApprovalEmail,
  sendClientNotificationAlertToSuperAdmin,
  sendNotificationStatusEmail,
  sendSubscriptionReminderEmail
};