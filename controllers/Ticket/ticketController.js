// controllers/Ticket/ticketController.js
const { Ticket } = require('../../models/Ticket/Ticket');
const TicketActivity = require('../../models/Ticket/TicketActivity');
const Client = require('../../models/CMS/Client');
const User = require('../../models/User');
const { 
  saveTicketAttachments, 
  deleteTicketAttachment,
  deleteMultipleAttachments 
} = require('../../utils/uploads/ticketUploadS3');
const { 
  notifyTicketCreated,
  notifyTicketAssigned,
  notifyTicketStatusChanged,
  notifyTicketCommented,
  notifyTicketEscalated,
  notifyTicketResolved,
  notifySupportManagerNewTicket,
  notifySupportUserAssigned,
  notifyConsultantAdminTicket, // 🆕 New
  notifyConsultantTicket // 🆕 New
} = require('../../utils/notifications/ticketNotifications');

// ===== CONSTANTS =====

/**
 * 🆕 System ClientId for consultant internal issues
 * Used when consultant/consultant_admin creates ticket without specifying a client
 */
const INTERNAL_SUPPORT_CLIENT_ID = 'INTERNAL-SUPPORT';


// ===== SOCKET.IO INTEGRATION =====
let io;

/**
 * Set Socket.IO instance (called from index.js)
 */
exports.setSocketIO = (socketIO) => {
  io = socketIO;
};

/**
 * Emit ticket event to Socket.IO rooms
 */
function emitTicketEvent(eventType, data) {
  if (!io) return;

  const payload = {
    eventType,
    timestamp: new Date().toISOString(),
    ...data
  };

  // Emit to client room if clientId exists and is not internal
  if (data.clientId && data.clientId !== INTERNAL_SUPPORT_CLIENT_ID) {
    io.to(`client_${data.clientId}`).emit(eventType, payload);
  }
  
  // Emit to ticket-specific room if ticketId exists
  if (data.ticketId || data._id) {
    const ticketRoomId = data._id ? data._id.toString() : data.ticketId;
    io.to(`ticket_${ticketRoomId}`).emit(eventType, payload);
  }

  // 🆕 Emit to consultant rooms if applicable
  if (data.consultantAdminId) {
    io.to(`user_${data.consultantAdminId}`).emit(eventType, payload);
  }
  if (data.assignedConsultantId) {
    io.to(`user_${data.assignedConsultantId}`).emit(eventType, payload);
  }

  console.log(`[TICKET] Emitted ${eventType}`);
}

// ===== HELPER FUNCTIONS =====


// ===== HELPER FUNCTIONS =====

function getId(value) {
  if (!value) return null;

  // Already a string/number
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);

  // Mongoose populated doc OR plain object
  if (value._id) return String(value._id);
  if (value.id) return String(value.id);

  // Mongoose ObjectId
  if (typeof value.toHexString === "function") return value.toHexString();

  // Fallback
  if (typeof value.toString === "function") return value.toString();
  return null;
}

function idsEqual(a, b) {
  const idA = getId(a);
  const idB = getId(b);
  return Boolean(idA && idB && idA === idB);
}

function getUserId(user) {
  return getId(user);
}

/**
 * Find ticket by either MongoDB ObjectId or human-readable ticketId
 * Returns a Mongoose Query object that can be chained with .populate(), .select(), etc.
 * 
 * @param {string} id - Either MongoDB ObjectId (24 hex) or ticketId (TKT-YYYY-NNNNN)
 * @returns {Query} - Mongoose Query object (NOT the result)
 * 
 * @example
 * // Chain with populate
 * const ticket = await findTicketByIdOrTicketId("TKT-2026-00002")
 *   .populate('createdBy')
 *   .populate('assignedTo');
 * 
 * @example
 * // Execute without populate
 * const ticket = await findTicketByIdOrTicketId("507f1f77bcf86cd799439011");
 */
function findTicketByIdOrTicketId(id) {  // ✅ NOT async
  if (!id) {
    // Return a query that will find nothing
    return Ticket.findOne({ _id: null });
  }

  // Remove whitespace
  const cleanId = id.toString().trim();

  // Check if it's MongoDB ObjectId format (24 hexadecimal characters)
  const isObjectId = /^[0-9a-fA-F]{24}$/.test(cleanId);
  
  if (isObjectId) {
    // Return Query object (not awaited!)
    return Ticket.findById(cleanId);  // ✅ Returns Query
  } else {
    // Return Query object (not awaited!)
    return Ticket.findOne({ ticketId: cleanId });  // ✅ Returns Query
  }
}


async function checkTicketAccess(user, ticket) {
  const userId = getUserId(user);
  const userType = user.userType;

  // Super admin - full access
  if (userType === "super_admin") return true;

  // Support Manager
  if (userType === "supportManager") {
    if (idsEqual(ticket.supportManagerId, userId)) return true;
    if (user.supportManagerType === "general_support") return true;
    return false;
  }

  // Support User
  if (userType === "support") {
    if (idsEqual(ticket.assignedTo, userId)) return true;

    if (Array.isArray(ticket.watchers) && ticket.watchers.some((w) => idsEqual(w, userId))) {
      return true;
    }

    if (user.supportManagerId && idsEqual(ticket.supportManagerId, user.supportManagerId)) {
      return true;
    }

    return false;
  }

  // Consultant Admin
  if (userType === "consultant_admin") {
    if (idsEqual(ticket.createdBy, userId)) return true;

    if (idsEqual(ticket.consultantContext?.consultantAdminId, userId)) return true;

    if (ticket.clientId && ticket.clientId !== INTERNAL_SUPPORT_CLIENT_ID) {
      const client = await Client.findOne({ clientId: ticket.clientId });
      if (client && idsEqual(client.leadInfo?.createdBy, userId)) return true;
    }

    return false;
  }

  // Consultant
  if (userType === "consultant") {
    if (idsEqual(ticket.createdBy, userId)) return true;

    if (idsEqual(ticket.consultantContext?.assignedConsultantId, userId)) return true;

    if (ticket.clientId && ticket.clientId !== INTERNAL_SUPPORT_CLIENT_ID) {
      const client = await Client.findOne({ clientId: ticket.clientId });
      if (client && idsEqual(client.workflowTracking?.assignedConsultantId, userId)) return true;
    }

    return false;
  }

  // Client-side users
  if (["client_admin", "client_employee_head", "employee", "auditor", "viewer"].includes(userType)) {
    if (user.clientId && ticket.clientId === user.clientId) return true;

    if (
      idsEqual(ticket.createdBy, userId) ||
      (Array.isArray(ticket.watchers) && ticket.watchers.some((w) => idsEqual(w, userId)))
    ) {
      return true;
    }
  }

  return false;
}


/**
 * 🆕 UPDATED: Get support manager ID based on user type and context
 * 
 * For consultant/consultant_admin issues:
 * - Uses User.supportManagerId (their assigned support manager)
 * 
 * For client tickets:
 * - Uses Client.supportSection.assignedSupportManagerId
 */
async function getSupportManagerForUser(user, clientId) {
  try {
    const userType = user.userType;
    
    // 🆕 For consultant/consultant_admin - Use their personal support manager
    if (['consultant', 'consultant_admin'].includes(userType)) {
      // If clientId is INTERNAL or not provided, use consultant's support manager
      if (!clientId || clientId === INTERNAL_SUPPORT_CLIENT_ID) {
        if (user.supportManagerId) {
          console.log(`[TICKET] Using consultant's support manager for internal issue`);
          return user.supportManagerId;
        }
        return null;
      }
      
      // If clientId is provided and real, could use client's SM or consultant's SM
      // For now, use client's SM for client-related issues even from consultants
      const client = await Client.findOne({ clientId });
      if (client?.supportSection?.assignedSupportManagerId) {
        console.log(`[TICKET] Using client's support manager for client-related issue from consultant`);
        return client.supportSection.assignedSupportManagerId;
      }
      
      // Fallback to consultant's SM
      if (user.supportManagerId) {
        return user.supportManagerId;
      }
    }
    
    // For client-side users, use client's support manager
    if (['client_admin', 'client_employee_head', 'employee', 'auditor'].includes(userType)) {
      if (!clientId || clientId === INTERNAL_SUPPORT_CLIENT_ID) {
        console.warn('[TICKET] Client-side user without valid clientId');
        return null;
      }
      
      const client = await Client.findOne({ clientId });
      if (client?.supportSection?.assignedSupportManagerId) {
        return client.supportSection.assignedSupportManagerId;
      }
    }
    
    // For support users, use their manager
    if (userType === 'support') {
      if (user.supportManagerId) {
        return user.supportManagerId;
      }
    }
    
    // No support manager found
    return null;
  } catch (error) {
    console.error('[TICKET] Error getting support manager:', error);
    return null;
  }
}

