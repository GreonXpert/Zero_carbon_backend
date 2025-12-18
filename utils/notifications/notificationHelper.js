const Notification = require("../../models/Notification/Notification");
const User = require("../../models/User");
const { sendMail } = require("../mail");

/**
 * Create a notification when a new lead is created
 * @param {String} action - 'created', 'updated', 'deleted'
 * @param {Object} client - The client/lead object
 * @param {Object} performedBy - The user who performed the action
 */
const createLeadActionNotification = async (action, client, performedBy) => {
  try {
    const superAdmin = await User.findOne({ userType: "super_admin" });
    if (!superAdmin) return;
    
    let title, message;
    
    switch (action) {
      case 'created':
        title = `New Lead Created: ${client.clientId}`;
        message = `
A new lead has been created by ${performedBy.userName}:

• Lead ID: ${client.clientId}
• Company: ${client.leadInfo.companyName}
• Contact Person: ${client.leadInfo.contactPersonName}
• Email: ${client.leadInfo.email}
• Mobile: ${client.leadInfo.mobileNumber}
• Lead Source: ${client.leadInfo.leadSource || 'Direct'}
• Created: ${new Date().toLocaleString()}
        `.trim();
        break;
        
      case 'updated':
        title = `Lead Updated: ${client.clientId}`;
        message = `
Lead ${client.clientId} has been updated by ${performedBy.userName}:

• Company: ${client.leadInfo.companyName}
• Contact Person: ${client.leadInfo.contactPersonName}
• Updated: ${new Date().toLocaleString()}
        `.trim();
        break;
        
      case 'deleted':
        title = `Lead Deleted: ${client.clientId}`;
        message = `
Lead ${client.clientId} has been deleted by ${performedBy.userName}:

• Company: ${client.leadInfo.companyName}
• Deletion Reason: ${client.leadInfo.deletionReason || 'Not specified'}
• Deleted: ${new Date().toLocaleString()}
        `.trim();
        break;
    }
    
    const notification = new Notification({
      title,
      message,
      priority: action === 'deleted' ? "high" : "medium",
      createdBy: performedBy.id,
      creatorType: performedBy.userType,
      targetUsers: [superAdmin._id],
      status: "published",
      publishedAt: new Date(),
      isSystemNotification: true,
      systemAction: `lead_${action}`,
      relatedEntity: {
        type: "client",
        id: client._id
      }
    });
    
    await notification.save();
    
    // Broadcast real-time notification if available
    if (global.broadcastNotification) {
      await global.broadcastNotification(notification);
    }
    
  } catch (error) {
    console.error(`Failed to create lead ${action} notification:`, error);
  }
};

/**
 * Create a notification when a lead moves to data submission stage
 * @param {Object} client - The client object
 * @param {Object} performedBy - The user who performed the action
 */
const createDataSubmissionNotification = async (client, performedBy) => {
  try {
    const superAdmin = await User.findOne({ userType: "super_admin" });
    
    const notification = new Notification({
      title: `Lead Moved to Data Submission: ${client.clientId}`,
      message: `
Lead has been moved to data submission stage by ${performedBy.userName}:

• Client ID: ${client.clientId}
• Company: ${client.leadInfo.companyName}
• Contact Person: ${client.leadInfo.contactPersonName}
• Email: ${client.leadInfo.email}
• Stage: Data Submission (Registered)
• Status: Pending

The client has been notified and is ready for data collection.
      `.trim(),
      priority: "medium",
      createdBy: performedBy.id,
      creatorType: performedBy.userType,
      targetUsers: superAdmin ? [superAdmin._id] : [],
      targetUserTypes: ["super_admin"],
      status: "published",
      publishedAt: new Date(),
      isSystemNotification: true,
      systemAction: "stage_changed",
      relatedEntity: {
        type: "client",
        id: client._id
      },
      autoDeleteAfterDays: 30
    });

    await notification.save();
    
    // Notify consultant's team
    const teamConsultants = await User.find({ 
      consultantAdminId: performedBy.id,
      userType: "consultant",
      isActive: true 
    });

    if (teamConsultants.length > 0) {
      const teamNotification = new Notification({
        title: `Team Update: Lead Moved to Data Submission`,
        message: `
${performedBy.userName} has moved a lead to data submission:

• Client ID: ${client.clientId}
• Company: ${client.leadInfo.companyName}

Please coordinate with your admin for next steps.
        `.trim(),
        priority: "low",
        createdBy: performedBy.id,
        creatorType: performedBy.userType,
        targetUsers: teamConsultants.map(consultant => consultant._id),
        status: "published",
        publishedAt: new Date(),
        isSystemNotification: true,
        systemAction: "stage_changed",
        relatedEntity: {
          type: "client",
          id: client._id
        },
        autoDeleteAfterDays: 14
      });

      await teamNotification.save();
    }
    
    // Broadcast real-time notifications
    if (global.broadcastNotification) {
      await global.broadcastNotification(notification);
    }
    
  } catch (error) {
    console.error("Failed to create data submission notification:", error);
  }
};

