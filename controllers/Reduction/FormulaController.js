// controllers/Calculation/Reduction/m2FormulaController.js
const { Parser } = require('expr-eval');
const ReductionFormula = require('../../models/Reduction/Formula');
const Reduction = require('../../models/Reduction/Reduction');
const Client = require('../../models/CMS/Client');
const DeleteRequest = require('../../models/Reduction/DeleteRequest');
const User = require('../../models/User');   

const {
  notifyFormulaDeleteRequested,
  notifyFormulaDeleteApproved,
  notifyFormulaDeleteRejected
} = require('../../utils/notifications/formulaNotifications');


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

  const { name, description, link, expression, variables, version, clientIds } = req.body;

if (!name || !expression)
  return res.status(400).json({ success:false, message:'name & expression required' });

// NEW: Validate clientIds array of STRINGS
if (!Array.isArray(clientIds) || clientIds.length === 0) {
  return res.status(400).json({
    success:false,
    message: "clientIds must be a non-empty array of strings"
  });
}

// Ensure all are strings and not empty
for (const id of clientIds) {
  if (typeof id !== "string" || id.trim() === "") {
    return res.status(400).json({
      success:false,
      message:`Invalid clientId (must be string): ${id}`
    });
  }
}

Parser.parse(expression);

const doc = await ReductionFormula.create({
  name,
  description: description || "",
  link,
  expression,
  variables: variables || [],
  version: version || 1,
  clientIds,                                // STORE HERE
  createdBy: req.user._id || req.user.id
});

    res.status(201).json({ success:true, data: doc });
  } catch(e){
    res.status(500).json({ success:false, message:'Failed to create formula', error: e.message });
  }
};

exports.listFormulas = async (req, res) => {
  try {
    const user = req.user;

    // =============================================
    // SUPER ADMIN → all formulas
    // =============================================
    if (user.userType === "super_admin") {
      const formulas = await ReductionFormula.find({ isDeleted: false });
      return res.status(200).json({ success: true, data: formulas });
    }

    // =============================================
    // CONSULTANT_ADMIN → only team formulas
    // =============================================
    if (user.userType === "consultant_admin") {
      const team = await User.find({
        $or: [
          { _id: user.id },
          { consultantAdminId: user.id, userType: "consultant" }
        ]
      }).select("_id");

      const teamIds = team.map(t => String(t._id));

      const formulas = await ReductionFormula.find({
        isDeleted: false,
        createdBy: { $in: teamIds }
      });

      return res.status(200).json({ success: true, data: formulas });
    }

    // =============================================
    // CONSULTANT → formulas for their assigned clients
    // =============================================
// =============================================
    // CONSULTANT → formulas for their assigned clients
    // =============================================
    if (user.userType === "consultant") {
      
      // ✅ FIX START: Fetch the full user document to get assignedClients and consultantAdminId
      // The 'auth' middleware only provides a partial user object.
      const fullUser = await User.findById(user.id || user._id);
      
      if (!fullUser) {
         return res.status(404).json({ success: false, message: "User details not found" });
      }

      const assignedClients = fullUser.assignedClients || [];

      const consultantTeam = await User.find({
        $or: [
          { _id: fullUser._id },
          { consultantAdminId: fullUser.consultantAdminId, userType: "consultant" }
        ]
      }).select("_id");
      // ✅ FIX END

      const teamIds = consultantTeam.map(t => String(t._id));

      const formulas = await ReductionFormula.find({
        isDeleted: false,
        $or: [
          { clientIds: { $in: assignedClients }},
          { createdBy: { $in: teamIds }}
        ]
      });

      return res.status(200).json({ success: true, data: formulas });
    }


   

    // =============================================
    // CLIENT_ADMIN → formulas belonging to their client
    // =============================================
    if (user.userType === "client_admin") {
      const clientId = user.clientId;

      const formulas = await ReductionFormula.find({
        isDeleted: false,
        clientIds: clientId
      });

      return res.status(200).json({ success: true, data: formulas });
    }

    // =============================================
    // AUDITOR → Can view formulas belonging to the client they audit
    // =============================================
    if (user.userType === "auditor") {
      const clientId = user.clientId;

      const formulas = await ReductionFormula.find({
        isDeleted: false,
        clientIds: clientId
      });

      return res.status(200).json({ success: true, data: formulas });
    }

    return res.status(403).json({
      success: false,
      message: "Unauthorized role"
    });

  } catch (e) {
    return res.status(500).json({
      success: false,
      message: "Failed to list formulas",
      error: e.message
    });
  }
};