/**
 * 🆕 Set consultant context for a ticket
 * Handles both client tickets and consultant internal issues
 */
async function setConsultantContext(ticket, user, client) {
  try {
    if (!ticket.consultantContext) {
      ticket.consultantContext = {};
    }

    const userId = getUserId(user);
    
    // If created by consultant or consultant_admin, mark as consultant issue ONLY if no real client
    if (['consultant', 'consultant_admin'].includes(user.userType)) {
      // Check if this is an internal issue (no client or INTERNAL-SUPPORT)
      if (!client || ticket.clientId === INTERNAL_SUPPORT_CLIENT_ID) {
        ticket.consultantContext.isConsultantIssue = true;
        console.log(`[TICKET] Marked as consultant internal issue`);
      }
      
      // Set consultant admin info
      if (user.userType === 'consultant_admin') {
        ticket.consultantContext.consultantAdminId = user._id;
        ticket.consultantContext.consultantAdminName = user.userName;
      }
      
      // For consultant, find their consultant admin
      if (user.userType === 'consultant') {
        if (user.consultantAdminId) {
          ticket.consultantContext.consultantAdminId = user.consultantAdminId;
          
          const consultantAdmin = await User.findById(user.consultantAdminId).select('userName');
          if (consultantAdmin) {
            ticket.consultantContext.consultantAdminName = consultantAdmin.userName;
          }
        }
        
        // Set themselves as assigned consultant
        ticket.consultantContext.assignedConsultantId = user._id;
        ticket.consultantContext.assignedConsultantName = user.userName;
      }
    }

    // If client exists and it's not an internal issue, get consultant info from client
    if (client && ticket.clientId !== INTERNAL_SUPPORT_CLIENT_ID) {
      // Get consultant admin from client
      if (client.leadInfo?.consultantAdminId) {
        ticket.consultantContext.consultantAdminId = client.leadInfo.consultantAdminId;
        
        const consultantAdmin = await User.findById(client.leadInfo.consultantAdminId).select('userName');
        if (consultantAdmin) {
          ticket.consultantContext.consultantAdminName = consultantAdmin.userName;
        }
      }

      // Get assigned consultant from client
      if (client.workflowTracking?.assignedConsultantId || client.leadInfo?.assignedConsultantId) {
        const consultantId = client.workflowTracking?.assignedConsultantId || client.leadInfo.assignedConsultantId;
        ticket.consultantContext.assignedConsultantId = consultantId;
        
        const consultant = await User.findById(consultantId).select('userName');
        if (consultant) {
          ticket.consultantContext.assignedConsultantName = consultant.userName;
        }
      }
    }

    ticket.consultantContext.contextSetAt = new Date();

  } catch (error) {
    console.error('[TICKET] Error setting consultant context:', error);
    // Don't fail ticket creation if this fails
  }
}

/**
 * 🆕 UPDATED: Check if user can access client's tickets
 * Now handles INTERNAL-SUPPORT clientId for consultant issues
 */
async function canAccessClientTickets(user, clientId) {
  const userId = getUserId(user);
  
  // Super admin can access all
  if (user.userType === 'super_admin') {
    return { allowed: true, reason: 'Super admin access' };
  }

  // 🆕 If INTERNAL-SUPPORT clientId, only consultants/consultant_admins can access
  if (clientId === INTERNAL_SUPPORT_CLIENT_ID) {
    if (['consultant', 'consultant_admin'].includes(user.userType)) {
      return { allowed: true, reason: 'Consultant internal issue access' };
    }
    return { allowed: false, reason: 'Internal issues only accessible to consultants' };
  }

  // Support managers can access tickets they manage
  if (user.userType === 'supportManager') {
    if (user.assignedSupportClients?.includes(clientId)) {
      return { allowed: true, reason: 'Support manager access' };
    }
    
    if (user.supportManagerType === 'general_support') {
      return { allowed: true, reason: 'General support access' };
    }
  }

  // Support users can access if they belong to the support team managing this client
  if (user.userType === 'support') {
    const client = await Client.findOne({ clientId });
    if (client?.supportSection?.assignedSupportManagerId) {
      if (user.supportManagerId?.toString() === client.supportSection.assignedSupportManagerId.toString()) {
        return { allowed: true, reason: 'Support user access' };
      }
    }
  }

  // Client users can access their own client
  if (user.clientId === clientId) {
    return { allowed: true, reason: 'Own client access' };
  }

  // Get client details
  const client = await Client.findOne({ clientId });
  if (!client) {
    return { allowed: false, reason: 'Client not found' };
  }

  // Consultant Admin: Can access if they created the lead
  if (user.userType === 'consultant_admin') {
    const createdBy = client.leadInfo?.createdBy?.toString();
    if (createdBy === userId) {
      return { allowed: true, reason: 'Lead creator access' };
    }
    
    // Can access if any of their consultants is assigned
    const consultants = await User.find({ 
      consultantAdminId: userId, 
      userType: 'consultant',
      isActive: true 
    }).select('_id').lean();
    
    const consultantIds = consultants.map(c => c._id.toString());
    const assignedConsultantId = client.workflowTracking?.assignedConsultantId?.toString() || 
                                  client.leadInfo?.assignedConsultantId?.toString();
    
    if (assignedConsultantId && consultantIds.includes(assignedConsultantId)) {
      return { allowed: true, reason: 'Team consultant assigned access' };
    }
  }

  // Consultant: Can access if assigned to the client
  if (user.userType === 'consultant') {
    const assignedConsultantId = client.workflowTracking?.assignedConsultantId?.toString() || 
                                  client.leadInfo?.assignedConsultantId?.toString();
    
    if (assignedConsultantId === userId) {
      return { allowed: true, reason: 'Assigned consultant access' };
    }
  }

  return { allowed: false, reason: 'Access denied' };
}


/**
 * 🆕 UPDATED: Check if user can create tickets
 * Now allows consultant/consultant_admin to create without clientId (uses INTERNAL-SUPPORT)
 */
async function canCreateTicket(user, clientId) {
  const userId = getUserId(user);
  
  // Super admin can create for any client
  if (user.userType === 'super_admin') {
    return { allowed: true };
  }

  // 🆕 Consultant/consultant_admin can ALWAYS create tickets
  if (['consultant', 'consultant_admin'].includes(user.userType)) {
    // If no clientId or INTERNAL, it's their internal issue - allow
    if (!clientId || clientId === INTERNAL_SUPPORT_CLIENT_ID) {
      return { allowed: true, reason: 'Consultant internal issue' };
    }
    
    // If clientId is provided, check if they have access to that client
    const access = await canAccessClientTickets(user, clientId);
    if (access.allowed) {
      return { allowed: true };
    }
    
    return { allowed: false, reason: 'No access to specified client' };
  }

  // Client users MUST provide clientId
  if (!clientId || clientId === INTERNAL_SUPPORT_CLIENT_ID) {
    return { allowed: false, reason: 'clientId is required for client users' };
  }

  // Client users can create for their own client
  const clientCreateRoles = ['client_admin', 'client_employee_head', 'employee'];
  if (clientCreateRoles.includes(user.userType) && user.clientId === clientId) {
    return { allowed: true };
  }

  // Auditors can create tickets for their client
  if (user.userType === 'auditor' && user.clientId === clientId) {
    return { allowed: true };
  }

  return { allowed: false, reason: 'Cannot create tickets for this client' };
}
/**
 * Check if user can view a specific ticket
 */
async function canViewTicket(user, ticket) {
  const userId = getUserId(user);
  
  // Super admin can view all
  if (user.userType === 'super_admin') {
    return { allowed: true };
  }

  // Check general access
  const hasAccess = await checkTicketAccess(user, ticket);
  if (hasAccess) {
    return { allowed: true };
  }

  return { allowed: false, reason: 'No access to ticket' };
}

/**
 * Check if user can modify a ticket
 */
