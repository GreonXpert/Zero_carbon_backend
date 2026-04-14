// utils/notifications/supportNotifications.js
// Support team lifecycle notifications (in-app + email)

function tryRequire(paths) {
  for (const p of paths) {
    try {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      return require(p);
    } catch (e) { /* continue */ }
  }
  return null;
}

// Prefer correct relative paths (if this file is inside utils/notifications/)
const Notification = tryRequire([
  "../../models/Notification/Notification",
  "././models/Notification/Notification",
]);
const User = tryRequire([
  "../../models/User",
  "././models/User",
]);
const Client = tryRequire([
  "../../models/CMS/Client",
  "././models/CMS/Client",
]);

const mailMod = tryRequire([
  "../mail",
  "../../utils/mail",
  "././utils/mail",
  "./mail",
]);
const sendMail = mailMod?.sendMail;

const getFrontendUrl = () =>
  process.env.FRONTEND_URL || "https://zerocarbon.greonxpert.com";

const safeId = (x) => (x?._id ? String(x._id) : x?.id ? String(x.id) : x ? String(x) : null);

async function createSystemNotification({
  title,
  message,
  priority = "medium",
  createdBy,
  creatorType,
  targetUsers = [],
  targetClients = [],
  systemAction,
  relatedEntity,
  metadata = {},
}) {
  if (!Notification) return null;

  const notification = new Notification({
    title,
    message,
    priority,
    createdBy,
    creatorType,
    targetUsers,
    targetClients,
    status: "published",
    publishedAt: new Date(),
    isSystemNotification: true,
    systemAction: systemAction || "support_update",
    relatedEntity: relatedEntity || null,
    metadata,
  });

  await notification.save();

  if (global.broadcastNotification) {
    await global.broadcastNotification(notification);
  }

  return notification;
}

function buildEmailTemplate({ heading, intro, blocks = [], cta }) {
  const contentBlocks = blocks
    .map(
      (b) => `
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin:12px 0;">
        ${b}
      </div>`
    )
    .join("");

  const ctaHtml = cta?.url
    ? `
      <div style="text-align:center;margin:18px 0;">
        <a href="${cta.url}" style="display:inline-block;background:#0ea5e9;color:#fff;padding:10px 18px;text-decoration:none;border-radius:8px;">
          ${cta.label || "Open ZeroCarbon"}
        </a>
      </div>`
    : "";

  return `<!DOCTYPE html>
  <html>
    <body style="font-family:Arial,sans-serif;background:#f3f4f6;margin:0;padding:18px;">
      <div style="max-width:640px;margin:0 auto;">
        <div style="background:#0f172a;color:#fff;padding:18px;border-radius:12px 12px 0 0;">
          <h2 style="margin:0;font-size:18px;">${heading}</h2>
        </div>

        <div style="background:#ffffff;border:1px solid #e5e7eb;border-top:none;padding:18px;border-radius:0 0 12px 12px;">
          <p style="margin:0 0 12px 0;color:#111827;">${intro}</p>
          ${contentBlocks}
          ${ctaHtml}

          <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;" />
          <p style="margin:0;color:#6b7280;font-size:12px;text-align:center;">
            ZeroCarbon Platform • Automated message — please do not reply
          </p>
        </div>
      </div>
    </body>
  </html>`;
}

