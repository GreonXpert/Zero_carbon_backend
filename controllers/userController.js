const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const User = require("../models/User");
const Client = require("../models/CMS/Client");
const { sendMail } = require("../utils/mail");
const moment = require("moment");
const Notification = require("../models/Notification/Notification");
// Import the notification controller
const { createUserStatusNotification } = require("../controllers/Notification/notificationControllers");
const Flowchart = require('../models/Organization/Flowchart');
const { saveUserProfileImage } = require('../utils/uploads/userImageUploadS3');

const { getNormalizedLevels } = require("../utils/Permissions/permissions");

// Import OTP Helper for 2FA
const {
  generateOTP,
  storeOTP,
  verifyOTP,
  sendOTPEmail,
  canResendOTP,
  updateResendTimestamp,
  OTP_CONFIG
} = require('../utils/otpHelper');






// Initialize Super Admin Account from Environment Variables
const initializeSuperAdmin = async () => {
  try {
    const superAdminEmail = process.env.SUPER_ADMIN_EMAIL;
    const existingSuperAdmin = await User.findOne({ 
      email: superAdminEmail, 
      userType: "super_admin" 
    });
    
    if (existingSuperAdmin) {
      console.log("Super Admin account already exists");
      return;
    }
    
    const hashedPassword = bcrypt.hashSync(process.env.SUPER_ADMIN_PASSWORD, 10);
    const newSuperAdmin = new User({
      email: superAdminEmail,
      password: hashedPassword,
      contactNumber: process.env.SUPER_ADMIN_CONTACT || "0000000000",
      userName: process.env.SUPER_ADMIN_USERNAME || "superadmin",
      userType: "super_admin",
      address: process.env.SUPER_ADMIN_ADDRESS || "System",
      role: "System Administrator",
      companyName: "ZeroCarbon System",
      isFirstLogin: false,
      permissions: {
        canViewAllClients: true,
        canManageUsers: true,
        canManageClients: true,
        canViewReports: true,
        canEditBoundaries: true,
        canSubmitData: true,
        canAudit: true
      }
    });
    
    await newSuperAdmin.save();
    console.log("Super Admin account created successfully");
  } catch (err) {
    console.error("Error creating super admin account:", err);
  }
};

// Universal Login for all user types


// ==========================================================
// REPLACE THE EXISTING login FUNCTION (lines 66-175) WITH THIS:
// ==========================================================

// Universal Login with 2FA - Step 1: Verify Credentials & Send OTP
const login = async (req, res) => {
  try {
    const { login: loginIdentifier, password } = req.body;

    if (!loginIdentifier || !password) {
      return res.status(400).json({
        message: "Please provide login credentials"
      });
    }

    console.log(`[LOGIN STEP 1] Attempting login for: ${loginIdentifier}`);

    // ==========================================================
    // 1. FIND USER (email or userName) + allow sandbox or active
    // ==========================================================
    const user = await User.findOne({
      $and: [
        { $or: [{ email: loginIdentifier }, { userName: loginIdentifier }] },
        { $or: [{ isActive: true }, { sandbox: true }] }
      ]
    }).populate("createdBy", "userName email");

    if (!user) {
      console.log(`[LOGIN STEP 1] User not found: ${loginIdentifier}`);
      return res.status(404).json({ message: "User not found" });
    }

    // ==========================================================
    // 2. PASSWORD VALIDATION
    // ==========================================================
    const isMatch = bcrypt.compareSync(password, user.password);
    if (!isMatch) {
      console.log(`[LOGIN STEP 1] Invalid password for: ${user.email}`);
      return res.status(400).json({ message: "Invalid credentials" });
    }

    // ==========================================================
    // 3. CHECK CLIENT ACTIVE STATUS (ONLY FOR NON-SANDBOX USERS)
    // ==========================================================
    if (user.clientId && !user.sandbox) {
      const client = await Client.findOne({
        clientId: user.clientId,
        "accountDetails.isActive": true
      });

      if (!client) {
        console.log(`[LOGIN STEP 1] Inactive client: ${user.clientId}`);
        return res.status(403).json({
          message: "Your organization's subscription is not active"
        });
      }
    }

    // ==========================================================
    // 4. GENERATE AND SEND OTP
    // ==========================================================
    const otp = generateOTP();
    storeOTP(user.email, otp, user._id.toString());

    console.log(`[LOGIN STEP 1] Generated OTP for ${user.email}`);

    // Send OTP via email
    const emailSent = await sendOTPEmail(user.email, otp, user.userName);

    if (!emailSent) {
      console.error(`[LOGIN STEP 1] Failed to send OTP email to ${user.email}`);
      return res.status(500).json({
        message: "Failed to send OTP. Please try again later.",
        code: "EMAIL_SEND_FAILED"
      });
    }

    console.log(`[LOGIN STEP 1] OTP sent successfully to ${user.email}`);

    // ==========================================================
    // 5. CREATE TEMPORARY SESSION TOKEN (NOT A FULL LOGIN TOKEN)
    // ==========================================================
    // This token is only for identifying the user during OTP verification
    // It does NOT grant access to protected routes
    const tempToken = jwt.sign(
      {
        userId: user._id,
        email: user.email,
        stage: 'otp_pending',
        purpose: '2fa_verification'
      },
      process.env.JWT_SECRET,
      { expiresIn: `${OTP_CONFIG.EXPIRY_MINUTES}m` }
    );

    // ==========================================================
    // 6. RESPONSE - OTP SENT
    // ==========================================================
    res.status(200).json({
      message: "OTP sent to your registered email",
      tempToken,
      email: user.email.replace(/(.{2})(.*)(?=@)/, '$1***'), // Masked email
      expiresIn: OTP_CONFIG.EXPIRY_MINUTES,
      maxAttempts: OTP_CONFIG.MAX_ATTEMPTS,
      requiresOTP: true
    });

  } catch (error) {
    console.error("[LOGIN STEP 1] Error:", error);
    res.status(500).json({
      message: "Login failed",
      error: error.message
    });
  }
};

// ==========================================================
// ADD THESE TWO NEW FUNCTIONS AFTER THE login FUNCTION IN userController.js
// ==========================================================

// Login Step 2: Verify OTP and Issue Final Token
const verifyLoginOTP = async (req, res) => {
  try {
    const { otp, tempToken } = req.body;

    if (!otp || !tempToken) {
      return res.status(400).json({
        message: "OTP and temporary token are required"
      });
    }

    console.log(`[LOGIN STEP 2] Verifying OTP`);

    // ==========================================================
    // 1. VERIFY TEMPORARY TOKEN
    // ==========================================================
    let decoded;
    try {
      decoded = jwt.verify(tempToken, process.env.JWT_SECRET);
      
      if (decoded.stage !== 'otp_pending' || decoded.purpose !== '2fa_verification') {
        return res.status(401).json({
          message: "Invalid temporary token"
        });
      }
    } catch (err) {
      console.log(`[LOGIN STEP 2] Invalid or expired temp token`);
      return res.status(401).json({
        message: "Session expired. Please login again."
      });
    }

    // ==========================================================
    // 2. FIND USER
    // ==========================================================
    const user = await User.findById(decoded.userId).populate("createdBy", "userName email");
    
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // ==========================================================
    // 3. VERIFY OTP
    // ==========================================================
    const otpResult = verifyOTP(user.email, otp);

    if (!otpResult.success) {
      console.log(`[LOGIN STEP 2] OTP verification failed: ${otpResult.code}`);
      return res.status(400).json({
        message: otpResult.message,
        code: otpResult.code,
        remainingAttempts: otpResult.remainingAttempts
      });
    }

    console.log(`[LOGIN STEP 2] OTP verified successfully for ${user.email}`);

    // ==========================================================
    // 4. UPDATE FIRST LOGIN FLAG
    // ==========================================================
    if (user.isFirstLogin) {
      user.isFirstLogin = false;
      await user.save();
    }

    // ==========================================================
    // 5. CREATE FINAL JWT TOKEN
    // ==========================================================
    const tokenPayload = {
      id: user._id,
      email: user.email,
      userName: user.userName,
      userType: user.userType,
      clientId: user.clientId,
      permissions: user.permissions,
      sandbox: user.sandbox === true,
      assessmentLevel: user.assessmentLevel || []
    };

    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, {
      expiresIn: "24h"
    });

    // ==========================================================
    // 6. PREPARE USER DATA
    // ==========================================================
    const userData = {
      id: user._id,
      email: user.email,
      contactNumber: user.contactNumber,
      userName: user.userName,
      userType: user.userType,
      address: user.address,
      companyName: user.companyName,
      clientId: user.clientId,
      permissions: user.permissions,
      isFirstLogin: user.isFirstLogin,
      profileImage: user.profileImage || null,
      sandbox: user.sandbox === true,
      assessmentLevel: user.assessmentLevel || []
    };

    // ==========================================================
    // 7. SUCCESS RESPONSE
    // ==========================================================
    console.log(`[LOGIN STEP 2] Login successful for ${user.email}`);
    
    res.status(200).json({
      user: userData,
      token,
      message: "Login successful"
    });

  } catch (error) {
    console.error("[LOGIN STEP 2] Error:", error);
    res.status(500).json({
      message: "OTP verification failed",
      error: error.message
    });
  }
};

// Resend OTP
const resendLoginOTP = async (req, res) => {
  try {
    const { tempToken } = req.body;

    if (!tempToken) {
      return res.status(400).json({
        message: "Temporary token is required"
      });
    }

    console.log(`[RESEND OTP] Request received`);

    // ==========================================================
    // 1. VERIFY TEMPORARY TOKEN
    // ==========================================================
    let decoded;
    try {
      decoded = jwt.verify(tempToken, process.env.JWT_SECRET);
      
      if (decoded.stage !== 'otp_pending' || decoded.purpose !== '2fa_verification') {
        return res.status(401).json({
          message: "Invalid temporary token"
        });
      }
    } catch (err) {
      console.log(`[RESEND OTP] Invalid or expired temp token`);
      return res.status(401).json({
        message: "Session expired. Please login again."
      });
    }

    // ==========================================================
    // 2. FIND USER
    // ==========================================================
    const user = await User.findById(decoded.userId);
    
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // ==========================================================
    // 3. CHECK RESEND COOLDOWN
    // ==========================================================
    const canResend = canResendOTP(user.email);
    
    if (!canResend.canResend) {
      console.log(`[RESEND OTP] Cooldown active for ${user.email}`);
      return res.status(429).json({
        message: canResend.message,
        waitTime: canResend.waitTime
      });
    }

    // ==========================================================
    // 4. GENERATE AND SEND NEW OTP
    // ==========================================================
    const otp = generateOTP();
    storeOTP(user.email, otp, user._id.toString());
    updateResendTimestamp(user.email);

    console.log(`[RESEND OTP] Generated new OTP for ${user.email}`);

    const emailSent = await sendOTPEmail(user.email, otp, user.userName);

    if (!emailSent) {
      console.error(`[RESEND OTP] Failed to send OTP email to ${user.email}`);
      return res.status(500).json({
        message: "Failed to send OTP. Please try again later."
      });
    }

    console.log(`[RESEND OTP] New OTP sent successfully to ${user.email}`);

    // ==========================================================
    // 5. SUCCESS RESPONSE
    // ==========================================================
    res.status(200).json({
      message: "New OTP sent to your registered email",
      email: user.email.replace(/(.{2})(.*)(?=@)/, '$1***'),
      expiresIn: OTP_CONFIG.EXPIRY_MINUTES,
      cooldownSeconds: OTP_CONFIG.RESEND_COOLDOWN_SECONDS
    });

  } catch (error) {
    console.error("[RESEND OTP] Error:", error);
    res.status(500).json({
      message: "Failed to resend OTP",
      error: error.message
    });
  }
};