async function canModifyTicket(user, ticket) {
  const userId = getUserId(user);
  
  // Super admin can modify all
  if (user.userType === 'super_admin') {
    return { allowed: true };
  }

  // Support manager can modify tickets assigned to them
  if (user.userType === 'supportManager') {
    if (ticket.supportManagerId?.toString() === userId) {
      return { allowed: true };
    }
  }

  // Support user can modify assigned tickets
  if (user.userType === 'support') {
    if (ticket.assignedTo?.toString() === userId) {
      return { allowed: true };
    }
  }

  // Client admin can modify tickets for their client
  if (user.userType === 'client_admin' && ticket.clientId && 
      ticket.clientId !== INTERNAL_SUPPORT_CLIENT_ID && 
      user.clientId === ticket.clientId) {
    return { allowed: true };
  }

  // Consultant admin can modify tickets for their clients or their own issues
  if (user.userType === 'consultant_admin') {
    // Can modify their own tickets
    if (ticket.createdBy.toString() === userId) {
      return { allowed: true };
    }
    
    // Can modify if client is accessible (not INTERNAL tickets from others)
    if (ticket.clientId && ticket.clientId !== INTERNAL_SUPPORT_CLIENT_ID) {
      const access = await canAccessClientTickets(user, ticket.clientId);
      if (access.allowed) {
        return { allowed: true };
      }
    }
  }

  // Consultant can modify if assigned or their own
  if (user.userType === 'consultant') {
    if (ticket.createdBy.toString() === userId) {
      return { allowed: true };
    }
    
    if (ticket.assignedTo && ticket.assignedTo.toString() === userId) {
      return { allowed: true };
    }
    
    // Or if they have access to the client
    if (ticket.clientId && ticket.clientId !== INTERNAL_SUPPORT_CLIENT_ID) {
      const access = await canAccessClientTickets(user, ticket.clientId);
      if (access.allowed) {
        return { allowed: true };
      }
    }
  }

  // Creator can modify their own ticket (limited fields)
  if (ticket.createdBy.toString() === userId) {
    return { allowed: true, limited: true };
  }

  return { allowed: false, reason: 'No permission to modify ticket' };
}


/**
 * Check if user can assign tickets
 */
async function canAssignTicket(user, ticket) {
  const userId = getUserId(user);
  
  // Super admin can assign all
  if (user.userType === 'super_admin') {
    return { allowed: true };
  }

  // ✅ FIXED: Support manager can assign tickets
  if (user.userType === 'supportManager') {
    // Can assign if ticket is in their queue
    if (ticket.supportManagerId?.toString() === userId) {
      return { allowed: true };
    }
    
    // ✅ NEW: Can assign if they're general support (access to all tickets)
    if (user.supportManagerType === 'general_support') {
      return { allowed: true };
    }
    
    // ✅ NEW: Can assign unassigned tickets (no supportManagerId set)
    if (!ticket.supportManagerId) {
      return { allowed: true };
    }
    
    // ✅ NEW: Can assign if they manage the client
    if (ticket.clientId && ticket.clientId !== INTERNAL_SUPPORT_CLIENT_ID) {
      if (user.assignedSupportClients?.includes(ticket.clientId)) {
        return { allowed: true };
      }
    }
  }

  // Client admin can assign within their client (limited)
  if (user.userType === 'client_admin' && ticket.clientId && 
      ticket.clientId !== INTERNAL_SUPPORT_CLIENT_ID && 
      user.clientId === ticket.clientId) {
    return { allowed: true, limited: true };
  }

  // Consultant admin can assign tickets for their clients (limited)
  if (user.userType === 'consultant_admin') {
    if (ticket.clientId && ticket.clientId !== INTERNAL_SUPPORT_CLIENT_ID) {
      const access = await canAccessClientTickets(user, ticket.clientId);
      if (access.allowed) {
        return { allowed: true, limited: true };
      }
    }
    // Can assign their own tickets
    if (ticket.createdBy.toString() === userId) {
      return { allowed: true, limited: true };
    }
  }

  return { allowed: false, reason: 'No permission to assign tickets' };
}


/**
 * Check if user can resolve tickets
 */
async function canResolveTicket(user, ticket) {
  const userId = getUserId(user);
  
  // Super admin can resolve all
  if (user.userType === 'super_admin') {
    return { allowed: true };
  }

  // Support manager can resolve tickets they manage
  if (user.userType === 'supportManager') {
    if (ticket.supportManagerId?.toString() === userId) {
      return { allowed: true };
    }
  }

  // Support user can resolve assigned tickets
  if (user.userType === 'support') {
    if (ticket.assignedTo?.toString() === userId) {
      return { allowed: true };
    }
  }

  // Consultant admin can resolve tickets for their clients
  if (user.userType === 'consultant_admin') {
    if (ticket.clientId && ticket.clientId !== INTERNAL_SUPPORT_CLIENT_ID) {
      const access = await canAccessClientTickets(user, ticket.clientId);
      if (access.allowed) {
        return { allowed: true };
      }
    }
    if (ticket.createdBy.toString() === userId) {
      return { allowed: true };
    }
  }

  return { allowed: false, reason: 'No permission to resolve tickets' };
}


/**
 * Check if user can close tickets
 */
async function canCloseTicket(user, ticket) {
  // Only super admin, support manager, and ticket creator can close
  const userId = getUserId(user);
  
  if (user.userType === 'super_admin') {
    return { allowed: true };
  }

  if (user.userType === 'supportManager' && ticket.supportManagerId?.toString() === userId) {
    return { allowed: true };
  }

  if (ticket.createdBy.toString() === userId) {
    return { allowed: true };
  }

  return { allowed: false, reason: 'No permission to close tickets' };
}
/**
 * Log activity for a ticket
 */
async function logActivity(ticketId, activityType, data, userId, userType) {
  try {
    const activity = new TicketActivity({
      ticket: ticketId,
      activityType,
      createdBy: userId,
      createdByType: userType,
      ...data
    });

    await activity.save();
    return activity;
  } catch (error) {
    console.error('Error logging ticket activity:', error);
    throw error;
  }
}

// ===== CORE ENDPOINTS =====

/**
 * 🆕 ENHANCED Create a new ticket
 * POST /api/tickets
 * 
 * UPDATED LOGIC:
 * - For client-side users: Auto-assign to client's supportManager
 * - For consultant/consultant_admin: Auto-assign to consultant's supportManager
 * - Sets consultant context for tracking
 * - Notifies appropriate parties
 */
