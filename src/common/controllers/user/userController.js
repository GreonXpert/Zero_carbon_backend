const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const User = require("../../models/User");
const Client = require("../../../modules/client-management/client/Client");
const { sendMail } = require("../../utils/mail");
const moment = require("moment");
const Notification = require("../../models/Notification/Notification");
// Import the notification controller
const { createUserStatusNotification } = require("../notification/notificationControllers");
const Flowchart = require('../../../modules/zero-carbon/organization/models/Flowchart');
const { saveUserProfileImage } = require('../../utils/uploads/userImageUploadS3');
const mongoose = require('mongoose');

const { getNormalizedLevels } = require("../../utils/Permissions/permissions");

// Import OTP Helper for 2FA
const {
  generateOTP,
  storeOTP,
  verifyOTP,
  sendOTPEmail,
  canResendOTP,
  updateResendTimestamp,
  OTP_CONFIG
} = require('../../utils/otpHelper');

const {
  notifySupportManagerWelcome,
  notifySupportUserWelcome,
  notifySupportManagerAssignmentsUpdated,
  notifySupportUserTransferredToManager,
  notifySupportManagerDeleted,
  notifySupportUserDeleted,
} = require("../../utils/notifications/supportNotifications");

const {
     validateAndSanitizeChecklist,
     VIEWER_DEFAULT_CHECKLIST,
     AUDITOR_DEFAULT_CHECKLIST,
       } = require('../../utils/Permissions/accessControlPermission');

const { logLogin, logLoginFailed, logUserCreated } = require('../../services/audit/auditLogService');
const { logEvent } = require('../../services/audit/auditLogService');
const UserSession = require('../../models/UserSession');
const { isModuleSubscriptionActive } = require('../../utils/Permissions/modulePermission');

'use strict';

// ─── FormData-safe accessControls parser ─────────────────────────────────────
// FormData (multipart/form-data) serialises every field as a string, so when
// the frontend sends:   formData.append('accessControls', JSON.stringify({...}))
// the backend receives a JSON string, not an object.
// This helper handles both cases transparently so create AND update endpoints
// work whether the request is application/json or multipart/form-data.
//
// Returns: { ok: true,  value: <parsed object> }
//       or { ok: false, error: <human-readable message> }
const parseAccessControls = (raw) => {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: null }; // absent → caller uses default checklist
  }

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return { ok: true, value: raw }; // already an object (application/json path)
  }

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
        return { ok: false, error: 'accessControls must be a JSON object, not an array or primitive.' };
      }
      return { ok: true, value: parsed };
    } catch (_) {
      return { ok: false, error: 'accessControls is not valid JSON. Send it as a stringified object.' };
    }
  }

  return { ok: false, error: 'accessControls must be an object (or a JSON-stringified object for FormData requests).' };
};
// ─────────────────────────────────────────────────────────────────────────────

const {
  reserveUserTypeSlot,
  releaseUserTypeSlot,
  getUserTypeQuotaStatusFromDoc,
  getAssignedConsultantId,
} = require('../../../modules/client-management/quota/quotaService');

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
      logLoginFailed(req, req.body.email || req.body.identifier).catch(() => {});
      return res.status(404).json({ message: "User not found" });
    }

    // ==========================================================
    // 2. PASSWORD VALIDATION
    // ==========================================================
    
    const isMatch = bcrypt.compareSync(password, user.password);
    if (!isMatch) {
      console.log(`[LOGIN STEP 1] Invalid password for: ${user.email}`);
      logLoginFailed(req, req.body.email || req.body.identifier).catch(() => {});
      return res.status(400).json({ message: "Invalid credentials" });
    }

    // ==========================================================
    // 3. CHECK CLIENT ACTIVE STATUS (ONLY FOR NON-SANDBOX USERS)
    // ==========================================================
    if (user.clientId && !user.sandbox) {
      // NOTE: accountDetails is encrypted in MongoDB — we CANNOT query on
      // "accountDetails.isActive" directly (it's stored as an encrypted blob).
      // Fetch by clientId only, then check isActive AFTER Mongoose decrypts it.
      const client = await Client.findOne({ clientId: user.clientId });

      if (!client || !client.accountDetails?.isActive) {
        console.log(`[LOGIN STEP 1] Inactive client: ${user.clientId}`);
        logLoginFailed(req, req.body.email || req.body.identifier).catch(() => {});
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

      if (decoded.stage !== "otp_pending" || decoded.purpose !== "2fa_verification") {
        return res.status(401).json({ message: "Invalid temporary token" });
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
    // 4. CONCURRENT SESSION ENFORCEMENT
    // ==========================================================
    const limit = user.concurrentLoginLimit ?? 1;

    // Cleanup stale expired sessions first
    await UserSession.updateMany(
      {
        userId: user._id,
        isActive: true,
        expiresAt: { $lt: new Date() }
      },
      {
        $set: { isActive: false }
      }
    );

    const activeSessionCount = await UserSession.countDocuments({
      userId: user._id,
      isActive: true
    });

    console.log(
      `[LOGIN STEP 2] User ${user.email}: activeSessionCount=${activeSessionCount}, limit=${limit}`
    );

    if (activeSessionCount >= limit) {
      console.log(
        `[LOGIN STEP 2] Concurrent session limit reached for ${user.email}`
      );
      return res.status(409).json({
        message: "Already logged in on another device",
        code: "SESSION_LIMIT_REACHED",
        activeSessions: activeSessionCount,
        limit
      });
    }

    // ==========================================================
    // 4b. QUOTA-LEVEL CONCURRENT SESSION CHECK
    // ==========================================================
    const QUOTA_CONCURRENT_TYPES = ["client_employee_head", "employee", "viewer", "auditor"];

    if (QUOTA_CONCURRENT_TYPES.includes(user.userType) && user.clientId) {
      const { checkConcurrentLoginLimit } = require("../../../modules/client-management/quota/quotaService");
      const concurrentCheck = await checkConcurrentLoginLimit(user);

      if (!concurrentCheck.allowed) {
        console.log(
          `[LOGIN STEP 2] Quota concurrent session limit reached for ${user.email}: ` +
          `${concurrentCheck.activeCount}/${concurrentCheck.limit}`
        );

        return res.status(429).json({
          message: concurrentCheck.message,
          code: "QUOTA_SESSION_LIMIT_REACHED",
          limit: concurrentCheck.limit,
          activeCount: concurrentCheck.activeCount
        });
      }
    }

    // ==========================================================
    // 5. UPDATE FIRST LOGIN FLAG
    // ==========================================================
    if (user.isFirstLogin) {
      user.isFirstLogin = false;
      await user.save();
    }

    // ==========================================================
    // 6. CREATE SESSION RECORD
    // ==========================================================
    const sessionId = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const userAgent = req.headers["user-agent"] || "unknown";
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      "unknown";

    await UserSession.create({
      userId: user._id,
      sessionId,
      userAgent,
      ip,
      expiresAt,
      isActive: true
    });

    console.log(`[LOGIN STEP 2] Session created: ${sessionId.slice(0, 8)}… for ${user.email}`);

    // ==========================================================
    // 7. CREATE FINAL JWT TOKEN
    // ==========================================================
    const tokenPayload = {
      id: user._id,
      email: user.email,
      userName: user.userName,
      userType: user.userType,
      clientId: user.clientId,
      permissions: user.permissions,
      sandbox: user.sandbox === true,
      assessmentLevel: user.assessmentLevel || [],
      sessionId
    };

    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, {
      expiresIn: "24h"
    });

    // ==========================================================
    // 8. PREPARE USER DATA
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
    // 9. SUCCESS RESPONSE
    // ==========================================================
    logLogin(req, user).catch(() => {});
    console.log(`[LOGIN STEP 2] Login successful for ${user.email}`);

    return res.status(200).json({
      user: userData,
      token,
      message: "Login successful"
    });

  } catch (error) {
    console.error("[LOGIN STEP 2] Error:", error);
    return res.status(500).json({
      message: "OTP verification failed",
      error: error.message
    });
  }
};

// ============================================================
// NEW FUNCTION: logout
//
// POST /api/users/logout
// Header: Authorization: Bearer <token>
//
// Marks the current session as inactive so:
//   - The auth middleware will reject the token immediately (before JWT expiry).
//   - The slot is freed, allowing the user (or another browser) to log in again.
//   - The TTL index will eventually clean up the document automatically.
//
// No body required — session is identified from the token via req.sessionId
// (set by the auth middleware which runs before this handler).
// ============================================================
const logout = async (req, res) => {
  try {
    const sessionId = req.sessionId; // set by auth middleware

    if (!sessionId) {
      // Should never happen when auth middleware is applied, but guard anyway
      return res.status(400).json({ message: "No active session found" });
    }

    const result = await UserSession.updateOne(
      { sessionId, userId: req.user.id, isActive: true },
      { $set: { isActive: false } }
    );

    if (result.matchedCount === 0) {
      // Session already invalidated or not found — still treat as success
      console.log(`[LOGOUT] Session not found or already logged out: ${sessionId.slice(0, 8)}…`);
    } else {
      console.log(`[LOGOUT] Session invalidated: ${sessionId.slice(0, 8)}… for ${req.user.email}`);
    }

    return res.status(200).json({ message: "Logged out successfully" });

  } catch (error) {
    console.error("[LOGOUT] Error:", error);
    return res.status(500).json({
      message: "Logout failed",
      error: error.message
    });
  }
};


// ════════════════════════════════════════════════════════════════════════
//  A)  logoutAllDevices
//      POST /api/users/me/logout-all-devices
//
//  Strategy: Option B (recommended UX)
//    Revoke ALL sessions EXCEPT the current one.
//    The user stays logged in on the device they used to trigger this.
//    All other devices/tabs receive SESSION_EXPIRED on the next request.
//
//  To switch to Option A (strict "all devices including current"):
//    Replace the query filter:
//      { userId: req.user.id }          ← Option A
//    with:
//      { userId: req.user.id,
//        sessionId: { $ne: req.sessionId } }  ← Option B (current)
// ════════════════════════════════════════════════════════════════════════

