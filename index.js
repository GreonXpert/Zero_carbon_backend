const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const connectDB = require("./config/db");
const path = require("path");
const http = require("http");
const socketIo = require("socket.io");
const cron = require("node-cron");
const jwt = require("jsonwebtoken");

// Import Routes
const userR = require("./router/userR");
const clientR = require("./router/CMS/clientR");
const flowchartR = require("./router/Organization/flowchartR");
const defraDataR = require("./router/EmissionFactor/defraData");
const gwpRoutes = require("./router/EmissionFactor/gwpRoutes");
const fuelCombustionRoutes = require("./router/EmissionFactor/fuelCombustionRoutes");
const CountryemissionFactorRouter = require("./router/EmissionFactor/countryemissionFactorRouter");

const processFlowR = require("./router/Organization/processflowR");
// const dataEntryRoutes = require('./router/dataEntryRoutes');
const EmissionFactorHub = require('./router/EmissionFactor/EmissionFactorHubRoutes');
const ipccDataRoutes = require('./router/EmissionFactor/ipccDataRoutes');
const EPADataRoutes = require('./router/EmissionFactor/EPADataRoutes');
const emissionFactorRoutes = require('./router/EmissionFactor/emissionFactorRoutes');
const ipccConverstionCalculation = require('./router/EmissionFactor/IpccConverstionCalculation');
const summaryRoutes = require('./router/Organization/summaryRoutes');
const reductionRoutes = require('./router/Reduction/reductionR');
const netReductionRoutes = require('./router/Reduction/netReductionR');
const FormulaR = require('./router/Reduction/FormulaR');
const netReductionSummaryR = require('./router/Reduction/netReductionSummaryR');
const DecarbonizationRoutes = require('./router/Decarbonization/sbtiRoutes');

// Import notification routes
const notificationRoutes = require('./router/Notification/notificationRoutes');
const { dataCollectionRouter, iotRouter } = require('./router/Organization/dataCollectionRoutes');

// Import IoT routes
const iotRoutes = require('./router/iotRoutes');

// Import controllers
const { checkExpiredSubscriptions } = require("./controllers/CMS/clientController");
const { initializeSuperAdmin } = require("./controllers/userController");
const { publishScheduledNotifications } = require('./controllers/Notification/notificationControllers');
const { scheduleMonthlySummary, checkAndCreateMissedSummaries } = require('./controllers/DataCollection/monthlyDataSummaryController');

// Import summary controller
const calculationSummaryController = require('./controllers/Calculation/CalculationSummary');
const dataCollectionController = require('./controllers/Organization/dataCollectionController');
const netReductionController = require('./controllers/Reduction/netReductionController');
const netReductionSummaryController = require('./controllers/Reduction/netReductionSummaryController');
const sbtiController = require('./controllers/Decabonization/sbtiController');
const transportFlowRouter = require('./router/Organization/transportFlowR');
const sandboxRoutes = require('./router/CMS/sandboxRoutes');
const apiKeyRoutes = require('./router/apiKeyRoutes');
const { startApiKeyExpiryChecker } = require('./utils/jobs/apiKeyExpiryChecker');

// Import models for real-time features
const User = require('./models/User');
const Notification = require('./models/Notification/Notification');
const dataCompletionController = require('./controllers/DataCollection/dataCompletionController');
const {
  broadcastDataCompletionUpdate,
  broadcastNetReductionCompletionUpdate
} = dataCompletionController;
// Ticket route import
const ticketRoutes = require('./router/Ticket/ticketRoutes');

// Ticket controller import
const ticketController = require('./controllers/Ticket/ticketController');

// SLA checker import
const { startSLAChecker } = require('./utils/jobs/ticketSlaChecker');
const { setTicketChatSocketIO } = require('./utils/sockets/ticketChatSocket');

const helmet = require('helmet');

dotenv.config();

const app = express();

app.use(helmet());

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true }
}));

// Middleware
app.use(express.json());

// Global request logger
app.use((req, res, next) => {
    console.log(`\n[${new Date().toISOString()}] ➜ ${req.method} ${req.originalUrl}`);
    console.log("  Params:", req.params);
    console.log("  Query :", req.query);
    console.log("  Body  :", req.body);
    next();
});

if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    next();
  });
}

// CORS allowed frontend domains
app.use(cors({
  origin: [
    "http://localhost:3000",
    "http://localhost:3002",
    "http://localhost:5174",
    'https://zerocarbon.greonxpert.com',
    'https://www.zerocarbon.greonxpert.com'
  ],
  credentials: true,
}));

// Static files
app.use(
  '/uploads',
  helmet.crossOriginResourcePolicy({ policy: "cross-origin" }),
  express.static('uploads')
);

// Routes
app.use("/api/users", userR);
app.use("/api/clients", clientR);
app.use('/api/sandbox', sandboxRoutes);
app.use("/api/flowchart", flowchartR);
app.use("/api/defra", defraDataR);
app.use("/api/gwp", gwpRoutes);
app.use("/api/fuelCombustion", fuelCombustionRoutes);
app.use("/api/country-emission-factors", CountryemissionFactorRouter);
app.use("/api/processflow", processFlowR);
app.use('/api/transport-flowchart', transportFlowRouter);
app.use('/api/emission-factor-hub', EmissionFactorHub);
app.use('/api/iot', iotRoutes);
app.use('/api/ipcc', ipccDataRoutes);
app.use('/api/epa', EPADataRoutes);
app.use('/api/emission-factors', emissionFactorRoutes);
app.use('/api/emission-factor', ipccConverstionCalculation);
app.use('/api/summaries', summaryRoutes);
app.use('/api/reductions', reductionRoutes);
app.use('/api/net-reduction', netReductionRoutes);
app.use('/api/formulas', FormulaR);
app.use('/api/sbti', DecarbonizationRoutes);

// Notification and data collection routes
app.use('/api/notifications', notificationRoutes);
app.use('/api/data-collection', dataCollectionRouter);
app.use('/api/iot', iotRouter);

app.use('/api', apiKeyRoutes);
app.use('/api/tickets', ticketRoutes);

// // In your main app.js or routes/index.js
// const debugRoutes = require('./router/debug');

// // Add this line with your other routes
// app.use('/api/debug', debugRoutes);
// ============================================================================
// 🔐 HELPER FUNCTIONS (MUST BE OUTSIDE CONNECTION HANDLER)
// ============================================================================

/**
 * Helper function to check ticket access
 * MOVED OUTSIDE connection handler to be accessible by broadcast functions
 */
async function checkTicketAccess(user, ticket) {
    try {
        const userId = user.id || user._id?.toString() || user._id;
        
        // Super admin has access to all
        if (user.userType === 'super_admin') {
            return true;
        }

        // Check if user's client matches ticket's client
        if (user.clientId === ticket.clientId) {
            // Client employee head - check department
            if (user.userType === 'client_employee_head') {
                const User = require('./models/User');
                const creator = await User.findById(ticket.createdBy);
                return creator && creator.department === user.department;
            }
            
            // Employee can only view own tickets
            if (user.userType === 'employee') {
                return ticket.createdBy.toString() === userId;
            }
            
            // Viewer can only view own tickets
            if (user.userType === 'viewer') {
                return ticket.createdBy.toString() === userId;
            }
            
            // Other client roles (client_admin, auditor) can view all client tickets
            return true;
        }

        // Check consultant access
        if (['consultant_admin', 'consultant'].includes(user.userType)) {
            const Client = require('./models/CMS/Client');
            const client = await Client.findOne({ clientId: ticket.clientId });
            
            if (!client) return false;
            
            // Consultant admin who created the lead
            if (user.userType === 'consultant_admin') {
                if (client.leadInfo?.createdBy?.toString() === userId) {
                    return true;
                }
            }
            
            // Assigned consultant
            if (client.workflowTracking?.assignedConsultantId?.toString() === userId) {
                return true;
            }
        }

        return false;
    } catch (error) {
        console.error('Error checking ticket access:', error);
        return false;
    }
}

