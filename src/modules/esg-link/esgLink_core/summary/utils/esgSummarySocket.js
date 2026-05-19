'use strict';

let io;

const setSocketIO = (socketIO) => {
  io = socketIO;
};

/**
 * Broadcast to all users subscribed to a client's ESG summary room.
 * Room: esg-summary-{clientId}
 */
const emitEsgClientEvent = (clientId, event, payload) => {
  if (!io) return;
  io.to(`esg-summary-${clientId}`).emit(event, { ...payload, clientId, timestamp: new Date() });
};

/**
 * Broadcast to a specific user's personal room.
 * Room: user_{userId}
 */
const emitEsgUserEvent = (userId, event, payload) => {
  if (!io) return;
  io.to(`user_${userId}`).emit(event, { ...payload, timestamp: new Date() });
};

/**
 * Broadcast summary-updated event after compute completes.
 */
const emitSummaryUpdated = (clientId, boundaryDocId, periodType, periodKey, totals, totalEntries) => {
  emitEsgClientEvent(clientId, 'esg:summary-updated', {
    boundaryDocId: boundaryDocId?.toString(),
    periodType,
    periodKey,
    approvedTotals: totals,
    totalEntries,
  });
};

/**
 * Broadcast when an entry moves between workflow statuses.
 * Also emits targeted events to reviewer/approver/contributor rooms.
 */
const emitWorkflowStatusChanged = (clientId, entryId, metricCode, nodeId, fromStatus, toStatus, context = {}) => {
  const { reviewerIds = [], approverIds = [], submittedBy, note } = context;

  emitEsgClientEvent(clientId, 'esg:workflow-status-changed', {
    entryId: entryId?.toString(),
    metricCode,
    nodeId,
    from: fromStatus,
    to: toStatus,
  });

  if (toStatus === 'submitted' || toStatus === 'resubmitted') {
    reviewerIds.forEach((id) =>
      emitEsgUserEvent(id.toString(), 'esg:reviewer-queue-updated', {
        entryId: entryId?.toString(),
        metricCode,
        nodeId,
        action: 'new_entry',
      })
    );
  }

  if (toStatus === 'under_review') {
    approverIds.forEach((id) =>
      emitEsgUserEvent(id.toString(), 'esg:approver-queue-updated', {
        entryId: entryId?.toString(),
        metricCode,
        nodeId,
        action: 'forwarded_to_approval',
      })
    );
  }

  if (['approved', 'rejected', 'clarification_requested'].includes(toStatus) && submittedBy) {
    emitEsgUserEvent(submittedBy.toString(), 'esg:contributor-entry-updated', {
      entryId: entryId?.toString(),
      metricCode,
      nodeId,
      newStatus: toStatus,
      note: note || null,
    });
  }
};

/**
 * Broadcast coverage/scorecard changes to admin users in the client room.
 */
const emitCoverageUpdated = (clientId, coverageSummary) => {
  emitEsgClientEvent(clientId, 'esg:coverage-updated', { coverage: coverageSummary });
};

const emitScorecardUpdated = (clientId, scorecard) => {
  emitEsgClientEvent(clientId, 'esg:scorecard-updated', { scorecard });
};

module.exports = {
  setSocketIO,
  emitEsgClientEvent,
  emitEsgUserEvent,
  emitSummaryUpdated,
  emitWorkflowStatusChanged,
  emitCoverageUpdated,
  emitScorecardUpdated,
};