const logoutAllDevices = async (req, res) => {
  try {
    // ── 1. Permission check ──────────────────────────────────────────
    //  canLogoutAllDevices must be explicitly true on the User document.
    //  We re-read from DB (not JWT) to get the live value.
    const user = await User.findById(req.user.id).select('canLogoutAllDevices email userName');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (!user.canLogoutAllDevices) {
      console.log(
        `[LOGOUT-ALL] DENIED — ${user.email} does not have canLogoutAllDevices permission`
      );
      return res.status(403).json({
        message: 'You do not have permission to log out from all devices.',
        code:    'LOGOUT_ALL_DENIED'
      });
    }

    // ── 2. Revoke all sessions except the current one (Option B) ────
    //  Change the filter to `{ userId: req.user.id }` if you prefer Option A.
    const currentSessionId = req.sessionId; // set by auth middleware

    const result = await UserSession.updateMany(
      {
        userId:    req.user.id,
        isActive:  true,
        sessionId: { $ne: currentSessionId }   // exclude the current session
      },
      { $set: { isActive: false } }
    );

    const revokedCount = result.modifiedCount;

    console.log(
      `[LOGOUT-ALL] ${user.email} revoked ${revokedCount} session(s) ` +
      `(current session ${currentSessionId.slice(0, 8)}… preserved)`
    );

    return res.status(200).json({
      success:      true,
      message:      revokedCount > 0
        ? `Logged out from ${revokedCount} other device(s) successfully.`
        : 'No other active sessions found.',
      revokedCount
    });

  } catch (error) {
    console.error('[LOGOUT-ALL] Error:', error);
    return res.status(500).json({
      message: 'Logout from all devices failed.',
      error:   process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
};


// ════════════════════════════════════════════════════════════════════════
//  B)  setUserPermissions
//      PATCH /api/admin/users/:userId/user-permissions
//
//  Body (one or both fields required):
//    { "canLogoutAllDevices": true, "permissionToEdit": true }
//
//  Allowed callers:
//    super_admin         — can update any user
//    consultant_admin    — can update users whose clientId is in their assignedClients
//
//  Blocked callers:
//    client_admin and all other roles → 403
// ════════════════════════════════════════════════════════════════════════

const setUserPermissions = async (req, res) => {
  try {
    const { userId } = req.params;
    const requester  = req.user;

    // ── 1. Validate userId ───────────────────────────────────────────
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'Invalid userId' });
    }

    // ── 2. Validate body ─────────────────────────────────────────────
    const { canLogoutAllDevices, permissionToEdit } = req.body;

    const hasCanLogout = canLogoutAllDevices !== undefined && canLogoutAllDevices !== null;
    const hasPermEdit  = permissionToEdit    !== undefined && permissionToEdit    !== null;

    if (!hasCanLogout && !hasPermEdit) {
      return res.status(400).json({
        message: 'At least one of canLogoutAllDevices or permissionToEdit must be provided.',
        allowed: ['canLogoutAllDevices (boolean)', 'permissionToEdit (boolean)']
      });
    }

    if (hasCanLogout && typeof canLogoutAllDevices !== 'boolean') {
      return res.status(400).json({ message: 'canLogoutAllDevices must be a boolean.' });
    }

    if (hasPermEdit && typeof permissionToEdit !== 'boolean') {
      return res.status(400).json({ message: 'permissionToEdit must be a boolean.' });
    }

    // ── 3. Prevent self-update ───────────────────────────────────────
    if (String(userId) === String(requester.id)) {
      return res.status(400).json({ message: 'You cannot modify your own permission badges.' });
    }

    // ── 4. Load target user ──────────────────────────────────────────
    const targetUser = await User.findById(userId).select('-password');

    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    // ── 5. Caller authorisation ──────────────────────────────────────
    const reqType = requester.userType;

    if (reqType === 'super_admin') {
      // super_admin can update any user — no further checks needed
    } else if (reqType === 'consultant_admin') {
      // consultant_admin: target must belong to one of their assigned clients
      if (!targetUser.clientId) {
        return res.status(403).json({
          message: 'Target user has no clientId — cannot verify organisation ownership.'
        });
      }

      // Re-fetch live assignedClients (not from JWT — may be stale)
      const adminDoc = await User.findById(requester.id)
        .select('assignedClients')
        .lean();

      const assignedClients = adminDoc?.assignedClients || [];

      if (!assignedClients.map(String).includes(String(targetUser.clientId))) {
        return res.status(403).json({
          message: `You can only manage permissions for users whose organisation (${targetUser.clientId}) is in your assigned clients list.`
        });
      }
    } else {
      // All other roles — explicitly denied
      return res.status(403).json({
        message: 'Only super_admin or consultant_admin can modify user permission badges.'
      });
    }

    // ── 6. Apply the updates ─────────────────────────────────────────
    const previousValues = {
      canLogoutAllDevices: targetUser.canLogoutAllDevices,
      permissionToEdit:    targetUser.permissionToEdit
    };

    if (hasCanLogout) targetUser.canLogoutAllDevices = canLogoutAllDevices;
    if (hasPermEdit)  targetUser.permissionToEdit    = permissionToEdit;

    await targetUser.save();

    console.log(
      `[USER-PERMS] ${requester.userType} (${requester.email}) updated ` +
      `${targetUser.userType} (${targetUser.email}): ` +
      `${JSON.stringify(previousValues)} → ` +
      `canLogoutAllDevices=${targetUser.canLogoutAllDevices}, ` +
      `permissionToEdit=${targetUser.permissionToEdit}`
    );

    return res.status(200).json({
      message: 'User permission badges updated successfully.',
      user: {
        id:                  targetUser._id,
        userName:            targetUser.userName,
        email:               targetUser.email,
        userType:            targetUser.userType,
        clientId:            targetUser.clientId || null,
        canLogoutAllDevices: targetUser.canLogoutAllDevices,
        permissionToEdit:    targetUser.permissionToEdit,
        previous:            previousValues
      }
    });

  } catch (error) {
    if (error.name === 'ValidationError') {
      const msgs = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ message: 'Validation failed', errors: msgs });
    }

    console.error('[USER-PERMS] Unexpected error:', error);
    return res.status(500).json({
      message: 'Failed to update user permissions.',
      error:   process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
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
    const companyName = req.body.companyName;
    const concurrentLoginLimit= req.body.concurrentLoginLimit || 1;

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
      companyName,
      createdBy: req.user.id,
      isActive: true,
      sandbox: false,
      concurrentLoginLimit
    });

    await consultantAdmin.save();
    console.log("[DEBUG] ✅ User saved to DB with ID:", consultantAdmin._id);
    logUserCreated(req, consultantAdmin).catch(() => {});

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
        profileImage: consultantAdmin.profileImage || null,
        concurrentLoginLimit: consultantAdmin.concurrentLoginLimit || 1
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
      teamName,
      concurrentLoginLimit
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
        { userName: userName},
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
      userName: userName,
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
      },
      concurrentLoginLimit: concurrentLoginLimit || 1 // Default to 1 if not specified
    });
    
    await consultant.save();
    
    console.log(`✅ Consultant created: ${consultant.userName} (ID: ${consultant.employeeId})`);
    logUserCreated(req, consultant).catch(() => {})
    
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
        profileImage: consultant.profileImage?.url || null,
        concurrentLoginLimit: consultant.concurrentLoginLimit
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

        // ==========================================
        // 7b. QUOTA ENFORCEMENT (atomic slot reservation)
        // ==========================================
        const ehSlot = await reserveUserTypeSlot(req.user.clientId, 'client_employee_head');
        if (!ehSlot.allowed) {
          throw Object.assign(new Error(ehSlot.message || 'Employee Head quota exceeded for this client.'), {
            isQuotaError: true,
            quota: {
              limit:     ehSlot.limit,
              used:      ehSlot.used,
              remaining: ehSlot.remaining,
            },
          });
        }

        try {
          await head.save();
        } catch (saveErr) {
          // Rollback the reserved slot on DB failure
          if (ehSlot.reserved && ehSlot.consultantId) {
            await releaseUserTypeSlot(req.user.clientId, 'client_employee_head', ehSlot.consultantId).catch(() => {});
          }
          throw saveErr;
        }

        logUserCreated(req, head).catch(() => {})

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
          field: extractFieldFromError(err.message),
          ...(err.isQuotaError ? { quotaExceeded: true, quota: err.quota } : {}),
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

        // ── Quota enforcement ──────────────────────────────────────
        const empSlot = await reserveUserTypeSlot(req.user.clientId, 'employee');
        if (!empSlot.allowed) {
          throw Object.assign(
            new Error(empSlot.message || 'Employee quota exceeded for this client.'),
            {
              isQuotaError: true,
              quota: { limit: empSlot.limit, used: empSlot.used, remaining: empSlot.remaining },
            }
          );
        }

        try {
          await emp.save();
        } catch (saveErr) {
          if (empSlot.reserved && empSlot.consultantId) {
            await releaseUserTypeSlot(req.user.clientId, 'employee', empSlot.consultantId).catch(() => {});
          }
          throw saveErr;
        }
        // ── End quota enforcement ──────────────────────────────────

          logUserCreated(req, emp).catch(() => {});
          try { await saveUserProfileImage(req, emp); } catch (e) {
         console.warn('profile image save skipped:', e.message);
         }

        results.created.push({ id: emp._id, email: emp.email, userName: emp.userName });
      } catch (err) {
        results.errors.push({
          input: data,
          error: err.message,
          ...(err.isQuotaError ? { quotaExceeded: true, quota: err.quota } : {}),
        });
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

// ============================================================
// PATCH: controllers/userController.js
// ============================================================


const createAuditor = async (req, res) => {
  try {
    if (!req.user || req.user.userType !== 'client_admin') {
      return res.status(403).json({
        message: 'Only Client Admin can create Auditors',
      });
    }

    const {
      email,
      password,
      contactNumber,
      userName,
      address,
      auditPeriod,
      auditScope,
      accessControls,   // optional checklist from client_admin
      accessibleModules, // 🆕 which module(s) this auditor accesses
    } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ $or: [{ email }, { userName }] });
    if (existingUser) {
      return res.status(409).json({ message: 'Email or Username already exists' });
    }

    // ── Resolve and validate accessibleModules ───────────────────────────────
    const VALID_MODULES = ['zero_carbon', 'esg_link'];
    let resolvedModules;
    if (accessibleModules && accessibleModules.length > 0) {
      const modulesArray = Array.isArray(accessibleModules) ? accessibleModules : [accessibleModules];
      const invalid = modulesArray.filter(m => !VALID_MODULES.includes(m));
      if (invalid.length > 0) {
        return res.status(400).json({ message: `Invalid module(s): ${invalid.join(', ')}. Allowed: ${VALID_MODULES.join(', ')}` });
      }
      // Check client has those modules
      const clientDoc = await Client.findOne({ clientId: req.user.clientId });
      if (clientDoc) {
        for (const mod of modulesArray) {
          if (!clientDoc.accessibleModules?.includes(mod)) {
            return res.status(403).json({ message: `Client does not have access to module: ${mod}` });
          }
          if (!isModuleSubscriptionActive(clientDoc, mod)) {
            return res.status(403).json({ message: `The ${mod} subscription is not active for this client` });
          }
        }
      }
      resolvedModules = modulesArray;
    } else {
      // Default to client's accessible modules
      const clientDoc = await Client.findOne({ clientId: req.user.clientId });
      resolvedModules = clientDoc?.accessibleModules || ['zero_carbon'];
    }

    // ── Parse + validate accessControls ─────────────────────────────────────
    // parseAccessControls handles both application/json (object) and
    // multipart/form-data (JSON string) transparently.
    let resolvedAccessControls;
    const acParsed = parseAccessControls(accessControls);
    if (!acParsed.ok) {
      return res.status(400).json({ message: `Invalid accessControls: ${acParsed.error}` });
    }
    if (acParsed.value) {
      const validation = validateAndSanitizeChecklist(acParsed.value);
      if (!validation.valid) {
        return res.status(400).json({
          message: `Invalid accessControls: ${validation.error}`,
        });
      }
      resolvedAccessControls = validation.sanitized;
    } else {
      // Fail-closed default: all false. client_admin must explicitly grant access.
      resolvedAccessControls = AUDITOR_DEFAULT_CHECKLIST;
    }

    const hashedPassword = bcrypt.hashSync(password, 10);

    const auditor = new User({
      email,
      password: hashedPassword,
      contactNumber,
      userName,
      userType: 'auditor',
      address,
      companyName: req.user.companyName,
      clientId: req.user.clientId,
      auditPeriod,
      auditScope,
      createdBy: req.user.id,
      isActive: true,
      accessibleModules: resolvedModules, // 🆕 store which module(s) this auditor accesses
      permissions: {
        canViewAllClients: false,
        canManageUsers: false,
        canManageClients: false,
        canViewReports: true,
        canEditBoundaries: false,
        canSubmitData: false,
        canAudit: true,
      },
      accessControls: resolvedAccessControls,
    });

    // ── Quota enforcement ────────────────────────────────────────────────────
    const auditorSlot = await reserveUserTypeSlot(req.user.clientId, 'auditor');
    if (!auditorSlot.allowed) {
      return res.status(429).json({
        message: auditorSlot.message || 'Auditor quota exceeded for this client.',
        quota: {
          limit:     auditorSlot.limit     ?? null,
          used:      auditorSlot.used      ?? null,
          remaining: auditorSlot.remaining ?? 0,
        },
      });
    }

    try {
      await auditor.save();
    } catch (saveErr) {
      if (auditorSlot.reserved && auditorSlot.consultantId) {
        await releaseUserTypeSlot(req.user.clientId, 'auditor', auditorSlot.consultantId).catch(() => {});
      }
      throw saveErr;
    }
    // ── End quota enforcement ────────────────────────────────────────────────

    logUserCreated(req, auditor).catch(() => {});
    try {
      await saveUserProfileImage(req, auditor);
    } catch (e) {
      console.warn('profile image save skipped:', e.message);
    }

    res.status(201).json({
      message: 'Auditor created successfully',
      auditor: {
        id: auditor._id,
        email: auditor.email,
        userName: auditor.userName,
        auditPeriod: auditor.auditPeriod,
        accessControls: auditor.accessControls, // 🆕 return checklist in response
      },
    });
  } catch (error) {
    console.error('Create auditor error:', error);
    res.status(500).json({
      message: 'Failed to create Auditor',
      error: error.message,
    });
  }
};

// ─────────────────────────────────────────────────────────────
// REPLACEMENT for the existing createViewer function:
// ─────────────────────────────────────────────────────────────

const createViewer = async (req, res) => {
  try {
    if (!req.user || req.user.userType !== 'client_admin') {
      return res.status(403).json({
        message: 'Only Client Admin can create Viewers',
      });
    }

    const {
      email,
      password,
      contactNumber,
      userName,
      address,
      viewerPurpose,
      viewerExpiryDate,
      accessControls,    // optional checklist from client_admin
      accessibleModules, // 🆕 which module(s) this viewer accesses
    } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ $or: [{ email }, { userName }] });
    if (existingUser) {
      return res.status(409).json({ message: 'Email or Username already exists' });
    }

    // ── Resolve and validate accessibleModules ───────────────────────────────
    const VALID_MODULES_V = ['zero_carbon', 'esg_link'];
    let resolvedModulesV;
    if (accessibleModules && accessibleModules.length > 0) {
      const modulesArrayV = Array.isArray(accessibleModules) ? accessibleModules : [accessibleModules];
      const invalidV = modulesArrayV.filter(m => !VALID_MODULES_V.includes(m));
      if (invalidV.length > 0) {
        return res.status(400).json({ message: `Invalid module(s): ${invalidV.join(', ')}. Allowed: ${VALID_MODULES_V.join(', ')}` });
      }
      const clientDocV = await Client.findOne({ clientId: req.user.clientId });
      if (clientDocV) {
        for (const mod of modulesArrayV) {
          if (!clientDocV.accessibleModules?.includes(mod)) {
            return res.status(403).json({ message: `Client does not have access to module: ${mod}` });
          }
          if (!isModuleSubscriptionActive(clientDocV, mod)) {
            return res.status(403).json({ message: `The ${mod} subscription is not active for this client` });
          }
        }
      }
      resolvedModulesV = modulesArrayV;
    } else {
      const clientDocV = await Client.findOne({ clientId: req.user.clientId });
      resolvedModulesV = clientDocV?.accessibleModules || ['zero_carbon'];
    }

    // ── Parse + validate accessControls ─────────────────────────────────────
    // parseAccessControls handles both application/json (object) and
    // multipart/form-data (JSON string) transparently.
    let resolvedAccessControls;
    const acParsed = parseAccessControls(accessControls);
    if (!acParsed.ok) {
      return res.status(400).json({ message: `Invalid accessControls: ${acParsed.error}` });
    }
    if (acParsed.value) {
      const validation = validateAndSanitizeChecklist(acParsed.value);
      if (!validation.valid) {
        return res.status(400).json({
          message: `Invalid accessControls: ${validation.error}`,
        });
      }
      resolvedAccessControls = validation.sanitized;
    } else {
      // Fail-closed default: all false. client_admin must explicitly grant access.
      resolvedAccessControls = VIEWER_DEFAULT_CHECKLIST;
    }

    const hashedPassword = bcrypt.hashSync(password, 10);

    const viewer = new User({
      email,
      password: hashedPassword,
      contactNumber,
      userName,
      userType: 'viewer',
      address,
      companyName: req.user.companyName,
      clientId: req.user.clientId,
      viewerPurpose,
      viewerExpiryDate,
      createdBy: req.user.id,
      isActive: true,
      accessibleModules: resolvedModulesV, // 🆕 store which module(s) this viewer accesses
      permissions: {
        canViewAllClients: false,
        canManageUsers: false,
        canManageClients: false,
        canViewReports: true,
        canEditBoundaries: false,
        canSubmitData: false,
        canAudit: false,
      },
      accessControls: resolvedAccessControls,
    });

    // ── Quota enforcement ────────────────────────────────────────────────────
    const viewerSlot = await reserveUserTypeSlot(req.user.clientId, 'viewer');
    if (!viewerSlot.allowed) {
      return res.status(429).json({
        message: viewerSlot.message || 'Viewer quota exceeded for this client.',
        quota: {
          limit:     viewerSlot.limit     ?? null,
          used:      viewerSlot.used      ?? null,
          remaining: viewerSlot.remaining ?? 0,
        },
      });
    }

    try {
      await viewer.save();
    } catch (saveErr) {
      if (viewerSlot.reserved && viewerSlot.consultantId) {
        await releaseUserTypeSlot(req.user.clientId, 'viewer', viewerSlot.consultantId).catch(() => {});
      }
      throw saveErr;
    }
    // ── End quota enforcement ────────────────────────────────────────────────

    logUserCreated(req, viewer).catch(() => {});
    try {
      await saveUserProfileImage(req, viewer);
    } catch (e) {
      console.warn('profile image save skipped:', e.message);
    }

    res.status(201).json({
      message: 'Viewer created successfully',
      viewer: {
        id: viewer._id,
        email: viewer.email,
        userName: viewer.userName,
        viewerPurpose: viewer.viewerPurpose,
        accessControls: viewer.accessControls, // 🆕 return checklist in response
      },
    });
  } catch (error) {
    console.error('Create viewer error:', error);
    res.status(500).json({
      message: 'Failed to create Viewer',
      error: error.message,
    });
  }
};


