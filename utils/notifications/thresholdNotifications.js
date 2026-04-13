// utils/notifications/thresholdNotifications.js
const Notification = require("../../models/Notification/Notification");
const Client = require("../../models/CMS/Client");

/**
 * Sends a high-priority notification to the consultant_admin of the client
 * when an anomalous data entry is intercepted and held for approval.
 *
 * Follows the exact Notification.create() pattern used throughout the project
 * (see netReductionController.js createSystemNotification helper).
 *
 * @param {object} params
 * @param {string}   params.clientId
 * @param {string}   params.scopeIdentifier   - scope or projectId label
 * @param {ObjectId} params.pendingApprovalId - PendingApproval._id
 * @param {number}   params.normalizedValue   - Incoming daily-normalized value
 * @param {number}   params.historicalAverage - Historical daily-normalized average
 * @param {number}   params.deviationPct      - Computed deviation %
 * @param {number}   params.thresholdPct      - Configured threshold %
 * @param {string}   params.frequency         - Detected collection frequency
 * @param {string}   params.inputType         - 'manual' | 'API' | 'IOT' | 'OCR'
 * @param {string}   params.flowType          - 'dataEntry' | 'netReduction'
 * @param {ObjectId} params.submittedBy       - User._id who submitted the entry
 * @param {string}   params.submittedByType   - userType of submitter
 * @returns {Promise<Notification|null>}
 */
async function notifyConsultantAdminOfAnomaly({
  clientId,
  scopeIdentifier,
  pendingApprovalId,
  normalizedValue,
  historicalAverage,
  deviationPct,
  thresholdPct,
  frequency,
  inputType,
  flowType,
  submittedBy,
  submittedByType
}) {
  try {
    const client = await Client.findOne({ clientId })
      .select("leadInfo.consultantAdminId leadInfo.companyName")
      .lean();

    const consultantAdminId = client?.leadInfo?.consultantAdminId;
    if (!consultantAdminId) return null;

    const companyName = client?.leadInfo?.companyName || clientId;
    const flowLabel = flowType === "netReduction" ? "Net Reduction" : "Data Entry";

    const title = `Anomaly Detected — ${flowLabel} Approval Required`;

    const message =
      `Unusual ${inputType?.toUpperCase() || "MANUAL"} data submitted for client ${companyName} (${clientId}).\n` +
      `Scope / Identifier: ${scopeIdentifier}\n` +
      `Incoming daily value: ${Number(normalizedValue).toFixed(4)}\n` +
      `Historical average (daily): ${Number(historicalAverage).toFixed(4)}\n` +
      `Deviation: ${Number(deviationPct).toFixed(2)}% (threshold: ${thresholdPct}%)\n` +
      `Frequency: ${frequency}\n` +
      `Please review and approve or reject this entry.`;

    const notification = await Notification.create({
      title,
      message,
      targetUsers: [consultantAdminId],
      targetClients: [clientId],
      priority: "high",
      createdBy: submittedBy,
      creatorType: submittedByType,
      systemAction: "anomaly_detected",
      isSystemNotification: true,
      status: "published",
      publishedAt: new Date(),
      relatedEntity: {
        type: "PendingApproval",
        id: pendingApprovalId
      }
    });

    return notification;
  } catch (err) {
    // Non-fatal — log but don't block the response
    console.error("[thresholdNotifications] Failed to send anomaly notification:", err.message);
    return null;
  }
}

/**
 * Notifies the original data submitter about the outcome of their pending approval.
 *
 * @param {object} params
 * @param {string}   params.clientId
 * @param {string}   params.scopeIdentifier
 * @param {ObjectId} params.submittedBy     - original submitter User._id
 * @param {string}   params.submittedByType
 * @param {ObjectId} params.reviewedBy      - consultant_admin User._id
 * @param {string}   params.reviewedByType
 * @param {'Approved'|'Rejected'} params.outcome
 * @param {string}   [params.rejectionReason]
 * @param {string}   params.flowType
 * @param {ObjectId} params.pendingApprovalId
 * @returns {Promise<Notification|null>}
 */
async function notifySubmitterOfOutcome({
  clientId,
  scopeIdentifier,
  submittedBy,
  submittedByType,
  reviewedBy,
  reviewedByType,
  outcome,
  rejectionReason,
  flowType,
  pendingApprovalId
}) {
  try {
    const flowLabel = flowType === "netReduction" ? "Net Reduction" : "Data Entry";
    const isApproved = outcome === "Approved";

    const title = isApproved
      ? `Your ${flowLabel} Entry Has Been Approved`
      : `Your ${flowLabel} Entry Was Rejected`;

    let message = isApproved
      ? `Your data entry for scope/identifier "${scopeIdentifier}" (client: ${clientId}) has been reviewed and approved. The entry has been saved successfully.`
      : `Your data entry for scope/identifier "${scopeIdentifier}" (client: ${clientId}) has been reviewed and rejected.`;

    if (!isApproved && rejectionReason) {
      message += `\nReason: ${rejectionReason}`;
    }

    const notification = await Notification.create({
      title,
      message,
      targetUsers: [submittedBy],
      targetClients: [clientId],
      priority: isApproved ? "medium" : "high",
      createdBy: reviewedBy,
      creatorType: reviewedByType,
      systemAction: isApproved ? "anomaly_approved" : "anomaly_rejected",
      isSystemNotification: true,
      status: "published",
      publishedAt: new Date(),
      relatedEntity: {
        type: "PendingApproval",
        id: pendingApprovalId
      }
    });

    return notification;
  } catch (err) {
    console.error("[thresholdNotifications] Failed to send outcome notification:", err.message);
    return null;
  }
}

module.exports = {
  notifyConsultantAdminOfAnomaly,
  notifySubmitterOfOutcome
};
