const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Client = require('../models/CMS/Client');
const UserSession = require('../models/UserSession');
const { isModuleSubscriptionActive } = require('../utils/Permissions/modulePermission');

/**
 * Primary auth middleware used by all protected routes (router.use(auth)).
 *
 * Changes from original:
 *   1. After JWT decode + user fetch, verifies that `decoded.sessionId` exists
 *      in UserSession as an active, non-expired session.
 *   2. Updates `lastSeen` on the session (fire-and-forget — never blocks the request).
 *   3. Attaches `req.sessionId` so controllers (e.g. logout) can reference it.
 *
 * Backward compat: tokens issued before this patch have no `sessionId` field.
 * Those tokens will fail the session check and return 401 "Session not found".
 * Users must log in once after the patch is deployed. This is intentional and
 * expected — it is the deployment cut-over moment.
 */
const auth = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: "No token provided" });
    }

    const token = authHeader.slice(7);

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // ── 1. Verify user still exists ──────────────────────────────────────
      const user = await User.findById(decoded.id).select('-password');

      if (!user) {
        return res.status(401).json({ message: "User not found" });
      }

      const isSandboxUser = user.sandbox === true;

      if (!user.isActive && !isSandboxUser) {
        return res.status(403).json({ message: "User account is deactivated" });
      }

      // ── 2. Session liveness check ─────────────────────────────────────────
      //
      // Every real login token (issued by verifyLoginOTP) contains `sessionId`.
      // Tokens that have no sessionId are legacy tokens from before this patch —
      // treat them as invalid so users are forced to re-authenticate.
      if (!decoded.sessionId) {
        return res.status(401).json({
          message: "Session invalid. Please log in again.",
          code: "SESSION_MISSING"
        });
      }

      const session = await UserSession.findOne({
        sessionId: decoded.sessionId,
        userId: user._id,
        isActive: true
      });

      if (!session) {
        return res.status(401).json({
          message: "Session is no longer valid. Please log in again.",
          code: "SESSION_EXPIRED"
        });
      }

      // Fire-and-forget: update lastSeen without blocking the request
      UserSession.updateOne(
        { sessionId: decoded.sessionId },
        { $set: { lastSeen: new Date() } }
      ).exec().catch(err =>
        console.error('[AUTH] lastSeen update failed:', err.message)
      );

      // ── 3. Client subscription check ──────────────────────────────────────
      if (user.clientId) {
        let client = await Client.findOne({ clientId: user.clientId });
        if (!client) {
          // Fallback: user.clientId may still be the old Sandbox_GreonXXX id if the
          // clientId-rename step failed silently during activation. Look up by sandboxClientId.
          client = await Client.findOne({ sandboxClientId: user.clientId });
        }
        if (!client) {
          return res.status(403).json({ message: "Your organization is not found" });
        }

        const isSandboxClient =
          client.sandbox === true ||
          isSandboxUser ||
          String(client.clientId || '').startsWith('Sandbox_');

        if (!isSandboxClient) {
          const userModules = user.accessibleModules && user.accessibleModules.length > 0
            ? user.accessibleModules
            : ['zero_carbon']; // backward compat for users without accessibleModules set

          // Module-aware subscription check:
          // Only block entirely when ALL of the user's modules are expired/inactive.
          // If at least one module is active, let the request through — route-level
          // middleware (requireActiveModuleSubscription) handles per-module gating.
          const activeModules = userModules.filter(m => isModuleSubscriptionActive(client, m));

          if (activeModules.length === 0) {
            const firstModule = userModules[0];
            return res.status(403).json({
              message: `Your organization's ${firstModule === 'esg_link' ? 'ESGLink' : 'ZeroCarbon'} subscription has expired or is not active`,
              module: firstModule,
              subscriptionExpired: true,
            });
          }

          // Attach expired module info and client doc for downstream route middleware
          // to enforce per-module access gates without an extra DB query.
          req.expiredModules = userModules.filter(m => !activeModules.includes(m));
          req.client = client;
        }
      }

      // ── 4. Viewer expiry check ────────────────────────────────────────────
      if (user.userType === "viewer" && user.viewerExpiryDate) {
        if (new Date() > new Date(user.viewerExpiryDate)) {
          return res.status(403).json({ message: "Your viewer access has expired" });
        }
      }

      // ── 5. Attach to request ──────────────────────────────────────────────
      req.user = {
        _id: user._id,
        id: user._id.toString(),
        email: user.email,
        userName: user.userName,
        userType: user.userType,
        clientId: user.clientId,
        permissions: user.permissions,
        companyName: user.companyName,
        sandbox: user.sandbox === true,
        assessmentLevel: user.assessmentLevel || [],
        department: user.department,
        location: user.location,
        accessControls: user.accessControls,
        // 🆕 Module access — which product modules this user can access
        accessibleModules: user.accessibleModules && user.accessibleModules.length > 0
          ? user.accessibleModules
          : ['zero_carbon'],
      };

      req.sessionId = decoded.sessionId; // ← available to logout controller

      next();

    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ message: "Token expired" });
      }
      if (err.name === 'JsonWebTokenError') {
        return res.status(401).json({ message: "Invalid token" });
      }
      throw err;
    }

  } catch (error) {
    console.error("Auth middleware error:", error);
    return res.status(500).json({
      message: "Authentication error",
      error: error.message
    });
  }
};

