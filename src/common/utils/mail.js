// util/mail.js
require("dotenv").config(); // ← keep this as the very first line

const nodemailer = require("nodemailer");

// Use Gmail’s built-in "gmail" service shorthand
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER, // e.g. greonxpert@gmail.com
    pass: process.env.EMAIL_PASS, // the 16-char App Password (no spaces)
  },
});

// ✅ Helpers (added) — does NOT affect other parts
const looksLikeHtml = (s) => {
  if (!s) return false;
  const str = String(s).trim();
  return (
    str.startsWith("<!DOCTYPE") ||
    str.startsWith("<html") ||
    /<\/?[a-z][\s\S]*>/i.test(str) // contains HTML tags
  );
};

const stripHtmlToText = (html) => {
  if (!html) return "";
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/p>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
};

// ✅ UPDATED: supports both text + html (backward compatible)
const sendMail = async (receiver, subject, message, htmlMessage) => {
  try {
    // If htmlMessage is provided, use it.
    // Else if message itself looks like HTML, treat message as HTML.
    const html = htmlMessage || (looksLikeHtml(message) ? String(message) : null);

    // Always generate a text fallback (best practice)
    const text = html ? stripHtmlToText(html) : String(message || "");

    const info = await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: receiver,
      subject,
      text,
      ...(html ? { html } : {}),
    });

    console.log("Email sent successfully:", info?.messageId || info);
    return true;
  } catch (err) {
    console.log("Error sending email:", err);
    return false;
  }
};

const randomPassGen = (length) => {
  const characters =
    "idnhb4j5n3mvbaj285nbhskcnah475nvbghadfiekmba75001nvgr";
  let result = "";
  const charLength = characters.length;
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charLength));
  }
  return result;
};

module.exports = { sendMail, randomPassGen };