exports.getFormula = async (req, res) => {
  try {
    const user = req.user;
    const { formulaId } = req.params;

    const formula = await ReductionFormula.findById(formulaId).lean();
    if (!formula || formula.isDeleted) {
      return res.status(404).json({
        success: false,
        message: "Formula not found"
      });
    }

    // =============================================
    // SUPER ADMIN → full access
    // =============================================
    if (user.userType === "super_admin") {
      return res.status(200).json({ success: true, data: formula });
    }

    // =============================================
    // CONSULTANT_ADMIN → only team formulas
    // =============================================
    if (user.userType === "consultant_admin") {
      const team = await User.find({
        $or: [
          { _id: user.id },
          { consultantAdminId: user.id, userType: "consultant" }
        ]
      }).select("_id");

      const teamIds = team.map(u => String(u._id));

      if (!teamIds.includes(String(formula.createdBy))) {
        return res.status(403).json({
          success: false,
          message: "You can only view formulas created by your consultant team."
        });
      }

      return res.status(200).json({ success: true, data: formula });
    }

    // =============================================
    // CONSULTANT → formulas of their assigned clients
    // =============================================
   // =============================================
    // CONSULTANT → formulas for their assigned clients
    // =============================================
    if (user.userType === "consultant") {
      
      // ✅ FIX START: Fetch the full user document to get assignedClients and consultantAdminId
      // The 'auth' middleware only provides a partial user object.
      const fullUser = await User.findById(user.id || user._id);
      
      if (!fullUser) {
         return res.status(404).json({ success: false, message: "User details not found" });
      }

      const assignedClients = fullUser.assignedClients || [];

      const consultantTeam = await User.find({
        $or: [
          { _id: fullUser._id },
          { consultantAdminId: fullUser.consultantAdminId, userType: "consultant" }
        ]
      }).select("_id");
      // ✅ FIX END

      const teamIds = consultantTeam.map(t => String(t._id));

      const formulas = await ReductionFormula.find({
        isDeleted: false,
        $or: [
          { clientIds: { $in: assignedClients }},
          { createdBy: { $in: teamIds }}
        ]
      });

      return res.status(200).json({ success: true, data: formulas });
    }


    // =============================================
    // CLIENT_ADMIN → see formulas belonging to their client
    // =============================================
    if (user.userType === "client_admin") {
      const clientId = user.clientId;
      if (!formula.clientIds.includes(clientId)) {
        return res.status(403).json({
          success: false,
          message: "This formula does not belong to your client."
        });
      }
      return res.status(200).json({ success: true, data: formula });
    }

    // =============================================
    // AUDITOR → allowed same view as client_admin
    // =============================================
    if (user.userType === "auditor") {
      const clientId = user.clientId; // auditor is assigned to one client
      if (!formula.clientIds.includes(clientId)) {
        return res.status(403).json({
          success: false,
          message: "Auditor: You can only view formulas of the client you audit."
        });
      }
      return res.status(200).json({ success: true, data: formula });
    }

    return res.status(403).json({
      success: false,
      message: "Forbidden"
    });

  } catch (e) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch formula",
      error: e.message
    });
  }
};




