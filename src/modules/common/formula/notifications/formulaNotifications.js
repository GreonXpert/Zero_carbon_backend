'use strict';

/**
 * formulaNotifications.js (common)
 * Notification helpers for the common formula module.
 * Supports both zero_carbon and esg_link module formulas.
 *
 * Moved from: src/modules/zero-carbon/workflow/notifications/formulaNotifications.js
 * Old file is now a re-export pointing here.
 */

const Notification = require('../../../../common/models/Notification/Notification');
const User = require('../../../../common/models/User');

/**
 * Notify consultant_admin + super_admin when a consultant requests formula deletion.
 */
async function notifyFormulaDeleteRequested({ actor, formula, approverIds }) {
  try {
    const title = 'Formula Delete Request Submitted';
    const message =
      `${actor.userName} (${actor.userType.replace(/_/g, ' ')}) requested to delete formula: ${formula.name}`;

    const notif = new Notification({
      title,
      message,
      priority: 'medium',
      createdBy: actor.id,
      creatorType: actor.userType,
      targetUsers: approverIds,
      targetClients: [],
      status: 'published',
      isSystemNotification: true,
      systemAction: 'formula_delete_requested',
      relatedEntity: {
        type: 'formula',
        id: formula._id
      },
      publishedAt: new Date()
    });

    await notif.save();

    if (global.broadcastNotification) {
      await global.broadcastNotification(notif);
    }
  } catch (err) {
    console.error('notifyFormulaDeleteRequested error:', err.message);
  }
}

/**
 * Notify the requesting consultant when their delete request is approved.
 */
async function notifyFormulaDeleteApproved({ actor, formula, request }) {
  try {
    const title = 'Formula Delete Request Approved';
    const message =
      `${actor.userName} (${actor.userType.replace(/_/g, ' ')}) approved deletion of formula: ${formula.name}`;

    const notif = new Notification({
      title,
      message,
      priority: 'high',
      createdBy: actor.id,
      creatorType: actor.userType,
      targetUsers: [request.requestedBy],
      targetClients: [],
      status: 'published',
      isSystemNotification: true,
      systemAction: 'formula_delete_approved',
      relatedEntity: {
        type: 'formula',
        id: formula._id
      },
      publishedAt: new Date()
    });

    await notif.save();

    if (global.broadcastNotification) {
      await global.broadcastNotification(notif);
    }
  } catch (err) {
    console.error('notifyFormulaDeleteApproved error:', err.message);
  }
}

/**
 * Notify the requesting consultant when their delete request is rejected.
 */
async function notifyFormulaDeleteRejected({ actor, formula, request }) {
  try {
    const title = 'Formula Delete Request Rejected';
    const message =
      `${actor.userName} (${actor.userType.replace(/_/g, ' ')}) rejected deletion request for formula: ${formula.name}`;

    const notif = new Notification({
      title,
      message,
      priority: 'medium',
      createdBy: actor.id,
      creatorType: actor.userType,
      targetUsers: [request.requestedBy],
      targetClients: [],
      status: 'published',
      isSystemNotification: true,
      systemAction: 'formula_delete_rejected',
      relatedEntity: {
        type: 'formula',
        id: formula._id
      },
      publishedAt: new Date()
    });

    await notif.save();

    if (global.broadcastNotification) {
      await global.broadcastNotification(notif);
    }
  } catch (err) {
    console.error('notifyFormulaDeleteRejected error:', err.message);
  }
}

module.exports = {
  notifyFormulaDeleteRequested,
  notifyFormulaDeleteApproved,
  notifyFormulaDeleteRejected
};