// ==========================================
// Create Consultant Admin (Super Admin only)
// ==========================================
const createConsultantAdmin = async (req, res) => {
  try {
    console.log("[DEBUG] ====== CREATE CONSULTANT ADMIN START ======");
    console.log("[DEBUG] req.body:", req.body);
    console.log("[DEBUG] req.file:", req.file ? {
      fieldname: req.file.fieldname,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      buffer: req.file.buffer ? `Buffer(${req.file.buffer.length} bytes)` : 'No buffer'
    } : 'No file uploaded');

    if (!req.user || req.user.userType !== "super_admin") {
      return res.status(403).json({ 
        message: "Only Super Admin can create Consultant Admins" 
      });
    }

    const email = req.body.email;
    const password = req.body.password;
    const userName = req.body.userName;
    const contactNumber = req.body.contactNumber;
    const address = req.body.address;
    const teamName = req.body.teamName;
    const employeeId = req.body.employeeId;

    if (!email || !password || !userName) {
      return res.status(400).json({ 
        message: "email, password and userName are required" 
      });
    }

    const existingUser = await User.findOne({
      $or: [{ email: email }, { userName: userName }]
    });

    if (existingUser) {
      return res.status(409).json({ 
        message: "Email or Username already exists" 
      });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);

    const consultantAdmin = new User({
      email,
      password: hashedPassword,
      contactNumber,
      userName,
      address,
      teamName,
      employeeId,
      userType: "consultant_admin",
      companyName: "ZeroCarbon Consultancy",
      createdBy: req.user.id,
      isActive: true,
      sandbox: false
    });

    await consultantAdmin.save();
    console.log("[DEBUG] ✅ User saved to DB with ID:", consultantAdmin._id);

    // Handle profile image upload
    let imageUploadResult = { success: false, error: null };
    
    if (req.file) {
      console.log("[DEBUG] 📸 Profile image detected, attempting S3 upload...");
      
      try {
        await saveUserProfileImage(req, consultantAdmin);
        imageUploadResult.success = true;
        console.log("[DEBUG] ✅ Profile image uploaded successfully");
        console.log("[DEBUG] Image metadata:", consultantAdmin.profileImage);
        
      } catch (imageError) {
        imageUploadResult.error = imageError.message;
        console.error("[DEBUG] ❌ Profile image upload failed:", imageError);
        console.error("[DEBUG] Full error:", imageError);
        
        // Continue with user creation even if image fails
        // But return the error in response
      }
    } else {
      console.log("[DEBUG] ⚠️ No profile image file in request");
    }

    // Send welcome email
    try {
      await sendMail(
        email,
        "Welcome to ZeroCarbon – Consultant Admin Account",
        `Hello ${userName},\n\nYour account has been created.\n\nEmail: ${email}\nPassword: ${password}\n\nPlease change your password after first login.`
      );
      console.log("[DEBUG] ✅ Welcome email sent");
    } catch (emailError) {
      console.error("[DEBUG] ⚠️ Failed to send welcome email:", emailError.message);
      // Continue even if email fails
    }

    console.log("[DEBUG] ====== CREATE CONSULTANT ADMIN END ======");

    return res.status(201).json({
      message: "Consultant Admin created successfully",
      consultantAdmin: {
        id: consultantAdmin._id,
        email,
        userName,
        teamName,
        profileImage: consultantAdmin.profileImage || null
      },
      imageUpload: imageUploadResult
    });

  } catch (error) {
    console.error("[DEBUG] ❌ CREATE CONSULTANT ADMIN ERROR:", error);
    console.error("[DEBUG] Error stack:", error.stack);
    
    return res.status(500).json({
      message: "Failed to create Consultant Admin",
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};


// Enhanced Create Consultant Function (Consultant Admin only)
const createConsultant = async (req, res) => {
  try {
    // ==========================================
    // 1. AUTHORIZATION CHECK
    // ==========================================
    if (!req.user || req.user.userType !== "consultant_admin") {
      return res.status(403).json({ 
        message: "Only Consultant Admin can create Consultants" 
      });
    }
    
    // ==========================================
    // 2. EXTRACT REQUEST DATA
    // ==========================================
    const {
      email,
      password,
      contactNumber,
      userName,
      address,
      employeeId,
      jobRole,
      branch,
      teamName
    } = req.body;
    
    // ==========================================
    // 3. INPUT VALIDATION - Required Fields
    // ==========================================
    
    // Basic required fields
    if (!email) {
      return res.status(400).json({ 
        message: "Email is required",
        field: "email"
      });
    }
    
    if (!password) {
      return res.status(400).json({ 
        message: "Password is required",
        field: "password"
      });
    }
    
    if (!contactNumber) {
      return res.status(400).json({ 
        message: "Contact number is required",
        field: "contactNumber"
      });
    }
    
    if (!userName) {
      return res.status(400).json({ 
        message: "Username is required",
        field: "userName"
      });
    }
    
    if (!address) {
      return res.status(400).json({ 
        message: "Address is required",
        field: "address"
      });
    }
    
    // ⚠️ CONSULTANT-SPECIFIC REQUIRED FIELDS
    
    if (!employeeId) {
      return res.status(400).json({ 
        message: "Employee ID is required for Consultant creation",
        field: "employeeId",
        details: "Employee ID is a mandatory field to create a Consultant account"
      });
    }
    
    if (!jobRole) {
      return res.status(400).json({ 
        message: "Job Role is required for Consultant creation",
        field: "jobRole",
        details: "Please specify the consultant's job role (e.g., Junior Consultant, Senior Consultant)"
      });
    }
    
    if (!branch) {
      return res.status(400).json({ 
        message: "Branch is required for Consultant creation",
        field: "branch",
        details: "Please specify the branch/location for this consultant"
      });
    }
    
    // ==========================================
    // 4. INPUT VALIDATION - Format & Business Rules
    // ==========================================
    
    // Email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ 
        message: "Invalid email format",
        field: "email"
      });
    }
    
    // Password strength validation
    if (password.length < 8) {
      return res.status(400).json({ 
        message: "Password must be at least 8 characters long",
        field: "password"
      });
    }
    
    // Contact number validation (basic)
    if (contactNumber.length < 10) {
      return res.status(400).json({ 
        message: "Contact number must be at least 10 digits",
        field: "contactNumber"
      });
    }
    
    // Employee ID validation (alphanumeric, 3-20 characters)
    const employeeIdRegex = /^[a-zA-Z0-9]{3,20}$/;
    if (!employeeIdRegex.test(employeeId)) {
      return res.status(400).json({ 
        message: "Employee ID must be 3-20 alphanumeric characters",
        field: "employeeId",
        example: "EMP001, CONS123, etc."
      });
    }
    
    // ==========================================
    // 5. CHECK FOR DUPLICATE USER
    // ==========================================
    const existingUser = await User.findOne({
      $or: [
        { email: email.toLowerCase() },
        { userName: userName.toLowerCase() },
        { employeeId: employeeId.toUpperCase() } // Also check for duplicate employeeId
      ]
    });
    
    if (existingUser) {
      let conflictField = "";
      let conflictMessage = "";
      
      if (existingUser.email === email.toLowerCase()) {
        conflictField = "email";
        conflictMessage = "Email already exists";
      } else if (existingUser.userName === userName.toLowerCase()) {
        conflictField = "userName";
        conflictMessage = "Username already exists";
      } else if (existingUser.employeeId === employeeId.toUpperCase()) {
        conflictField = "employeeId";
        conflictMessage = "Employee ID already exists";
      }
      
      return res.status(409).json({ 
        message: conflictMessage,
        field: conflictField,
        existingUser: {
          email: existingUser.email,
          userName: existingUser.userName,
          employeeId: existingUser.employeeId
        }
      });
    }
    
    // ==========================================
    // 6. CREATE CONSULTANT USER
    // ==========================================
    const hashedPassword = bcrypt.hashSync(password, 10);
    
    const consultant = new User({
      email: email.toLowerCase(),
      password: hashedPassword,
      contactNumber,
      userName: userName.toLowerCase(),
      userType: "consultant",
      address,
      companyName: teamName || "ZeroCarbon Consultancy",
      employeeId: employeeId.toUpperCase(), // Store in uppercase for consistency
      jobRole,
      branch,
      teamName: teamName || req.user.teamName, // Inherit team name from Consultant Admin if not provided
      createdBy: req.user.id,
      consultantAdminId: req.user.id,
      parentUser: req.user.id, // Set parent user relationship
      isActive: true,
      isFirstLogin: true, // Force password change on first login
      permissions: {
        canViewAllClients: false,
        canManageUsers: false,
        canManageClients: true,
        canViewReports: true,
        canEditBoundaries: true,
        canSubmitData: false,
        canAudit: false
      }
    });
    
    await consultant.save();
    
    console.log(`✅ Consultant created: ${consultant.userName} (ID: ${consultant.employeeId})`);
    
    // ==========================================
    // 7. HANDLE PROFILE IMAGE (Optional)
    // ==========================================
    try { 
      await saveUserProfileImage(req, consultant); 
      console.log(`✅ Profile image saved for: ${consultant.userName}`);
    } catch (e) {
      console.warn(`⚠️ Profile image save skipped for ${consultant.userName}:`, e.message);
    }
    
    // ==========================================
    // 8. SEND WELCOME EMAIL
    // ==========================================
    const emailSubject = "Welcome to ZeroCarbon - Consultant Account Created";
    const emailMessage = `Dear ${userName},

Your Consultant account has been created successfully by ${req.user.userName}.

Login Credentials:
==================
Username: ${userName}
Email: ${email}
Temporary Password: ${password}
Employee ID: ${employeeId.toUpperCase()}
Job Role: ${jobRole}
Branch: ${branch}

Portal URL: ${process.env.FRONTEND_URL || 'https://zerocarbon.greonxpert.com'}

IMPORTANT SECURITY NOTICE:
=========================
⚠️ Please change your password immediately after first login for security reasons.
⚠️ Do not share your login credentials with anyone.

Your Account Details:
====================
- User Type: Consultant
- Team: ${teamName || req.user.teamName || 'ZeroCarbon Consultancy'}
- Created By: ${req.user.userName}
- Created On: ${new Date().toLocaleString()}

If you did not expect this account creation, please contact your administrator immediately.

Best regards,
ZeroCarbon Team`;

    try {
      const emailSent = await sendMail(email, emailSubject, emailMessage);
      if (emailSent) {
        console.log(`✅ Welcome email sent to: ${email}`);
      } else {
        console.warn(`⚠️ Failed to send welcome email to: ${email}`);
      }
    } catch (emailError) {
      console.error(`❌ Error sending welcome email to ${email}:`, emailError.message);
      // Don't fail the user creation if email fails
    }
    
    // ==========================================
    // 9. CREATE NOTIFICATION (Optional - if notification system is implemented)
    // ==========================================
    try {
      await Notification.create({
        userId: consultant._id,
        type: "account_created",
        title: "Welcome to ZeroCarbon",
        message: `Your Consultant account has been created. Please login and change your password.`,
        priority: "high",
        isRead: false
      });
      console.log(`✅ Notification created for: ${consultant.userName}`);
    } catch (notifError) {
      console.warn(`⚠️ Notification creation failed:`, notifError.message);
      // Don't fail the user creation if notification fails
    }
    
    // ==========================================
    // 10. SEND SUCCESS RESPONSE
    // ==========================================
    res.status(201).json({
      message: "Consultant created successfully",
      consultant: {
        id: consultant._id,
        email: consultant.email,
        userName: consultant.userName,
        employeeId: consultant.employeeId,
        jobRole: consultant.jobRole,
        branch: consultant.branch,
        teamName: consultant.teamName,
        userType: consultant.userType,
        createdBy: req.user.userName,
        createdAt: consultant.createdAt,
        profileImage: consultant.profileImage?.url || null
      },
      instructions: {
        nextSteps: [
          "Login credentials have been sent to the consultant's email",
          "Consultant should change password on first login",
          "Consultant can now access the platform and manage clients"
        ]
      }
    });
    
  } catch (error) {
    console.error("❌ Create consultant error:", error);
    
    // Handle mongoose validation errors
    if (error.name === "ValidationError") {
      const validationErrors = Object.values(error.errors).map(err => ({
        field: err.path,
        message: err.message
      }));
      
      return res.status(400).json({ 
        message: "Validation failed", 
        errors: validationErrors
      });
    }
    
    // Handle duplicate key errors (MongoDB unique constraint)
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(409).json({ 
        message: `${field} already exists`,
        field: field
      });
    }
    
    res.status(500).json({ 
      message: "Failed to create Consultant", 
      error: process.env.NODE_ENV === "development" ? error.message : "Internal server error"
    });
  }
};

