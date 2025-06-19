const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const User = require("../models/User");
const Client = require("../models/Client");
const { sendMail } = require("../utils/mail");
const moment = require("moment");
const Notification = require("../models/Notification");
// Import the notification controller
const { createUserStatusNotification } = require("./notificationControllers");
const Flowchart = require('../models/Flowchart');

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
const login = async (req, res) => {
  try {
    const { login: loginIdentifier, password } = req.body;
    
    if (!loginIdentifier || !password) {
      return res.status(400).json({ 
        message: "Please provide login credentials" 
      });
    }
    
    // Find user by email or userName
    const user = await User.findOne({
      $or: [{ email: loginIdentifier }, { userName: loginIdentifier }],
      isActive: true
    }).populate('createdBy', 'userName email');
    
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    
    const isMatch = bcrypt.compareSync(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid credentials" });
    }
    
    // Check if client is active (for client-related users)
    if (user.clientId) {
      const client = await Client.findOne({ 
        clientId: user.clientId,
        "accountDetails.isActive": true 
      });
      
      if (!client) {
        return res.status(403).json({ 
          message: "Your organization's subscription is not active" 
        });
      }
    }
    
    // Update first login status
    if (user.isFirstLogin) {
      user.isFirstLogin = false;
      await user.save();
    }
    
    // Prepare token payload
    const tokenPayload = {
      id: user._id,
      email: user.email,
      userName: user.userName,
      userType: user.userType,
      clientId: user.clientId,
      permissions: user.permissions
    };
    
    // Generate JWT token
    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, {
      expiresIn: "24h"
    });
    
    // Prepare response data
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
      isFirstLogin: user.isFirstLogin
    };
    
    res.status(200).json({
      user: userData,
      token,
      message: "Login successful"
    });
    
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ 
      message: "Login failed", 
      error: error.message 
    });
  }
};