exports.updateFormula = async (req,res)=>{
  try {
    const err = ensureRole(req);
    if (err) return res.status(403).json({ success:false, message: err });

    const doc = await ReductionFormula.findById(req.params.formulaId);
    if (!doc || doc.isDeleted) return res.status(404).json({ success:false, message:'Not found' });

  const {
  name,
  description,
  link,
  expression,
  variables,
  version,
  clientIds,        // full replace
  addClientIds,     // add
  removeClientIds   // remove
} = req.body;

if (expression) Parser.parse(expression);

if (name != null)        doc.name = name;
if (description != null) doc.description = description;
if (expression != null)  doc.expression = expression;
if (link != null)        doc.link = link;
if (Array.isArray(variables)) doc.variables = variables;
if (version != null)     doc.version = version;

// --- FULL REPLACE ---
if (Array.isArray(clientIds)) {
  for (const id of clientIds) {
    if (typeof id !== "string" || id.trim() === "") {
      return res.status(400).json({ success:false, message:`Invalid clientId: ${id}` });
    }
  }
  doc.clientIds = clientIds;
}

// --- ADD ---
if (Array.isArray(addClientIds)) {
  for (const id of addClientIds) {
    if (typeof id !== "string" || id.trim() === "") {
      return res.status(400).json({ success:false, message:`Invalid clientId: ${id}` });
    }
    if (!doc.clientIds.includes(id)) doc.clientIds.push(id);
  }
}

// --- REMOVE ---
if (Array.isArray(removeClientIds)) {
  doc.clientIds = doc.clientIds.filter(id => !removeClientIds.includes(id));
}

await doc.save();


    res.status(200).json({ success:true, data: doc });
  } catch(e){
    res.status(500).json({ success:false, message:'Failed to update', error: e.message });
  }
};

exports.deleteFormula = async (req, res) => {
  try {
    const user = req.user;
    const { formulaId } = req.params;

    const isSuper = user.userType === "super_admin";
    const isAdmin = user.userType === "consultant_admin";
    const isConsultant = user.userType === "consultant";

    // ==================================================
    // CASE 1: CONSULTANT → CREATE DELETE REQUEST
    // ==================================================
    if (isConsultant) {
      const existing = await DeleteRequest.findOne({
        formulaId,
        requestedBy: user.id,
        status: "pending"
      });

      if (existing) {
        return res.status(200).json({
          success: true,
          message: "Delete request already submitted and pending approval."
        });
      }

      const reqDoc = await DeleteRequest.create({
        formulaId,
        requestedBy: user.id,
        reason: req.body.reason || ""
      });

      // Notify consultant_admin + super_admin
      const formula = await ReductionFormula.findById(formulaId).lean();
      const approvers = await User.find({
        userType: { $in: ["super_admin", "consultant_admin"] },
        isActive: true
      }).select("_id");

      await notifyFormulaDeleteRequested({
        actor: user,
        formula,
        approverIds: approvers.map(u => u._id)
      });

      return res.status(200).json({
        success: true,
        message: "Delete request submitted to Consultant Admin / Super Admin."
      });
    }

    // ==================================================
    // CASE 2: CONSULTANT_ADMIN / SUPER_ADMIN → DELETE NOW
    // ==================================================
    if (isAdmin || isSuper) {
      const modeParam =
        (req.params.mode || req.params.deleteType || req.query.mode || "")
          .toString()
          .toLowerCase();
      const isHard = modeParam === "hard";

      // Get formula early so it can be used in notification
      const formula = await ReductionFormula.findById(formulaId);
      if (!formula) {
        return res.status(404).json({ success: false, message: "Formula not found" });
      }

      // ---------------- SOFT DELETE ----------------
      if (!isHard) {
        formula.isDeleted = true;
        await formula.save();

        // ---- auto-approve pending requests ----
        const requests = await DeleteRequest.find({
          formulaId,
          status: "pending"
        });

        await DeleteRequest.updateMany(
          { formulaId, status: "pending" },
          { status: "approved", approvedBy: user.id, approvedAt: new Date() }
        );

        // ---- send notification to each consultant requester ----
        for (const request of requests) {
          await notifyFormulaDeleteApproved({
            actor: user,
            formula,
            request
          });
        }

        return res.status(200).json({
          success: true,
          message: "Formula deleted (soft) by admin."
        });
      }

      // ---------------- HARD DELETE ----------------
      const attached = await Reduction.exists({
        isDeleted: false,
        "m2.formulaRef.formulaId": formulaId
      });

      if (attached) {
        return res.status(409).json({
          success: false,
          message: "Cannot hard delete: formula attached to reduction projects."
        });
      }

      await ReductionFormula.deleteOne({ _id: formulaId });

      const requests = await DeleteRequest.find({
        formulaId,
        status: "pending"
      });

      await DeleteRequest.updateMany(
        { formulaId, status: "pending" },
        { status: "approved", approvedBy: user.id, approvedAt: new Date() }
      );

      // ---- notify each consultant who requested ----
      for (const request of requests) {
        await notifyFormulaDeleteApproved({
          actor: user,
          formula,
          request
        });
      }

      return res.status(200).json({
        success: true,
        message: "Formula deleted permanently (hard) by admin."
      });
    }

    // ==================================================
    // CASE 3: CLIENTS OR OTHERS → DENY
    // ==================================================
    return res.status(403).json({
      success: false,
      message: "You are not allowed to delete or request deletion for formulas."
    });

  } catch (e) {
    return res.status(500).json({
      success: false,
      message: "Failed to delete formula",
      error: e.message
    });
  }
};