module.exports = { createConsultant };
// Create Client Admin (Automatic on proposal acceptance)
const createClientAdmin = async (clientId, clientData = {}) => {
  try {
    const client = await Client.findOne({ clientId });
    if (!client) {
      throw new Error("Client not found");
    }

    // Derive the email, name, etc. from client data
    const companyName =
      client.submissionData?.companyInfo?.companyName ||
      client.leadInfo?.companyName ||
      "Client";

    const primaryContact =
      client.submissionData?.companyInfo?.primaryContactPerson || {};

    const email =
      primaryContact.email ||
      client.leadInfo?.email;

    const phone =
      primaryContact.phoneNumber ||
      primaryContact.contactNumber ||
      client.leadInfo?.mobileNumber;

    const contactName =
      primaryContact.name ||
      primaryContact.contactPersonName ||
      client.leadInfo?.contactPersonName ||
      companyName ||
      "Client Admin";

    if (!email) {
      throw new Error("No email found for client admin creation");
    }

    const levels = getNormalizedLevels(client); // normalized assessmentLevel

    // =========================================================================
    // 1) Try to find an existing client_admin for THIS final clientId
    // =========================================================================
    let existingClientAdmin = await User.findOne({
      email: email,
      userType: "client_admin",
      clientId: clientId,
    });

    if (existingClientAdmin) {
      try {
        // 🔹 Update sandbox / active flags if explicitly passed
        if (typeof clientData.sandbox === "boolean") {
          if (clientData.sandbox === true) {
            existingClientAdmin.sandbox = true;
            existingClientAdmin.isActive = false;
          } else {
            existingClientAdmin.isActive = true; // pre-save hook will force sandbox=false
          }
        }

        if (Array.isArray(levels) && levels.length) {
          existingClientAdmin.assessmentLevel = levels;
        }

        existingClientAdmin.companyName = companyName;

        await existingClientAdmin.save();
      } catch (e) {
        console.warn(
          "Skipping assessmentLevel / sandbox sync to existing client_admin:",
          e.message
        );
      }

      if (!client.accountDetails) client.accountDetails = {};
      client.accountDetails.clientAdminId = existingClientAdmin._id;
      await client.save();

      return existingClientAdmin;
    }

    // =========================================================================
    // 1b) If we're moving from sandbox → active, try to REUSE sandbox user
    //     This happens when clientData.sandbox === false (live account)
    // =========================================================================
    if (clientData.sandbox === false) {
      // Any sandbox client_admin with this email
      let sandboxAdmin = await User.findOne({
        email: email,
        userType: "client_admin",
        sandbox: true,
      });

      if (sandboxAdmin) {
        // ✅ Upgrade sandbox user to live client admin
        sandboxAdmin.clientId = clientId;       // <--- update clientId to ACTIVE
        sandboxAdmin.sandbox  = false;          // leave sandbox mode
        sandboxAdmin.isActive = true;           // now active user
        sandboxAdmin.companyName = companyName;

        if (Array.isArray(levels) && levels.length) {
          sandboxAdmin.assessmentLevel = levels;
        }

        await sandboxAdmin.save();

        if (!client.accountDetails) client.accountDetails = {};
        client.accountDetails.clientAdminId = sandboxAdmin._id;
        // keep existing defaultPassword if already set
        await client.save();

        return sandboxAdmin;
      }
    }

    // =========================================================================
    // 2) No existing or sandbox user – create a brand new client_admin
    // =========================================================================
    const cleanCompanyName = (companyName || "Client")
      .toString()
      .replace(/[^a-zA-Z0-9]/g, "");
    const year = new Date().getFullYear();
    const defaultPassword = `${cleanCompanyName}@${year}`;
    const hashedPassword = bcrypt.hashSync(defaultPassword, 10);

    const isSandbox = clientData.sandbox === true;

    const clientAdmin = new User({
      email: email,
      password: hashedPassword,
      contactNumber: phone || "0000000000",
      userName: email, // using email as username
      userType: "client_admin",
      address:
        client.submissionData?.companyInfo?.companyAddress ||
        client.leadInfo?.companyName ||
        "Not provided",
      companyName: companyName,
      clientId: clientId,
      assessmentLevel: levels,
      createdBy: clientData.consultantId,
      // 🔹 Flags:
      //    - Sandbox user (submitted stage) => sandbox = true, isActive = false
      //    - Live user   (active stage)     => sandbox = false, isActive = true
      sandbox: isSandbox,
      isActive: isSandbox ? false : true,
      permissions: {
        canViewAllClients: false,
        canManageUsers: true,
        canManageClients: false,
        canViewReports: true,
        canEditBoundaries: false,
        canSubmitData: false,
        canAudit: false,
      },
    });

    await clientAdmin.save();

    // Update the client document with the new clientAdminId
    if (!client.accountDetails) client.accountDetails = {};
    client.accountDetails.clientAdminId = clientAdmin._id;
    client.accountDetails.defaultPassword = defaultPassword;
    await client.save();

    // Send activation email (same as before)
    const emailSubject = "Welcome to ZeroCarbon - Your Account is Active";
    const emailMessage = `
      Dear ${contactName},

      Your ZeroCarbon account has been ${isSandbox ? "created in sandbox mode" : "activated successfully"}.

      Login Credentials:
      Email: ${email}
      Password: ${defaultPassword}

      Please change your password after first login.

      Your subscription is valid until: ${
        client.accountDetails.subscriptionEndDate
          ? moment(client.accountDetails.subscriptionEndDate).format("DD/MM/YYYY")
          : "N/A"
      }
    `;
    await sendMail(email, emailSubject, emailMessage);

    return clientAdmin;
  } catch (error) {
    console.error("Create client admin error:", error);
    throw error;
  }
};


// Enhanced Create Employee Head Function (Client Admin only)
// Supports both single and bulk creation

