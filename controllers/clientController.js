const Client = require("../models/Client");
const User = require("../models/User");
const { sendMail } = require("../utils/mail");
const { createClientAdmin } = require("./userController");
const Notification = require("../models/Notification");
const moment = require("moment");
const { emailQueue } = require("../utils/emailQueue");
const { withTimeout } = require('../utils/queueUtils');

const {
  createLeadActionNotification,
  createDataSubmissionNotification,
  createProposalActionNotification,
  createConsultantAssignmentNotification
} = require("../utils/notificationHelper");

const {
  sendLeadCreatedEmail,
  sendConsultantAssignedEmail
} = require('../utils/emailHelper');


// Helper function for pagination with caching
const getPaginationOptions = (req) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const skip = (page - 1) * limit;
  
  const search = req.query.search?.trim() || '';
  const stage = req.query.stage || '';
  const status = req.query.status || '';
  const sortBy = req.query.sortBy || 'createdAt';
  const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
  
  return { 
    page, 
    limit, 
    skip, 
    search, 
    stage, 
    status, 
    sortBy, 
    sortOrder 
  };
};

// Enhanced response formatter
const formatPaginatedResponse = (data, total, options) => {
  const { page, limit } = options;
  const totalPages = Math.ceil(total / limit);
  
  return {
    success: true,
    data,
    pagination: {
      currentPage: page,
      totalPages,
      totalItems: total,
      itemsPerPage: limit,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    },
    timestamp: new Date().toISOString()
  };
};
// Create Lead (Stage 1)
// Create Lead (Stage 1)
const createLead = async (req, res) => {
    const startTime = Date.now();
  try {
    // Only consultant_admin can create leads
    if (!req.user || req.user.userType !== "consultant_admin") {
      return res.status(403).json({
        message: "Only Consultant Admins can create leads"
      });
    }

    const {
      companyName,
      contactPersonName,
      email,
      mobileNumber,
      leadSource,
      notes,
      assignedConsultantId
    } = req.body;
    // Validate required fields
    const requiredFields = { companyName, contactPersonName, email, mobileNumber };
    const missingFields = Object.entries(requiredFields)
      .filter(([_, value]) => !value)
      .map(([key]) => key);
    
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missingFields.join(', ')}`,
        timestamp: new Date().toISOString()
      });
    }
    // Check if lead already exists by email
    const existingLead = await Client.findOne({
      "leadInfo.email": email
    });
    if (existingLead) {
      return res.status(409).json({
        success: false,
        message: "A lead with this email already exists",
        clientId: existingLead.clientId,
        timestamp: new Date().toISOString()
      });
    }

    // Generate a new Client ID
    const clientId = await Client.generateClientId();

    // Create the new lead
    const newClient = new Client({
      clientId,
      stage: "lead",
      status: "contacted",
      leadInfo: {
        companyName,
        contactPersonName,
        email,
        mobileNumber,
        leadSource,
        notes,
        consultantAdminId: req.user.id,
        assignedConsultantId: assignedConsultantId || null,
        createdBy: req.user.id // ← store who created
        // createdAt is auto‐populated by schema default
      },
      timeline: [{
        stage: "lead",
        status: "contacted",
        action: "Lead created",
        performedBy: req.user.id,
        notes: `Lead created by ${req.user.userName}`
      }]
    });

    await newClient.save();

      try {
       sendLeadCreatedEmail(newClient, req.user.userName);
      console.log(`✉️  Lead creation email queued for super admin (${process.env.SUPER_ADMIN_EMAIL})`);
    } catch (mailErr) {
      console.error("⚠️  Could not send lead-created email:", mailErr);
    }


     // 1) Try sending the “lead created” notification, but don’t let it throw.
    try {
       createLeadActionNotification('created', newClient, req.user);
    } catch (notifErr) {
      console.error("Warning: could not enqueue lead notification:", notifErr);
      // (You can choose to swallow this completely or log it somewhere else.)
    }

    // 2) If there’s an assigned consultant, wrap that in its own try block too:
    if (assignedConsultantId) {
      // ── a) In‐app “assign” notification ───────────────────────────────────
      try {
        const consultant = await User.findById(assignedConsultantId).select('email userName');
        if (consultant) {
          // If createConsultantAssignmentNotification is async, await it
           createConsultantAssignmentNotification(consultant, newClient, req.user);
        }
      } catch (assignNotifErr) {
        console.error("Warning: could not enqueue consultant‐assignment notification:", assignNotifErr);
      }

      // ── b) Email the consultant ───────────────────────────────────────────
      try {
        // It’s often simpler to re‐fetch only email/userName via .lean(), but
        // since we already did findById above (with select), you can reuse it:
        const consultantUser = await User
          .findById(assignedConsultantId)
          .select('email userName')
          .lean();

        if (consultantUser && consultantUser.email) {
           sendConsultantAssignedEmail(
            consultantUser,
            newClient,
            req.user.userName
          );
          console.log(`✉️ Consultant assignment email sent to ${consultantUser.email}`);
        }
      } catch (assignEmailErr) {
        console.error("⚠️ Could not send consultant-assigned email:", assignEmailErr);
      }
    }


    const responseTime = Date.now() - startTime;

 return res.status(201).json({
      success: true,
      message: "Lead created successfully",
      data: {
        clientId: newClient.clientId,
        stage: newClient.stage,
        status: newClient.status,
        leadInfo: newClient.leadInfo
      },
      responseTime: `${responseTime}ms`,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error("Create lead error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create lead",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
};


/**
 * Update a Lead's basic "leadInfo" fields.
 * – Only a consultant_admin can call this.
 * – Only allowed when client.stage === "lead".
 * – Once moved to "registered" (data submission), it can no longer be edited.
 */
const updateLead = async (req, res) => {
  try {
    const { clientId } = req.params;
    const updateData = req.body;

    // 1) Only consultant_admin may update
    if (!req.user || req.user.userType !== "consultant_admin") {
      return res.status(403).json({
        message: "Only Consultant Admins can update leads"
      });
    }

    // 2) Find the lead (client) by clientId
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    // 3) Ensure the caller is the same consultant_admin who created this lead
    if (client.leadInfo.createdBy.toString() !== req.user.id) {
      return res.status(403).json({
        message: "You can only update leads you created"
      });
    }

    // 4) Ensure it is still in "lead" stage
    if (client.stage !== "lead") {
      return res.status(400).json({
        message: "Cannot edit a lead after it has moved to data submission"
      });
    }

    // 5) Request must wrap everything under `leadInfo`
    if (!updateData.leadInfo || typeof updateData.leadInfo !== "object") {
      return res.status(400).json({
        message: "Payload must contain a 'leadInfo' object"
      });
    }

    // 6) Allowed fields (under leadInfo) to update
    const allowedFields = [
      "companyName",
      "contactPersonName",
      "email",
      "mobileNumber",
      "leadSource",
      "notes",
      "assignedConsultantId"
    ];

    // 7) Apply only those subfields if present
    allowedFields.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(updateData.leadInfo, field)) {
        client.leadInfo[field] = updateData.leadInfo[field];
      }
    });

    // 8) If assignedConsultantId changed, notify that consultant
    if (updateData.leadInfo.assignedConsultantId && 
        updateData.leadInfo.assignedConsultantId !== client.leadInfo.assignedConsultantId?.toString()) {
      const newConsId = updateData.leadInfo.assignedConsultantId;
      const consultant = await User.findById(newConsId);
      if (consultant) {
        try {
          await createConsultantAssignmentNotification(consultant, client, req.user);
          
          // Send email notification
          await sendConsultantAssignedEmail(
            consultant,
            client,
            req.user.userName
          );
          console.log(`✉️ Consultant assignment email sent to ${consultant.email}`);
        } catch (notifErr) {
          console.error("Warning: could not send consultant assignment notifications:", notifErr);
          // Continue with the update even if notifications fail
        }
      }
    }

    // 9) Add timeline entry
    client.timeline.push({
      stage: client.stage,
      status: client.status,
      action: "Lead information updated",
      performedBy: req.user.id,
      notes: `Updated by ${req.user.userName}`
    });

    // 10) Save changes
    await client.save();

    return res.status(200).json({
      message: "Lead updated successfully",
      lead: {
        clientId: client.clientId,
        stage: client.stage,
        status: client.status,
        leadInfo: client.leadInfo
      }
    });
  } catch (err) {
    console.error("Update lead error:", err);
    return res.status(500).json({
      message: "Failed to update lead",
      error: err.message
    });
  }
};


/**
 * Delete a lead (soft delete) **only** if:
 * 1) The lead’s stage is still "lead"
 * 2) The lead was created ≤ 3 days ago
 * 3) A reason is provided in the request body
 *
 * Upon deletion:
 * ‣ Soft-delete the client document (isDeleted = true, deletedAt, deletedBy, store reason)
 * ‣ Send a high-priority notification + email to the super_admin with the reason
 */
const deleteLead = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { reason } = req.body;

    // A) Only consultant_admin may delete
    if (!req.user || req.user.userType !== "consultant_admin") {
      return res.status(403).json({
        message: "Only Consultant Admins can delete leads"
      });
    }

    // B) Find the client record
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    // C) Only the same consultant_admin who created the lead
    if (client.leadInfo.createdBy.toString() !== req.user.id) {
      return res.status(403).json({
        message: "You can only delete leads you created"
      });
    }

    // D) Only delete if still in "lead" stage
    if (client.stage !== "lead") {
      return res.status(400).json({
        message: "Cannot delete: this lead has already advanced beyond 'lead' stage"
      });
    }

    // E) Enforce 3-day window since creation
    const createdAt = client.leadInfo.createdAt;
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    if (createdAt < threeDaysAgo) {
      return res.status(400).json({
        message: "Cannot delete lead: more than 3 days have elapsed since creation"
      });
    }

    // F) Validate deletion reason (min length 5)
    if (!reason || reason.length < 5) {
      return res.status(400).json({
        message: "Please provide a reason (minimum 5 characters)"
      });
    }

    // G) Soft‐delete / archive the lead
    client.isDeleted = true;
    client.deletedAt = new Date();
    client.leadInfo.deletionReason = reason;
    client.deletedBy = req.user.id;

    // → Update accountDetails with valid status
    // Instead of "deactivated", use "suspended" or another valid enum value
    client.accountDetails.isActive = false;
    // Only set subscriptionStatus if it exists and client is in active stage
    if (client.stage === "active" && client.accountDetails.subscriptionStatus) {
      client.accountDetails.subscriptionStatus = "suspended"; // Use a valid enum value
    }

    await client.save();

    // H) Notify super_admin: create Notification + email
    const superAdmin = await User.findOne({
      userType: "super_admin",
      isActive: true
    });
    
    if (superAdmin) {
      // a) Try to save a Notification (wrap in try-catch to handle Redis errors)
      try {
        const notif = new Notification({
          title: `Lead Deleted: ${clientId}`,
          message: `
${req.user.userName} (${req.user.userType}) deleted lead ${clientId}.
Reason: ${reason}

Lead Details:
• Company: ${client.leadInfo.companyName}
• Contact Person: ${client.leadInfo.contactPersonName}
• Email: ${client.leadInfo.email}
• Mobile: ${client.leadInfo.mobileNumber}
Deleted On: ${client.deletedAt.toLocaleString()}
          `.trim(),
          priority: "high",
          createdBy: req.user.id,
          creatorType: req.user.userType,
          targetUsers: [superAdmin._id],
          status: "published",
          publishedAt: new Date(),
          isSystemNotification: true,
          systemAction: "lead_deleted",
          relatedEntity: {
            type: "client",
            id: client._id
          }
        });
        await notif.save();
        
        // Broadcast notification if global.io exists
        if (global.io && global.broadcastNotification) {
          try {
            await global.broadcastNotification(notif);
          } catch (broadcastErr) {
            console.error("Warning: could not broadcast notification:", broadcastErr);
          }
        }
      } catch (notifErr) {
        console.error("Warning: could not create notification:", notifErr);
        // Continue with the deletion even if notification fails
      }

      // b) Send email to super_admin (wrap in try-catch)
      try {
        const adminSubject = `ZeroCarbon – Lead Deleted: ${clientId}`;
        const adminMessage = `
Dear ${superAdmin.userName},

${req.user.userName} (${req.user.userType}) has deleted lead ${clientId}.
Reason: ${reason}

Lead Details:
• Company: ${client.leadInfo.companyName}
• Contact Person: ${client.leadInfo.contactPersonName}
• Email: ${client.leadInfo.email}
• Mobile: ${client.leadInfo.mobileNumber}
Deleted On: ${client.deletedAt.toLocaleString()}

Please check the system for more details.

Best regards,
ZeroCarbon System
        `.trim();

        await sendMail(superAdmin.email, adminSubject, adminMessage);
      } catch (emailErr) {
        console.error("Warning: could not send email to super admin:", emailErr);
        // Continue with the deletion even if email fails
      }
    }

    // I) Respond
    return res.status(200).json({
      message: `Lead ${clientId} deleted successfully`,
      deletedLead: {
        clientId: client.clientId,
        deletedAt: client.deletedAt,
        deletedBy: req.user.id,
        reason
      }
    });

  } catch (err) {
    console.error("Delete lead error:", err);
    return res.status(500).json({
      message: "Failed to delete lead",
      error: err.message
    });
  }
};


// ─── Get Leads (Consultant Admin only) ──────────────────────────────────────────
const getLeads = async (req, res) => {
  try {
    // Only consultant_admin can fetch "their" leads
    if (req.user.userType !== "consultant_admin") {
      return res.status(403).json({
        message: "You don't have permission to view leads",
      });
    }
    
    const paginationParams = getPaginationOptions(req);
    const { page, limit, skip, search, stage, status, sortBy, sortOrder } = paginationParams;

    // Build query
    let query = {
      "leadInfo.consultantAdminId": req.user.id,
      "isDeleted": false,
    };

    // Add search filter if provided
    if (search) {
      query.$or = [
        { "leadInfo.companyName": { $regex: search, $options: 'i' } },
        { "leadInfo.contactPersonName": { $regex: search, $options: 'i' } },
        { "leadInfo.email": { $regex: search, $options: 'i' } },
        { "leadInfo.mobileNumber": { $regex: search, $options: 'i' } }
      ];
    }

    // Add stage filter if provided
    if (stage) {
      query.stage = stage;
    }

    // Add status filter if provided
    if (status) {
      query.status = status;
    }

    // Get total count for pagination
    const totalLeads = await Client.countDocuments(query);

    // Find all clients with pagination
    const leads = await Client.find(query)
      .select("clientId stage status leadInfo.companyName leadInfo.contactPersonName leadInfo.email leadInfo.mobileNumber leadInfo.leadSource leadInfo.createdAt")
      .sort({ [sortBy]: sortOrder })
      .skip(skip)
      .limit(limit)
      .lean();

    // Use the formatPaginatedResponse helper
    return res.status(200).json(
      formatPaginatedResponse(leads, totalLeads, paginationParams)
    );
    
  } catch (error) {
    console.error("Get leads error:", error);
    return res.status(500).json({
      message: "Failed to fetch leads",
      error: error.message
    });
  }
};

// Update Lead to Data Submission Stage (Stage 2)
const moveToDataSubmission = async (req, res) => {
  try {
    const { clientId } = req.params;

    // A) Only consultant_admin can perform this
    if (req.user.userType !== "consultant_admin") {
      return res.status(403).json({
        message: "Only Consultant Admins can move leads to data submission",
      });
    }

    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    // B) Only the consultant_admin who originally created the lead may move it
    if (client.leadInfo.createdBy.toString() !== req.user.id) {
      return res.status(403).json({
        message: "Only the Consultant Admin who created this lead can move it to data submission",
      });
    }

    if (client.stage !== "lead") {
      return res.status(400).json({
        message: "Client is not in lead stage",
      });
    }

    // C) Update stage and status
    client.stage = "registered";
    client.status = "pending";
    client.timeline.push({
      stage: "registered",
      status: "pending",
      action: "Moved to data submission",
      performedBy: req.user.id,
      notes: "Client moved to data submission stage",
    });

    await client.save();

    // D) Send email to client
    const emailSubject = "ZeroCarbon - Please Submit Your Company Data";
    const emailMessage = `
      Dear ${client.leadInfo.contactPersonName},

      Thank you for your interest in ZeroCarbon services.

      To proceed with your carbon footprint assessment, we need some additional information about your company.

      Your Client ID: ${clientId}

      Our consultant will contact you shortly to guide you through the data submission process.

      Best regards,
      ZeroCarbon Team
    `;

    await sendMail(client.leadInfo.email, emailSubject, emailMessage);

    // E) CREATE NOTIFICATION for Super Admin and related users
    await createDataSubmissionNotification(client, req.user);


    return res.status(200).json({
      message: "Client moved to data submission stage",
      client: {
        clientId: client.clientId,
        stage: client.stage,
        status: client.status,
      },
    });
  } catch (error) {
    console.error("Move to data submission error:", error);
    return res.status(500).json({
      message: "Failed to update client stage",
      error: error.message,
    });
  }
};



// Submit Client Data (Stage 2)
const submitClientData = async (req, res) => {
  try {
    const { clientId } = req.params;
    const submissionData = req.body;
    
    // Check permissions
    if (!["consultant_admin", "consultant"].includes(req.user.userType)) {
      return res.status(403).json({ 
        message: "Only Consultants can submit client data" 
      });
    }
    
    const client = await Client.findOne({ clientId });
    
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }
    
    if (client.stage !== "registered") {
      return res.status(400).json({ 
        message: "Client is not in data submission stage" 
      });
    }
    
    // Update submission data
    client.submissionData = {
      ...submissionData,
      submittedAt: new Date(),
      submittedBy: req.user.id
    };
    
    client.status = "submitted";
    client.timeline.push({
      stage: "registered",
      status: "submitted",
      action: "Data submitted",
      performedBy: req.user.id,
      notes: "Client data submission completed"
    });
    
    await client.save();
    
    res.status(200).json({
      message: "Client data submitted successfully",
      client: {
        clientId: client.clientId,
        stage: client.stage,
        status: client.status
      }
    });
    
  } catch (error) {
    console.error("Submit client data error:", error);
    res.status(500).json({ 
      message: "Failed to submit client data", 
      error: error.message 
    });
  }
};

// ─── Update Client Submission Data (Consultant Admin only, creator-only, pre-activation) ──────────────────────────────────────────
const updateClientData = async (req, res) => {
  try {
    const { clientId } = req.params;

    // B) Find the client record
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    // C) Must be in "registered" stage and not yet active
    if (client.stage !== "registered" || client.status === "active") {
      return res.status(400).json({
        message:
          "Cannot update: client is either not in registration stage or is already active",
      });
    }

    // D) Only the Consultant Admin who created the lead or the assigned consultant may update
    const creatorId = client.leadInfo.createdBy?.toString();
    const assignedConsultantId = client.leadInfo.assignedConsultantId?.toString();
    if (req.user.id !== creatorId && req.user.id !== assignedConsultantId) {
      return res.status(403).json({
        message:
          "You can only update submission data if you created this client or are the assigned consultant",
      });
    }

    // E) Extract the nested object from body:
    const payload = req.body.submissionData;
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({
        message: "Request must contain a 'submissionData' object",
      });
    }

    // F) For each key in payload (e.g. "organizationalOverview"), merge its subfields:
    Object.keys(payload).forEach((key) => {
      // Ensure that this key actually exists in client.submissionData
      if (client.submissionData[key] && typeof client.submissionData[key] === "object") {
        client.submissionData[key] = {
          ...client.submissionData[key],
          ...payload[key],
        };
      } else {
        // If the subdocument key did not exist before, simply assign it:
        client.submissionData[key] = payload[key];
      }
    });

    // G) Update timestamp
    client.submissionData.updatedAt = new Date();

    // H) Add a timeline entry
    client.timeline.push({
      stage: "registered",
      status: "updated",
      action: "Submission data updated",
      performedBy: req.user.id,
      notes: "Consultant Admin edited client submission data",
    });

    await client.save();

    return res.status(200).json({
      message: "Client submission data updated successfully",
      client: {
        clientId: client.clientId,
        stage: client.stage,
        status: client.status,
      },
    });
  } catch (error) {
    console.error("Update client data error:", error);
    return res.status(500).json({
      message: "Failed to update client data",
      error: error.message,
    });
  }
};



// ─── Delete Client Submission Data (Consultant Admin only, creator-only, pre-activation) ──────────────────────────────────────────
const deleteClientData = async (req, res) => {
  try {
    const { clientId } = req.params;

    // A) Only consultant_admin may delete
    if (!req.user || req.user.userType !== "consultant_admin") {
      return res.status(403).json({
        message: "Only Consultant Admins can delete submission data",
      });
    }

    // B) Find the client record
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    // C) Must be in “registered” stage and not yet active
    if (client.stage !== "registered" || client.status === "active") {
      return res.status(400).json({
        message:
          "Cannot delete: client is either not in registration stage or is already active",
      });
    }

    // D) Only the Consultant Admin who originally created the lead may delete submission data
    const creatorId = client.leadInfo.createdBy?.toString();
    if (req.user.id !== creatorId) {
      return res.status(403).json({
        message:
          "You can only delete submission data if you originally created this client",
      });
    }

    // E) Reset submissionData to an “empty” skeleton instead of undefined
    client.submissionData = {
      // 1) companyInfo defaults
      companyInfo: {
        companyName: "",
        companyAddress: "",
        primaryContactPerson: {
          name: "",
          designation: "",
          email: "",
          phoneNumber: ""
        },
        alternateContactPerson: {
          name: "",
          designation: "",
          email: "",
          phoneNumber: ""
        }
      },

      // 2) organizationalOverview defaults
      organizationalOverview: {
        industrySector: "",
        companyDescription: "",
        numberOfOperationalSites: 0,
        sitesDetails: [],
        totalEmployees: 0,
        employeesByFacility: [],
        accountingYear: ""
      },

      // 3) emissionsProfile defaults
      emissionsProfile: {
        scope1: {
          stationaryCombustion: {
            included: false,
            details: {
              fuelType: "",
              quantityUsed: "",
              equipmentType: "",
              operationalHours: ""
            }
          },
          mobileCombustion: {
            included: false,
            details: {
              vehicleType: "",
              fuelType: "",
              distanceTraveled: "",
              fuelConsumed: ""
            }
          },
          processEmissions: {
            included: false,
            details: {
              processDescription: "",
              emissionTypes: "",
              quantitiesEmitted: ""
            }
          },
          fugitiveEmissions: {
            included: false,
            details: {
              gasType: "",
              leakageRates: "",
              equipmentType: ""
            }
          }
        },
        scope2: {
          purchasedElectricity: {
            included: false,
            details: {
              monthlyConsumption: "",
              annualConsumption: "",
              supplierDetails: "",
              unit: ""
            }
          },
          purchasedSteamHeating: {
            included: false,
            details: {
              quantityPurchased: "",
              sourceSupplier: "",
              unit: ""
            }
          }
        },
        scope3: {
          includeScope3: false,
          categories: {
            businessTravel: false,
            employeeCommuting: false,
            wasteGenerated: false,
            upstreamTransportation: false,
            downstreamTransportation: false,
            purchasedGoodsAndServices: false,
            capitalGoods: false,
            fuelAndEnergyRelated: false,
            upstreamLeasedAssets: false,
            downstreamLeasedAssets: false,
            processingOfSoldProducts: false,
            useOfSoldProducts: false,
            endOfLifeTreatment: false,
            franchises: false,
            investments: false
          },
          otherIndirectSources: ""
        }
      },

      // 4) ghgDataManagement defaults
      ghgDataManagement: {
        previousCarbonAccounting: {
          conducted: false,
          details: "",
          methodologies: ""
        },
        dataTypesAvailable: {
          energyUsage: false,
          fuelConsumption: false,
          productionProcesses: false,
          otherDataTypes: "",
          dataFormat: ""
        },
        isoCompliance: {
          hasEMSorQMS: false,
          containsGHGProcedures: false,
          certificationDetails: ""
        }
      },

      // 5) additionalNotes defaults
      additionalNotes: {
        stakeholderRequirements: "",
        additionalExpectations: "",
        completedBy: "",
        completionDate: null
      },

      // 6) supportingDocuments default
      supportingDocuments: [],

      // 7) clear any submission timestamps/IDs
      submittedAt: null,
      submittedBy: null,
      updatedAt: null
    };

    // F) Revert stage back to “lead”
    client.stage = "lead";

    // G) Update status to indicate that submitted data was deleted
    client.status = "submission_deleted";

    // H) Log timeline entry
    client.timeline.push({
      stage: "lead",
      status: "submission_deleted",
      action: "Submission data deleted",
      performedBy: req.user.id,
      notes:
        "Consultant Admin (creator) removed their submission; reverted to lead stage",
    });

    await client.save();

    return res.status(200).json({
      message:
        "Client submission data deleted successfully; stage reverted to lead",
      client: {
        clientId: client.clientId,
        stage: client.stage,
        status: client.status,
        submissionData: client.submissionData
      },
    });
  } catch (error) {
    console.error("Delete client data error:", error);
    return res.status(500).json({
      message: "Failed to delete client submission data",
      error: error.message,
    });
  }
};

// ─── Get Client Submission Data (createdBy or assignedConsultant only) ──────────────────────────────────────────
const getClientSubmissionData = async (req, res) => {
  try {
    const { clientId } = req.params;

    // A) Must be a consultant (consultant_admin or consultant)
    if (!["consultant_admin", "consultant"].includes(req.user.userType)) {
      return res.status(403).json({
        message: "Only Consultants can view submission data",
      });
    }

    // B) Find the client record
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    // C) Only the Consultant Admin who created the lead or the assigned consultant may access submissionData
    const creatorId = client.leadInfo.createdBy?.toString();
    const assignedConsultantId = client.leadInfo.assignedConsultantId?.toString();
    if (req.user.id !== creatorId && req.user.id !== assignedConsultantId) {
      return res.status(403).json({
        message:
          "You can only view submission data if you created this client or are the assigned consultant",
      });
    }

    // D) Ensure submissionData exists
    if (!client.submissionData) {
      return res.status(404).json({
        message: "No submission data available for this client",
      });
    }

    // E) Return submissionData
    return res.status(200).json({
      message: "Submission data fetched successfully",
      submissionData: client.submissionData,
    });
  } catch (error) {
    console.error("Get submission data error:", error);
    return res.status(500).json({
      message: "Failed to fetch submission data",
      error: error.message,
    });
  }
};




// Move to Proposal Stage (Stage 3)
const moveToProposal = async (req, res) => {
  try {
    const { clientId } = req.params;

    // A) Only consultant_admin can perform this
    if (req.user.userType !== "consultant_admin") {
      return res.status(403).json({
        message: "Only Consultant Admins can move clients to proposal stage",
      });
    }

    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    // B) Only the same consultant_admin who submitted the data can move it forward
    if (
      !client.submissionData ||
      client.submissionData.submittedBy.toString() !== req.user.id
    ) {
      return res.status(403).json({
        message: "Only the Consultant Admin who submitted data can move to proposal stage",
      });
    }

    if (client.stage !== "registered" || client.status !== "submitted") {
      return res.status(400).json({
        message: "Client data must be submitted before creating proposal",
      });
    }

    // C) Update stage and status
    client.stage = "proposal";
    client.status = "proposal_pending";
    client.timeline.push({
      stage: "proposal",
      status: "proposal_pending",
      action: "Moved to proposal stage",
      performedBy: req.user.id,
      notes: "Ready for proposal creation",
    });

    await client.save();

    return res.status(200).json({
      message: "Client moved to proposal stage",
      client: {
        clientId: client.clientId,
        stage: client.stage,
        status: client.status,
      },
    });
  } catch (error) {
    console.error("Move to proposal error:", error);
    return res.status(500).json({
      message: "Failed to move client to proposal stage",
      error: error.message,
    });
  }
};

// Create and Submit Proposal (Stage 3)
const createProposal = async (req, res) => {
  try {
    const { clientId } = req.params;
    const proposalData = req.body;
    
    // Only consultant_admin can perform this
    if (req.user.userType !== "consultant_admin") {
      return res.status(403).json({ 
        message: "Only Consultant Admins can create proposals" 
      });
    }
    
    const client = await Client.findOne({ clientId });
    
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }
    
    if (client.stage !== "proposal") {
      return res.status(400).json({ 
        message: "Client is not in proposal stage" 
      });
    }

    // Validate required fields for new data integration structure
    if (!proposalData.totalDataIntegrationPoints) {
      return res.status(400).json({
        message: "totalDataIntegrationPoints is required"
      });
    }

    // Validate scopes structure
    const requiredScopes = ['scope1_directEmissions', 'scope2_energyConsumption', 'scope3_purchasedGoodsServices', 'manualDataCollection', 'decarbonizationModule'];
    for (const scope of requiredScopes) {
      if (!proposalData.scopes || !proposalData.scopes[scope]) {
        return res.status(400).json({
          message: `Missing required scope: ${scope}`
        });
      }
      
      // Check required fields for decarbonizationModule
      if (scope === 'decarbonizationModule') {
        if (!proposalData.scopes[scope].name || !proposalData.scopes[scope].dataType) {
          return res.status(400).json({
            message: `${scope} requires both name and dataType fields`
          });
        }
      }
    }

    // Validate consolidatedData structure
    if (!proposalData.consolidatedData) {
      return res.status(400).json({
        message: "consolidatedData is required"
      });
    }

    const requiredConsolidatedScopes = ['scope1', 'scope2', 'scope3'];
    for (const scope of requiredConsolidatedScopes) {
      if (!proposalData.consolidatedData[scope]) {
        return res.status(400).json({
          message: `Missing consolidatedData for ${scope}`
        });
      }
      
      const scopeData = proposalData.consolidatedData[scope];
      if (!scopeData.category || scopeData.totalDataPoints === undefined || !scopeData.collectionMethods) {
        return res.status(400).json({
          message: `${scope} in consolidatedData requires category, totalDataPoints, and collectionMethods`
        });
      }
    }
    
    // Generate proposal number
    const proposalNumber = `ZC-${clientId}-${Date.now()}`;
    
    // Update proposal data with new structure
    client.proposalData = {
      // Basic proposal info
      proposalNumber,
      proposalDate: new Date(),
      validUntil: moment().add(30, 'days').toDate(),
      
      // Services and pricing (existing structure)
      servicesOffered: proposalData.servicesOffered || [],
      pricing: {
        basePrice: proposalData.pricing?.basePrice || 0,
        additionalServices: proposalData.pricing?.additionalServices || [],
        discounts: proposalData.pricing?.discounts || [],
        totalAmount: proposalData.pricing?.totalAmount || 0,
        currency: proposalData.pricing?.currency || "INR",
        paymentTerms: proposalData.pricing?.paymentTerms || ""
      },
      
      // Terms and SLA (existing structure)
      termsAndConditions: proposalData.termsAndConditions || "",
      sla: {
        responseTime: proposalData.sla?.responseTime || "",
        resolutionTime: proposalData.sla?.resolutionTime || "",
        availability: proposalData.sla?.availability || ""
      },
      
      // New data integration fields
      totalDataIntegrationPoints: proposalData.totalDataIntegrationPoints,
      
      scopes: {
        scope1_directEmissions: {
          name: proposalData.scopes.scope1_directEmissions?.name?.trim() || "",
          dataType: proposalData.scopes.scope1_directEmissions?.dataType?.trim() || ""
        },
        scope2_energyConsumption: {
          name: proposalData.scopes.scope2_energyConsumption?.name?.trim() || "",
          dataType: proposalData.scopes.scope2_energyConsumption?.dataType?.trim() || ""
        },
        scope3_purchasedGoodsServices: {
          name: proposalData.scopes.scope3_purchasedGoodsServices?.name?.trim() || "",
          dataType: proposalData.scopes.scope3_purchasedGoodsServices?.dataType?.trim() || ""
        },
        manualDataCollection: {
          name: proposalData.scopes.manualDataCollection?.name?.trim() || "",
          dataType: proposalData.scopes.manualDataCollection?.dataType?.trim() || ""
        },
        decarbonizationModule: {
          name: proposalData.scopes.decarbonizationModule.name.trim(),
          dataType: proposalData.scopes.decarbonizationModule.dataType.trim()
        }
      },
      
      consolidatedData: {
        scope1: {
          category: proposalData.consolidatedData.scope1.category,
          totalDataPoints: proposalData.consolidatedData.scope1.totalDataPoints,
          collectionMethods: proposalData.consolidatedData.scope1.collectionMethods
        },
        scope2: {
          category: proposalData.consolidatedData.scope2.category,
          totalDataPoints: proposalData.consolidatedData.scope2.totalDataPoints,
          collectionMethods: proposalData.consolidatedData.scope2.collectionMethods
        },
        scope3: {
          category: proposalData.consolidatedData.scope3.category,
          totalDataPoints: proposalData.consolidatedData.scope3.totalDataPoints,
          collectionMethods: proposalData.consolidatedData.scope3.collectionMethods
        }
      }
    };
    
    client.status = "proposal_submitted";
    client.timeline.push({
      stage: "proposal",
      status: "proposal_submitted",
      action: "Proposal created and sent",
      performedBy: req.user.id,
      notes: `Proposal ${proposalNumber} sent to client with ${proposalData.totalDataIntegrationPoints} data integration points`
    });
    
    await client.save();
    
    // Send proposal email with updated information
    const emailSubject = "ZeroCarbon - Service Proposal";
    const emailMessage = `
      Dear ${client.submissionData?.companyInfo?.primaryContactPerson?.name || 'Valued Client'},
      
      We are pleased to present our comprehensive carbon footprint management proposal.
      
      Proposal Details:
      - Proposal Number: ${proposalNumber}
      - Valid Until: ${moment(client.proposalData.validUntil).format('DD/MM/YYYY')}
      - Total Amount: ₹${client.proposalData.pricing.totalAmount}
      - Data Integration Points: ${proposalData.totalDataIntegrationPoints}
      
      Our solution covers:
      • ${proposalData.consolidatedData.scope1.category} (${proposalData.consolidatedData.scope1.totalDataPoints} data points)
      • ${proposalData.consolidatedData.scope2.category} (${proposalData.consolidatedData.scope2.totalDataPoints} data points)
      • ${proposalData.consolidatedData.scope3.category} (${proposalData.consolidatedData.scope3.totalDataPoints} data points)
      
      Please review the proposal and let us know if you have any questions.
      
      Best regards,
      ZeroCarbon Team
    `;
    
    await sendMail(
      client.submissionData?.companyInfo?.primaryContactPerson?.email || client.leadInfo?.email, 
      emailSubject, 
      emailMessage
    );
    
    res.status(200).json({
      message: "Proposal created and sent successfully",
      proposal: {
        clientId: client.clientId,
        proposalNumber,
        validUntil: client.proposalData.validUntil,
        totalAmount: client.proposalData.pricing.totalAmount,
        totalDataIntegrationPoints: proposalData.totalDataIntegrationPoints,
        scopes: Object.keys(proposalData.scopes),
        consolidatedData: {
          scope1: proposalData.consolidatedData.scope1.totalDataPoints,
          scope2: proposalData.consolidatedData.scope2.totalDataPoints,
          scope3: proposalData.consolidatedData.scope3.totalDataPoints
        }
      }
    });
    
  } catch (error) {
    console.error("Create proposal error:", error);
    res.status(500).json({ 
      message: "Failed to create proposal", 
      error: error.message 
    });
  }
};

// Edit Proposal (Stage 3, creator-only)
const editProposal = async (req, res) => {
  try {
    const { clientId } = req.params;
    const updatedFields = req.body; // Expecting same shape as createProposal payload

    // A) Only consultant_admin may edit
    if (!req.user || req.user.userType !== "consultant_admin") {
      return res.status(403).json({
        message: "Only Consultant Admins can edit proposals"
      });
    }

    // B) Find the client record
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    // C) Client must be in "proposal" stage
    if (client.stage !== "proposal") {
      return res.status(400).json({
        message: "Cannot edit: client is not in proposal stage"
      });
    }

    // D) Only the same consultant_admin who created the proposal may edit
    const creatorId = client.leadInfo.createdBy.toString();;
    if (req.user.id !== creatorId) {
      return res.status(403).json({
        message: "You can only edit the proposal you originally created"
      });
    }

    // E) Validate any required fields again (optional—but recommended)
    //    For example, ensure updatedFields.totalDataIntegrationPoints still exists, etc.
    if (updatedFields.totalDataIntegrationPoints === undefined) {
      return res.status(400).json({
        message: "totalDataIntegrationPoints is required"
      });
    }
    const requiredScopes = [
      "scope1_directEmissions",
      "scope2_energyConsumption",
      "scope3_purchasedGoodsServices",
      "manualDataCollection",
      "decarbonizationModule"
    ];
    for (const scope of requiredScopes) {
      if (!updatedFields.scopes || !updatedFields.scopes[scope]) {
        return res.status(400).json({
          message: `Missing required scope: ${scope}`
        });
      }
      // decarbonizationModule still needs both fields
      if (scope === "decarbonizationModule") {
        if (
          !updatedFields.scopes[scope].name ||
          !updatedFields.scopes[scope].dataType
        ) {
          return res.status(400).json({
            message: `${scope} requires both name and dataType fields`
          });
        }
      }
    }
    if (!updatedFields.consolidatedData) {
      return res.status(400).json({
        message: "consolidatedData is required"
      });
    }
    for (const scope of ["scope1", "scope2", "scope3"]) {
      if (!updatedFields.consolidatedData[scope]) {
        return res.status(400).json({
          message: `Missing consolidatedData for ${scope}`
        });
      }
      const scopeData = updatedFields.consolidatedData[scope];
      if (
        !scopeData.category ||
        scopeData.totalDataPoints === undefined ||
        !scopeData.collectionMethods
      ) {
        return res.status(400).json({
          message: `${scope} in consolidatedData requires category, totalDataPoints, and collectionMethods`
        });
      }
    }

    // F) Overwrite all fields in client.proposalData, but preserve `createdBy` & `proposalNumber`
    client.proposalData = {
      createdBy: client.proposalData.createdBy,    // preserve original creator
      proposalNumber: client.proposalData.proposalNumber,
      proposalDate: new Date(),
      validUntil: moment().add(30, "days").toDate(),

      servicesOffered: updatedFields.servicesOffered || [],
      pricing: {
        basePrice: updatedFields.pricing?.basePrice || 0,
        additionalServices: updatedFields.pricing?.additionalServices || [],
        discounts: updatedFields.pricing?.discounts || [],
        totalAmount: updatedFields.pricing?.totalAmount || 0,
        currency: updatedFields.pricing?.currency || "INR",
        paymentTerms: updatedFields.pricing?.paymentTerms || ""
      },

      termsAndConditions: updatedFields.termsAndConditions || "",
      sla: {
        responseTime: updatedFields.sla?.responseTime || "",
        resolutionTime: updatedFields.sla?.resolutionTime || "",
        availability: updatedFields.sla?.availability || ""
      },

      totalDataIntegrationPoints: updatedFields.totalDataIntegrationPoints,

      scopes: {
        scope1_directEmissions: {
          name: updatedFields.scopes.scope1_directEmissions?.name.trim() || "",
          dataType: updatedFields.scopes.scope1_directEmissions?.dataType.trim() || ""
        },
        scope2_energyConsumption: {
          name: updatedFields.scopes.scope2_energyConsumption?.name.trim() || "",
          dataType: updatedFields.scopes.scope2_energyConsumption?.dataType.trim() || ""
        },
        scope3_purchasedGoodsServices: {
          name: updatedFields.scopes.scope3_purchasedGoodsServices?.name.trim() || "",
          dataType: updatedFields.scopes.scope3_purchasedGoodsServices?.dataType.trim() || ""
        },
        manualDataCollection: {
          name: updatedFields.scopes.manualDataCollection?.name.trim() || "",
          dataType: updatedFields.scopes.manualDataCollection?.dataType.trim() || ""
        },
        decarbonizationModule: {
          name: updatedFields.scopes.decarbonizationModule.name.trim(),
          dataType: updatedFields.scopes.decarbonizationModule.dataType.trim()
        }
      },

      consolidatedData: {
        scope1: {
          category: updatedFields.consolidatedData.scope1.category,
          totalDataPoints: updatedFields.consolidatedData.scope1.totalDataPoints,
          collectionMethods: updatedFields.consolidatedData.scope1.collectionMethods
        },
        scope2: {
          category: updatedFields.consolidatedData.scope2.category,
          totalDataPoints: updatedFields.consolidatedData.scope2.totalDataPoints,
          collectionMethods: updatedFields.consolidatedData.scope2.collectionMethods
        },
        scope3: {
          category: updatedFields.consolidatedData.scope3.category,
          totalDataPoints: updatedFields.consolidatedData.scope3.totalDataPoints,
          collectionMethods: updatedFields.consolidatedData.scope3.collectionMethods
        }
      }
    };

    // G) Revert client back to “registered” stage with status “submitted”
    client.stage = "proposal";
    client.status = "proposal_submitted";

    // H) Timeline entry indicating edit
    client.timeline.push({
      stage: "proposal",
      status: "proposal_submitted",
      action: "Proposal edited and reverted to data submission",
      performedBy: req.user.id,
      notes: `Proposal ${client.proposalData.proposalNumber} was edited`
    });

    await client.save();

    return res.status(200).json({
      message:
        "Proposal updated successfully; client reverted to registered stage (resubmit data → moveToProposal again)",
      proposalNumber: client.proposalData.proposalNumber,
      client: {
        clientId: client.clientId,
        stage: client.stage,
        status: client.status
      }
    });
  } catch (error) {
    console.error("Edit proposal error:", error);
    return res.status(500).json({
      message: "Failed to edit proposal",
      error: error.message
    });
  }
};

// ─── Get Client Proposal Data (creator-only or assignedConsultant) ─────────────────────────────
const getClientProposalData = async (req, res) => {
  try {
    const { clientId } = req.params;

    // A) Must be a consultant (consultant_admin or consultant)
    if (!["consultant_admin", "consultant"].includes(req.user.userType)) {
      return res.status(403).json({
        message: "Only Consultants can view proposal data",
      });
    }

    // B) Find the client record
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }



    // D) Ensure proposalData exists
    if (!client.proposalData || !client.proposalData.proposalNumber) {
      return res.status(404).json({
        message: "No proposal data available for this client",
      });
    }

    // E) Return proposalData
    return res.status(200).json({
      message: "Proposal data fetched successfully",
      proposalData: client.proposalData,
    });
  } catch (error) {
    console.error("Get proposal data error:", error);
    return res.status(500).json({
      message: "Failed to fetch proposal data",
      error: error.message,
    });
  }
};

// ─── Delete Proposal (Consultant Admin only, creator-only) ──────────────────────────────────────────
const deleteProposal = async (req, res) => {
  try {
    const { clientId } = req.params;

    // A) Only consultant_admin may delete
    if (!req.user || req.user.userType !== "consultant_admin") {
      return res.status(403).json({
        message: "Only Consultant Admins can delete proposals",
      });
    }

    // B) Find the client record
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    // C) Client must be in “proposal” stage
    if (client.stage !== "proposal") {
      return res.status(400).json({
        message: "Cannot delete: client is not currently in proposal stage",
      });
    }

    // D) Only the same consultant_admin who created the proposal may delete
    const creatorId =  client.leadInfo.createdBy.toString();
    if (!creatorId || req.user.id !== creatorId) {
      return res.status(403).json({
        message: "You can only delete the proposal you originally created",
      });
    }

    // E) Reset proposalData to an empty skeleton
    client.proposalData = {
      proposalNumber: "",
      proposalDate: null,
      validUntil: null,

      servicesOffered: [],
      pricing: {
        basePrice: 0,
        additionalServices: [],
        discounts: [],
        totalAmount: 0,
        currency: "",
        paymentTerms: ""
      },

      termsAndConditions: "",
      sla: {
        responseTime: "",
        resolutionTime: "",
        availability: ""
      },

      totalDataIntegrationPoints: 0,

      scopes: {
        scope1_directEmissions: { name: "", dataType: "" },
        scope2_energyConsumption: { name: "", dataType: "" },
        scope3_purchasedGoodsServices: { name: "", dataType: "" },
        manualDataCollection: { name: "", dataType: "" },
        decarbonizationModule: { name: "", dataType: "" }
      },

      consolidatedData: {
        scope1: { category: "", totalDataPoints: 0, collectionMethods: [] },
        scope2: { category: "", totalDataPoints: 0, collectionMethods: [] },
        scope3: { category: "", totalDataPoints: 0, collectionMethods: [] }
      }
    };

    // F) Keep stage as "proposal", revert status to "proposal_pending"
    client.stage = "proposal";
    client.status = "proposal_pending";

    // G) Log timeline entry
    client.timeline.push({
      stage: "proposal",
      status: "proposal_pending",
      action: "Proposal deleted",
      performedBy: req.user.id,
      notes: "Consultant Admin deleted the proposal; client remains in proposal stage"
    });

    await client.save();

    return res.status(200).json({
      message:
        "Proposal deleted successfully; client status reverted to proposal_pending",
      client: {
        clientId: client.clientId,
        stage: client.stage,
        status: client.status,
        proposalData: client.proposalData
      }
    });
  } catch (error) {
    console.error("Delete proposal error:", error);
    return res.status(500).json({
      message: "Failed to delete proposal",
      error: error.message
    });
  }
};

// Accept/Reject Proposal
// Accept/Reject Proposal - FIXED VERSION
const updateProposalStatus = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { action, reason } = req.body;

    if (req.user.userType !== "consultant_admin") {
      return res.status(403).json({
        message: "Only Consultant Admins can update proposal status",
      });
    }

    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }
    if (client.stage !== "proposal" || client.status !== "proposal_submitted") {
      return res.status(400).json({
        message: "No active proposal found for this client",
      });
    }

    if (action === "accept") {
      client.status = "proposal_accepted";
      client.proposalData.clientApprovalDate = new Date();
      const approvedByName =
        client.submissionData?.companyInfo?.primaryContactPerson?.name ||
        client.leadInfo?.contactPersonName ||
        "Client Representative";
      client.proposalData.approvedBy = approvedByName;

      client.stage = "active";
      client.accountDetails = {
        subscriptionStartDate: new Date(),
        subscriptionEndDate: moment().add(1, "year").toDate(),
        subscriptionStatus: "active",
        isActive: true,
        activeUsers: 1,
        lastLoginDate: null,
        dataSubmissions: 0,
      };

      client.timeline.push({
        stage: "active",
        status: "active",
        action: "Proposal accepted and account activated",
        performedBy: req.user.id,
        notes: "Client subscription activated for 1 year",
      });

      // Try to create a client admin—but if it already exists, we still continue
      try {
        await createClientAdmin(clientId, {
          consultantId: req.user.id,
        });
      } catch (err) {
        console.warn(
          `createClientAdmin threw an error but was caught: ${err.message}`
        );
        // We do NOT re‐throw, because we still want the client to move to active
      }

      await client.save();

      return res.status(200).json({
        message: "Proposal accepted and client account activated",
        client: {
          clientId: client.clientId,
          stage: client.stage,
          status: client.accountDetails.subscriptionStatus,
          subscriptionEndDate: client.accountDetails.subscriptionEndDate,
        },
      });
    } else if (action === "reject") {
      client.status = "proposal_rejected";
      client.proposalData.rejectionReason = reason;
      client.timeline.push({
        stage: "proposal",
        status: "proposal_rejected",
        action: "Proposal rejected",
        performedBy: req.user.id,
        notes: reason || "Client rejected the proposal",
      });

      await client.save();

      return res.status(200).json({
        message: "Proposal rejected",
        client: {
          clientId: client.clientId,
          stage: client.stage,
          status: client.status,
        },
      });
    } else {
      return res.status(400).json({
        message: "Invalid action. Use 'accept' or 'reject'",
      });
    }
  } catch (error) {
    console.error("Update proposal status error:", error);
    return res.status(500).json({
      message: "Failed to update proposal status",
      error: error.message,
    });
  }
};

// Get Clients based on user permissions
const getClients = async (req, res) => {
  try {
    let query = { isDeleted: false };
    const { stage, status, search } = req.query;
    
    // Build query based on user type
    switch (req.user.userType) {
      case "super_admin":
        // Can see all clients
        break;
        
      case "consultant_admin":
        // Can see clients they or their consultants manage
        const consultants = await User.find({ 
          consultantAdminId: req.user.id 
        }).select("_id");
        
        const consultantIds = consultants.map(c => c._id);
        consultantIds.push(req.user.id);
        
        query.$or = [
          { "leadInfo.consultantAdminId": req.user.id },
          { "leadInfo.assignedConsultantId": { $in: consultantIds } }
        ];
        break;
        
      case "consultant":
        // Can see assigned clients
        query["leadInfo.assignedConsultantId"] = req.user.id;
        break;
        
      case "client_admin":
      case "auditor":
      case "viewer":
        // Can see own client data
        query.clientId = req.user.clientId;
        break;
        
      default:
        return res.status(403).json({ 
          message: "You don't have permission to view clients" 
        });
    }
    
    // Apply filters
    if (stage) query.stage = stage;
    if (status) query.status = status;
    if (search) {
      query.$or = [
        { clientId: { $regex: search, $options: 'i' } },
        { "leadInfo.companyName": { $regex: search, $options: 'i' } },
        { "leadInfo.email": { $regex: search, $options: 'i' } }
      ];
    }
    
    const clients = await Client.find(query)
      .populate("leadInfo.consultantAdminId", "userName email")
      .populate("leadInfo.assignedConsultantId", "userName email")
      .sort({ createdAt: -1 });
    
    res.status(200).json({
      message: "Clients fetched successfully",
      clients
    });
    
  } catch (error) {
    console.error("Get clients error:", error);
    res.status(500).json({ 
      message: "Failed to fetch clients", 
      error: error.message 
    });
  }
};

// Get single client details
const getClientById = async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await Client.findOne({ clientId })
      .populate("leadInfo.consultantAdminId", "userName email")
      .populate("leadInfo.assignedConsultantId", "userName email")
      .populate("timeline.performedBy", "userName email");
    
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }
    
    // Check permissions
    let hasAccess = false;
    
    switch (req.user.userType) {
      case "super_admin":
        hasAccess = true;
        break;
        
      case "consultant_admin":
        hasAccess = client.leadInfo.consultantAdminId._id.toString() === req.user.id;
        break;
        
      case "consultant":
        hasAccess = client.leadInfo.assignedConsultantId?._id.toString() === req.user.id;
        break;
        
      case "client_admin":
      case "client_employee_head":
      case "auditor":
      case "viewer":
        hasAccess = client.clientId === req.user.clientId;
        break;
        
      default:
        hasAccess = false;
    }
    
    if (!hasAccess) {
      return res.status(403).json({ 
        message: "You don't have permission to view this client" 
      });
    }
    
    res.status(200).json({
      message: "Client details fetched successfully",
      client
    });
    
  } catch (error) {
    console.error("Get client by ID error:", error);
    res.status(500).json({ 
      message: "Failed to fetch client details", 
      error: error.message 
    });
  }
};

// Update client assignment
const assignConsultant = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { consultantId } = req.body;
    
    // Only consultant admin can assign consultants
    if (req.user.userType !== "consultant_admin") {
      return res.status(403).json({ 
        message: "Only Consultant Admins can assign consultants" 
      });
    }
    
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }
    
    // Verify consultant belongs to this consultant admin
    const consultant = await User.findOne({
      _id: consultantId,
      userType: "consultant",
      consultantAdminId: req.user.id
    });
    
    if (!consultant) {
      return res.status(400).json({ 
        message: "Invalid consultant or consultant not under your management" 
      });
    }
    
    client.leadInfo.assignedConsultantId = consultantId;
    client.timeline.push({
      stage: client.stage,
      status: client.status,
      action: "Consultant assigned",
      performedBy: req.user.id,
      notes: `Assigned to ${consultant.userName}`
    });
    
    await client.save();
    
    // Notify the assigned consultant
    const emailSubject = "New Client Assignment";
    const emailMessage = `
      You have been assigned to a new client:
      
      Client ID: ${clientId}
      Company: ${client.leadInfo.companyName}
      Current Stage: ${client.stage}
      
      Please review the client details and take appropriate action.
    `;
    
    await sendMail(consultant.email, emailSubject, emailMessage);
    
    res.status(200).json({
      message: "Consultant assigned successfully",
      client: {
        clientId: client.clientId,
        assignedConsultant: {
          id: consultant._id,
          name: consultant.userName,
          email: consultant.email
        }
      }
    });
    
  } catch (error) {
    console.error("Assign consultant error:", error);
    res.status(500).json({ 
      message: "Failed to assign consultant", 
      error: error.message 
    });
  }
};

// Manage subscription
const manageSubscription = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { action, reason, extensionDays } = req.body;
    
    // Check permissions
    if (!["super_admin", "consultant_admin"].includes(req.user.userType)) {
      return res.status(403).json({ 
        message: "Only Super Admin and Consultant Admin can manage subscriptions" 
      });
    }
    
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }
    
    if (client.stage !== "active") {
      return res.status(400).json({ 
        message: "Client is not in active stage" 
      });
    }
    
    switch (action) {
      case "suspend":
        client.accountDetails.subscriptionStatus = "suspended";
        client.accountDetails.isActive = false;
        client.accountDetails.suspensionReason = reason;
        client.accountDetails.suspendedBy = req.user.id;
        client.accountDetails.suspendedAt = new Date();
        
        // Deactivate all client users
        await User.updateMany(
          { clientId: client.clientId },
          { isActive: false }
        );
        
        client.timeline.push({
          stage: "active",
          status: "suspended",
          action: "Subscription suspended",
          performedBy: req.user.id,
          notes: reason
        });
        
        break;
        
      case "reactivate":
        client.accountDetails.subscriptionStatus = "active";
        client.accountDetails.isActive = true;
        client.accountDetails.suspensionReason = null;
        client.accountDetails.suspendedBy = null;
        client.accountDetails.suspendedAt = null;
        
        // Reactivate client admin only
        await User.updateOne(
          { 
            _id: client.accountDetails.clientAdminId,
            userType: "client_admin"
          },
          { isActive: true }
        );
        
        client.timeline.push({
          stage: "active",
          status: "active",
          action: "Subscription reactivated",
          performedBy: req.user.id,
          notes: "Account reactivated"
        });
        
        break;
        
      case "extend":
        const currentEndDate = moment(client.accountDetails.subscriptionEndDate);
        const newEndDate = currentEndDate.add(extensionDays || 30, 'days');
        
        client.accountDetails.subscriptionEndDate = newEndDate.toDate();
        
        client.timeline.push({
          stage: "active",
          status: client.accountDetails.subscriptionStatus,
          action: "Subscription extended",
          performedBy: req.user.id,
          notes: `Extended by ${extensionDays || 30} days`
        });
        
        break;
        
      case "renew":
        client.accountDetails.subscriptionStartDate = new Date();
        client.accountDetails.subscriptionEndDate = moment().add(1, 'year').toDate();
        client.accountDetails.subscriptionStatus = "active";
        client.accountDetails.isActive = true;
        
        client.timeline.push({
          stage: "active",
          status: "active",
          action: "Subscription renewed",
          performedBy: req.user.id,
          notes: "Renewed for 1 year"
        });
        
        break;
        
      default:
        return res.status(400).json({ 
          message: "Invalid action. Use: suspend, reactivate, extend, or renew" 
        });
    }
    
    await client.save();
    
    res.status(200).json({
      message: `Subscription ${action} successful`,
      subscription: {
        status: client.accountDetails.subscriptionStatus,
        endDate: client.accountDetails.subscriptionEndDate,
        isActive: client.accountDetails.isActive
      }
    });
    
  } catch (error) {
    console.error("Manage subscription error:", error);
    res.status(500).json({ 
      message: "Failed to manage subscription", 
      error: error.message 
    });
  }
};

// Dashboard metrics
const getDashboardMetrics = async (req, res) => {
  try {
    let query = { isDeleted: false };
    
    // Build query based on user type
    if (req.user.userType === "consultant_admin") {
      const consultants = await User.find({ 
        consultantAdminId: req.user.id 
      }).select("_id");
      
      const consultantIds = consultants.map(c => c._id);
      consultantIds.push(req.user.id);
      
      query.$or = [
        { "leadInfo.consultantAdminId": req.user.id },
        { "leadInfo.assignedConsultantId": { $in: consultantIds } }
      ];
    } else if (req.user.userType === "consultant") {
      query["leadInfo.assignedConsultantId"] = req.user.id;
    } else if (!["super_admin"].includes(req.user.userType)) {
      return res.status(403).json({ 
        message: "You don't have permission to view dashboard metrics" 
      });
    }
    
    // Get counts by stage
    const stageCount = await Client.aggregate([
      { $match: query },
      {
        $group: {
          _id: "$stage",
          count: { $sum: 1 }
        }
      }
    ]);
    
    // Get active subscriptions expiring soon (within 30 days)
    const expiringSoon = await Client.countDocuments({
      ...query,
      stage: "active",
      "accountDetails.subscriptionEndDate": {
        $lte: moment().add(30, 'days').toDate(),
        $gte: new Date()
      }
    });
    
    // Get recent activities
    const recentActivities = await Client.find(query)
      .select("clientId stage status timeline")
      .populate("timeline.performedBy", "userName")
      .sort({ "timeline.timestamp": -1 })
      .limit(10);
    
    // Format recent activities
    const activities = [];
    recentActivities.forEach(client => {
      if (client.timeline.length > 0) {
        const lastAction = client.timeline[client.timeline.length - 1];
        activities.push({
          clientId: client.clientId,
          action: lastAction.action,
          performedBy: lastAction.performedBy?.userName,
          timestamp: lastAction.timestamp
        });
      }
    });
    
    // Calculate conversion rates
    const totalLeads = stageCount.find(s => s._id === "lead")?.count || 0;
    const totalActive = stageCount.find(s => s._id === "active")?.count || 0;
    const conversionRate = totalLeads > 0 ? (totalActive / totalLeads * 100).toFixed(2) : 0;
    
    res.status(200).json({
      message: "Dashboard metrics fetched successfully",
      metrics: {
        stageDistribution: stageCount.reduce((acc, curr) => {
          acc[curr._id] = curr.count;
          return acc;
        }, {}),
        totalClients: stageCount.reduce((sum, curr) => sum + curr.count, 0),
        activeClients: totalActive,
        expiringSoon,
        conversionRate: `${conversionRate}%`,
        recentActivities: activities
      }
    });
    
  } catch (error) {
    console.error("Get dashboard metrics error:", error);
    res.status(500).json({ 
      message: "Failed to fetch dashboard metrics", 
      error: error.message 
    });
  }
};

// Check and update expired subscriptions (to be called by cron job)
const checkExpiredSubscriptions = async () => {
  try {
    const expiredClients = await Client.find({
      stage: "active",
      "accountDetails.subscriptionEndDate": { $lte: new Date() },
      "accountDetails.subscriptionStatus": "active"
    });
    
    for (const client of expiredClients) {
      // Check if in grace period (30 days)
      const daysSinceExpiry = moment().diff(
        moment(client.accountDetails.subscriptionEndDate), 
        'days'
      );
      
      if (daysSinceExpiry <= 30) {
        // Grace period
        client.accountDetails.subscriptionStatus = "grace_period";
        
        // Send grace period notification
        const clientAdmin = await User.findById(client.accountDetails.clientAdminId);
        if (clientAdmin) {
          const emailSubject = "ZeroCarbon - Subscription Expired (Grace Period)";
          const emailMessage = `
            Your ZeroCarbon subscription has expired.
            
            You are currently in a 30-day grace period. Please renew your subscription to continue using our services.
            
            Grace period ends on: ${moment(client.accountDetails.subscriptionEndDate).add(30, 'days').format('DD/MM/YYYY')}
            
            Contact your consultant for renewal.
          `;
          
          await sendMail(clientAdmin.email, emailSubject, emailMessage);
        }
      } else {
        // Fully expired
        client.accountDetails.subscriptionStatus = "expired";
        client.accountDetails.isActive = false;
        
        // Deactivate all users
        await User.updateMany(
          { clientId: client.clientId },
          { isActive: false }
        );
      }
      
      client.timeline.push({
        stage: "active",
        status: client.accountDetails.subscriptionStatus,
        action: `Subscription ${client.accountDetails.subscriptionStatus}`,
        performedBy: null,
        notes: "Automatic system update"
      });
      
      await client.save();
    }
    
    console.log(`Processed ${expiredClients.length} expired subscriptions`);
    
  } catch (error) {
    console.error("Check expired subscriptions error:", error);
  }
};

module.exports = {
  createLead,
  updateLead,
  deleteLead,
  getLeads,
  moveToDataSubmission,
  submitClientData,
  updateClientData,
  deleteClientData,
  getClientSubmissionData,
  moveToProposal,
  createProposal,
  editProposal,
  deleteProposal,
  getClientProposalData,
  updateProposalStatus,
  getClients,
  getClientById,
  assignConsultant,
  manageSubscription,
  getDashboardMetrics,
  checkExpiredSubscriptions
};