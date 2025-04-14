const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Form = require("../models/Form");
const { sendMail } = require("../utils/mail");

// Parse ALLOWED_ADMIN_EMAILS from environment variables
const allowedAdminEmails = process.env.ALLOWED_ADMIN_EMAILS
  ? process.env.ALLOWED_ADMIN_EMAILS.split(",") // Split the string into an array
  : [];

  // Registration for normal users and consultants only.
// Admin accounts are created via environment variables.
  const registerUser = async (req, res, next) => {
    try {
      const {
        email,
        password,
        contactNumber,
        userName,
        userType,
        address,
        companyName, // for user registration only
        employeeId,  // consultant only
        jobRole,     // consultant only
        branch,      // consultant only
      } = req.body;
  
      // Common required fields
      if (!email || !password || !contactNumber || !userName || !userType || !address) {
        return res
          .status(400)
          .json({ message: "Please provide all required fields" });
      }
  
      // Prevent registering admin via the endpoint
      if (userType === "admin") {
        return res
          .status(403)
          .json({ message: "Admin account cannot be registered through this endpoint" });
      }
  
      // For consultant, require extra fields
      if (userType === "consultant") {
        if (!employeeId || !jobRole || !branch) {
          return res.status(400).json({
            message: "Please provide employeeId, jobRole, and branch for consultant registration",
          });
        }
      }
  
      // For consultant, override companyName to default
      let finalCompanyName = companyName;
      if (userType === "consultant") {
        finalCompanyName = "Greonxpert Pvt Ltd";
      }
  
      // Check if a user exists with the same email or userName
      const existingUser = await User.findOne({
        $or: [{ email }, { userName }],
      });
      if (existingUser) {
        return res.status(409).json({ message: "Email or UserName already in use" });
      }
  
      // Hash password
      const hashedPassword = bcrypt.hashSync(password, 10);
  
      const newUserData = {
        email,
        password: hashedPassword,
        contactNumber,
        userName,
        userType,
        address,
        companyName: finalCompanyName,
        isFirstLogin: true,
      };
  
      // Add consultant extra fields if applicable
      if (userType === "consultant") {
        newUserData.employeeId = employeeId;
        newUserData.jobRole = jobRole;
        newUserData.branch = branch;
      }
  
      const user = new User(newUserData);
      await user.save();
      res.status(201).json({ message: "User registered successfully" });
    } catch (error) {
      res
        .status(500)
        .json({ error: error.message, message: "Registration Failed" });
    }
  };
  

