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
  notifyTicketResolved
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

/**
 * Normalize user ID (handle both req.user.id and req.user._id)
 */
function getUserId(user) {
  return user.id || user._id?.toString() || user._id;
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

  // Check client access
  const clientAccess = await canAccessClientTickets(user, ticket.clientId);
  if (!clientAccess.allowed) {
    return { allowed: false, reason: 'No access to client' };
  }

  // Client employee head can only view tickets from their department
  if (user.userType === 'client_employee_head') {
    // Check if ticket creator is in the same department
    const creator = await User.findById(ticket.createdBy);
    if (creator && creator.department !== user.department) {
      return { allowed: false, reason: 'Different department' };
    }
  }

  // Viewers can only view tickets they created
  if (user.userType === 'viewer') {
    if (ticket.createdBy.toString() !== userId) {
      return { allowed: false, reason: 'Can only view own tickets' };
    }
  }

  return { allowed: true };
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

  // Client admin can assign within their client
  if (user.userType === 'client_admin' && user.clientId === ticket.clientId) {
    return { allowed: true };
  }

  // Consultant admin can assign tickets for their clients
  if (user.userType === 'consultant_admin') {
    const access = await canAccessClientTickets(user, ticket.clientId);
    if (access.allowed) {
      return { allowed: true };
    }
  }

  // Consultant can assign if they have access
  if (user.userType === 'consultant') {
    const access = await canAccessClientTickets(user, ticket.clientId);
    if (access.allowed) {
      return { allowed: true };
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

  // Assigned user can resolve
  if (ticket.assignedTo && ticket.assignedTo.toString() === userId) {
    return { allowed: true };
  }

  // Client admin can resolve tickets for their client
  if (user.userType === 'client_admin' && user.clientId === ticket.clientId) {
    return { allowed: true };
  }

  // Consultant admin and consultant can resolve if they have access
  if (['consultant_admin', 'consultant'].includes(user.userType)) {
    const access = await canAccessClientTickets(user, ticket.clientId);
    if (access.allowed) {
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
    const supportRoles = ['super_admin', 'consultant_admin', 'consultant'];
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

    // Create ticket
    const ticket = new Ticket({
      ticketId,
      clientId,
      createdBy: userId,
      createdByType: req.user.userType,
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

    // Emit socket event
    emitTicketEvent('ticket-created', {
      clientId,
      ticketId: ticket._id,
      ticket: ticket.toObject()
    });

    // Send notifications
    await notifyTicketCreated(ticket, req.user);

    // Populate references before sending response
    await ticket.populate('createdBy', 'userName email userType');

    res.status(201).json({
      success: true,
      message: 'Ticket created successfully',
      ticket
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
    } else {
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
              page: parseInt(page),
              limit: parseInt(limit),
              pages: 0
            }
          });
        }

        if (clientId && accessibleClients.includes(clientId)) {
          query.clientId = clientId;
        } else if (!clientId) {
          query.clientId = { $in: accessibleClients };
        } else {
          return res.status(403).json({
            success: false,
            message: 'No access to specified client'
          });
        }
      }
    }

    // Status filter (can be multiple)
    if (status) {
      const statuses = Array.isArray(status) ? status : status.split(',');
      query.status = { $in: statuses };
    }

    // Priority filter (can be multiple)
    if (priority) {
      const priorities = Array.isArray(priority) ? priority : priority.split(',');
      query.priority = { $in: priorities };
    }

    // Category filter
    if (category) {
      query.category = category;
    }

    // Assigned to filter
    if (assignedTo) {
      query.assignedTo = assignedTo === 'me' ? userId : assignedTo;
    }

    // Created by filter
    if (createdBy) {
      query.createdBy = createdBy === 'me' ? userId : createdBy;
    }

    // Tags filter
    if (tags) {
      const tagArray = Array.isArray(tags) ? tags : tags.split(',');
      query.tags = { $in: tagArray };
    }

    // Has attachments filter
    if (hasAttachments === 'true') {
      query['attachments.0'] = { $exists: true };
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

    // Additional role-based filters
    if (req.user.userType === 'employee') {
      // Employees can only see their own tickets
      query.createdBy = userId;
    } else if (req.user.userType === 'client_employee_head') {
      // Employee heads can see tickets from their department
      const deptUsers = await User.find({
        clientId: req.user.clientId,
        department: req.user.department
      }).distinct('_id');
      query.createdBy = { $in: deptUsers };
    } else if (req.user.userType === 'viewer') {
      // Viewers can only see their own tickets
      query.createdBy = userId;
    }

    // Execute query with pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const [tickets, total] = await Promise.all([
      Ticket.find(query)
        .populate('createdBy', 'userName email userType')
        .populate('assignedTo', 'userName email userType')
        .sort(sortOptions)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Ticket.countDocuments(query)
    ]);

    // Apply post-query filters (overdue, dueSoon)
    let filteredTickets = tickets;
    
    if (overdue === 'true') {
      filteredTickets = filteredTickets.filter(t => {
        if (!t.dueDate) return false;
        if (['resolved', 'closed', 'cancelled'].includes(t.status)) return false;
        return new Date() > new Date(t.dueDate);
      });
    }

    if (dueSoon === 'true') {
      filteredTickets = filteredTickets.filter(t => {
        if (!t.dueDate) return false;
        if (['resolved', 'closed', 'cancelled'].includes(t.status)) return false;
        
        const now = new Date();
        const created = new Date(t.createdAt);
        const due = new Date(t.dueDate);
        
        const totalTime = due.getTime() - created.getTime();
        const elapsed = now.getTime() - created.getTime();
        const percentElapsed = (elapsed / totalTime) * 100;
        
        return percentElapsed >= 80 && percentElapsed < 100;
      });
    }

    res.status(200).json({
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
    const userId = getUserId(req.user);
    const { id } = req.params;

    // Find ticket
    const ticket = await Ticket.findById(id)
      .populate('createdBy', 'userName email userType department')
      .populate('assignedTo', 'userName email userType')
      .populate('escalatedBy', 'userName email userType')
      .populate('approvedBy', 'userName email userType')
      .populate('watchers', 'userName email userType')
      .populate('resolution.resolvedBy', 'userName email userType');

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
        message: canView.reason || 'Access denied'
      });
    }

    // Record view
    ticket.recordView(userId);
    await ticket.save();

    // Get activity history
    const activities = await TicketActivity.find({ 
      ticket: ticket._id,
      isDeleted: false
    })
      .populate('createdBy', 'userName email userType')
      .sort({ createdAt: 1 });

    // Filter internal comments based on user role
    const visibleActivities = activities.filter(activity => 
      canViewComment(req.user, activity)
    );

    // Calculate SLA info
    const slaInfo = {
      dueDate: ticket.dueDate,
      isOverdue: ticket.isOverdue(),
      isDueSoon: ticket.isDueSoon(),
      timeRemaining: ticket.getTimeRemaining()
    };

    res.status(200).json({
      success: true,
      ticket,
      activities: visibleActivities,
      slaInfo
    });

  } catch (error) {
    console.error('Error getting ticket:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get ticket',
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

    // Track changes for activity log
    const changes = [];

    // Editable fields
    const editableFields = ['subject', 'description', 'category', 'subCategory', 'tags'];
    
    // Limited editable fields for regular users
    if (canModify.limited) {
      // Regular users can only edit subject, description, and tags
      const limitedFields = ['subject', 'description', 'tags'];
      
      for (const field of limitedFields) {
        if (req.body[field] !== undefined) {
          const oldValue = Array.isArray(ticket[field]) 
            ? ticket[field].join(', ') 
            : String(ticket[field] || '');
          const newValue = Array.isArray(req.body[field])
            ? req.body[field].join(', ')
            : String(req.body[field] || '');
          
          if (oldValue !== newValue) {
            changes.push({
              field,
              oldValue,
              newValue
            });
            ticket[field] = req.body[field];
          }
        }
      }
    } else {
      // Admin/support can edit more fields
      for (const field of editableFields) {
        if (req.body[field] !== undefined) {
          const oldValue = Array.isArray(ticket[field]) 
            ? ticket[field].join(', ') 
            : String(ticket[field] || '');
          const newValue = Array.isArray(req.body[field])
            ? req.body[field].join(', ')
            : String(req.body[field] || '');
          
          if (oldValue !== newValue) {
            changes.push({
              field,
              oldValue,
              newValue
            });
            ticket[field] = req.body[field];
          }
        }
      }

      // Priority can be changed by admins/support
      if (req.body.priority && req.body.priority !== ticket.priority) {
        changes.push({
          field: 'priority',
          oldValue: ticket.priority,
          newValue: req.body.priority
        });
        
        ticket.priority = req.body.priority;
        
        // Recalculate due date if priority changed
        ticket.dueDate = Ticket.calculateDueDate(req.body.priority, ticket.createdAt);
      }
    }

    if (changes.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No changes detected'
      });
    }

    await ticket.save();

    // Log activity
    await logActivity(
      ticket._id,
      'status_change',
      { changes },
      userId,
      req.user.userType
    );

    // Emit socket event
    emitTicketEvent('ticket-updated', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      changes
    });

    // Populate references
    await ticket.populate('createdBy', 'userName email userType');
    await ticket.populate('assignedTo', 'userName email userType');

    res.status(200).json({
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

    // Find ticket
    const ticket = await Ticket.findById(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Only super_admin or ticket creator (if draft) can delete
    const userId = getUserId(req.user);
    const isCreator = ticket.createdBy.toString() === userId;
    const isDraft = ticket.status === 'draft';

    if (req.user.userType !== 'super_admin' && !(isCreator && isDraft)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only super admin or creator (for drafts) can delete tickets'
      });
    }

    // Delete attachments from S3
    if (ticket.attachments && ticket.attachments.length > 0) {
      await deleteMultipleAttachments(ticket.attachments);
    }

    // Delete activity attachments
    const activities = await TicketActivity.find({ ticket: ticket._id });
    for (const activity of activities) {
      if (activity.attachments && activity.attachments.length > 0) {
        await deleteMultipleAttachments(activity.attachments);
      }
    }

    // Delete activities
    await TicketActivity.deleteMany({ ticket: ticket._id });

    // Delete ticket
    await Ticket.findByIdAndDelete(id);

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

// ===== WORKFLOW OPERATIONS =====

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

    // Only support roles can add internal comments
    const supportRoles = ['super_admin', 'consultant_admin', 'consultant'];
    if (isInternal && !supportRoles.includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: 'Only support staff can add internal comments'
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
      createdBy: userId,
      createdByType: req.user.userType
    });

    // Handle attachments if present
    if (req.files && req.files.length > 0) {
      const attachments = await saveTicketAttachments(req, {
        clientId: ticket.clientId,
        ticketId: ticket.ticketId,
        userId,
        type: 'activity',
        activityId: activity._id.toString()
      });
      activity.attachments = attachments;
    }

    await activity.save();

    // Set first response time if this is first support comment
    if (!ticket.firstResponseAt && supportRoles.includes(req.user.userType)) {
      ticket.firstResponseAt = new Date();
      await ticket.save();
    }

    // Emit socket event
    emitTicketEvent('ticket-new-comment', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      activity: activity.toObject()
    });

    // Send notifications
    await notifyTicketCommented(ticket, activity, req.user);

    // Populate references
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
 * Assign ticket
 * POST /api/tickets/:id/assign
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

    // Check permissions
    const canAssign = await canAssignTicket(req.user, ticket);
    if (!canAssign.allowed) {
      return res.status(403).json({
        success: false,
        message: canAssign.reason || 'Access denied'
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

    // Store old assignee for activity log
    const oldAssignee = ticket.assignedTo ? ticket.assignedTo.toString() : null;

    // Update ticket
    ticket.assignedTo = assignTo;
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
    await notifyTicketAssigned(ticket, assignee, req.user);

    // Populate references
    await ticket.populate('createdBy', 'userName email userType');
    await ticket.populate('assignedTo', 'userName email userType');

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

    // Check permissions (support roles only)
    const supportRoles = ['super_admin', 'consultant_admin', 'consultant', 'client_admin'];
    if (!supportRoles.includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: 'Only support staff and admins can escalate tickets'
      });
    }

    // Update ticket
    ticket.isEscalated = true;
    ticket.escalatedAt = new Date();
    ticket.escalatedBy = userId;
    ticket.escalationReason = reason;
    ticket.escalationLevel = (ticket.escalationLevel || 0)  + 1;
    ticket.status = 'escalated';

    // Increase priority if not already critical
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
          field: 'escalationLevel',
          oldValue: String(ticket.escalationLevel - 1),
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
      escalationLevel: ticket.escalationLevel
    });

    // Send notifications
    await notifyTicketEscalated(ticket, reason, req.user);

    // Populate references
    await ticket.populate('createdBy', 'userName email userType');
    await ticket.populate('assignedTo', 'userName email userType');
    await ticket.populate('escalatedBy', 'userName email userType');

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
    emitTicketEvent('ticket-status-changed', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      status: 'resolved'
    });

    // Send notifications
    await notifyTicketResolved(ticket, req.user);

    // Populate references
    await ticket.populate('createdBy', 'userName email userType');
    await ticket.populate('assignedTo', 'userName email userType');
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

    // Check permissions
    const canClose = await canModifyTicket(req.user, ticket);
    if (!canClose.allowed) {
      // Also allow ticket creator to close their own resolved ticket
      if (ticket.createdBy.toString() !== userId || ticket.status !== 'resolved') {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }
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

    // Add satisfaction rating if provided
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
    emitTicketEvent('ticket-status-changed', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      status: 'closed'
    });

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
    if (!['closed', 'resolved'].includes(ticket.status)) {
      return res.status(400).json({
        success: false,
        message: 'Can only reopen closed or resolved tickets'
      });
    }

    // Check permissions (creator, assignee, or admin)
    const isCreator = ticket.createdBy.toString() === userId;
    const isAssignee = ticket.assignedTo && ticket.assignedTo.toString() === userId;
    const isAdmin = ['super_admin', 'consultant_admin', 'client_admin'].includes(req.user.userType);

    if (!isCreator && !isAssignee && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const oldStatus = ticket.status;

    // Update ticket
    ticket.status = 'reopened';
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
        }],
        comment: {
          text: reason || 'Ticket reopened',
          isInternal: false
        }
      },
      userId,
      req.user.userType
    );

    // Emit socket event
    emitTicketEvent('ticket-status-changed', {
      clientId: ticket.clientId,
      ticketId: ticket._id,
      status: 'reopened'
    });

    // Notify assignee and watchers
    await notifyTicketStatusChanged(ticket, oldStatus, 'reopened', req.user);

    // Populate references
    await ticket.populate('createdBy', 'userName email userType');
    await ticket.populate('assignedTo', 'userName email userType');

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


