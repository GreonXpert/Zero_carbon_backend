// utils/Permissions/summaryPermission.js

const Client = require('../../models/Client');
const User = require('../../models/User');
const { getActiveFlowchart } = require('../DataCollection/dataCollection');

const checkSummaryPermission = async (req, res, next) => {
    try {
        const { clientId } = req.params;
        const user = req.user;

        // Debug logging to understand the user object structure
        console.log('Permission Check Debug:', {
            userType: user?.userType,
            userId: user?._id || user?.id,
            userIdType: typeof (user?._id || user?.id),
            clientIdParam: clientId
        });

        if (!user) {
            return res.status(401).json({ 
                success: false, 
                message: 'Authentication required.' 
            });
        }

        // Get the user ID (handle both _id and id cases)
        const userId = (user._id || user.id).toString();

        // Fetch client - NO population needed, we'll work with ObjectIds directly
        const client = await Client.findOne({ clientId }).lean();

        if (!client) {
            return res.status(404).json({ 
                success: false, 
                message: 'Client not found.' 
            });
        }

        // Helper function to safely convert ObjectId to string
        const getIdString = (field) => {
            if (!field) return null;
            // Handle both ObjectId and populated object cases
            if (field._id) return field._id.toString();
            if (field.$oid) return field.$oid;
            return field.toString();
        };

        // Extract consultant IDs from client
        const clientConsultantAdminId = getIdString(client.leadInfo?.consultantAdminId);
        const clientAssignedConsultantId = getIdString(client.leadInfo?.assignedConsultantId);
        const workflowAssignedConsultantId = getIdString(client.workflowTracking?.assignedConsultantId);
        const createdById = getIdString(client.leadInfo?.createdBy);

        // Debug logging for consultant IDs
        console.log('Client Permission Data:', {
            consultantAdminId: clientConsultantAdminId,
            assignedConsultantId: clientAssignedConsultantId,
            workflowAssignedConsultantId: workflowAssignedConsultantId,
            createdBy: createdById,
            currentUserId: userId
        });

        // Build permission check based on user type (following getClients pattern)
        switch (user.userType) {
            case "super_admin":
                // Super Admin: Can access all summaries
                console.log('Access granted: Super Admin');
                return next();

            case "consultant_admin":
                // Consultant Admin: Can see clients they or their consultants manage
                
                // Check if this consultant admin is directly assigned to the client
                if (clientConsultantAdminId === userId) {
                    console.log('Access granted: Direct Consultant Admin assignment');
                    return next();
                }

                // Check if they created the client
                if (createdById === userId) {
                    console.log('Access granted: Client Creator Consultant Admin');
                    return next();
                }

                // Find all consultants under this consultant admin
                const consultants = await User.find({ 
                    consultantAdminId: userId,
                    userType: 'consultant'
                }).select("_id").lean();
                
                // Create array of consultant IDs as strings
                const consultantIds = consultants.map(c => c._id.toString());
                
                console.log('Consultant Admin - Team IDs:', consultantIds);
                
                // Check if any of their consultants are assigned to this client
                const hasTeamAccess = 
                    (clientAssignedConsultantId && consultantIds.includes(clientAssignedConsultantId)) ||
                    (workflowAssignedConsultantId && consultantIds.includes(workflowAssignedConsultantId));
                
                if (hasTeamAccess) {
                    console.log('Access granted: Consultant Admin manages assigned consultant');
                    return next();
                }
                
                console.log('Access denied: Consultant Admin without permission');
                return res.status(403).json({
                    success: false,
                    message: 'Access denied. You do not have permission to view this client\'s summary.',
                    debug: process.env.NODE_ENV === 'development' ? {
                        yourId: userId,
                        yourTeam: consultantIds,
                        clientConsultantAdminId: clientConsultantAdminId,
                        clientAssignedConsultantId: clientAssignedConsultantId,
                        workflowAssignedConsultantId: workflowAssignedConsultantId
                    } : undefined
                });

            case "consultant":
                // Consultant: Can see assigned clients only
                const isAssignedConsultant = 
                    clientAssignedConsultantId === userId ||
                    workflowAssignedConsultantId === userId;
                
                if (isAssignedConsultant) {
                    console.log('Access granted: Assigned Consultant');
                    return next();
                }
                
                console.log('Access denied: Consultant without assignment');
                return res.status(403).json({
                    success: false,
                    message: 'Access denied. You are not assigned to this client.',
                    debug: process.env.NODE_ENV === 'development' ? {
                        yourId: userId,
                        clientAssignedConsultantId: clientAssignedConsultantId,
                        workflowAssignedConsultantId: workflowAssignedConsultantId
                    } : undefined
                });

            case "client_admin":
            case "auditor":
            case "viewer":
                // Client users: Can only access their own organization's summary
                if (user.clientId === clientId) {
                    console.log(`Access granted: ${user.userType} - own organization`);
                    return next();
                }
                
                return res.status(403).json({
                    success: false,
                    message: 'Access denied. You can only view summaries for your own organization.',
                    yourClientId: user.clientId,
                    requestedClientId: clientId
                });

            case "client_employee_head":
                // Employee Head: Can access summaries for their organization
                if (user.clientId !== clientId) {
                    return res.status(403).json({
                        success: false,
                        message: 'Access denied. You can only view summaries for your own organization.',
                        yourClientId: user.clientId,
                        requestedClientId: clientId
                    });
                }

                // Additional check: Must be assigned to at least one node
                const activeFlowchart = await getActiveFlowchart(clientId);
                if (activeFlowchart && activeFlowchart.chart) {
                    const isAssigned = activeFlowchart.chart.nodes.some(
                        node => {
                            const nodeEmployeeHeadId = getIdString(node.details.employeeHeadId);
                            return nodeEmployeeHeadId === userId;
                        }
                    );

                    if (isAssigned) {
                        console.log('Access granted: Employee Head with node assignment');
                        return next();
                    }
                }

                return res.status(403).json({
                    success: false,
                    message: 'Access denied. You are not assigned to any nodes in this organization.'
                });

            case "employee":
                // Regular Employee: Can access summaries for their organization (if needed)
                if (user.clientId === clientId) {
                    console.log('Access granted: Employee - own organization');
                    return next();
                }
                
                return res.status(403).json({
                    success: false,
                    message: 'Access denied. You can only view summaries for your own organization.',
                    yourClientId: user.clientId,
                    requestedClientId: clientId
                });

            default:
                // Unknown user type
                console.log('Access denied: Unknown user type');
                return res.status(403).json({
                    success: false,
                    message: 'Access denied. You do not have permission to view summaries.',
                    userType: user.userType
                });
        }

    } catch (error) {
        console.error('Error in checkSummaryPermission middleware:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error during permission check.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

module.exports = { checkSummaryPermission };