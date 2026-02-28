const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true },
    contactNumber: { type: String, required: true },
    userName: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    userType: {
      type: String,
      required: true,
      // 🆕 ADDED: supportManager and support
      enum: [
        "super_admin", 
        "consultant_admin", 
        "consultant",
        "supportManager",     // NEW: Support team manager
        "support",            // NEW: Support team member
        "client_admin", 
        "client_employee_head", 
        "employee", 
        "viewer", 
        "auditor"
      ],
    },
    address: { type: String, required: true },
    companyName: { type: String },
    isFirstLogin: { type: Boolean, default: true },
    isActive: { type: Boolean, default: false },

    // ===== SANDBOX FLAG =====
    sandbox: { 
      type: Boolean, 
      default: false 
    },
    
    // Hierarchical relationships
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    parentUser: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    
    // Client relationship
    clientId: { type: String }, // Format: Greon001, Greon002, etc.
    
    // Super Admin specific
    role: { type: String }, // Only for super admin
    
    // Consultant Admin specific
    teamName: { type: String },
    assignedClients: [{ type: String }], // Array of clientIds
    
    // Consultant specific
    employeeId: { type: String },
    jobRole: { type: String },
    branch: { type: String },
    consultantAdminId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    hasAssignedClients: { type: Boolean, default: false },

    // 🆕 SUPPORT MANAGER SPECIFIC FIELDS
    supportTeamName: { 
      type: String 
      // e.g., "Customer Success Team A", "Technical Support Team"
    },
    
    assignedSupportClients: [{ 
      type: String 
      // Array of clientIds this support manager handles
      // e.g., ["Greon001", "Greon002", "Greon005"]
    }],
    
    assignedConsultants: [{ 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "User" 
      // Array of consultant/consultant_admin IDs this support manager supports
      // These consultants can raise tickets that come to this support manager
    }],
    
    supportManagerType: {
      type: String,
      enum: ['client_support', 'consultant_support', 'general_support'],
      default: 'general_support'
      // client_support: Handles only client-side tickets
      // consultant_support: Handles only consultant-side tickets (for consultants' internal issues)
      // general_support: Handles all types of tickets
    },

    // 🆕 SUPPORT USER SPECIFIC FIELDS
    supportManagerId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "User" 
      // Reference to Support Manager (similar to consultantAdminId)
    },
    
    supportEmployeeId: { 
      type: String 
      // Employee ID for support staff (e.g., "SUP-001")
    },
    
    supportJobRole: { 
      type: String 
      // Role like "Technical Support Specialist", "Customer Success Manager"
    },
    
    supportBranch: { 
      type: String 
      // Support branch/location if applicable
    },
    
    supportSpecialization: [{
      type: String,
      enum: [
        'technical',          // Technical issues, system errors
        'data_issues',        // Data-related problems
        'training',           // Training and onboarding
        'billing',            // Billing and subscriptions
        'compliance',         // Compliance and audit support
        'general'             // General support
      ]
    }], // Areas of expertise for routing tickets
    
    // Client Employee Head specific
    department: { type: String },
    location: { type: String },
    
    // Employee specific
    employeeHeadId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    assignedModules: [{ type: String }],
    
    // Auditor specific
    auditPeriod: {
      startDate: { type: Date },
      endDate: { type: Date }
    },
    auditScope: [{ type: String }],
    
    // Viewer specific
    viewerPurpose: { type: String },
    viewerExpiryDate: { type: Date },

    // Profile image metadata
    profileImage: {
      filename: { type: String },
      path:     { type: String },
      url:      { type: String },
      uploadedAt: { type: Date },
      storedAt: { type: String }
    },
    
    // Permissions
    permissions: {
      canViewAllClients: { type: Boolean, default: false },
      canManageUsers: { type: Boolean, default: false },
      canManageClients: { type: Boolean, default: false },
      canViewReports: { type: Boolean, default: false },
      canEditBoundaries: { type: Boolean, default: false },
      canSubmitData: { type: Boolean, default: false },
      canAudit: { type: Boolean, default: false },
      // 🆕 NEW PERMISSIONS FOR SUPPORT
      canManageSupportTeam: { type: Boolean, default: false }, // For supportManager
      canViewAllTickets: { type: Boolean, default: false },    // For supportManager
      canAssignTickets: { type: Boolean, default: false }      // For supportManager
    },
    
    assessmentLevel: {
      type: [String],
      enum: ['reduction', 'decarbonization', 'organization', 'process', 'both'],
      default: []
    },

    // ╔══════════════════════════════════════════════════════════╗
    // ║  ACCESS CONTROLS CHECKLIST (viewer / auditor only)       ║
    // ║  Assigned by client_admin at create / edit time.         ║
    // ║  All defaults are FALSE (fail-closed).                   ║
    // ║  Enforced via utils/Permissions/accessControlPermission  ║
    // ╚══════════════════════════════════════════════════════════╝
    accessControls: {
      modules: {
        emission_summary: {
          enabled: { type: Boolean, default: false },
          sections: {
            overview:         { type: Boolean, default: false },
            byScope:          { type: Boolean, default: false },
            byNode:           { type: Boolean, default: false },
            byDepartment:     { type: Boolean, default: false },
            byLocation:       { type: Boolean, default: false },
            processEmission:  { type: Boolean, default: false },
            reductionSummary: { type: Boolean, default: false },
            trends:           { type: Boolean, default: false },
            metadata:         { type: Boolean, default: false },
          },
        },
        data_entry: {
          enabled: { type: Boolean, default: false },
          sections: {
            list:             { type: Boolean, default: false },
            detail:           { type: Boolean, default: false },
            editHistory:      { type: Boolean, default: false },
            logs:             { type: Boolean, default: false },
            cumulativeValues: { type: Boolean, default: false },
            stats:            { type: Boolean, default: false },
          },
        },
        process_flowchart: {
          enabled: { type: Boolean, default: false },
          sections: {
            view:                   { type: Boolean, default: false },
            entries:                { type: Boolean, default: false },
            processEmissionEntries: { type: Boolean, default: false },
          },
        },
        organization_flowchart: {
          enabled: { type: Boolean, default: false },
          sections: {
            view:        { type: Boolean, default: false },
            nodes:       { type: Boolean, default: false },
            assignments: { type: Boolean, default: false },
          },
        },
        reduction: {
          enabled: { type: Boolean, default: false },
          sections: {
            list:         { type: Boolean, default: false },
            detail:       { type: Boolean, default: false },
            netReduction: { type: Boolean, default: false },
            summary:      { type: Boolean, default: false },
          },
        },
        decarbonization: {
          enabled: { type: Boolean, default: false },
          sections: {
            sbti:    { type: Boolean, default: false },
            targets: { type: Boolean, default: false },
          },
        },
        reports: {
          enabled: { type: Boolean, default: false },
          sections: {
            basic:    { type: Boolean, default: false },
            detailed: { type: Boolean, default: false },
            export:   { type: Boolean, default: false },
          },
        },
        tickets: {
          enabled: { type: Boolean, default: false },
          sections: {
            view:   { type: Boolean, default: false },
            create: { type: Boolean, default: false },
          },
        },
         // audit_logs — controls what audit log data a viewer/auditor can read.
        //
        // HOW IT WORKS:
        //   Page-level sections: list, detail, export — control UI page visibility.
        //   Per-module sections (*_logs) — control which AuditLog.module rows are returned.
        //   logPermission._buildModuleFilter() reads these to build { module: { $in: [...] } }.
        //
        // AUTH RESTRICTION:
        //   'auth' logs are ALWAYS blocked for viewer/auditor at the logPermission layer.
        //   There is no 'auth_logs' section — it cannot be granted via checklist.
        //   Only super_admin, consultant_admin, consultant see auth logs (no schema field needed).
        audit_logs: {
          enabled: { type: Boolean, default: false },
          sections: {
            // Page-level access
            list:                     { type: Boolean, default: false },
            detail:                   { type: Boolean, default: false },
            export:                   { type: Boolean, default: false },
            // Per audit-service module access
            // Each controls visibility of AuditLog rows where module === mapped value
            data_entry_logs:          { type: Boolean, default: false }, // module: 'data_entry'
            flowchart_logs:           { type: Boolean, default: false }, // module: 'organization_flowchart'
            process_flowchart_logs:   { type: Boolean, default: false }, // module: 'process_flowchart'
            transport_flowchart_logs: { type: Boolean, default: false }, // module: 'transport_flowchart'
            reduction_logs:           { type: Boolean, default: false }, // module: 'reduction'
            net_reduction_logs:       { type: Boolean, default: false }, // module: 'net_reduction'
            sbti_logs:                { type: Boolean, default: false }, // module: 'sbti'
            emission_summary_logs:    { type: Boolean, default: false }, // module: 'emission_summary'
            user_management_logs:     { type: Boolean, default: false }, // module: 'user_management'
            system_logs:              { type: Boolean, default: false }, // module: 'system'
          },
        },
      },
    },
  },
  { timestamps: true }
);

