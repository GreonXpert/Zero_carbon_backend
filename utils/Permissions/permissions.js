const Client = require('../../models/Client');
const User = require('../../models/User')

// Helper function to check if user can manage process flowchart
const canManageProcessFlowchart = async (user, clientId) => {
  // Super admin can manage all
  if (user.userType === 'super_admin') {
    return true;
  }

  const client = await Client.findOne({ clientId });
  if (!client) return false;

  // Consultant admin can manage their clients' flowcharts
  if (user.userType === 'consultant_admin') {
    // Get all consultant IDs under this admin
    const consultants = await User.find({ 
      consultantAdminId: user._id,
      userType: 'consultant'
    }).select('_id');
    const consultantIds = consultants.map(c => c._id);
    consultantIds.push(user._id);

    return (
      client.leadInfo.consultantAdminId?.toString() === user._id.toString() ||
      consultantIds.some(id => client.leadInfo.assignedConsultantId?.toString() === id.toString())
    );
  }

  // Consultant: Can manage if they are assigned to this client
  if (user.userType === 'consultant') {
    const assignedConsultantId = client.leadInfo?.assignedConsultantId;
    if (assignedConsultantId && user.id && assignedConsultantId.toString() === user.id.toString()) {
      return { allowed: true, reason: 'Assigned consultant' };
    }
    return { allowed: false, reason: 'Not assigned to this client' };
  }


  return false;
};

// Check if user can create/edit flowchart for a client (restricted to consultants/super-admin)
const canManageFlowchart = async (user, clientId) => {
  // Super admin can manage all
  if (user.userType === 'super_admin') {
    return { allowed: true, reason: 'Super admin access' };
  }

  // Get client details
  const client = await Client.findOne({ clientId });
  if (!client) {
    return { allowed: false, reason: 'Client not found' };
  }

  // Consultant Admin: Can manage if they created the lead or their team is assigned
  if (user.userType === 'consultant_admin') {
    const createdBy = client.leadInfo?.createdBy;
    if (createdBy && user._id && createdBy.toString() === user._id.toString()) {
      return { allowed: true, reason: 'Consultant admin who created lead' };
    }

    const consultantsUnderAdmin = await User.find({
      consultantAdminId: user.id || user._id,
      userType: 'consultant'
    }).select('_id');
    const consultantIds = consultantsUnderAdmin.map(c => c._id.toString());
    const assignedConsultantId = client.leadInfo?.assignedConsultantId;
    if (assignedConsultantId && consultantIds.includes(assignedConsultantId.toString())) {
      return { allowed: true, reason: 'Client assigned to consultant under this admin' };
    }
    return { allowed: false, reason: 'Not authorized for this client' };
  }

  // Consultant: Can manage if they are assigned to this client
  if (user.userType === 'consultant') {
    const assignedConsultantId = client.leadInfo?.assignedConsultantId;
    if (assignedConsultantId && user.id && assignedConsultantId.toString() === user.id.toString()) {
      return { allowed: true, reason: 'Assigned consultant' };
    }
    return { allowed: false, reason: 'Not assigned to this client' };
  }

  return { allowed: false, reason: 'Insufficient permissions' };
};

// NEW: Specific permission check for assigning an Employee Head
const canAssignHeadToNode = async (user, clientId) => {
    // Super admin can always assign
    if (user.userType === 'super_admin') {
        return { allowed: true, reason: 'Super admin access' };
    }

    // Client admin can assign for their own client
    if (user.userType === 'client_admin' && user.clientId === clientId) {
        return { allowed: true, reason: 'Client admin access for own client' };
    }

    // For consultants and consultant admins, we can reuse the canManageFlowchart logic
    const managePermission = await canManageFlowchart(user, clientId);
    if (managePermission.allowed) {
        return { allowed: true, reason: `Allowed because user can manage flowchart: ${managePermission.reason}` };
    }
    
    return { allowed: false, reason: 'Insufficient permissions to assign employee head.' };
};


// Check if user can view flowchart
const canViewFlowchart = async (user, clientId) => {
  // Super admin can view all
  if (user.userType === 'super_admin') {
    return { allowed: true, fullAccess: true };
  }

  // Check if user can manage (creators can always view)
  const manageCheck = await canManageFlowchart(user, clientId);
  if (manageCheck.allowed) {
    return { allowed: true, fullAccess: true };
  }

  // Client admin can view their own flowchart
  if (user.userType === 'client_admin' && user.clientId === clientId) {
    return { allowed: true, fullAccess: true };
  }

  // Employee head can view with department/location restrictions
  if (user.userType === 'client_employee_head' && user.clientId === clientId) {
    return { 
      allowed: true, 
      fullAccess: false,
      restrictions: {
        department: user.department,
        location: user.location
      }
    };
  }

  // Employees, auditors, viewers can view if they belong to the client
  if (['employee', 'auditor', 'viewer'].includes(user.userType) && user.clientId === clientId) {
    return { allowed: true, fullAccess: false };
  }

  return { allowed: false };
};

module.exports = {
    canManageProcessFlowchart,
    canManageFlowchart,
    canViewFlowchart,
    canAssignHeadToNode
}