async function sendEmailToUserIds(userIds, subject, html, text) {
  if (!sendMail || !User || !userIds?.length) return;

  const stripHtmlToText = (h) =>
    String(h || "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const users = await User.find({ _id: { $in: userIds } })
    .select("email userName")
    .lean();

  for (const u of users) {
    if (!u?.email) continue;

    try {
      const plain = text || stripHtmlToText(html);

      // ✅ Works even if sendMail supports 3 args or 4 args
      if (sendMail.length >= 4) {
        await sendMail(u.email, subject, plain, html);
      } else {
        // fallback for legacy 3-arg sendMail
        await sendMail(u.email, subject, html);
      }
    } catch (e) {
      console.error("[SUPPORT NOTIF] Email failed:", u.email, e.message);
    }
  }
}


// Add this small helper near top of supportNotifications.js (safe addition)
const escapeHtml = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

// ======================================================
// 1) WELCOME (SupportManager / Support)
// ======================================================
async function notifySupportManagerWelcome({ actor, supportManager, tempPassword }) {
  try {
    const smId = safeId(supportManager);
    if (!smId) return;

    const title = "Welcome to ZeroCarbon Support";
    const message =
      `Hi ${supportManager.userName || "Support Manager"}, your Support Manager account is ready.\n` +
      `Team: ${supportManager.supportTeamName || "N/A"}\n` +
      `Type: ${supportManager.supportManagerType || "N/A"}`;

    await createSystemNotification({
      title,
      message,
      priority: "medium",
      createdBy: safeId(actor?.id || actor?._id || actor) || smId,
      creatorType: actor?.userType || "system",
      targetUsers: [smId],
      systemAction: "support_manager_created",
      relatedEntity: { type: "user", id: smId },
      metadata: { userType: "supportManager" },
    });

    const loginUrl = `${getFrontendUrl()}/login`;

    const html = buildEmailTemplate({
      heading: "Welcome — Support Manager Account Created",
      intro: `Hi ${supportManager.userName || "Support Manager"}, your Support Manager access is now active.`,
      blocks: [
        `<p style="margin:0;"><b>Team</b>: ${escapeHtml(supportManager.supportTeamName || "N/A")}</p>
         <p style="margin:6px 0 0 0;"><b>Type</b>: ${escapeHtml(supportManager.supportManagerType || "N/A")}</p>`,

        `<p style="margin:0;"><b>Login Email</b>: ${escapeHtml(supportManager.email || "N/A")}</p>
         <p style="margin:6px 0 0 0;"><b>Password</b>: ${tempPassword ? escapeHtml(tempPassword) : "Set by admin"}</p>
         <p style="margin:6px 0 0 0;"><b>Login URL</b>: <a href="${loginUrl}">${loginUrl}</a></p>`,
      ],
      cta: { url: loginUrl, label: "Login" },
    });

    await sendEmailToUserIds([smId], "Welcome to ZeroCarbon Support (Manager)", html);
  } catch (e) {
    console.error("[SUPPORT NOTIF] notifySupportManagerWelcome:", e.message);
  }
}

async function notifySupportUserWelcome({ actor, supportUser, supportManager, tempPassword }) {
  try {
    const suId = safeId(supportUser);
    const smId = safeId(supportManager || supportUser?.supportManagerId);
    if (!suId) return;

    // notify the support user
    await createSystemNotification({
      title: "Welcome to ZeroCarbon Support",
      message:
        `Hi ${supportUser.userName || "Support User"}, your Support account is ready.\n` +
        `Manager: ${supportManager?.userName || "N/A"}\n` +
        `Team: ${supportManager?.supportTeamName || supportUser.supportTeamName || "N/A"}`,
      priority: "medium",
      createdBy: safeId(actor?.id || actor?._id || actor) || suId,
      creatorType: actor?.userType || "system",
      targetUsers: [suId],
      systemAction: "support_user_created",
      relatedEntity: { type: "user", id: suId },
      metadata: { userType: "support" },
    });

    const loginUrl = `${getFrontendUrl()}/login`;

    const html = buildEmailTemplate({
      heading: "Welcome — Support Account Created",
      intro: `Hi ${supportUser.userName || "Support User"}, your Support account is now active.`,
      blocks: [
        `<p style="margin:0;"><b>Team</b>: ${escapeHtml(
          supportManager?.supportTeamName || supportUser.supportTeamName || "N/A"
        )}</p>
         <p style="margin:6px 0 0 0;"><b>Manager</b>: ${escapeHtml(supportManager?.userName || "N/A")}</p>`,

        `<p style="margin:0;"><b>Login Email</b>: ${escapeHtml(supportUser.email || "N/A")}</p>
         <p style="margin:6px 0 0 0;"><b>Password</b>: ${tempPassword ? escapeHtml(tempPassword) : "Set by admin"}</p>
         <p style="margin:6px 0 0 0;"><b>Login URL</b>: <a href="${loginUrl}">${loginUrl}</a></p>`,
      ],
      cta: { url: loginUrl, label: "Login" },
    });

    await sendEmailToUserIds([suId], "Welcome to ZeroCarbon Support", html);

    // notify the support manager that a new support user joined (existing logic continues)
    if (smId) {
      // keep your existing manager notification block below unchanged
    }
  } catch (e) {
    console.error("[SUPPORT NOTIF] notifySupportUserWelcome:", e.message);
  }
}


// ======================================================
// 2) ASSIGNMENTS (clients/consultants → supportManager)
// ======================================================
async function notifySupportManagerAssignmentsUpdated({
  actor,
  supportManager,
  clientsAdded = [],
  consultantsAdded = [],
}) {
  try {
    const smId = safeId(supportManager);
    if (!smId) return;

    const title = "Support Assignments Updated";
    const message =
      `Assignments updated for your team.\n` +
      `Clients added: ${clientsAdded.length}\n` +
      `Consultants added: ${consultantsAdded.length}`;

    await createSystemNotification({
      title,
      message,
      priority: "medium",
      createdBy: safeId(actor?.id || actor?._id || actor) || smId,
      creatorType: actor?.userType || "system",
      targetUsers: [smId],
      systemAction: "support_manager_assignments_updated",
      relatedEntity: { type: "user", id: smId },
      metadata: { clientsAdded, consultantsAdded },
    });

    const html = buildEmailTemplate({
      heading: "Assignments Updated",
      intro: `Hi ${supportManager.userName || "Support Manager"}, your assignments were updated.`,
      blocks: [
        `<p style="margin:0;"><b>Clients added</b>: ${clientsAdded.length}</p>
         <p style="margin:6px 0 0 0;"><b>Consultants added</b>: ${consultantsAdded.length}</p>`,
      ],
      cta: { url: `${getFrontendUrl()}/support/assignments`, label: "View Assignments" },
    });

    await sendEmailToUserIds([smId], "ZeroCarbon: Support assignments updated", html);
  } catch (e) {
    console.error("[SUPPORT NOTIF] notifySupportManagerAssignmentsUpdated:", e.message);
  }
}

// ======================================================
// 3) DELETIONS + TRANSFERS
// ======================================================
async function notifySupportManagerDeleted({
  actor,
  deletedManager,
  transferToManager,
  movedSupportUsers = [],
}) {
  try {
    const delId = safeId(deletedManager);
    const toId = safeId(transferToManager);
    if (!delId) return;

    // email + in-app to deleted manager
    await createSystemNotification({
      title: "Account Deactivated",
      message:
        `Your Support Manager account has been deactivated.\n` +
        (toId ? `Team transferred to: ${transferToManager.userName || toId}` : ""),
      priority: "high",
      createdBy: safeId(actor?.id || actor?._id || actor) || delId,
      creatorType: actor?.userType || "system",
      targetUsers: [delId],
      systemAction: "support_manager_deleted",
      relatedEntity: { type: "user", id: delId },
      metadata: { transferToSupportManagerId: toId, movedSupportUsersCount: movedSupportUsers.length },
    });

    const htmlDel = buildEmailTemplate({
      heading: "Account Deactivated (Support Manager)",
      intro: `Hi ${deletedManager.userName || "Support Manager"}, your account has been deactivated.`,
      blocks: [
        `<p style="margin:0;"><b>Reason</b>: ${(actor?.reason || "Administrative action")}</p>
         <p style="margin:6px 0 0 0;"><b>Team moved</b>: ${movedSupportUsers.length}</p>
         ${toId ? `<p style="margin:6px 0 0 0;"><b>New Manager</b>: ${transferToManager.userName || toId}</p>` : ""}`,
      ],
      cta: { url: `${getFrontendUrl()}/support/help`, label: "Contact Support" },
    });

    await sendEmailToUserIds([delId], "ZeroCarbon: Support Manager account deactivated", htmlDel);

    // notify new manager
    if (toId) {
      await createSystemNotification({
        title: "Support Team Updated",
        message:
          `Support users have been transferred to your team.\n` +
          `Transferred users: ${movedSupportUsers.length}`,
        priority: "medium",
        createdBy: safeId(actor?.id || actor?._id || actor) || toId,
        creatorType: actor?.userType || "system",
        targetUsers: [toId],
        systemAction: "support_users_transferred_to_manager",
        relatedEntity: { type: "user", id: toId },
        metadata: { movedSupportUsers },
      });

      const htmlTo = buildEmailTemplate({
        heading: "Support Users Transferred to Your Team",
        intro: `Hi ${transferToManager.userName || "Support Manager"}, support users were transferred to your team.`,
        blocks: [
          `<p style="margin:0;"><b>Transferred users</b>: ${movedSupportUsers.length}</p>`,
        ],
        cta: { url: `${getFrontendUrl()}/support/team`, label: "View Team" },
      });

      await sendEmailToUserIds([toId], "ZeroCarbon: Support users transferred to your team", htmlTo);

      // optional: notify moved support users about new manager
      if (movedSupportUsers.length) {
        await createSystemNotification({
          title: "Team Updated",
          message: `Your support team manager has changed to ${transferToManager.userName || "a new manager"}.`,
          priority: "low",
          createdBy: safeId(actor?.id || actor?._id || actor) || toId,
          creatorType: actor?.userType || "system",
          targetUsers: movedSupportUsers.map(String),
          systemAction: "support_user_manager_changed_due_to_transfer",
          relatedEntity: { type: "user", id: toId },
          metadata: { newSupportManagerId: toId },
        });
      }
    }
  } catch (e) {
    console.error("[SUPPORT NOTIF] notifySupportManagerDeleted:", e.message);
  }
}

async function notifySupportUserDeleted({
  actor,
  deletedSupportUser,
  transferToSupportUser,
  transferredClientIds = [],
}) {
  try {
    const delId = safeId(deletedSupportUser);
    const toId = safeId(transferToSupportUser);
    if (!delId) return;

    // notify deleted support user
    await createSystemNotification({
      title: "Account Deactivated",
      message:
        `Your Support account has been deactivated.\n` +
        (toId ? `Clients transferred to: ${transferToSupportUser.userName || toId}` : ""),
      priority: "high",
      createdBy: safeId(actor?.id || actor?._id || actor) || delId,
      creatorType: actor?.userType || "system",
      targetUsers: [delId],
      systemAction: "support_user_deleted",
      relatedEntity: { type: "user", id: delId },
      metadata: { transferToSupportUserId: toId, transferredClientCount: transferredClientIds.length },
    });

    const htmlDel = buildEmailTemplate({
      heading: "Account Deactivated (Support User)",
      intro: `Hi ${deletedSupportUser.userName || "Support User"}, your account has been deactivated.`,
      blocks: [
        `<p style="margin:0;"><b>Transferred clients</b>: ${transferredClientIds.length}</p>
         ${toId ? `<p style="margin:6px 0 0 0;"><b>New owner</b>: ${transferToSupportUser.userName || toId}</p>` : ""}`,
      ],
      cta: { url: `${getFrontendUrl()}/support/help`, label: "Contact Support" },
    });

    await sendEmailToUserIds([delId], "ZeroCarbon: Support account deactivated", htmlDel);

    // notify transferee about received clients
    if (toId && transferredClientIds.length) {
      await createSystemNotification({
        title: "Clients Transferred to You",
        message: `New clients were transferred to you. Count: ${transferredClientIds.length}`,
        priority: "medium",
        createdBy: safeId(actor?.id || actor?._id || actor) || toId,
        creatorType: actor?.userType || "system",
        targetUsers: [toId],
        systemAction: "support_clients_transferred_to_user",
        relatedEntity: { type: "user", id: toId },
        metadata: { transferredClientIds },
      });

      const htmlTo = buildEmailTemplate({
        heading: "Clients Transferred to You",
        intro: `Hi ${transferToSupportUser.userName || "Support User"}, clients were transferred to your queue.`,
        blocks: [
          `<p style="margin:0;"><b>Clients count</b>: ${transferredClientIds.length}</p>`,
        ],
        cta: { url: `${getFrontendUrl()}/support/clients`, label: "View Clients" },
      });

      await sendEmailToUserIds([toId], "ZeroCarbon: Clients transferred to you", htmlTo);
    }
  } catch (e) {
    console.error("[SUPPORT NOTIF] notifySupportUserDeleted:", e.message);
  }
}

async function notifySupportUserTransferredToManager({
  actor,
  supportUser,
  oldManagerId,
  newSupportManager, // doc with _id, userName, supportTeamName, supportManagerType
  reason,
}) {
  try {
    const supportUserId = safeId(supportUser);
    const newManagerId = safeId(newSupportManager);
    const oldId = safeId(oldManagerId);

    if (!supportUserId || !newManagerId) return;

    // 1) Notify NEW manager (in-app + email)
    await createSystemNotification({
      title: "New Support User Assigned",
      message:
        `${supportUser.userName || "A support user"} has been assigned to your team.\n` +
        `Email: ${supportUser.email || "N/A"}\n` +
        `Reason: ${reason || "N/A"}`,
      priority: "medium",
      createdBy: safeId(actor?.id || actor?._id || actor) || newManagerId,
      creatorType: actor?.userType || "system",
      targetUsers: [newManagerId],
      systemAction: "support_user_transferred_in",
      relatedEntity: { type: "user", id: supportUserId },
      metadata: {
        supportUserId,
        oldSupportManagerId: oldId,
        newSupportManagerId: newManagerId,
        reason: reason || null,
      },
    });

    const htmlNewMgr = buildEmailTemplate({
      heading: "New Support User Assigned to Your Team",
      intro: `Hi ${newSupportManager.userName || "Support Manager"}, a support user has been transferred to your team.`,
      blocks: [
        `<p style="margin:0;"><b>User</b>: ${supportUser.userName || "N/A"} (${supportUser.email || "N/A"})</p>
         <p style="margin:6px 0 0 0;"><b>Team</b>: ${newSupportManager.supportTeamName || "N/A"}</p>
         <p style="margin:6px 0 0 0;"><b>Reason</b>: ${reason || "N/A"}</p>`,
      ],
      cta: { url: `${getFrontendUrl()}/support/team`, label: "View Team" },
    });

    await sendEmailToUserIds(
      [newManagerId],
      "ZeroCarbon: New support user assigned",
      htmlNewMgr
    );

    // 2) Notify SUPPORT USER (in-app + email)
    await createSystemNotification({
      title: "Team Updated",
      message:
        `You have been transferred to a new Support Manager.\n` +
        `Manager: ${newSupportManager.userName || "N/A"}\n` +
        `Team: ${newSupportManager.supportTeamName || "N/A"}\n` +
        `Reason: ${reason || "N/A"}`,
      priority: "medium",
      createdBy: safeId(actor?.id || actor?._id || actor) || supportUserId,
      creatorType: actor?.userType || "system",
      targetUsers: [supportUserId],
      systemAction: "support_user_transferred_notice",
      relatedEntity: { type: "user", id: newManagerId },
      metadata: {
        oldSupportManagerId: oldId,
        newSupportManagerId: newManagerId,
        reason: reason || null,
      },
    });

    const htmlUser = buildEmailTemplate({
      heading: "Your Support Team Has Changed",
      intro: `Hi ${supportUser.userName || "Support User"}, your support manager has been updated.`,
      blocks: [
        `<p style="margin:0;"><b>New Manager</b>: ${newSupportManager.userName || "N/A"}</p>
         <p style="margin:6px 0 0 0;"><b>Team</b>: ${newSupportManager.supportTeamName || "N/A"}</p>
         <p style="margin:6px 0 0 0;"><b>Reason</b>: ${reason || "N/A"}</p>`,
      ],
      cta: { url: `${getFrontendUrl()}/login`, label: "Open ZeroCarbon" },
    });

    await sendEmailToUserIds(
      [supportUserId],
      "ZeroCarbon: Your support manager changed",
      htmlUser
    );

    // 3) OPTIONAL: notify OLD manager (if exists)
    if (oldId) {
      await createSystemNotification({
        title: "Support User Transferred Out",
        message:
          `${supportUser.userName || "A support user"} has been transferred out of your team.\n` +
          `New manager: ${newSupportManager.userName || "N/A"}\n` +
          `Reason: ${reason || "N/A"}`,
        priority: "low",
        createdBy: safeId(actor?.id || actor?._id || actor) || oldId,
        creatorType: actor?.userType || "system",
        targetUsers: [oldId],
        systemAction: "support_user_transferred_out",
        relatedEntity: { type: "user", id: supportUserId },
        metadata: {
          oldSupportManagerId: oldId,
          newSupportManagerId: newManagerId,
          reason: reason || null,
        },
      });
    }
  } catch (e) {
    console.error("[SUPPORT NOTIF] notifySupportUserTransferredToManager:", e.message);
  }
}

module.exports = {
  notifySupportManagerWelcome,
  notifySupportUserWelcome,
  notifySupportManagerAssignmentsUpdated,
  notifySupportManagerDeleted,
  notifySupportUserDeleted,
  notifySupportUserTransferredToManager
};