// Create Consultant Admin (Super Admin only)
const createConsultantAdmin = async (req, res) => {
  try {
    if (!req.user || req.user.userType !== "super_admin") {
      return res.status(403).json({ 
        message: "Only Super Admin can create Consultant Admins" 
      });
    }
    
    const {
      email,
      password,
      contactNumber,
      userName,
      address,
      teamName,
      employeeId
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
    
    const consultantAdmin = new User({
      email,
      password: hashedPassword,
      contactNumber,
      userName,
      userType: "consultant_admin",
      address,
      companyName: "ZeroCarbon Consultancy",
      teamName,
      employeeId,
      createdBy: req.user.id,
      permissions: {
        canViewAllClients: true,
        canManageUsers: true,
        canManageClients: true,
        canViewReports: true,
        canEditBoundaries: false,
        canSubmitData: false,
        canAudit: false
      }
    });
    
    await consultantAdmin.save();
    
    // Send welcome email
    const emailSubject = "Welcome to ZeroCarbon - Consultant Admin Account";
    const emailMessage = `
      Your Consultant Admin account has been created successfully.
      
      Login Credentials:
      Username: ${userName}
      Email: ${email}
      Password: ${password}
      
      Please change your password after first login.
    `;
    
    await sendMail(email, emailSubject, emailMessage);
    
    res.status(201).json({
      message: "Consultant Admin created successfully",
      consultantAdmin: {
        id: consultantAdmin._id,
        email: consultantAdmin.email,
        userName: consultantAdmin.userName,
        teamName: consultantAdmin.teamName
      }
    });
    
  } catch (error) {
    console.error("Create consultant admin error:", error);
    res.status(500).json({ 
      message: "Failed to create Consultant Admin", 
      error: error.message 
    });
  }
};

// Create Consultant (Consultant Admin only)
const createConsultant = async (req, res) => {
  try {
    if (!req.user || req.user.userType !== "consultant_admin") {
      return res.status(403).json({ 
        message: "Only Consultant Admin can create Consultants" 
      });
    }
    
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
    
    const consultant = new User({
      email,
      password: hashedPassword,
      contactNumber,
      userName,
      userType: "consultant",
      address,
      companyName: "ZeroCarbon Consultancy",
      employeeId,
      jobRole,
      branch,
      teamName,
      createdBy: req.user.id,
      consultantAdminId: req.user.id,
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

    // Send welcome email
    const emailSubject = "Welcome to ZeroCarbon - Consultant Account";
    const emailMessage = `
      Your Consultant account has been created successfully.
      
      Login Credentials:
      Username: ${userName}
      Email: ${email}
      Password: ${password}
      
      Please change your password after first login.
    `;

    await sendMail(email, emailSubject, emailMessage);

    res.status(201).json({
      message: "Consultant created successfully",
      consultant: {
        id: consultant._id,
        email: consultant.email,
        userName: consultant.userName,
        employeeId: consultant.employeeId
      }
    });
    
  } catch (error) {
    console.error("Create consultant error:", error);
    res.status(500).json({ 
      message: "Failed to create Consultant", 
      error: error.message 
    });
  }
};

// Create Client Admin (Automatic on proposal acceptance)
const createClientAdmin = async (clientId, clientData) => {
  try {
    const client = await Client.findOne({ clientId });
    if (!client) {
      throw new Error("Client not found");
    }

    // Derive the email, name, etc. from client data
    const companyName =
      client.submissionData?.companyInfo?.companyName ||
      client.leadInfo?.companyName;
    const primaryContact = client.submissionData?.companyInfo?.primaryContactPerson || {};
    const email = primaryContact.email || client.leadInfo?.email;
    const phone = primaryContact.phoneNumber || client.leadInfo?.mobileNumber;
    const contactName = primaryContact.name || client.leadInfo?.contactPersonName;

    if (!email) {
      throw new Error("No email found for client admin creation");
    }

    // 1) Check if a client_admin with this email and clientId already exists
    let existingClientAdmin = await User.findOne({
      email: email,
      userType: "client_admin",
      clientId: clientId,
    });
    if (existingClientAdmin) {
      // If it already exists, just link it and return without throwing
      client.accountDetails.clientAdminId = existingClientAdmin._id;
      await client.save();
      return existingClientAdmin;
    }

    // 2) If not found, generate a default password and create a new user
    const cleanCompanyName = companyName.replace(/[^a-zA-Z0-9]/g, "");
    const year = new Date().getFullYear();
    const defaultPassword = `${cleanCompanyName}@${year}`;
    const hashedPassword = bcrypt.hashSync(defaultPassword, 10);

    const clientAdmin = new User({
      email: email,
      password: hashedPassword,
      contactNumber: phone || "0000000000",
      userName: email,                 // using email as username
      userType: "client_admin",
      address:
        client.submissionData?.companyInfo?.companyAddress ||
        client.leadInfo?.companyName ||
        "Not provided",
      companyName: companyName,
      clientId: clientId,
      createdBy: clientData.consultantId,
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
    client.accountDetails.clientAdminId = clientAdmin._id;
    client.accountDetails.defaultPassword = defaultPassword;
    await client.save();

    // Send the welcome email
    const emailSubject = "Welcome to ZeroCarbon - Your Account is Active";
    const emailMessage = `
      Dear ${contactName},

      Your ZeroCarbon account has been activated successfully.

      Login Credentials:
      Email: ${email}
      Password: ${defaultPassword}

      Please change your password after first login.

      Your subscription is valid until: ${moment(
        client.accountDetails.subscriptionEndDate
      ).format("DD/MM/YYYY")}
    `;
    await sendMail(email, emailSubject, emailMessage);

    return clientAdmin;
  } catch (error) {
    console.error("Create client admin error:", error);
    throw error;
  }
};

const createEmployeeHead = async (req, res) => {
  try {
    if (!req.user || req.user.userType !== "client_admin") {
      return res.status(403).json({ 
        message: "Only Client Admin can create Employee Heads" 
      });
    }

    // Allow bulk or single
    const payloads = Array.isArray(req.body.employeeHeads)
      ? req.body.employeeHeads
      : [req.body];

    const results = { created: [], errors: [] };

    for (const data of payloads) {
      const { email, password, contactNumber, userName, address, department, location } = data;
      try {
        // Check required fields
        if (!email || !password || !userName) {
          throw new Error('Missing required fields: email, password, or userName');
        }
        // Check uniqueness
        const exists = await User.findOne({ $or: [{ email }, { userName }] });
        if (exists) throw new Error('Email or Username already exists');

        const hashed = bcrypt.hashSync(password, 10);
        const head = new User({
          email,
          password: hashed,
          contactNumber,
          userName,
          userType: "client_employee_head",
          address,
          companyName: req.user.companyName,
          clientId: req.user.clientId,
          department,
          location,
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
        results.created.push({ id: head._id, email: head.email, userName: head.userName, department: head.department, location: head.location });
      } catch (err) {
        results.errors.push({ input: data, error: err.message });
      }
    }

    const statusCode = results.created.length > 0 ? 201 : 400;
    return res.status(statusCode).json({
      message: `Employee Head creation completed`,
      ...results
    });
  } catch (error) {
    console.error("Create employee head error:", error);
    return res.status(500).json({ 
      message: "Failed to create Employee Head", 
      error: error.message 
    });
  }
};


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
const getUsers = async (req, res) => {
  try {
    // 1. Build base query by hierarchy (unchanged)
    let baseQuery = {};
    switch (req.user.userType) {
      case "super_admin":
        // sees all users
        break;
      case "consultant_admin":
        baseQuery = {
          $or: [
            { createdBy: req.user.id },
            { consultantAdminId: req.user.id }
          ]
        };
        break;
      case "consultant":
        const assignedClients = await Client.find({
          "leadInfo.assignedConsultantId": req.user.id
        }).select("clientId");
        const clientIds = assignedClients.map(c => c.clientId);
        baseQuery = { clientId: { $in: clientIds } };
        break;
      case "client_admin":
        baseQuery = { clientId: req.user.clientId };
        break;
      case "client_employee_head":
        baseQuery = { createdBy: req.user.id };
        break;
      default:
        return res.status(403).json({ message: "You don't have permission to view users" });
    }

    // 2. Extract special params (pagination, sorting, search)
    const {
      page = 1,
      limit = 10,
      sort,        // Can be: "field1:asc,field2:desc" or just "field:order"
      search,      // Global search term
      ...filters   // All other params are treated as filters
    } = req.query;

    // 3. Build filter query from ALL remaining params
    const filterQuery = {};
    
    // Process each filter param
    Object.keys(filters).forEach(key => {
      const value = filters[key];
      
      // Handle different filter types
      if (value.includes(',')) {
        // Multiple values: use $in operator
        filterQuery[key] = { $in: value.split(',') };
      } else if (value.startsWith('>=')) {
        // Greater than or equal
        filterQuery[key] = { $gte: value.substring(2) };
      } else if (value.startsWith('<=')) {
        // Less than or equal
        filterQuery[key] = { $lte: value.substring(2) };
      } else if (value.startsWith('>')) {
        // Greater than
        filterQuery[key] = { $gt: value.substring(1) };
      } else if (value.startsWith('<')) {
        // Less than
        filterQuery[key] = { $lt: value.substring(1) };
      } else if (value.startsWith('!')) {
        // Not equal
        filterQuery[key] = { $ne: value.substring(1) };
      } else if (value === 'true' || value === 'false') {
        // Boolean values
        filterQuery[key] = value === 'true';
      } else if (!isNaN(value) && value !== '') {
        // Numeric values
        filterQuery[key] = Number(value);
      } else if (key.includes('.')) {
        // Nested field filtering (e.g., permissions.canViewReports=true)
        filterQuery[key] = value === 'true' ? true : value === 'false' ? false : value;
      } else {
        // String values: use regex for partial matching
        filterQuery[key] = { $regex: value, $options: 'i' };
      }
    });

    // 4. Add global search across ALL text fields
    if (search) {
      const searchRegex = { $regex: search, $options: 'i' };
      filterQuery.$or = [
        { userName: searchRegex },
        { email: searchRegex },
        { address: searchRegex },
        { companyName: searchRegex },
        { role: searchRegex },
        { teamName: searchRegex },
        { employeeId: searchRegex },
        { jobRole: searchRegex },
        { branch: searchRegex },
        { clientId: searchRegex },
        { department: searchRegex },
        { viewerPurpose: searchRegex },
        { 'assignedClients': searchRegex },
        { 'assignedModules': searchRegex },
        { 'auditScope': searchRegex }
      ];
    }

    // 5. Merge hierarchy + filters
    const finalQuery = { ...baseQuery, ...filterQuery };

    // 6. Build sort object (supports multiple sort fields)
    let sortObj = {};
    if (sort) {
      // Handle multiple sort fields: "field1:asc,field2:desc"
      const sortFields = sort.split(',');
      sortFields.forEach(field => {
        const [fieldName, order = 'asc'] = field.split(':');
        sortObj[fieldName] = order.toLowerCase() === 'desc' ? -1 : 1;
      });
    } else {
      // Default sort by createdAt desc
      sortObj = { createdAt: -1 };
    }

    // 7. Execute query with pagination
    const skip = (Number(page) - 1) * Number(limit);
    const limitNum = Number(limit);

    // Get total count for pagination
    const total = await User.countDocuments(finalQuery);

    // Fetch paginated results
    const users = await User.find(finalQuery)
      .select('-password')
      .populate('createdBy', 'userName email')
      .populate('parentUser', 'userName email')
      .populate('consultantAdminId', 'userName email')
      .populate('employeeHeadId', 'userName email')
      .sort(sortObj)
      .skip(skip)
      .limit(limitNum)
      .lean();

    // 8. Return response with comprehensive metadata
    res.status(200).json({
      success: true,
      message: 'Users fetched successfully',
      data: {
        users,
        pagination: {
          page: Number(page),
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
          hasNextPage: page < Math.ceil(total / limitNum),
          hasPrevPage: page > 1
        },
        filters: {
          applied: filters,
          search: search || null,
          sort: sortObj
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
                notes: `Reassigned from ${userToDelete.userName} to ${newConsultant.userName}`
              }
            }
          }
        );
      };
      
      details.reassignedTo = newConsultant.userName;
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

// Update user
// Update user
const updateUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const updateData = req.body;

    // Remove sensitive fields from update
    delete updateData.password;
    delete updateData.userType;
    delete updateData.clientId;
    delete updateData.createdBy;
    delete updateData.consultantAdminId;
    delete updateData.parentUser;

    // Find user to update
    const userToUpdate = await User.findById(userId);
    if (!userToUpdate) {
      return res.status(404).json({ message: "User not found" });
    }

    // Check permissions based on hierarchy, but always allow self-edit
    let canUpdate = false;
    const errorMessage = "You don't have permission to update this user";

    // If the logged-in user is editing their own account, allow it
    if (userToUpdate._id.toString() === req.user.id) {
      canUpdate = true;
    } else {
      switch (req.user.userType) {
        case "super_admin":
          // Super admin can update all users except other super admins
          canUpdate =
            userToUpdate.userType !== "super_admin" ||
            userToUpdate._id.toString() === req.user.id;
          break;

        case "consultant_admin":
          // Can update: their consultants, client admins of their clients
          if (userToUpdate.userType === "consultant") {
            canUpdate =
              userToUpdate.consultantAdminId?.toString() === req.user.id;
          } else if (userToUpdate.userType === "client_admin") {
            // Check if this client admin belongs to a client managed by this consultant admin
            const client = await Client.findOne({
              clientId: userToUpdate.clientId,
              $or: [
                { "leadInfo.consultantAdminId": req.user.id },
                {
                  "leadInfo.assignedConsultantId": {
                    $in: await getConsultantIds(req.user.id),
                  },
                },
              ],
            });
            canUpdate = !!client;
          }
          break;

        case "client_admin":
          // Can update: employee heads, employees, auditors, viewers in their organization
          canUpdate =
            userToUpdate.clientId === req.user.clientId &&
            ["client_employee_head", "employee", "auditor", "viewer"].includes(
              userToUpdate.userType
            );
          break;

        case "client_employee_head":
          // Can only update employees they created
          canUpdate =
            userToUpdate.userType === "employee" &&
            userToUpdate.createdBy.toString() === req.user.id;
          break;

        default:
          canUpdate = false;
      }
    }

    if (!canUpdate) {
      return res.status(403).json({ message: errorMessage });
    }

    // Update user
    const updatedUser = await User.findByIdAndUpdate(userId, updateData, {
      new: true,
      runValidators: true,
    }).select("-password");

    res.status(200).json({
      message: "User updated successfully",
      user: updatedUser,
    });
  } catch (error) {
    console.error("Update user error:", error);
    res.status(500).json({
      message: "Failed to update user",
      error: error.message,
    });
  }
};



// Helper function: Get consultant IDs under a consultant admin


// Delete user with hierarchy control and email notifications
const deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { reassignToConsultantId } = req.body; // For reassigning clients when deleting consultant
    
    // Find user to delete
    const userToDelete = await User.findById(userId);
    if (!userToDelete) {
      return res.status(404).json({ message: "User not found" });
    }
    
    // Prevent self-deletion
    if (userToDelete._id.toString() === req.user.id) {
      return res.status(400).json({ message: "You cannot delete your own account" });
    }
    
    // Check permissions and handle deletion based on hierarchy
    let canDelete = false;
    let deletionDetails = null;
    
    switch (req.user.userType) {
      case "super_admin":
        if (userToDelete.userType === "super_admin") {
          return res.status(403).json({ message: "Super admins cannot be deleted" });
        }
        canDelete = true;
        deletionDetails = await handleSuperAdminDeletion(userToDelete, req.user);
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
        deletionDetails = await handleClientAdminDeletion(userToDelete, req.user);
        canDelete = deletionDetails.canDelete;
        break;
        // ─── Allow a client_employee_head to delete only employees they created ────────────────────────────
        case "client_employee_head":
          // Can delete if the target is an "employee" and was created by this employee head
          if (
            userToDelete.userType === "employee" &&
           userToDelete.createdBy.toString() === req.user.id
          ) {
            canDelete = true;
            // No special pre-deletion tasks required beyond deactivating any deeper subordinates (none in this model).
            deletionDetails = { canDelete: true, emailRecipients: [userToDelete.email] };
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
        message: deletionDetails?.message || "You don't have permission to delete this user" 
      });
    }
    
    // Handle special case validations
    if (deletionDetails.requiresReassignment && !reassignToConsultantId) {
      return res.status(400).json({
        message: deletionDetails.message,
        requiresReassignment: true,
        availableConsultants: deletionDetails.availableConsultants
      });
    }
    
    // Perform pre-deletion tasks
    if (deletionDetails.preDeletionTasks) {
      await deletionDetails.preDeletionTasks();
    }
    
    // Send deletion notification email
    await sendDeletionEmail(userToDelete, req.user, deletionDetails);
    
    // Soft delete the user
    userToDelete.isActive = false;
    userToDelete.isDeleted = true;
    userToDelete.deletedAt = new Date();
    userToDelete.deletedBy = req.user.id;
    await userToDelete.save();
    
    res.status(200).json({
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
    res.status(500).json({ 
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
          const Client = require("../models/Client");
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
      if (!user || !user.isActive) {
        throw new Error("User not found or inactive");
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
  removeAssignment
};