const createEmployeeHead = async (req, res) => {
  try {
    // ==========================================
    // 1. AUTHORIZATION CHECK
    // ==========================================
    if (!req.user || req.user.userType !== "client_admin") {
      return res.status(403).json({ 
        message: "Only Client Admin can create Employee Heads" 
      });
    }

    console.log(`\n👤 Employee Head creation requested by: ${req.user.userName}`);

    // ==========================================
    // 2. HANDLE BULK OR SINGLE CREATION
    // ==========================================
    const payloads = Array.isArray(req.body.employeeHeads)
      ? req.body.employeeHeads
      : [req.body];

    console.log(`📊 Processing ${payloads.length} Employee Head(s)`);

    const results = { 
      created: [], 
      errors: [],
      summary: {
        total: payloads.length,
        successful: 0,
        failed: 0
      }
    };

    // ==========================================
    // 3. PROCESS EACH EMPLOYEE HEAD
    // ==========================================
    for (let i = 0; i < payloads.length; i++) {
      const data = payloads[i];
      const itemNumber = i + 1;
      
      console.log(`\n📝 Processing Employee Head ${itemNumber}/${payloads.length}`);
      
      try {
        const {
          email,
          password,
          contactNumber,
          userName,
          address,
          department,
          location
        } = data;

        // ==========================================
        // 4. INPUT VALIDATION - Required Fields
        // ==========================================
        
        // Basic required fields
        if (!email) {
          throw new Error('Email is required');
        }

        if (!password) {
          throw new Error('Password is required');
        }

        if (!userName) {
          throw new Error('Username is required');
        }

        if (!contactNumber) {
          throw new Error('Contact number is required');
        }

        if (!address) {
          throw new Error('Address is required');
        }

        // ⚠️ EMPLOYEE HEAD SPECIFIC REQUIRED FIELDS
        
        if (!department) {
          throw new Error('Department is required for Employee Head creation. Please specify the department (e.g., Operations, Finance, HR, IT)');
        }

        if (!location) {
          throw new Error('Location is required for Employee Head creation. Please specify the location/branch (e.g., Mumbai, Delhi, Bangalore)');
        }

        // ==========================================
        // 5. INPUT VALIDATION - Format & Business Rules
        // ==========================================

        // Email format validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
          throw new Error('Invalid email format');
        }

        // Password strength validation
        if (password.length < 8) {
          throw new Error('Password must be at least 8 characters long');
        }

        // Contact number validation
        if (contactNumber.length < 10) {
          throw new Error('Contact number must be at least 10 digits');
        }

        // Department validation (2-50 characters, alphanumeric with spaces)
        const departmentRegex = /^[a-zA-Z0-9\s&-]{2,50}$/;
        if (!departmentRegex.test(department)) {
          throw new Error('Department must be 2-50 characters (letters, numbers, spaces, & and - allowed). Example: "Operations", "HR & Admin", "IT-Support"');
        }

        // Location validation (2-50 characters, alphanumeric with spaces and commas)
        const locationRegex = /^[a-zA-Z0-9\s,.-]{2,50}$/;
        if (!locationRegex.test(location)) {
          throw new Error('Location must be 2-50 characters (letters, numbers, spaces, commas allowed). Example: "Mumbai", "New York, USA"');
        }

        // ==========================================
        // 6. CHECK FOR DUPLICATE USER
        // ==========================================
        const existingUser = await User.findOne({
          $or: [
            { email: email.toLowerCase() },
            { userName: userName.toLowerCase() }
          ]
        });

        if (existingUser) {
          let conflictMessage = '';
          if (existingUser.email === email.toLowerCase()) {
            conflictMessage = `Email "${email}" already exists`;
          } else if (existingUser.userName === userName.toLowerCase()) {
            conflictMessage = `Username "${userName}" already exists`;
          }
          throw new Error(conflictMessage);
        }

        // ==========================================
        // 7. CREATE EMPLOYEE HEAD
        // ==========================================
        const hashedPassword = bcrypt.hashSync(password, 10);

        const head = new User({
          email: email.toLowerCase(),
          password: hashedPassword,
          contactNumber,
          userName: userName.toLowerCase(),
          userType: "client_employee_head",
          address,
          isActive: true,
          isFirstLogin: true, // Force password change on first login
          companyName: req.user.companyName,
          clientId: req.user.clientId,
          department: department.trim(), // Trim whitespace
          location: location.trim(), // Trim whitespace
          createdBy: req.user.id,
          parentUser: req.user.id,
          permissions: {
            canViewAllClients: false,
            canManageUsers: true,
            canManageClients: false,
            canViewReports: false,
            canEditBoundaries: false,
            canSubmitData: false,
            canAudit: false
          }
        });

        await head.save();

        console.log(`✅ Employee Head created: ${head.userName} | Department: ${head.department} | Location: ${head.location}`);

        // ==========================================
        // 8. HANDLE PROFILE IMAGE (Optional)
        // ==========================================
        try {
          await saveUserProfileImage(req, head);
          console.log(`✅ Profile image saved for: ${head.userName}`);
        } catch (e) {
          console.warn(`⚠️ Profile image save skipped for ${head.userName}:`, e.message);
        }

        // ==========================================
        // 9. SEND WELCOME EMAIL
        // ==========================================
        const emailSubject = "Welcome to ZeroCarbon - Employee Head Account Created";
        const emailMessage = `Dear ${userName},

Your Employee Head account has been created successfully by ${req.user.userName}.

Login Credentials:
==================
Username: ${userName}
Email: ${email}
Temporary Password: ${password}
User Type: Employee Head

Your Department & Location:
===========================
Department: ${department}
Location: ${location}
Organization: ${req.user.companyName}
Client ID: ${req.user.clientId}

Portal URL: ${process.env.FRONTEND_URL || 'https://zerocarbon.greonxpert.com'}

IMPORTANT SECURITY NOTICE:
=========================
⚠️ Please change your password immediately after first login for security reasons.
⚠️ Do not share your login credentials with anyone.

Your Responsibilities:
=====================
As an Employee Head, you can:
- Manage employees within your department
- Assign employees to data collection scopes
- Monitor data submission for your department
- View department-specific reports

Account Details:
===============
- Created By: ${req.user.userName}
- Created On: ${new Date().toLocaleString()}
- Organization: ${req.user.companyName}

If you did not expect this account creation, please contact your administrator immediately.

Best regards,
ZeroCarbon Team`;

        try {
          const emailSent = await sendMail(email, emailSubject, emailMessage);
          if (emailSent) {
            console.log(`✅ Welcome email sent to: ${email}`);
          } else {
            console.warn(`⚠️ Failed to send welcome email to: ${email}`);
          }
        } catch (emailError) {
          console.error(`❌ Error sending welcome email to ${email}:`, emailError.message);
          // Don't fail the creation if email fails
        }

        // ==========================================
        // 10. CREATE NOTIFICATION (Optional)
        // ==========================================
        try {
          await Notification.create({
            userId: head._id,
            type: "account_created",
            title: "Welcome to ZeroCarbon",
            message: `Your Employee Head account has been created for ${department} department at ${location}. Please login and change your password.`,
            priority: "high",
            isRead: false
          });
          console.log(`✅ Notification created for: ${head.userName}`);
        } catch (notifError) {
          console.warn(`⚠️ Notification creation failed:`, notifError.message);
          // Don't fail the creation if notification fails
        }

        // ==========================================
        // 11. ADD TO SUCCESS RESULTS
        // ==========================================
        results.created.push({
          id: head._id,
          email: head.email,
          userName: head.userName,
          department: head.department,
          location: head.location,
          clientId: head.clientId,
          userType: head.userType,
          createdAt: head.createdAt,
          profileImage: head.profileImage?.url || null
        });

        results.summary.successful++;
        console.log(`✅ Employee Head ${itemNumber}/${payloads.length} created successfully`);

      } catch (err) {
        // ==========================================
        // 12. HANDLE INDIVIDUAL CREATION ERRORS
        // ==========================================
        console.error(`❌ Failed to create Employee Head ${itemNumber}/${payloads.length}:`, err.message);
        
        results.errors.push({
          itemNumber: itemNumber,
          input: {
            email: data.email,
            userName: data.userName,
            department: data.department,
            location: data.location
          },
          error: err.message,
          field: this.extractFieldFromError(err.message)
        });

        results.summary.failed++;
      }
    }

    // ==========================================
    // 13. DETERMINE RESPONSE STATUS CODE
    // ==========================================
    let statusCode;
    let message;

    if (results.created.length > 0 && results.errors.length === 0) {
      // All successful
      statusCode = 201;
      message = `Successfully created ${results.created.length} Employee Head(s)`;
    } else if (results.created.length > 0 && results.errors.length > 0) {
      // Partial success
      statusCode = 207; // Multi-Status
      message = `Partially completed: ${results.created.length} created, ${results.errors.length} failed`;
    } else if (results.created.length === 0 && results.errors.length > 0) {
      // All failed
      statusCode = 400;
      message = `Failed to create any Employee Heads: ${results.errors.length} error(s)`;
    } else {
      // No data provided
      statusCode = 400;
      message = "No Employee Head data provided";
    }

    console.log(`\n📊 Summary: ${results.summary.successful} created, ${results.summary.failed} failed`);

    // ==========================================
    // 14. SEND RESPONSE
    // ==========================================
    return res.status(statusCode).json({
      message: message,
      summary: results.summary,
      created: results.created,
      errors: results.errors,
      instructions: results.created.length > 0 ? {
        nextSteps: [
          "Login credentials have been sent to each Employee Head's email",
          "Employee Heads should change password on first login",
          "Employee Heads can now manage employees in their departments"
        ]
      } : undefined
    });

  } catch (error) {
    // ==========================================
    // 15. HANDLE UNEXPECTED ERRORS
    // ==========================================
    console.error("\n❌ Unexpected error in createEmployeeHead:", error);
    
    // Handle mongoose validation errors
    if (error.name === "ValidationError") {
      const validationErrors = Object.values(error.errors).map(err => ({
        field: err.path,
        message: err.message
      }));

      return res.status(400).json({
        message: "Validation failed",
        errors: validationErrors
      });
    }

    // Handle duplicate key errors (MongoDB unique constraint)
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(409).json({
        message: `${field} already exists`,
        field: field
      });
    }

    return res.status(500).json({
      message: "Failed to create Employee Head",
      error: process.env.NODE_ENV === "development" ? error.message : "Internal server error"
    });
  }
};

// ==========================================
// HELPER FUNCTION - Extract field from error message
// ==========================================
function extractFieldFromError(errorMessage) {
  if (!errorMessage) return null;
  
  const lowerMessage = errorMessage.toLowerCase();
  
  if (lowerMessage.includes('email')) return 'email';
  if (lowerMessage.includes('password')) return 'password';
  if (lowerMessage.includes('username')) return 'userName';
  if (lowerMessage.includes('contact')) return 'contactNumber';
  if (lowerMessage.includes('address')) return 'address';
  if (lowerMessage.includes('department')) return 'department';
  if (lowerMessage.includes('location')) return 'location';
  
  return null;
}

module.exports = { createEmployeeHead };


// Create Employee (Employee Head only)
const createEmployee = async (req, res) => {
  try {
    if (!req.user || req.user.userType !== "client_employee_head") {
      return res.status(403).json({ 
        message: "Only Employee Head can create Employees" 
      });
    }

    // Allow bulk or single
    const payloads = Array.isArray(req.body.employees)
      ? req.body.employees
      : [req.body];

    const results = { created: [], errors: [] };

    for (const data of payloads) {
      const { email, password, contactNumber, userName, address, assignedModules } = data;
      try {
        // Check required fields
        if (!email || !password || !userName) {
          throw new Error('Missing required fields: email, password, or userName');
        }
        // Check uniqueness
        const exists = await User.findOne({ $or: [{ email }, { userName }] });
        if (exists) throw new Error('Email or Username already exists');

        const hashed = bcrypt.hashSync(password, 10);
        const emp = new User({
          email,
          password: hashed,
          contactNumber,
          userName,
          userType: "employee",
          address,
          isActive: true,
          companyName: req.user.companyName,
          clientId: req.user.clientId,
          department: req.user.department,
          employeeHeadId: req.user.id,
          assignedModules,
          createdBy: req.user.id,
          parentUser: req.user.id,
          permissions: {
            canViewAllClients: false,
            canManageUsers: false,
            canManageClients: false,
            canViewReports: false,
            canEditBoundaries: false,
            canSubmitData: true,
            canAudit: false
          }
        });
        await emp.save();

          try { await saveUserProfileImage(req, emp); } catch (e) {
         console.warn('profile image save skipped:', e.message);
         }

        results.created.push({ id: emp._id, email: emp.email, userName: emp.userName });
      } catch (err) {
        results.errors.push({ input: data, error: err.message });
      }
    }

    const statusCode = results.created.length > 0 ? 201 : 400;
    return res.status(statusCode).json({
      message: `Employee creation completed`,
      ...results
    });
  } catch (error) {
    console.error("Create employee error:", error);
    return res.status(500).json({ 
      message: "Failed to create Employee", 
      error: error.message 
    });
  }
};;

// Create Auditor (Client Admin only)
const createAuditor = async (req, res) => {
  try {
    if (!req.user || req.user.userType !== "client_admin") {
      return res.status(403).json({ 
        message: "Only Client Admin can create Auditors" 
      });
    }
    
    const {
      email,
      password,
      contactNumber,
      userName,
      address,
      auditPeriod,
      auditScope
    } = req.body;
    
    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ email }, { userName }]
    });
    
    if (existingUser) {
      return res.status(409).json({ 
        message: "Email or Username already exists" 
      });
    }
    
    const hashedPassword = bcrypt.hashSync(password, 10);
    
    const auditor = new User({
      email,
      password: hashedPassword,
      contactNumber,
      userName,
      userType: "auditor",
      address,
      companyName: req.user.companyName,
      clientId: req.user.clientId,
      auditPeriod,
      auditScope,
      createdBy: req.user.id,
      permissions: {
        canViewAllClients: false,
        canManageUsers: false,
        canManageClients: false,
        canViewReports: true,
        canEditBoundaries: false,
        canSubmitData: false,
        canAudit: true
      }
    });
    
    await auditor.save();

        try { await saveUserProfileImage(req, auditor); } catch (e) {
      console.warn('profile image save skipped:', e.message);
    }

    
    res.status(201).json({
      message: "Auditor created successfully",
      auditor: {
        id: auditor._id,
        email: auditor.email,
        userName: auditor.userName,
        auditPeriod: auditor.auditPeriod
      }
    });
    
  } catch (error) {
    console.error("Create auditor error:", error);
    res.status(500).json({ 
      message: "Failed to create Auditor", 
      error: error.message 
    });
  }
};

// Create Viewer (Client Admin only)
const createViewer = async (req, res) => {
  try {
    if (!req.user || req.user.userType !== "client_admin") {
      return res.status(403).json({ 
        message: "Only Client Admin can create Viewers" 
      });
    }
    
    const {
      email,
      password,
      contactNumber,
      userName,
      address,
      viewerPurpose,
      viewerExpiryDate
    } = req.body;
    
    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ email }, { userName }]
    });
    
    if (existingUser) {
      return res.status(409).json({ 
        message: "Email or Username already exists" 
      });
    }
    
    const hashedPassword = bcrypt.hashSync(password, 10);
    
    const viewer = new User({
      email,
      password: hashedPassword,
      contactNumber,
      userName,
      userType: "viewer",
      address,
      companyName: req.user.companyName,
      clientId: req.user.clientId,
      viewerPurpose,
      viewerExpiryDate,
      createdBy: req.user.id,
      permissions: {
        canViewAllClients: false,
        canManageUsers: false,
        canManageClients: false,
        canViewReports: true,
        canEditBoundaries: false,
        canSubmitData: false,
        canAudit: false
      }
    });
    
    await viewer.save();

        try { await saveUserProfileImage(req, viewer); } catch (e) {
      console.warn('profile image save skipped:', e.message);
    }

    
    res.status(201).json({
      message: "Viewer created successfully",
      viewer: {
        id: viewer._id,
        email: viewer.email,
        userName: viewer.userName,
        viewerPurpose: viewer.viewerPurpose
      }
    });
    
  } catch (error) {
    console.error("Create viewer error:", error);
    res.status(500).json({ 
      message: "Failed to create Viewer", 
      error: error.message 
    });
  }
};

