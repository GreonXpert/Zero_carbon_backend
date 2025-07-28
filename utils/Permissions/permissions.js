const Client = require('../../models/Client');


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

  // Consultant can manage assigned clients' flowcharts
  if (user.userType === 'consultant') {
    return client.leadInfo.assignedConsultantId?.toString() === user._id.toString();
  }

  return false;
};

// Check if user can create/edit flowchart for a client
const canManageFlowchart = async (user, clientId, flowchart = null) => {
  // Super admin can manage all
  if (user.userType === 'super_admin') {
    return { allowed: true, reason: 'Super admin access' };
  }

  // Get client details
  const client = await Client.findOne({ clientId });
  if (!client) {
    return { allowed: false, reason: 'Client not found' };
  }

  // Consultant Admin: Can manage if they created the lead
  if (user.userType === 'consultant_admin') {
    const createdBy = client.leadInfo?.createdBy;
    if (createdBy && user._id && createdBy.toString() === user._id.toString()) {
      return { allowed: true, reason: 'Consultant admin who created lead' };
    }

    // Also check if any consultant under them is assigned
    const consultantsUnderAdmin = await User.find({
      consultantAdminId: user.id,
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
  //  // Consultant Admin: view if any of their consultants is assigned to this client
  // if (user.userType === 'consultant_admin') {
  //   const client = await Client.findOne({ clientId }).select('leadInfo.assignedConsultantId');
  //   if (client?.leadInfo?.assignedConsultantId) {
  //     // get all consultants under this admin
  //     const subCons = await User.find({
  //       consultantAdminId: user.id,
  //       userType: 'consultant'
  //     }).select('_id');
  //     const subIds = subCons.map(c => c._id.toString());
  //     if (subIds.includes(client.leadInfo.assignedConsultantId.toString())) {
  //       return { allowed: true, fullAccess: true };
  //     }
  //   }
  // }

  // // Consultant: view if they are the assigned consultant
  // if (user.userType === 'consultant') {
  //   const client = await Client.findOne({ clientId }).select('leadInfo.assignedConsultantId');
  //   if (client?.leadInfo?.assignedConsultantId?.toString() === user.id.toString()) {
  //     return { allowed: true, fullAccess: true };
  //   }
  // }
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
    canViewFlowchart
}