const parseArrayField = (val) => {
  if (!val) return [];
  if (Array.isArray(val)) return val;

  if (typeof val === "string") {
    // supports: JSON array string OR comma-separated string
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {}

    return val
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return [];
};

const uniqStrings = (arr) => [...new Set((arr || []).map((x) => String(x).trim()).filter(Boolean))];

const uniqObjectIds = (arr) => {
  const cleaned = (arr || []).map((x) => String(x).trim()).filter(Boolean);
  return [...new Set(cleaned)];
};

const findConflictsForArray = (docs, fieldName, targets) => {
  const targetSet = new Set(targets);
  const conflicts = [];

  for (const d of docs || []) {
    const list = Array.isArray(d[fieldName]) ? d[fieldName].map(String) : [];
    const overlap = list.filter((x) => targetSet.has(String(x)));
    if (overlap.length) {
      conflicts.push({
        _id: d._id,
        userName: d.userName,
        userType: d.userType,
        conflicts: overlap,
      });
    }
  }

  return conflicts;
};



/**
 * Create a new Support Manager
 * POST /api/users/create-support-manager
 * Auth: super_admin only
 */
// Create Support Manager (Super Admin only)
/**
 * Create a new Support Manager
 * POST /api/users/create-support-manager
 * Auth: super_admin only
 */
const createSupportManager = async (req, res) => {
  try {
    if (!req.user || req.user.userType !== "super_admin") {
      return res.status(403).json({
        success: false,
        message: "Only Super Admin can create Support Managers",
      });
    }

    const {
      email,
      password,
      contactNumber,
      userName,
      address,
      supportManagerType,
      supportTeamName,

      // ✅ optional assignments
      assignedSupportClients,
      assignedConsultants,
      concurrentLoginLimit,
    } = req.body;

    if (!email || !password || !userName) {
      return res.status(400).json({
        success: false,
        message: "email, password and userName are required",
      });
    }

    // ✅ parse (multipart/form-data can send arrays as strings)
    const clientIds = uniqStrings(parseArrayField(assignedSupportClients));
    const consultantIds = uniqObjectIds(parseArrayField(assignedConsultants));

    // ✅ Validate consultant ids format
    const invalidConsultantIds = consultantIds.filter(
      (id) => !mongoose.Types.ObjectId.isValid(id)
    );
    if (invalidConsultantIds.length) {
      return res.status(400).json({
        success: false,
        message: "Invalid consultant ids in assignedConsultants",
        meta: { invalidConsultantIds },
      });
    }

    const existingUser = await User.findOne({ $or: [{ email }, { userName }] });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "Email or Username already exists",
      });
    }

    // =========================
    // ✅ 1) Existence checks
    // =========================
    if (clientIds.length) {
      const foundClients = await Client.find({ clientId: { $in: clientIds } })
        .select("clientId")
        .lean();

      const foundSet = new Set(foundClients.map((c) => c.clientId));
      const missingClientIds = clientIds.filter((c) => !foundSet.has(c));

      if (missingClientIds.length) {
        return res.status(404).json({
          success: false,
          message:
            "Some clientIds in assignedSupportClients were not found in Client collection",
          meta: { missingClientIds },
        });
      }
    }

    let foundConsultants = [];
    if (consultantIds.length) {
      foundConsultants = await User.find({
        _id: { $in: consultantIds },
        isActive: true,
        userType: { $in: ["consultant", "consultant_admin"] },
      })
        .select("_id userType userName email")
        .lean();

      const foundSet = new Set(foundConsultants.map((u) => String(u._id)));
      const missingConsultantIds = consultantIds.filter(
        (id) => !foundSet.has(String(id))
      );

      if (missingConsultantIds.length) {
        return res.status(404).json({
          success: false,
          message:
            "Some ids in assignedConsultants were not found (or not active consultant/consultant_admin)",
          meta: { missingConsultantIds },
        });
      }
    }

    // =========================
    // ✅ 2) Duplicate assignment checks
    // (block if already assigned to another active supportManager/support user)
    // =========================
    if (clientIds.length) {
      const holders = await User.find({
        isActive: true,
        userType: { $in: ["supportManager", "support"] },
        assignedSupportClients: { $in: clientIds },
      })
        .select("_id userName userType assignedSupportClients")
        .lean();

      const conflicts = findConflictsForArray(
        holders,
        "assignedSupportClients",
        clientIds
      );

      if (conflicts.length) {
        return res.status(409).json({
          success: false,
          message:
            "Some clients are already assigned to another support manager/support user",
          meta: { conflicts },
        });
      }
    }

    if (consultantIds.length) {
      const holders = await User.find({
        isActive: true,
        userType: { $in: ["supportManager", "support"] },
        assignedConsultants: { $in: consultantIds },
      })
        .select("_id userName userType assignedConsultants")
        .lean();

      const conflicts = findConflictsForArray(
        holders,
        "assignedConsultants",
        consultantIds
      );

      if (conflicts.length) {
        return res.status(409).json({
          success: false,
          message:
            "Some consultants are already assigned to another support manager/support user",
          meta: { conflicts },
        });
      }
    }

    // =========================
    // ✅ 3) Create manager
    // =========================
    const hashedPassword = bcrypt.hashSync(password, 10);

    const supportManager = new User({
      email,
      password: hashedPassword,
      contactNumber,
      userName,
      userType: "supportManager",
      address,
      isActive: true,
      supportManagerType,
      supportTeamName,

      // ✅ store assignments
      assignedSupportClients: clientIds,
      assignedConsultants: consultantIds,
      concurrentLoginLimit,

      createdBy: req.user?._id || req.user?.id || req.user?.userId,
    });

    await supportManager.save();
    logUserCreated(req, supportManager).catch(() => {});
    // ✅ 3A) Welcome notification (account created)
    try {
      await notifySupportManagerWelcome({ actor: req.user, supportManager, tempPassword: password, email  });
    } catch (e) {
      console.error("[USER CONTROLLER] welcome notif failed:", e.message);
    }

    // =========================
    // ✅ 4) Sync to Client + Consultant docs
    // =========================
    let clientsUpdated = 0;
    let consultantsUpdated = 0;

    if (clientIds.length) {
      const up = await Client.updateMany(
        { clientId: { $in: clientIds } },
        {
          $set: {
            supportManagerId: supportManager._id,
            "supportInfo.supportManagerId": supportManager._id,
            "supportInfo.supportTeamName": supportManager.supportTeamName || "",
            "supportInfo.supportManagerType": supportManager.supportManagerType || "",
          },
        }
      );
      clientsUpdated = up?.modifiedCount ?? up?.nModified ?? 0;
    }

    if (consultantIds.length) {
      const up = await User.updateMany(
        { _id: { $in: consultantIds } },
        {
          $set: {
            supportManagerId: supportManager._id,
            "supportInfo.supportManagerId": supportManager._id,
            "supportInfo.supportTeamName": supportManager.supportTeamName || "",
          },
        }
      );
      consultantsUpdated = up?.modifiedCount ?? up?.nModified ?? 0;
    }

    // ✅ 4A) Assignments notification (only if any assignments were provided)
    if (clientIds.length || consultantIds.length) {
      try {
        await notifySupportManagerAssignmentsUpdated({
          actor: req.user,
          supportManager,
          clientsAdded: clientIds,
          consultantsAdded: consultantIds,
        });
      } catch (e) {
        console.error("[USER CONTROLLER] assignment notif failed:", e.message);
      }
    }

    // ✅ Profile Image Upload (S3)
    let imageUploadResult = { success: false, error: null };
    if (req.file) {
      try {
        await saveUserProfileImage(req, supportManager);
        imageUploadResult.success = true;
      } catch (e) {
        imageUploadResult.error = e.message;
      }
    }

    return res.status(201).json({
      success: true,
      message: "Support Manager created successfully",
      supportManager: {
        id: supportManager._id,
        email: supportManager.email,
        userName: supportManager.userName,
        supportManagerType: supportManager.supportManagerType || null,
        supportTeamName: supportManager.supportTeamName || null,
        assignedSupportClients: supportManager.assignedSupportClients || [],
        assignedConsultants: supportManager.assignedConsultants || [],
        profileImage: supportManager.profileImage || null,
        concurrentLoginLimit: supportManager.concurrentLoginLimit || null,
      },
      sync: {
        clientsUpdated,
        consultantsUpdated,
      },
      imageUpload: imageUploadResult,
    });
  } catch (error) {
    console.error("[USER CONTROLLER] Error creating support manager:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create support manager",
      error: error.message,
    });
  }
};



/**
 * Create a new Support User
 * POST /api/users/create-support
 * Auth: supportManager or super_admin
 */
const createSupport = async (req, res) => {
  try {
    if (!req.user || !["super_admin", "supportManager"].includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: "Only Super Admin or Support Manager can create support users",
      });
    }

    const {
      email,
      password,
      contactNumber,
      userName,
      address,
      specialization,
      supportJobRole,
      supportManagerId, // super_admin only

      // ✅ optional assignments
      assignedSupportClients,
      assignedConsultants,
      concurrentLoginLimit,
    } = req.body;

    if (!email || !password || !userName) {
      return res.status(400).json({
        success: false,
        message: "email, password and userName are required",
      });
    }

    const existingUser = await User.findOne({ $or: [{ email }, { userName }] });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "Email or Username already exists",
      });
    }

    const currentUserId = req.user?._id || req.user?.id || req.user?.userId;

    // Determine assigned manager
    let assignedSupportManagerId = null;
    if (req.user.userType === "supportManager") {
      assignedSupportManagerId = currentUserId;
    } else {
      if (!supportManagerId) {
        return res.status(400).json({
          success: false,
          message: "supportManagerId is required when created by super_admin",
        });
      }
      assignedSupportManagerId = supportManagerId;
    }

    const supportManager = await User.findOne({
      _id: assignedSupportManagerId,
      userType: "supportManager",
      isActive: true,
    });

    if (!supportManager) {
      return res.status(404).json({
        success: false,
        message: "Support manager not found or inactive",
      });
    }

    // ✅ parse assignment arrays
    const clientIds = uniqStrings(parseArrayField(assignedSupportClients));
    const consultantIds = uniqObjectIds(parseArrayField(assignedConsultants));

    // ✅ validate consultant ids format
    const invalidConsultantIds = consultantIds.filter((id) => !mongoose.Types.ObjectId.isValid(id));
    if (invalidConsultantIds.length) {
      return res.status(400).json({
        success: false,
        message: "Invalid consultant ids in assignedConsultants",
        meta: { invalidConsultantIds },
      });
    }

    // ✅ existence checks
    if (clientIds.length) {
      const foundClients = await Client.find({ clientId: { $in: clientIds } }).select("clientId").lean();
      const foundSet = new Set(foundClients.map((c) => c.clientId));
      const missingClientIds = clientIds.filter((c) => !foundSet.has(c));
      if (missingClientIds.length) {
        return res.status(404).json({
          success: false,
          message: "Some clientIds in assignedSupportClients were not found in Client collection",
          meta: { missingClientIds },
        });
      }
    }

    if (consultantIds.length) {
      const found = await User.find({
        _id: { $in: consultantIds },
        isActive: true,
        userType: { $in: ["consultant", "consultant_admin"] },
      }).select("_id").lean();

      const foundSet = new Set(found.map((u) => String(u._id)));
      const missingConsultantIds = consultantIds.filter((id) => !foundSet.has(String(id)));
      if (missingConsultantIds.length) {
        return res.status(404).json({
          success: false,
          message: "Some ids in assignedConsultants were not found (or not active consultant/consultant_admin)",
          meta: { missingConsultantIds },
        });
      }
    }

    // ✅ duplicate assignment checks (block if already assigned to OTHER active support/supportManager)
    if (clientIds.length) {
      const holders = await User.find({
        isActive: true,
        userType: { $in: ["supportManager", "support"] },
        assignedSupportClients: { $in: clientIds },
      }).select("_id userName userType assignedSupportClients").lean();

      // allow same manager record only? (support user is new, so no allow needed)
      const conflicts = findConflictsForArray(holders, "assignedSupportClients", clientIds);
      if (conflicts.length) {
        return res.status(409).json({
          success: false,
          message: "Some clients are already assigned to another support manager/support user",
          meta: { conflicts },
        });
      }
    }

    if (consultantIds.length) {
      const holders = await User.find({
        isActive: true,
        userType: { $in: ["supportManager", "support"] },
        assignedConsultants: { $in: consultantIds },
      }).select("_id userName userType assignedConsultants").lean();

      const conflicts = findConflictsForArray(holders, "assignedConsultants", consultantIds);
      if (conflicts.length) {
        return res.status(409).json({
          success: false,
          message: "Some consultants are already assigned to another support manager/support user",
          meta: { conflicts },
        });
      }
    }

    const hashedPassword = bcrypt.hashSync(password, 10);

    const supportUser = new User({
      email,
      password: hashedPassword,
      contactNumber,
      userName,
      userType: "support",
      address,
      isActive: true,
      specialization,
      supportJobRole,

      supportManagerId: supportManager._id,
      supportTeamName: supportManager.supportTeamName || "",

      // ✅ store assignments
      assignedSupportClients: clientIds,
      assignedConsultants: consultantIds,
      concurrentLoginLimit,

      createdBy: currentUserId,

      // ✅ FIX: parentUser should always be the support manager for team mapping
      parentUser: supportManager._id,
    });

    await supportUser.save();
    logUserCreated(req, supportUser).catch(() => {});

    try {
  await notifySupportUserWelcome({ actor: req.user, supportUser, supportManager,tempPassword: password, email  });
} catch (e) {
  console.error("[USER CONTROLLER] support welcome notif failed:", e.message);
}


    // ✅ sync to Client + Consultant docs
    let clientsUpdated = 0;
    let consultantsUpdated = 0;

    if (clientIds.length) {
      const up = await Client.updateMany(
        { clientId: { $in: clientIds } },
        {
          $set: {
            supportUserId: supportUser._id,
            "supportInfo.supportUserId": supportUser._id,
            supportManagerId: supportManager._id,
            "supportInfo.supportManagerId": supportManager._id,
            "supportInfo.supportTeamName": supportManager.supportTeamName || "",
          },
        }
      );
      clientsUpdated = up?.modifiedCount ?? up?.nModified ?? 0;
    }

    if (consultantIds.length) {
      const up = await User.updateMany(
        { _id: { $in: consultantIds } },
        {
          $set: {
            supportUserId: supportUser._id,
            "supportInfo.supportUserId": supportUser._id,
            supportManagerId: supportManager._id,
            "supportInfo.supportManagerId": supportManager._id,
            "supportInfo.supportTeamName": supportManager.supportTeamName || "",
          },
        }
      );
      consultantsUpdated = up?.modifiedCount ?? up?.nModified ?? 0;
    }

    // ✅ Profile Image Upload (S3)
    let imageUploadResult = { success: false, error: null };
    if (req.file) {
      try {
        await saveUserProfileImage(req, supportUser);
        imageUploadResult.success = true;
      } catch (e) {
        imageUploadResult.error = e.message;
      }
    }

    return res.status(201).json({
      success: true,
      message: "Support user created successfully",
      supportUser: {
        id: supportUser._id,
        email: supportUser.email,
        userName: supportUser.userName,
        userType: supportUser.userType,
        supportManagerId: supportUser.supportManagerId,
        supportTeamName: supportUser.supportTeamName,
        assignedSupportClients: supportUser.assignedSupportClients || [],
        assignedConsultants: supportUser.assignedConsultants || [],
        profileImage: supportUser.profileImage || null,
        concurrentLoginLimit: supportUser.concurrentLoginLimit || null,
      },
      sync: {
        clientsUpdated,
        consultantsUpdated,
      },
      imageUpload: imageUploadResult,
    });
  } catch (error) {
    console.error("[USER CONTROLLER] Error creating support user:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create support user",
      error: error.message,
    });
  }
};



