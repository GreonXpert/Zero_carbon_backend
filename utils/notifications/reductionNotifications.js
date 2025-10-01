// utils/notifications/reductionNotifications.js
const Notification = require('../../models/Notification');
const Client = require('../../models/Client');
const User = require('../../models/User');

/**
 * action: 'created' | 'updated' | 'deleted' | 'hard_deleted'
 * doc: the Reduction document (useful for title/message)
 */
async function notifyReductionEvent({ actor, clientId, action, doc, projectId }) {
  try {
    // find stakeholders
    const client = await Client.findOne({ clientId })
      .select('leadInfo.createdBy leadInfo.assignedConsultantId leadInfo.companyName')
      .lean();

    if (!client) return;

    const consultantAdminId = client.leadInfo?.createdBy?.toString();
    const consultantId      = client.leadInfo?.assignedConsultantId?.toString();

    const targetUsers = new Set();

    // always notify the consultant_admin for this client (unless it's the actor)
    if (consultantAdminId && consultantAdminId !== String(actor.id)) {
      targetUsers.add(consultantAdminId);
    }

    // role-specific extra target:
    // - if consultant_admin did the change → notify the assigned consultant
    // - if consultant did the change → the rule above already notified consultant_admin
    if (actor.userType === 'consultant_admin' && consultantId && consultantId !== String(actor.id)) {
      targetUsers.add(consultantId);
    }

    // NOTE: the "client" means all users under that client org → use targetClients
    const targetClients = [clientId];

    const verb =
      action === 'created' ? 'created' :
      action === 'updated' ? 'updated' :
      action === 'deleted' ? 'deleted' : 'deleted permanently';

    const prjName = doc?.projectName || 'Reduction';
    const prjId   = doc?.projectId || projectId;

    const title = `Reduction ${verb}: ${prjName}`;
    const message =
      `${actor.userName} (${actor.userType.replace(/_/g,' ')}) ${verb} a reduction\n` +
      `Client: ${clientId} (${client.leadInfo?.companyName || 'N/A'})\n` +
      `Project ID: ${prjId}`;

    const notification = new Notification({
      title,
      message,
      priority: action.includes('deleted') ? 'high' : 'medium',
      createdBy: actor.id,
      creatorType: actor.userType,
      targetUsers: Array.from(targetUsers),
      targetClients,
      status: 'published',
      isSystemNotification: true,
      systemAction: `reduction_${action}`,
      relatedEntity: {
        type: 'reduction',
        id: doc?._id || prjId
      },
      publishedAt: new Date()
    });

    await notification.save();

    // instant real-time push via Socket.IO (your index.js exposes this)
    if (global.broadcastNotification) {
      await global.broadcastNotification(notification);
    }
  } catch (err) {
    console.error('notifyReductionEvent error:', err.message);
  }
}

module.exports = { notifyReductionEvent };