/**
 * Create a notification when a proposal action occurs
 * @param {String} action - 'created', 'accepted', 'rejected'
 * @param {Object} client - The client object
 * @param {Object} performedBy - The user who performed the action
 */
const createProposalActionNotification = async (action, client, performedBy) => {
  try {
    let title, message, targetUsers = [];
    const priority = action === 'accepted' ? "high" : "medium";
    
    // Get relevant users
    const superAdmin = await User.findOne({ userType: "super_admin" });
    const consultantAdmin = await User.findById(client.leadInfo.consultantAdminId);
    
    switch (action) {
      case 'created':
        title = `Proposal Created: ${client.clientId}`;
        message = `
A proposal has been created for client ${client.clientId}:

• Company: ${client.leadInfo.companyName}
• Proposal Number: ${client.proposalData.proposalNumber}
• Total Amount: ₹${client.proposalData.pricing.totalAmount}
• Created by: ${performedBy.userName}
        `.trim();
        targetUsers = [superAdmin?._id].filter(Boolean);
        break;
        
      case 'accepted':
        title = `Proposal Accepted: ${client.clientId}`;
        message = `
Great news! The proposal for ${client.clientId} has been accepted:

• Company: ${client.leadInfo.companyName}
• Proposal Number: ${client.proposalData.proposalNumber}
• Total Amount: ₹${client.proposalData.pricing.totalAmount}
• Client is now ACTIVE

The client admin account has been created and activated.
        `.trim();
        targetUsers = [superAdmin?._id, consultantAdmin?._id].filter(Boolean);
        break;
        
      case 'rejected':
        title = `Proposal Rejected: ${client.clientId}`;
        message = `
The proposal for ${client.clientId} has been rejected:

• Company: ${client.leadInfo.companyName}
• Proposal Number: ${client.proposalData.proposalNumber}
• Rejection Reason: ${client.proposalData.rejectionReason || 'Not specified'}

Consider following up with the client to understand their concerns.
        `.trim();
        targetUsers = [consultantAdmin?._id].filter(Boolean);
        break;
    }
    
    if (targetUsers.length > 0) {
      const notification = new Notification({
        title,
        message,
        priority,
        createdBy: performedBy.id,
        creatorType: performedBy.userType,
        targetUsers,
        status: "published",
        publishedAt: new Date(),
        isSystemNotification: true,
        systemAction: `proposal_${action}`,
        relatedEntity: {
          type: "client",
          id: client._id
        }
      });
      
      await notification.save();
      
      // Broadcast real-time notification
      if (global.broadcastNotification) {
        await global.broadcastNotification(notification);
      }
    }
    
  } catch (error) {
    console.error(`Failed to create proposal ${action} notification:`, error);
  }
};

/**
 * Create a notification when a consultant is assigned to a client
 * @param {Object} consultant - The consultant user object
 * @param {Object} client - The client object
 * @param {Object} assignedBy - The user who assigned the consultant
 */
const createConsultantAssignmentNotification = async (consultant, client, assignedBy) => {
  try {
    const notification = new Notification({
      title: `New Client Assignment`,
      message: `
You have been assigned to a new client:

• Client ID: ${client.clientId}
• Company: ${client.leadInfo.companyName}
• Contact Person: ${client.leadInfo.contactPersonName}
• Email: ${client.leadInfo.email}
• Current Stage: ${client.stage}
• Assigned by: ${assignedBy.userName}

Please review the client details and take appropriate action.
      `.trim(),
      priority: "high",
      createdBy: assignedBy.id,
      creatorType: assignedBy.userType,
      targetUsers: [consultant._id],
      status: "published",
      publishedAt: new Date(),
      isSystemNotification: true,
      systemAction: "consultant_assigned",
      relatedEntity: {
        type: "client",
        id: client._id
      }
    });
    
    await notification.save();
    
    // Broadcast real-time notification
    if (global.broadcastNotification) {
      await global.broadcastNotification(notification);
    }
    
  } catch (error) {
    console.error("Failed to create consultant assignment notification:", error);
  }
};