const getCurrentUserId = (req) =>
  (req.user?._id || req.user?.id || req.user?.userId || "").toString();

const toBool = (val, defaultVal = true) => {
  if (val === undefined || val === null) return defaultVal;
  if (typeof val === "boolean") return val;
  const s = String(val).toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return defaultVal;
};

/**
 * Get all support team members for a support manager
 * GET /api/users/support-team
 * Auth: supportManager (own team) or super_admin (any team)
 */
const getSupportTeam = async (req, res) => {
  try {
    if (!["supportManager", "super_admin"].includes(req.user.userType)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    let managerId;
    if (req.user.userType === "supportManager") {
      managerId = getCurrentUserId(req); // ✅ safe
    } else {
      managerId = req.query.supportManagerId;
      if (!managerId) {
        return res.status(400).json({
          success: false,
          message: "supportManagerId query parameter required for super_admin",
        });
      }
    }

    const manager = await User.findOne({
      _id: managerId,
      userType: "supportManager",
      isActive: true,
    }).select("userName supportTeamName supportManagerType");

    if (!manager) {
      return res.status(404).json({ success: false, message: "Support manager not found" });
    }

    const teamMembers = await User.find({
      supportManagerId: managerId,
      userType: "support",
      isActive: true,
    })
      .select("-password")
      .sort({ userName: 1 });

    return res.status(200).json({
      success: true,
      manager,
      teamMembers,
      statistics: {
        totalMembers: teamMembers.length,
      },
    });
  } catch (error) {
    console.error("[USER CONTROLLER] Error getting support team:", error);
    return res.status(500).json({
      success: false,
      message: "Error getting support team",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};


/**
 * Change the support manager for a support user (transfer to different team)
 * PATCH /api/users/:supportUserId/change-support-manager
 * Body: { newSupportManagerId, reason }
 * Auth: supportManager (from team) or super_admin
 */
const changeSupportUserManager = async (req, res) => {
  try {
    const { supportUserId } = req.params;
    const { newSupportManagerId, reason } = req.body;

    if (!["supportManager", "super_admin"].includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: "Only support managers or super admins can transfer support users",
      });
    }

    if (!newSupportManagerId) {
      return res.status(400).json({ success: false, message: "newSupportManagerId is required" });
    }

    if (!mongoose.Types.ObjectId.isValid(newSupportManagerId)) {
      return res.status(400).json({ success: false, message: "Invalid newSupportManagerId" });
    }

    if (!mongoose.Types.ObjectId.isValid(supportUserId)) {
      return res.status(400).json({ success: false, message: "Invalid supportUserId" });
    }

    const supportUser = await User.findById(supportUserId);
    if (!supportUser || supportUser.userType !== "support") {
      return res.status(404).json({ success: false, message: "Support user not found" });
    }

    if (!supportUser.supportManagerId) {
      return res.status(400).json({
        success: false,
        message: "Support user has no current supportManagerId set; cannot transfer.",
      });
    }

    // ✅ SupportManager can transfer only from own team
    if (req.user.userType === "supportManager") {
      const currentUserId = getCurrentUserId(req);
      if (String(supportUser.supportManagerId) !== String(currentUserId)) {
        return res.status(403).json({
          success: false,
          message: "You can only transfer members from your own team",
        });
      }
    }

    const newSupportManager = await User.findOne({
      _id: newSupportManagerId,
      userType: "supportManager",
      isActive: true,
    }).select("_id userName supportTeamName supportManagerType email");

    if (!newSupportManager) {
      return res.status(404).json({
        success: false,
        message: "New support manager not found or inactive",
      });
    }

    if (String(supportUser.supportManagerId) === String(newSupportManagerId)) {
      return res.status(400).json({
        success: false,
        message: "Support user is already in this team",
      });
    }

    const oldManagerId = supportUser.supportManagerId;

    supportUser.supportManagerId = newSupportManagerId;
    supportUser.parentUser = newSupportManagerId;
    supportUser.supportManagerType = newSupportManager.supportManagerType; // optional
    supportUser.supportTeamName = newSupportManager.supportTeamName || ""; // ✅ keep consistent
    supportUser.updatedAt = new Date();

    await supportUser.save();

    console.log(
      `[USER CONTROLLER] Support user transferred: ${supportUser.userName} from ${oldManagerId} to ${newSupportManagerId}. Reason: ${reason || "N/A"}`
    );

    // ✅ Notifications: new manager + support user (and optional old manager)
    try {
      await notifySupportUserTransferredToManager({
        actor: req.user,
        supportUser,
        oldManagerId,
        newSupportManager,
        reason,
      });
    } catch (e) {
      console.error("[USER CONTROLLER] transfer notif failed:", e.message);
    }

    return res.status(200).json({
      success: true,
      message: "Support user transferred successfully",
      supportUser: {
        _id: supportUser._id,
        userName: supportUser.userName,
        email: supportUser.email,
        oldSupportManagerId: oldManagerId,
        newSupportManagerId,
        reason: reason || null,
      },
      newSupportManager,
    });
  } catch (error) {
    console.error("[USER CONTROLLER] Error changing support user manager:", error);
    return res.status(500).json({
      success: false,
      message: "Error changing support user manager",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};


/**
 * Get all support managers with statistics
 * GET /api/users/support-managers
 * Auth: super_admin | supportManager | consultant_admin | consultant
 */
const getAllSupportManagers = async (req, res) => {
  try {
    const allowedTypes = ["super_admin", "supportManager", "consultant_admin", "consultant"];
    if (!req.user || !allowedTypes.includes(req.user.userType)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const {
      supportManagerType,
      search,
      isActive = "true",
      page = 1,
      limit = 20,
    } = req.query;

    const activeBool = toBool(isActive, true);
    const currentUserId = getCurrentUserId(req);

    // Build query safely using $and so we can combine role restrictions + search filters
    const andConditions = [
      { userType: "supportManager", isActive: activeBool },
    ];

    // Consultant-side users: ONLY their support managers (general_support OR assigned consultant_support)
    if (["consultant_admin", "consultant"].includes(req.user.userType)) {
      const supportManagerIdFromUser =
        req.user.supportManagerId || req.user?.supportInfo?.supportManagerId || null;

      const orConditions = [
        { supportManagerType: "general_support" },
        { supportManagerType: "consultant_support", assignedConsultants: currentUserId },
        { supportManagerType: "client_support" },
      ];

      // Optional fallback if you sync consultant -> supportManagerId (your createSupportManager does this)
      if (supportManagerIdFromUser) {
        orConditions.push({ _id: supportManagerIdFromUser });
      }

      andConditions.push({ $or: orConditions });

      // Restrict to visible support manager types for consultant-side users
      andConditions.push({ supportManagerType: { $in: ["general_support", "consultant_support", "client_support"] } });
    }

    // Optional filter
    if (supportManagerType) {
      andConditions.push({ supportManagerType });
    }

    // Search filter
    if (search && String(search).trim()) {
      const regex = new RegExp(String(search).trim(), "i");
      andConditions.push({
        $or: [
          { userName: regex },
          { email: regex },
          { contactNumber: regex },
          { supportTeamName: regex },
          { address: regex },
          { companyName: regex },
          { supportManagerType: regex },
        ],
      });
    }

    const query = andConditions.length === 1 ? andConditions[0] : { $and: andConditions };

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    const [supportManagers, totalCount] = await Promise.all([
      User.find(query)
        .select("-password")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      User.countDocuments(query),
    ]);

    // Efficient member counts (avoid N+1 queries)
    const managerIds = supportManagers.map((m) => m._id);
    const countMap = {};

    if (managerIds.length) {
      const counts = await User.aggregate([
        {
          $match: {
            userType: "support",
            isActive: true,
            supportManagerId: { $in: managerIds },
          },
        },
        { $group: { _id: "$supportManagerId", count: { $sum: 1 } } },
      ]);

      counts.forEach((c) => {
        countMap[String(c._id)] = c.count;
      });
    }

    const managersWithStats = supportManagers.map((manager) => ({
      ...manager.toObject(), // ✅ fixed (was `.manager.toObject()` which crashes)
      teamMemberCount: countMap[String(manager._id)] || 0,
    }));

    return res.status(200).json({
      success: true,
      supportManagers: managersWithStats,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(totalCount / limitNum),
        totalCount,
        limit: limitNum,
      },
    });
  } catch (error) {
    console.error("[USER CONTROLLER] Error fetching support managers:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching support managers",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};


/**
 * Get all support users
 * GET /api/users/support-users
 * Auth: super_admin | supportManager | consultant_admin | consultant
 */
const getAllSupportUsers = async (req, res) => {
  try {
    const allowedTypes = ["super_admin", "supportManager", "consultant_admin", "consultant"];
    if (!req.user || !allowedTypes.includes(req.user.userType)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const {
      supportManagerId,
      specialization,
      search,
      isActive = "true",
      page = 1,
      limit = 20,
    } = req.query;

    const activeBool = toBool(isActive, true);
    const currentUserId = getCurrentUserId(req);

    const andConditions = [
      { userType: "support", isActive: activeBool },
    ];

    // SupportManager: only their own team
    if (req.user.userType === "supportManager") {
      andConditions.push({ supportManagerId: currentUserId });
    }

    // Consultant-side: only support users under their support manager(s)
    if (["consultant_admin", "consultant"].includes(req.user.userType)) {
      const supportManagerIdFromUser =
        req.user.supportManagerId || req.user?.supportInfo?.supportManagerId || null;

      const managerMatchOr = [
        { supportManagerType: "general_support" },
        { supportManagerType: "consultant_support", assignedConsultants: currentUserId },
      ];

      if (supportManagerIdFromUser) {
        managerMatchOr.push({ _id: supportManagerIdFromUser });
      }

      const allowedManagers = await User.find({
        userType: "supportManager",
        isActive: true,
        supportManagerType: { $in: ["general_support", "consultant_support"] },
        $or: managerMatchOr,
      }).select("_id");

      const allowedManagerIds = allowedManagers.map((m) => m._id);

      // If no support manager is linked, return empty (don’t leak anything)
      if (!allowedManagerIds.length) {
        return res.status(200).json({
          success: true,
          supportUsers: [],
          pagination: {
            currentPage: 1,
            totalPages: 0,
            totalCount: 0,
            limit: Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100),
          },
        });
      }

      // If they request a specific managerId, enforce it is within allowed list
      if (supportManagerId) {
        const ok = allowedManagerIds.some((id) => String(id) === String(supportManagerId));
        if (!ok) {
          return res.status(403).json({ success: false, message: "Access denied" });
        }
        andConditions.push({ supportManagerId });
      } else {
        andConditions.push({ supportManagerId: { $in: allowedManagerIds } });
      }
    }

    // Super admin: optional filter by supportManagerId
    if (req.user.userType === "super_admin" && supportManagerId) {
      andConditions.push({ supportManagerId });
    }

    // specialization is an ARRAY in DB, so use $in
    if (specialization && String(specialization).trim()) {
      const specs = String(specialization)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (specs.length) {
        andConditions.push({ supportSpecialization: { $in: specs } });
      }
    }

    if (search && String(search).trim()) {
      const regex = new RegExp(String(search).trim(), "i");
      andConditions.push({
        $or: [
          { userName: regex },
          { email: regex },
          { contactNumber: regex },
          { address: regex },
          { supportEmployeeId: regex },
          { supportJobRole: regex },
          { supportBranch: regex },
        ],
      });
    }

    const query = andConditions.length === 1 ? andConditions[0] : { $and: andConditions };

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    const [supportUsers, totalCount] = await Promise.all([
      User.find(query)
        .select("-password")
        .populate("supportManagerId", "userName supportTeamName supportManagerType")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      User.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      supportUsers,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(totalCount / limitNum),
        totalCount,
        limit: limitNum,
      },
    });
  } catch (error) {
    console.error("[USER CONTROLLER] Error fetching support users:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching support users",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};




// =======================================================
// DELETE SUPPORT MANAGER (Super Admin only)
// Mandatory: transfer support users to another manager
// Optional: transfer assignedSupportClients/assignedConsultants too
// =======================================================
const deleteSupportManager = async (req, res) => {
  try {
    const { supportManagerId } = req.params;
    const { transferToSupportManagerId, reason } = req.body;

    const currentUserId = req.user?._id || req.user?.id || req.user?.userId;

    if (!mongoose.Types.ObjectId.isValid(supportManagerId)) {
      return res.status(400).json({ success: false, message: "Invalid supportManagerId" });
    }

    if (!req.user || req.user.userType !== "super_admin") {
      return res.status(403).json({
        success: false,
        message: "Only super_admin can delete support managers",
      });
    }

    // Prevent self-delete
    if (String(supportManagerId) === String(currentUserId)) {
      return res.status(400).json({
        success: false,
        message: "You cannot delete your own account",
      });
    }

    const manager = await User.findOne({
      _id: supportManagerId,
      userType: "supportManager",
      isActive: true,
    });

    if (!manager) {
      return res.status(404).json({
        success: false,
        message: "Support manager not found or already inactive",
      });
    }

    // Count active team members
    const teamCount = await User.countDocuments({
      userType: "support",
      isActive: true,
      supportManagerId: manager._id,
    });

    // ✅ Mandatory transfer if there are team members
    if (teamCount > 0 && !transferToSupportManagerId) {
      return res.status(400).json({
        success: false,
        message:
          "transferToSupportManagerId is required because this support manager has active support users",
        meta: { teamCount },
      });
    }

    // ✅ NEW: strict validation when transferToSupportManagerId is provided (or required)
    let newManager = null;
    const needsTransfer = teamCount > 0;

    if (transferToSupportManagerId) {
      if (!mongoose.Types.ObjectId.isValid(transferToSupportManagerId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid transferToSupportManagerId",
        });
      }

      if (String(transferToSupportManagerId) === String(manager._id)) {
        return res.status(400).json({
          success: false,
          message: "transferToSupportManagerId cannot be the same as the deleted manager",
        });
      }

      // ✅ MUST check DB presence
      newManager = await User.findOne({
        _id: transferToSupportManagerId,
        userType: "supportManager",
        isActive: true,
      });

      if (!newManager) {
        return res.status(404).json({
          success: false,
          message: "Transfer support manager not found or inactive",
          meta: { transferToSupportManagerId },
        });
      }
    } else if (needsTransfer) {
      // ✅ defensive: if transfer is needed but id missing (already checked above, but keeps it safe)
      return res.status(400).json({
        success: false,
        message: "transferToSupportManagerId is required for transferring team members",
        meta: { teamCount },
      });
    }

    // -----------------------------
    // Capture team members BEFORE transfer (for notifications)
    // -----------------------------
    let movedSupportUserIds = [];
    if (teamCount > 0) {
      const teamUsers = await User.find({
        userType: "support",
        isActive: true,
        supportManagerId: manager._id,
      }).select("_id").lean();

      movedSupportUserIds = teamUsers.map((u) => String(u._id));
    }

    // -----------------------------
    // Transfer Team Members
    // -----------------------------
    let movedUsers = 0;

    if (teamCount > 0 && newManager) {
      const updateRes = await User.updateMany(
        { userType: "support", isActive: true, supportManagerId: manager._id },
        {
          $set: {
            supportManagerId: newManager._id,
            parentUser: newManager._id,
            supportTeamName: newManager.supportTeamName || "",
            updatedAt: new Date(),
          },
        }
      );

      movedUsers = updateRes?.modifiedCount || updateRes?.nModified || 0;
    }

    // -----------------------------
    // Transfer Assigned Clients/Consultants (if any)
    // -----------------------------
    let transferredClientCount = 0;
    let transferredConsultantCount = 0;

    if (newManager) {
      const oldClients = Array.isArray(manager.assignedSupportClients)
        ? manager.assignedSupportClients
        : [];
      const oldConsultants = Array.isArray(manager.assignedConsultants)
        ? manager.assignedConsultants
        : [];

      if (oldClients.length || oldConsultants.length) {
        await User.updateOne(
          { _id: newManager._id },
          {
            ...(oldClients.length
              ? { $addToSet: { assignedSupportClients: { $each: oldClients } } }
              : {}),
            ...(oldConsultants.length
              ? { $addToSet: { assignedConsultants: { $each: oldConsultants } } }
              : {}),
          }
        );
      }

      transferredClientCount = oldClients.length;
      transferredConsultantCount = oldConsultants.length;
    }

    // -----------------------------
    // Soft delete manager
    // -----------------------------
    manager.isActive = false;
    manager.updatedAt = new Date();
    // manager.deletionReason = reason;

    await manager.save();

    // -----------------------------
    // ✅ Notifications (email + in-app)
    // -----------------------------
    try {
      await notifySupportManagerDeleted({
        actor: { ...req.user, reason },
        deletedManager: manager,
        transferToManager: newManager,
        movedSupportUsers: movedSupportUserIds, // ✅ real IDs (not empty)
      });
    } catch (e) {
      console.error("[USER CONTROLLER] delete manager notif failed:", e.message);
    }

    return res.status(200).json({
      success: true,
      message: "Support manager deleted successfully",
      meta: {
        deletedSupportManagerId: manager._id,
        teamCountBeforeDelete: teamCount,
        movedUsers,
        movedSupportUserIds, // ✅ useful for frontend/admin logs
        transferToSupportManagerId: newManager ? newManager._id : null,
        transferredClientCount,
        transferredConsultantCount,
        reason: reason || null,
      },
    });
  } catch (error) {
    console.error("[USER CONTROLLER] deleteSupportManager error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete support manager",
      error: error.message,
    });
  }
};


// =======================================================
// DELETE SUPPORT USER (SupportManager who owns them OR super_admin)
// Mandatory: transfer assignedSupportClients to another support user
// =======================================================
const deleteSupportUser = async (req, res) => {
  try {
    const { supportUserId } = req.params;
    const { transferToSupportUserId, reason } = req.body;

    const currentUserId = req.user?._id || req.user?.id || req.user?.userId;

    if (!mongoose.Types.ObjectId.isValid(supportUserId)) {
      return res.status(400).json({ success: false, message: "Invalid supportUserId" });
    }

    if (!req.user || !["supportManager", "super_admin"].includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: "Only supportManager or super_admin can delete support users",
      });
    }

    const supportUser = await User.findOne({
      _id: supportUserId,
      userType: "support",
      isActive: true,
    });

    if (!supportUser) {
      return res.status(404).json({
        success: false,
        message: "Support user not found or already inactive",
      });
    }

    // Prevent deleting self
    if (String(supportUser._id) === String(currentUserId)) {
      return res.status(400).json({
        success: false,
        message: "You cannot delete your own account",
      });
    }

    // If supportManager is deleting: must own that support user
    if (req.user.userType === "supportManager") {
      if (!supportUser.supportManagerId) {
        return res.status(403).json({
          success: false,
          message: "This support user has no supportManagerId; only super_admin can delete",
        });
      }

      if (String(supportUser.supportManagerId) !== String(currentUserId)) {
        return res.status(403).json({
          success: false,
          message: "You can delete only support users in your own team",
        });
      }
    }

    const clientsToTransfer = Array.isArray(supportUser.assignedSupportClients)
      ? supportUser.assignedSupportClients
      : [];

    // Mandatory transfer if the user has assigned clients
    if (clientsToTransfer.length > 0 && !transferToSupportUserId) {
      return res.status(400).json({
        success: false,
        message:
          "transferToSupportUserId is required because this support user has assignedSupportClients",
        meta: { assignedSupportClientsCount: clientsToTransfer.length },
      });
    }

    let transferee = null;
    if (transferToSupportUserId) {
      // ✅ 1) Validate ObjectId format
      if (!mongoose.Types.ObjectId.isValid(transferToSupportUserId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid transferToSupportUserId",
          meta: { transferToSupportUserId },
        });
      }

      // ✅ 2) Can't transfer to the same user
      if (String(transferToSupportUserId) === String(supportUser._id)) {
        return res.status(400).json({
          success: false,
          message: "transferToSupportUserId cannot be the same as the deleted support user",
        });
      }

      // ✅ 3) Check DB existence (found vs inactive)
      const transfereeAny = await User.findOne({
        _id: transferToSupportUserId,
        userType: "support",
      });

      if (!transfereeAny) {
        return res.status(404).json({
          success: false,
          message: "Transfer support user not found",
          meta: { transferToSupportUserId },
        });
      }

      if (!transfereeAny.isActive) {
        return res.status(400).json({
          success: false,
          message: "Transfer support user is inactive",
          meta: { transferToSupportUserId },
        });
      }

      transferee = transfereeAny;

      // ✅ 4) Enforce same team if deleted by supportManager
      if (req.user.userType === "supportManager") {
        if (
          !transferee.supportManagerId ||
          String(transferee.supportManagerId) !== String(currentUserId)
        ) {
          return res.status(400).json({
            success: false,
            message: "Transfer support user must be in your team",
          });
        }
      }
    }

    // -----------------------------
    // Transfer assignedSupportClients
    // -----------------------------
    let transferredCount = 0;

    if (transferee && clientsToTransfer.length > 0) {
      await User.updateOne(
        { _id: transferee._id },
        { $addToSet: { assignedSupportClients: { $each: clientsToTransfer } } }
      );

      // Clear from deleted user
      supportUser.assignedSupportClients = [];
      transferredCount = clientsToTransfer.length;

      // Optional: Update Client collection if you store assignedSupportUserId there
      // await Client.updateMany(
      //   { "supportInfo.assignedSupportUserId": supportUser._id },
      //   { $set: { "supportInfo.assignedSupportUserId": transferee._id } }
      // );
    }

    // -----------------------------
    // Soft delete support user
    // -----------------------------
    supportUser.isActive = false;
    supportUser.updatedAt = new Date();
    // supportUser.deletionReason = reason;

    await supportUser.save();

    // -----------------------------
    // ✅ Notifications (email + in-app)
    // -----------------------------
    try {
      await notifySupportUserDeleted({
        actor: { ...req.user, reason },
        deletedSupportUser: supportUser,
        transferToSupportUser: transferee,
        transferredClientIds: clientsToTransfer,
      });
    } catch (e) {
      console.error("[USER CONTROLLER] delete support notif failed:", e.message);
    }

    return res.status(200).json({
      success: true,
      message: "Support user deleted successfully",
      meta: {
        deletedSupportUserId: supportUser._id,
        transferToSupportUserId: transferee ? transferee._id : null,
        transferredCount,
        transferredClientIds: clientsToTransfer, // ✅ useful for logs/audit
        reason: reason || null,
      },
    });
  } catch (error) {
    console.error("[USER CONTROLLER] deleteSupportUser error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete support user",
      error: error.message,
    });
  }
};



// ===============================================
// PROFILE IMAGE NORMALIZER (S3 + Legacy Safe)
// ===============================================
const normalizeUserProfile = (u) => {
  if (!u) return null;

  const BASE = process.env.SERVER_BASE_URL?.replace(/\/+$/, '');

  // If S3 url exists → keep it
  if (u.profileImage?.url) return u;

  // If legacy local path exists → convert to URL
  if (u.profileImage?.path && BASE) {
    u.profileImage.url = `${BASE}/${u.profileImage.path.replace(/\\/g, '/')}`;
  }

  return u;
};

// ===============================================
// GET MY PROFILE (Logged in user)
// GET /api/users/me
// ===============================================
const getMyProfile = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;

    const user = await User.findById(userId)
      .select("-password")
      .populate("createdBy", "userName email profileImage")
      .populate("parentUser", "userName email profileImage")
      .populate("consultantAdminId", "userName email profileImage")
      .populate("employeeHeadId", "userName email profileImage")
      .lean();

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Normalize all profile images
    user.createdBy = normalizeUserProfile(user.createdBy);
    user.parentUser = normalizeUserProfile(user.parentUser);
    user.consultantAdminId = normalizeUserProfile(user.consultantAdminId);
    user.employeeHeadId = normalizeUserProfile(user.employeeHeadId);
    normalizeUserProfile(user);

    res.status(200).json({
      success: true,
      user
    });

  } catch (error) {
    console.error("Get my profile error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch profile",
      error: error.message
    });
  }
};


