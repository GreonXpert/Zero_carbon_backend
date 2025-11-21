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
      enum: ["super_admin", "consultant_admin", "consultant", "client_admin", "client_employee_head", "employee", "viewer", "auditor"],
    },
    address: { type: String, required: true },
    companyName: { type: String },
    isFirstLogin: { type: Boolean, default: true },
    isActive: { type: Boolean, default: false },

    // ===== NEW: SANDBOX FLAG =====
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

    
    // ADD THIS NEW FIELD:
    assignedClients: [{ type: String }], // Array of clientIds (this already exists)
    // ADD THIS NEW FIELD FOR CONSULTANT:
    hasAssignedClients: { type: Boolean, default: false },
    
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
      storedAt: { type: String } // folder hint
    },
    
    // Permissions
    permissions: {
      canViewAllClients: { type: Boolean, default: false },
      canManageUsers: { type: Boolean, default: false },
      canManageClients: { type: Boolean, default: false },
      canViewReports: { type: Boolean, default: false },
      canEditBoundaries: { type: Boolean, default: false },
      canSubmitData: { type: Boolean, default: false },
      canAudit: { type: Boolean, default: false }
    },
     assessmentLevel: {
      type: [String],
      enum: ['reduction', 'decarbonization', 'organization', 'process', 'both'],
      default: []
    },
  },
  { timestamps: true }
);


// ===== NEW: ENFORCE SANDBOX/ACTIVE INVARIANTS =====
userSchema.pre('save', function(next) {
  // Enforce the invariant: if sandbox === true then isActive === false
  // and if isActive === true then sandbox === false
  if (this.sandbox === true && this.isActive === true) {
    return next(new Error('User cannot be both sandbox and active'));
  }
  
  // Auto-adjust to maintain invariant
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
  
  next();
});

// ===== NEW: Method to check if user has sandbox access =====
userSchema.methods.hasSandboxAccess = function(route) {
  if (!this.sandbox) return true; // Non-sandbox users have full access
  
  // Define sandbox-allowed routes
  const sandboxAllowedRoutes = [
    '/api/dashboard',
    '/api/profile',
    '/api/clients/own', // View own client data
    '/api/proposal/view',
    '/api/submission/status',
    '/api/flowchart/view',
    '/api/reports/basic',
    // Add more allowed routes as needed
  ];
  
  // Check if the route starts with any allowed pattern
  return sandboxAllowedRoutes.some(allowed => 
    route.startsWith(allowed)
  );
};

// Index for efficient queries
userSchema.index({ clientId: 1 });
userSchema.index({ userType: 1 });
userSchema.index({ createdBy: 1 });
userSchema.index({ email: 1 });
userSchema.index({ sandbox: 1 });

module.exports = mongoose.model("User", userSchema);