exports.createTicket = async (req, res) => {
  try {
    const userId = getUserId(req.user);
    let { clientId } = req.body;

    // 🆕 HANDLE CONSULTANT INTERNAL ISSUES
    const isConsultantUser = ['consultant', 'consultant_admin'].includes(req.user.userType);
    
    // If consultant/consultant_admin and no clientId provided, use INTERNAL-SUPPORT
    if (isConsultantUser && !clientId) {
      clientId = INTERNAL_SUPPORT_CLIENT_ID;
      console.log(`[TICKET] Consultant internal issue detected, using ${INTERNAL_SUPPORT_CLIENT_ID}`);
    }
    
    // For non-consultant users, clientId is required
    if (!isConsultantUser && !clientId) {
      return res.status(400).json({
        success: false,
        message: 'clientId is required for client users'
      });
    }

    // Check permissions
    const canCreate = await canCreateTicket(req.user, clientId);
    if (!canCreate.allowed) {
      return res.status(403).json({
        success: false,
        message: canCreate.reason || 'Access denied'
      });
    }

    // Verify client exists if it's a real client (not INTERNAL-SUPPORT)
    let client = null;
    if (clientId && clientId !== INTERNAL_SUPPORT_CLIENT_ID) {
      client = await Client.findOne({ clientId });
      if (!client) {
        return res.status(404).json({
          success: false,
          message: 'Client not found'
        });
      }
    }

    // Generate ticket ID
    const ticketId = await Ticket.generateTicketId();

    // Extract ticket data
    const {
      category,
      subCategory,
      subject,
      description,
      priority = 'medium',
      status = 'open',
      relatedEntities = {},
      tags = [],
      requiresApproval = false
    } = req.body;

    // Validate required fields
    if (!category || !subject || !description) {
      return res.status(400).json({
        success: false,
        message: 'category, subject, and description are required'
      });
    }

    // Calculate SLA due date
    const dueDate = Ticket.calculateDueDate(priority);

    // Determine sandbox status
    const isSandbox = (client && client.sandbox === true) || req.user.sandbox === true;

    // ===== AUTO-ASSIGN TO SUPPORT MANAGER =====
    let assignedSupportManagerId = null;
    
    // Get the appropriate support manager
    assignedSupportManagerId = await getSupportManagerForUser(req.user, clientId);
    
    if (!assignedSupportManagerId) {
      console.warn(`[TICKET] No support manager found for user ${req.user.userName} (${req.user.userType}), clientId: ${clientId}`);
    }

    // 🆕 Create ticket with INTERNAL-SUPPORT clientId if needed
    const ticket = new Ticket({
      ticketId,
      clientId, // Will be INTERNAL-SUPPORT for consultant issues or actual clientId
      createdBy: userId,
      createdByType: req.user.userType,
      supportManagerId: assignedSupportManagerId,
      category,
      subCategory,
      subject,
      description,
      priority,
      status,
      relatedEntities,
      tags,
      dueDate,
      requiresApproval,
      sandbox: isSandbox
    });

    // 🆕 Set consultant context
    await setConsultantContext(ticket, req.user, client);

    // Handle file attachments if present
    if (req.files && req.files.length > 0) {
      const attachments = await saveTicketAttachments(req, {
        clientId: clientId,
        ticketId,
        userId,
        type: 'ticket'
      });
      ticket.attachments = attachments;
    }

    await ticket.save();

    // Log creation activity
    await logActivity(
      ticket._id,
      'created',
      {
        changes: [{
          field: 'status',
          oldValue: null,
          newValue: status
        }]
      },
      userId,
      req.user.userType
    );

    // ===== NOTIFICATIONS =====
    
    // 1. Notify support manager
    if (assignedSupportManagerId) {
      const supportManager = await User.findById(assignedSupportManagerId);
      
      if (supportManager) {
        console.log(`[TICKET] Notifying support manager ${supportManager.userName} about new ticket ${ticket.ticketId}`);
        
        try {
          await notifySupportManagerNewTicket(ticket, supportManager, req.user);
        } catch (notifyError) {
          console.error('[TICKET] Error notifying support manager:', notifyError);
        }
        
        // Broadcast via Socket.IO
        if (global.broadcastTicketCreated) {
          global.broadcastTicketCreated({
            ...ticket.toObject(),
            notifiedSupportManager: {
              _id: supportManager._id,
              userName: supportManager.userName,
              supportTeamName: supportManager.supportTeamName
            }
          });
        }
      }
    }

    // 🆕 2. Notify consultant admin about tickets from their clients (NOT for internal issues)
    if (client && ticket.consultantContext?.consultantAdminId && 
        !ticket.consultantContext.isConsultantIssue &&
        !['consultant_admin'].includes(req.user.userType)) {
      try {
        const consultantAdmin = await User.findById(ticket.consultantContext.consultantAdminId);
        if (consultantAdmin) {
          await notifyConsultantAdminTicket(ticket, consultantAdmin, client);
        }
      } catch (notifyError) {
        console.error('[TICKET] Error notifying consultant admin:', notifyError);
      }
    }

    // 🆕 3. Notify assigned consultant about tickets from their clients (NOT for internal issues)
    if (client && ticket.consultantContext?.assignedConsultantId && 
        !ticket.consultantContext.isConsultantIssue &&
        !['consultant'].includes(req.user.userType)) {
      try {
        const consultant = await User.findById(ticket.consultantContext.assignedConsultantId);
        if (consultant) {
          await notifyConsultantTicket(ticket, consultant, client);
        }
      } catch (notifyError) {
        console.error('[TICKET] Error notifying consultant:', notifyError);
      }
    }

    // Emit socket event
    emitTicketEvent('ticket-created', {
      clientId,
      ticketId: ticket._id,
      ticket: ticket.toObject(),
      consultantAdminId: ticket.consultantContext?.consultantAdminId,
      assignedConsultantId: ticket.consultantContext?.assignedConsultantId
    });

    // Send general notifications
    try {
      await notifyTicketCreated(ticket, req.user);
    } catch (notifyError) {
      console.error('[TICKET] Error sending general notifications:', notifyError);
    }

    // Populate references before sending response
    await ticket.populate([
      { path: 'createdBy', select: 'userName email userType' },
      { path: 'supportManagerId', select: 'userName email userType supportTeamName supportManagerType' },
      { path: 'consultantContext.consultantAdminId', select: 'userName email userType' },
      { path: 'consultantContext.assignedConsultantId', select: 'userName email userType' }
    ]);

    res.status(201).json({
      success: true,
      message: 'Ticket created successfully',
      ticket,
      supportManagerAssigned: !!assignedSupportManagerId,
      consultantContext: ticket.consultantContext,
      isConsultantIssue: ticket.consultantContext?.isConsultantIssue || false,
      isInternalIssue: clientId === INTERNAL_SUPPORT_CLIENT_ID
    });

  } catch (error) {
    console.error('Error creating ticket:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create ticket',
      error: error.message
    });
  }
};

/**
 * 🆕 ENHANCED List tickets with consultant filtering
 * GET /api/tickets
 */
exports.listTickets = async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const {
      clientId,
      status,
      priority,
      category,
      assignedTo,
      createdBy,
      tags,
      hasAttachments,
      overdue,
      dueSoon,
      search,
      fromDate,
      toDate,
      page = 1,
      limit = 20,
      sortBy = 'updatedAt',
      sortOrder = 'desc',
      // 🆕 New filters for consultant workflows
      consultantAdminId,
      assignedConsultantId,
      isConsultantIssue
    } = req.query;

    // Build query
    const query = {};

    // Client ID filter (required for non-super_admin)
    if (req.user.userType === 'super_admin') {
      // Super admin can see all, optionally filter by clientId
      if (clientId) {
        query.clientId = clientId;
      }
    } else if (req.user.userType === 'supportManager') {
      // Support manager sees tickets assigned to them
      if (req.user.supportManagerType === 'general_support') {
        // General support can see all tickets
        if (clientId) {
          query.clientId = clientId;
        }
      } else {
        // Specific support managers see only their tickets
        query.supportManagerId = req.user._id;
        if (clientId) {
          query.clientId = clientId;
        }
      }
    } else if (req.user.userType === 'support') {
  // ✅ Support users can see:
  // 1. Tickets from their manager's queue
  // 2. Tickets assigned directly to them (regardless of supportManagerId)
  
  // Check if filtering by assignedTo=me
  const isFilteringAssignedToMe = req.query.assignedTo === 'me';
  
  if (isFilteringAssignedToMe) {
    // When filtering for assigned tickets, ONLY show tickets assigned to them
    // Don't filter by supportManagerId - they should see ALL assigned tickets
    query.assignedTo = req.user._id;
  } else {
    // Default view: tickets from their manager's queue
    if (req.user.supportManagerId) {
      // Either assigned to their manager OR unassigned (null)
      query.$or = [
        { supportManagerId: req.user.supportManagerId },
        { supportManagerId: null, assignedTo: req.user._id } // Unassigned but assigned to them
      ];
    }
  }
  
  if (clientId) {
    query.clientId = clientId;
  }
} else if (req.user.userType === 'consultant_admin') {
      // 🆕 Consultant Admin can see:
      // 1. Tickets they created
      // 2. Tickets from clients they created
      // 3. Tickets created by consultants in their team
      
      if (clientId) {
        query.clientId = clientId;
      } else {
        // Build OR query for all accessible tickets
        const orConditions = [
          { createdBy: req.user._id }, // Tickets created by them
          { 'consultantContext.consultantAdminId': req.user._id } // Tickets from their clients
        ];
        
        query.$or = orConditions;
      }
    } else if (req.user.userType === 'consultant') {
      // 🆕 Consultant can see:
      // 1. Tickets they created
      // 2. Tickets from clients assigned to them
      
      if (clientId) {
        query.clientId = clientId;
      } else {
        const orConditions = [
          { createdBy: req.user._id }, // Tickets created by them
          { 'consultantContext.assignedConsultantId': req.user._id } // Tickets from assigned clients
        ];
        
        query.$or = orConditions;
      }
    } else {
      // Client-side users can only see tickets from their client
      if (!req.user.clientId) {
        return res.status(403).json({
          success: false,
          message: 'Client ID not found in user profile'
        });
      }
      query.clientId = req.user.clientId;
    }

    // 🆕 Consultant-specific filters
    if (consultantAdminId) {
      query['consultantContext.consultantAdminId'] = consultantAdminId;
    }

    if (assignedConsultantId) {
      query['consultantContext.assignedConsultantId'] = assignedConsultantId;
    }

    if (isConsultantIssue === 'true') {
      query['consultantContext.isConsultantIssue'] = true;
    }

    // Status filter
    if (status) {
      const statusArray = status.split(',').map(s => s.trim());
      query.status = statusArray.length === 1 ? statusArray[0] : { $in: statusArray };
    }

    // Priority filter
    if (priority) {
      const priorityArray = priority.split(',').map(p => p.trim());
      query.priority = priorityArray.length === 1 ? priorityArray[0] : { $in: priorityArray };
    }

    // Category filter
    if (category) {
      query.category = category;
    }

    // Assignment filters
    if (assignedTo === 'me') {
      query.assignedTo = req.user._id;
    } else if (assignedTo === 'unassigned') {
      query.assignedTo = null;
    } else if (assignedTo) {
      query.assignedTo = assignedTo;
    }

    // Creator filter
    if (createdBy === 'me') {
      query.createdBy = req.user._id;
    } else if (createdBy) {
      query.createdBy = createdBy;
    }

    // Tags filter
    if (tags) {
      const tagsArray = tags.split(',').map(t => t.trim());
      query.tags = { $in: tagsArray };
    }

    // Attachments filter
    if (hasAttachments === 'true') {
      query.attachments = { $exists: true, $ne: [] };
    }

    // Date range filter
    if (fromDate || toDate) {
      query.createdAt = {};
      if (fromDate) {
        query.createdAt.$gte = new Date(fromDate);
      }
      if (toDate) {
        query.createdAt.$lte = new Date(toDate);
      }
    }

    // Text search
    if (search) {
      query.$text = { $search: search };
    }

    // Pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Execute query
    const [tickets, total] = await Promise.all([
      Ticket.find(query)
        .populate('createdBy', 'userName email userType')
        .populate('assignedTo', 'userName email userType')
        .populate('supportManagerId', 'userName email userType supportTeamName')
        .populate('consultantContext.consultantAdminId', 'userName email userType')
        .populate('consultantContext.assignedConsultantId', 'userName email userType')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Ticket.countDocuments(query)
    ]);

    // 🆕 Apply overdue/due soon filters in memory (for accurate counts)
    let filteredTickets = tickets;
    
    if (overdue === 'true') {
      filteredTickets = filteredTickets.filter(ticket => {
        const t = new Ticket(ticket);
        return t.isOverdue();
      });
    }
    
    if (dueSoon === 'true') {
      filteredTickets = filteredTickets.filter(ticket => {
        const t = new Ticket(ticket);
        return t.isDueSoon();
      });
    }

    res.json({
      success: true,
      tickets: filteredTickets,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (error) {
    console.error('Error listing tickets:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tickets',
      error: error.message
    });
  }
};

