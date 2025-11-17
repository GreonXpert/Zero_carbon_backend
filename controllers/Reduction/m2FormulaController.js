// controllers/Calculation/Reduction/m2FormulaController.js
const { Parser } = require('expr-eval');
const ReductionFormula = require('../../models/Reduction/Formula');
const Reduction = require('../../models/Reduction/Reduction');
const Client = require('../../models/Client');

// basic role gate (routes also apply this)
const ALLOWED_ROLES = new Set(['super_admin','consultant_admin','consultant']);

function ensureRole(req){
  if (!req.user) return 'Unauthenticated';
  if (!ALLOWED_ROLES.has(req.user.userType)) return 'Forbidden';
  return null;
}

/** Create a formula */
exports.createFormula = async (req,res)=>{
  try {
    const err = ensureRole(req);
    if (err) return res.status(403).json({ success:false, message: err });

    const { name, description,link, expression, variables, version } = req.body;
    if (!name || !expression) return res.status(400).json({ success:false, message:'name & expression required' });

    // quick parse check
    Parser.parse(expression);

    const doc = await ReductionFormula.create({
      name, description: description||'',link, expression, variables: variables||[], version: version||1,
      createdBy: req.user._id || req.user.id
    });

    res.status(201).json({ success:true, data: doc });
  } catch(e){
    res.status(500).json({ success:false, message:'Failed to create formula', error: e.message });
  }
};

exports.listFormulas = async (req,res)=>{
  try {
    const err = ensureRole(req);
    if (err) return res.status(403).json({ success:false, message: err });

    const list = await ReductionFormula.find({ isDeleted:false }).sort({ updatedAt: -1 });
    res.status(200).json({ success:true, data: list });
  } catch(e){
    res.status(500).json({ success:false, message:'Failed to list', error: e.message });
  }
};

exports.getFormula = async (req,res)=>{
  try {
    const err = ensureRole(req);
    if (err) return res.status(403).json({ success:false, message: err });

    const doc = await ReductionFormula.findById(req.params.formulaId);
    if (!doc || doc.isDeleted) return res.status(404).json({ success:false, message:'Not found' });
    res.status(200).json({ success:true, data: doc });
  } catch(e){
    res.status(500).json({ success:false, message:'Failed to fetch', error: e.message });
  }
};

exports.updateFormula = async (req,res)=>{
  try {
    const err = ensureRole(req);
    if (err) return res.status(403).json({ success:false, message: err });

    const doc = await ReductionFormula.findById(req.params.formulaId);
    if (!doc || doc.isDeleted) return res.status(404).json({ success:false, message:'Not found' });

    const { name, description, link, expression, variables, version } = req.body;

    if (expression) Parser.parse(expression); // validate expression

    if (name != null)        doc.name = name;
    if (description != null) doc.description = description;
    if (expression != null)  doc.expression = expression;
    if (link != null)        doc.link = link;
    if (Array.isArray(variables)) doc.variables = variables;
    if (version != null)     doc.version = version;

    await doc.save();
    res.status(200).json({ success:true, data: doc });
  } catch(e){
    res.status(500).json({ success:false, message:'Failed to update', error: e.message });
  }
};

exports.deleteFormula = async (req, res) => {
  try {
    const err = ensureRole(req); // super_admin | consultant_admin | consultant
    if (err) return res.status(403).json({ success: false, message: err });

    const { formulaId } = req.params;
    const modeParam =
      (req.params.mode || req.params.deleteType || req.query.mode || '').toString().toLowerCase();
    const isHard = modeParam === 'hard';

    // Soft delete (default): /api/m2/formulas/:formulaId
    if (!isHard) {
      const doc = await ReductionFormula.findById(formulaId);
      if (!doc) {
        return res.status(404).json({ success: false, message: 'Not found' });
      }
      if (doc.isDeleted) {
        // already soft-deleted; idempotent success
        return res.status(200).json({ success: true, message: 'Already deleted (soft)' });
      }
      doc.isDeleted = true;
      await doc.save();
      return res.status(200).json({ success: true, message: 'Deleted (soft)' });
    }

    // Hard delete: /api/m2/formulas/:formulaId/hard
    // Safety check: block hard delete if attached to any active Reduction (m2.formulaRef.formulaId)
    const attached = await Reduction.exists({
      isDeleted: false,
      'm2.formulaRef.formulaId': formulaId
    });

    if (attached) {
      return res.status(409).json({
        success: false,
        message:
          'Cannot hard delete: formula is attached to one or more reductions. Detach first or soft delete instead.'
      });
    }

    const result = await ReductionFormula.deleteOne({ _id: formulaId });
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Not found' });
    }
    return res.status(200).json({ success: true, message: 'Deleted (hard)' });
  } catch (e) {
    return res
      .status(500)
      .json({ success: false, message: 'Failed to delete', error: e.message });
  }
};