// ============================================================================
// 📊 SOCKET.IO SERVER SETUP
// ============================================================================

// Create HTTP server and bind Socket.io
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: [
      "http://localhost:3000", 
      "http://localhost:3002", 
      "http://localhost:5174",
      "https://zerocarbon.greonxpert.com",
      "https://www.zerocarbon.greonxpert.com"
    ],
    credentials: true
  }
});

// Set socket.io instance in controllers
dataCollectionController.setSocketIO(io);
calculationSummaryController.setSocketIO(io);
netReductionController.setSocketIO(io);
sbtiController.setSocketIO(io);
dataCompletionController.setSocketIO(io);
ticketController.setSocketIO(io);

setTicketChatSocketIO(io);

// Socket.IO Authentication Middleware
io.use(async (socket, next) => {
    try {
        const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
        
        if (!token) {
            return next(new Error('Authentication token required'));
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id).select('-password');
        
        if (!user || (!user.isActive && !user.sandbox)) {
            return next(new Error('Invalid or inactive user'));
        }

        socket.userId = user._id.toString();
        socket.userType = user.userType;
        socket.clientId = user.clientId;
        socket.user = user;
        
        console.log(`🔐 User authenticated: ${user.userName} (${user.userType}) - Socket: ${socket.id}`);
        next();
    } catch (error) {
        console.error('Socket authentication error:', error.message);
        next(new Error('Authentication failed'));
    }
});

// Track connected users
const connectedUsers = new Map();

// ============================================================================
// 🔄 SOCKET.IO CONNECTION HANDLER
// ============================================================================

