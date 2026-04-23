'use strict';

const settingsService = require('../services/settingsService');
const { assertCanManageSettings, resolveClientId } = require('../utils/m3Permission');

const ok  = (res, data, s = 200) => res.status(s).json({ success: true, data });
const err = (res, e) => res.status(e.status || 500).json({ success: false, message: e.message });

exports.getSettings = async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const data = await settingsService.getSettings(clientId);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.updateSettings = async (req, res) => {
  try {
    assertCanManageSettings(req);
    const clientId = resolveClientId(req);
    const data = await settingsService.updateSettings(clientId, req.body, req.user);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.listFrameworks = async (req, res) => {
  try {
    const data = await settingsService.listFrameworks();
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.upsertFramework = async (req, res) => {
  try {
    assertCanManageSettings(req);
    const data = await settingsService.upsertFramework(req.body);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.listMethods = async (req, res) => {
  try {
    const data = await settingsService.listMethods();
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.upsertMethod = async (req, res) => {
  try {
    assertCanManageSettings(req);
    const data = await settingsService.upsertMethod(req.body);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.listPermissions = async (req, res) => {
  try {
    const data = await settingsService.listPermissions();
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.upsertPermission = async (req, res) => {
  try {
    assertCanManageSettings(req);
    const data = await settingsService.upsertPermission(req.body);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.listScopes = async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const data = await settingsService.listScopes(clientId);
    ok(res, data);
  } catch (e) { err(res, e); }
};

exports.upsertScope = async (req, res) => {
  try {
    assertCanManageSettings(req);
    const data = await settingsService.upsertScope(req.body);
    ok(res, data);
  } catch (e) { err(res, e); }
};