// ===== ENFORCE SANDBOX/ACTIVE INVARIANTS =====
userSchema.pre('save', function(next) {
  if (this.sandbox === true && this.isActive === true) {
    return next(new Error('User cannot be both sandbox and active'));
  }
  
  if (this.isModified('sandbox')) {
    if (this.sandbox === true) {
      this.isActive = false;
    }
  }
  
  if (this.isModified('isActive')) {
    if (this.isActive === true) {
      this.sandbox = false;
    }
  }
  
  // 🆕 AUTO-SET PERMISSIONS FOR SUPPORT MANAGER
  if (this.userType === 'supportManager' && this.isModified('userType')) {
    this.permissions.canManageSupportTeam = true;
    this.permissions.canViewAllTickets = true;
    this.permissions.canAssignTickets = true;
  }
  
  next();
});

// ===== METHOD TO CHECK SANDBOX ACCESS =====
userSchema.methods.hasSandboxAccess = function(route) {
  if (!this.sandbox) return true;
  
  const sandboxAllowedRoutes = [
    '/api/dashboard',
    '/api/profile',
    '/api/clients/own',
    '/api/proposal/view',
    '/api/submission/status',
    '/api/flowchart/view',
    '/api/reports/basic',
  ];
  
  return sandboxAllowedRoutes.some(allowed => 
    route.startsWith(allowed)
  );
};