/** Map a formula to a Reduction (m2.formulaRef) */
exports.attachFormulaToReduction = async (req,res)=>{
  try {
    const err = ensureRole(req);
    if (err) return res.status(403).json({ success:false, message: err });

    const { clientId, projectId } = req.params;
    const { formulaId, version, frozenValues } = req.body; // frozenValues: { varName: number, ... }

    // ensure client exists
    const client = await Client.findOne({ clientId }).select('_id leadInfo.createdBy leadInfo.assignedConsultantId');
    if (!client) return res.status(404).json({ success:false, message:'Client not found' });

    // basic permission like your m1 create/update (creator admin or assigned consultant)
    const uid = (req.user._id || req.user.id).toString();
    const isCreatorAdmin = req.user.userType === 'consultant_admin' &&
      client.leadInfo?.createdBy?.toString() === uid;
    const isAssignedConsultant = req.user.userType === 'consultant' &&
      client.leadInfo?.assignedConsultantId?.toString() === uid;

    if (!(req.user.userType === 'super_admin' || isCreatorAdmin || isAssignedConsultant)) {
      return res.status(403).json({ success:false, message:'Not allowed to attach formula to this reduction' });
    }

    const formula = await ReductionFormula.findById(formulaId);
    if (!formula || formula.isDeleted) return res.status(404).json({ success:false, message:'Formula not found' });

    const red = await Reduction.findOne({ clientId, projectId, isDeleted:false });
    if (!red) return res.status(404).json({ success:false, message:'Reduction not found' });
    if (red.calculationMethodology !== 'methodology2') {
      return res.status(400).json({ success:false, message:`Project uses ${red.calculationMethodology}` });
    }

    red.m2 = red.m2 || {};
    red.m2.formulaRef = red.m2.formulaRef || {};
    red.m2.formulaRef.formulaId = formula._id;
    red.m2.formulaRef.version   = version || formula.version;

        // roles
    const varKinds = req.body.variableKinds || (req.body.formulaRef && req.body.formulaRef.variableKinds) || {};
    if (varKinds && typeof varKinds === 'object') {
      red.m2.formulaRef.variableKinds = new Map(Object.entries(varKinds));
    }


    // seed frozen variable values (optional)
    if (frozenValues && typeof frozenValues === 'object') {
      red.m2.formulaRef.variables = red.m2.formulaRef.variables || new Map();
      for (const [k,v] of Object.entries(frozenValues)) {
        red.m2.formulaRef.variables.set(k, { value: Number(v), updatePolicy: 'manual', lastUpdatedAt: new Date() });
      }
    }

        // Hard check here too (friendlier 400s than model error)
    const missing = [];
    const needVals = [];
    for (const v of (formula.variables || [])) {
      const role = (varKinds && varKinds[v.name]) || (red.m2.formulaRef.variableKinds?.get?.(v.name));
      if (!role) missing.push(v.name);
      if (role === 'frozen') {
        const fv = red.m2.formulaRef.variables?.get?.(v.name);
        if (!(fv && typeof fv.value === 'number' && isFinite(fv.value))) needVals.push(v.name);
      }
    }
    if (missing.length) return res.status(400).json({ success:false, message:`Declare roles for: ${missing.join(', ')}` });
    if (needVals.length) return res.status(400).json({ success:false, message:`Frozen values required for: ${needVals.join(', ')}` });


    await red.validate(); // recompute LE etc
    await red.save();

    res.status(200).json({ success:true, message:'Formula attached', data: {
      clientId, projectId, formulaId: formula._id, version: red.m2.formulaRef.version
    }});
  } catch(e){
    res.status(500).json({ success:false, message:'Failed to attach formula', error: e.message });
  }
};
