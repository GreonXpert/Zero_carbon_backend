const Client = require('../../models/Client');
const User = require('../../models/User')


// ---- Robust ID normalizer used everywhere below ----
const getId = (x) => {
  if (x == null) return '';
  if (typeof x === 'string' || typeof x === 'number') return String(x);

  const candidate = (x._id != null) ? x._id
                  : (x.id  != null) ? x.id
                  : x;

  if (candidate == null) return '';
  return (typeof candidate === 'string' || typeof candidate === 'number')
    ? String(candidate)
    : (candidate.toString ? candidate.toString() : '');
};


// Helper function to check if user can manage process flowchart
/**
 * Can the user manage *process* flowchart for this client?
 * Always returns: { allowed: boolean, reason: string }
 */
const canManageProcessFlowchart = async (user, clientId) => {
  const myId = getId(user);

  // Super admin can manage all
  if (user.userType === 'super_admin') {
    return { allowed: true, reason: 'Super admin access' };
  }

  // Load client
  const client = await Client.findOne({ clientId });
  if (!client) {
    return { allowed: false, reason: 'Client not found' };
  }

  // Collect possible "assigned consultant" ids (lead, workflow, active history)
  const leadAssigned        = getId(client.leadInfo?.assignedConsultantId);
  const workflowAssigned    = getId(client.workflowTracking?.assignedConsultantId);
  const activeHistoryIds    = (client.leadInfo?.consultantHistory || [])
    .filter(h => h?.isActive)
    .map(h => getId(h?.consultantId))
    .filter(Boolean);

  const currentlyAssigned = new Set(
    [leadAssigned, workflowAssigned, ...activeHistoryIds].filter(Boolean)
  );

  // Consultant Admin: created lead, is admin on client, or manages a team member who is assigned
  if (user.userType === 'consultant_admin') {
    const createdById   = getId(client.leadInfo?.createdBy);
    const adminOnClient = getId(client.leadInfo?.consultantAdminId);

    if (createdById && createdById === myId) {
      return { allowed: true, reason: 'Consultant admin who created lead' };
    }
    if (adminOnClient && adminOnClient === myId) {
      return { allowed: true, reason: 'Consultant admin for this client' };
    }

    // Is any currently-assigned consultant under this admin?
    const team = await User.find({
      consultantAdminId: myId,
      userType: 'consultant'
    }).select('_id');

    const teamIds = new Set(team.map(u => getId(u._id)));
    for (const cid of currentlyAssigned) {
      if (teamIds.has(cid)) {
        return { allowed: true, reason: 'Client assigned to consultant under this admin' };
      }
    }
    return { allowed: false, reason: 'Not authorized for this client' };
  }

  // Consultant: must be one of the "currently assigned" consultants
  if (user.userType === 'consultant') {
    if (currentlyAssigned.has(myId)) {
      return { allowed: true, reason: 'Assigned consultant' };
    }
    return { allowed: false, reason: 'Not assigned to this client' };
  }

  // Everyone else
  return { allowed: false, reason: 'Insufficient permissions' };
};