// ===============================================
// GET USER BY ID (Hierarchy enforced)
// GET /api/users/:userId
// ===============================================
const getUserById = async (req, res) => {
  try {
    const { userId } = req.params;

    // ✅ Avoid CastError + return proper client error
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid userId",
      });
    }

    let baseQuery = {};

    switch (req.user.userType) {
      case "super_admin":
        break;

      case "consultant_admin": {
        // ── Source of truth: Client collection ──────────────────────────────
        // A consultant_admin has authority over a client when ANY of these is true:
        //   (a) client.leadInfo.consultantAdminId === this admin
        //   (b) client.leadInfo.createdBy         === this admin
        //   (c) a consultant under this admin is currently assigned to the client
        //       (leadInfo.assignedConsultantId OR workflowTracking.assignedConsultantId
        //        OR any active consultantHistory entry)
        //
        // We also fall back to User.assignedClients as a supplemental source
        // in case some clients were assigned via a different flow.
        // ────────────────────────────────────────────────────────────────────

        const adminId = req.user.id;

        // Get all consultants under this admin
        const myConsultants = await User.find({
          consultantAdminId: adminId,
          userType: "consultant",
        }).select("_id").lean();
        const myConsultantIds = myConsultants.map((c) => String(c._id));

        // Find all clients this admin has authority over (from Client collection)
        const authorisedClients = await Client.find({
          $or: [
            { "leadInfo.consultantAdminId": adminId },
            { "leadInfo.createdBy": adminId },
            { "leadInfo.assignedConsultantId": { $in: myConsultantIds } },
            { "workflowTracking.assignedConsultantId": { $in: myConsultantIds } },
            {
              "leadInfo.consultantHistory": {
                $elemMatch: { consultantId: { $in: myConsultantIds }, isActive: true },
              },
            },
          ],
        }).select("clientId").lean();

        const clientIdsFromDb = authorisedClients.map((c) => c.clientId);

        // Also include User.assignedClients as supplemental (some flows set this directly)
        const consultantAdminDoc = await User.findById(adminId)
          .select("assignedClients")
          .lean();
        const clientIdsFromUser = consultantAdminDoc?.assignedClients || [];

        // Merge + deduplicate
        const allClientIds = [...new Set([...clientIdsFromDb, ...clientIdsFromUser])];

        // Build query:
        //   • Own consultant team  (createdBy / consultantAdminId)
        //   • ALL users of every authorised client
        //     (client_admin, client_employee_head, employee, auditor, viewer)
        const orClauses = [
          { createdBy: adminId },           // consultants this admin created directly
          { consultantAdminId: adminId },   // consultants linked via consultantAdminId
        ];

        if (allClientIds.length > 0) {
          orClauses.push({
            clientId: { $in: allClientIds },
            userType: {
              $in: ["client_admin", "client_employee_head", "employee", "auditor", "viewer"],
            },
          });
        }

        baseQuery = { $or: orClauses };
        break;
      }

      case "consultant": {
        const assignedClients = await Client.find({
          "leadInfo.assignedConsultantId": req.user.id,
        }).select("clientId");
        const clientIds = assignedClients.map((c) => c.clientId);
        baseQuery = { clientId: { $in: clientIds } };
        break;
      }

      case "client_admin":
        baseQuery = { clientId: req.user.clientId };
        break;

      case "client_employee_head":
        baseQuery = { createdBy: req.user.id };
        break;

      // ✅ supportManager can access self + their team members
      case "supportManager": {
        const currentUserId = req.user?._id || req.user?.id || req.user?.userId;
        baseQuery = {
          $or: [
            { _id: currentUserId },              // self
            { supportManagerId: currentUserId }, // team members
          ],
        };
        break;
      }

      // ✅ NEW: support can access self + their own manager
      case "support": {
        const currentUserId = req.user?._id || req.user?.id || req.user?.userId;
        baseQuery = {
          $or: [
            { _id: currentUserId }, // self
            // allow viewing their own manager record
            { _id: req.user?.supportManagerId },
          ].filter(Boolean),
        };
        break;
      }

      default:
        return res.status(403).json({
          success: false,
          message: "You don't have permission to view this user",
        });
    }

    // ✅ Correct merge (no ".baseQuery")
    const user = await User.findOne({ _id: userId, ...baseQuery })
      .select("-password")
      .populate("createdBy", "userName email profileImage")
      .populate("parentUser", "userName email profileImage")
      .populate("consultantAdminId", "userName email profileImage")
      .populate("employeeHeadId", "userName email profileImage")

      // ✅ NEW: populate supportManagerId for support users
      .populate("supportManagerId", "userName email profileImage supportTeamName supportManagerType")

      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found or not accessible",
      });
    }

    // (keep your normalize logic)
    user.createdBy = normalizeUserProfile(user.createdBy);
    user.parentUser = normalizeUserProfile(user.parentUser);
    user.consultantAdminId = normalizeUserProfile(user.consultantAdminId);
    user.employeeHeadId = normalizeUserProfile(user.employeeHeadId);

    // ✅ NEW
    user.supportManagerId = normalizeUserProfile(user.supportManagerId);

    normalizeUserProfile(user);

    return res.status(200).json({ success: true, user });
  } catch (error) {
    console.error("Get user by id error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch user",
      error: error.message,
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

      case "consultant_admin": {
        // ── Source of truth: Client collection ──────────────────────────────
        // Same authority logic as permissions.js canManageFlowchart:
        //   (a) client.leadInfo.consultantAdminId === this admin
        //   (b) client.leadInfo.createdBy         === this admin
        //   (c) a consultant under this admin is assigned to the client
        //       (leadInfo.assignedConsultantId, workflowTracking.assignedConsultantId,
        //        or any active consultantHistory entry)
        // Also merges User.assignedClients as a supplemental source.
        // ────────────────────────────────────────────────────────────────────

        const caAdminId = req.user.id;

        // Step 1: All consultants under this admin
        const caConsultants = await User.find({
          consultantAdminId: caAdminId,
          userType: "consultant",
        }).select("_id").lean();
        const caConsultantIds = caConsultants.map((c) => String(c._id));

        // Step 2: All clients this admin has authority over (Client collection)
        const caAuthorisedClients = await Client.find({
          $or: [
            { "leadInfo.consultantAdminId": caAdminId },
            { "leadInfo.createdBy": caAdminId },
            ...(caConsultantIds.length > 0
              ? [
                  { "leadInfo.assignedConsultantId": { $in: caConsultantIds } },
                  { "workflowTracking.assignedConsultantId": { $in: caConsultantIds } },
                  {
                    "leadInfo.consultantHistory": {
                      $elemMatch: { consultantId: { $in: caConsultantIds }, isActive: true },
                    },
                  },
                ]
              : []),
          ],
        }).select("clientId").lean();

        const caClientIdsFromDb = caAuthorisedClients.map((c) => c.clientId);

        // Step 3: Supplemental — User.assignedClients (populated by some flows)
        const caAdminDoc = await User.findById(caAdminId)
          .select("assignedClients")
          .lean();
        const caClientIdsFromUser = caAdminDoc?.assignedClients || [];

        // Step 4: Merge + deduplicate
        const caAllClientIds = [
          ...new Set([...caClientIdsFromDb, ...caClientIdsFromUser]),
        ];

        // Step 5: Build $or — own consultant team + all users of authorised clients
        const caOrClauses = [
          { createdBy: caAdminId },         // consultants created directly by this admin
          { consultantAdminId: caAdminId }, // consultants linked via consultantAdminId field
        ];

        if (caAllClientIds.length > 0) {
          caOrClauses.push({
            clientId: { $in: caAllClientIds },
            userType: {
              $in: ["client_admin", "client_employee_head", "employee", "auditor", "viewer"],
            },
          });
        }

        baseQuery = { $or: caOrClauses };
        break;
      }

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

      // ✅ Support Manager can see their OWN team + self
      case "supportManager": {
        const currentUserId = req.user?._id || req.user?.id || req.user?.userId;
        baseQuery = {
          $or: [
            { _id: currentUserId },               // manager record
            { supportManagerId: currentUserId }   // team members
          ]
        };
        break;
      }

      // ✅ NEW: Support user can at least see self (safe default)
      case "support": {
        const currentUserId = req.user?._id || req.user?.id || req.user?.userId;
        baseQuery = { _id: currentUserId };
        break;
      }

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
        { department: regex },

        // ✅ NEW: Support fields searchable too
        { supportTeamName: regex },
        { supportManagerType: regex },
        { supportEmployeeId: regex },
        { supportJobRole: regex },
        { supportBranch: regex },
        { supportSpecialization: regex },
        { address: regex },
        { contactNumber: regex }
      ];
    }

    // 5. Merge queries — use $and to safely combine baseQuery + filterQuery
    //    so that a search $or never clobbers the hierarchy $or in baseQuery.
    let finalQuery;
    const hasBase   = Object.keys(baseQuery).length > 0;
    const hasFilter = Object.keys(filterQuery).length > 0;

    if (hasBase && hasFilter) {
      finalQuery = { $and: [baseQuery, filterQuery] };
    } else if (hasBase) {
      finalQuery = baseQuery;
    } else if (hasFilter) {
      finalQuery = filterQuery;
    } else {
      finalQuery = {};
    }

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

      // ✅ NEW: populate support manager for support users
      .populate('supportManagerId', 'userName email profileImage supportTeamName supportManagerType')

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

      // ✅ NEW
      u.supportManagerId = normalizeUser(u.supportManagerId);

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
      // FIX Bug #2 (supplemental): Mark subordinate employees as BOTH
      // isActive: false AND isDeleted: true so that:
      //   1. They cannot log in or be re-activated.
      //   2. syncUserTypeUsedCounts excludes them correctly
      //      (it filters isDeleted: { $ne: true }).
      //   3. The quota release in deleteUser can identify them by
      //      isDeleted: true and release their slots.
      // Previously only isActive: false was set, creating an ambiguous
      // state where the users appeared deactivated but not deleted.
      await User.updateMany(
        { employeeHeadId: userToDelete._id, userType: 'employee' },
        {
          isActive:  false,
          isDeleted: true,
          deletedAt: new Date(),
          deletedBy: userToDelete._id, // attributed to the cascade from head deletion
        }
      );
    };
  }
  
  details.canDelete = true;
  return details;
}


