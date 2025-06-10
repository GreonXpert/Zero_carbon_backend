// utils/notificationHelper.js
const Notification = require('../models/Notification');
const User = require('../models/User');
const { emailQueue } = require('./emailQueue');

/**
 * Create system notification and send email
 * @param {Object} params - Notification parameters
 * @param {string} params.title - Notification title
 * @param {string} params.message - Notification message
 * @param {string} params.priority - Priority level (low, medium, high, urgent)
 * @param {Object} params.createdBy - User object who triggered the action
 * @param {string} params.systemAction - System action type
 * @param {Object} params.relatedEntity - Related entity (client, user, etc.)
 * @param {Array} params.targetUsers - Specific user IDs to notify
 * @param {Object} params.emailData - Email specific data
 */
const createSystemNotificationWithEmail = async (params) => {
  try {
    const {
      title,
      message,
      priority = 'medium',
      createdBy,
      systemAction,
      relatedEntity,
      targetUsers = [],
      emailData = {}
    } = params;

    // Create notification
    const notification = new Notification({
      title,
      message,
      priority,
      createdBy: createdBy.id || createdBy._id,
      creatorType: createdBy.userType,
      targetUsers,
      status: 'published',
      publishedAt: new Date(),
      isSystemNotification: true,
      systemAction,
      relatedEntity,
      autoDeleteAfterDays: 30
    });

    await notification.save();

    // Broadcast real-time notification if available
    if (global.broadcastNotification) {
      await global.broadcastNotification(notification);
    }

    // Queue email if emailData provided
    if (emailData.to && emailData.subject && emailData.template) {
      await emailQueue.add(emailData.template, emailData);
    }

    return notification;
  } catch (error) {
    console.error('Error creating system notification:', error);
    throw error;
  }
};

/**
 * Create lead action notification
 */
const createLeadActionNotification = async (action, client, user, additionalData = {}) => {
  const superAdmin = await User.findOne({ userType: 'super_admin', isActive: true });
  if (!superAdmin) return;

  const actionMessages = {
    created: 'created',
    updated: 'updated',
    deleted: 'deleted'
  };

  const title = `Lead ${actionMessages[action]}: ${client.clientId}`;
  let message = `
Lead has been ${actionMessages[action]} by ${user.userName} (${user.userType}):

• Lead ID: ${client.clientId}
• Company: ${client.leadInfo.companyName}
• Contact Person: ${client.leadInfo.contactPersonName}
• Email: ${client.leadInfo.email}
• Mobile: ${client.leadInfo.mobileNumber}
`.trim();

  if (action === 'deleted' && additionalData.reason) {
    message += `\n• Deletion Reason: ${additionalData.reason}`;
  }

  if (action === 'updated' && additionalData.updatedFields) {
    message += `\n• Updated Fields: ${additionalData.updatedFields.join(', ')}`;
  }

  await createSystemNotificationWithEmail({
    title,
    message,
    priority: action === 'deleted' ? 'high' : 'medium',
    createdBy: user,
    systemAction: `lead_${action}`,
    relatedEntity: { type: 'client', id: client._id },
    targetUsers: [superAdmin._id],
    emailData: {
      to: superAdmin.email,
      subject: `ZeroCarbon - ${title}`,
      template: 'leadActionEmail',
      ...additionalData,
      action,
      client: {
        clientId: client.clientId,
        companyName: client.leadInfo.companyName,
        contactPersonName: client.leadInfo.contactPersonName,
        email: client.leadInfo.email,
        mobileNumber: client.leadInfo.mobileNumber
      },
      performedBy: user.userName,
      performedByType: user.userType
    }
  });
};

/**
 * Create data submission notification
 */
