// controllers/Reduction/m2FormulaController.js
const Formula = require('../../models/Reduction/Formula');
const Client  = require('../../models/Client');

// Roles allowed: super_admin, consultant_admin, consultant
function assertFormulaRole(user) {
  if (!user) throw new Error('Unauthenticated');
  const ok = ['super_admin','consultant_admin','consultant'].includes(user.userType);
  if (!ok) throw new Error('Forbidden');
}

// CREATE
exports.createFormula = async (req, res) => {
  try {
    assertFormulaRole(req.user);
    const { name, key, description, expression, variables, scope, status, version } = req.body;

    if (!name || !key || !expression) {
      return res.status(400).json({ success:false, message:'name, key, expression are required' });
    }

    // Optional guard: if scope.client specified, you could verify client exists
    if (scope?.type === 'client' && scope.clientId) {
      const exists = await Client.findOne({ clientId: scope.clientId }).select('_id');
      if (!exists) return res.status(400).json({ success:false, message: 'scope.clientId not found' });
    }

    const doc = await Formula.create({
      name, key, description: description || '', expression,
      variables: Array.isArray(variables) ? variables : [],
      scope: scope || { type: 'global' },
      status: status || 'draft',
      version: version || '1.0.0',
      createdBy: req.user._id || req.user.id
    });

    return res.status(201).json({ success:true, message:'Formula created', data: doc });
  } catch (err) {
    return res.status(500).json({ success:false, message:'Failed to create formula', error: err.message });
  }
};

// LIST
exports.listFormulas = async (req, res) => {
  try {
    assertFormulaRole(req.user);
    const { scopeType, clientId, status, q } = req.query;

    const filter = { isDeleted: false };
    if (scopeType) filter['scope.type'] = scopeType;
    if (clientId)  filter['scope.clientId'] = clientId;
    if (status)    filter.status = status;
    if (q)         filter.name = { $regex: new RegExp(q, 'i') };

    const items = await Formula.find(filter).sort({ updatedAt: -1 });
    return res.status(200).json({ success:true, data: items });
  } catch (err) {
    return res.status(500).json({ success:false, message:'Failed to list formulas', error: err.message });
  }
};

// GET ONE
exports.getFormula = async (req, res) => {
  try {
    assertFormulaRole(req.user);
    const doc = await Formula.findOne({ _id: req.params.id, isDeleted: false });
    if (!doc) return res.status(404).json({ success:false, message:'Not found' });
    return res.status(200).json({ success:true, data: doc });
  } catch (err) {
    return res.status(500).json({ success:false, message:'Failed to get formula', error: err.message });
  }
};

// UPDATE
exports.updateFormula = async (req, res) => {
  try {
    assertFormulaRole(req.user);
    const doc = await Formula.findOne({ _id: req.params.id, isDeleted: false });
    if (!doc) return res.status(404).json({ success:false, message:'Not found' });

    const { name, description, expression, variables, scope, status, version } = req.body;
    if (name != null)        doc.name = name;
    if (description != null) doc.description = description;
    if (expression != null)  doc.expression = expression;
    if (Array.isArray(variables)) doc.variables = variables;
    if (scope && scope.type) doc.scope = scope;
    if (status)              doc.status = status;
    if (version)             doc.version = version;
    doc.updatedBy = req.user._id || req.user.id;

    await doc.save();
    return res.status(200).json({ success:true, message:'Updated', data: doc });
  } catch (err) {
    return res.status(500).json({ success:false, message:'Failed to update formula', error: err.message });
  }
};

// DELETE (soft)
exports.deleteFormula = async (req, res) => {
  try {
    assertFormulaRole(req.user);
    const doc = await Formula.findOne({ _id: req.params.id, isDeleted: false });
    if (!doc) return res.status(404).json({ success:false, message:'Not found' });

    doc.isDeleted = true;
    doc.deletedAt = new Date();
    doc.deletedBy = req.user._id || req.user.id;
    await doc.save();

    return res.status(200).json({ success:true, message:'Deleted' });
  } catch (err) {
    return res.status(500).json({ success:false, message:'Failed to delete formula', error: err.message });
  }
};