const { replaceUserProfileImage } = require('../../utils/uploads/update/replaceUserProfileImage');

// =====================================
// UPDATE USER (S3 IMAGE SAFE) + Support Roles
// =====================================
const updateUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const updateData = { ...req.body };

    // ✅ Safe current user id (supports id/_id/userId)
    const currentUserId = req.user?._id || req.user?.id || req.user?.userId;

    const userToUpdate = await User.findById(userId);
    if (!userToUpdate) {
      return res.status(404).json({ message: "User not found" });
    }

    // -------------------------------------
    // PERMISSION CHECK (UNCHANGED LOGIC + support roles)
    // -------------------------------------
    let canUpdate = false;

    // ✅ Self update (fixed - supports req.user.id mismatch cases)
    if (String(userToUpdate._id) === String(currentUserId)) {
      canUpdate = true;
    } else {
      switch (req.user.userType) {
        case "super_admin":
          canUpdate =
            userToUpdate.userType !== "super_admin" ||
            String(userToUpdate._id) === String(currentUserId);
          break;

        case "consultant_admin":
          if (userToUpdate.userType === "consultant") {
            canUpdate =
              String(userToUpdate.consultantAdminId) === String(currentUserId);
          }
          break;

        case "client_admin":
          canUpdate =
            userToUpdate.clientId === req.user.clientId &&
            ["client_employee_head", "employee", "auditor", "viewer"].includes(
              userToUpdate.userType
            );
          break;

        case "client_employee_head":
          canUpdate =
            userToUpdate.userType === "employee" &&
            String(userToUpdate.createdBy) === String(currentUserId);
          break;

        // ✅ NEW: supportManager can update support users in their team
        case "supportManager":
          canUpdate =
            userToUpdate.userType === "support" &&
            userToUpdate.supportManagerId &&
            String(userToUpdate.supportManagerId) === String(currentUserId);
          break;

        // ✅ NEW: support cannot update others
        case "support":
          canUpdate = false;
          break;
      }
    }

    if (!canUpdate) {
      return res.status(403).json({
        message: "You don't have permission to update this user",
      });
    }

    // ── permissionToEdit guard (self-update only) ─────────────────────
    const isSelfUpdate = String(userToUpdate._id) === String(currentUserId);

    if (isSelfUpdate) {
      // Re-read from DB so we always have the live value, not the JWT snapshot
      const freshUser = await User.findById(currentUserId)
        .select("permissionToEdit")
        .lean();

      if (freshUser && freshUser.permissionToEdit === false) {
        return res.status(403).json({
          message:
            "Profile editing has been disabled for your account. Please contact your administrator.",
          code: "EDIT_PERMISSION_DENIED",
        });
      }
    }
    // ─────────────────────────────────────────────────────────────────

    // -------------------------------------
    // REMOVE IMMUTABLE FIELDS + accessControls VALIDATION
    // -------------------------------------

    // Remove immutable fields
    delete updateData.password;
    delete updateData.userType;
    delete updateData.clientId;
    delete updateData.createdBy;
    delete updateData.consultantAdminId;
    delete updateData.parentUser;

    // 🆕 Handle accessControls checklist update for viewer/auditor
    if (updateData.accessControls !== undefined) {
      const targetUserType = userToUpdate.userType;

      // Only client_admin / super_admin can set accessControls for viewer/auditor
      if (
        req.user.userType !== "client_admin" &&
        req.user.userType !== "super_admin"
      ) {
        delete updateData.accessControls; // silently strip — non-admin cannot set
      } else if (!["viewer", "auditor"].includes(targetUserType)) {
        // accessControls only applies to viewer/auditor
        delete updateData.accessControls;
      } else {
        // Parse first (handles FormData JSON string → object), then validate.
        const acParsed = parseAccessControls(updateData.accessControls);
        if (!acParsed.ok) {
          return res.status(400).json({
            message: `Invalid accessControls: ${acParsed.error}`,
          });
        }

        const validation = validateAndSanitizeChecklist(acParsed.value ?? updateData.accessControls);

        if (!validation.valid) {
          return res.status(400).json({
            message: `Invalid accessControls: ${validation.error}`,
          });
        }

        updateData.accessControls = validation.sanitized;
      }
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

    const updatedUser = await User.findById(userId).select("-password").lean();

    return res.status(200).json({
      message: "User updated successfully",
      user: updatedUser,
    });
  } catch (error) {
    console.error("Update user error:", error);
    return res.status(500).json({
      message: "Failed to update user",
      error: error.message,
    });
  }
};



const { deleteUserProfileImage } = require('../../utils/uploads/delete/deleteUserProfileImage');

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

    // ── Release quota slot on deletion ─────────────────────────────────────────
    // FIX Bug #1: The original code passed null as consultantId, causing
    // releaseUserTypeSlot to immediately return (no-op) on every call.
    // Every deleted user was permanently inflating usedCount, which eventually
    // blocks new user creation even after deletions.
    // Fix: resolve consultantId via getAssignedConsultantId() first.
    //
    // FIX Bug #2: When a client_employee_head is deleted, handleClientAdminDeletion
    // deactivates their subordinate employees via updateMany({ isActive: false }).
    // Those employees' quota slots were never released, leaving usedCount inflated
    // for 'employee' even though those users are now non-functional.
    // Fix: find the deactivated employees (isActive: false, isDeleted: true from
    // preDeletionTasks) and release a slot for each of them.
    const QUOTA_CONTROLLED = ['client_employee_head', 'employee', 'viewer', 'auditor'];
    if (QUOTA_CONTROLLED.includes(userToDelete.userType) && userToDelete.clientId) {
      getAssignedConsultantId(userToDelete.clientId)
        .then(async (consultantId) => {
          if (!consultantId) return; // no consultant assigned → no quota doc → nothing to release

          // Release slot for the directly-deleted user.
          await releaseUserTypeSlot(
            userToDelete.clientId,
            userToDelete.userType,
            consultantId
          );

          // FIX Bug #2: If an employee_head was deleted, preDeletionTasks
          // cascaded isActive: false + isDeleted: true onto their employees.
          // Their usedCount slots were never released — release them now.
          if (userToDelete.userType === 'client_employee_head') {
            const deactivatedEmployees = await User.find({
              employeeHeadId: userToDelete._id,
              clientId:       userToDelete.clientId,
              userType:       'employee',
              isActive:       false,
              isDeleted:      true,   // set by updated preDeletionTasks
            }).select('_id').lean();

            for (let i = 0; i < deactivatedEmployees.length; i++) {
              await releaseUserTypeSlot(
                userToDelete.clientId,
                'employee',
                consultantId
              );
            }

            if (deactivatedEmployees.length > 0) {
              console.log(
                `[QUOTA] Released ${deactivatedEmployees.length} employee slot(s) ` +
                `after head ${userToDelete.userName} (${userToDelete._id}) was deleted.`
              );
            }
          }
        })
        .catch((e) =>
          console.warn('[QUOTA] releaseUserTypeSlot after delete failed:', e.message)
        );
    }
    // ── End quota release ───────────────────────────────────────────────────────

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
          const Client = require("../../../modules/client-management/client/Client");
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
        message: "Please provide current and new password",
      });
    }

    // ── permissionToEdit guard ────────────────────────────────────────
    // Re-read from DB so we always have the live value, not the JWT snapshot
    const callerForPwChange = await User.findById(req.user.id)
      .select("permissionToEdit")
      .lean();

    if (callerForPwChange && callerForPwChange.permissionToEdit === false) {
      return res.status(403).json({
        message:
          "Password changes have been disabled for your account. Please contact your administrator.",
        code: "EDIT_PERMISSION_DENIED",
      });
    }
    // ─────────────────────────────────────────────────────────────────

    // Get user with password
    const user = await User.findById(req.user.id);

    // Verify current password
    const isMatch = bcrypt.compareSync(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({
        message: "Current password is incorrect",
      });
    }

    // Hash new password
    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    user.password = hashedPassword;
    user.isFirstLogin = false;
    await user.save();

    res.status(200).json({
      message: "Password changed successfully",
    });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({
      message: "Failed to change password",
      error: error.message,
    });
  }
};