/**
 * Create a notification for subscription events
 * @param {String} event - 'expiring', 'expired', 'renewed', 'suspended'
 * @param {Object} client - The client object
 * @param {Object} performedBy - The user who performed the action (optional)
 */
const createSubscriptionNotification = async (event, client, performedBy = null) => {
  try {
    let title, message, priority = "medium", targetUsers = [];
    
    // Get client admin
    const clientAdmin = await User.findById(client.accountDetails.clientAdminId);
    const consultantAdmin = await User.findById(client.leadInfo.consultantAdminId);
    const superAdmin = await User.findOne({ userType: "super_admin" });
    
    switch (event) {
      case 'expiring':
        title = `Subscription Expiring Soon: ${client.clientId}`;
        message = `
Your ZeroCarbon subscription is expiring soon:

• Company: ${client.leadInfo.companyName}
• Expiry Date: ${new Date(client.accountDetails.subscriptionEndDate).toLocaleDateString()}
• Days Remaining: ${Math.ceil((new Date(client.accountDetails.subscriptionEndDate) - new Date()) / (1000 * 60 * 60 * 24))}

Please contact your consultant to renew your subscription.
        `.trim();
        priority = "high";
        targetUsers = [clientAdmin?._id, consultantAdmin?._id].filter(Boolean);
        break;
        
      case 'expired':
        title = `Subscription Expired: ${client.clientId}`;
        message = `
Your ZeroCarbon subscription has expired:

• Company: ${client.leadInfo.companyName}
• Expired On: ${new Date().toLocaleDateString()}
• Status: ${client.accountDetails.subscriptionStatus}

Your account access has been restricted. Please renew immediately.
        `.trim();
        priority = "urgent";
        targetUsers = [clientAdmin?._id, consultantAdmin?._id, superAdmin?._id].filter(Boolean);
        break;
        
      case 'renewed':
        title = `Subscription Renewed: ${client.clientId}`;
        message = `
Your ZeroCarbon subscription has been renewed successfully:

• Company: ${client.leadInfo.companyName}
• New Expiry Date: ${new Date(client.accountDetails.subscriptionEndDate).toLocaleDateString()}
• Renewed by: ${performedBy?.userName || 'System'}

Thank you for continuing with ZeroCarbon!
        `.trim();
        priority = "low";
        targetUsers = [clientAdmin?._id].filter(Boolean);
        break;
        
      case 'suspended':
        title = `Subscription Suspended: ${client.clientId}`;
        message = `
A client subscription has been suspended:

• Company: ${client.leadInfo.companyName}
• Client ID: ${client.clientId}
• Suspended by: ${performedBy?.userName || 'System'}
• Reason: ${client.accountDetails.suspensionReason || 'Not specified'}

All client users have been deactivated.
        `.trim();
        priority = "high";
        targetUsers = [superAdmin?._id, consultantAdmin?._id].filter(Boolean);
        break;
    }
    
    if (targetUsers.length > 0) {
      const notification = new Notification({
        title,
        message,
        priority,
        createdBy: performedBy?.id || superAdmin?._id,
        creatorType: performedBy?.userType || "super_admin",
        targetUsers,
        status: "published",
        publishedAt: new Date(),
        isSystemNotification: true,
        systemAction: `subscription_${event}`,
        relatedEntity: {
          type: "client",
          id: client._id
        }
      });
      
      await notification.save();
      
      // Broadcast real-time notification
      if (global.broadcastNotification) {
        await global.broadcastNotification(notification);
      }
    }
    
  } catch (error) {
    console.error(`Failed to create subscription ${event} notification:`, error);
  }
};

module.exports = {
  createLeadActionNotification,
  createDataSubmissionNotification,
  createProposalActionNotification,
  createConsultantAssignmentNotification,
  createSubscriptionNotification
};