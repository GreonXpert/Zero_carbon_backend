'use strict';

/**
 * attachFormulaToReduction.js
 *
 * Reduction-specific controller for attaching a formula to a Reduction project.
 * Extracted from the old FormulaController.js when the formula module was
 * moved to src/modules/common/formula/.
 *
 * This logic stays in the reduction module because it involves:
 * - Reduction project validation (methodology2 check)
 * - Client permission checks
 * - Mapping formula variables to frozen/realtime/manual roles
 *
 * The formula lookup now uses the common Formula model.
 */

const Formula   = require('../../../common/formula/models/Formula');
const Reduction = require('../models/Reduction');
const Client    = require('../../../client-management/client/Client');

/** Map a formula to a Reduction project (m2.formulaRef) */
exports.attachFormulaToReduction = async (req, res) => {
  try {
    const user = req.user;

    // Role gate (routes also enforce this)
    const ALLOWED = new Set(['super_admin', 'consultant_admin', 'consultant']);
    if (!user || !ALLOWED.has(user.userType)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const { clientId, projectId } = req.params;
    const { formulaId, version, frozenValues } = req.body;

    // Ensure client exists
    const client = await Client.findOne({ clientId })
      .select('_id leadInfo.createdBy leadInfo.assignedConsultantId');
    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    // Permission check: creator admin or assigned consultant
    const uid = (user._id || user.id).toString();
    const isCreatorAdmin = user.userType === 'consultant_admin' &&
      client.leadInfo?.createdBy?.toString() === uid;
    const isAssignedConsultant = user.userType === 'consultant' &&
      client.leadInfo?.assignedConsultantId?.toString() === uid;

    if (!(user.userType === 'super_admin' || isCreatorAdmin || isAssignedConsultant)) {
      return res.status(403).json({
        success: false,
        message: 'Not allowed to attach formula to this reduction'
      });
    }

    // Formula must exist and not be deleted
    const formula = await Formula.findById(formulaId);
    if (!formula || formula.isDeleted) {
      return res.status(404).json({ success: false, message: 'Formula not found' });
    }

    // Reduction must exist and use methodology2
    const red = await Reduction.findOne({ clientId, projectId, isDeleted: false });
    if (!red) {
      return res.status(404).json({ success: false, message: 'Reduction not found' });
    }
    if (red.calculationMethodology !== 'methodology2') {
      return res.status(400).json({
        success: false,
        message: `Project uses ${red.calculationMethodology}; formula attach is only for methodology2`
      });
    }

    // Set formula reference
    red.m2 = red.m2 || {};
    red.m2.formulaRef = red.m2.formulaRef || {};
    red.m2.formulaRef.formulaId = formula._id;
    red.m2.formulaRef.version   = version || formula.version;

    // Assign variable roles (frozen/realtime/manual)
    const varKinds =
      req.body.variableKinds ||
      (req.body.formulaRef && req.body.formulaRef.variableKinds) ||
      {};
    if (varKinds && typeof varKinds === 'object') {
      red.m2.formulaRef.variableKinds = new Map(Object.entries(varKinds));
    }

    // Seed frozen variable values (optional)
    if (frozenValues && typeof frozenValues === 'object') {
      red.m2.formulaRef.variables = red.m2.formulaRef.variables || new Map();
      for (const [k, v] of Object.entries(frozenValues)) {
        red.m2.formulaRef.variables.set(k, {
          value: Number(v),
          updatePolicy: 'manual',
          lastUpdatedAt: new Date()
        });
      }
    }

    // Validate: all formula variables must have a declared role;
    // frozen variables must have numeric values.
    const missing  = [];
    const needVals = [];
    for (const v of (formula.variables || [])) {
      const role =
        (varKinds && varKinds[v.name]) ||
        red.m2.formulaRef.variableKinds?.get?.(v.name);
      if (!role) missing.push(v.name);
      if (role === 'frozen') {
        const fv = red.m2.formulaRef.variables?.get?.(v.name);
        if (!(fv && typeof fv.value === 'number' && isFinite(fv.value))) {
          needVals.push(v.name);
        }
      }
    }
    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: `Declare roles for: ${missing.join(', ')}`
      });
    }
    if (needVals.length) {
      return res.status(400).json({
        success: false,
        message: `Frozen values required for: ${needVals.join(', ')}`
      });
    }

    // Recompute LE etc. before save
    await red.validate();
    await red.save();

    return res.status(200).json({
      success: true,
      message: 'Formula attached',
      data: {
        clientId,
        projectId,
        formulaId: formula._id,
        version: red.m2.formulaRef.version
      }
    });

  } catch (e) {
    return res.status(500).json({
      success: false,
      message: 'Failed to attach formula',
      error: e.message
    });
  }
};
