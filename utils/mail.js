// util/mail.js
require("dotenv").config(); // ← make sure this is the very first line

const nodemailer = require("nodemailer");

// Use Gmail’s built-in "gmail" service shorthand
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,     // e.g. greonxpert@gmail.com
    pass: process.env.EMAIL_PASS      // the 16-char App Password (no spaces)
  }
});

const sendMail = async (receiver, subject, message) => {
  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: receiver,
      subject,
      text: message
    });
    console.log("Email sent successfully:", info);
    return true;
  } catch (err) {
    console.log("Error sending email:", err);
    return false;
  }
};

const randomPassGen = (length) => {
  const characters = "idnhb4j5n3mvbaj285nbhskcnah475nvbghadfiekmba75001nvgr";
  let result = "";
  const charLength = characters.length;
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charLength));
  }
  return result;
};

module.exports = { sendMail, randomPassGen };