// Get users based on hierarchy
// ===============================================
// FIXED getUsers (S3 PROFILE IMAGE SAFE)
// ===============================================
const getUsers = async (req, res) => {
  try {
    // 1. Build base query by hierarchy
    let baseQuery = {};
    switch (req.user.userType) {
      case "super_admin":
        break;

      case "consultant_admin":
        baseQuery = {
          $or: [
            { createdBy: req.user.id },
            { consultantAdminId: req.user.id }
          ]
        };
        break;

      case "consultant": {
        const assignedClients = await Client.find({
          "leadInfo.assignedConsultantId": req.user.id
        }).select("clientId");
        const clientIds = assignedClients.map(c => c.clientId);
        baseQuery = { clientId: { $in: clientIds } };
        break;
      }

      case "client_admin":
        baseQuery = { clientId: req.user.clientId };
        break;

      case "client_employee_head":
        baseQuery = { createdBy: req.user.id };
        break;

      default:
        return res.status(403).json({
          message: "You don't have permission to view users"
        });
    }

    // 2. Extract query params
    const {
      page = 1,
      limit = 10,
      sort,
      search,
      ...filters
    } = req.query;

    // 3. Build filter query
    const filterQuery = {};

    Object.keys(filters).forEach(key => {
      const value = filters[key];
      if (value.includes(',')) {
        filterQuery[key] = { $in: value.split(',') };
      } else if (value === 'true' || value === 'false') {
        filterQuery[key] = value === 'true';
      } else if (!isNaN(value) && value !== '') {
        filterQuery[key] = Number(value);
      } else {
        filterQuery[key] = { $regex: value, $options: 'i' };
      }
    });

    // 4. Global search
    if (search) {
      const regex = { $regex: search, $options: 'i' };
      filterQuery.$or = [
        { userName: regex },
        { email: regex },
        { companyName: regex },
        { teamName: regex },
        { employeeId: regex },
        { jobRole: regex },
        { branch: regex },
        { clientId: regex },
        { department: regex }
      ];
    }

    // 5. Merge queries
    const finalQuery = { ...baseQuery, ...filterQuery };

    // 6. Sorting
    let sortObj = {};
    if (sort) {
      sort.split(',').forEach(field => {
        const [key, order = 'asc'] = field.split(':');
        sortObj[key] = order === 'desc' ? -1 : 1;
      });
    } else {
      sortObj = { createdAt: -1 };
    }

    // 7. Pagination
    const skip = (Number(page) - 1) * Number(limit);
    const limitNum = Number(limit);
    const total = await User.countDocuments(finalQuery);

    // 8. Fetch users (🔥 POPULATE profileImage)
    const users = await User.find(finalQuery)
      .select('-password')
      .populate('createdBy', 'userName email profileImage')
      .populate('parentUser', 'userName email profileImage')
      .populate('consultantAdminId', 'userName email profileImage')
      .populate('employeeHeadId', 'userName email profileImage')
      .sort(sortObj)
      .skip(skip)
      .limit(limitNum)
      .lean();

    // ------------------------------------------------
    // 🔥 PROFILE IMAGE NORMALIZATION (CRITICAL)
    // ------------------------------------------------
    const BASE = process.env.SERVER_BASE_URL?.replace(/\/+$/, '');

    const normalizeUser = (u) => {
      if (!u) return null;

      // ✅ S3 URL → keep it
      if (u.profileImage?.url) return u;

      // ⚠ legacy local image
      if (u.profileImage?.path && BASE) {
        u.profileImage.url =
          `${BASE}/${u.profileImage.path.replace(/\\/g, '/')}`;
      }

      return u;
    };

    const normalizedUsers = users.map(u => {
      u.createdBy = normalizeUser(u.createdBy);
      u.parentUser = normalizeUser(u.parentUser);
      u.consultantAdminId = normalizeUser(u.consultantAdminId);
      u.employeeHeadId = normalizeUser(u.employeeHeadId);
      return u;
    });

    // 9. Response
    res.status(200).json({
      success: true,
      message: 'Users fetched successfully',
      data: {
        users: normalizedUsers,
        pagination: {
          page: Number(page),
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
          hasNextPage: page < Math.ceil(total / limitNum),
          hasPrevPage: page > 1
        }
      }
    });

  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch users',
      error: error.message
    });
  }
};


async function getConsultantIds(consultantAdminId) {
  const consultants = await User.find({ 
    consultantAdminId: consultantAdminId,
    userType: "consultant"
  }).select("_id");
  return consultants.map(c => c._id);
}

// Helper function: Handle super admin deletion logic
async function handleSuperAdminDeletion(userToDelete, deletedBy) {
  const details = {
    canDelete: true,
    emailRecipients: [userToDelete.email]
  };
  
  // If deleting consultant admin, notify all their consultants
  if (userToDelete.userType === "consultant_admin") {
    const consultants = await User.find({ 
      consultantAdminId: userToDelete._id 
    }).select("email");
    details.emailRecipients.push(...consultants.map(c => c.email));
    
    // Deactivate all consultants under this consultant admin
    details.preDeletionTasks = async () => {
      await User.updateMany(
        { consultantAdminId: userToDelete._id },
        { isActive: false }
      );
    };
  }
  
  return details;
}

// Helper function: Handle consultant admin deletion logic
async function handleConsultantAdminDeletion(userToDelete, deletedBy, reassignToConsultantId) {
  const details = {
    canDelete: false,
    emailRecipients: [userToDelete.email]
  };
  
  // Consultant admin can delete their consultants
  if (userToDelete.userType === "consultant") {
    if (userToDelete.consultantAdminId?.toString() !== deletedBy.id) {
      details.message = "You can only delete consultants under your management";
      return details;
    }
    
    // Check if consultant has assigned clients
    const assignedClients = await Client.find({
      "leadInfo.assignedConsultantId": userToDelete._id
    });
    
    if (assignedClients.length > 0 && !reassignToConsultantId) {
      // Get available consultants for reassignment
      const availableConsultants = await User.find({
        consultantAdminId: deletedBy.id,
        userType: "consultant",
        _id: { $ne: userToDelete._id },
        isActive: true
      }).select("_id userName email");
      
      details.requiresReassignment = true;
      details.message = `This consultant has ${assignedClients.length} assigned clients. Please select another consultant to reassign them to.`;
      details.availableConsultants = availableConsultants;
      return details;
    }
    
    // Reassign clients if needed
    if (assignedClients.length > 0 && reassignToConsultantId) {
      // Verify reassignment consultant
      const newConsultant = await User.findOne({
        _id: reassignToConsultantId,
        consultantAdminId: deletedBy.id,
        userType: "consultant",
        isActive: true
      });
      
      if (!newConsultant) {
        details.message = "Invalid consultant selected for reassignment";
        return details;
      }
      
      details.preDeletionTasks = async () => {
        // 1. Update Client collection - reassign consultant
        await Client.updateMany(
          { "leadInfo.assignedConsultantId": userToDelete._id },
          { 
            "leadInfo.assignedConsultantId": reassignToConsultantId,
            $push: {
              timeline: {
                stage: "lead",
                status: "reassigned",
                action: "Consultant reassigned due to deletion",
                performedBy: deletedBy.id,
                notes: `Reassigned from ${userToDelete.userName} to ${newConsultant.userName}`,
                timestamp: new Date()
              }
            }
          }
        );

        // 2. Get the list of clientIds being reassigned
        const clientIds = assignedClients.map(client => client.clientId);

        // 3. Update the NEW consultant's assignedClients array and hasAssignedClients flag
        await User.findByIdAndUpdate(
          reassignToConsultantId,
          { 
            $addToSet: { assignedClients: { $each: clientIds } },
            $set: { hasAssignedClients: true }
          }
        );

        // 4. Remove clients from the OLD consultant's assignedClients array
        await User.findByIdAndUpdate(
          userToDelete._id,
          { 
            $pullAll: { assignedClients: clientIds },
            $set: { hasAssignedClients: false }
          }
        );

        // 5. Update consultant history in all affected clients
        for (const client of assignedClients) {
          // Mark previous assignment as inactive in consultant history
          const previousHistoryIndex = client.leadInfo.consultantHistory.findIndex(
            h => h.consultantId.toString() === userToDelete._id.toString() && h.isActive
          );
          
          if (previousHistoryIndex !== -1) {
            await Client.updateOne(
              { 
                _id: client._id,
                "leadInfo.consultantHistory.consultantId": userToDelete._id,
                "leadInfo.consultantHistory.isActive": true
              },
              {
                $set: {
                  "leadInfo.consultantHistory.$.isActive": false,
                  "leadInfo.consultantHistory.$.unassignedAt": new Date(),
                  "leadInfo.consultantHistory.$.unassignedBy": deletedBy.id,
                  "leadInfo.consultantHistory.$.reasonForChange": "Consultant deleted - reassigned"
                }
              }
            );
          }

          // Add new consultant to history
          await Client.updateOne(
            { _id: client._id },
            {
              $push: {
                "leadInfo.consultantHistory": {
                  consultantId: reassignToConsultantId,
                  consultantName: newConsultant.userName,
                  employeeId: newConsultant.employeeId,
                  assignedAt: new Date(),
                  assignedBy: deletedBy.id,
                  reasonForChange: "Reassigned due to consultant deletion",
                  isActive: true
                }
              }
            }
          );
        }

        console.log(`✅ Successfully reassigned ${clientIds.length} clients from ${userToDelete.userName} to ${newConsultant.userName}`);
      };
      
      details.reassignedTo = newConsultant.userName;
      details.reassignedClientsCount = assignedClients.length;
    }
    
    details.canDelete = true;
  }
  
  // Consultant admin can delete client admins of their clients
  else if (userToDelete.userType === "client_admin") {
    const client = await Client.findOne({
      clientId: userToDelete.clientId,
      $or: [
        { "leadInfo.consultantAdminId": deletedBy.id },
        { "leadInfo.assignedConsultantId": { $in: await getConsultantIds(deletedBy.id) } }
      ]
    });
    
    if (!client) {
      details.message = "You can only delete client admins of your managed clients";
      return details;
    }
    
    // Notify super admin when deleting client admin
    const superAdmin = await User.findOne({ userType: "super_admin" });
    if (superAdmin) {
      details.emailRecipients.push(superAdmin.email);
    }
    
    // Deactivate all users under this client
    details.preDeletionTasks = async () => {
      await User.updateMany(
        { clientId: userToDelete.clientId },
        { isActive: false }
      );
      
      // Update client status
      await Client.updateOne(
        { clientId: userToDelete.clientId },
        { 
          "accountDetails.isActive": false,
          "accountDetails.suspensionReason": "Client admin account deleted",
          "accountDetails.suspendedBy": deletedBy.id,
          "accountDetails.suspendedAt": new Date()
        }
      );
    };
    
    details.canDelete = true;
    details.notifySuperAdmin = true;
  }
  
  return details;
}

// Helper function: Handle client admin deletion logic
async function handleClientAdminDeletion(userToDelete, deletedBy) {
  const details = {
    canDelete: false,
    emailRecipients: [userToDelete.email]
  };
  
  // Check if user belongs to same organization
  if (userToDelete.clientId !== deletedBy.clientId) {
    details.message = "You can only delete users in your organization";
    return details;
  }
  
  // Client admin can delete employee heads, employees, auditors, and viewers
  const allowedTypes = ["client_employee_head", "employee", "auditor", "viewer"];
  if (!allowedTypes.includes(userToDelete.userType)) {
    details.message = "You can only delete employee heads, employees, auditors, and viewers";
    return details;
  }
  
  // If deleting employee head, deactivate their employees
  if (userToDelete.userType === "client_employee_head") {
    details.preDeletionTasks = async () => {
      await User.updateMany(
        { employeeHeadId: userToDelete._id },
        { isActive: false }
      );
    };
  }
  
  details.canDelete = true;
  return details;
}


