'use strict';

// ============================================================================
// userDataRetriever.js — Role-based user / client / consultant data fetcher
//
// ⚠️  ENCRYPTION NOTE (critical):
//   On the Client model, these fields are encrypted in full (AES-256-GCM):
//     submissionData, accountDetails, workflowTracking, proposalData, supportSection
//   Reading them with .lean() returns the encrypted blob — NOT usable data.
//
//   These leadInfo sub-fields are NOT encrypted and safe to read:
//     companyName, email, contactPersonName, mobileNumber,
//     consultantAdminId, assignedConsultantId, createdBy
//
//   The User model stores assessment/module data at root level (NOT encrypted):
//     assessmentLevel, accessibleModules, esgLinkAssessmentLevel, accessControls
//
// Strategy: Read company/contact info from Client DB (leadInfo only).
//           Read assessment level + accessible modules + user data from User DB.
// ============================================================================

const User   = require('../../../common/models/User');
const Client = require('../../../modules/client-management/client/Client');

const CLIENT_USER_TYPES = [
  'client_employee_head', 'employee', 'contributor',
  'reviewer', 'approver', 'auditor', 'viewer',
];

const MAX_CLIENTS          = 30;
const MAX_USERS_PER_CLIENT = 50;

// Sentinel: queryController sets this when no specific client was named.
const USER_SCOPE_SENTINEL = '__user_scope__';

// Safe Client DB projection — ONLY non-encrypted fields from leadInfo.
// Never include submissionData, accountDetails, workflowTracking (encrypted in full).
const CLIENT_SAFE_SELECT =
  'clientId createdAt ' +
  'leadInfo.companyName leadInfo.email leadInfo.contactPersonName leadInfo.mobileNumber ' +
  'leadInfo.consultantAdminId leadInfo.assignedConsultantId leadInfo.createdBy';

// User DB projection for client_admin (assessment + module data lives here unencrypted)
const CLIENT_ADMIN_SELECT =
  'userName email companyName assessmentLevel accessibleModules esgLinkAssessmentLevel isActive createdAt';

// ── Main entry point ──────────────────────────────────────────────────────────

async function retrieve(plan, accessContext) {
  const user     = plan.requestingUser || null;
  const userType = accessContext.userType;
  const exclusions = [];

  const rawClientId      = plan.clientId || accessContext.clientId || null;
  const specificClientId = (rawClientId && rawClientId !== USER_SCOPE_SENTINEL)
    ? rawClientId : null;

  try {
    if (specificClientId && userType !== 'client_admin') {
      return _fetchSingleClientData(specificClientId, exclusions);
    }

    switch (userType) {
      case 'super_admin':      return _fetchSuperAdminData(exclusions);
      case 'consultant_admin': return _fetchConsultantAdminData(user, exclusions);
      case 'consultant':       return _fetchConsultantData(user, exclusions);
      case 'client_admin':
        return _fetchClientAdminData(specificClientId || accessContext.clientId, exclusions);
      default:
        exclusions.push('User data queries are only available for administrator and consultant roles.');
        return { data: {}, exclusions, recordCount: 0 };
    }
  } catch (err) {
    console.error('[userDataRetriever] error:', err.message);
    exclusions.push('An error occurred while fetching user data.');
    return { data: {}, exclusions, recordCount: 0 };
  }
}

// ── Single client full detail ──────────────────────────────────────────────────

async function _fetchSingleClientData(clientId, exclusions) {
  // Fetch Client DB (safe fields only) + User DB simultaneously
  const [client, clientAdminUser, allUsers] = await Promise.all([
    Client.findOne({ clientId, isDeleted: { $ne: true } })
          .select(CLIENT_SAFE_SELECT)
          .lean(),
    // Assessment level + modules come from User DB (NOT from encrypted submissionData)
    User.findOne({ clientId, userType: 'client_admin' })
        .select(CLIENT_ADMIN_SELECT)
        .lean(),
    User.find({ clientId })
        .select('userName email userType isActive createdAt')
        .sort({ userType: 1, createdAt: -1 })
        .limit(100)
        .lean(),
  ]);

  if (!client && !clientAdminUser) {
    exclusions.push(`Client '${clientId}' not found.`);
    return { data: {}, exclusions, recordCount: 0 };
  }

  const clientUsers    = allUsers.filter((u) => CLIENT_USER_TYPES.includes(u.userType));
  const clientAdmins   = allUsers.filter((u) => u.userType === 'client_admin');
  const grouped        = _groupUsersByRole(clientUsers);
  const counts         = _countByRole(grouped);

  // Company name: Client DB leadInfo (not encrypted) → User DB companyName → clientId
  const companyName =
    client?.leadInfo?.companyName ||
    clientAdminUser?.companyName  ||
    clientId;

  // Fetch assigned consultant from User DB
  const assignedConsultants = [];
  if (client?.leadInfo?.assignedConsultantId) {
    const c = await User.findById(client.leadInfo.assignedConsultantId)
                        .select('userName email companyName').lean();
    if (c) assignedConsultants.push(_safeUser(c));
  }

  // Fetch consultant admin from User DB
  let consultantAdminInfo = null;
  if (client?.leadInfo?.consultantAdminId) {
    const ca = await User.findById(client.leadInfo.consultantAdminId)
                         .select('userName email companyName teamName').lean();
    if (ca) {
      consultantAdminInfo = {
        name:        ca.userName    || '—',
        email:       ca.email       || '—',
        companyName: ca.companyName || '—',
        teamName:    ca.teamName    || '—',
      };
    }
  }

  // Assessment data: from User DB (client_admin user) — NOT from encrypted submissionData
  const assessmentLevel    = clientAdminUser?.assessmentLevel    || [];
  const accessibleModules  = clientAdminUser?.accessibleModules  || ['zero_carbon'];
  const esgAssessmentLevel = clientAdminUser?.esgLinkAssessmentLevel || {};

  return {
    data: {
      userData: {
        type: 'single_client_view',
        clientInfo: {
          clientId,
          companyName,
          contactPerson: client?.leadInfo?.contactPersonName || '—',
          contactEmail:  client?.leadInfo?.email             || '—',
          contactMobile: client?.leadInfo?.mobileNumber      || '—',
          createdAt:     client?.createdAt || clientAdminUser?.createdAt,
        },
        // Assessment data from User DB (decrypted, always accurate)
        assessmentDetails: {
          assessmentLevel,
          esgAssessmentLevel,
          accessibleModules,
        },
        clientAdmins: clientAdmins.map(_safeUser),
        assignedConsultants,
        consultantAdminInfo,
        userCounts:   counts,
        usersByRole:  grouped,
        totalUsers:   clientUsers.length,
      },
    },
    exclusions,
    recordCount: 1 + clientUsers.length,
  };
}