exports.approveDeleteRequest = async (req, res) => {
  try {
    const user = req.user;

    // Only super_admin or consultant_admin can approve
    if (!['super_admin', 'consultant_admin'].includes(user.userType)) {
      return res.status(403).json({
        success: false,
        message: "Only Consultant Admin / Super Admin can approve"
      });
    }

    const { requestId } = req.params;

    // Find delete request
    const request = await DeleteRequest.findById(requestId);
    if (!request || request.status !== "pending") {
      return res.status(404).json({
        success: false,
        message: "Request not found or already processed"
      });
    }

    // Find formula to delete
    const formula = await ReductionFormula.findById(request.formulaId);
    if (!formula) {
      return res.status(404).json({
        success: false,
        message: "Formula does not exist"
      });
    }

    // SOFT DELETE the formula
    formula.isDeleted = true;
    await formula.save();

    // Approve request
    request.status = "approved";
    request.approvedBy = user.id;
    request.approvedAt = new Date();
    await request.save();

    // ===================================================
    // 🔔 SEND NOTIFICATION TO THE CONSULTANT WHO REQUESTED
    // ===================================================
    await notifyFormulaDeleteApproved({
      actor: user,      // admin/super admin approving
      formula,          // formula being deleted
      request           // includes requestedBy (consultant)
    });

    return res.status(200).json({
      success: true,
      message: "Delete request approved & formula deleted."
    });

  } catch (e) {
    return res.status(500).json({
      success: false,
      message: "Failed to approve request",
      error: e.message
    });
  }
};


exports.rejectDeleteRequest = async (req, res) => {
  try {
    const user = req.user;

    // Only consultant_admin or super_admin can reject
    if (!['super_admin', 'consultant_admin'].includes(user.userType)) {
      return res.status(403).json({
        success: false,
        message: "Only Consultant Admin or Super Admin can reject delete requests."
      });
    }

    const { requestId } = req.params;

    // Find delete request
    const request = await DeleteRequest.findById(requestId)
      .populate("requestedBy", "userName email");

    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Delete request not found."
      });
    }

    if (request.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: "This request is already processed."
      });
    }

    // NEED THE FORMULA for the notification
    const formula = await ReductionFormula.findById(request.formulaId).lean();
    if (!formula) {
      return res.status(404).json({
        success: false,
        message: "Formula does not exist anymore"
      });
    }

    // ================
    // REJECT REQUEST
    // ================
    request.status = "rejected";
    request.approvedBy = user.id;
    request.approvedAt = new Date();
    await request.save();

    // ==============================================
    // 🔔 SEND NOTIFICATION TO REQUESTING CONSULTANT
    // ==============================================
    await notifyFormulaDeleteRejected({
      actor: user,      // admin/super admin who rejected
      formula,          // formula info
      request           // contains requestedBy user
    });

    return res.status(200).json({
      success: true,
      message: "Delete request rejected successfully."
    });

  } catch (e) {
    return res.status(500).json({
      success: false,
      message: "Failed to reject delete request",
      error: e.message
    });
  }
};