const { replaceUserProfileImage } = require(
  '../utils/uploads/update/replaceUserProfileImage'
);

// Update user
// Update user
// =====================================
// UPDATE USER (S3 IMAGE SAFE)
// =====================================
const updateUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const updateData = { ...req.body };

    // Remove immutable fields
    delete updateData.password;
    delete updateData.userType;
    delete updateData.clientId;
    delete updateData.createdBy;
    delete updateData.consultantAdminId;
    delete updateData.parentUser;

    const userToUpdate = await User.findById(userId);
    if (!userToUpdate) {
      return res.status(404).json({ message: "User not found" });
    }

    // -------------------------------------
    // PERMISSION CHECK (UNCHANGED LOGIC)
    // -------------------------------------
    let canUpdate = false;

    if (userToUpdate._id.toString() === req.user.id) {
      canUpdate = true;
    } else {
      switch (req.user.userType) {
        case "super_admin":
          canUpdate =
            userToUpdate.userType !== "super_admin" ||
            userToUpdate._id.toString() === req.user.id;
          break;

        case "consultant_admin":
          if (userToUpdate.userType === "consultant") {
            canUpdate =
              userToUpdate.consultantAdminId?.toString() === req.user.id;
          }
          break;

        case "client_admin":
          canUpdate =
            userToUpdate.clientId === req.user.clientId &&
            ["client_employee_head", "employee", "auditor", "viewer"]
              .includes(userToUpdate.userType);
          break;

        case "client_employee_head":
          canUpdate =
            userToUpdate.userType === "employee" &&
            userToUpdate.createdBy?.toString() === req.user.id;
          break;
      }
    }

    if (!canUpdate) {
      return res.status(403).json({
        message: "You don't have permission to update this user"
      });
    }

    // -------------------------------------
    // APPLY FIELD UPDATES
    // -------------------------------------
    Object.assign(userToUpdate, updateData);
    await userToUpdate.save();

    // -------------------------------------
    // 🔥 REPLACE PROFILE IMAGE (IF UPLOADED)
    // -------------------------------------
    if (req.file) {
      await replaceUserProfileImage(req, userToUpdate);
    }

    const updatedUser = await User.findById(userId)
      .select('-password')
      .lean();

    return res.status(200).json({
      message: "User updated successfully",
      user: updatedUser
    });

  } catch (error) {
    console.error("Update user error:", error);
    return res.status(500).json({
      message: "Failed to update user",
      error: error.message
    });
  }
};



const { deleteUserProfileImage } = require(
  '../utils/uploads/delete/deleteUserProfileImage'
);

// Helper function: Get consultant IDs under a consultant admin


// ===============================================
// DELETE USER (S3 IMAGE SAFE)
// ===============================================
const deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { reassignToConsultantId } = req.body;

    const userToDelete = await User.findById(userId);
    if (!userToDelete) {
      return res.status(404).json({ message: "User not found" });
    }

    // Prevent self-deletion
    if (userToDelete._id.toString() === req.user.id) {
      return res.status(400).json({
        message: "You cannot delete your own account"
      });
    }

    // ------------------------------------------------
    // PERMISSION & HIERARCHY CHECK (UNCHANGED)
    // ------------------------------------------------
    let canDelete = false;
    let deletionDetails = null;

    switch (req.user.userType) {
      case "super_admin":
        if (userToDelete.userType === "super_admin") {
          return res.status(403).json({
            message: "Super admins cannot be deleted"
          });
        }
        canDelete = true;
        deletionDetails = await handleSuperAdminDeletion(
          userToDelete,
          req.user
        );
        break;

      case "consultant_admin":
        deletionDetails = await handleConsultantAdminDeletion(
          userToDelete,
          req.user,
          reassignToConsultantId
        );
        canDelete = deletionDetails.canDelete;
        break;

      case "client_admin":
        deletionDetails = await handleClientAdminDeletion(
          userToDelete,
          req.user
        );
        canDelete = deletionDetails.canDelete;
        break;

      case "client_employee_head":
        if (
          userToDelete.userType === "employee" &&
          userToDelete.createdBy?.toString() === req.user.id
        ) {
          canDelete = true;
          deletionDetails = {
            canDelete: true,
            emailRecipients: [userToDelete.email]
          };
        } else {
          deletionDetails = {
            canDelete: false,
            message: "You can only delete employees you directly created"
          };
        }
        break;

      default:
        return res.status(403).json({
          message: "You don't have permission to delete users"
        });
    }

    if (!canDelete) {
      return res.status(403).json({
        message:
          deletionDetails?.message ||
          "You don't have permission to delete this user"
      });
    }

    // ------------------------------------------------
    // REASSIGNMENT VALIDATION
    // ------------------------------------------------
    if (
      deletionDetails.requiresReassignment &&
      !reassignToConsultantId
    ) {
      return res.status(400).json({
        message: deletionDetails.message,
        requiresReassignment: true,
        availableConsultants:
          deletionDetails.availableConsultants
      });
    }

    // ------------------------------------------------
    // PRE-DELETION TASKS
    // ------------------------------------------------
    if (deletionDetails.preDeletionTasks) {
      await deletionDetails.preDeletionTasks();
    }

    // ------------------------------------------------
    // 🔥 DELETE PROFILE IMAGE FROM S3
    // ------------------------------------------------
    await deleteUserProfileImage(userToDelete);

    // ------------------------------------------------
    // SEND EMAIL NOTIFICATION
    // ------------------------------------------------
    await sendDeletionEmail(
      userToDelete,
      req.user,
      deletionDetails
    );

    // ------------------------------------------------
    // SOFT DELETE USER
    // ------------------------------------------------
    userToDelete.isActive = false;
    userToDelete.isDeleted = true;
    userToDelete.deletedAt = new Date();
    userToDelete.deletedBy = req.user.id;

    await userToDelete.save();

    // ------------------------------------------------
    // RESPONSE
    // ------------------------------------------------
    return res.status(200).json({
      message: `User ${userToDelete.userName} has been deleted successfully`,
      deletedUser: {
        id: userToDelete._id,
        userName: userToDelete.userName,
        email: userToDelete.email,
        userType: userToDelete.userType
      }
    });

  } catch (error) {
    console.error("Delete user error:", error);
    return res.status(500).json({
      message: "Failed to delete user",
      error: error.message
    });
  }
};



// Helper function: Send deletion notification emails
async function sendDeletionEmail(deletedUser, deletedBy, details) {
  const emailSubject = `ZeroCarbon - Account Deletion Notice`;
  let emailMessage = `
    Dear ${deletedUser.userName},
    
    Your ZeroCarbon account has been deleted by ${deletedBy.userName} (${deletedBy.userType.replace(/_/g, ' ')}).
    
    Account Details:
    - Username: ${deletedUser.userName}
    - Email: ${deletedUser.email}
    - User Type: ${deletedUser.userType.replace(/_/g, ' ')}
    - Deleted On: ${new Date().toLocaleString()}
  `;
  
  if (details.reassignedTo) {
    emailMessage += `\n\nYour assigned clients have been reassigned to: ${details.reassignedTo}`;
  }
  
  emailMessage += `\n\nIf you believe this is an error, please contact your administrator.
    
Best regards,
ZeroCarbon Team`;
  
  // Send to all recipients
  for (const recipient of details.emailRecipients) {
    await sendMail(recipient, emailSubject, emailMessage);
  }
  
  // Special notification for super admin when client admin is deleted
  if (details.notifySuperAdmin) {
    const superAdminMessage = `
      ADMIN NOTIFICATION: Client Admin Deletion
      
      A client admin account has been deleted:
      - Client Admin: ${deletedUser.userName} (${deletedUser.email})
      - Client ID: ${deletedUser.clientId}
      - Deleted By: ${deletedBy.userName} (${deletedBy.userType})
      - Date: ${new Date().toLocaleString()}
      
      All users under this client have been deactivated.
    `;
    
    const superAdmin = await User.findOne({ userType: "super_admin" });
    if (superAdmin) {
      await sendMail(superAdmin.email, "ALERT: Client Admin Account Deleted", superAdminMessage);
    }
  }
}

// Toggle user active status
// Updated Toggle user active status with email notification
const toggleUserStatus = async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Find user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    
    // Prevent self-deactivation
    if (!user.isActive && user._id.toString() === req.user.id) {
      return res.status(400).json({ 
        message: "You cannot deactivate your own account" 
      });
    }
    
    // Check permissions based on hierarchy
    let canToggle = false;
    
    switch (req.user.userType) {
      case "super_admin":
        // Super admin can toggle all except other super admins
        canToggle = user.userType !== "super_admin";
        break;
        
      case "consultant_admin":
        // Can toggle their consultants and client admins of their clients
        if (user.userType === "consultant") {
          canToggle = user.consultantAdminId?.toString() === req.user.id;
        } else if (user.userType === "client_admin") {
          // Check if this client admin belongs to a client managed by this consultant admin
          const Client = require("../models/CMS/Client");
          const client = await Client.findOne({ 
            clientId: user.clientId,
            $or: [
              { "leadInfo.consultantAdminId": req.user.id },
              { "leadInfo.assignedConsultantId": { $in: await getConsultantIds(req.user.id) } }
            ]
          });
          canToggle = !!client;
        }
        break;
        
      case "client_admin":
        // Can toggle users in their organization except other client admins
        canToggle = user.clientId === req.user.clientId &&
                   user.userType !== "client_admin";
        break;
        
      case "client_employee_head":
        // Can only toggle employees they created
        canToggle = user.userType === "employee" && 
                   user.createdBy.toString() === req.user.id;
        break;
        
      default:
        canToggle = false;
    }
    
    if (!canToggle) {
      return res.status(403).json({ 
        message: "You don't have permission to change this user's status" 
      });
    }
    
    // Store the old status
    const oldStatus = user.isActive;
    
    // Toggle status
    user.isActive = !user.isActive;
    await user.save();
    
    // Create notification and send email
    await createUserStatusNotification(user, req.user, user.isActive);
    
    // If deactivating a user with subordinates, notify them too
    if (!user.isActive) {
      let subordinates = [];
      
      switch (user.userType) {
        case "consultant_admin":
          // Find all consultants under this admin
          subordinates = await User.find({ 
            consultantAdminId: user._id,
            isActive: true 
          });
          break;
          
        case "client_admin":
          // Find all users in the same organization
          subordinates = await User.find({ 
            clientId: user.clientId,
            _id: { $ne: user._id },
            isActive: true 
          });
          break;
          
        case "client_employee_head":
          // Find all employees under this head
          subordinates = await User.find({ 
            employeeHeadId: user._id,
            isActive: true 
          });
          break;
      }
      
      // Notify subordinates about their superior's deactivation
      for (const subordinate of subordinates) {
        const notification = new Notification({
          title: "Important: Account Status Update",
          message: `${user.userName} (${user.userType.replace(/_/g, ' ')}) account has been deactivated. This may affect your access or operations.`,
          priority: "high",
          createdBy: req.user.id,
          creatorType: req.user.userType,
          targetUsers: [subordinate._id],
          status: "published",
          publishedAt: new Date(),
          isSystemNotification: true,
          systemAction: "superior_status_changed",
          relatedEntity: {
            type: "user",
            id: user._id
          }
        });
        
        await notification.save();
      }
    }
    
    res.status(200).json({
      message: `User ${user.isActive ? 'activated' : 'deactivated'} successfully`,
      user: {
        id: user._id,
        userName: user.userName,
        email: user.email,
        isActive: user.isActive
      }
    });
    
  } catch (error) {
    console.error("Toggle user status error:", error);
    res.status(500).json({ 
      message: "Failed to toggle user status", 
      error: error.message 
    });
  }
};
// Change password
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ 
        message: "Please provide current and new password" 
      });
    }
    
    // Get user with password
    const user = await User.findById(req.user.id);
    
    // Verify current password
    const isMatch = bcrypt.compareSync(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ 
        message: "Current password is incorrect" 
      });
    }
    
    // Hash new password
    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    user.password = hashedPassword;
    user.isFirstLogin = false;
    await user.save();
    
    res.status(200).json({
      message: "Password changed successfully"
    });
    
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ 
      message: "Failed to change password", 
      error: error.message 
    });
  }
};