/**
 * 🆕 ENHANCED Get ticket statistics with consultant breakdowns
 * GET /api/tickets/stats
 */
exports.getStats = async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { clientId, fromDate, toDate, consultantAdminId, assignedConsultantId } = req.query;

    // Build base query based on user type
    const baseQuery = {};

    if (req.user.userType === 'super_admin') {
      if (clientId) baseQuery.clientId = clientId;
    } else if (req.user.userType === 'supportManager') {
      if (req.user.supportManagerType !== 'general_support') {
        baseQuery.supportManagerId = req.user._id;
      }
      if (clientId) baseQuery.clientId = clientId;
    } else if (req.user.userType === 'support') {
      baseQuery.supportManagerId = req.user.supportManagerId;
      if (clientId) baseQuery.clientId = clientId;
    } else if (req.user.userType === 'consultant_admin') {
      // 🆕 Consultant admin sees stats for their clients
      if (clientId) {
        baseQuery.clientId = clientId;
      } else {
        baseQuery['consultantContext.consultantAdminId'] = req.user._id;
      }
    } else if (req.user.userType === 'consultant') {
      // 🆕 Consultant sees stats for their assigned clients
      if (clientId) {
        baseQuery.clientId = clientId;
      } else {
        baseQuery['consultantContext.assignedConsultantId'] = req.user._id;
      }
    } else {
      baseQuery.clientId = req.user.clientId;
    }

    // 🆕 Apply consultant filters
    if (consultantAdminId) {
      baseQuery['consultantContext.consultantAdminId'] = consultantAdminId;
    }
    if (assignedConsultantId) {
      baseQuery['consultantContext.assignedConsultantId'] = assignedConsultantId;
    }

    // Date range filter
    if (fromDate || toDate) {
      baseQuery.createdAt = {};
      if (fromDate) baseQuery.createdAt.$gte = new Date(fromDate);
      if (toDate) baseQuery.createdAt.$lte = new Date(toDate);
    }

    // Get all tickets matching base query
    const allTickets = await Ticket.find(baseQuery).lean();

    // Calculate statistics
    const stats = {
      total: allTickets.length,
      byStatus: {},
      byPriority: {},
      byCategory: {},
      sla: {
        overdue: 0,
        dueSoon: 0,
        onTrack: 0
      },
      assignment: {
        unassigned: 0,
        assigned: 0
      },
      resolution: {
        avgResolutionTime: 0,
        resolvedCount: 0
      },
      // 🆕 Consultant-specific stats
      consultant: {
        byConsultantAdmin: {},
        byAssignedConsultant: {},
        consultantIssues: 0,
        clientIssues: 0
      }
    };

    // Process each ticket
    let totalResolutionTime = 0;
    
    for (const ticket of allTickets) {
      // Status breakdown
      stats.byStatus[ticket.status] = (stats.byStatus[ticket.status] || 0) + 1;
      
      // Priority breakdown
      stats.byPriority[ticket.priority] = (stats.byPriority[ticket.priority] || 0) + 1;
      
      // Category breakdown
      stats.byCategory[ticket.category] = (stats.byCategory[ticket.category] || 0) + 1;
      
      // SLA tracking
      const t = new Ticket(ticket);
      if (t.isOverdue()) {
        stats.sla.overdue++;
      } else if (t.isDueSoon()) {
        stats.sla.dueSoon++;
      } else {
        stats.sla.onTrack++;
      }
      
      // Assignment
      if (ticket.assignedTo) {
        stats.assignment.assigned++;
      } else {
        stats.assignment.unassigned++;
      }
      
      // Resolution time
      if (ticket.status === 'resolved' || ticket.status === 'closed') {
        stats.resolution.resolvedCount++;
        if (ticket.resolvedAt) {
          const resolutionTime = new Date(ticket.resolvedAt) - new Date(ticket.createdAt);
          totalResolutionTime += resolutionTime;
        }
      }
      
      // 🆕 Consultant stats
      if (ticket.consultantContext) {
        // By consultant admin
        if (ticket.consultantContext.consultantAdminId) {
          const adminId = ticket.consultantContext.consultantAdminId.toString();
          if (!stats.consultant.byConsultantAdmin[adminId]) {
            stats.consultant.byConsultantAdmin[adminId] = {
              consultantAdminId: adminId,
              consultantAdminName: ticket.consultantContext.consultantAdminName,
              total: 0,
              open: 0,
              resolved: 0,
              closed: 0
            };
          }
          stats.consultant.byConsultantAdmin[adminId].total++;
          if (ticket.status === 'open' || ticket.status === 'assigned' || ticket.status === 'in_progress') {
            stats.consultant.byConsultantAdmin[adminId].open++;
          } else if (ticket.status === 'resolved') {
            stats.consultant.byConsultantAdmin[adminId].resolved++;
          } else if (ticket.status === 'closed') {
            stats.consultant.byConsultantAdmin[adminId].closed++;
          }
        }
        
        // By assigned consultant
        if (ticket.consultantContext.assignedConsultantId) {
          const consultantId = ticket.consultantContext.assignedConsultantId.toString();
          if (!stats.consultant.byAssignedConsultant[consultantId]) {
            stats.consultant.byAssignedConsultant[consultantId] = {
              consultantId: consultantId,
              consultantName: ticket.consultantContext.assignedConsultantName,
              total: 0,
              open: 0,
              resolved: 0,
              closed: 0
            };
          }
          stats.consultant.byAssignedConsultant[consultantId].total++;
          if (ticket.status === 'open' || ticket.status === 'assigned' || ticket.status === 'in_progress') {
            stats.consultant.byAssignedConsultant[consultantId].open++;
          } else if (ticket.status === 'resolved') {
            stats.consultant.byAssignedConsultant[consultantId].resolved++;
          } else if (ticket.status === 'closed') {
            stats.consultant.byAssignedConsultant[consultantId].closed++;
          }
        }
        
        // Consultant issues vs client issues
        if (ticket.consultantContext.isConsultantIssue) {
          stats.consultant.consultantIssues++;
        } else {
          stats.consultant.clientIssues++;
        }
      }
    }

    // Calculate average resolution time
    if (stats.resolution.resolvedCount > 0) {
      stats.resolution.avgResolutionTime = totalResolutionTime / stats.resolution.resolvedCount;
      // Convert to hours
      stats.resolution.avgResolutionTimeHours = stats.resolution.avgResolutionTime / (1000 * 60 * 60);
    }

    // Convert consultant stats objects to arrays
    stats.consultant.byConsultantAdmin = Object.values(stats.consultant.byConsultantAdmin);
    stats.consultant.byAssignedConsultant = Object.values(stats.consultant.byAssignedConsultant);

    res.json({
      success: true,
      stats,
      query: {
        clientId,
        fromDate,
        toDate,
        consultantAdminId,
        assignedConsultantId,
        userType: req.user.userType
      }
    });

  } catch (error) {
    console.error('Error getting ticket stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get statistics',
      error: error.message
    });
  }
};