// ===== ATTACHMENT OPERATIONS =====

/**
 * Upload attachments to ticket
 * POST /api/tickets/:id/attachments
 */
exports.uploadAttachment = async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { id } = req.params;

    // Check if files are present
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

    // Upload files to S3
    const attachments = await saveTicketAttachments(req, {
      clientId: ticket.clientId,
      ticketId: ticket.ticketId,
      userId,
      type: 'ticket'
    });

    // Add attachments to ticket
    ticket.attachments.push(...attachments);
    await ticket.save();

    // Log activity
    await logActivity(
      ticket._id,
      'attachment',
      {
        changes: [{
          field: 'attachments',
          oldValue: String(ticket.attachments.length - attachments.length),
          newValue: String(ticket.attachments.length)
        }]
      },
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
    console.error('Error uploading attachment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload attachment',
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

    // Check if user can delete (uploader, assignee, or admin)
    const isUploader = attachment.uploadedBy.toString() === userId;
    const isAssignee = ticket.assignedTo && ticket.assignedTo.toString() === userId;
    const isAdmin = ['super_admin', 'consultant_admin', 'client_admin'].includes(req.user.userType);

    if (!isUploader && !isAssignee && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Can only delete your own attachments'
      });
    }

    // Delete from S3
    await deleteTicketAttachment(attachment.bucket, attachment.s3Key);

    // Remove from ticket
    ticket.attachments.pull(attachmentId);
    await ticket.save();

    // Log activity
    await logActivity(
      ticket._id,
      'attachment',
      {
        changes: [{
          field: 'attachments',
          oldValue: attachment.filename,
          newValue: 'deleted'
        }]
      },
      userId,
      req.user.userType
    );

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

// ===== WATCHER OPERATIONS =====

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

    // Check permissions - user must have access to the ticket
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
        message: 'Watcher user not found'
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
          oldValue: 'added',
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
        email: watcher.email
      }
    });

    res.status(200).json({
      success: true,
      message: 'Watcher added successfully',
      watcher: {
        _id: watcher._id,
        userName: watcher.userName,
        email: watcher.email,
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
    const isAdmin = ['super_admin', 'consultant_admin', 'client_admin'].includes(req.user.userType);

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
              slaCompliance: 0,
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
      totalResolutionTime = resTime;
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
          slaCompliant;
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