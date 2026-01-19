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
  notifySupportUserAssigned
} = require('../../utils/notifications/ticketNotifications');

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
  if (!io || !data.clientId) return;

  const payload = {
    eventType,
    timestamp: new Date().toISOString(),
    ...data
  };

  // Emit to client room
  io.to(`client_${data.clientId}`).emit(eventType, payload);
  
  // Emit to ticket-specific room if ticketId exists
  if (data.ticketId || data._id) {
    const ticketRoomId = data._id ? data._id.toString() : data.ticketId;
    io.to(`ticket_${ticketRoomId}`).emit(eventType, payload);
  }

  console.log(`[TICKET] Emitted ${eventType} to client_${data.clientId}`);
}

// ===== HELPER FUNCTIONS =====

async function checkTicketAccess(user, ticket) {
  const userId = user._id.toString();
  const userType = user.userType;

  // Super admin - full access
  if (userType === 'super_admin') {
    return true;
  }

  // Support Manager - can access tickets assigned to them
  if (userType === 'supportManager') {
    // Check if this support manager is assigned to the ticket
    if (ticket.supportManagerId?.toString() === userId) {
      return true;
    }
    
    // General support managers can see all tickets
    if (user.supportManagerType === 'general_support') {
      return true;
    }
    
    return false;
  }

  // Support User - can access tickets assigned to them or managed by their manager
  if (userType === 'support') {
    // Can view if assigned to them
    if (ticket.assignedTo?.toString() === userId) {
      return true;
    }
    
    // Can view if they're a watcher
    if (ticket.watchers?.some(w => w.toString() === userId)) {
      return true;
    }
    
    // Can view if ticket is managed by their support manager
    if (user.supportManagerId && ticket.supportManagerId?.toString() === user.supportManagerId.toString()) {
      return true;
    }
    
    return false;
  }

  // Consultant admin - tickets for clients they created
  if (userType === 'consultant_admin') {
    // Can access own tickets
    if (ticket.createdBy.toString() === userId) {
      return true;
    }
    
    const client = await Client.findOne({ 
      clientId: ticket.clientId,
      'leadInfo.createdBy': userId
    });
    return !!client;
  }

  // Consultant - tickets for assigned clients or own tickets
  if (userType === 'consultant') {
    // Can access own tickets
    if (ticket.createdBy.toString() === userId) {
      return true;
    }
    
    const client = await Client.findOne({ 
      clientId: ticket.clientId,
      'workflowTracking.assignedConsultantId': userId
    });
    
    if (client) return true;
    
    // Also if assigned to the ticket
    if (ticket.assignedTo?.toString() === userId) {
      return true;
    }
    
    return false;
  }

  // Client users - tickets for their client only
  if (['client_admin', 'client_employee_head', 'employee', 'viewer', 'auditor'].includes(userType)) {
    // Check if ticket belongs to user's client
    if (ticket.clientId !== user.clientId) {
      return false;
    }

    // Client admin - can view all client tickets
    if (userType === 'client_admin') {
      return true;
    }

    // Auditor - can view all client tickets
    if (userType === 'auditor') {
      return true;
    }

    // Employee head - can view department tickets
    if (userType === 'client_employee_head') {
      const creator = await User.findById(ticket.createdBy);
      if (!creator) return false;
      return creator.department === user.department;
    }

    // Employee/Viewer - only own tickets
    if (userType === 'employee' || userType === 'viewer') {
      return ticket.createdBy.toString() === userId;
    }
  }

  return false;
}

/**
 * Normalize user ID (handle both req.user.id and req.user._id)
 */
function getUserId(user) {
  return user.id || user._id?.toString() || user._id;
}

/**
 * Get support manager for a ticket creator
 * Returns supportManagerId based on user type
 */
