// utils/ApiKey/apiKeyNotifications.js
const Notification = require('../../models/Notification');
const User = require('../../models/User');
const Client = require('../../models/Client');

/**
 * ✅ HELPER: Safely extract user ID from user object
 */
const getUserId = (user) => {
  if (!user) return null;
  
  if (user.id) {
    return typeof user.id === 'string' ? user.id : user.id.toString();
  }
  
  if (user._id) {
    return typeof user._id === 'string' ? user._id : user._id.toString();
  }
  
  return null;
};

/**
 * Create a notification for API key lifecycle events
 * @param {string} action - 'created', 'renewed', 'revoked', 'expired'
 * @param {Object} apiKey - The API key document
 * @param {Object} performedBy - User who performed the action
 * @param {Object} client - The client document
 */
async function createApiKeyNotification(action, apiKey, performedBy, client) {
  try {
    // ✅ FIX: Safely extract user ID
    const performedById = getUserId(performedBy);
    if (!performedById) {
      console.error('[API Key Notification] Invalid performedBy user object:', performedBy);
      return; // Skip notification if no valid user ID
    }

    let title, message, priority;
    const targetUsers = [];

    // Get relevant users
    const clientAdmin = client.accountDetails?.clientAdminId 
      ? await User.findById(client.accountDetails.clientAdminId) 
      : null;
    
    const consultantAdmin = client.leadInfo?.consultantAdminId 
      ? await User.findById(client.leadInfo.consultantAdminId) 
      : null;
    
    const assignedConsultant = client.workflowTracking?.assignedConsultantId 
      ? await User.findById(client.workflowTracking.assignedConsultantId) 
      : null;

    // Build target user list
    if (clientAdmin) targetUsers.push(clientAdmin._id);
    if (consultantAdmin) targetUsers.push(consultantAdmin._id);
    if (assignedConsultant && assignedConsultant._id.toString() !== consultantAdmin?._id.toString()) {
      targetUsers.push(assignedConsultant._id);
    }

    // Format key type for display
    const keyTypeDisplay = {
      'NET_API': 'Net Reduction API',
      'NET_IOT': 'Net Reduction IoT',
      'DC_API': 'Data Collection API',
      'DC_IOT': 'Data Collection IoT'
    }[apiKey.keyType] || apiKey.keyType;

    // Get endpoint details
    let endpointInfo = '';
    if (apiKey.keyType === 'NET_API' || apiKey.keyType === 'NET_IOT') {
      endpointInfo = `Project: ${apiKey.projectId}\nMethodology: ${apiKey.calculationMethodology}`;
    } else {
      endpointInfo = `Node: ${apiKey.nodeId}\nScope: ${apiKey.scopeIdentifier}`;
    }

    // Build message based on action
    switch (action) {
      case 'created':
        title = `New API Key Created: ${client.clientId}`;
        message = `
A new ${keyTypeDisplay} key has been created by ${performedBy.userName}:

• Client: ${client.clientId}
• Key Type: ${keyTypeDisplay}
• Key Prefix: ${apiKey.keyPrefix}***
${endpointInfo}
• Expires: ${apiKey.expiresAt.toLocaleDateString()}
• Is Sandbox: ${apiKey.isSandboxKey ? 'Yes' : 'No'}
${apiKey.description ? `• Description: ${apiKey.description}` : ''}

The key was shown only once during creation. Please ensure it has been saved securely.
        `.trim();
        priority = 'medium';
        break;

      case 'renewed':
        title = `API Key Renewed: ${client.clientId}`;
        message = `
An API key has been renewed by ${performedBy.userName}:

• Client: ${client.clientId}
• Key Type: ${keyTypeDisplay}
• New Key Prefix: ${apiKey.keyPrefix}***
${endpointInfo}
• New Expiry: ${apiKey.expiresAt.toLocaleDateString()}

The old key has been revoked. Please update your systems with the new key.
        `.trim();
        priority = 'high';
        break;

      case 'revoked':
        title = `API Key Revoked: ${client.clientId}`;
        message = `
An API key has been revoked by ${performedBy.userName}:

• Client: ${client.clientId}
• Key Type: ${keyTypeDisplay}
• Key Prefix: ${apiKey.keyPrefix}***
${endpointInfo}
• Revoked: ${apiKey.revokedAt.toLocaleString()}
${apiKey.revocationReason ? `• Reason: ${apiKey.revocationReason}` : ''}

This key can no longer be used for API access.
        `.trim();
        priority = 'high';
        break;

      case 'expired':
        title = `API Key Expired: ${client.clientId}`;
        message = `
An API key has expired:

• Client: ${client.clientId}
• Key Type: ${keyTypeDisplay}
• Key Prefix: ${apiKey.keyPrefix}***
${endpointInfo}
• Expired: ${apiKey.expiresAt.toLocaleDateString()}

Please create or renew this key to continue API access.
        `.trim();
        priority = 'urgent';
        break;
    }

    // Create notification
    if (targetUsers.length > 0) {
      const notification = new Notification({
        title,
        message,
        priority,
        createdBy: performedById, // ✅ FIX: Use extracted ID
        creatorType: performedBy.userType,
        targetUsers,
        status: 'published',
        publishedAt: new Date(),
        isSystemNotification: true,
        systemAction: `api_key_${action}`,
        relatedEntity: {
          type: 'apiKey',
          id: apiKey._id
        },
        metadata: {
          clientId: client.clientId,
          keyType: apiKey.keyType,
          keyPrefix: apiKey.keyPrefix
        }
      });

      await notification.save();

      // Broadcast real-time notification if available
      if (global.broadcastNotification) {
        await global.broadcastNotification(notification);
      }

      console.log(`[API Key] ✅ Notification sent for ${action}: ${apiKey.keyPrefix}***`);
    }

  } catch (error) {
    console.error(`[API Key] ❌ Failed to create API key ${action} notification:`, error);
  }
}

