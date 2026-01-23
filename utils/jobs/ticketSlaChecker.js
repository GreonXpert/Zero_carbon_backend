// utils/jobs/ticketSlaChecker.js
const cron = require('node-cron');
const { Ticket } = require('../../models/Ticket/Ticket');
const { notifySLAWarning } = require('../notifications/ticketNotifications');

/**
 * SLA Configuration
 * Defines response and resolution times for each priority level
 */
const SLA_CONFIG = {
  critical: {
    firstResponse: 1 * 60 * 60 * 1000,  // 1 hour
    resolution: 4 * 60 * 60 * 1000      // 4 hours
  },
  high: {
    firstResponse: 4 * 60 * 60 * 1000,  // 4 hours
    resolution: 24 * 60 * 60 * 1000     // 24 hours
  },
  medium: {
    firstResponse: 8 * 60 * 60 * 1000,  // 8 hours
    resolution: 3 * 24 * 60 * 60 * 1000 // 3 days
  },
  low: {
    firstResponse: 24 * 60 * 60 * 1000, // 24 hours
    resolution: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
};

/**
 * Auto-escalation configuration
 */
const AUTO_ESCALATE_CONFIG = {
  enabled: true,
  escalateCriticalAfterMinutes: 60,  // 1 hour for critical
  escalateHighAfterMinutes: 240,     // 4 hours for high
  unassignedCriticalMinutes: 15,     // Auto-escalate unassigned critical after 15 min
  unassignedHighMinutes: 60          // Auto-escalate unassigned high after 1 hour
};

/**
 * Check SLA status for all active tickets
 */
async function checkSLAStatus() {
  try {
    console.log('[SLA CHECKER] Starting SLA check...');

    const now = new Date();

    // Find all active tickets (not resolved, closed, or cancelled)
    const activeTickets = await Ticket.find({
      status: { 
        $nin: ['resolved', 'closed', 'cancelled'] 
      },
      dueDate: { $exists: true }
    }).populate('assignedTo', 'userName email')
      .populate('supportManagerId', 'userName email')
      .populate('consultantContext.consultantAdminId', 'userName email')
      .populate('consultantContext.assignedConsultantId', 'userName email');

    console.log(`[SLA CHECKER] Found ${activeTickets.length} active tickets to check`);

    let breachedCount = 0;
    let warningCount = 0;
    let autoEscalatedCount = 0;

    for (const ticket of activeTickets) {
      try {
        const timeRemaining = ticket.getTimeRemaining();
        const isOverdue = ticket.isOverdue();
        const isDueSoon = ticket.isDueSoon();

        // Check for SLA breach
        if (isOverdue) {
          await handleSLABreach(ticket);
          breachedCount++;
        }
        // Check for SLA warning (80% elapsed)
        else if (isDueSoon) {
          await handleSLAWarning(ticket);
          warningCount++;
        }

        // Check for auto-escalation conditions
        if (AUTO_ESCALATE_CONFIG.enabled) {
          const shouldEscalate = await checkAutoEscalation(ticket, now);
          if (shouldEscalate) {
            await autoEscalateTicket(ticket, shouldEscalate.reason);
            autoEscalatedCount++;
          }
        }

      } catch (ticketError) {
        console.error(`[SLA CHECKER] Error processing ticket ${ticket.ticketId}:`, ticketError);
      }
    }

    console.log(`[SLA CHECKER] Completed. Breached: ${breachedCount}, Warnings: ${warningCount}, Auto-escalated: ${autoEscalatedCount}`);

  } catch (error) {
    console.error('[SLA CHECKER] Error in checkSLAStatus:', error);
  }
}

/**
 * Handle SLA breach
 */
async function handleSLABreach(ticket) {
  try {
    console.log(`[SLA CHECKER] SLA breach detected for ticket ${ticket.ticketId}`);

    // Check if we already sent breach notification (to avoid spam)
    // We can use a metadata field or check recent activities
    const recentBreach = ticket.metadata?.lastSLABreachNotification;
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    if (recentBreach && new Date(recentBreach) > oneDayAgo) {
      // Already notified within last 24 hours
      return;
    }

    // Send breach notification
    await notifySLAWarning(ticket, 'breach');

    // Update ticket metadata
    if (!ticket.metadata) {
      ticket.metadata = {};
    }
    ticket.metadata.lastSLABreachNotification = new Date();
    ticket.metadata.slaBreached = true;
    
    // Mark for save (using markModified since metadata is Mixed type)
    ticket.markModified('metadata');
    await ticket.save();

  } catch (error) {
    console.error(`[SLA CHECKER] Error handling SLA breach for ${ticket.ticketId}:`, error);
  }
}

/**
 * Handle SLA warning (80% elapsed)
 */
async function handleSLAWarning(ticket) {
  try {
    console.log(`[SLA CHECKER] SLA warning for ticket ${ticket.ticketId}`);

    // Check if we already sent warning
    const recentWarning = ticket.metadata?.lastSLAWarningNotification;
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);

    if (recentWarning && new Date(recentWarning) > sixHoursAgo) {
      // Already notified within last 6 hours
      return;
    }

    // Send warning notification
    await notifySLAWarning(ticket, 'warning');

    // Update ticket metadata
    if (!ticket.metadata) {
      ticket.metadata = {};
    }
    ticket.metadata.lastSLAWarningNotification = new Date();
    
    ticket.markModified('metadata');
    await ticket.save();

  } catch (error) {
    console.error(`[SLA CHECKER] Error handling SLA warning for ${ticket.ticketId}:`, error);
  }
}