exports.getDeleteRequestedIds = async (req, res) => {
  try {
    const user = req.user;

    // SUPER ADMIN → all requests
    if (user.userType === "super_admin") {
      const data = await DeleteRequest.find().populate("requestedBy", "userName");
      return res.status(200).json({ success: true, data });
    }

    // CONSULTANT ADMIN → only requests from their team
    if (user.userType === "consultant_admin") {
      const team = await User.find({
        $or: [
          { _id: user.id },
          { consultantAdminId: user.id, userType: "consultant" }
        ]
      }).select("_id");

      const teamIds = team.map(u => String(u._id));

      const data = await DeleteRequest.find({
        requestedBy: { $in: teamIds }
      }).populate("requestedBy", "userName");

      return res.status(200).json({ success: true, data });
    }

    // CONSULTANT → only their own requests
    if (user.userType === "consultant") {
      const data = await DeleteRequest.find({
        requestedBy: user.id
      });

      return res.status(200).json({ success: true, data });
    }

    return res.status(403).json({ success: false, message: "Forbidden" });

  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};


exports.getDeleteRequestedById = async (req, res) => {
  try {
    const { requestId } = req.params;
    const user = req.user;

    const request = await DeleteRequest.findById(requestId)
      .populate("requestedBy", "userName email")
      .lean();

    if (!request) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    // SUPER ADMIN → full access
    if (user.userType === "super_admin") {
      return res.status(200).json({ success: true, data: request });
    }

    // CONSULTANT ADMIN → only own team
    if (user.userType === "consultant_admin") {
      const team = await User.find({
        $or: [
          { _id: user.id },
          { consultantAdminId: user.id, userType: "consultant" }
        ]
      }).select("_id");

      const teamIds = team.map(u => String(u._id));

      if (!teamIds.includes(String(request.requestedBy._id))) {
        return res.status(403).json({ success: false, message: "Not your team request" });
      }

      return res.status(200).json({ success: true, data: request });
    }

    // CONSULTANT → only their own requests
    if (user.userType === "consultant") {
      if (String(request.requestedBy._id) !== String(user.id)) {
        return res.status(403).json({ success: false, message: "Forbidden" });
      }
      return res.status(200).json({ success: true, data: request });
    }

    return res.status(403).json({ success: false, message: "Forbidden" });

  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};



exports.filterDeleteRequested = async (req, res) => {
  try {
    const user = req.user;
    const {
      status,
      formulaId,
      requestedBy,
      clientId,
      fromDate,
      toDate
    } = req.query;

    let query = {};

    // consultant_admin → restricted to team
    if (user.userType === "consultant_admin") {
      const team = await User.find({
        $or: [
          { _id: user.id },
          { consultantAdminId: user.id, userType: "consultant" }
        ]
      }).select("_id");

      const teamIds = team.map(u => String(u._id));
      query.requestedBy = { $in: teamIds };
    }

    // consultant → only their requests
    else if (user.userType === "consultant") {
      query.requestedBy = user.id;
    }

    if (status) query.status = status;
    if (formulaId) query.formulaId = formulaId;
    if (requestedBy) query.requestedBy = requestedBy;

    if (fromDate || toDate) {
      query.createdAt = {};
      if (fromDate) query.createdAt.$gte = new Date(fromDate);
      if (toDate) query.createdAt.$lte = new Date(toDate);
    }

    if (clientId) {
      const formulas = await ReductionFormula.find({
        clientIds: clientId
      }).select("_id");
      query.formulaId = { $in: formulas.map(f => f._id.toString()) };
    }

    const result = await DeleteRequest.find(query)
      .populate("requestedBy", "userName email");

    return res.status(200).json({ success: true, data: result });

  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
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
