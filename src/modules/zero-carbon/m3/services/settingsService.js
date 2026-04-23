'use strict';

const OrgSettings = require('../models/OrgSettings');
const FrameworkLibrary = require('../models/FrameworkLibrary');
const MethodLibrary = require('../models/MethodLibrary');
const RolePermissionMatrix = require('../models/RolePermissionMatrix');
const UserScopeMap = require('../models/UserScopeMap');

async function getSettings(clientId) {
  const existing = await OrgSettings.findOne({ clientId });
  if (existing) return existing;
  // Return defaults if none configured yet
  return new OrgSettings({ clientId });
}

async function updateSettings(clientId, data, user) {
  return OrgSettings.findOneAndUpdate(
    { clientId },
    { $set: { ...data, updated_by: user._id } },
    { upsert: true, new: true }
  );
}

async function listFrameworks(onlyActive = true) {
  const query = onlyActive ? { is_active: true } : {};
  return FrameworkLibrary.find(query);
}

async function upsertFramework(data) {
  return FrameworkLibrary.findOneAndUpdate(
    { framework_code: data.framework_code },
    { $set: data },
    { upsert: true, new: true }
  );
}

async function listMethods(onlyActive = true) {
  const query = onlyActive ? { is_active: true } : {};
  return MethodLibrary.find(query);
}

async function upsertMethod(data) {
  return MethodLibrary.findOneAndUpdate(
    { method_code: data.method_code },
    { $set: data },
    { upsert: true, new: true }
  );
}

async function listPermissions() {
  return RolePermissionMatrix.find({});
}

async function upsertPermission(data) {
  return RolePermissionMatrix.findOneAndUpdate(
    { role_code: data.role_code, action_code: data.action_code, resource_type: data.resource_type },
    { $set: data },
    { upsert: true, new: true }
  );
}

async function listScopes(clientId) {
  return UserScopeMap.find({ clientId });
}

async function upsertScope(data) {
  return UserScopeMap.findOneAndUpdate(
    { user_id: data.user_id, clientId: data.clientId, role_code: data.role_code, scope_type: data.scope_type },
    { $set: data },
    { upsert: true, new: true }
  );
}

module.exports = {
  getSettings, updateSettings,
  listFrameworks, upsertFramework,
  listMethods, upsertMethod,
  listPermissions, upsertPermission,
  listScopes, upsertScope,
};