// ── Role-based middleware ─────────────────────────────────────────────────

const checkRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    if (!allowedRoles.includes(req.user.userType)) {
      return res.status(403).json({
        message: `Access denied. Required roles: ${allowedRoles.join(', ')}`
      });
    }
    next();
  };
};

// ── Permission-based middleware ───────────────────────────────────────────

const checkPermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    if (!req.user.permissions || !req.user.permissions[permission]) {
      return res.status(403).json({
        message: `Access denied. Missing permission: ${permission}`
      });
    }
    next();
  };
};

/**
 * `authenticate` — duplicate variant used by some controllers directly.
 * Patched with the same session liveness check as `auth`.
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.header('Authorization');
    const token = authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.substring(7)
      : authHeader;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.'
      });
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const userId = decoded.userId || decoded.id;
      const user = await User.findById(userId).select('-password');

      if (!user) {
        return res.status(401).json({ success: false, message: 'Invalid token. User not found.' });
      }

      const isSandboxUser = user.sandbox === true;

      if (!user.isActive && !isSandboxUser) {
        return res.status(401).json({ success: false, message: 'Account is deactivated.' });
      }

      // ── Session liveness check (mirrors `auth` above) ───────────────────
      if (!decoded.sessionId) {
        return res.status(401).json({
          success: false,
          message: 'Session invalid. Please log in again.',
          code: 'SESSION_MISSING'
        });
      }

      const session = await UserSession.findOne({
        sessionId: decoded.sessionId,
        userId: user._id,
        isActive: true
      });

      if (!session) {
        return res.status(401).json({
          success: false,
          message: 'Session is no longer valid. Please log in again.',
          code: 'SESSION_EXPIRED'
        });
      }

      UserSession.updateOne(
        { sessionId: decoded.sessionId },
        { $set: { lastSeen: new Date() } }
      ).exec().catch(err =>
        console.error('[AUTHENTICATE] lastSeen update failed:', err.message)
      );
      // ────────────────────────────────────────────────────────────────────

      req.user = user;
      req.sessionId = decoded.sessionId;
      next();

    } catch (jwtError) {
      console.error('JWT verification error:', jwtError.message);
      return res.status(401).json({ success: false, message: 'Invalid token.' });
    }

  } catch (error) {
    console.error('Authentication middleware error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error during authentication.'
    });
  }
};

// ── Remaining helpers — UNCHANGED ─────────────────────────────────────────

const authorize = (roles = []) => {
  if (typeof roles === 'string') roles = [roles];

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    if (roles.length && !roles.includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Insufficient permissions.',
        requiredRoles: roles,
        userRole: req.user.userType
      });
    }
    next();
  };
};

const enforceClientAccess = (req, res, next) => {
  const { clientId } = req.params;
  const user = req.user;

  if (user.userType === 'super_admin') return next();

  if (['consultant_admin', 'consultant'].includes(user.userType)) return next();

  if (['client_admin', 'client_employee_head', 'employee', 'auditor'].includes(user.userType)) {
    if (user.clientId !== clientId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only access data from your own organization.',
        yourClientId: user.clientId,
        requestedClientId: clientId
      });
    }
  }

  next();
};

const adminOnly = (req, res, next) => {
  const allowedRoles = ['super_admin', 'client_admin'];
  if (!req.user || !allowedRoles.includes(req.user.userType)) {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Admin privileges required.'
    });
  }
  next();
};

const superAdminOnly = (req, res, next) => {
  if (!req.user || req.user.userType !== 'super_admin') {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Super admin privileges required.'
    });
  }
  next();
};

const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.header('Authorization');
    const token = authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.substring(7)
      : authHeader;

    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.userId || decoded.id;
        const user = await User.findById(userId).select('-password');
        const isSandboxUser = user && user.sandbox === true;

        if (user && (user.isActive || isSandboxUser)) {
          req.user = user;
        }
      } catch (jwtError) {
        console.log('Optional auth: Invalid token provided');
      }
    }

    next();
  } catch (error) {
    console.error('Optional auth middleware error:', error);
    next();
  }
};

module.exports = {
  auth,
  checkRole,
  checkPermission,
  authenticate,
  authorize,
  enforceClientAccess,
  adminOnly,
  superAdminOnly,
  optionalAuth
};