// Request password reset
const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ 
        message: "Please provide your email address" 
      });
    }
    
    // Find user by email
    const user = await User.findOne({ 
      email: email.toLowerCase(),
      isActive: true 
    });
    
    if (!user) {
      // Don't reveal if email exists or not for security
      return res.status(200).json({ 
        message: "If your email is registered, you will receive a password reset link shortly." 
      });
    }
    
    // Generate reset token using JWT (valid for 15 minutes)
    const resetToken = jwt.sign(
      { 
        userId: user._id,
        email: user.email,
        purpose: "password-reset"
      },
      process.env.JWT_SECRET + user.password, // Use current password hash as part of secret
      { expiresIn: "15m" }
    );
    
    // Create reset URL
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;
    
    // Email content
    const emailSubject = "ZeroCarbon - Password Reset Request";
    const emailMessage = `
      Dear ${user.userName},
      
      We received a request to reset your password for your ZeroCarbon account.
      
      Please click on the link below to reset your password:
      ${resetUrl}
      
      This link will expire in 15 minutes for security reasons.
      
      If you did not request this password reset, please ignore this email and your password will remain unchanged.
      
      For security reasons, we recommend that you:
      - Use a strong, unique password
      - Do not share your password with anyone
      - Change your password regularly
      
      Best regards,
      ZeroCarbon Security Team
    `;
    
    // Send email
    const emailSent = await sendMail(user.email, emailSubject, emailMessage);
    
    if (!emailSent) {
      return res.status(500).json({ 
        message: "Failed to send reset email. Please try again later." 
      });
    }
    
    // Log the password reset attempt for security
    console.log(`Password reset requested for user: ${user.email} at ${new Date().toISOString()}`);
    
    res.status(200).json({
      message: "If your email is registered, you will receive a password reset link shortly."
    });
    
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ 
      message: "An error occurred. Please try again later.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
};

// Reset password using token
const resetPassword = async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    
    if (!token || !newPassword) {
      return res.status(400).json({ 
        message: "Please provide reset token and new password" 
      });
    }
    
    // Validate password strength (optional)
    if (newPassword.length < 8) {
      return res.status(400).json({ 
        message: "Password must be at least 8 characters long" 
      });
    }
    
    // Decode token to get userId
    let decoded;
    try {
      // First decode without verification to get userId
      const preDecoded = jwt.decode(token);
      if (!preDecoded || !preDecoded.userId) {
        throw new Error("Invalid token format");
      }
      
      // Get user to use their password hash as part of secret
      const user = await User.findById(preDecoded.userId);
      if (!user) {
        throw new Error("User not found");
      }
      
      // Now verify with the correct secret
      decoded = jwt.verify(token, process.env.JWT_SECRET + user.password);
      
      // Extra validation
      if (decoded.purpose !== "password-reset") {
        throw new Error("Invalid token purpose");
      }
      
    } catch (jwtError) {
      if (jwtError.name === "TokenExpiredError") {
        return res.status(400).json({ 
          message: "Password reset link has expired. Please request a new one." 
        });
      }
      return res.status(400).json({ 
        message: "Invalid or expired reset link" 
      });
    }
    
    // Find user and verify they're active
    const user = await User.findOne({
      _id: decoded.userId,
      email: decoded.email,
      isActive: true
    });
    
    if (!user) {
      return res.status(400).json({ 
        message: "Invalid reset link or user not found" 
      });
    }
    
    // Check if new password is same as current password
    const isSamePassword = bcrypt.compareSync(newPassword, user.password);
    if (isSamePassword) {
      return res.status(400).json({ 
        message: "New password must be different from your current password" 
      });
    }
    
    // Hash new password
    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    
    // Update user password
    user.password = hashedPassword;
    user.isFirstLogin = false; // In case it was a first login scenario
    await user.save();
    
    // Send confirmation email
    const confirmationSubject = "ZeroCarbon - Password Reset Successful";
    const confirmationMessage = `
      Dear ${user.userName},
      
      Your password has been successfully reset.
      
      If you did not perform this action, please contact our support team immediately.
      
      For your security:
      - Your old password is no longer valid
      - All existing sessions have been invalidated
      - You will need to log in again with your new password
      
      Login here: ${process.env.FRONTEND_URL}/login
      
      Best regards,
      ZeroCarbon Security Team
    `;
    
    await sendMail(user.email, confirmationSubject, confirmationMessage);
    
    // Log successful password reset
    console.log(`Password reset successful for user: ${user.email} at ${new Date().toISOString()}`);
    
    res.status(200).json({
      message: "Password has been reset successfully. Please login with your new password."
    });
    
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ 
      message: "Failed to reset password. Please try again.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
};

// Verify reset token (optional endpoint to check if token is valid before showing reset form)
const verifyResetToken = async (req, res) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({ 
        message: "Please provide reset token" 
      });
    }
    
    // Decode token to get userId
    let decoded;
    try {
      // First decode without verification to get userId
      const preDecoded = jwt.decode(token);
      if (!preDecoded || !preDecoded.userId) {
        throw new Error("Invalid token format");
      }
      
      // Get user to use their password hash as part of secret
      const user = await User.findById(preDecoded.userId);
      if (!user || (!user.isActive && !user.sandbox)) {
            return next(new Error('Invalid or inactive user'));
        }
      // Now verify with the correct secret
      decoded = jwt.verify(token, process.env.JWT_SECRET + user.password);
      
      // Extra validation
      if (decoded.purpose !== "password-reset") {
        throw new Error("Invalid token purpose");
      }
      
    } catch (jwtError) {
      if (jwtError.name === "TokenExpiredError") {
        return res.status(400).json({ 
          valid: false,
          message: "Password reset link has expired" 
        });
      }
      return res.status(400).json({ 
        valid: false,
        message: "Invalid reset link" 
      });
    }
    
    res.status(200).json({
      valid: true,
      message: "Reset token is valid",
      email: decoded.email // Can be used to pre-fill email field
    });
    
  } catch (error) {
    console.error("Verify reset token error:", error);
    res.status(500).json({ 
      valid: false,
      message: "Failed to verify token"
    });
  }
};

// Enhanced userController.js functions for proper assignment management

/**
 * POST /api/users/assign-head
 * body: { clientId, nodeId, headId }
 * └─ Only client_admin can assign an Employee Head to a specific node
 */
const assignHeadToNode = async (req, res) => {
  try {
    // 1) Authorization check
    if (req.user.userType !== 'client_admin') {
      return res.status(403).json({ 
        message: 'Only Client Admin can assign Employee Heads to nodes' 
      });
    }

    const { clientId, nodeId, headId } = req.body;

    // 2) Validate required fields
    if (!clientId || !nodeId || !headId) {
      return res.status(400).json({ 
        message: 'clientId, nodeId, and headId are required' 
      });
    }

    // 3) Verify this is the client admin's own organization
    if (req.user.clientId !== clientId) {
      return res.status(403).json({ 
        message: 'You can only assign heads within your own organization' 
      });
    }

    // 4) Verify the Employee Head exists and belongs to this organization
    const employeeHead = await User.findOne({
      _id: headId,
      userType: 'client_employee_head',
      clientId: clientId,
      isActive: true
    });

    if (!employeeHead) {
      return res.status(404).json({ 
        message: 'Employee Head not found or not in your organization' 
      });
    }

    // 5) Fetch the specific node to get its details
    const flowchart = await Flowchart.findOne(
      { clientId, 'nodes.id': nodeId },
      { 'nodes.$': 1 }
    );

    if (!flowchart || !flowchart.nodes || flowchart.nodes.length === 0) {
      return res.status(404).json({ 
        message: 'Flowchart or node not found' 
      });
    }

    const node = flowchart.nodes[0];
    const { nodeType, department, location } = node.details;

    // 6) Check if node already has a head assigned
    if (node.details.employeeHeadId) {
      // Remove previous assignment from old head's record
      await User.updateOne(
        { _id: node.details.employeeHeadId },
        {
          $pull: {
            assignedModules: {
              $regex: `.*"nodeId":"${nodeId}".*`
            }
          }
        }
      );
    }

    // 7) Update the flowchart to assign the new head
    const flowResult = await Flowchart.updateOne(
      { clientId, 'nodes.id': nodeId },
      { 
        $set: { 
          'nodes.$.details.employeeHeadId': headId,
          'nodes.$.details.lastAssignedAt': new Date(),
          'nodes.$.details.assignedBy': req.user._id
        }
      }
    );

    if (flowResult.modifiedCount === 0) {
      return res.status(404).json({ 
        message: 'Failed to update flowchart - node not found' 
      });
    }

    // 8) Update the Employee Head's record
    const moduleAssignment = {
      nodeId,
      nodeType: nodeType || 'unknown',
      department: department || 'unknown',
      location: location || 'unknown',
      assignedAt: new Date(),
      assignedBy: req.user._id
    };

    await User.updateOne(
      { _id: headId },
      {
        $addToSet: {
          assignedModules: JSON.stringify(moduleAssignment)
        }
      }
    );

    console.log(`✅ Employee Head ${employeeHead.userName} assigned to node ${nodeId} by ${req.user.userName}`);

    res.status(200).json({ 
      message: 'Employee Head successfully assigned to node',
      assignment: {
        employeeHead: {
          id: employeeHead._id,
          name: employeeHead.userName,
          email: employeeHead.email
        },
        node: {
          id: nodeId,
          label: node.label,
          nodeType,
          department,
          location
        },
        assignedAt: new Date()
      }
    });

  } catch (error) {
    console.error('❌ Error in assignHeadToNode:', error);
    res.status(500).json({ 
      message: 'Error assigning Employee Head to node', 
      error: error.message 
    });
  }
};

/**
 * POST /api/users/assign-scope
 * body: { clientId, nodeId, scopeIdentifier, employeeIds }
 * └─ Only the Employee Head assigned to that specific node can assign employees to scope details
 */
