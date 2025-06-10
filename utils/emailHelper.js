// utils/emailHelper.js
const { emailQueue } = require("./emailQueue");

module.exports.notifyConsultant = (consultantEmail, clientDetails) => {
  return emailQueue.add("notifyConsultant", {
    consultantEmail,
    ...clientDetails
  });
};

module.exports.notifySuperAdmin = (superAdminEmail, clientDetails) => {
  return emailQueue.add("sendSuperAdminLeadEmail", {
    superAdminEmail,
    ...clientDetails
  });
};
// utils/emailHelper.js
const { sendMail } = require("../utils/mail");

/**
 * Send a “Lead Created” email to the Super Admin.
 *
 * @param {Object} clientObj           The Mongoose document for the newly created client.
 * @param {string} performedByUsername userName of whoever created the lead.
 */
async function sendLeadCreatedEmail(clientObj, performedByUsername) {
  // Super‐admin’s address (set in .env or fallback)
  const superAdminEmail = process.env.SUPER_ADMIN_EMAIL || "superadmin@yourcompany.com";

  // Build a plain‐text body with \n line breaks
  const messageLines = [
    "New Lead Created in ZeroCarbon",
    "-----------------------------",
    `Client ID:       ${clientObj.clientId}`,
    `Company Name:    ${clientObj.leadInfo.companyName}`,
    `Contact Person:  ${clientObj.leadInfo.contactPersonName}`,
    `Email:           ${clientObj.leadInfo.email}`,
    `Mobile Number:   ${clientObj.leadInfo.mobileNumber}`,
    `Lead Source:     ${clientObj.leadInfo.leadSource || "-"}`,
    `Notes:           ${clientObj.leadInfo.notes || "-"}`,
    `Created By:      ${performedByUsername}`,
    `Created At:      ${new Date(clientObj.createdAt).toLocaleString()}`,
    "",
    "Log in to ZeroCarbon dashboard for more details."
  ];
  const plainTextBody = messageLines.join("\n");

  // Call sendMail(receiver, subject, message)
  const subject = `📬 New Lead #${clientObj.clientId} Created`;
  await sendMail(superAdminEmail, subject, plainTextBody);
}

/**
 * Send a “Lead Assigned” email to the Consultant.
 *
 * @param {Object} consultantUser       A Mongoose User object with fields { email, userName }.
 * @param {Object} clientObj            The Mongoose document for the newly created client.
 * @param {string} assignedByUsername   userName of whoever performed the assignment.
 */
async function sendConsultantAssignedEmail(consultantUser, clientObj, assignedByUsername) {
  const consultantEmail = consultantUser.email;
  const messageLines = [
    `Hello ${consultantUser.userName},`,
    "",
    "You have been assigned a new lead in ZeroCarbon:",
    "----------------------------------------------",
    `Client ID:       ${clientObj.clientId}`,
    `Company Name:    ${clientObj.leadInfo.companyName}`,
    `Contact Person:  ${clientObj.leadInfo.contactPersonName}`,
    `Email:           ${clientObj.leadInfo.email}`,
    `Mobile Number:   ${clientObj.leadInfo.mobileNumber}`,
    `Current Stage:   ${clientObj.stage}`,
    `Notes:           ${clientObj.leadInfo.notes || "-"}`,
    `Assigned By:     ${assignedByUsername}`,
    `Assigned At:     ${new Date().toLocaleString()}`,
    "",
    "Please log in to your consultant dashboard to follow up on this lead."
  ];
  const plainTextBody = messageLines.join("\n");

  const subject = `📬 New Lead Assigned: ${clientObj.clientId}`;
  await sendMail(consultantEmail, subject, plainTextBody);
}

module.exports = {
  sendLeadCreatedEmail,
  sendConsultantAssignedEmail
};