/**
 * Create expiry warning notification
 * @param {Object} apiKey 
 * @param {number} daysUntilExpiry 
 */
async function createKeyExpiryWarning(apiKey, daysUntilExpiry) {
  try {
    // Find the client
    const client = await Client.findOne({ clientId: apiKey.clientId });
    if (!client) return;

    // Get target users
    const targetUsers = [];
    
    const clientAdmin = client.accountDetails?.clientAdminId 
      ? await User.findById(client.accountDetails.clientAdminId) 
      : null;
    
    const consultantAdmin = client.leadInfo?.consultantAdminId 
      ? await User.findById(client.leadInfo.consultantAdminId) 
      : null;
    
    const assignedConsultant = client.workflowTracking?.assignedConsultantId 
      ? await User.findById(client.workflowTracking.assignedConsultantId) 
      : null;

    if (clientAdmin) targetUsers.push(clientAdmin._id);
    if (consultantAdmin) targetUsers.push(consultantAdmin._id);
    if (assignedConsultant && assignedConsultant._id.toString() !== consultantAdmin?._id.toString()) {
      targetUsers.push(assignedConsultant._id);
    }

    // ✅ FIX: Ensure we have a valid createdBy
    const createdBy = consultantAdmin?._id || clientAdmin?._id;
    if (!createdBy) {
      console.log('[API Key] No valid user found for expiry warning notification');
      return;
    }

    // Format key type
    const keyTypeDisplay = {
      'NET_API': 'Net Reduction API',
      'NET_IOT': 'Net Reduction IoT',
      'DC_API': 'Data Collection API',
      'DC_IOT': 'Data Collection IoT'
    }[apiKey.keyType] || apiKey.keyType;

    // Get endpoint details
    let endpointInfo = '';
    if (apiKey.keyType === 'NET_API' || apiKey.keyType === 'NET_IOT') {
      endpointInfo = `Project: ${apiKey.projectId}, Methodology: ${apiKey.calculationMethodology}`;
    } else {
      endpointInfo = `Node: ${apiKey.nodeId}, Scope: ${apiKey.scopeIdentifier}`;
    }

    const title = `API Key Expiring Soon: ${client.clientId}`;
    const message = `
⚠️ An API key is expiring in ${daysUntilExpiry} day${daysUntilExpiry !== 1 ? 's' : ''}:

• Client: ${client.clientId}
• Key Type: ${keyTypeDisplay}
• Key Prefix: ${apiKey.keyPrefix}***
• ${endpointInfo}
• Expires: ${apiKey.expiresAt.toLocaleDateString()}
• Last Used: ${apiKey.lastUsedAt ? apiKey.lastUsedAt.toLocaleDateString() : 'Never'}
• Usage Count: ${apiKey.usageCount}

Please renew this key to avoid service interruption.
    `.trim();

    const priority = daysUntilExpiry <= 1 ? 'urgent' : 'high';

    // Create notification
    if (targetUsers.length > 0) {
      const notification = new Notification({
        title,
        message,
        priority,
        createdBy, // ✅ FIX: Use valid createdBy
        creatorType: 'system',
        targetUsers,
        status: 'published',
        publishedAt: new Date(),
        isSystemNotification: true,
        systemAction: 'api_key_expiring',
        relatedEntity: {
          type: 'apiKey',
          id: apiKey._id
        },
        metadata: {
          clientId: client.clientId,
          keyType: apiKey.keyType,
          keyPrefix: apiKey.keyPrefix,
          daysUntilExpiry
        },
        autoDeleteAfterDays: 7
      });

      await notification.save();

      // Broadcast real-time notification if available
      if (global.broadcastNotification) {
        await global.broadcastNotification(notification);
      }

      // Mark that this warning was sent
      apiKey.expiryWarningsSent.push({
        daysBeforeExpiry: daysUntilExpiry,
        sentAt: new Date()
      });
      await apiKey.save();

      console.log(`[API Key] ✅ Expiry warning sent for ${apiKey.keyPrefix}***: ${daysUntilExpiry} days`);
    }

  } catch (error) {
    console.error('[API Key] ❌ Failed to create key expiry warning:', error);
  }
}

/**
 * Create expired notification
 * @param {Object} apiKey 
 */
async function createKeyExpiredNotification(apiKey) {
  try {
    // Mark key as expired
    await apiKey.markExpired();

    // Find the client
    const client = await Client.findOne({ clientId: apiKey.clientId });
    if (!client) return;

    // Get creator for performedBy
    const creator = await User.findById(apiKey.createdBy);

    // Use the main notification function
    await createApiKeyNotification(
      'expired', 
      apiKey, 
      creator || { 
        userName: 'System',
        id: apiKey.createdBy, // ✅ FIX: Use 'id' not '_id'
        userType: 'system' 
      }, 
      client
    );

    // Mark notification as sent
    apiKey.expiryNotificationSent = true;
    await apiKey.save();

  } catch (error) {
    console.error('[API Key] ❌ Failed to create key expired notification:', error);
  }
}

module.exports = {
  createApiKeyNotification,
  createKeyExpiryWarning,
  createKeyExpiredNotification
};