// ── Role-based list handlers ───────────────────────────────────────────────────

async function _fetchSuperAdminData(exclusions) {
  const [consultantAdmins, consultants, clients] = await Promise.all([
    User.find({ userType: 'consultant_admin' })
        .select('userName email companyName teamName isActive assignedClients createdAt')
        .sort({ createdAt: -1 }).limit(MAX_CLIENTS).lean(),

    User.find({ userType: 'consultant' })
        .select('userName email consultantAdminId hasAssignedClients assignedClients isActive createdAt')
        .sort({ createdAt: -1 }).limit(MAX_CLIENTS).lean(),

    // Only safe (non-encrypted) Client fields
    Client.find({ isDeleted: { $ne: true }, sandbox: { $ne: true } })
          .select(CLIENT_SAFE_SELECT)
          .sort({ 'leadInfo.companyName': 1 }).limit(MAX_CLIENTS).lean(),
  ]);

  const clientData = await Promise.all(clients.map(_enrichClientWithUsers));

  return {
    data: {
      userData: {
        type: 'super_admin_view',
        summary: {
          totalConsultantAdmins: consultantAdmins.length,
          totalConsultants:      consultants.length,
          totalClients:          clientData.length,
        },
        consultantAdmins: consultantAdmins.map(_safeUser),
        consultants:      consultants.map(_safeUser),
        clients:          clientData,
      },
    },
    exclusions,
    recordCount: consultantAdmins.length + consultants.length + clientData.length,
  };
}

async function _fetchConsultantAdminData(user, exclusions) {
  if (!user?._id) {
    exclusions.push('Requesting user context unavailable.');
    return { data: {}, exclusions, recordCount: 0 };
  }

  const [consultants, clients] = await Promise.all([
    User.find({
      userType: 'consultant',
      $or: [{ createdBy: user._id }, { consultantAdminId: user._id }],
    })
    .select('userName email consultantAdminId hasAssignedClients assignedClients isActive createdAt')
    .sort({ createdAt: -1 }).limit(30).lean(),

    Client.find({
      isDeleted: { $ne: true },
      sandbox:   { $ne: true },
      $or: [
        { 'leadInfo.consultantAdminId': user._id },
        { 'leadInfo.createdBy':         user._id },
        { clientId: { $in: user.assignedClients || [] } },
      ],
    })
    .select(CLIENT_SAFE_SELECT)
    .sort({ 'leadInfo.companyName': 1 }).limit(MAX_CLIENTS).lean(),
  ]);

  const clientData = await Promise.all(clients.map(_enrichClientWithUsers));

  return {
    data: {
      userData: {
        type: 'consultant_admin_view',
        consultantAdminInfo: {
          id:          String(user._id),
          name:        user.userName    || '—',
          email:       user.email       || '—',
          companyName: user.companyName || '—',
          teamName:    user.teamName    || '—',
        },
        summary: {
          totalConsultants: consultants.length,
          totalClients:     clientData.length,
        },
        consultants: consultants.map((c) => ({
          ..._safeUser(c),
          assignedClientsCount: (c.assignedClients || []).length,
        })),
        clients: clientData,
      },
    },
    exclusions,
    recordCount: consultants.length + clientData.length,
  };
}