/**
 * Check if ticket should be auto-escalated
 */
async function checkAutoEscalation(ticket, now) {
  // Skip if already escalated
  if (ticket.isEscalated) {
    return null;
  }

  const createdTime = ticket.createdAt.getTime();
  const elapsedMinutes = (now.getTime() - createdTime) / (1000 * 60);

  // Check unassigned tickets
  if (!ticket.assignedTo) {
    // Critical unassigned tickets
    if (ticket.priority === 'critical' && 
        elapsedMinutes > AUTO_ESCALATE_CONFIG.unassignedCriticalMinutes) {
      return {
        reason: `Critical ticket unassigned for ${Math.round(elapsedMinutes)} minutes`
      };
    }

    // High priority unassigned tickets
    if (ticket.priority === 'high' && 
        elapsedMinutes > AUTO_ESCALATE_CONFIG.unassignedHighMinutes) {
      return {
        reason: `High priority ticket unassigned for ${Math.round(elapsedMinutes)} minutes`
      };
    }
  }

  // Check assigned tickets without response
  if (ticket.assignedTo && !ticket.firstResponseAt) {
    // Critical tickets without response
    if (ticket.priority === 'critical' && 
        elapsedMinutes > AUTO_ESCALATE_CONFIG.escalateCriticalAfterMinutes) {
      return {
        reason: `Critical ticket without response for ${Math.round(elapsedMinutes)} minutes`
      };
    }

    // High priority tickets without response
    if (ticket.priority === 'high' && 
        elapsedMinutes > AUTO_ESCALATE_CONFIG.escalateHighAfterMinutes) {
      return {
        reason: `High priority ticket without response for ${Math.round(elapsedMinutes)} minutes`
      };
    }
  }

  // Check for SLA breach without escalation
  if (ticket.isOverdue() && !ticket.metadata?.autoEscalatedForBreach) {
    return {
      reason: 'SLA deadline breached'
    };
  }

  return null;
}

/**
 * Auto-escalate a ticket
 */
async function autoEscalateTicket(ticket, reason) {
  try {
    console.log(`[SLA CHECKER] Auto-escalating ticket ${ticket.ticketId}: ${reason}`);

    // Update ticket
    ticket.isEscalated = true;
    ticket.escalatedAt = new Date();
    ticket.escalationReason = `[AUTO-ESCALATED] ${reason}`;
    ticket.escalationLevel = (ticket.escalationLevel || 0) + 1;
    ticket.status = 'escalated';

    // Increase priority
    if (ticket.priority === 'low') {
      ticket.priority = 'medium';
    } else if (ticket.priority === 'medium') {
      ticket.priority = 'high';
    } else if (ticket.priority === 'high') {
      ticket.priority = 'critical';
    }

    // Mark as auto-escalated
    if (!ticket.metadata) {
      ticket.metadata = {};
    }
    ticket.metadata.autoEscalated = true;
    ticket.metadata.autoEscalatedAt = new Date();
    ticket.metadata.autoEscalatedReason = reason;

    ticket.markModified('metadata');
    await ticket.save();

    // Send escalation notification
    const { notifyTicketEscalated } = require('../notifications/ticketNotifications');
    await notifyTicketEscalated(ticket, reason, {
      userName: 'System',
      userType: 'system',
      _id: null
    });

    console.log(`[SLA CHECKER] Successfully auto-escalated ticket ${ticket.ticketId}`);

  } catch (error) {
    console.error(`[SLA CHECKER] Error auto-escalating ticket ${ticket.ticketId}:`, error);
  }
}

/**
 * Start the SLA checker cron job
 */
function startSLAChecker() {
  console.log('[SLA CHECKER] Initializing SLA checker cron job...');

  // Run every 15 minutes
  const task = cron.schedule('*/15 * * * *', () => {
    console.log('[SLA CHECKER] Running scheduled SLA check...');
    checkSLAStatus();
  });

  console.log('[SLA CHECKER] SLA checker cron job started (runs every 15 minutes)');

  return task;
}

module.exports = {
  startSLAChecker,
  checkSLAStatus,
  SLA_CONFIG,
  AUTO_ESCALATE_CONFIG
};