/**
 * 🆕 Get consultant-specific ticket overview
 * GET /api/tickets/consultant-overview
 */
exports.getConsultantOverview = async (req, res) => {
  try {
    const userId = getUserId(req.user);

    // Only consultants and consultant_admins can use this endpoint
    if (!['consultant', 'consultant_admin'].includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: 'This endpoint is only for consultants and consultant admins'
      });
    }

    const overview = {
      myIssues: { total: 0, open: 0, resolved: 0, closed: 0 },
      clientIssues: { total: 0, open: 0, resolved: 0, closed: 0 },
      byClient: [],
      supportTeams: [],
      recentTickets: []
    };

    // Build query based on user type
    let myIssuesQuery, clientIssuesQuery;

    if (req.user.userType === 'consultant_admin') {
      // My issues - tickets I created
      myIssuesQuery = {
        createdBy: req.user._id,
        'consultantContext.isConsultantIssue': true
      };

      // Client issues - tickets from my clients
      clientIssuesQuery = {
        'consultantContext.consultantAdminId': req.user._id,
        'consultantContext.isConsultantIssue': { $ne: true }
      };

    } else { // consultant
      // My issues
      myIssuesQuery = {
        createdBy: req.user._id,
        'consultantContext.isConsultantIssue': true
      };

      // Client issues
      clientIssuesQuery = {
        'consultantContext.assignedConsultantId': req.user._id,
        'consultantContext.isConsultantIssue': { $ne: true }
      };
    }

    // Get tickets
    const [myIssuesTickets, clientIssuesTickets] = await Promise.all([
      Ticket.find(myIssuesQuery).lean(),
      Ticket.find(clientIssuesQuery).lean()
    ]);

    // Process my issues
    myIssuesTickets.forEach(ticket => {
      overview.myIssues.total++;
      if (['open', 'assigned', 'in_progress'].includes(ticket.status)) {
        overview.myIssues.open++;
      } else if (ticket.status === 'resolved') {
        overview.myIssues.resolved++;
      } else if (ticket.status === 'closed') {
        overview.myIssues.closed++;
      }
    });

    // Process client issues
    const clientStats = {};
    const supportTeamStats = {};

    for (const ticket of clientIssuesTickets) {
      overview.clientIssues.total++;
      
      if (['open', 'assigned', 'in_progress'].includes(ticket.status)) {
        overview.clientIssues.open++;
      } else if (ticket.status === 'resolved') {
        overview.clientIssues.resolved++;
      } else if (ticket.status === 'closed') {
        overview.clientIssues.closed++;
      }

      // Group by client
      if (!clientStats[ticket.clientId]) {
        clientStats[ticket.clientId] = {
          clientId: ticket.clientId,
          total: 0,
          open: 0,
          resolved: 0,
          closed: 0
        };
      }
      clientStats[ticket.clientId].total++;
      if (['open', 'assigned', 'in_progress'].includes(ticket.status)) {
        clientStats[ticket.clientId].open++;
      } else if (ticket.status === 'resolved') {
        clientStats[ticket.clientId].resolved++;
      } else if (ticket.status === 'closed') {
        clientStats[ticket.clientId].closed++;
      }

      // Track support teams
      if (ticket.supportManagerId) {
        const smId = ticket.supportManagerId.toString();
        if (!supportTeamStats[smId]) {
          supportTeamStats[smId] = {
            supportManagerId: smId,
            tickets: 0
          };
        }
        supportTeamStats[smId].tickets++;
      }
    }

    overview.byClient = Object.values(clientStats);
    overview.supportTeams = Object.values(supportTeamStats);

    // Get recent tickets (last 10)
    const allTickets = [...myIssuesTickets, ...clientIssuesTickets];
    overview.recentTickets = allTickets
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 10)
      .map(t => ({
        ticketId: t.ticketId,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        clientId: t.clientId,
        createdAt: t.createdAt,
        isMyIssue: t.consultantContext?.isConsultantIssue || false
      }));

    // Populate support manager details
    const supportManagerIds = overview.supportTeams.map(st => st.supportManagerId);
    if (supportManagerIds.length > 0) {
      const supportManagers = await User.find({
        _id: { $in: supportManagerIds }
      }).select('userName email supportTeamName').lean();

      const smMap = {};
      supportManagers.forEach(sm => {
        smMap[sm._id.toString()] = sm;
      });

      overview.supportTeams = overview.supportTeams.map(st => ({
        ...st,
        supportManager: smMap[st.supportManagerId] || null
      }));
    }

    // Get client names
    const clientIds = overview.byClient.map(c => c.clientId);
    if (clientIds.length > 0) {
      const clients = await Client.find({
        clientId: { $in: clientIds }
      }).select('clientId leadInfo.companyName').lean();

      const clientMap = {};
      clients.forEach(c => {
        clientMap[c.clientId] = c.leadInfo?.companyName || c.clientId;
      });

      overview.byClient = overview.byClient.map(c => ({
        ...c,
        companyName: clientMap[c.clientId] || c.clientId
      }));
    }

    res.json({
      success: true,
      overview,
      userType: req.user.userType
    });

  } catch (error) {
    console.error('Error getting consultant overview:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get consultant overview',
      error: error.message
    });
  }
};


/**
 * Get ticket details
 * GET /api/tickets/:id
 */
exports.getTicket = async (req, res) => {
  try {
    const { id } = req.params;

    const ticket = await findTicketByIdOrTicketId(id)
      .populate('createdBy', 'userName email userType contactNumber')
      .populate('assignedTo', 'userName email userType contactNumber')
      .populate('supportManagerId', 'userName email userType supportTeamName supportManagerType')
      .populate('watchers', 'userName email userType')
      .populate('consultantContext.consultantAdminId', 'userName email userType teamName')
      .populate('consultantContext.assignedConsultantId', 'userName email userType employeeId')
      .populate('escalatedBy', 'userName email userType')
      .populate('resolution.resolvedBy', 'userName email userType')
      .populate('approvedBy', 'userName email userType');

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Check access
    const access = await canViewTicket(req.user, ticket);
    if (!access.allowed) {
      return res.status(403).json({
        success: false,
        message: access.reason || 'Access denied'
      });
    }

    // Record view
    ticket.recordView(req.user._id);
    await ticket.save();

    // Get activities
    const activities = await TicketActivity.find({ 
      ticket: ticket._id,
      isDeleted: false
    })
      .populate('createdBy', 'userName email userType')
      .populate('comment.mentions', 'userName email')
      .sort({ createdAt: -1 })
      .lean();

    // Calculate SLA info
    const slaInfo = {
      dueDate: ticket.dueDate,
      isOverdue: ticket.isOverdue(),
      isDueSoon: ticket.isDueSoon(),
      timeRemaining: ticket.getTimeRemaining(),
      timeRemainingHours: ticket.getTimeRemaining() ? ticket.getTimeRemaining() / (1000 * 60 * 60) : null
    };

    res.json({
      success: true,
      ticket,
      activities,
      slaInfo
    });

  } catch (error) {
    console.error('Error getting ticket:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch ticket',
      error: error.message
    });
  }
};

/**
 * Update ticket
 * PATCH /api/tickets/:id
 */
exports.updateTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = getUserId(req.user);

const ticket = await findTicketByIdOrTicketId(id);    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Check permissions
    const canModify = await canModifyTicket(req.user, ticket);
    if (!canModify.allowed) {
      return res.status(403).json({
        success: false,
        message: canModify.reason || 'Access denied'
      });
    }

    // Track changes for activity log
    const changes = [];

    // Allowed fields for update
    const allowedFields = ['subject', 'description', 'category', 'subCategory', 'tags', 'priority'];
    
    // Admin/support users can also update status and assignment
    const adminFields = ['status', 'priority'];
    if (['super_admin', 'supportManager', 'support'].includes(req.user.userType)) {
      allowedFields.push(...adminFields);
    }

    // Limited updates for regular users
    if (canModify.limited) {
      // Regular users can only update basic fields
      const limitedFields = ['subject', 'description', 'tags'];
      Object.keys(req.body).forEach(key => {
        if (!limitedFields.includes(key)) {
          delete req.body[key];
        }
      });
    }

    // Update fields and track changes
    for (const field of allowedFields) {
      if (req.body[field] !== undefined && req.body[field] !== ticket[field]) {
        changes.push({
          field,
          oldValue: typeof ticket[field] === 'object' ? JSON.stringify(ticket[field]) : String(ticket[field]),
          newValue: typeof req.body[field] === 'object' ? JSON.stringify(req.body[field]) : String(req.body[field])
        });
        ticket[field] = req.body[field];
      }
    }

    if (changes.length === 0) {
      return res.json({
        success: true,
        message: 'No changes to update',
        ticket
      });
    }

    await ticket.save();

    // Log update activity
    if (changes.length > 0) {
      await logActivity(
        ticket._id,
        'status_change',
        { changes },
        userId,
        req.user.userType
      );
    }

    // Emit socket event
    emitTicketEvent('ticket-updated', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      ticket: ticket.toObject(),
      changes
    });

    // Notify about changes
    try {
      await notifyTicketStatusChanged(ticket, req.user, changes);
    } catch (notifyError) {
      console.error('[TICKET] Error sending notifications:', notifyError);
    }

    await ticket.populate([
      { path: 'createdBy', select: 'userName email userType' },
      { path: 'assignedTo', select: 'userName email userType' },
      { path: 'supportManagerId', select: 'userName email userType supportTeamName' }
    ]);

    res.json({
      success: true,
      message: 'Ticket updated successfully',
      ticket,
      changes
    });

  } catch (error) {
    console.error('Error updating ticket:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update ticket',
      error: error.message
    });
  }
};

