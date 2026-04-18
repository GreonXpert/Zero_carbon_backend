'use strict';

const Notification = require('../../../../../common/models/Notification/Notification');
const { EsgNotificationPreference } = require('../models/EsgNotificationPreference');

// ── Notification event → recipient role mapping ───────────────────────────────
const EVENT_RECIPIENTS = {
  submission_received:    'reviewers',
  clarification_requested: 'contributor',
  clarification_replied:  'reviewers',
  review_passed:          'approvers',
  approved:               'contributor',
  rejected:               'contributor',
};

/**
 * Send a notification for a workflow event.
 * Fire-and-forget — never throws.
 *
 * @param {string} eventType    - one of EVENT_RECIPIENTS keys
 * @param {Object} submission   - EsgDataEntry document
 * @param {Object} assignees    - { contributors, reviewers, approvers } (arrays of userId strings)
 * @param {Object} options      - { title, message, actor }
 */
async function notify(eventType, submission, assignees, options = {}) {
  try {
    const { title, message, actor } = options;
    const recipientKey = EVENT_RECIPIENTS[eventType];
    if (!recipientKey) return;

    let recipientIds = [];
    if (recipientKey === 'contributor') {
      recipientIds = submission.submittedBy ? [submission.submittedBy.toString()] : [];
    } else if (recipientKey === 'reviewers') {
      recipientIds = (assignees.reviewers || []).map((id) => id.toString());
    } else if (recipientKey === 'approvers') {
      recipientIds = (assignees.approvers || []).map((id) => id.toString());
    }

    if (!recipientIds.length) return;

    // Filter by per-user notification preferences
    const prefs = await EsgNotificationPreference.find({
      userId: { $in: recipientIds },
    });
    const prefMap = new Map(prefs.map((p) => [p.userId.toString(), p]));

    const appRecipients   = [];
    const emailRecipients = [];

    for (const uid of recipientIds) {
      const pref = prefMap.get(uid);
      const appOn   = !pref || pref.appNotifications !== false;
      const emailOn = !pref || pref.emailNotifications !== false;
      const typeOff = pref && pref.disabledTypes.includes(eventType);

      if (!typeOff && appOn)   appRecipients.push(uid);
      if (!typeOff && emailOn) emailRecipients.push(uid);
    }

    // Create in-app notification
    if (appRecipients.length) {
      const notif = new Notification({
        title:               title || _defaultTitle(eventType, submission),
        message:             message || _defaultMessage(eventType, submission),
        priority:            _priority(eventType),
        targetUsers:         appRecipients,
        targetClients:       [submission.clientId],
        status:              'published',
        isSystemNotification: true,
        systemAction:        `esg_${eventType}`,
        relatedEntity:       { type: 'EsgDataEntry', id: submission._id },
        createdByType:       'system',
      });
      await notif.save().catch((e) => console.warn('[esgDataNotificationService] notif save error:', e.message));
    }

    // Socket.IO broadcast (if io available)
    if (global.io) {
      for (const uid of appRecipients) {
        global.io.to(`user_${uid}`).emit('esg_notification', {
          eventType,
          submissionId: submission._id,
          clientId:     submission.clientId,
          mappingId:    submission.mappingId,
          title:        title || _defaultTitle(eventType, submission),
        });
      }
    }

    // Email notification (non-blocking)
    if (emailRecipients.length) {
      _sendEmailNotifications(emailRecipients, eventType, submission, title, message).catch(
        (e) => console.warn('[esgDataNotificationService] email error:', e.message)
      );
    }
  } catch (err) {
    console.error('[esgDataNotificationService.notify] Error:', err.message);
  }
}

/**
 * Send frequency reminder notification for a mapping.
 * Checks if a reminder was already sent this period before sending.
 */
async function sendFrequencyReminder(reminderType, clientId, nodeId, mappingId, periodLabel, recipientIds) {
  try {
    const EsgWorkflowAction = require('../models/EsgWorkflowAction');

    // Check spam prevention: was a reminder of this type already sent for this period?
    const alreadySent = await EsgWorkflowAction.findOne({
      clientId,
      action:   'system_reminder',
      metadata: {
        $elemMatch: { periodLabel, reminderType, nodeId, mappingId },
      },
    });

    // Alternative simpler check if $elemMatch doesn't work with mixed type
    const alreadySentAlt = await EsgWorkflowAction.findOne({
      clientId,
      action:               'system_reminder',
      'metadata.periodLabel':  periodLabel,
      'metadata.reminderType': reminderType,
      'metadata.mappingId':    mappingId,
    });

    if (alreadySent || alreadySentAlt) return;

    // Create notification
    if (recipientIds.length) {
      const notif = new Notification({
        title:               `ESG Data ${reminderType === 'due' ? 'Due' : reminderType === 'overdue' ? 'Overdue' : 'Missed'}: ${periodLabel}`,
        message:             `Data submission for mapping ${mappingId} is ${reminderType} for period ${periodLabel}.`,
        priority:            reminderType === 'missed' ? 'urgent' : reminderType === 'overdue' ? 'high' : 'medium',
        targetUsers:         recipientIds,
        targetClients:       [clientId],
        status:              'published',
        isSystemNotification: true,
        systemAction:        `esg_${reminderType}_reminder`,
        createdByType:       'system',
      });
      await notif.save().catch((e) => console.warn('[sendFrequencyReminder] save error:', e.message));
    }

    // Record that we sent this reminder
    await EsgWorkflowAction.create({
      submissionId: null,
      clientId,
      action:    'system_reminder',
      actorType: 'system',
      metadata:  { periodLabel, reminderType, nodeId, mappingId },
      createdAt: new Date(),
    }).catch(() => {});
  } catch (err) {
    console.error('[esgDataNotificationService.sendFrequencyReminder]', err.message);
  }
}

// ─── Private Helpers ──────────────────────────────────────────────────────────

function _defaultTitle(eventType, submission) {
  const map = {
    submission_received:     'New ESG Submission Awaiting Review',
    clarification_requested: 'Clarification Requested on Your Submission',
    clarification_replied:   'Contributor Replied to Your Clarification',
    review_passed:           'ESG Submission Ready for Approval',
    approved:                'Your ESG Submission Has Been Approved',
    rejected:                'Your ESG Submission Has Been Rejected',
  };
  return map[eventType] || 'ESG Submission Update';
}

function _defaultMessage(eventType, submission) {
  return `Submission ID: ${submission._id} | Mapping: ${submission.mappingId} | Period: ${submission.period?.periodLabel}`;
}

function _priority(eventType) {
  if (['rejected', 'clarification_requested'].includes(eventType)) return 'high';
  if (['approved'].includes(eventType)) return 'medium';
  return 'medium';
}

async function _sendEmailNotifications(recipientIds, eventType, submission, title, message) {
  // Uses the same email queue pattern as other modules
  // emailServiceClient is attached to global or required from a shared location
  try {
    const User = require('../../../../common/models/User');
    const users = await User.find({ _id: { $in: recipientIds } }).select('email userName');

    for (const user of users) {
      if (!user.email) continue;
      // If an emailServiceClient or nodemailer transporter is available globally, use it here
      // This is a placeholder — the actual email sending uses the project's existing emailQueue
      if (global.emailServiceClient) {
        global.emailServiceClient.sendMail({
          to:      user.email,
          subject: title || _defaultTitle(eventType, submission),
          text:    message || _defaultMessage(eventType, submission),
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.warn('[esgDataNotificationService._sendEmailNotifications]', err.message);
  }
}

module.exports = { notify, sendFrequencyReminder };
