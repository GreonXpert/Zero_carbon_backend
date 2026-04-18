'use strict';

const cron = require('node-cron');

const EsgLinkBoundary = require('../../boundary/models/EsgLinkBoundary');
const EsgDataEntry    = require('../../data-collection/models/EsgDataEntry');
const { classifyReminder, getCurrentWindowForFrequency } = require('../../data-collection/utils/esgFrequencyHelper');
const { sendFrequencyReminder } = require('../../data-collection/services/esgDataNotificationService');

/**
 * For each active ESG Link mapping across all clients, check whether data
 * has been submitted/approved for the current period.  If missing, classify
 * the reminder type and send once per period (spam prevention is inside
 * sendFrequencyReminder via EsgWorkflowAction system_reminder records).
 */
async function checkEsgDataFrequencyAndNotify() {
  try {
    const boundaries = await EsgLinkBoundary.find({ isDeleted: { $ne: true } })
      .select('clientId nodes')
      .lean();

    const now = new Date();

    for (const boundary of boundaries) {
      const clientId = boundary.clientId;
      const nodes    = boundary.nodes || [];

      for (const node of nodes) {
        const mappings = node.metricsDetails || [];

        for (const mapping of mappings) {
          const mappingId = mapping._id?.toString();
          if (!mappingId) continue;

          const frequency = mapping.frequency || 'monthly';
          const window    = getCurrentWindowForFrequency(frequency, now);
          if (!window) continue;

          const { periodLabel, start: windowStart } = window;

          // ── Check existing entry ────────────────────────────────────────────
          const existing = await EsgDataEntry.findOne({
            clientId,
            nodeId:              node.id || node._id?.toString(),
            mappingId,
            'period.periodLabel': periodLabel,
            isDeleted:           { $ne: true },
          })
            .select('workflowStatus submittedAt submittedBy createdAt')
            .lean();

          const lastApprovedAt = existing?.workflowStatus === 'approved'
            ? existing.createdAt
            : null;
          const lastSubmittedAt = existing ? existing.submittedAt || existing.createdAt : null;

          const reminderType = classifyReminder(frequency, lastApprovedAt, lastSubmittedAt, now);
          if (!reminderType) continue; // null → no reminder needed

          // ── Resolve contributor IDs ─────────────────────────────────────────
          const contributorIds = (mapping.contributors || []).map((id) => id.toString());
          const reviewerIds    = (mapping.reviewers    || []).map((id) => id.toString());

          let recipientIds = contributorIds;
          if (reminderType === 'overdue' || reminderType === 'missed') {
            recipientIds = [...new Set([...contributorIds, ...reviewerIds])];
          }

          if (!recipientIds.length) continue;

          await sendFrequencyReminder(
            reminderType,
            clientId,
            node.id || node._id?.toString(),
            mappingId,
            periodLabel,
            recipientIds
          );
        }
      }
    }
  } catch (err) {
    console.error('[esgDataFrequencyChecker] Error:', err.message);
  }
}

/**
 * Registers the daily ESG data frequency reminder cron (07:00 UTC).
 */
function startEsgDataFrequencyChecker() {
  cron.schedule('0 7 * * *', () => {
    console.log('[ESG] Running ESG data frequency reminder check...');
    checkEsgDataFrequencyAndNotify();
  });

  console.log('[ESG] ESG data frequency checker scheduled at 07:00 UTC daily');
}

module.exports = { startEsgDataFrequencyChecker, checkEsgDataFrequencyAndNotify };
