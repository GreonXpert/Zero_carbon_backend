const { randomPassGen, sendMail } = require("../utils/mail");
const User = require("../models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Generate a new random password
    const newPassword = randomPassGen(8);
    const salt = bcrypt.genSaltSync(10);
    const hashedPassword = bcrypt.hashSync(newPassword, salt);

    // Send email to the user
    const subject = "Forgot Password Request";
    const message = `your new password is: ${newPassword}`;

    const emailSent = await sendMail(user.email, subject, message);

    if (!emailSent) {
      return res
        .status(500)
        .json({ message: "Failed to send email. Please try again later." });
    }

    // Update the user's password
    user.password = hashedPassword;
    await user.save();

    res.status(200).json({
      success: true,
      message: "A new password has been sent to your registered email address.",
    });
  } catch (error) {
    console.error("Forgot Password Error:", error);
    res
      .status(500)
      .json({ message: "An error occurred. Please try again later." });
  }
};

module.exports = { forgotPassword };