// 🆕 METHOD TO CHECK IF USER IS SUPPORT STAFF
userSchema.methods.isSupportStaff = function() {
  return ['supportManager', 'support'].includes(this.userType);
};

// 🆕 METHOD TO CHECK IF USER IS CONSULTANT STAFF
userSchema.methods.isConsultantStaff = function() {
  return ['consultant_admin', 'consultant'].includes(this.userType);
};

// 🆕 METHOD TO CHECK IF USER CAN MANAGE SUPPORT TEAM
userSchema.methods.canManageSupportTeam = function() {
  return this.userType === 'supportManager' || this.userType === 'super_admin';
};

// 🆕 METHOD TO GET SUPPORT MANAGER FOR A SUPPORT USER
userSchema.methods.getSupportManager = async function() {
  if (this.userType !== 'support' || !this.supportManagerId) {
    return null;
  }
  return await mongoose.model('User').findById(this.supportManagerId);
};

// 🆕 METHOD TO GET SUPPORT TEAM MEMBERS FOR A SUPPORT MANAGER
userSchema.methods.getSupportTeamMembers = async function() {
  if (this.userType !== 'supportManager') {
    return [];
  }
  return await mongoose.model('User').find({
    supportManagerId: this._id,
    isActive: true,
    userType: 'support'
  }).select('-password');
};

// 🆕 METHOD TO CHECK IF SUPPORT MANAGER HANDLES A CLIENT
userSchema.methods.handlesSupportForClient = function(clientId) {
  if (this.userType !== 'supportManager') {
    return false;
  }
  
  if (this.supportManagerType === 'general_support') {
    return true; // General support handles all clients
  }
  
  if (this.supportManagerType === 'client_support') {
    return this.assignedSupportClients?.includes(clientId) || false;
  }
  
  return false;
};

// 🆕 METHOD TO CHECK IF SUPPORT MANAGER HANDLES A CONSULTANT
userSchema.methods.handlesSupportForConsultant = function(consultantId) {
  if (this.userType !== 'supportManager') {
    return false;
  }
  
  if (this.supportManagerType === 'general_support') {
    return true; // General support handles all consultants
  }
  
  if (this.supportManagerType === 'consultant_support') {
    return this.assignedConsultants?.some(id => id.toString() === consultantId.toString()) || false;
  }
  
  return false;
};

// Indexes
userSchema.index({ clientId: 1 });
userSchema.index({ userType: 1 });
userSchema.index({ createdBy: 1 });
userSchema.index({ email: 1 });
userSchema.index({ sandbox: 1 });
userSchema.index({ clientId: 1, userType: 1, isActive: 1 });
userSchema.index({ consultantAdminId: 1, isActive: 1 });
userSchema.index({ email: 1 }, { unique: true });

// 🆕 NEW INDEXES FOR SUPPORT
userSchema.index({ supportManagerId: 1, isActive: 1 });
userSchema.index({ userType: 1, isActive: 1 });
userSchema.index({ assignedSupportClients: 1 });
userSchema.index({ assignedConsultants: 1 });
userSchema.index({ supportSpecialization: 1 });

module.exports = mongoose.model("User", userSchema);