// Check if user can create/edit flowchart for a client (restricted to consultants/super-admin)
// Check if user can create/edit flowchart for a client (restricted to consultants/super-admin)
const canManageFlowchart = async (user, clientId) => {
// extremely defensive ID normalizer
const getId = (x) => {
  if (x == null) return '';                // handles undefined/null
  // If it's already a string or number (ObjectId as string), return as string
  if (typeof x === 'string' || typeof x === 'number') return String(x);

  // If it's a Mongoose doc or plain object that might contain _id/id
  const candidate = (x._id != null) ? x._id
                   : (x.id != null) ? x.id
                   : x;

  if (candidate == null) return '';        // guard explicit null

  // Safely call toString if present
  if (typeof candidate === 'string' || typeof candidate === 'number') {
    return String(candidate);
  }
  return candidate?.toString ? candidate.toString() : '';
};

  // Super admin can manage all
  if (user.userType === 'super_admin') {
    return { allowed: true, reason: 'Super admin access' };
  }

  // Get client details
  const client = await Client.findOne({ clientId });
  if (!client) {
    return { allowed: false, reason: 'Client not found' };
  }

  // Gather all possible "currently assigned" consultant IDs
  const leadAssigned = getId(client.leadInfo?.assignedConsultantId);
  const workflowAssigned = getId(client.workflowTracking?.assignedConsultantId);
  const activeHistoryIds = (client.leadInfo?.consultantHistory || [])
    .filter(h => h?.isActive)
    .map(h => getId(h.consultantId))
    .filter(Boolean);

  const currentlyAssigned = new Set(
    [leadAssigned, workflowAssigned, ...activeHistoryIds].filter(Boolean)
  );

  const myId = getId(user);

  // Consultant Admin rules
  if (user.userType === 'consultant_admin') {
    const createdById   = getId(client.leadInfo?.createdBy);
    const adminOnClient = getId(client.leadInfo?.consultantAdminId);

    // (a) This admin created the lead
    if (createdById && createdById === myId) {
      return { allowed: true, reason: 'Consultant admin who created lead' };
    }
    // (b) This admin is the client’s consultantAdminId
    if (adminOnClient && adminOnClient === myId) {
      return { allowed: true, reason: 'Consultant admin for this client' };
    }

    // (c) Any currently assigned consultant is in this admin's team
    const team = await User.find({ consultantAdminId: myId, userType: 'consultant' }).select('_id');
    const teamIds = new Set(team.map(u => getId(u._id)));

    for (const cid of currentlyAssigned) {
      if (teamIds.has(cid)) {
        return { allowed: true, reason: 'Client assigned to consultant under this admin' };
      }
    }
    return { allowed: false, reason: 'Not authorized for this client' };
  }

  // Consultant rule: must be currently assigned via any of the sources
  if (user.userType === 'consultant') {
    if (currentlyAssigned.has(myId)) {
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


// --- internal helpers -------------------------------------------------------
function _norm(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // strip zero-widths
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function _aliasToCanonical(level) {
  const n = _norm(level);
  // common aliases/typos mapped to canonical tokens
  if (["organisation", "orangization", "organization", "org"].includes(n)) return "organization";
  if (["process", "proc", "processes"].includes(n)) return "process";
  if (["reduction", "reduce"].includes(n)) return "reduction";
  if (["decarbonization", "decarbonisation", "decarb"].includes(n)) return "decarbonization";
  if (n === "both") return "both"; // legacy storage meaning org+process
  return n; // unknowns pass through
}

/** Return normalized, deduped array of levels from array|string|clientDoc */
function getNormalizedLevels(levelsOrClient) {
  const raw = Array.isArray(levelsOrClient)
    ? levelsOrClient
    : levelsOrClient?.submissionData?.assessmentLevel;

  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const out = [];
  for (const v of arr) {
    const canon = _aliasToCanonical(v);
    if (canon && !out.includes(canon)) out.push(canon);
  }
  return out;
}

// --- the one function you asked for ----------------------------------------
/**
 * canAccessModule(levelsOrClient, moduleName)
 * - levelsOrClient: array|string OR a Client document/lean doc with submissionData.assessmentLevel
 * - moduleName: "organization" | "process" | "reduction" (aliases/typos OK)
 * Returns boolean.
 */
function canAccessModule(levelsOrClient, moduleName) {
  const levels = getNormalizedLevels(levelsOrClient);
  const target = _aliasToCanonical(moduleName);

  if (target === "organization") {
    // org is allowed by explicit "organization" or legacy "both"
    return levels.includes("organization") || levels.includes("both");
  }
  if (target === "process") {
    // process allowed by explicit "process" or legacy "both"
    return levels.includes("process") || levels.includes("both");
  }
  // reduction / decarbonization / any other canonical token must be explicitly present
  return levels.includes(target);
}

// (Optional) tiny convenience wrappers if you want them:
const canAccessOrganization = (x) => canAccessModule(x, "organization");
const canAccessProcess      = (x) => canAccessModule(x, "process");
const canAccessReduction    = (x) => canAccessModule(x, "reduction");



module.exports = {
    canManageProcessFlowchart,
    canManageFlowchart,
    canViewFlowchart,
    canAssignHeadToNode,
    getNormalizedLevels,
  canAccessModule,
  // optional wrappers:
  canAccessOrganization,
  canAccessProcess,
  canAccessReduction
}