/**
 * Delete ticket
 * DELETE /api/tickets/:id
 */
exports.deleteTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = getUserId(req.user);

const ticket = await findTicketByIdOrTicketId(id);    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Only super_admin or creator (for drafts) can delete
    const canDelete = req.user.userType === 'super_admin' || 
                     (ticket.createdBy.toString() === userId && ticket.status === 'draft');

    if (!canDelete) {
      return res.status(403).json({
        success: false,
        message: 'Only super admin or ticket creator (for drafts) can delete tickets'
      });
    }

    // Delete attachments from S3
    if (ticket.attachments && ticket.attachments.length > 0) {
      try {
        await deleteMultipleAttachments(ticket.attachments);
      } catch (s3Error) {
        console.error('Error deleting attachments from S3:', s3Error);
        // Continue with ticket deletion even if S3 deletion fails
      }
    }

    // Delete associated activities
    await TicketActivity.deleteMany({ ticket: ticket._id });

    // Delete ticket
    await Ticket.findByIdAndDelete(id);

    // Emit socket event
    emitTicketEvent('ticket-deleted', {
      clientId: ticket.clientId,
      ticketId: ticket._id
    });

    res.json({
      success: true,
      message: 'Ticket deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting ticket:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete ticket',
      error: error.message
    });
  }
};

// ===== WORKFLOW OPERATIONS =====

/**
 * Add comment to ticket
 * POST /api/tickets/:id/comments
 */
exports.addComment = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = getUserId(req.user);
    const { text, isInternal = false, mentions = [] } = req.body;

    if (!text || text.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Comment text is required'
      });
    }

    const ticket = await findTicketByIdOrTicketId(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Check access
    const access = await canViewTicket(req.user, ticket);
    if (!access.allowed) {
      return res.status(403).json({
        success: false,
        message: access.reason || 'Access denied'
      });
    }

    // Handle attachments if present
    let attachments = [];
    if (req.files && req.files.length > 0) {
      attachments = await saveTicketAttachments(req, {
        clientId: ticket.clientId,
        ticketId: ticket.ticketId,
        userId,
        type: 'comment'
      });
    }

    // Create activity
    const activity = new TicketActivity({
      ticket: ticket._id,
      activityType: 'comment',
      comment: {
        text,
        isInternal,
        mentions
      },
      attachments,
      createdBy: userId,
      createdByType: req.user.userType
    });

    await activity.save();

    // Update ticket's firstResponseAt if this is first response from support
    if (!ticket.firstResponseAt && ['support', 'supportManager'].includes(req.user.userType)) {
      ticket.firstResponseAt = new Date();
      await ticket.save();
    }

    // Emit socket event
    emitTicketEvent('ticket-commented', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      activity: activity.toObject()
    });

    // Send notifications
    try {
        const commenter = await User.findById(userId).select('_id userName email userType');
    // notifyTicketCommented signature is: (ticket, activity, commenter)
    await notifyTicketCommented(ticket, activity, commenter || req.user);

    } catch (notifyError) {
      console.error('[TICKET] Error sending comment notifications:', notifyError);
    }

    await activity.populate('createdBy', 'userName email userType');

    res.status(201).json({
      success: true,
      message: 'Comment added successfully',
      activity
    });

  } catch (error) {
    console.error('Error adding comment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add comment',
      error: error.message
    });
  }
};

/**
 * Assign ticket to support user
 * POST /api/tickets/:id/assign
 */
exports.assignTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = getUserId(req.user);
    const { assignTo } = req.body;

    if (!assignTo) {
      return res.status(400).json({
        success: false,
        message: 'assignTo is required'
      });
    }

    const ticket = await findTicketByIdOrTicketId(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Check permissions
    const canAssign = await canAssignTicket(req.user, ticket);
    if (!canAssign.allowed) {
      return res.status(403).json({
        success: false,
        message: canAssign.reason || 'Access denied'
      });
    }

    // Get assignee user
    const assignee = await User.findById(assignTo);
    if (!assignee) {
      return res.status(404).json({
        success: false,
        message: 'Assignee user not found'
      });
    }

    // Validate assignment based on user type
    if (req.user.userType === 'supportManager') {
      // Support manager can only assign to their team members
      if (assignee.userType !== 'support' || assignee.supportManagerId?.toString() !== userId) {
        return res.status(400).json({
          success: false,
          message: 'Support managers can only assign to their team members'
        });
      }
    }

    // Track changes
    const oldAssignee = ticket.assignedTo ? ticket.assignedTo.toString() : null;
    const oldAssigneeType = ticket.assignedToType;

    // Update assignment
    ticket.assignedTo = assignee._id;
    ticket.assignedToType = assignee.userType;
    ticket.status = 'assigned';

    await ticket.save();

    // Log activity
    await logActivity(
      ticket._id,
      'assignment',
      {
        changes: [{
          field: 'assignedTo',
          oldValue: oldAssignee || 'unassigned',
          newValue: assignee._id.toString()
        }]
      },
      userId,
      req.user.userType
    );

    // Emit socket event
    emitTicketEvent('ticket-assigned', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      ticket: ticket.toObject(),
      assignedTo: assignee._id
    });

    // Send notifications
    try {
      await notifyTicketAssigned(ticket, assignee, req.user);
      await notifySupportUserAssigned(ticket, assignee);
    } catch (notifyError) {
      console.error('[TICKET] Error sending assignment notifications:', notifyError);
    }

    await ticket.populate([
      { path: 'assignedTo', select: 'userName email userType' },
      { path: 'supportManagerId', select: 'userName email userType supportTeamName' }
    ]);

    res.json({
      success: true,
      message: 'Ticket assigned successfully',
      ticket
    });

  } catch (error) {
    console.error('Error assigning ticket:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to assign ticket',
      error: error.message
    });
  }
};

/**
 * Escalate ticket
 * POST /api/tickets/:id/escalate
 */
exports.escalateTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = getUserId(req.user);
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'Escalation reason is required'
      });
    }

    const ticket = await findTicketByIdOrTicketId(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Check permissions
    const access = await canViewTicket(req.user, ticket);
    if (!access.allowed) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Update escalation
    ticket.isEscalated = true;
    ticket.escalatedAt = new Date();
    ticket.escalatedBy = userId;
    ticket.escalationReason = reason;
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

    await ticket.save();

    // Log activity
    await logActivity(
      ticket._id,
      'escalation',
      {
        changes: [{
          field: 'escalated',
          oldValue: 'false',
          newValue: 'true'
        }, {
          field: 'escalationLevel',
          oldValue: String((ticket.escalationLevel || 1) - 1),
          newValue: String(ticket.escalationLevel)
        }]
      },
      userId,
      req.user.userType
    );

    // Emit socket event
    emitTicketEvent('ticket-escalated', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      ticket: ticket.toObject()
    });

    // Send notifications
    try {
      await notifyTicketEscalated(ticket, reason, req.user);
    } catch (notifyError) {
      console.error('[TICKET] Error sending escalation notifications:', notifyError);
    }

    await ticket.populate([
      { path: 'createdBy', select: 'userName email userType' },
      { path: 'escalatedBy', select: 'userName email userType' }
    ]);

    res.json({
      success: true,
      message: 'Ticket escalated successfully',
      ticket
    });

  } catch (error) {
    console.error('Error escalating ticket:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to escalate ticket',
      error: error.message
    });
  }
};

/**
 * Resolve ticket
 * POST /api/tickets/:id/resolve
 */