// =========================
// LOGIN FUNCTION
// =========================
// The login function now returns a JWT token with all user data (except the password) in its payload.

  const login = async (req, res, next) => {
    try {
      const { login: loginIdentifier, password } = req.body;
  
      if (!loginIdentifier || !password) {
        return res.status(400).json({ message: "Please provide a login identifier and password" });
      }
  
      // Find a user by email or userName
      const user = await User.findOne({
        $or: [{ email: loginIdentifier }, { userName: loginIdentifier }],
      });
      if (!user) return res.status(404).json({ message: "User not found" });
  
      const isMatch = bcrypt.compareSync(password, user.password);
      if (!isMatch)
        return res.status(400).json({ message: "Invalid credentials" });
  
      // If it's the user's first login, update 'isFirstLogin' to false
      if (user.isFirstLogin) {
        user.isFirstLogin = false;
        await user.save();
      }
  
      // Prepare user data for the token payload, excluding password
      const userPayload = {
        id: user._id,
        email: user.email,
        contactNumber: user.contactNumber,
        userName: user.userName,
        userType: user.userType,
        address: user.address,
        companyName: user.companyName,
        role: user.role,
        employeeId: user.employeeId,
        jobRole: user.jobRole,
        branch: user.branch,
        isFirstLogin: user.isFirstLogin,
      };
  
      // Generate JWT token valid for 24 hours with full user data in the payload
      const token = jwt.sign(userPayload, process.env.JWT_SECRET, {
        expiresIn: "24h",
      });
  
      res.status(200).json({
        user: userPayload,
        token,
        message: "Login successful",
      });
      console.log("Login successful");
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };


  const getUsersWithUserTypeUser = async (req, res) => {
    try {
      if (!req.user || !["admin", "consultant"].includes(req.user.userType)) {
        return res.status(403).json({ message: "Access denied. Only admin or consultant can view this data." });
      }
      const users = await User.find({ userType: "user" });
      if (!users.length) {
        return res.status(404).json({
          message: "No users with userType 'user' found.",
        });
      }
      res.status(200).json({
        success: true,
        data: users,
      });
    } catch (error) {
      console.log("error:", error);
      res.status(500).json({
        success: false,
        message: "An error occurred while fetching users.",
        error: error.message,
      });
    }
  };

// =========================
// UPDATE USER (EDIT)
// =========================
// Only admin can update a user.

  const updateUser = async (req, res) => {
    try {
      if (!req.user || req.user.userType !== "admin") {
        return res.status(403).json({ message: "Access denied. Only admin can update user details." });
      }
      const { id } = req.params; // User id to update
      const updateData = req.body;
      if (updateData.password) {
        updateData.password = bcrypt.hashSync(updateData.password, 10);
      }
      const updatedUser = await User.findByIdAndUpdate(id, updateData, { new: true });
      if (!updatedUser) {
        return res.status(404).json({ message: "User not found." });
      }
      res.status(200).json({ message: "User updated successfully.", data: updatedUser });
    } catch (error) {
      res.status(500).json({ error: error.message, message: "Failed to update user." });
    }
  };


// =========================
// DELETE USER
// =========================
// Only admin can delete a user.
  const deleteUser = async (req, res) => {
    try {
      if (!req.user || req.user.userType !== "admin") {
        return res.status(403).json({ message: "Access denied. Only admin can delete users." });
      }
      const { id } = req.params;
      const deletedUser = await User.findByIdAndDelete(id);
      if (!deletedUser) {
        return res.status(404).json({ message: "User not found." });
      }
      res.status(200).json({ message: "User deleted successfully.", data: deletedUser });
    } catch (error) {
      res.status(500).json({ error: error.message, message: "Failed to delete user." });
    }
  };
  


// =========================
// FORM SUBMISSION FUNCTION
// =========================

const formSubmission = async (req, res) => {
  try {
    const { formData, userId } = req.body;

    // Save form data
    const form = new Form({ ...formData, userId });
    await form.save();

    // Update user login status
    const user = await User.findById(userId);
    user.isFirstLogin = false;
    await user.save();

    // Fetch admin and superAdmin emails
     // Fetch admin emails for notification
     const adminEmails = await User.find(
      { userType: "admin" },
      "email"
    );
    const emailList = adminEmails.map((admin) => admin.email);


    // Prepare email summary
    const emailSubject = "New Form Submission Received";
    const emailMessage = `
      A new form submission has been received from  ${formData.companyName}

      // User ID: ${userId}
      // Submitted Details: ${JSON.stringify(formData, null, 2)}

      Please review the submission in the admin dashboard.
    `;

    // Send email notification (don't block response)
    sendMail(emailList.join(","), emailSubject, emailMessage)
      .then(() => {
        console.log("Email sent successfully");
      })
      .catch((err) => {
        console.error("Failed to send email notification:", err);
      });

    // Always send success response to frontend
    res.status(201).json({
      message:
        "Thank you for submitting your information. Our team will review your details and get in touch with you shortly.",
    });
  } catch (error) {
    console.error("Error during form submission:", error);
    res.status(500).json({
      message: "An error occurred while submitting the form",
      error: error.message,
    });
  }
};

// =========================
// INITIALIZE ADMIN ACCOUNT
// =========================
// Creates the admin account using environment variable data if it does not already exist.
const initializeAdminAccount = async () => {
  try {
    const adminEmail = process.env.ADMIN_EMAIL;
    const existingAdmin = await User.findOne({ email: adminEmail, userType: "admin" });
    if (existingAdmin) {
      console.log("Admin account already exists");
      return;
    }
    const hashedPassword = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
    const newAdmin = new User({
      email: adminEmail,
      password: hashedPassword,
      contactNumber: process.env.ADMIN_CONTACT_NUMBER,
      userName: process.env.ADMIN_USER_NAME,
      userType: "admin",
      address: process.env.ADMIN_ADDRESS,
      role: process.env.ADMIN_ROLE,
      companyName: process.env.ADMIN_COMPANY,
      isFirstLogin: false,
    });
    await newAdmin.save();
    console.log("Admin account created successfully");
  } catch (err) {
    console.error("Error creating admin account:", err);
  }
};

module.exports = {
  registerUser,
  login,
  formSubmission,
  getUsersWithUserTypeUser,
  initializeAdminAccount,
  updateUser,
  deleteUser,
};
