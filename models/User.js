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
    isActive: { type: Boolean, default: true },
    
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
    
    // Permissions
    permissions: {
      canViewAllClients: { type: Boolean, default: false },
      canManageUsers: { type: Boolean, default: false },
      canManageClients: { type: Boolean, default: false },
      canViewReports: { type: Boolean, default: false },
      canEditBoundaries: { type: Boolean, default: false },
      canSubmitData: { type: Boolean, default: false },
      canAudit: { type: Boolean, default: false }
    }
  },
  { timestamps: true }
);

// Index for efficient queries
userSchema.index({ clientId: 1 });
userSchema.index({ userType: 1 });
userSchema.index({ createdBy: 1 });
userSchema.index({ email: 1 });

module.exports = mongoose.model("User", userSchema);