const mongoose = require("mongoose");



const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true },
    contactNumber: { type: String, required: true },
    userName: { type: String, required: true },
    password: { type: String, required: true },
    userType: {
      type: String,
      required: true,
      enum: ["user", "admin", "consultant"],
    },
    address: { type: String, required: true },
    // For regular users the companyName can be provided,
    // but for consultants and admin it will default to Greonxpert Pvt Ltd.
    companyName: { type: String, default: "Greonxpert Pvt Ltd" },
    isFirstLogin: { type: Boolean, default: true },
    // Only for admin accounts
    role: { type: String },
    // Consultant specific fields
    employeeId: { type: String },
    jobRole: { type: String },
    branch: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