exports.resolveTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = getUserId(req.user);
    const { resolutionNotes } = req.body;

    const ticket = await findTicketByIdOrTicketId(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Check permissions
    const canResolve = await canResolveTicket(req.user, ticket);
    if (!canResolve.allowed) {
      return res.status(403).json({
        success: false,
        message: canResolve.reason || 'Access denied'
      });
    }

    // Update ticket
    ticket.status = 'resolved';
    ticket.resolvedAt = new Date();
    ticket.resolution = {
      resolvedBy: userId,
      resolutionNotes,
      resolutionDate: new Date()
    };

    await ticket.save();

    // Log activity
    await logActivity(
      ticket._id,
      'resolution',
      {
        changes: [{
          field: 'status',
          oldValue: 'in_progress',
          newValue: 'resolved'
        }]
      },
      userId,
      req.user.userType
    );

    // Emit socket event
    emitTicketEvent('ticket-resolved', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      ticket: ticket.toObject()
    });

    // Send notifications
    try {
      await notifyTicketResolved(ticket, req.user);
    } catch (notifyError) {
      console.error('[TICKET] Error sending resolution notifications:', notifyError);
    }

    await ticket.populate([
      { path: 'resolution.resolvedBy', select: 'userName email userType' }
    ]);

    res.json({
      success: true,
      message: 'Ticket resolved successfully',
      ticket
    });

  } catch (error) {
    console.error('Error resolving ticket:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to resolve ticket',
      error: error.message
    });
  }
};

/**
 * Close ticket
 * POST /api/tickets/:id/close
 */
exports.closeTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = getUserId(req.user);
    const { satisfactionRating, userFeedback } = req.body;

    const ticket = await findTicketByIdOrTicketId(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Check permissions
    const canClose = await canCloseTicket(req.user, ticket);
    if (!canClose.allowed) {
      return res.status(403).json({
        success: false,
        message: canClose.reason || 'Access denied'
      });
    }

    // Ticket must be resolved before closing
    if (ticket.status !== 'resolved') {
      return res.status(400).json({
        success: false,
        message: 'Ticket must be resolved before closing'
      });
    }

    // Update ticket
    ticket.status = 'closed';
    ticket.closedAt = new Date();
    
    if (satisfactionRating) {
      ticket.resolution.satisfactionRating = satisfactionRating;
    }
    if (userFeedback) {
      ticket.resolution.userFeedback = userFeedback;
    }

    await ticket.save();

    // Log activity
    await logActivity(
      ticket._id,
      'status_change',
      {
        changes: [{
          field: 'status',
          oldValue: 'resolved',
          newValue: 'closed'
        }]
      },
      userId,
      req.user.userType
    );

    // Emit socket event
    emitTicketEvent('ticket-closed', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      ticket: ticket.toObject()
    });

    res.json({
      success: true,
      message: 'Ticket closed successfully',
      ticket
    });

  } catch (error) {
    console.error('Error closing ticket:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to close ticket',
      error: error.message
    });
  }
};

/**
 * Reopen ticket
 * POST /api/tickets/:id/reopen
 */
exports.reopenTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = getUserId(req.user);
    const { reason } = req.body;

    const ticket = await findTicketByIdOrTicketId(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Check access
    const access = await canViewTicket(req.user, ticket);
    if (!access.allowed) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Can only reopen resolved or closed tickets
    if (!['resolved', 'closed'].includes(ticket.status)) {
      return res.status(400).json({
        success: false,
        message: 'Can only reopen resolved or closed tickets'
      });
    }

    // Update ticket
    const oldStatus = ticket.status;
    ticket.status = 'reopened';
    ticket.resolvedAt = null;
    ticket.closedAt = null;

    await ticket.save();

    // Log activity
    await logActivity(
      ticket._id,
      'reopened',
      {
        changes: [{
          field: 'status',
          oldValue: oldStatus,
          newValue: 'reopened'
        }, {
          field: 'reason',
          oldValue: null,
          newValue: reason || 'No reason provided'
        }]
      },
      userId,
      req.user.userType
    );

    // Emit socket event
    emitTicketEvent('ticket-reopened', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      ticket: ticket.toObject()
    });

    res.json({
      success: true,
      message: 'Ticket reopened successfully',
      ticket
    });

  } catch (error) {
    console.error('Error reopening ticket:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reopen ticket',
      error: error.message
    });
  }
};

// ===== ATTACHMENT OPERATIONS =====

/**
 * Upload attachments to ticket
 * POST /api/tickets/:id/attachments
 */
exports.uploadAttachment = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = getUserId(req.user);

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No files provided'
      });
    }

    const ticket = await findTicketByIdOrTicketId(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Check access
    const access = await canViewTicket(req.user, ticket);
    if (!access.allowed) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Save attachments
    const attachments = await saveTicketAttachments(req, {
      clientId: ticket.clientId,
      ticketId: ticket.ticketId,
      userId,
      type: 'ticket'
    });

    // Add to ticket
    ticket.attachments = [...(ticket.attachments || []), ...attachments];
    await ticket.save();

    // Log activity
    await logActivity(
      ticket._id,
      'attachment',
      { attachments },
      userId,
      req.user.userType
    );

    // Emit socket event
    emitTicketEvent('ticket-attachment-added', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      attachments
    });

    res.json({
      success: true,
      message: 'Attachments uploaded successfully',
      attachments
    });

  } catch (error) {
    console.error('Error uploading attachments:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload attachments',
      error: error.message
    });
  }
};

/**
 * Delete attachment from ticket
 * DELETE /api/tickets/:id/attachments/:attachmentId
 */
exports.deleteAttachment = async (req, res) => {
  try {
    const { id, attachmentId } = req.params;
    const userId = getUserId(req.user);

    const ticket = await findTicketByIdOrTicketId(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Check permissions
    const canModify = await canModifyTicket(req.user, ticket);
    if (!canModify.allowed) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Find attachment
    const attachment = ticket.attachments.id(attachmentId);
    if (!attachment) {
      return res.status(404).json({
        success: false,
        message: 'Attachment not found'
      });
    }

    // Delete from S3
    try {
      await deleteTicketAttachment(attachment);
    } catch (s3Error) {
      console.error('Error deleting from S3:', s3Error);
      // Continue with removal from database even if S3 deletion fails
    }

    // Remove from ticket
    ticket.attachments.pull(attachmentId);
    await ticket.save();

    // Emit socket event
    emitTicketEvent('ticket-attachment-deleted', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      attachmentId
    });

    res.json({
      success: true,
      message: 'Attachment deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting attachment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete attachment',
      error: error.message
    });
  }
};

// ===== WATCHER OPERATIONS =====

/**
 * Add watcher to ticket
 * POST /api/tickets/:id/watchers
 */
exports.addWatcher = async (req, res) => {
  try {
    const { id } = req.params;
    const { watcherId } = req.body;
    const userId = getUserId(req.user);

    if (!watcherId) {
      return res.status(400).json({
        success: false,
        message: 'watcherId is required'
      });
    }

    const ticket = await findTicketByIdOrTicketId(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Check access
    const access = await canViewTicket(req.user, ticket);
    if (!access.allowed) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Verify watcher user exists
    const watcher = await User.findById(watcherId);
    if (!watcher) {
      return res.status(404).json({
        success: false,
        message: 'Watcher user not found'
      });
    }

    // Add watcher
    ticket.addWatcher(watcherId);
    await ticket.save();

    // Log activity
    await logActivity(
      ticket._id,
      'watcher_change',
      {
        changes: [{
          field: 'watcher_added',
          oldValue: null,
          newValue: watcher.userName
        }]
      },
      userId,
      req.user.userType
    );

    res.json({
      success: true,
      message: 'Watcher added successfully',
      watchers: ticket.watchers
    });

  } catch (error) {
    console.error('Error adding watcher:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add watcher',
      error: error.message
    });
  }
};

/**
 * Remove watcher from ticket
 * DELETE /api/tickets/:id/watchers/:watcherId
 */
exports.removeWatcher = async (req, res) => {
  try {
    const { id, watcherId } = req.params;
    const userId = getUserId(req.user);

    const ticket = await findTicketByIdOrTicketId(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Check access
    const access = await canViewTicket(req.user, ticket);
    if (!access.allowed) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Get watcher name for logging
    const watcher = await User.findById(watcherId);

    // Remove watcher
    ticket.removeWatcher(watcherId);
    await ticket.save();

    // Log activity
    await logActivity(
      ticket._id,
      'watcher_change',
      {
        changes: [{
          field: 'watcher_removed',
          oldValue: watcher ? watcher.userName : watcherId,
          newValue: null
        }]
      },
      userId,
      req.user.userType
    );

    res.json({
      success: true,
      message: 'Watcher removed successfully',
      watchers: ticket.watchers
    });

  } catch (error) {
    console.error('Error removing watcher:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove watcher',
      error: error.message
    });
  }
};

module.exports = exports;