async function getSupportManagerForUser(user, clientId = null) {
  try {
    const userType = user.userType;
    
    // For client-side users (client_admin, employee_head, employee, auditor)
    if (['client_admin', 'client_employee_head', 'employee', 'auditor'].includes(userType)) {
      // Get support manager from client
      if (clientId || user.clientId) {
        const client = await Client.findOne({ clientId: clientId || user.clientId });
        if (client?.supportSection?.assignedSupportManagerId) {
          return client.supportSection.assignedSupportManagerId;
        }
      }
      
      // Fallback: Get from user's supportManagerId if exists
      if (user.supportManagerId) {
        return user.supportManagerId;
      }
    }
    
    // For consultant/consultant_admin - use their assigned supportManager
    if (['consultant', 'consultant_admin'].includes(userType)) {
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
 * Check if user can access client's tickets
 */
async function canAccessClientTickets(user, clientId) {
  const userId = getUserId(user);
  
  // Super admin can access all
  if (user.userType === 'super_admin') {
    return { allowed: true, reason: 'Super admin access' };
  }

  // Support managers can access tickets they manage
  if (user.userType === 'supportManager') {
    // Check if managing this client
    if (user.assignedSupportClients?.includes(clientId)) {
      return { allowed: true, reason: 'Support manager access' };
    }
    
    // General support can access all
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
  }

  // Consultant: Can access if assigned to the client
  if (user.userType === 'consultant') {
    const assignedConsultantId = client.workflowTracking?.assignedConsultantId?.toString();
    const consultantAdminId = client.leadInfo?.consultantAdminId?.toString();
    const consultantAdmins = await User.find({ 
      _id: consultantAdminId, 
      userType: 'consultant_admin' 
    });
    
    if (assignedConsultantId === userId) {
      return { allowed: true, reason: 'Assigned consultant access' };
    }
    
    // Check if consultant belongs to the same consultant_admin team
    for (const admin of consultantAdmins) {
      const teamConsultants = await User.find({
        consultantAdminId: admin._id,
        userType: 'consultant'
      });
      
      if (teamConsultants.some(c => c._id.toString() === userId)) {
        return { allowed: true, reason: 'Team consultant access' };
      }
    }
  }

  return { allowed: false, reason: 'Access denied' };
}

/**
 * Check if user can create tickets for a client
 */
async function canCreateTicket(user, clientId) {
  const userId = getUserId(user);
  
  // Super admin can create for any client
  if (user.userType === 'super_admin') {
    return { allowed: true };
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

  // Consultants can create tickets for assigned clients
  const access = await canAccessClientTickets(user, clientId);
  if (access.allowed) {
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
  if (user.userType === 'client_admin' && user.clientId === ticket.clientId) {
    return { allowed: true };
  }

  // Consultant admin can modify tickets for their clients
  if (user.userType === 'consultant_admin') {
    const access = await canAccessClientTickets(user, ticket.clientId);
    if (access.allowed) {
      return { allowed: true };
    }
  }

  // Consultant can modify if assigned
  if (user.userType === 'consultant') {
    if (ticket.assignedTo && ticket.assignedTo.toString() === userId) {
      return { allowed: true };
    }
    
    // Or if they have access to the client
    const access = await canAccessClientTickets(user, ticket.clientId);
    if (access.allowed) {
      return { allowed: true };
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

  // Support manager can assign tickets managed by them
  if (user.userType === 'supportManager') {
    if (ticket.supportManagerId?.toString() === userId) {
      return { allowed: true };
    }
  }

  // Client admin can assign within their client (limited)
  if (user.userType === 'client_admin' && user.clientId === ticket.clientId) {
    return { allowed: true, limited: true };
  }

  // Consultant admin can assign tickets for their clients (limited)
  if (user.userType === 'consultant_admin') {
    const access = await canAccessClientTickets(user, ticket.clientId);
    if (access.allowed) {
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

  // Consultant admin can resolve
  if (user.userType === 'consultant_admin') {
    const access = await canAccessClientTickets(user, ticket.clientId);
    if (access.allowed) {
      return { allowed: true };
    }
  }

  // Consultant can resolve if assigned
  if (user.userType === 'consultant') {
    if (ticket.assignedTo && ticket.assignedTo.toString() === userId) {
      return { allowed: true };
    }
  }

  return { allowed: false, reason: 'No permission to resolve tickets' };
}

/**
 * Check if comment should be visible to user
 */
function canViewComment(user, activity) {
  // Internal comments are only visible to support roles
  if (activity.comment?.isInternal) {
    const supportRoles = ['super_admin', 'consultant_admin', 'consultant', 'supportManager', 'support'];
    return supportRoles.includes(user.userType);
  }
  return true;
}

/**
 * Log ticket activity
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
 * Create a new ticket
 * POST /api/tickets
 * 
 * UPDATED LOGIC:
 * - For client-side users (client_admin, employee_head, employee, auditor): 
 *   Auto-assign to client's supportManager
 * - For consultant-side users (consultant, consultant_admin): 
 *   Auto-assign to consultant's supportManager
 * - SupportManager must review and assign to support user
 */
exports.createTicket = async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { clientId } = req.body;

    // Validate required fields
    if (!clientId) {
      return res.status(400).json({
        success: false,
        message: 'clientId is required'
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

    // Verify client exists
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
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
    const isSandbox = client.sandbox === true || req.user.sandbox === true;

    // ===== AUTO-ASSIGN TO SUPPORT MANAGER =====
    let assignedSupportManagerId = null;
    
    // Get the appropriate support manager based on user type
    assignedSupportManagerId = await getSupportManagerForUser(req.user, clientId);
    
    if (!assignedSupportManagerId) {
      console.warn(`[TICKET] No support manager found for user ${req.user.userName} (${req.user.userType}), clientId: ${clientId}`);
      // Don't fail ticket creation, just log warning
    }

    // Create ticket with supportManagerId assigned
    const ticket = new Ticket({
      ticketId,
      clientId,
      createdBy: userId,
      createdByType: req.user.userType,
      supportManagerId: assignedSupportManagerId, // Auto-assign to support manager
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

    // Handle file attachments if present
    if (req.files && req.files.length > 0) {
      const attachments = await saveTicketAttachments(req, {
        clientId,
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

    // ===== NOTIFY SUPPORT MANAGER =====
    if (assignedSupportManagerId) {
      const supportManager = await User.findById(assignedSupportManagerId);
      
      if (supportManager) {
        console.log(`[TICKET] Notifying support manager ${supportManager.userName} about new ticket ${ticket.ticketId}`);
        
        // Send notification to support manager
        try {
          await notifySupportManagerNewTicket(ticket, supportManager, req.user);
        } catch (notifyError) {
          console.error('[TICKET] Error notifying support manager:', notifyError);
          // Don't fail ticket creation if notification fails
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

    // Emit socket event
    emitTicketEvent('ticket-created', {
      clientId,
      ticketId: ticket._id,
      ticket: ticket.toObject()
    });

    // Send general notifications
    try {
      await notifyTicketCreated(ticket, req.user);
    } catch (notifyError) {
      console.error('[TICKET] Error sending general notifications:', notifyError);
      // Don't fail ticket creation
    }

    // Populate references before sending response
    await ticket.populate('createdBy', 'userName email userType');
    if (ticket.supportManagerId) {
      await ticket.populate('supportManagerId', 'userName email userType supportTeamName supportManagerType');
    }

    res.status(201).json({
      success: true,
      message: 'Ticket created successfully',
      ticket,
      supportManagerAssigned: !!assignedSupportManagerId
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
 * List tickets with filters and pagination
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
      sortOrder = 'desc'
    } = req.query;

    // Build query
    const query = {};

    // Client ID filter (required for non-super_admin)
    if (req.user.userType === 'super_admin') {
      if (clientId) {
        query.clientId = clientId;
      }
    } 
    // Support manager filtering - tickets assigned to them
    else if (req.user.userType === 'supportManager') {
      query.supportManagerId = userId;
      
      if (clientId) {
        query.clientId = clientId;
      }
    }
    // Support user filtering - only their assigned tickets or where they're watchers
    else if (req.user.userType === 'support') {
      query.$or = [
        { assignedTo: userId },
        { watchers: userId },
        { supportManagerId: req.user.supportManagerId } // Can see tickets managed by their manager
      ];
      
      if (clientId) {
        query.clientId = clientId;
      }
    }
    else {
      // For client users, filter by their client
      if (req.user.clientId) {
        query.clientId = req.user.clientId;
      } else {
        // For consultants, need to find accessible clients
        const accessibleClients = await Client.find({
          $or: [
            { 'leadInfo.createdBy': userId }, // Consultant admin created
            { 'workflowTracking.assignedConsultantId': userId } // Consultant assigned
          ]
        }).distinct('clientId');

        if (accessibleClients.length === 0) {
          return res.status(200).json({
            success: true,
            tickets: [],
            pagination: {
              total: 0,
              page: 1,
              limit,
              pages: 0
            }
          });
        }

        if (clientId && accessibleClients.includes(clientId)) {
          query.clientId = clientId;
        } else if (!clientId) {
          query.clientId = { $in: accessibleClients };
        }
      }
    }

    // Additional filters
    if (status) {
      const statusArray = status.split(',').map(s => s.trim());
      query.status = statusArray.length > 1 ? { $in: statusArray } : statusArray[0];
    }

    if (priority) {
      const priorityArray = priority.split(',').map(p => p.trim());
      query.priority = priorityArray.length > 1 ? { $in: priorityArray } : priorityArray[0];
    }

    if (category) {
      query.category = category;
    }

    if (assignedTo) {
      query.assignedTo = assignedTo === 'me' ? userId : assignedTo;
    }

    if (createdBy) {
      query.createdBy = createdBy === 'me' ? userId : createdBy;
    }

    if (tags) {
      const tagsArray = tags.split(',').map(t => t.trim());
      query.tags = { $in: tagsArray };
    }

    if (hasAttachments === 'true') {
      query['attachments.0'] = { $exists: true };
    }

    // Date range
    if (fromDate || toDate) {
      query.createdAt = {};
      if (fromDate) query.createdAt.$gte = new Date(fromDate);
      if (toDate) query.createdAt.$lte = new Date(toDate);
    }

    // Search
    if (search) {
      query.$text = { $search: search };
    }

    // Count total matching documents
    const total = await Ticket.countDocuments(query);

    // Get paginated results
    const skip = (page - 1) * limit;
    let tickets = await Ticket.find(query)
      .populate('createdBy', 'userName email userType')
      .populate('assignedTo', 'userName email userType')
      .populate('supportManagerId', 'userName email supportTeamName supportManagerType')
      .sort({ [sortBy]: sortOrder === 'asc' ? 1 : -1 })
      .skip(skip)
      .limit(parseInt(limit));

    // Apply overdue/dueSoon filters (after query)
    if (overdue === 'true') {
      tickets = tickets.filter(t => t.isOverdue());
    }

    if (dueSoon === 'true') {
      tickets = tickets.filter(t => t.isDueSoon());
    }

    // Calculate pagination
    const pages = Math.ceil(total / limit);

    res.status(200).json({
      success: true,
      tickets,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages
      }
    });

  } catch (error) {
    console.error('Error listing tickets:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to list tickets',
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

    // Find ticket
    const ticket = await Ticket.findById(id)
      .populate('createdBy', 'userName email userType profileImage')
      .populate('assignedTo', 'userName email userType profileImage')
      .populate('supportManagerId', 'userName email userType supportTeamName supportManagerType profileImage')
      .populate('watchers', 'userName email userType profileImage');

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Check permissions
    const canView = await canViewTicket(req.user, ticket);
    if (!canView.allowed) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Record view
    ticket.recordView(req.user._id);
    await ticket.save();

    // Get ticket activities (filtered by visibility)
    let activities = await TicketActivity.find({ 
      ticket: ticket._id,
      isDeleted: false 
    })
      .populate('createdBy', 'userName email userType profileImage')
      .sort({ createdAt: -1 });

    // Filter out internal comments for non-support users
    activities = activities.filter(activity => canViewComment(req.user, activity));

    // Calculate SLA info
    const slaInfo = {
      dueDate: ticket.dueDate,
      isOverdue: ticket.isOverdue(),
      isDueSoon: ticket.isDueSoon(),
      timeRemaining: ticket.getTimeRemaining(),
      breached: ticket.metadata?.slaBreached || false
    };

    res.status(200).json({
      success: true,
      ticket,
      activities,
      slaInfo
    });

  } catch (error) {
    console.error('Error getting ticket:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get ticket details',
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
    const userId = getUserId(req.user);
    const { id } = req.params;

    // Find ticket
    const ticket = await Ticket.findById(id);
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
        message: canModify.reason || 'Access denied'
      });
    }

    // Fields that can be updated
    const allowedFields = canModify.limited 
      ? ['subject', 'description', 'tags']
      : ['subject', 'description', 'category', 'subCategory', 'tags', 'priority', 'status'];

    const updates = {};
    const changes = [];

    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        const oldValue = ticket[field];
        const newValue = req.body[field];
        
        if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
          updates[field] = newValue;
          changes.push({
            field,
            oldValue: JSON.stringify(oldValue),
            newValue: JSON.stringify(newValue)
          });
        }
      }
    });

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid updates provided'
      });
    }

    // Apply updates
    Object.assign(ticket, updates);
    await ticket.save();

    // Log activity
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
      updates
    });

    // Populate references
    await ticket.populate('createdBy', 'userName email userType');
    await ticket.populate('assignedTo', 'userName email userType');
    await ticket.populate('supportManagerId', 'userName email supportTeamName');

    res.status(200).json({
      success: true,
      message: 'Ticket updated successfully',
      ticket
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
    const userId = getUserId(req.user);
    const { id } = req.params;

    // Find ticket
    const ticket = await Ticket.findById(id);
    if (!ticket) {
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
        message: 'Only super admins or creators can delete draft tickets'
      });
    }

    // Delete attachments from S3
    if (ticket.attachments && ticket.attachments.length > 0) {
      await deleteMultipleAttachments(ticket.attachments);
    }

    // Delete activities
    await TicketActivity.deleteMany({ ticket: ticket._id });

    // Delete ticket
    await ticket.deleteOne();

    // Emit socket event
    emitTicketEvent('ticket-deleted', {
      clientId: ticket.clientId,
      ticketId: ticket._id
    });

    res.status(200).json({
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

/**
 * Add comment to ticket
 * POST /api/tickets/:id/comments
 */
exports.addComment = async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { id } = req.params;
    const { text, isInternal = false, mentions = [] } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Comment text is required'
      });
    }

    // Find ticket
    const ticket = await Ticket.findById(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Check permissions
    const canView = await canViewTicket(req.user, ticket);
    if (!canView.allowed) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Create activity data
    const activityData = {
      comment: {
        text: text.trim(),
        isInternal,
        mentions
      }
    };

    // Handle attachments
    if (req.files && req.files.length > 0) {
      const attachments = await saveTicketAttachments(req, {
        clientId: ticket.clientId,
        ticketId: ticket.ticketId,
        userId,
        type: 'activity'
      });
      activityData.attachments = attachments;
    }

    // Log activity
    const activity = await logActivity(
      ticket._id,
      'comment',
      activityData,
      userId,
      req.user.userType
    );

    // Update first response time if not set and comment is from assignee/support
    if (!ticket.firstResponseAt && 
        (ticket.assignedTo?.toString() === userId || 
         req.user.userType === 'support' || 
         req.user.userType === 'supportManager')) {
      ticket.firstResponseAt = new Date();
      await ticket.save();
    }

    // Emit socket event
    emitTicketEvent('ticket-comment-added', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      activity: activity.toObject()
    });

    // Send notifications
    await notifyTicketCommented(ticket, req.user, text);

    // Populate activity
    await activity.populate('createdBy', 'userName email userType profileImage');

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
 * 
 * UPDATED: Only supportManager can assign to support users in their team
 */
exports.assignTicket = async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { id } = req.params;
    const { assignTo } = req.body;

    if (!assignTo) {
      return res.status(400).json({
        success: false,
        message: 'assignTo user ID is required'
      });
    }

    // Find ticket
    const ticket = await Ticket.findById(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Check if user can assign
    const canAssign = await canAssignTicket(req.user, ticket);
    if (!canAssign.allowed) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to assign tickets'
      });
    }

    // Verify assignee exists
    const assignee = await User.findById(assignTo);
    if (!assignee) {
      return res.status(404).json({
        success: false,
        message: 'Assignee user not found'
      });
    }

    // Valid assignee types
    const validAssigneeTypes = [
      'super_admin', 
      'consultant_admin', 
      'consultant', 
      'supportManager',
      'support',
      'client_admin'
    ];

    if (!validAssigneeTypes.includes(assignee.userType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid assignee type'
      });
    }

    // If assignee is a support user, verify they belong to the ticket's support manager's team
    if (assignee.userType === 'support') {
      // Verify support user belongs to the ticket's support manager's team
      if (!ticket.supportManagerId) {
        return res.status(400).json({
          success: false,
          message: 'This ticket does not have an assigned support manager'
        });
      }

      if (!assignee.supportManagerId || 
          assignee.supportManagerId.toString() !== ticket.supportManagerId.toString()) {
        return res.status(400).json({
          success: false,
          message: 'This support user does not belong to the ticket\'s support team'
        });
      }

      // Only the ticket's support manager can assign to support users
      if (req.user.userType !== 'super_admin' && 
          req.user.userType !== 'supportManager') {
        return res.status(403).json({
          success: false,
          message: 'Only support managers can assign tickets to support users'
        });
      }

      if (req.user.userType === 'supportManager' && 
          ticket.supportManagerId.toString() !== userId) {
        return res.status(403).json({
          success: false,
          message: 'You can only assign tickets managed by you'
        });
      }
    }

    // Store old assignee for activity log
    const oldAssignee = ticket.assignedTo ? ticket.assignedTo.toString() : null;

    // Update ticket
    ticket.assignedTo = assignTo;
    ticket.assignedToType = assignee.userType;
    ticket.status = 'assigned';

    if (!ticket.firstResponseAt) {
      ticket.firstResponseAt = new Date();
    }

    await ticket.save();

    // Log activity
    await logActivity(
      ticket._id,
      'assignment',
      {
        changes: [{
          field: 'assignedTo',
          oldValue: oldAssignee ? oldAssignee : 'Unassigned',
          newValue: assignee.userName
        }]
      },
      userId,
      req.user.userType
    );

    // Emit socket event
    emitTicketEvent('ticket-assigned', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      assignedTo: assignee
    });

    // Send notifications
    if (assignee.userType === 'support') {
      await notifySupportUserAssigned(ticket, assignee, req.user);
    } else {
      await notifyTicketAssigned(ticket, assignee, req.user);
    }

    // Broadcast
    if (global.broadcastTicketAssigned) {
      global.broadcastTicketAssigned({
        ...ticket.toObject(),
        assignedTo: {
          _id: assignee._id,
          userName: assignee.userName,
          userType: assignee.userType
        }
      });
    }

    // Populate references
    await ticket.populate('createdBy', 'userName email userType');
    await ticket.populate('assignedTo', 'userName email userType');
    await ticket.populate('supportManagerId', 'userName email supportTeamName');

    res.status(200).json({
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
    const userId = getUserId(req.user);
    const { id } = req.params;
    const { reason } = req.body;

    // Find ticket
    const ticket = await Ticket.findById(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    const supportRoles = ['super_admin', 'consultant_admin', 'consultant', 'supportManager', 'support', 'client_admin'];
    if (!supportRoles.includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: 'Only support staff and admins can escalate tickets'
      });
    }

    // Check access
    const hasAccess = await checkTicketAccess(req.user, ticket);
    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Store old values
    const oldPriority = ticket.priority;
    const oldEscalationLevel = ticket.escalationLevel || 0;

    // Update ticket
    ticket.isEscalated = true;
    ticket.escalatedAt = new Date();
    ticket.escalatedBy = userId;
    ticket.escalationReason = reason || 'Manual escalation';
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
        changes: [
          {
            field: 'escalationLevel',
            oldValue: oldEscalationLevel.toString(),
            newValue: ticket.escalationLevel.toString()
          },
          {
            field: 'priority',
            oldValue: oldPriority,
            newValue: ticket.priority
          },
          {
            field: 'status',
            oldValue: 'previous',
            newValue: 'escalated'
          }
        ]
      },
      userId,
      req.user.userType
    );

    // Emit socket event
    emitTicketEvent('ticket-escalated', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      escalationLevel: ticket.escalationLevel,
      priority: ticket.priority
    });

    // Send notifications
    await notifyTicketEscalated(ticket, reason, req.user);

    // Populate references
    await ticket.populate('createdBy', 'userName email userType');
    await ticket.populate('assignedTo', 'userName email userType');
    await ticket.populate('supportManagerId', 'userName email supportTeamName');

    res.status(200).json({
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
    const userId = getUserId(req.user);
    const { id } = req.params;
    const { resolutionNotes } = req.body;

    // Find ticket
    const ticket = await Ticket.findById(id);
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
    const oldStatus = ticket.status;
    ticket.status = 'resolved';
    ticket.resolvedAt = new Date();
    ticket.resolution = {
      resolvedBy: userId,
      resolutionNotes: resolutionNotes || '',
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
          oldValue: oldStatus,
          newValue: 'resolved'
        }]
      },
      userId,
      req.user.userType
    );

    // Emit socket event
    emitTicketEvent('ticket-resolved', {
      clientId: ticket.clientId,
      ticketId: ticket._id
    });

    // Send notifications
    await notifyTicketResolved(ticket, req.user, resolutionNotes);

    // Populate references
    await ticket.populate('createdBy', 'userName email userType');
    await ticket.populate('assignedTo', 'userName email userType');
    await ticket.populate('supportManagerId', 'userName email supportTeamName');
    await ticket.populate('resolution.resolvedBy', 'userName email userType');

    res.status(200).json({
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
    const userId = getUserId(req.user);
    const { id } = req.params;
    const { satisfactionRating, userFeedback } = req.body;

    // Find ticket
    const ticket = await Ticket.findById(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Only creator or support roles can close
    const canClose = ticket.createdBy.toString() === userId || 
                    ['super_admin', 'supportManager', 'support'].includes(req.user.userType);

    if (!canClose) {
      return res.status(403).json({
        success: false,
        message: 'Only ticket creator or support staff can close tickets'
      });
    }

    // Ticket must be resolved first
    if (ticket.status !== 'resolved') {
      return res.status(400).json({
        success: false,
        message: 'Ticket must be resolved before closing'
      });
    }

    // Update ticket
    const oldStatus = ticket.status;
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
          oldValue: oldStatus,
          newValue: 'closed'
        }]
      },
      userId,
      req.user.userType
    );

    // Emit socket event
    emitTicketEvent('ticket-closed', {
      clientId: ticket.clientId,
      ticketId: ticket._id
    });

    // Send notifications
    await notifyTicketStatusChanged(ticket, oldStatus, 'closed', req.user);

    // Populate references
    await ticket.populate('createdBy', 'userName email userType');
    await ticket.populate('assignedTo', 'userName email userType');
    await ticket.populate('supportManagerId', 'userName email supportTeamName');

    res.status(200).json({
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
    const userId = getUserId(req.user);
    const { id } = req.params;
    const { reason } = req.body;

    // Find ticket
    const ticket = await Ticket.findById(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Can only reopen closed or resolved tickets
    if (!['resolved', 'closed'].includes(ticket.status)) {
      return res.status(400).json({
        success: false,
        message: 'Can only reopen resolved or closed tickets'
      });
    }

    // Check permissions
    const hasAccess = await checkTicketAccess(req.user, ticket);
    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
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
        }]
      },
      userId,
      req.user.userType
    );

    // Emit socket event
    emitTicketEvent('ticket-reopened', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      reason
    });

    // Send notifications
    await notifyTicketStatusChanged(ticket, oldStatus, 'reopened', req.user);

    // Populate references
    await ticket.populate('createdBy', 'userName email userType');
    await ticket.populate('assignedTo', 'userName email userType');
    await ticket.populate('supportManagerId', 'userName email supportTeamName');

    res.status(200).json({
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

/**
 * Upload attachments to ticket
 * POST /api/tickets/:id/attachments
 */
exports.uploadAttachment = async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { id } = req.params;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No files uploaded'
      });
    }

    // Find ticket
    const ticket = await Ticket.findById(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Check permissions
    const canView = await canViewTicket(req.user, ticket);
    if (!canView.allowed) {
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
    ticket.attachments.push(...attachments);
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

    res.status(200).json({
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
    const userId = getUserId(req.user);
    const { id, attachmentId } = req.params;

    // Find ticket
    const ticket = await Ticket.findById(id);
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

    // Only uploader or admin can delete
    const canDelete = attachment.uploadedBy.toString() === userId || 
                     req.user.userType === 'super_admin';

    if (!canDelete) {
      return res.status(403).json({
        success: false,
        message: 'Only uploader or admin can delete attachments'
      });
    }

    // Delete from S3
    await deleteTicketAttachment(attachment.bucket, attachment.s3Key);

    // Remove from ticket
    ticket.attachments.pull(attachmentId);
    await ticket.save();

    // Emit socket event
    emitTicketEvent('ticket-attachment-deleted', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      attachmentId
    });

    res.status(200).json({
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

/**
 * Add watcher to ticket
 * POST /api/tickets/:id/watchers
 */
exports.addWatcher = async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { id } = req.params;
    const { watcherId } = req.body;

    if (!watcherId) {
      return res.status(400).json({
        success: false,
        message: 'watcherId is required'
      });
    }

    // Find ticket
    const ticket = await Ticket.findById(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Check permissions
    const canView = await canViewTicket(req.user, ticket);
    if (!canView.allowed) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Verify watcher exists
    const watcher = await User.findById(watcherId);
    if (!watcher) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check if already watching
    const isWatching = ticket.watchers.some(w => w.toString() === watcherId);
    if (isWatching) {
      return res.status(400).json({
        success: false,
        message: 'User is already watching this ticket'
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
          field: 'watchers',
          oldValue: 'none',
          newValue: watcher.userName
        }]
      },
      userId,
      req.user.userType
    );

    // Emit socket event
    emitTicketEvent('ticket-watcher-added', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      watcher: {
        _id: watcher._id,
        userName: watcher.userName,
        userType: watcher.userType
      }
    });

    res.status(200).json({
      success: true,
      message: 'Watcher added successfully',
      watcher: {
        _id: watcher._id,
        userName: watcher.userName,
        userType: watcher.userType
      }
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
    const userId = getUserId(req.user);
    const { id, watcherId } = req.params;

    // Find ticket
    const ticket = await Ticket.findById(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Check permissions
    const canView = await canViewTicket(req.user, ticket);
    if (!canView.allowed) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Check if user is trying to remove themselves or is admin
    const isSelf = watcherId === userId;
    const isAdmin = ['super_admin', 'consultant_admin', 'client_admin', 'supportManager'].includes(req.user.userType);

    if (!isSelf && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Can only remove yourself as watcher'
      });
    }

    // Check if watching
    const isWatching = ticket.watchers.some(w => w.toString() === watcherId);
    if (!isWatching) {
      return res.status(400).json({
        success: false,
        message: 'User is not watching this ticket'
      });
    }

    // Get watcher info before removing
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
          field: 'watchers',
          oldValue: watcher ? watcher.userName : watcherId,
          newValue: 'removed'
        }]
      },
      userId,
      req.user.userType
    );

    // Emit socket event
    emitTicketEvent('ticket-watcher-removed', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      watcherId
    });

    res.status(200).json({
      success: true,
      message: 'Watcher removed successfully'
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

// ===== STATISTICS =====

/**
 * Get ticket statistics
 * GET /api/tickets/stats
 */
exports.getStats = async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { clientId, fromDate, toDate } = req.query;

    // Build base query with RBAC
    const baseQuery = {};

    // Apply client access control
    if (req.user.userType === 'super_admin') {
      if (clientId) {
        baseQuery.clientId = clientId;
      }
    } else if (req.user.userType === 'supportManager') {
      baseQuery.supportManagerId = userId;
      if (clientId) {
        baseQuery.clientId = clientId;
      }
    } else if (req.user.userType === 'support') {
      baseQuery.$or = [
        { assignedTo: userId },
        { supportManagerId: req.user.supportManagerId }
      ];
      if (clientId) {
        baseQuery.clientId = clientId;
      }
    } else {
      if (req.user.clientId) {
        baseQuery.clientId = req.user.clientId;
      } else {
        // For consultants, find accessible clients
        const accessibleClients = await Client.find({
          $or: [
            { 'leadInfo.createdBy': userId },
            { 'workflowTracking.assignedConsultantId': userId }
          ]
        }).distinct('clientId');

        if (accessibleClients.length === 0) {
          return res.status(200).json({
            success: true,
            stats: {
              total: 0,
              byStatus: {},
              byPriority: {},
              byCategory: {},
              avgResolutionTime: 0,
              slaComplianceRate: 0,
              escalationRate: 0
            }
          });
        }

        if (clientId && accessibleClients.includes(clientId)) {
          baseQuery.clientId = clientId;
        } else if (!clientId) {
          baseQuery.clientId = { $in: accessibleClients };
        }
      }
    }

    // Date range filter
    if (fromDate || toDate) {
      baseQuery.createdAt = {};
      if (fromDate) {
        baseQuery.createdAt.$gte = new Date(fromDate);
      }
      if (toDate) {
        baseQuery.createdAt.$lte = new Date(toDate);
      }
    }

    // Get total count
    const total = await Ticket.countDocuments(baseQuery);

    // Get counts by status
    const byStatus = await Ticket.aggregate([
      { $match: baseQuery },
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // Get counts by priority
    const byPriority = await Ticket.aggregate([
      { $match: baseQuery },
      { $group: { _id: '$priority', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // Get counts by category
    const byCategory = await Ticket.aggregate([
      { $match: baseQuery },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // Calculate average resolution time (in hours)
    const resolvedTickets = await Ticket.find({
      ...baseQuery,
      status: { $in: ['resolved', 'closed'] },
      createdAt: { $exists: true },
      resolvedAt: { $exists: true }
    }).select('createdAt resolvedAt');

    let totalResolutionTime = 0;
    resolvedTickets.forEach(ticket => {
      const resTime = ticket.resolvedAt.getTime() - ticket.createdAt.getTime();
      totalResolutionTime += resTime;
    });

    const avgResolutionTime = resolvedTickets.length > 0
      ? totalResolutionTime / resolvedTickets.length / (1000 * 60 * 60) // Convert to hours
      : 0;

    // Calculate SLA compliance rate
    const ticketsWithDueDate = await Ticket.find({
      ...baseQuery,
      dueDate: { $exists: true },
      status: { $in: ['resolved', 'closed'] }
    }).select('dueDate resolvedAt');

    let slaCompliant = 0;
    ticketsWithDueDate.forEach(ticket => {
      if (ticket.resolvedAt && ticket.dueDate) {
        if (ticket.resolvedAt <= ticket.dueDate) {
          slaCompliant++;
        }
      }
    });

    const slaComplianceRate = ticketsWithDueDate.length > 0
      ? (slaCompliant / ticketsWithDueDate.length) * 100
      : 0;

    // Calculate escalation rate
    const escalatedCount = await Ticket.countDocuments({
      ...baseQuery,
      isEscalated: true
    });

    const escalationRate = total > 0 ? (escalatedCount / total) * 100 : 0;

    // Format results
    const stats = {
      total,
      byStatus: byStatus.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {}),
      byPriority: byPriority.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {}),
      byCategory: byCategory.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {}),
      avgResolutionTime: Math.round(avgResolutionTime * 100) / 100,
      slaComplianceRate: Math.round(slaComplianceRate * 100) / 100,
      escalationRate: Math.round(escalationRate * 100) / 100,
      resolvedCount: resolvedTickets.length,
      escalatedCount
    };

    res.status(200).json({
      success: true,
      stats
    });

  } catch (error) {
    console.error('Error getting ticket stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get ticket statistics',
      error: error.message
    });
  }
};

module.exports = exports;