// Request password reset
const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        message: "Please provide your email address",
      });
    }

    // Find user by email
    const user = await User.findOne({
      email: email.toLowerCase(),
      isActive: true,
    });

    if (!user) {
      // Don't reveal if email exists or not for security
      return res.status(200).json({
        message:
          "If your email is registered, you will receive a password reset link shortly.",
      });
    }

    // ── permissionToEdit guard ────────────────────────────────────────
    // NOTE: Return generic 200 to avoid account enumeration / lock-state leakage.
    if (user.permissionToEdit === false) {
      console.log(
        `[FORGOT-PW] Blocked reset for ${user.email} — permissionToEdit=false`
      );

      return res.status(200).json({
        message:
          "If your email is registered, you will receive a password reset link shortly.",
      });
    }
    // ─────────────────────────────────────────────────────────────────

    // Generate reset token using JWT (valid for 15 minutes)
    const resetToken = jwt.sign(
      {
        userId: user._id,
        email: user.email,
        purpose: "password-reset",
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
        message: "Failed to send reset email. Please try again later.",
      });
    }

    // Log the password reset attempt for security
    console.log(
      `Password reset requested for user: ${user.email} at ${new Date().toISOString()}`
    );

    res.status(200).json({
      message:
        "If your email is registered, you will receive a password reset link shortly.",
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({
      message: "An error occurred. Please try again later.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

// Reset password using token
const resetPassword = async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({
        message: "Please provide reset token and new password",
      });
    }

    // Validate password strength (optional)
    if (newPassword.length < 8) {
      return res.status(400).json({
        message: "Password must be at least 8 characters long",
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
          message: "Password reset link has expired. Please request a new one.",
        });
      }
      return res.status(400).json({
        message: "Invalid or expired reset link",
      });
    }

    // Find user and verify they're active
    const user = await User.findOne({
      _id: decoded.userId,
      email: decoded.email,
      isActive: true,
    });

    if (!user) {
      return res.status(400).json({
        message: "Invalid reset link or user not found",
      });
    }

    // ── permissionToEdit guard ────────────────────────────────────────
    if (user.permissionToEdit === false) {
      console.log(
        `[RESET-PW] Blocked reset for ${user.email} — permissionToEdit=false`
      );
      return res.status(403).json({
        message:
          "Password reset has been disabled for this account. Please contact your administrator.",
        code: "EDIT_PERMISSION_DENIED",
      });
    }
    // ─────────────────────────────────────────────────────────────────

    // Check if new password is same as current password
    const isSamePassword = bcrypt.compareSync(newPassword, user.password);
    if (isSamePassword) {
      return res.status(400).json({
        message: "New password must be different from your current password",
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
    console.log(
      `Password reset successful for user: ${user.email} at ${new Date().toISOString()}`
    );

    res.status(200).json({
      message:
        "Password has been reset successfully. Please login with your new password.",
    });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({
      message: "Failed to reset password. Please try again.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
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

const {
  logFlowchartScopeAssign,
  logFlowchartScopeUnassign,
} = require('../../../modules/zero-carbon/workflow/audit/flowchartAuditLog'); 
// adjust ../../ based on your controller location


/**
 * POST /api/users/assign-scope
 * body: { clientId, nodeId, scopeIdentifier, employeeIds }
 * └─ Only the Employee Head assigned to that specific node can assign employees to scope details
 */
const assignScope = async (req, res) => {
  try {
    if (req.user.userType !== 'client_employee_head') {
      return res.status(403).json({
        message: 'Only Employee Heads can assign employees to scopes'
      });
    }

    const { clientId, nodeId, scopeIdentifier, employeeIds } = req.body;

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

    if (req.user.clientId !== clientId) {
      return res.status(403).json({
        message: 'You can only assign employees within your organization'
      });
    }

    // ✅ IMPORTANT: include _id + clientId in projection for audit logger
    const flowchart = await Flowchart.findOne(
      { clientId, 'nodes.id': nodeId },
      { _id: 1, clientId: 1, 'nodes.$': 1 }
    );

    if (!flowchart || !flowchart.nodes || flowchart.nodes.length === 0) {
      return res.status(404).json({
        message: 'Flowchart or node not found'
      });
    }

    const node = flowchart.nodes[0];

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

    const scopeDetail = node.details.scopeDetails.find(
      scope => scope.scopeIdentifier === scopeIdentifier
    );

    if (!scopeDetail) {
      return res.status(404).json({
        message: `Scope detail '${scopeIdentifier}' not found in this node`
      });
    }

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

    // ✅ AUDIT LOG (Assign Employees → Scope)
    await logFlowchartScopeAssign(
      req,
      { _id: flowchart._id, clientId: flowchart.clientId },
      nodeId,
      scopeIdentifier,
      employeeIds
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
      // (optional) your existing node-head removal logic remains the same
      const result = await Flowchart.updateOne(
        { clientId, 'nodes.id': nodeId },
        { $unset: { 'nodes.$.details.employeeHeadId': "" } }
      );

      if (result.modifiedCount > 0) {
        await User.updateMany(
          { userType: 'client_employee_head', clientId },
          {
            $pull: {
              assignedModules: { $regex: `.*"nodeId":"${nodeId}".*` }
            }
          }
        );

        return res.status(200).json({ message: 'Employee Head removed from node' });
      } else {
        return res.status(404).json({ message: 'Node not found' });
      }

    } else if (req.user.userType === 'client_employee_head' && scopeIdentifier && employeeIds) {
      // ✅ fetch minimal flowchart info for audit logger
      const flowchart = await Flowchart.findOne(
        { clientId, 'nodes.id': nodeId },
        { _id: 1, clientId: 1 }
      );

      if (!flowchart) {
        return res.status(404).json({ message: 'Flowchart or node not found' });
      }

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

      // ✅ AUDIT LOG (Unassign Employees ← Scope)
      await logFlowchartScopeUnassign(
        req,
        { _id: flowchart._id, clientId: flowchart.clientId },
        nodeId,
        scopeIdentifier,
        employeeIds
      );

      return res.status(200).json({ message: 'Employees removed from scope' });

    } else {
      return res.status(403).json({ message: 'Insufficient permissions' });
    }

  } catch (error) {
    console.error('❌ Error removing assignment:', error);
    res.status(500).json({
      message: 'Error removing assignment',
      error: error.message
    });
  }
};


/**
 * Assign support manager to consultant or consultant admin
 * PATCH /api/users/:userId/assign-support-manager
 * Body: { supportManagerId }
 * Auth: super_admin only
 */
const assignSupportManagerToConsultant = async (req, res) => {
  try {
    const { userId } = req.params;
    const { supportManagerId } = req.body;

    // Only super_admin can assign support to consultants
    if (req.user.userType !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Only super admins can assign support to consultants'
      });
    }

    if (!supportManagerId) {
      return res.status(400).json({
        success: false,
        message: 'supportManagerId is required'
      });
    }

    // Get the consultant/consultant_admin
    const consultant = await User.findById(userId);
    if (!consultant || !['consultant', 'consultant_admin'].includes(consultant.userType)) {
      return res.status(404).json({
        success: false,
        message: 'Consultant or consultant admin not found'
      });
    }

    // Verify support manager exists and is active
    const supportManager = await User.findOne({
      _id: supportManagerId,
      userType: 'supportManager',
      isActive: true
    });

    if (!supportManager) {
      return res.status(404).json({
        success: false,
        message: 'Support manager not found or inactive'
      });
    }

    // Check if support manager can handle consultant support
    if (supportManager.supportManagerType === 'client_support') {
      return res.status(400).json({
        success: false,
        message: 'This support manager only handles client support, not consultant support'
      });
    }

    // Add consultant to support manager's assigned consultants list
    if (!supportManager.assignedConsultants) {
      supportManager.assignedConsultants = [];
    }
    
    const consultantIdStr = consultant._id.toString();
    const alreadyAssigned = supportManager.assignedConsultants.some(
      id => id.toString() === consultantIdStr
    );

    if (alreadyAssigned) {
      return res.status(400).json({
        success: false,
        message: 'This support manager is already assigned to this consultant'
      });
    }

    supportManager.assignedConsultants.push(consultant._id);
    await supportManager.save();

    console.log(`[CLIENT CONTROLLER] Support manager ${supportManager.userName} assigned to consultant ${consultant.userName}`);

    return res.status(200).json({
      success: true,
      message: 'Support manager assigned to consultant successfully',
      assignment: {
        consultant: {
          _id: consultant._id,
          userName: consultant.userName,
          userType: consultant.userType
        },
        supportManager: {
          _id: supportManager._id,
          userName: supportManager.userName,
          supportTeamName: supportManager.supportTeamName,
          supportManagerType: supportManager.supportManagerType
        }
      }
    });

  } catch (error) {
    console.error('[CLIENT CONTROLLER] Error assigning support manager to consultant:', error);
    return res.status(500).json({
      success: false,
      message: 'Error assigning support manager',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};



/**
 * ── Permission matrix (corrected) ───────────────────────────────────────
 *
 *  WHO can call this endpoint:
 *  ┌─────────────────┬────────────────────────────────────────────────────┐
 *  │ Requester       │ Which target users they can update                 │
 *  ├─────────────────┼────────────────────────────────────────────────────┤
 *  │ super_admin     │ Any user in the system                             │
 *  ├─────────────────┼────────────────────────────────────────────────────┤
 *  │ consultant_admin│ client_admin, client_employee_head, employee,      │
 *  │                 │ auditor, viewer — whose clientId is in the         │
 *  │                 │ consultant_admin's own assignedClients array       │
 *  │                 │ OR belongs to a client_admin created by them       │
 *  ├─────────────────┼────────────────────────────────────────────────────┤
 *  │ consultant      │ client_admin, client_employee_head, employee,      │
 *  │                 │ auditor, viewer — whose clientId is a client where │
 *  │                 │ Client.leadInfo.assignedConsultantId === consultant │
 *  │                 │ (same lookup used by getUsers / getUserById)       │
 *  ├─────────────────┼────────────────────────────────────────────────────┤
 *  │ client_admin    │ ❌ NOT ALLOWED — client_admin cannot set limits    │
 *  └─────────────────┴────────────────────────────────────────────────────┘
 *
 *  ENDPOINT:  PATCH /api/users/:userId/session-limit
 *  BODY:      { "concurrentLoginLimit": <integer 1–10> }
 *  HEADER:    Authorization: Bearer <token>
 */
const setConcurrentLoginLimit = async (req, res) => {
  try {
    const { userId } = req.params;
    const requester = req.user; // set by auth middleware

    // ── 1. Validate userId format ──────────────────────────────────────
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid userId" });
    }

    // ── 2. Validate the new limit value ───────────────────────────────
    const rawLimit = req.body.concurrentLoginLimit;

    if (rawLimit === undefined || rawLimit === null || rawLimit === '') {
      return res.status(400).json({
        message: "concurrentLoginLimit is required",
        field: "concurrentLoginLimit"
      });
    }

    const limit = parseInt(rawLimit, 10);

    if (isNaN(limit) || limit < 1 || limit > 10) {
      return res.status(400).json({
        message: "concurrentLoginLimit must be a whole number between 1 and 10",
        field: "concurrentLoginLimit",
        received: rawLimit,
        allowed: "1–10"
      });
    }

    // ── 3. Prevent self-update ─────────────────────────────────────────
    if (String(userId) === String(requester.id)) {
      return res.status(400).json({
        message: "You cannot change your own concurrent login limit"
      });
    }

    // ── 4. Load target user ────────────────────────────────────────────
    const targetUser = await User.findById(userId).select("-password");

    if (!targetUser) {
      return res.status(404).json({ message: "User not found" });
    }

    // ── 5. Authorization check ─────────────────────────────────────────
    const authResult = await _checkSessionLimitAuthority(requester, targetUser);

    if (!authResult.allowed) {
      console.log(
        `[SESSION LIMIT] DENIED — ${requester.userType} (${requester.email}) ` +
        `tried to update ${targetUser.userType} (${targetUser.email}): ${authResult.reason}`
      );
      return res.status(403).json({ message: authResult.reason });
    }

    // ── 6. Apply the update ────────────────────────────────────────────
    const previousLimit = targetUser.concurrentLoginLimit ?? 1;
    targetUser.concurrentLoginLimit = limit;
    await targetUser.save();

    console.log(
      `[SESSION LIMIT] ${requester.userType} (${requester.email}) ` +
      `updated ${targetUser.userType} (${targetUser.email}): ` +
      `${previousLimit} → ${limit}`
    );

    return res.status(200).json({
      message: "Concurrent login limit updated successfully",
      user: {
        id: targetUser._id,
        userName: targetUser.userName,
        email: targetUser.email,
        userType: targetUser.userType,
        clientId: targetUser.clientId || null,
        previousLimit,
        concurrentLoginLimit: targetUser.concurrentLoginLimit
      }
    });

  } catch (error) {
    // Mongoose schema-level validation (min/max)
    if (error.name === "ValidationError") {
      const msgs = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ message: "Validation failed", errors: msgs });
    }

    console.error("[SESSION LIMIT] Unexpected error:", error);
    return res.status(500).json({
      message: "Failed to update concurrent login limit",
      error: process.env.NODE_ENV === "development" ? error.message : "Internal server error"
    });
  }
};


/**
 * Internal authority resolver.
 *
 * Returns { allowed: true }
 *      or { allowed: false, reason: "<human-readable message>" }
 *
 * Uses the SAME data patterns as getUsers/getUserById:
 *   • consultant_admin → their assignedClients array on the User document
 *                        OR client ownership derived through created client_admin
 *   • consultant       → Client.leadInfo.assignedConsultantId (DB lookup)
 */
async function _checkSessionLimitAuthority(requester, targetUser) {
  const reqType = requester.userType;
  const tgtType = targetUser.userType;

  // ── Target must always be a client-side user ─────────────────────────
  const CLIENT_SIDE_TYPES = [
    "client_admin",
    "client_employee_head",
    "employee",
    "auditor",
    "viewer"
  ];

  if (!CLIENT_SIDE_TYPES.includes(tgtType)) {
    return {
      allowed: false,
      reason: "Only client-side users (client_admin, client_employee_head, employee, auditor, viewer) can have their session limit updated by this endpoint"
    };
  }

  // ── RULE 0: super_admin — unrestricted ───────────────────────────────
  if (reqType === "super_admin") {
    return { allowed: true };
  }

  // ── RULE 1: consultant_admin ─────────────────────────────────────────
  // Authority:
  //  1) their own assignedClients contains targetUser.clientId
  //  2) target client_admin was created by them
  //  3) target user belongs to a client whose client_admin was created by them
  if (reqType === "consultant_admin") {
    if (!targetUser.clientId) {
      return {
        allowed: false,
        reason: "Target user has no clientId — cannot verify organisation ownership"
      };
    }

    // Fetch live assignedClients from DB (not from JWT — it may be stale)
    const requesterDoc = await User.findById(requester.id)
      .select("assignedClients")
      .lean();

    const assignedClients = requesterDoc?.assignedClients || [];

    // 1) Existing logic: assignedClients
    if (assignedClients.map(String).includes(String(targetUser.clientId))) {
      return { allowed: true };
    }

    // 2) Direct ownership of client_admin via createdBy
    if (
      targetUser.userType === "client_admin" &&
      String(targetUser.createdBy) === String(requester.id)
    ) {
      return { allowed: true };
    }

    // 3) Indirect ownership of all client-side users under a client_admin created by this consultant_admin
    const ownedClientAdmin = await User.findOne({
      userType: "client_admin",
      clientId: targetUser.clientId,
      createdBy: requester.id
    })
      .select("_id clientId")
      .lean();

    if (ownedClientAdmin) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `You can only set session limits for users whose organisation (${targetUser.clientId}) is in your assigned clients list or belongs to a client_admin created by you`
    };
  }

  // ── RULE 2: consultant ───────────────────────────────────────────────
  // Keep this only if your file already has Client imported and the same
  // consultant ownership pattern is used elsewhere in the controller.
  if (reqType === "consultant") {
    if (!targetUser.clientId) {
      return {
        allowed: false,
        reason: "Target user has no clientId — cannot verify consultant ownership"
      };
    }

    const ownedClient = await Client.findOne({
      clientId: targetUser.clientId,
      "leadInfo.assignedConsultantId": requester.id
    })
      .select("_id clientId")
      .lean();

    if (ownedClient) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `You can only set session limits for users whose organisation (${targetUser.clientId}) is assigned to you`
    };
  }

  // ── RULE 3: client_admin — explicitly blocked ────────────────────────
  if (reqType === "client_admin") {
    return {
      allowed: false,
      reason: "client_admin does not have permission to set concurrent login limits. Only super_admin, consultant_admin, or consultant can do this."
    };
  }

  // ── Default deny for all other roles ─────────────────────────────────
  return {
    allowed: false,
    reason: "You do not have permission to set concurrent login limits"
  };
}

// ═══════════════════════════════════════════════════════════════════
// ESGLink USER CREATION FUNCTIONS
// Only callable when client has 'esg_link' in accessibleModules and
// the ESGLink subscription is active. Quota is enforced per user type.
// ═══════════════════════════════════════════════════════════════════

/**
 * Helper: validate ESGLink module access for client_admin creation routes.
 * Returns { ok: true } or { ok: false, res: response }
 */
async function _validateEsgLinkAccess(req, res) {
  if (!req.user || req.user.userType !== 'client_admin') {
    res.status(403).json({ message: 'Only Client Admin can create ESGLink users' });
    return { ok: false };
  }
  const clientDoc = await Client.findOne({ clientId: req.user.clientId });
  if (!clientDoc) {
    res.status(404).json({ message: 'Client not found' });
    return { ok: false };
  }
  if (!clientDoc.accessibleModules?.includes('esg_link')) {
    res.status(403).json({ message: 'Your organisation does not have access to the ESGLink module' });
    return { ok: false };
  }
  if (!isModuleSubscriptionActive(clientDoc, 'esg_link')) {
    res.status(403).json({ message: 'Your organisation\'s ESGLink subscription is not active' });
    return { ok: false };
  }
  return { ok: true };
}

// ─── createContributor ────────────────────────────────────────────────────────
const createContributor = async (req, res) => {
  try {
    const check = await _validateEsgLinkAccess(req, res);
    if (!check.ok) return;

    const { email, password, contactNumber, userName, address } = req.body;

    if (!email || !password || !contactNumber || !userName || !address) {
      return res.status(400).json({ message: 'email, password, contactNumber, userName and address are required' });
    }

    const existing = await User.findOne({ $or: [{ email }, { userName }] });
    if (existing) return res.status(409).json({ message: 'Email or Username already exists' });

    const slot = await reserveUserTypeSlot(req.user.clientId, 'contributor');
    if (!slot.allowed) {
      return res.status(429).json({
        message: slot.message || 'Contributor quota exceeded for this client.',
        quota: { limit: slot.limit ?? null, used: slot.used ?? null, remaining: slot.remaining ?? 0 },
      });
    }

    const user = new User({
      email,
      password: bcrypt.hashSync(password, 10),
      contactNumber,
      userName,
      address,
      userType: 'contributor',
      companyName: req.user.companyName,
      clientId: req.user.clientId,
      createdBy: req.user.id,
      isActive: true,
      accessibleModules: ['esg_link'],
      permissions: { canViewAllClients: false, canManageUsers: false, canManageClients: false, canViewReports: false, canEditBoundaries: false, canSubmitData: true, canAudit: false },
    });

    try {
      await user.save();
    } catch (saveErr) {
      if (slot.reserved && slot.consultantId) {
        await releaseUserTypeSlot(req.user.clientId, 'contributor', slot.consultantId).catch(() => {});
      }
      throw saveErr;
    }

    logUserCreated(req, user).catch(() => {});
    return res.status(201).json({ message: 'Contributor created successfully', contributor: { id: user._id, email: user.email, userName: user.userName } });
  } catch (error) {
    console.error('Create contributor error:', error);
    return res.status(500).json({ message: 'Failed to create Contributor', error: error.message });
  }
};

// ─── createReviewer ───────────────────────────────────────────────────────────
const createReviewer = async (req, res) => {
  try {
    const check = await _validateEsgLinkAccess(req, res);
    if (!check.ok) return;

    const { email, password, contactNumber, userName, address } = req.body;

    if (!email || !password || !contactNumber || !userName || !address) {
      return res.status(400).json({ message: 'email, password, contactNumber, userName and address are required' });
    }

    const existing = await User.findOne({ $or: [{ email }, { userName }] });
    if (existing) return res.status(409).json({ message: 'Email or Username already exists' });

    const slot = await reserveUserTypeSlot(req.user.clientId, 'reviewer');
    if (!slot.allowed) {
      return res.status(429).json({
        message: slot.message || 'Reviewer quota exceeded for this client.',
        quota: { limit: slot.limit ?? null, used: slot.used ?? null, remaining: slot.remaining ?? 0 },
      });
    }

    const user = new User({
      email,
      password: bcrypt.hashSync(password, 10),
      contactNumber,
      userName,
      address,
      userType: 'reviewer',
      companyName: req.user.companyName,
      clientId: req.user.clientId,
      createdBy: req.user.id,
      isActive: true,
      accessibleModules: ['esg_link'],
      permissions: { canViewAllClients: false, canManageUsers: false, canManageClients: false, canViewReports: true, canEditBoundaries: false, canSubmitData: false, canAudit: false },
    });

    try {
      await user.save();
    } catch (saveErr) {
      if (slot.reserved && slot.consultantId) {
        await releaseUserTypeSlot(req.user.clientId, 'reviewer', slot.consultantId).catch(() => {});
      }
      throw saveErr;
    }

    logUserCreated(req, user).catch(() => {});
    return res.status(201).json({ message: 'Reviewer created successfully', reviewer: { id: user._id, email: user.email, userName: user.userName } });
  } catch (error) {
    console.error('Create reviewer error:', error);
    return res.status(500).json({ message: 'Failed to create Reviewer', error: error.message });
  }
};

// ─── createApprover ───────────────────────────────────────────────────────────
const createApprover = async (req, res) => {
  try {
    const check = await _validateEsgLinkAccess(req, res);
    if (!check.ok) return;

    const { email, password, contactNumber, userName, address } = req.body;

    if (!email || !password || !contactNumber || !userName || !address) {
      return res.status(400).json({ message: 'email, password, contactNumber, userName and address are required' });
    }

    const existing = await User.findOne({ $or: [{ email }, { userName }] });
    if (existing) return res.status(409).json({ message: 'Email or Username already exists' });

    const slot = await reserveUserTypeSlot(req.user.clientId, 'approver');
    if (!slot.allowed) {
      return res.status(429).json({
        message: slot.message || 'Approver quota exceeded for this client.',
        quota: { limit: slot.limit ?? null, used: slot.used ?? null, remaining: slot.remaining ?? 0 },
      });
    }

    const user = new User({
      email,
      password: bcrypt.hashSync(password, 10),
      contactNumber,
      userName,
      address,
      userType: 'approver',
      companyName: req.user.companyName,
      clientId: req.user.clientId,
      createdBy: req.user.id,
      isActive: true,
      accessibleModules: ['esg_link'],
      permissions: { canViewAllClients: false, canManageUsers: false, canManageClients: false, canViewReports: true, canEditBoundaries: false, canSubmitData: false, canAudit: false },
    });

    try {
      await user.save();
    } catch (saveErr) {
      if (slot.reserved && slot.consultantId) {
        await releaseUserTypeSlot(req.user.clientId, 'approver', slot.consultantId).catch(() => {});
      }
      throw saveErr;
    }

    logUserCreated(req, user).catch(() => {});
    return res.status(201).json({ message: 'Approver created successfully', approver: { id: user._id, email: user.email, userName: user.userName } });
  } catch (error) {
    console.error('Create approver error:', error);
    return res.status(500).json({ message: 'Failed to create Approver', error: error.message });
  }
};

// ─── updateUserModuleAccess ───────────────────────────────────────────────────
// Only super_admin or the consultant_admin who manages the user's client.
const updateUserModuleAccess = async (req, res) => {
  try {
    const { userId } = req.params;
    const { accessibleModules } = req.body;
    const actor = req.user;

    if (!['super_admin', 'consultant_admin'].includes(actor.userType)) {
      return res.status(403).json({ message: 'Only Super Admin or Consultant Admin can update module access' });
    }

    if (!accessibleModules || !Array.isArray(accessibleModules) || accessibleModules.length === 0) {
      return res.status(400).json({ message: 'accessibleModules array is required' });
    }

    const VALID_MODULES = ['zero_carbon', 'esg_link'];
    const invalid = accessibleModules.filter(m => !VALID_MODULES.includes(m));
    if (invalid.length > 0) {
      return res.status(400).json({ message: `Invalid module(s): ${invalid.join(', ')}` });
    }

    const targetUser = await User.findById(userId);
    if (!targetUser) return res.status(404).json({ message: 'User not found' });

    // consultant_admin: can only update users in their own managed clients
    if (actor.userType === 'consultant_admin' && targetUser.clientId) {
      const clientDoc = await Client.findOne({ clientId: targetUser.clientId });
      if (!clientDoc || clientDoc.leadInfo?.consultantAdminId?.toString() !== actor.id) {
        return res.status(403).json({ message: 'You can only update module access for users in clients you manage' });
      }
      // Validate client has those modules
      for (const mod of accessibleModules) {
        if (!clientDoc.accessibleModules?.includes(mod)) {
          return res.status(403).json({ message: `Client ${targetUser.clientId} does not have access to module: ${mod}` });
        }
      }
    }

    const previousModules = targetUser.accessibleModules || ['zero_carbon'];
    targetUser.accessibleModules = accessibleModules;
    await targetUser.save();

    // Audit log
    logEvent({
      req,
      module: 'user_management',
      action: 'update',
      entityType: 'User',
      entityId: targetUser._id.toString(),
      clientId: targetUser.clientId,
      changeSummary: `Module access updated for user ${targetUser.userName}`,
      metadata: { previousModules, newModules: accessibleModules, targetUserId: userId },
      targetUserId: targetUser._id,
      targetUserName: targetUser.userName,
      targetUserType: targetUser.userType,
    }).catch(() => {});

    return res.status(200).json({
      message: 'User module access updated successfully',
      userId,
      accessibleModules,
    });
  } catch (error) {
    console.error('updateUserModuleAccess error:', error);
    return res.status(500).json({ message: 'Failed to update module access', error: error.message });
  }
};

module.exports = {
  initializeSuperAdmin,
  login,
  logout,
  logoutAllDevices,
  setUserPermissions,
  createConsultantAdmin,
  createConsultant,
  createClientAdmin,
  createEmployeeHead,
  createEmployee,
  createAuditor,
  createViewer,
  // 🆕 ESGLink user types
  createContributor,
  createReviewer,
  createApprover,
  updateUserModuleAccess,
  getMyProfile,
  getUserById,
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
  verifyLoginOTP,         
  resendLoginOTP,
  assignSupportManagerToConsultant,          
  createSupportManager,
  createSupport,
  getSupportTeam,
  changeSupportUserManager,
  getAllSupportManagers,
  getAllSupportUsers,
  deleteSupportManager,
  deleteSupportUser,
  setConcurrentLoginLimit,
};