const createDataSubmissionNotification = async (client, user) => {
  const superAdmin = await User.findOne({ userType: 'super_admin', isActive: true });
  if (!superAdmin) return;

  const title = `Client Data Submitted: ${client.clientId}`;
  const message = `
Client data has been submitted by ${user.userName} (${user.userType}):

• Client ID: ${client.clientId}
• Company: ${client.leadInfo.companyName}
• Stage: Data Submission
• Status: Submitted
• Submitted At: ${new Date().toLocaleString()}

Data completeness: ${client.calculateDataCompleteness ? client.calculateDataCompleteness() : 'N/A'}%
`.trim();

  await createSystemNotificationWithEmail({
    title,
    message,
    priority: 'medium',
    createdBy: user,
    systemAction: 'data_submitted',
    relatedEntity: { type: 'client', id: client._id },
    targetUsers: [superAdmin._id],
    emailData: {
      to: superAdmin.email,
      subject: `ZeroCarbon - ${title}`,
      template: 'dataSubmissionEmail',
      clientId: client.clientId,
      companyName: client.leadInfo.companyName,
      submittedBy: user.userName,
      dataCompleteness: client.calculateDataCompleteness ? client.calculateDataCompleteness() : 'N/A'
    }
  });
};

/**
 * Create proposal action notification
 */
const createProposalActionNotification = async (action, client, user, proposalData = {}) => {
  const superAdmin = await User.findOne({ userType: 'super_admin', isActive: true });
  if (!superAdmin) return;

  const actionTitles = {
    moved: 'Moved to Proposal Stage',
    created: 'Proposal Created',
    accepted: 'Proposal Accepted',
    rejected: 'Proposal Rejected'
  };

  const title = `${actionTitles[action]}: ${client.clientId}`;
  let message = `
${actionTitles[action]} by ${user.userName} (${user.userType}):

• Client ID: ${client.clientId}
• Company: ${client.leadInfo.companyName}
`.trim();

  if (action === 'created' && proposalData.proposalNumber) {
    message += `\n• Proposal Number: ${proposalData.proposalNumber}`;
    message += `\n• Total Amount: ₹${proposalData.totalAmount || 0}`;
    message += `\n• Data Integration Points: ${proposalData.totalDataIntegrationPoints || 0}`;
  }

  if (action === 'rejected' && proposalData.reason) {
    message += `\n• Rejection Reason: ${proposalData.reason}`;
  }

  await createSystemNotificationWithEmail({
    title,
    message,
    priority: ['accepted', 'rejected'].includes(action) ? 'high' : 'medium',
    createdBy: user,
    systemAction: `proposal_${action}`,
    relatedEntity: { type: 'client', id: client._id },
    targetUsers: [superAdmin._id],
    emailData: {
      to: superAdmin.email,
      subject: `ZeroCarbon - ${title}`,
      template: 'proposalActionEmail',
      action,
      clientId: client.clientId,
      companyName: client.leadInfo.companyName,
      performedBy: user.userName,
      ...proposalData
    }
  });
};

/**
 * Create consultant assignment notification
 */
const createConsultantAssignmentNotification = async (consultant, client, assignedBy) => {
  const title = `New Client Assignment: ${client.clientId}`;
  const message = `
You have been assigned to a new client by ${assignedBy.userName}:

• Client ID: ${client.clientId}
• Company: ${client.leadInfo.companyName}
• Contact Person: ${client.leadInfo.contactPersonName}
• Email: ${client.leadInfo.email}
• Current Stage: ${client.stage}
• Current Status: ${client.status}

Please review the client details and take appropriate action.
`.trim();

  await createSystemNotificationWithEmail({
    title,
    message,
    priority: 'high',
    createdBy: assignedBy,
    systemAction: 'consultant_assigned',
    relatedEntity: { type: 'client', id: client._id },
    targetUsers: [consultant._id],
    emailData: {
      to: consultant.email,
      subject: title,
      template: 'consultantAssignmentEmail',
      consultantName: consultant.userName,
      clientId: client.clientId,
      companyName: client.leadInfo.companyName,
      contactPersonName: client.leadInfo.contactPersonName,
      clientEmail: client.leadInfo.email,
      clientMobile: client.leadInfo.mobileNumber,
      currentStage: client.stage,
      assignedBy: assignedBy.userName
    }
  });
};

module.exports = {
  createSystemNotificationWithEmail,
  createLeadActionNotification,
  createDataSubmissionNotification,
  createProposalActionNotification,
  createConsultantAssignmentNotification
};