const assignScope = async (req, res) => {
  try {
    // 1) Authorization check
    if (req.user.userType !== 'client_employee_head') {
      return res.status(403).json({ 
        message: 'Only Employee Heads can assign employees to scopes' 
      });
    }

    const { clientId, nodeId, scopeIdentifier, employeeIds } = req.body;

    // 2) Validate required fields
    if (!clientId || !nodeId || !scopeIdentifier || !Array.isArray(employeeIds)) {
      return res.status(400).json({ 
        message: 'clientId, nodeId, scopeIdentifier, and employeeIds array are required' 
      });
    }

    if (employeeIds.length === 0) {
      return res.status(400).json({ 
        message: 'At least one employee must be assigned' 
      });
    }

    // 3) Verify this is within the head's organization
    if (req.user.clientId !== clientId) {
      return res.status(403).json({ 
        message: 'You can only assign employees within your organization' 
      });
    }

    // 4) Fetch the specific node and verify existence
    const flowchart = await Flowchart.findOne(
      { clientId, 'nodes.id': nodeId },
      { 'nodes.$': 1 }
    );

    if (!flowchart || !flowchart.nodes || flowchart.nodes.length === 0) {
      return res.status(404).json({ 
        message: 'Flowchart or node not found' 
      });
    }

    const node = flowchart.nodes[0];

    // 5) Verify this Employee Head is assigned to this node
    const assignedHeadId = node.details && node.details.employeeHeadId
      ? String(node.details.employeeHeadId)
      : null;
    const currentUserId = req.user.id
      ? String(req.user.id)
      : null;
    if (assignedHeadId !== currentUserId) {
      return res.status(403).json({ 
        message: 'You are not authorized to manage this node. Only the assigned Employee Head can assign scopes.' 
      });
    }

    // 6) Find the specific scope detail
    const scopeDetail = node.details.scopeDetails.find(
      scope => scope.scopeIdentifier === scopeIdentifier
    );

    if (!scopeDetail) {
      return res.status(404).json({ 
        message: `Scope detail '${scopeIdentifier}' not found in this node` 
      });
    }

    // 7) Verify all employees exist and belong to this organization
    const employees = await User.find({
      _id: { $in: employeeIds },
      userType: 'employee',
      clientId: clientId,
      isActive: true
    });

    if (employees.length !== employeeIds.length) {
      return res.status(400).json({ 
        message: 'One or more employees not found or not in your organization' 
      });
    }

    // 8) Remove existing assignments for these employees from this scope
    await Flowchart.updateOne(
      { clientId, 'nodes.id': nodeId },
      {
        $pull: {
          'nodes.$[n].details.scopeDetails.$[s].assignedEmployees': { 
            $in: employeeIds 
          }
        }
      },
      {
        arrayFilters: [
          { 'n.id': nodeId },
          { 's.scopeIdentifier': scopeIdentifier }
        ]
      }
    );

    // 9) Add new assignments to the flowchart
    const flowResult = await Flowchart.updateOne(
      { clientId, 'nodes.id': nodeId },
      {
        $addToSet: {
          'nodes.$[n].details.scopeDetails.$[s].assignedEmployees': { 
            $each: employeeIds 
          }
        },
        $set: {
          'nodes.$[n].details.scopeDetails.$[s].lastAssignedAt': new Date(),
          'nodes.$[n].details.scopeDetails.$[s].assignedBy': req.user._id
        }
      },
      {
        arrayFilters: [
          { 'n.id': nodeId },
          { 's.scopeIdentifier': scopeIdentifier }
        ]
      }
    );

    if (flowResult.modifiedCount === 0) {
      return res.status(500).json({ 
        message: 'Failed to update flowchart scope assignments' 
      });
    }

    // 10) Update each employee's record
    const scopeAssignment = {
      nodeId,
      nodeLabel: node.label,
      nodeType: node.details.nodeType || 'unknown',
      department: node.details.department || 'unknown',
      location: node.details.location || 'unknown',
      scopeIdentifier: scopeDetail.scopeIdentifier,
      scopeType: scopeDetail.scopeType,
      inputType: scopeDetail.inputType,
      assignedAt: new Date(),
      assignedBy: req.user._id
    };

    await User.updateMany(
      { _id: { $in: employeeIds } },
      {
        $set: { 
          employeeHeadId: req.user._id 
        },
        $addToSet: {
          assignedModules: JSON.stringify(scopeAssignment)
        }
      }
    );

    console.log(`✅ Scope '${scopeIdentifier}' assigned to ${employeeIds.length} employees by ${req.user.userName}`);

    res.status(200).json({ 
      message: 'Employees successfully assigned to scope',
      assignment: {
        scope: {
          identifier: scopeIdentifier,
          type: scopeDetail.scopeType,
          inputType: scopeDetail.inputType
        },
        node: {
          id: nodeId,
          label: node.label,
          department: node.details.department,
          location: node.details.location
        },
        employees: employees.map(emp => ({
          id: emp._id,
          name: emp.userName,
          email: emp.email
        })),
        assignedBy: req.user.userName,
        assignedAt: new Date()
      }
    });

  } catch (error) {
    console.error('❌ Error in assignScope:', error);
    res.status(500).json({ 
      message: 'Error assigning employees to scope', 
      error: error.message 
    });
  }
};



/**
 * GET /api/users/node-assignments/:clientId
 * └─ Get all node assignments for a client (Client Admin only)
 */
const getNodeAssignments = async (req, res) => {
  try {
    const { clientId } = req.params;

    // Authorization check
    if (req.user.userType !== 'client_admin' || req.user.clientId !== clientId) {
      return res.status(403).json({ 
        message: 'Only Client Admin can view node assignments for their organization' 
      });
    }

    // Get flowchart with populated employee head info
    const flowchart = await Flowchart.findOne({ clientId, isActive: true })
      .populate('nodes.details.employeeHeadId', 'userName email department location')
      .populate('nodes.details.scopeDetails.assignedEmployees', 'userName email');

    if (!flowchart) {
      return res.status(404).json({ message: 'Flowchart not found' });
    }

    // Format the response
    const assignments = flowchart.nodes.map(node => ({
      nodeId: node.id,
      nodeLabel: node.label,
      nodeType: node.details.nodeType,
      department: node.details.department,
      location: node.details.location,
      employeeHead: node.details.employeeHeadId ? {
        id: node.details.employeeHeadId._id,
        name: node.details.employeeHeadId.userName,
        email: node.details.employeeHeadId.email
      } : null,
      scopeAssignments: node.details.scopeDetails.map(scope => ({
        scopeIdentifier: scope.scopeIdentifier,
        scopeType: scope.scopeType,
        inputType: scope.inputType,
        assignedEmployees: scope.assignedEmployees || []
      }))
    }));

    res.status(200).json({
      message: 'Node assignments retrieved successfully',
      clientId,
      assignments
    });

  } catch (error) {
    console.error('❌ Error getting node assignments:', error);
    res.status(500).json({ 
      message: 'Error retrieving node assignments', 
      error: error.message 
    });
  }
};

/**
 * GET /api/users/my-assignments
 * └─ Get assignments for the current user (Employee Head or Employee)
 */
const getMyAssignments = async (req, res) => {
  try {
    const { userType, clientId, id: userId } = req.user;
    // Employee Head: list nodes they manage
    if (userType === 'client_employee_head') {
      // Find the active flowchart for this client with this head assigned
      const flowchart = await Flowchart.findOne(
        {
          clientId,
          isActive: true,
          'nodes.details.employeeHeadId': userId
        },
        { nodes: 1 }
      );
      let assignments = [];
      if (flowchart) {
        // Filter nodes where this head is assigned
        const assignedNodes = flowchart.nodes.filter(
          node => String(node.details.employeeHeadId) === userId
        );
        // Map to assignment objects
        assignments = assignedNodes.map(node => ({
          type: 'node_management',
          nodeId: node.id,
          nodeLabel: node.label,
          nodeType: node.details.nodeType,
          department: node.details.department,
          location: node.details.location,
          scopeCount: node.details.scopeDetails.length,
          scopes: node.details.scopeDetails.map(scope => ({
            scopeIdentifier: scope.scopeIdentifier,
            scopeType: scope.scopeType,
            inputType: scope.inputType,
            assignedEmployeeCount: scope.assignedEmployees?.length || 0
          }))
        }));
      }
      return res.status(200).json({
        message: 'Assignments retrieved successfully',
        userType,
        assignments
      });
    }

    // Employee: list scopes they're assigned to
    if (userType === 'employee') {
      const flowcharts = await Flowchart.find({ clientId, isActive: true });
      const assignments = [];
      flowcharts.forEach(fc => {
        fc.nodes.forEach(node => {
          node.details.scopeDetails.forEach(scope => {
            const assignedIds = (scope.assignedEmployees || []).map(id => String(id));
            if (assignedIds.includes(userId)) {
              assignments.push({
                type: 'scope_work',
                nodeId: node.id,
                nodeLabel: node.label,
                scopeIdentifier: scope.scopeIdentifier,
                scopeType: scope.scopeType,
                assignedAt: scope.lastAssignedAt || null
              });
            }
          });
        });
      });
      return res.status(200).json({
        message: 'Assignments retrieved successfully',
        userType,
        assignments
      });
    }

    // If neither
    return res.status(403).json({ message: 'Insufficient permissions' });
  } catch (error) {
    console.error('❌ Error retrieving my assignments:', error);
    res.status(500).json({
      message: 'Error retrieving assignments',
      error: error.message
    });
  }
};

/**
 * DELETE /api/users/remove-assignment
 * body: { clientId, nodeId, scopeIdentifier?, employeeIds? }
 * └─ Remove assignments (Node from Head or Employees from Scope)
 */
const removeAssignment = async (req, res) => {
  try {
    const { clientId, nodeId, scopeIdentifier, employeeIds } = req.body;

    if (!clientId || !nodeId) {
      return res.status(400).json({ 
        message: 'clientId and nodeId are required' 
      });
    }

    if (req.user.userType === 'client_admin') {
      // Remove Employee Head from node
      const result = await Flowchart.updateOne(
        { clientId, 'nodes.id': nodeId },
        { 
          $unset: { 'nodes.$.details.employeeHeadId': "" }
        }
      );

      if (result.modifiedCount > 0) {
        // Remove from user's assigned modules
        await User.updateMany(
          { userType: 'client_employee_head', clientId },
          {
            $pull: {
              assignedModules: { $regex: `.*"nodeId":"${nodeId}".*` }
            }
          }
        );

        res.status(200).json({ message: 'Employee Head removed from node' });
      } else {
        res.status(404).json({ message: 'Node not found' });
      }

    } else if (req.user.userType === 'client_employee_head' && scopeIdentifier && employeeIds) {
      // Remove employees from scope
      await Flowchart.updateOne(
        { clientId, 'nodes.id': nodeId },
        {
          $pull: {
            'nodes.$[n].details.scopeDetails.$[s].assignedEmployees': { 
              $in: employeeIds 
            }
          }
        },
        {
          arrayFilters: [
            { 'n.id': nodeId },
            { 's.scopeIdentifier': scopeIdentifier }
          ]
        }
      );

      // Remove from employees' assigned modules
      await User.updateMany(
        { _id: { $in: employeeIds } },
        {
          $pull: {
            assignedModules: { 
              $regex: `.*"nodeId":"${nodeId}".*"scopeIdentifier":"${scopeIdentifier}".*` 
            }
          }
        }
      );

      res.status(200).json({ message: 'Employees removed from scope' });
    } else {
      res.status(403).json({ message: 'Insufficient permissions' });
    }

  } catch (error) {
    console.error('❌ Error removing assignment:', error);
    res.status(500).json({ 
      message: 'Error removing assignment', 
      error: error.message 
    });
  }
};



module.exports = {
  initializeSuperAdmin,
  login,
  createConsultantAdmin,
  createConsultant,
  createClientAdmin,
  createEmployeeHead,
  createEmployee,
  createAuditor,
  createViewer,
  getUsers,
  updateUser,
  deleteUser,
  toggleUserStatus,
  changePassword,
  forgotPassword,
  resetPassword,
  verifyResetToken,
  assignHeadToNode,
  assignScope,
  getNodeAssignments,
  getMyAssignments,
  removeAssignment,
    verifyLoginOTP,          // ← NEW: OTP verification
  resendLoginOTP,          // ← NEW: Resend OTP
};