async function _fetchConsultantData(user, exclusions) {
  if (!user?._id) {
    exclusions.push('Requesting user context unavailable.');
    return { data: {}, exclusions, recordCount: 0 };
  }

  const clients = await Client.find({
    isDeleted: { $ne: true },
    sandbox:   { $ne: true },
    $or: [
      { clientId: { $in: user.assignedClients || [] } },
      { 'leadInfo.assignedConsultantId':         user._id },
      { 'workflowTracking.assignedConsultantId': user._id },
    ],
  })
  .select(CLIENT_SAFE_SELECT)
  .sort({ 'leadInfo.companyName': 1 }).limit(MAX_CLIENTS).lean();

  const clientData = await Promise.all(clients.map(_enrichClientWithUsers));

  return {
    data: {
      userData: {
        type: 'consultant_view',
        consultantInfo: { id: String(user._id), name: user.userName || '—', email: user.email || '—' },
        summary: { totalAssignedClients: clientData.length },
        clients: clientData,
      },
    },
    exclusions,
    recordCount: clientData.length,
  };
}

async function _fetchClientAdminData(clientId, exclusions) {
  if (!clientId) {
    exclusions.push('No client ID available for this account.');
    return { data: {}, exclusions, recordCount: 0 };
  }

  const [client, clientAdminUser, clientUsers] = await Promise.all([
    Client.findOne({ clientId, isDeleted: { $ne: true } })
          .select(CLIENT_SAFE_SELECT).lean(),
    // Assessment / module data from User DB (not encrypted)
    User.findOne({ clientId, userType: 'client_admin' })
        .select(CLIENT_ADMIN_SELECT).lean(),
    User.find({ clientId, userType: { $in: CLIENT_USER_TYPES } })
        .select('userName email userType isActive createdAt')
        .sort({ userType: 1, createdAt: -1 }).limit(MAX_USERS_PER_CLIENT).lean(),
  ]);

  const grouped = _groupUsersByRole(clientUsers);
  const counts  = _countByRole(grouped);

  const companyName =
    client?.leadInfo?.companyName ||
    clientAdminUser?.companyName  ||
    clientId;

  return {
    data: {
      userData: {
        type: 'client_admin_view',
        clientInfo: {
          clientId,
          companyName,
          contactPerson: client?.leadInfo?.contactPersonName || '—',
          contactEmail:  client?.leadInfo?.email             || '—',
          createdAt:     client?.createdAt,
        },
        // Assessment data from User DB — NOT from encrypted submissionData
        assessmentDetails: {
          assessmentLevel:    clientAdminUser?.assessmentLevel    || [],
          esgAssessmentLevel: clientAdminUser?.esgLinkAssessmentLevel || {},
          accessibleModules:  clientAdminUser?.accessibleModules  || ['zero_carbon'],
        },
        userCounts:  counts,
        usersByRole: grouped,
      },
    },
    exclusions,
    recordCount: clientUsers.length + 1,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Enriches a Client document with user data AND assessment data from User DB.
async function _enrichClientWithUsers(client) {
  const [users, clientAdminUser] = await Promise.all([
    User.find({ clientId: client.clientId, userType: { $in: CLIENT_USER_TYPES } })
        .select('userName email userType isActive').limit(MAX_USERS_PER_CLIENT).lean(),
    // Assessment + modules from User DB
    User.findOne({ clientId: client.clientId, userType: 'client_admin' })
        .select(CLIENT_ADMIN_SELECT).lean(),
  ]);

  const grouped = _groupUsersByRole(users);
  const counts  = _countByRole(grouped);

  const companyName =
    client.leadInfo?.companyName ||
    clientAdminUser?.companyName ||
    client.clientId;

  return {
    clientInfo: {
      clientId:      client.clientId,
      companyName,
      contactPerson: client.leadInfo?.contactPersonName || '—',
      contactEmail:  client.leadInfo?.email             || '—',
      createdAt:     client.createdAt,
    },
    // Assessment data from User DB (client_admin) — reliable, not encrypted
    assessmentDetails: {
      assessmentLevel:    clientAdminUser?.assessmentLevel    || [],
      esgAssessmentLevel: clientAdminUser?.esgLinkAssessmentLevel || {},
      accessibleModules:  clientAdminUser?.accessibleModules  || ['zero_carbon'],
    },
    userCounts:  counts,
    usersByRole: grouped,
  };
}

function _groupUsersByRole(users) {
  const grouped = {};
  for (const t of CLIENT_USER_TYPES) grouped[t] = [];
  for (const u of users) {
    if (grouped[u.userType]) grouped[u.userType].push(_safeUser(u));
  }
  return grouped;
}

function _countByRole(grouped) {
  const counts = {};
  for (const t of CLIENT_USER_TYPES) counts[t] = (grouped[t] || []).length;
  return counts;
}

function _safeUser(u) {
  return {
    id:        String(u._id),
    name:      u.userName    || '—',
    email:     u.email       || '—',
    userType:  u.userType    || '—',
    isActive:  u.isActive    ?? true,
    createdAt: u.createdAt,
    ...(u.companyName       ? { companyName:       u.companyName }       : {}),
    ...(u.teamName          ? { teamName:          u.teamName }          : {}),
    ...(u.hasAssignedClients !== undefined ? { hasAssignedClients: u.hasAssignedClients } : {}),
  };
}

module.exports = { retrieve };