io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.user.userName} (${socket.id})`);
    
    // Store user connection
    connectedUsers.set(socket.userId, {
        socketId: socket.id,
        user: socket.user,
        connectedAt: new Date()
    });
    
    // Join user-specific room
    socket.join(`user_${socket.userId}`);
    
    // Join user-type specific room
    socket.join(`userType_${socket.userType}`);
    
    // Join client-specific room if user has clientId
    if (socket.clientId) {
        socket.join(`client_${socket.clientId}`);
    }
    
    // Send welcome message with user info
    socket.emit('welcome', {
        message: 'Connected to ZeroCarbon Server',
        user: {
            id: socket.user._id,
            name: socket.user.userName,
            type: socket.user.userType
        },
        timestamp: new Date().toISOString()
    });

    // ========================================================================
    // 📊 SUMMARY SOCKET HANDLERS
    // ========================================================================

    socket.on('join-summary-room', (clientId) => {
        socket.join(`summaries-${clientId}`);
        console.log(`📊 Socket ${socket.id} joined summary room: summaries-${clientId}`);
        
        socket.emit('summary-connection-status', {
            status: 'connected',
            clientId,
            timestamp: new Date(),
            message: 'Successfully connected to summary updates'
        });
    });

    socket.on('subscribe-to-summaries', async (data) => {
        try {
            const { clientId, periodTypes = ['monthly', 'yearly', 'all-time'] } = data;
            
            socket.join(`summaries-${clientId}`);
            
            const EmissionSummary = require('./models/CalculationEmission/EmissionSummary');
            const summaries = {};
            
            for (const periodType of periodTypes) {
                const query = { clientId, 'period.type': periodType };
                
                if (periodType === 'monthly') {
                    const now = new Date();
                    query['period.year'] = now.getFullYear();
                    query['period.month'] = now.getMonth() + 1;
                } else if (periodType === 'yearly') {
                    query['period.year'] = new Date().getFullYear();
                }
                
                const summary = await EmissionSummary.findOne(query).lean();
                if (summary) {
                    summaries[periodType] = {
                        totalEmissions: summary.totalEmissions,
                        byScope: summary.byScope,
                        lastCalculated: summary.metadata.lastCalculated
                    };
                }
            }
            
            socket.emit('initial-summary-data', {
                clientId,
                summaries,
                timestamp: new Date()
            });
            
        } catch (error) {
            console.error('Error in subscribe-to-summaries:', error);
            socket.emit('summary-error', {
                error: 'Failed to subscribe to summaries',
                details: error.message
            });
        }
    });

    socket.on('calculate-summary', async (data) => {
        try {
            const { clientId, periodType = 'monthly', year, month } = data;
            
            console.log(`📊 Real-time summary calculation requested for client: ${clientId}`);
            
            const { recalculateAndSaveSummary } = calculationSummaryController;
            const summary = await recalculateAndSaveSummary(
                clientId, 
                periodType, 
                year, 
                month
            );
            
            if (summary) {
                io.to(`summaries-${clientId}`).emit('summary-calculated', {
                    clientId,
                    summaryId: summary._id,
                    period: summary.period,
                    totalEmissions: summary.totalEmissions,
                    byScope: summary.byScope,
                    timestamp: new Date()
                });
                
                socket.emit('summary-calculation-complete', {
                    success: true,
                    summaryId: summary._id,
                    message: 'Summary calculated successfully'
                });
            } else {
                socket.emit('summary-calculation-complete', {
                    success: false,
                    message: 'No data found for the specified period'
                });
            }
            
        } catch (error) {
            console.error('Error in calculate-summary:', error);
            socket.emit('summary-calculation-error', {
                error: 'Failed to calculate summary',
                details: error.message
            });
        }
    });

    // ========================================================================
    // 📨 NOTIFICATION SOCKET HANDLERS
    // ========================================================================
    
    socket.on('requestNotifications', async () => {
        try {
            const notifications = await Notification.getNotificationsForUser(socket.user, {
                limit: 20,
                includeRead: false
            });
            
            const unreadCount = notifications.filter(notif => 
                !notif.readBy.some(read => read.user.toString() === socket.userId)
            ).length;
            
            socket.emit('notificationsData', {
                notifications: notifications.map(notif => ({
                    id: notif._id,
                    title: notif.title,
                    message: notif.message,
                    priority: notif.priority,
                    createdAt: notif.createdAt,
                    isRead: notif.readBy.some(read => read.user.toString() === socket.userId),
                    attachments: notif.attachments
                })),
                unreadCount
            });
        } catch (error) {
            console.error('Error fetching notifications:', error);
            socket.emit('notificationError', { message: 'Failed to fetch notifications' });
        }
    });
    
    socket.on('markNotificationAsRead', async (notificationId) => {
        try {
            const notification = await Notification.findById(notificationId);
            if (notification && await notification.canBeViewedBy(socket.user)) {
                await notification.markAsReadBy(socket.userId);
                
                socket.emit('notificationReadStatusUpdate', {
                    notificationId,
                    isRead: true,
                    readAt: new Date()
                });
                
                const unreadCount = await getUnreadCountForUser(socket.user);
                socket.emit('unreadCountUpdate', { unreadCount });
            }
        } catch (error) {
            console.error('Error marking notification as read:', error);
        }
    });

    // ========================================================================
    // 📊 IOT & DASHBOARD SOCKET HANDLERS
    // ========================================================================
    
    socket.on('requestLatestIoTData', async () => {
        try {
            const IOTData = require('./models/IOTData');
            const latestData = await IOTData.find()
                .sort({ receivedAt: -1 })
                .limit(10);
            
            socket.emit('latestIoTData', latestData);
        } catch (error) {
            console.error('Error fetching latest IoT data:', error);
        }
    });

    socket.on('requestDashboardData', async (dashboardType) => {
        try {
            const { 
                getDashboardMetrics, 
                getWorkflowTrackingDashboard, 
                getOrganizationOverviewDashboard 
            } = require('./controllers/CMS/clientController');
            
            const mockReq = {
                user: socket.user,
                params: {},
                query: {}
            };
            
            const mockRes = {
                status: () => mockRes,
                json: (data) => {
                    socket.emit('dashboardData', {
                        type: dashboardType,
                        data: data,
                        timestamp: new Date().toISOString()
                    });
                }
            };
            
            switch (dashboardType) {
                case 'metrics':
                    await getDashboardMetrics(mockReq, mockRes);
                    break;
                case 'workflow':
                    await getWorkflowTrackingDashboard(mockReq, mockRes);
                    break;
                case 'organization':
                    if (socket.user.userType === 'super_admin') {
                        await getOrganizationOverviewDashboard(mockReq, mockRes);
                    } else {
                        socket.emit('dashboardError', { 
                            message: 'Unauthorized access to organization dashboard' 
                        });
                    }
                    break;
                default:
                    socket.emit('dashboardError', { 
                        message: 'Invalid dashboard type' 
                    });
            }
        } catch (error) {
            console.error('Error fetching dashboard data:', error);
            socket.emit('dashboardError', { 
                message: 'Failed to fetch dashboard data',
                error: error.message 
            });
        }
    });
    
    socket.on('subscribeToDashboard', async (dashboardType) => {
        try {
            socket.join(`dashboard_${dashboardType}_${socket.userId}`);
            
            console.log(`📊 User ${socket.user.userName} subscribed to ${dashboardType} dashboard`);
            
            socket.emit('dashboardSubscribed', {
                dashboardType,
                message: `Successfully subscribed to ${dashboardType} dashboard updates`
            });
            
            socket.emit('requestDashboardData', dashboardType);
        } catch (error) {
            console.error('Error subscribing to dashboard:', error);
            socket.emit('dashboardError', { 
                message: 'Failed to subscribe to dashboard updates' 
            });
        }
    });

    // ========================================================================
    // 📋 CLIENT LIST SOCKET HANDLERS
    // ========================================================================
    
    socket.on('requestClients', async (filters = {}) => {
        try {
            const { getClients } = require('./controllers/CMS/clientController');
            
            const mockReq = {
                user: socket.user,
                query: filters
            };
            
            const mockRes = {
                status: () => mockRes,
                json: (data) => {
                    socket.emit('clients_data', {
                        type: 'clients_list',
                        data: data,
                        timestamp: new Date().toISOString()
                    });
                }
            };
            
            await getClients(mockReq, mockRes);
            
        } catch (error) {
            console.error('Error fetching clients:', error);
            socket.emit('clientsError', { 
                message: 'Failed to fetch clients',
                error: error.message 
            });
        }
    });
    
    socket.on('subscribeToClients', async (filters = {}) => {
        try {
            const roomName = `clients_${socket.userType}_${socket.userId}`;
            socket.join(roomName);
            
            if (filters.stage || filters.status) {
                const filterRoom = `clients_filtered_${JSON.stringify(filters)}_${socket.userId}`;
                socket.join(filterRoom);
            }
            
            console.log(`📋 User ${socket.user.userName} subscribed to client updates`);
            
            socket.emit('clientsSubscribed', {
                message: 'Successfully subscribed to client updates',
                filters: filters
            });
            
            socket.emit('requestClients', filters);
            
        } catch (error) {
            console.error('Error subscribing to clients:', error);
            socket.emit('clientsError', { 
                message: 'Failed to subscribe to client updates' 
            });
        }
    });
    
    socket.on('unsubscribeFromClients', () => {
        try {
            const rooms = Array.from(socket.rooms);
            rooms.forEach(room => {
                if (room.startsWith('clients_')) {
                    socket.leave(room);
                }
            });
            
            socket.emit('clientsUnsubscribed', {
                message: 'Successfully unsubscribed from client updates'
            });
            
        } catch (error) {
            console.error('Error unsubscribing from clients:', error);
        }
    });
    
    socket.on('searchClients', async (searchQuery) => {
        try {
            const Client = require('./models/CMS/Client');
            
            let query = { isDeleted: false };
            
            switch (socket.user.userType) {
                case "super_admin":
                    break;
                    
                case "consultant_admin":
                    const consultants = await User.find({ 
                        consultantAdminId: socket.user._id 
                    }).select("_id");
                    
                    const consultantIds = consultants.map(c => c._id);
                    consultantIds.push(socket.user._id);
                    
                    query.$or = [
                        { "leadInfo.consultantAdminId": socket.user._id },
                        { "leadInfo.assignedConsultantId": { $in: consultantIds } },
                        { "workflowTracking.assignedConsultantId": { $in: consultantIds } }
                    ];
                    break;
                    
                case "consultant":
                    query.$or = [
                        { "leadInfo.assignedConsultantId": socket.user._id },
                        { "workflowTracking.assignedConsultantId": socket.user._id }
                    ];
                    break;
                    
                case "client_admin":
                case "auditor":
                case "viewer":
                    query.clientId = socket.user.clientId;
                    break;
                    
                default:
                    socket.emit('searchResults', { clients: [] });
                    return;
            }
            
            if (searchQuery) {
                query.$and = [
                    ...(query.$and || []),
                    {
                        $or: [
                            { clientId: { $regex: searchQuery, $options: 'i' } },
                            { "leadInfo.companyName": { $regex: searchQuery, $options: 'i' } },
                            { "leadInfo.email": { $regex: searchQuery, $options: 'i' } },
                            { "leadInfo.contactPersonName": { $regex: searchQuery, $options: 'i' } }
                        ]
                    }
                ];
            }
            
            const clients = await Client.find(query)
                .populate("leadInfo.consultantAdminId", "userName email")
                .populate("leadInfo.assignedConsultantId", "userName email")
                .select("clientId leadInfo.companyName leadInfo.email stage status")
                .limit(20)
                .sort({ createdAt: -1 });
            
            socket.emit('searchResults', {
                clients: clients,
                query: searchQuery,
                timestamp: new Date().toISOString()
            });
            
        } catch (error) {
            console.error('Error searching clients:', error);
            socket.emit('searchError', { 
                message: 'Failed to search clients' 
            });
        }
    });
    
    socket.on('requestClientStats', async () => {
        try {
            const Client = require('./models/CMS/Client');
            let query = { isDeleted: false };
            
            const stats = await Client.aggregate([
                { $match: query },
                {
                    $group: {
                        _id: null,
                        total: { $sum: 1 },
                        byStage: { $push: "$stage" },
                        byStatus: { $push: "$status" }
                    }
                },
                {
                    $project: {
                        total: 1,
                        stages: {
                            lead: {
                                $size: {
                                    $filter: {
                                        input: "$byStage",
                                        cond: { $eq: ["$$this", "lead"] }
                                    }
                                }
                            },
                            registered: {
                                $size: {
                                    $filter: {
                                        input: "$byStage",
                                        cond: { $eq: ["$$this", "registered"] }
                                    }
                                }
                            },
                            proposal: {
                                $size: {
                                    $filter: {
                                        input: "$byStage",
                                        cond: { $eq: ["$$this", "proposal"] }
                                    }
                                }
                            },
                            active: {
                                $size: {
                                    $filter: {
                                        input: "$byStage",
                                        cond: { $eq: ["$$this", "active"] }
                                    }
                                }
                            }
                        },
                        statuses: {
                            pending: {
                                $size: {
                                    $filter: {
                                        input: "$byStatus",
                                        cond: { $eq: ["$$this", "pending"] }
                                    }
                                }
                            },
                            in_progress: {
                                $size: {
                                    $filter: {
                                        input: "$byStatus",
                                        cond: { $eq: ["$$this", "in_progress"] }
                                    }
                                }
                            },
                            completed: {
                                $size: {
                                    $filter: {
                                        input: "$byStatus",
                                        cond: { $eq: ["$$this", "completed"] }
                                    }
                                }
                            }
                        }
                    }
                }
            ]);
            
            socket.emit('clientStats', {
                stats: stats[0] || { total: 0, stages: {}, statuses: {} },
                timestamp: new Date().toISOString()
            });
            
        } catch (error) {
            console.error('Error fetching client stats:', error);
            socket.emit('statsError', { 
                message: 'Failed to fetch client statistics' 
            });
        }
    });

    // ========================================================================
    // 📊 DATA COLLECTION SOCKET HANDLERS
    // ========================================================================

    socket.on('request-data-status', async (clientId) => {
        try {
            const DataCollectionConfig = require('./models/Organization/DataCollectionConfig');
            const configs = await DataCollectionConfig.find({ clientId }).lean();
            
            socket.emit('data-status-update', {
                clientId,
                configs,
                timestamp: new Date()
            });
        } catch (error) {
            console.error('Error getting data status:', error);
            socket.emit('data-status-error', error.message);
        }
    });

    socket.on('leave-client-room', (clientId) => {
        socket.leave(`client_${clientId}`);
        socket.leave(`summaries-${clientId}`);
        console.log(`📡 Socket ${socket.id} left rooms for client: ${clientId}`);
    });

    socket.on('subscribe-to-data-completion', async (clientId) => {
        try {
            const effectiveClientId = clientId || socket.clientId;
            if (!effectiveClientId) {
                return socket.emit('data-completion-error', {
                    message: 'clientId is required to subscribe to data completion stats'
                });
            }

            const roomName = `data-completion-${effectiveClientId}`;
            socket.join(roomName);
            console.log(`📊 Socket ${socket.id} joined data completion room: ${roomName}`);

            const stats =
                await dataCompletionController.calculateDataCompletionStatsForClient(
                    effectiveClientId
                );

            socket.emit('data-completion-update', {
                clientId: effectiveClientId,
                stats,
                initial: true,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('Error in subscribe-to-data-completion:', error);
            socket.emit('data-completion-error', {
                message: 'Failed to subscribe to data completion',
                error: error.message
            });
        }
    });

    socket.on('request-data-completion', async (clientId) => {
        try {
            const effectiveClientId = clientId || socket.clientId;
            if (!effectiveClientId) {
                return socket.emit('data-completion-error', {
                    message: 'clientId is required to request data completion stats'
                });
            }

            const stats =
                await dataCompletionController.calculateDataCompletionStatsForClient(
                    effectiveClientId
                );

            socket.emit('data-completion-update', {
                clientId: effectiveClientId,
                stats,
                initial: false,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('Error in request-data-completion:', error);
            socket.emit('data-completion-error', {
                message: 'Failed to get data completion stats',
                error: error.message
            });
        }
    });

    // ========================================================================
    // 🎫 TICKET SOCKET HANDLERS
    // ========================================================================

    socket.on('join-ticket', async (ticketId) => {
        try {
            const { Ticket } = require('./models/Ticket/Ticket');
            
            const ticket = await Ticket.findById(ticketId);
            
            if (!ticket) {
                return socket.emit('ticket-error', {
                    message: 'Ticket not found',
                    ticketId
                });
            }

            const hasAccess = await checkTicketAccess(socket.user, ticket);
            
            if (!hasAccess) {
                return socket.emit('ticket-error', {
                    message: 'Access denied to this ticket',
                    ticketId
                });
            }

            socket.join(`ticket_${ticketId}`);
            console.log(`🎫 Socket ${socket.id} (${socket.user.userName}) joined ticket room: ${ticketId}`);
            
            socket.to(`ticket_${ticketId}`).emit('user-joined-ticket', {
                ticketId,
                userName: socket.user.userName,
                userId: socket.userId,
                userType: socket.user.userType,
                timestamp: new Date().toISOString()
            });

            socket.emit('ticket-joined', {
                ticketId,
                message: 'Successfully joined ticket room',
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            console.error('Error joining ticket room:', error);
            socket.emit('ticket-error', {
                message: 'Failed to join ticket room',
                error: error.message
            });
        }
    });

    socket.on('leave-ticket', (ticketId) => {
        try {
            socket.leave(`ticket_${ticketId}`);
            console.log(`🎫 Socket ${socket.id} (${socket.user.userName}) left ticket room: ${ticketId}`);
            
            socket.to(`ticket_${ticketId}`).emit('user-left-ticket', {
                ticketId,
                userName: socket.user.userName,
                userId: socket.userId,
                timestamp: new Date().toISOString()
            });

            socket.emit('ticket-left', {
                ticketId,
                message: 'Successfully left ticket room',
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            console.error('Error leaving ticket room:', error);
            socket.emit('ticket-error', {
                message: 'Failed to leave ticket room',
                error: error.message
            });
        }
    });

    socket.on('ticket-typing', (data) => {
        try {
            const { ticketId, isTyping } = data;
            
            if (!ticketId) {
                return socket.emit('ticket-error', {
                    message: 'ticketId is required for typing indicator'
                });
            }

            socket.to(`ticket_${ticketId}`).emit('user-typing-ticket', {
                ticketId,
                userName: socket.user.userName,
                userId: socket.userId,
                isTyping: isTyping !== false,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            console.error('Error handling ticket typing:', error);
        }
    });

    socket.on('ticket-viewing', async (ticketId) => {
        try {
            if (!ticketId) {
                return socket.emit('ticket-error', {
                    message: 'ticketId is required'
                });
            }

            socket.to(`ticket_${ticketId}`).emit('user-viewing-ticket', {
                ticketId,
                userName: socket.user.userName,
                userId: socket.userId,
                userType: socket.user.userType,
                timestamp: new Date().toISOString()
            });

            const { Ticket } = require('./models/Ticket/Ticket');
            const ticket = await Ticket.findById(ticketId);
            
            if (ticket) {
                ticket.recordView(socket.userId);
                await ticket.save();
            }

        } catch (error) {
            console.error('Error handling ticket viewing:', error);
        }
    });

    socket.on('request-ticket-details', async (ticketId) => {
        try {
            const { Ticket } = require('./models/Ticket/Ticket');
            const TicketActivity = require('./models/Ticket/TicketActivity');

            const ticket = await Ticket.findById(ticketId)
                .populate('createdBy', 'userName email userType')
                .populate('assignedTo', 'userName email userType')
                .populate('watchers', 'userName email userType')
                .populate('escalatedBy', 'userName email userType');

            if (!ticket) {
                return socket.emit('ticket-error', {
                    message: 'Ticket not found',
                    ticketId
                });
            }

            const hasAccess = await checkTicketAccess(socket.user, ticket);
            if (!hasAccess) {
                return socket.emit('ticket-error', {
                    message: 'Access denied',
                    ticketId
                });
            }

            const activities = await TicketActivity.find({
                ticket: ticketId,
                isDeleted: false
            })
                .populate('createdBy', 'userName email userType')
                .sort({ createdAt: 1 });

            const supportRoles = ['super_admin', 'consultant_admin', 'consultant'];
            const visibleActivities = activities.filter(activity => {
                if (activity.comment?.isInternal) {
                    return supportRoles.includes(socket.user.userType);
                }
                return true;
            });

            const slaInfo = {
                dueDate: ticket.dueDate,
                isOverdue: ticket.isOverdue(),
                isDueSoon: ticket.isDueSoon(),
                timeRemaining: ticket.getTimeRemaining()
            };

            socket.emit('ticket-details', {
                ticket,
                activities: visibleActivities,
                slaInfo,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            console.error('Error fetching ticket details:', error);
            socket.emit('ticket-error', {
                message: 'Failed to fetch ticket details',
                error: error.message
            });
        }
    });

    socket.on('subscribe-to-tickets', async (data) => {
        try {
            const { clientId, filters = {} } = data;
            const effectiveClientId = clientId || socket.clientId;

            if (!effectiveClientId) {
                return socket.emit('ticket-error', {
                    message: 'clientId is required'
                });
            }

            socket.join(`client-tickets_${effectiveClientId}`);
            console.log(`🎫 Socket ${socket.id} subscribed to tickets for client: ${effectiveClientId}`);

            const { Ticket } = require('./models/Ticket/Ticket');
            
            const query = { clientId: effectiveClientId };
            
            if (filters.status) {
                query.status = Array.isArray(filters.status) 
                    ? { $in: filters.status }
                    : filters.status;
            }
            
            if (filters.priority) {
                query.priority = Array.isArray(filters.priority)
                    ? { $in: filters.priority }
                    : filters.priority;
            }

            if (filters.assignedTo === 'me') {
                query.assignedTo = socket.userId;
            }

            if (filters.createdBy === 'me') {
                query.createdBy = socket.userId;
            }

            const tickets = await Ticket.find(query)
                .populate('createdBy', 'userName email userType')
                .populate('assignedTo', 'userName email userType')
                .sort({ updatedAt: -1 })
                .limit(filters.limit || 50);

            socket.emit('tickets-list', {
                clientId: effectiveClientId,
                tickets,
                filters,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            console.error('Error subscribing to tickets:', error);
            socket.emit('ticket-error', {
                message: 'Failed to subscribe to tickets',
                error: error.message
            });
        }
    });

    socket.on('unsubscribe-from-tickets', (clientId) => {
        try {
            const effectiveClientId = clientId || socket.clientId;
            socket.leave(`client-tickets_${effectiveClientId}`);
            console.log(`🎫 Socket ${socket.id} unsubscribed from tickets for client: ${effectiveClientId}`);
            
            socket.emit('tickets-unsubscribed', {
                clientId: effectiveClientId,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('Error unsubscribing from tickets:', error);
        }
    });

    socket.on('request-ticket-stats', async (clientId) => {
        try {
            const effectiveClientId = clientId || socket.clientId;

            if (!effectiveClientId) {
                return socket.emit('ticket-error', {
                    message: 'clientId is required'
                });
            }

            const { Ticket } = require('./models/Ticket/Ticket');

            const statusCounts = await Ticket.aggregate([
                { $match: { clientId: effectiveClientId } },
                { $group: { _id: '$status', count: { $sum: 1 } } }
            ]);

            const priorityCounts = await Ticket.aggregate([
                { $match: { clientId: effectiveClientId } },
                { $group: { _id: '$priority', count: { $sum: 1 } } }
            ]);

            const overdueCount = await Ticket.countDocuments({
                clientId: effectiveClientId,
                status: { $nin: ['resolved', 'closed', 'cancelled'] },
                dueDate: { $lt: new Date() }
            });

            const myTicketsCount = await Ticket.countDocuments({
                clientId: effectiveClientId,
                $or: [
                    { createdBy: socket.userId },
                    { assignedTo: socket.userId },
                    { watchers: socket.userId }
                ]
            });

            const stats = {
                total: statusCounts.reduce((sum, item) => sum + item.count, 0),
                byStatus: statusCounts.reduce((acc, item) => {
                    acc[item._id] = item.count;
                    return acc;
                }, {}),
                byPriority: priorityCounts.reduce((acc, item) => {
                    acc[item._id] = item.count;
                    return acc;
                }, {}),
                overdue: overdueCount,
                myTickets: myTicketsCount
            };

            socket.emit('ticket-stats', {
                clientId: effectiveClientId,
                stats,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            console.error('Error fetching ticket stats:', error);
            socket.emit('ticket-error', {
                message: 'Failed to fetch ticket statistics',
                error: error.message
            });
        }
    });
    socket.on('request-minimal-entries', async (params) => {
  try {
    const {
      clientId,
      nodeId,
      scopeIdentifier,
      startDate,
      endDate,
      inputType,
      page = 1,
      limit = 50,
      sortBy = 'timestamp',
      sortOrder = 'desc'
    } = params;

    // Authorization check
    if (socket.userType === 'client_admin' || 
        socket.userType === 'client_employee_head' || 
        socket.userType === 'auditor' || 
        socket.userType === 'viewer') {
      if (clientId && clientId !== socket.clientId) {
        socket.emit('minimal-entries-error', {
          message: 'Unauthorized: Cannot access other client data'
        });
        return;
      }
    }

    // Build filters
    const filters = {};
    if (clientId || socket.clientId) {
      filters.clientId = clientId || socket.clientId;
    }
    if (nodeId) filters.nodeId = nodeId;
    if (scopeIdentifier) filters.scopeIdentifier = scopeIdentifier;
    if (inputType) filters.inputType = inputType;
    if (startDate || endDate) {
      filters.timestamp = {};
      if (startDate) filters.timestamp.$gte = new Date(startDate);
      if (endDate) filters.timestamp.$lte = new Date(endDate);
    }

    // Build sort
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Pagination
    const skip = (page - 1) * limit;

    // ✅ Fetch only required fields
    const [entries, total] = await Promise.all([
      DataEntry.find(filters)
        .select({
          _id: 1,
          clientId: 1,
          nodeId: 1,
          scopeIdentifier: 1,
          timestamp: 1,
          date: 1,
          time: 1,
          dataValues: 1,
          dataEntryCumulative: 1,
          inputType: 1
        })
        .sort(sort)
        .skip(skip)
        .limit(Math.min(limit, 100)) // Max 100 items for Socket.IO
        .lean(),
      DataEntry.countDocuments(filters)
    ]);

    // ✅ Serialize entries
    const serializedEntries = entries.map(entry => ({
      _id: entry._id,
      clientId: entry.clientId,
      nodeId: entry.nodeId,
      scopeIdentifier: entry.scopeIdentifier,
      timestamp: entry.timestamp,
      date: entry.date,
      time: entry.time,
      inputType: entry.inputType,
      dataValues: entry.dataValues instanceof Map 
        ? Object.fromEntries(entry.dataValues)
        : entry.dataValues,
      dataEntryCumulative: entry.dataEntryCumulative ? {
        incomingTotalValue: Number(entry.dataEntryCumulative.incomingTotalValue || 0),
        cumulativeTotalValue: Number(entry.dataEntryCumulative.cumulativeTotalValue || 0),
        entryCount: Number(entry.dataEntryCumulative.entryCount || 0),
        lastUpdatedAt: entry.dataEntryCumulative.lastUpdatedAt || null
      } : null
    }));

    // Send response
    socket.emit('minimal-entries-data', {
      success: true,
      data: serializedEntries,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      hasMore: page * limit < total,
      filters,
      timestamp: new Date()
    });

  } catch (error) {
    console.error('Error fetching minimal entries:', error);
    socket.emit('minimal-entries-error', {
      message: 'Failed to fetch minimal entries',
      error: error.message
    });
  }
    });
    socket.on('subscribe-minimal-data', async (params) => {
    try {
        const { clientId, nodeId, scopeIdentifier } = params;

        // Authorization check
        if (socket.userType === 'client_admin' || 
            socket.userType === 'client_employee_head' || 
            socket.userType === 'auditor' || 
            socket.userType === 'viewer') {
        if (clientId && clientId !== socket.clientId) {
            socket.emit('subscription-error', {
            message: 'Unauthorized: Cannot subscribe to other client data'
            });
            return;
        }
        }

        // Build room name
        const room = `minimal-data-${clientId || 'all'}-${nodeId || 'all'}-${scopeIdentifier || 'all'}`;
        
        // Join room
        socket.join(room);

        console.log(`📊 Socket ${socket.id} subscribed to minimal data room: ${room}`);

        // Confirm subscription
        socket.emit('subscription-confirmed', {
        room,
        clientId,
        nodeId,
        scopeIdentifier,
        timestamp: new Date()
        });

        // Send latest entry immediately
        const filters = {};
        if (clientId) filters.clientId = clientId;
        if (nodeId) filters.nodeId = nodeId;
        if (scopeIdentifier) filters.scopeIdentifier = scopeIdentifier;

        const latestEntry = await DataEntry.findOne(filters)
        .select({
            _id: 1,
            clientId: 1,
            nodeId: 1,
            scopeIdentifier: 1,
            timestamp: 1,
            dataValues: 1,
            dataEntryCumulative: 1,
            inputType: 1
        })
        .sort({ timestamp: -1 })
        .lean();

        if (latestEntry) {
        const serialized = {
            _id: latestEntry._id,
            clientId: latestEntry.clientId,
            nodeId: latestEntry.nodeId,
            scopeIdentifier: latestEntry.scopeIdentifier,
            timestamp: latestEntry.timestamp,
            inputType: latestEntry.inputType,
            dataValues: latestEntry.dataValues instanceof Map 
            ? Object.fromEntries(latestEntry.dataValues)
            : latestEntry.dataValues,
            dataEntryCumulative: latestEntry.dataEntryCumulative ? {
            incomingTotalValue: Number(latestEntry.dataEntryCumulative.incomingTotalValue || 0),
            cumulativeTotalValue: Number(latestEntry.dataEntryCumulative.cumulativeTotalValue || 0),
            entryCount: Number(latestEntry.dataEntryCumulative.entryCount || 0),
            lastUpdatedAt: latestEntry.dataEntryCumulative.lastUpdatedAt || null
            } : null
        };

        socket.emit('minimal-data-update', {
            type: 'latest',
            data: serialized
        });
        }

    } catch (error) {
        console.error('Error subscribing to minimal data:', error);
        socket.emit('subscription-error', {
        message: 'Failed to subscribe to minimal data',
        error: error.message
        });
    }
    });
    socket.on('unsubscribe-minimal-data', (params) => {
    try {
        const { clientId, nodeId, scopeIdentifier } = params;
        const room = `minimal-data-${clientId || 'all'}-${nodeId || 'all'}-${scopeIdentifier || 'all'}`;
        
        socket.leave(room);
        
        console.log(`📊 Socket ${socket.id} unsubscribed from minimal data room: ${room}`);
        
        socket.emit('unsubscription-confirmed', { room });
    } catch (error) {
        console.error('Error unsubscribing from minimal data:', error);
    }
    });


/**
 * Get latest entry for specific scope
 * 
 * Client emits: 'get-latest-minimal-entry'
 * Server responds: 'latest-minimal-entry'
 */
socket.on('get-latest-minimal-entry', async (params) => {
  try {
    const { clientId, nodeId, scopeIdentifier } = params;

    // Authorization check
    if (socket.userType === 'client_admin' || 
        socket.userType === 'client_employee_head' || 
        socket.userType === 'auditor' || 
        socket.userType === 'viewer') {
      if (clientId && clientId !== socket.clientId) {
        socket.emit('latest-entry-error', {
          message: 'Unauthorized: Cannot access other client data'
        });
        return;
      }
    }

    const filters = {};
    if (clientId || socket.clientId) filters.clientId = clientId || socket.clientId;
    if (nodeId) filters.nodeId = nodeId;
    if (scopeIdentifier) filters.scopeIdentifier = scopeIdentifier;

    const entry = await DataEntry.findOne(filters)
      .select({
        _id: 1,
        clientId: 1,
        nodeId: 1,
        scopeIdentifier: 1,
        timestamp: 1,
        date: 1,
        time: 1,
        dataValues: 1,
        dataEntryCumulative: 1,
        inputType: 1
      })
      .sort({ timestamp: -1 })
      .lean();

    if (!entry) {
      socket.emit('latest-minimal-entry', {
        success: false,
        message: 'No entry found'
      });
      return;
    }

    const serialized = {
      _id: entry._id,
      clientId: entry.clientId,
      nodeId: entry.nodeId,
      scopeIdentifier: entry.scopeIdentifier,
      timestamp: entry.timestamp,
      date: entry.date,
      time: entry.time,
      inputType: entry.inputType,
      dataValues: entry.dataValues instanceof Map 
        ? Object.fromEntries(entry.dataValues)
        : entry.dataValues,
      dataEntryCumulative: entry.dataEntryCumulative ? {
        incomingTotalValue: Number(entry.dataEntryCumulative.incomingTotalValue || 0),
        cumulativeTotalValue: Number(entry.dataEntryCumulative.cumulativeTotalValue || 0),
        entryCount: Number(entry.dataEntryCumulative.entryCount || 0),
        lastUpdatedAt: entry.dataEntryCumulative.lastUpdatedAt || null
      } : null
    };

    socket.emit('latest-minimal-entry', {
      success: true,
      data: serialized
    });

  } catch (error) {
    console.error('Error getting latest minimal entry:', error);
    socket.emit('latest-entry-error', {
      message: 'Failed to get latest entry',
      error: error.message
    });
  }
});


    /**
 * Join data collection room for real-time updates
 * Clients should emit this when viewing a specific scope's data
 */
socket.on('join-data-room', ({ clientId, nodeId, scopeIdentifier }) => {
  try {
    // Construct room names
    const specificRoom = `data-${clientId}-${nodeId || 'all'}-${scopeIdentifier || 'all'}`;
    const clientRoom = `client-${clientId}`;
    
    // Join the rooms
    socket.join(specificRoom);
    socket.join(clientRoom);
    
    console.log(`📡 Socket ${socket.id} joined data rooms:`, {
      specific: specificRoom,
      client: clientRoom
    });
    
    // Confirm to client
    socket.emit('data-room-joined', {
      room: specificRoom,
      clientId,
      nodeId,
      scopeIdentifier
    });
    
  } catch (error) {
    console.error('Error joining data room:', error);
    socket.emit('error', { message: 'Failed to join data room' });
  }
});


/**
 * Leave data collection room
 * Clients should emit this when navigating away
 */
socket.on('leave-data-room', ({ clientId, nodeId, scopeIdentifier }) => {
  try {
    const specificRoom = `data-${clientId}-${nodeId || 'all'}-${scopeIdentifier || 'all'}`;
    const clientRoom = `client-${clientId}`;
    
    socket.leave(specificRoom);
    socket.leave(clientRoom);
    
    console.log(`📡 Socket ${socket.id} left data rooms:`, {
      specific: specificRoom,
      client: clientRoom
    });
    
    socket.emit('data-room-left', {
      room: specificRoom,
      clientId,
      nodeId,
      scopeIdentifier
    });
    
  } catch (error) {
    console.error('Error leaving data room:', error);
  }
});

    // ========================================================================
    // 🔌 COMMON SOCKET HANDLERS
    // ========================================================================

    socket.on('disconnect', () => {
        console.log(`🔌 Client disconnected: ${socket.user.userName} (${socket.id})`);
        connectedUsers.delete(socket.userId);
    });

    socket.on('ping', () => {
        socket.emit('pong', { timestamp: new Date() });
    });

}); // END OF io.on('connection')

// ============================================================================
// 🌐 GLOBAL IO INSTANCE
// ============================================================================

global.io = io;

// ============================================================================
// 📨 NOTIFICATION BROADCAST FUNCTIONS (OUTSIDE CONNECTION HANDLER)
// ============================================================================

const broadcastNotification = async (notification) => {
    try {
        const populatedNotification = await Notification.findById(notification._id)
            .populate('createdBy', 'userName userType');
        
        if (!populatedNotification) return;
        
        const notificationData = {
            id: populatedNotification._id,
            title: populatedNotification.title,
            message: populatedNotification.message,
            priority: populatedNotification.priority,
            createdBy: populatedNotification.createdBy,
            createdAt: populatedNotification.createdAt,
            attachments: populatedNotification.attachments
        };
        
        const targetUsers = await getTargetUsersForNotification(populatedNotification);
        
        for (const user of targetUsers) {
            const userConnection = connectedUsers.get(user._id.toString());
            
            if (userConnection) {
                io.to(`user_${user._id}`).emit('newNotification', notificationData);
                
                const unreadCount = await getUnreadCountForUser(user);
                io.to(`user_${user._id}`).emit('unreadCountUpdate', { unreadCount });
                
                console.log(`📨 Notification sent to: ${user.userName}`);
            }
        }
        
        console.log(`📨 Broadcast notification "${notification.title}" to ${targetUsers.length} users`);
        
    } catch (error) {
        console.error('Error broadcasting notification:', error);
    }
};

const getTargetUsersForNotification = async (notification) => {
    const targetUsers = [];
    
    if (notification.targetUsers.length > 0) {
        const users = await User.find({
            _id: { $in: notification.targetUsers },
            isActive: true
        });
        targetUsers.push(...users);
    }
    
    if (notification.targetUserTypes.length > 0) {
        const users = await User.find({
            userType: { $in: notification.targetUserTypes },
            isActive: true
        });
        targetUsers.push(...users);
    }
    
    if (notification.targetClients.length > 0) {
        const users = await User.find({
            clientId: { $in: notification.targetClients },
            isActive: true
        });
        targetUsers.push(...users);
    }
    
    const uniqueUsers = targetUsers.filter((user, index, self) => 
        index === self.findIndex(u => u._id.toString() === user._id.toString())
    );
    
    return uniqueUsers;
};

const getUnreadCountForUser = async (user) => {
    try {
        const targetingConditions = [
            { targetUsers: user._id },
            {
                targetUserTypes: user.userType,
                $or: [
                    { targetUsers: { $exists: false } },
                    { targetUsers: { $size: 0 } }
                ]
            }
        ];
        
        if (user.clientId) {
            targetingConditions.push({
                targetClients: user.clientId,
                $and: [
                    { $or: [{ targetUsers: { $exists: false } }, { targetUsers: { $size: 0 } }] },
                    { $or: [{ targetUserTypes: { $exists: false } }, { targetUserTypes: { $size: 0 } }] }
                ]
            });
        }
        
        const unreadCount = await Notification.countDocuments({
            status: 'published',
            isDeleted: false,
            'readBy.user': { $ne: user._id },
            $or: [
                { expiryDate: null },
                { expiryDate: { $gt: new Date() } }
            ],
            $or: targetingConditions
        });
        
        return unreadCount;
    } catch (error) {
        console.error('Error getting unread count:', error);
        return 0;
    }
};

const broadcastDashboardUpdate = async (updateType, data, targetUsers = []) => {
    try {
        const updateData = {
            type: updateType,
            data: data,
            timestamp: new Date().toISOString()
        };
        
        if (targetUsers.length > 0) {
            targetUsers.forEach(userId => {
                io.to(`user_${userId}`).emit('dashboard_update', updateData);
            });
        } else {
            switch (updateType) {
                case 'workflow_tracking':
                    io.to('userType_super_admin').emit('dashboard_update', updateData);
                    io.to('userType_consultant_admin').emit('dashboard_update', updateData);
                    io.to('userType_consultant').emit('dashboard_update', updateData);
                    break;
                    
                case 'organization_overview':
                    io.to('userType_super_admin').emit('dashboard_update', updateData);
                    break;
                    
                case 'dashboard_metrics':
                    io.to('userType_super_admin').emit('dashboard_update', updateData);
                    io.to('userType_consultant_admin').emit('dashboard_update', updateData);
                    io.to('userType_consultant').emit('dashboard_update', updateData);
                    break;
            }
        }
        
        console.log(`📊 Dashboard update broadcasted: ${updateType}`);
    } catch (error) {
        console.error('Error broadcasting dashboard update:', error);
    }
};

// ============================================================================
// 🎫 TICKET BROADCAST FUNCTIONS (OUTSIDE CONNECTION HANDLER)
// ============================================================================

async function broadcastTicketCreated(ticketData) {
    try {
        const { clientId, ticketId, ticket } = ticketData;
        
        console.log(`🎫 Broadcasting ticket created: ${ticketId} for client ${clientId}`);

        io.to(`client_${clientId}`).emit('ticket-created', {
            ticket,
            timestamp: new Date().toISOString()
        });

        io.to(`client-tickets_${clientId}`).emit('ticket-list-updated', {
            action: 'created',
            ticket,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error broadcasting ticket created:', error);
    }
}

async function broadcastTicketUpdated(ticketData) {
    try {
        const { clientId, ticketId, changes } = ticketData;
        
        console.log(`🎫 Broadcasting ticket updated: ${ticketId}`);

        io.to(`ticket_${ticketId}`).emit('ticket-updated', {
            ticketId,
            changes,
            timestamp: new Date().toISOString()
        });

        io.to(`client-tickets_${clientId}`).emit('ticket-list-updated', {
            action: 'updated',
            ticketId,
            changes,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error broadcasting ticket updated:', error);
    }
}

async function broadcastTicketStatusChanged(ticketData) {
    try {
        const { clientId, ticketId, status, ticket } = ticketData;
        
        console.log(`🎫 Broadcasting ticket status changed: ${ticketId} -> ${status}`);

        io.to(`ticket_${ticketId}`).emit('ticket-status-changed', {
            ticketId,
            status,
            ticket,
            timestamp: new Date().toISOString()
        });

        io.to(`client_${clientId}`).emit('ticket-status-changed', {
            ticketId,
            status,
            timestamp: new Date().toISOString()
        });

        io.to(`client-tickets_${clientId}`).emit('ticket-list-updated', {
            action: 'status_changed',
            ticketId,
            status,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error broadcasting ticket status changed:', error);
    }
}

async function broadcastTicketAssigned(ticketData) {
    try {
        const { clientId, ticketId, assignedTo } = ticketData;
        
        console.log(`🎫 Broadcasting ticket assigned: ${ticketId} to ${assignedTo.userName}`);

        io.to(`ticket_${ticketId}`).emit('ticket-assigned', {
            ticketId,
            assignedTo,
            timestamp: new Date().toISOString()
        });

        io.to(`user_${assignedTo._id}`).emit('ticket-assigned-to-me', {
            ticketId,
            message: 'A ticket has been assigned to you',
            timestamp: new Date().toISOString()
        });

        io.to(`client-tickets_${clientId}`).emit('ticket-list-updated', {
            action: 'assigned',
            ticketId,
            assignedTo,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error broadcasting ticket assigned:', error);
    }
}

async function broadcastTicketComment(commentData) {
    try {
        const { clientId, ticketId, activity, isInternal } = commentData;
        
        console.log(`🎫 Broadcasting ticket comment: ${ticketId}${isInternal ? ' (internal)' : ''}`);

        io.to(`ticket_${ticketId}`).emit('ticket-new-comment', {
            ticketId,
            activity,
            timestamp: new Date().toISOString()
        });

        if (!isInternal) {
            io.to(`client_${clientId}`).emit('ticket-activity', {
                ticketId,
                activityType: 'comment',
                timestamp: new Date().toISOString()
            });
        }

    } catch (error) {
        console.error('Error broadcasting ticket comment:', error);
    }
}

async function broadcastTicketEscalated(ticketData) {
    try {
        const { clientId, ticketId, escalationLevel } = ticketData;
        
        console.log(`🎫 Broadcasting ticket escalated: ${ticketId} - Level ${escalationLevel}`);

        io.to(`ticket_${ticketId}`).emit('ticket-escalated', {
            ticketId,
            escalationLevel,
            timestamp: new Date().toISOString()
        });

        io.to(`client_${clientId}`).emit('ticket-escalated', {
            ticketId,
            escalationLevel,
            priority: 'high',
            timestamp: new Date().toISOString()
        });

        io.to('userType_super_admin').emit('ticket-escalated-alert', {
            ticketId,
            clientId,
            escalationLevel,
            message: 'A ticket requires immediate attention',
            timestamp: new Date().toISOString()
        });

        io.to('userType_consultant_admin').emit('ticket-escalated-alert', {
            ticketId,
            clientId,
            escalationLevel,
            message: 'A ticket requires immediate attention',
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error broadcasting ticket escalated:', error);
    }
}

async function broadcastTicketAttachment(attachmentData) {
    try {
        const { clientId, ticketId, attachments } = attachmentData;
        
        console.log(`🎫 Broadcasting ticket attachment added: ${ticketId}`);

        io.to(`ticket_${ticketId}`).emit('ticket-attachment-added', {
            ticketId,
            attachments,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error broadcasting ticket attachment:', error);
    }
}

async function broadcastTicketDeleted(ticketData) {
    try {
        const { clientId, ticketId } = ticketData;
        
        console.log(`🎫 Broadcasting ticket deleted: ${ticketId}`);

        io.to(`ticket_${ticketId}`).emit('ticket-deleted', {
            ticketId,
            message: 'This ticket has been deleted',
            timestamp: new Date().toISOString()
        });

        io.to(`client-tickets_${clientId}`).emit('ticket-list-updated', {
            action: 'deleted',
            ticketId,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error broadcasting ticket deleted:', error);
    }
}

async function broadcastSLAAlert(alertData) {
    try {
        const { clientId, ticketId, type, ticket } = alertData;
        
        console.log(`🎫 Broadcasting SLA alert: ${ticketId} - ${type}`);

        io.to(`ticket_${ticketId}`).emit('ticket-sla-alert', {
            ticketId,
            type,
            ticket,
            timestamp: new Date().toISOString()
        });

        io.to(`client_${clientId}`).emit('ticket-sla-alert', {
            ticketId,
            type,
            priority: type === 'breach' ? 'critical' : 'high',
            timestamp: new Date().toISOString()
        });

        io.to('userType_super_admin').emit('sla-alert', alertData);
        io.to('userType_consultant_admin').emit('sla-alert', alertData);

    } catch (error) {
        console.error('Error broadcasting SLA alert:', error);
    }
}

/**
 * Broadcast minimal data update to subscribed clients
 * This should be called after successful data entry creation
 * 
 * Add this to dataCollectionController.js after saving entries:
 * ```javascript
 * if (global.broadcastMinimalDataUpdate) {
 *   global.broadcastMinimalDataUpdate(entry);
 * }
 * ```
 */
function broadcastMinimalDataUpdate(entry) {
  if (!io) return;

  const room = `minimal-data-${entry.clientId}-${entry.nodeId}-${entry.scopeIdentifier}`;
  const broadRoom = `minimal-data-${entry.clientId}-all-all`;

  const data = {
    _id: entry._id,
    clientId: entry.clientId,
    nodeId: entry.nodeId,
    scopeIdentifier: entry.scopeIdentifier,
    timestamp: entry.timestamp,
    inputType: entry.inputType,
    dataValues: entry.dataValues instanceof Map 
      ? Object.fromEntries(entry.dataValues)
      : entry.dataValues,
    dataEntryCumulative: entry.dataEntryCumulative ? {
      incomingTotalValue: Number(entry.dataEntryCumulative.incomingTotalValue || 0),
      cumulativeTotalValue: Number(entry.dataEntryCumulative.cumulativeTotalValue || 0),
      entryCount: Number(entry.dataEntryCumulative.entryCount || 0),
      lastUpdatedAt: entry.dataEntryCumulative.lastUpdatedAt || null
    } : null
  };

  // Broadcast to specific room
  io.to(room).emit('minimal-data-update', {
    type: 'new',
    data,
    timestamp: new Date()
  });

  // Broadcast to client-wide room
  io.to(broadRoom).emit('minimal-data-update', {
    type: 'new',
    data,
    timestamp: new Date()
  });

  console.log(`📊 Broadcast minimal data update to rooms: ${room}, ${broadRoom}`);
}

// ============================================================================
// 🌐 EXPORT BROADCAST FUNCTIONS AS GLOBALS
// ============================================================================

global.broadcastNotification = broadcastNotification;
global.broadcastDashboardUpdate = broadcastDashboardUpdate;
global.getUnreadCountForUser = getUnreadCountForUser;
global.getTargetUsersForNotification = getTargetUsersForNotification;
global.broadcastDataCompletionUpdate = broadcastDataCompletionUpdate;
global.broadcastNetReductionCompletionUpdate = broadcastNetReductionCompletionUpdate;

// Ticket broadcast functions
global.broadcastTicketCreated = broadcastTicketCreated;
global.broadcastTicketUpdated = broadcastTicketUpdated;
global.broadcastTicketStatusChanged = broadcastTicketStatusChanged;
global.broadcastTicketAssigned = broadcastTicketAssigned;
global.broadcastTicketComment = broadcastTicketComment;
global.broadcastTicketEscalated = broadcastTicketEscalated;
global.broadcastTicketAttachment = broadcastTicketAttachment;
global.broadcastTicketDeleted = broadcastTicketDeleted;
global.broadcastSLAAlert = broadcastSLAAlert;

global.broadcastMinimalDataUpdate = broadcastMinimalDataUpdate;

console.log('✅ All broadcast functions registered globally');

// ============================================================================
// 🔄 PERIODIC SUMMARY HEALTH CHECK
// ============================================================================

setInterval(async () => {
  try {
    const now = new Date();
    
    const DataEntry = require('./models/Organization/DataEntry');
    const recentEntries = await DataEntry.find({
      timestamp: { $gte: new Date(now.getTime() - 60 * 60 * 1000) },
      calculatedEmissions: { $exists: true },
      summaryUpdateStatus: { $ne: 'completed' }
    }).distinct('clientId');
    
    if (recentEntries.length > 0) {
      console.log(`🔄 Found ${recentEntries.length} clients needing summary updates`);
      
      for (const clientId of recentEntries) {
        try {
          const { recalculateAndSaveSummary } = calculationSummaryController;
          const monthlySummary = await recalculateAndSaveSummary(
            clientId,
            'monthly',
            now.getFullYear(),
            now.getMonth() + 1
          );
          
          if (monthlySummary) {
            io.to(`summaries-${clientId}`).emit('summary-auto-updated', {
              clientId,
              summaryId: monthlySummary._id,
              period: monthlySummary.period,
              totalEmissions: monthlySummary.totalEmissions,
              timestamp: new Date()
            });
          }
        } catch (clientError) {
          console.error(`Error updating summary for client ${clientId}:`, clientError);
        }
      }
    }
  } catch (error) {
    console.error('Error in periodic summary check:', error);
  }
}, 5 * 60 * 1000);

// ============================================================================
// 🗄️ DATABASE CONNECTION AND SERVER STARTUP
// ============================================================================

// Connect to Database and start services
connectDB().then(() => {
    console.log('✅ Database connected successfully');
    
    // Initialize Super Admin account
    initializeSuperAdmin();
    
    // Schedule cron job to check expired subscriptions daily at midnight
    cron.schedule('0 0 * * *', () => {
        console.log('🔄 Running daily subscription check...');
        checkExpiredSubscriptions();
    });
    
    // Run subscription check on startup
    checkExpiredSubscriptions();
    
    // Schedule monthly summary cron job
    scheduleMonthlySummary();

    // Kick off missed summaries check in the background
    (async () => {
      try {
        await checkAndCreateMissedSummaries();
        console.log('✅ Missed summaries check complete');
      } catch (err) {
        console.error('❌ Error back-filling summaries:', err);
      }
    })();
    
    // Start API Key Expiry Checker
    console.log('🔐 Starting API Key expiry checker...');
    startApiKeyExpiryChecker();

    // Schedule cron jobs
    cron.schedule('0 2 * * *', async () => {
      console.log('🔄 Running daily subscription check...');
      await checkExpiredSubscriptions();
    });
}).catch((error) => {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
});

// Enhanced scheduled notifications with real-time broadcasting
cron.schedule('*/5 * * * *', async () => {
    console.log('🔄 Checking for scheduled notifications...');
    
    try {
        const now = new Date();
        
        const scheduledNotifications = await Notification.find({
            status: "scheduled",
            scheduledPublishDate: { $lte: now },
            isDeleted: false
        });
        
        for (const notification of scheduledNotifications) {
            // Update status to published
            notification.status = "published";
            notification.publishedAt = now;
            notification.publishDate = now;
            await notification.save();
            
            // Broadcast in real-time
            await broadcastNotification(notification);
            
            console.log(`📨 Published and broadcasted: ${notification.title}`);
        }
        
        // Also handle auto-deletion
        await Notification.scheduleAutoDeletion();
        
    } catch (error) {
        console.error('Error in scheduled notification job:', error);
    }
});

// Start background scheduler for notifications
cron.schedule('*/10 * * * *', async () => {
  console.log('🔄 Checking for scheduled notifications...');
  try {
    await publishScheduledNotifications();
  } catch (error) {
    console.error('Error in scheduled notification job:', error);
  }
});

// Start Server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`🚀 Server started on port ${PORT}`);
    console.log(`📡 Socket.IO server running with authentication`);
});

module.exports = { app, server, io };
