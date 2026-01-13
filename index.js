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
const summaryRoutes = require('./router/Organization/summaryRoutes'); // 🆕 Corrected path
const reductionRoutes = require('./router/Reduction/reductionR'); // 🆕 Corrected path
const netReductionRoutes = require('./router/Reduction/netReductionR'); // 🆕 Corrected path
const FormulaR = require('./router/Reduction/FormulaR'); // 🆕 Corrected path
const netReductionSummaryR = require('./router/Reduction/netReductionSummaryR'); // 🆕 Corrected path
const DecarbonizationRoutes = require('./router/Decarbonization/sbtiRoutes'); // 🆕 Corrected path



// Import notification routes
const notificationRoutes = require('./router/Notification/notificationRoutes');
const { dataCollectionRouter, iotRouter } = require('./router/Organization/dataCollectionRoutes');

// Import IoT routes and MQTT subscriber
const iotRoutes = require('./router/iotRoutes');
// const MQTTSubscriber = require('./mqtt/mqttSubscriber');

// Import controllers
const { checkExpiredSubscriptions } = require("./controllers/CMS/clientController");
const { initializeSuperAdmin } = require("./controllers/userController");
const { publishScheduledNotifications } = require('./controllers/Notification/notificationControllers');
const { scheduleMonthlySummary, checkAndCreateMissedSummaries } = require('./controllers/DataCollection/monthlyDataSummaryController');

// 🆕 Import summary controller
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
const {
  setSocketIO,
  broadcastDataCompletionUpdate,
  broadcastNetReductionCompletionUpdate
} = require('./controllers/DataCollection/dataCompletionController');
const dataCompletionController = require('./controllers/DataCollection/dataCompletionController');

// ✅ ADDED: Ticket route import
const ticketRoutes = require('./router/Ticket/ticketRoutes');

// ✅ ADDED: Ticket controller import
const ticketController = require('./controllers/Ticket/ticketController');

// ✅ ADDED: SLA checker import
const { startSLAChecker } = require('./utils/jobs/ticketSlaChecker');


  

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


// Allow frontend origins to fetch images


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

// in index.js / server.js once:
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
// app.use('/api/data-entry', dataEntryRoutes);
app.use('/api/emission-factor-hub', EmissionFactorHub);
app.use('/api/iot', iotRoutes);
app.use('/api/ipcc', ipccDataRoutes);
app.use('/api/epa', EPADataRoutes);
app.use('/api/emission-factors', emissionFactorRoutes);
app.use('/api/emission-factor', ipccConverstionCalculation);
app.use('/api/summaries', summaryRoutes); // 🆕 Summary routes
app.use('/api/reductions', reductionRoutes); // 🆕 Reduction routes
app.use('/api/net-reduction', netReductionRoutes); // 🆕 Net Reduction routes
app.use('/api/formulas', FormulaR); // 🆕 M2 Formula routes
app.use('/api/sbti', DecarbonizationRoutes); // 🆕 SBTi Decarbonization routes

// Notification and data collection routes
app.use('/api/notifications', notificationRoutes);
app.use('/api/data-collection', dataCollectionRouter);
app.use('/api/iot', iotRouter);

app.use('/api', apiKeyRoutes);
app.use('/api/tickets', ticketRoutes);


// Create HTTP server and bind Socket.io
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: ["http://localhost:3000", "http://localhost:3002", "https://zerocarbon.greonxpert.com","https://www.zerocarbon.greonxpert.com", "http://localhost:5174"],
    credentials: true
  }
});

// 🆕 Set socket.io instance in controllers
dataCollectionController.setSocketIO(io);
calculationSummaryController.setSocketIO(io);
netReductionController.setSocketIO(io);
sbtiController.setSocketIO(io);
dataCompletionController.setSocketIO(io);


// 🔐 Socket.IO Authentication Middleware
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

// 📊 Track connected users
const connectedUsers = new Map();

// 🔄 Enhanced Socket.IO connection handling with Real-time Notifications and Summaries
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

    // 🆕 Handle joining summary-specific rooms
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

    // 🆕 Handle summary subscription requests
    socket.on('subscribe-to-summaries', async (data) => {
        try {
            const { clientId, periodTypes = ['monthly', 'yearly', 'all-time'] } = data;
            
            // Join the summary room
            socket.join(`summaries-${clientId}`);
            
            // Send current summary data
            const EmissionSummary = require('./models/EmissionSummary');
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

    // 🆕 Handle real-time summary calculation requests
    socket.on('calculate-summary', async (data) => {
        try {
            const { clientId, periodType = 'monthly', year, month } = data;
            
            console.log(`📊 Real-time summary calculation requested for client: ${clientId}`);
            
            // Trigger summary calculation
            const { recalculateAndSaveSummary } = calculationSummaryController;
            const summary = await recalculateAndSaveSummary(
                clientId, 
                periodType, 
                year, 
                month
            );
            
            if (summary) {
                // Emit updated summary to all clients in the room
                io.to(`summaries-${clientId}`).emit('summary-calculated', {
                    clientId,
                    summaryId: summary._id,
                    period: summary.period,
                    totalEmissions: summary.totalEmissions,
                    byScope: summary.byScope,
                    timestamp: new Date()
                });
                
                // Send success confirmation to requesting client
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
    
    // 📨 Send initial notification data
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
    
    // 📖 Handle mark as read
    socket.on('markNotificationAsRead', async (notificationId) => {
        try {
            const notification = await Notification.findById(notificationId);
            if (notification && await notification.canBeViewedBy(socket.user)) {
                await notification.markAsReadBy(socket.userId);
                
                // Emit updated read status
                socket.emit('notificationReadStatusUpdate', {
                    notificationId,
                    isRead: true,
                    readAt: new Date()
                });
                
                // Update unread count
                const unreadCount = await getUnreadCountForUser(socket.user);
                socket.emit('unreadCountUpdate', { unreadCount });
            }
        } catch (error) {
            console.error('Error marking notification as read:', error);
        }
    });
    
    // 📊 Handle IoT data requests
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

    // 🎯 Handle dashboard data requests
    socket.on('requestDashboardData', async (dashboardType) => {
        try {
            const { 
                getDashboardMetrics, 
                getWorkflowTrackingDashboard, 
                getOrganizationOverviewDashboard 
            } = require('./controllers/CMS/clientController');
            
            // Create a mock request/response object for the controller
            const mockReq = {
                user: socket.user,
                params: {},
                query: {}
            };
            
            const mockRes = {
                status: () => mockRes,
                json: (data) => {
                    // Emit the dashboard data to the requesting socket
                    socket.emit('dashboardData', {
                        type: dashboardType,
                        data: data,
                        timestamp: new Date().toISOString()
                    });
                }
            };
            
            // Call the appropriate dashboard function
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
    
    // 🔄 Handle real-time dashboard subscriptions
    socket.on('subscribeToDashboard', async (dashboardType) => {
        try {
            // Join dashboard-specific room
            socket.join(`dashboard_${dashboardType}_${socket.userId}`);
            
            console.log(`📊 User ${socket.user.userName} subscribed to ${dashboardType} dashboard`);
            
            // Send initial dashboard data
            socket.emit('dashboardSubscribed', {
                dashboardType,
                message: `Successfully subscribed to ${dashboardType} dashboard updates`
            });
            
            // Trigger initial data fetch
            socket.emit('requestDashboardData', dashboardType);
        } catch (error) {
            console.error('Error subscribing to dashboard:', error);
            socket.emit('dashboardError', { 
                message: 'Failed to subscribe to dashboard updates' 
            });
        }
    });

    // 🔄 Handle real-time client list requests
    socket.on('requestClients', async (filters = {}) => {
        try {
            const { getClients } = require('./controllers/CMS/clientController');
            
            // Create mock request/response objects
            const mockReq = {
                user: socket.user,
                query: filters // { stage, status, search, page, limit }
            };
            
            const mockRes = {
                status: () => mockRes,
                json: (data) => {
                    // Emit the clients data to the requesting socket
                    socket.emit('clients_data', {
                        type: 'clients_list',
                        data: data,
                        timestamp: new Date().toISOString()
                    });
                }
            };
            
            // Call getClients with mock objects
            await getClients(mockReq, mockRes);
            
        } catch (error) {
            console.error('Error fetching clients:', error);
            socket.emit('clientsError', { 
                message: 'Failed to fetch clients',
                error: error.message 
            });
        }
    });
    
    // 📊 Subscribe to client list updates
    socket.on('subscribeToClients', async (filters = {}) => {
        try {
            // Join client updates room based on user type
            const roomName = `clients_${socket.userType}_${socket.userId}`;
            socket.join(roomName);
            
            // If filters are provided, join filtered room
            if (filters.stage || filters.status) {
                const filterRoom = `clients_filtered_${JSON.stringify(filters)}_${socket.userId}`;
                socket.join(filterRoom);
            }
            
            console.log(`📋 User ${socket.user.userName} subscribed to client updates`);
            
            socket.emit('clientsSubscribed', {
                message: 'Successfully subscribed to client updates',
                filters: filters
            });
            
            // Send initial client data
            socket.emit('requestClients', filters);
            
        } catch (error) {
            console.error('Error subscribing to clients:', error);
            socket.emit('clientsError', { 
                message: 'Failed to subscribe to client updates' 
            });
        }
    });
    
    // 🔄 Unsubscribe from client updates
    socket.on('unsubscribeFromClients', () => {
        try {
            // Leave all client-related rooms
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
    
    // 🔍 Handle client search
    socket.on('searchClients', async (searchQuery) => {
        try {
            const Client = require('./models/CMS/Client');
            
            let query = { isDeleted: false };
            
            // Apply user-based filtering
            switch (socket.user.userType) {
                case "super_admin":
                    // Can search all clients
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
            
            // Add search criteria
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
    
    // 📊 Get client statistics
    socket.on('requestClientStats', async () => {
        try {
            const Client = require('./models/CMS/Client');
            let query = { isDeleted: false };
            
            // Apply user-based filtering similar to above...
            
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

    // Handle data collection events
    socket.on('request-data-status', async (clientId) => {
        try {
            // Get real-time data collection status
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

    // Handle leaving rooms
    socket.on('leave-client-room', (clientId) => {
        socket.leave(`client-${clientId}`);
        socket.leave(`summaries-${clientId}`);
        console.log(`📡 Socket ${socket.id} left rooms for client: ${clientId}`);
    });

        // 🆕 Subscribe to data completion updates for a client
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

            // Send initial snapshot immediately
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

    // 🆕 One-time request for latest data completion stats
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


    // 🔌 Handle disconnect
    socket.on('disconnect', () => {
        console.log(`🔌 Client disconnected: ${socket.user.userName} (${socket.id})`);
        connectedUsers.delete(socket.userId);
    });

    // 🆕 Handle ping for connection health check
    socket.on('ping', () => {
        socket.emit('pong', { timestamp: new Date() });
    });

    // ============================================================================
// 🎫 TICKET SYSTEM - SOCKET.IO HANDLERS & BROADCAST FUNCTIONS
// ============================================================================

/**
 * Ticket-specific Socket.IO event handlers
 * Add these inside the io.on('connection', (socket) => { ... }) block
 */

// Place this code inside io.on('connection', (socket) => { ... }) after line ~550

    // ============================================================================
    // 🎫 TICKET SOCKET HANDLERS
    // ============================================================================

    /**
     * Join a specific ticket room for real-time updates
     * Usage: socket.emit('join-ticket', ticketId)
     */
    socket.on('join-ticket', async (ticketId) => {
        try {
            const { Ticket } = require('./models/Ticket/Ticket');
            
            // Verify ticket exists and user has access
            const ticket = await Ticket.findById(ticketId);
            
            if (!ticket) {
                return socket.emit('ticket-error', {
                    message: 'Ticket not found',
                    ticketId
                });
            }

            // Check access permissions
            const hasAccess = await checkTicketAccess(socket.user, ticket);
            
            if (!hasAccess) {
                return socket.emit('ticket-error', {
                    message: 'Access denied to this ticket',
                    ticketId
                });
            }

            // Join the ticket room
            socket.join(`ticket_${ticketId}`);
            console.log(`🎫 Socket ${socket.id} (${socket.user.userName}) joined ticket room: ${ticketId}`);
            
            // Notify others in the room about new viewer
            socket.to(`ticket_${ticketId}`).emit('user-joined-ticket', {
                ticketId,
                userName: socket.user.userName,
                userId: socket.userId,
                userType: socket.user.userType,
                timestamp: new Date().toISOString()
            });

            // Send confirmation to user
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

    /**
     * Leave a ticket room
     * Usage: socket.emit('leave-ticket', ticketId)
     */
    socket.on('leave-ticket', (ticketId) => {
        try {
            socket.leave(`ticket_${ticketId}`);
            console.log(`🎫 Socket ${socket.id} (${socket.user.userName}) left ticket room: ${ticketId}`);
            
            // Notify others in the room
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

    /**
     * Handle typing indicator for ticket comments
     * Usage: socket.emit('ticket-typing', { ticketId, isTyping: true })
     */
    socket.on('ticket-typing', (data) => {
        try {
            const { ticketId, isTyping } = data;
            
            if (!ticketId) {
                return socket.emit('ticket-error', {
                    message: 'ticketId is required for typing indicator'
                });
            }

            // Broadcast to others in the ticket room
            socket.to(`ticket_${ticketId}`).emit('user-typing-ticket', {
                ticketId,
                userName: socket.user.userName,
                userId: socket.userId,
                isTyping: isTyping !== false, // default to true
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            console.error('Error handling ticket typing:', error);
        }
    });

    /**
     * Handle ticket viewing indicator (who's currently viewing)
     * Usage: socket.emit('ticket-viewing', ticketId)
     */
    socket.on('ticket-viewing', async (ticketId) => {
        try {
            if (!ticketId) {
                return socket.emit('ticket-error', {
                    message: 'ticketId is required'
                });
            }

            // Broadcast to others in the room
            socket.to(`ticket_${ticketId}`).emit('user-viewing-ticket', {
                ticketId,
                userName: socket.user.userName,
                userId: socket.userId,
                userType: socket.user.userType,
                timestamp: new Date().toISOString()
            });

            // Update view count in database (optional, can be done on API call instead)
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

    /**
     * Request ticket details with real-time data
     * Usage: socket.emit('request-ticket-details', ticketId)
     */
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

            // Check access
            const hasAccess = await checkTicketAccess(socket.user, ticket);
            if (!hasAccess) {
                return socket.emit('ticket-error', {
                    message: 'Access denied',
                    ticketId
                });
            }

            // Get activities
            const activities = await TicketActivity.find({
                ticket: ticketId,
                isDeleted: false
            })
                .populate('createdBy', 'userName email userType')
                .sort({ createdAt: 1 });

            // Filter internal comments based on user role
            const supportRoles = ['super_admin', 'consultant_admin', 'consultant'];
            const visibleActivities = activities.filter(activity => {
                if (activity.comment?.isInternal) {
                    return supportRoles.includes(socket.user.userType);
                }
                return true;
            });

            // Calculate SLA info
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

    /**
     * Subscribe to ticket list updates for a client
     * Usage: socket.emit('subscribe-to-tickets', { clientId, filters })
     */
    socket.on('subscribe-to-tickets', async (data) => {
        try {
            const { clientId, filters = {} } = data;
            const effectiveClientId = clientId || socket.clientId;

            if (!effectiveClientId) {
                return socket.emit('ticket-error', {
                    message: 'clientId is required'
                });
            }

            // Join client ticket room
            socket.join(`client-tickets_${effectiveClientId}`);
            console.log(`🎫 Socket ${socket.id} subscribed to tickets for client: ${effectiveClientId}`);

            // Get initial ticket list
            const { Ticket } = require('./models/Ticket/Ticket');
            
            const query = { clientId: effectiveClientId };
            
            // Apply filters
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

    /**
     * Unsubscribe from ticket updates
     * Usage: socket.emit('unsubscribe-from-tickets', clientId)
     */
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

    /**
     * Request ticket statistics
     * Usage: socket.emit('request-ticket-stats', clientId)
     */
    socket.on('request-ticket-stats', async (clientId) => {
        try {
            const effectiveClientId = clientId || socket.clientId;

            if (!effectiveClientId) {
                return socket.emit('ticket-error', {
                    message: 'clientId is required'
                });
            }

            const { Ticket } = require('./models/Ticket/Ticket');

            // Get counts by status
            const statusCounts = await Ticket.aggregate([
                { $match: { clientId: effectiveClientId } },
                { $group: { _id: '$status', count: { $sum: 1 } } }
            ]);

            // Get counts by priority
            const priorityCounts = await Ticket.aggregate([
                { $match: { clientId: effectiveClientId } },
                { $group: { _id: '$priority', count: { $sum: 1 } } }
            ]);

            // Get overdue count
            const overdueCount = await Ticket.countDocuments({
                clientId: effectiveClientId,
                status: { $nin: ['resolved', 'closed', 'cancelled'] },
                dueDate: { $lt: new Date() }
            });

            // Get my tickets count
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

// ============================================================================
// 🎫 TICKET BROADCAST FUNCTIONS (Place outside io.on('connection') block)
// ============================================================================

/**
 * Helper function to check ticket access
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

/**
 * Broadcast ticket created event
 */
async function broadcastTicketCreated(ticketData) {
    try {
        const { clientId, ticketId, ticket } = ticketData;
        
        console.log(`🎫 Broadcasting ticket created: ${ticketId} for client ${clientId}`);

        // Emit to client room
        io.to(`client_${clientId}`).emit('ticket-created', {
            ticket,
            timestamp: new Date().toISOString()
        });

        // Emit to client tickets room
        io.to(`client-tickets_${clientId}`).emit('ticket-list-updated', {
            action: 'created',
            ticket,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error broadcasting ticket created:', error);
    }
}

/**
 * Broadcast ticket updated event
 */
async function broadcastTicketUpdated(ticketData) {
    try {
        const { clientId, ticketId, changes } = ticketData;
        
        console.log(`🎫 Broadcasting ticket updated: ${ticketId}`);

        // Emit to ticket room
        io.to(`ticket_${ticketId}`).emit('ticket-updated', {
            ticketId,
            changes,
            timestamp: new Date().toISOString()
        });

        // Emit to client tickets room
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

/**
 * Broadcast ticket status changed event
 */
async function broadcastTicketStatusChanged(ticketData) {
    try {
        const { clientId, ticketId, status, ticket } = ticketData;
        
        console.log(`🎫 Broadcasting ticket status changed: ${ticketId} -> ${status}`);

        // Emit to ticket room
        io.to(`ticket_${ticketId}`).emit('ticket-status-changed', {
            ticketId,
            status,
            ticket,
            timestamp: new Date().toISOString()
        });

        // Emit to client room
        io.to(`client_${clientId}`).emit('ticket-status-changed', {
            ticketId,
            status,
            timestamp: new Date().toISOString()
        });

        // Emit to client tickets room
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

/**
 * Broadcast ticket assigned event
 */
async function broadcastTicketAssigned(ticketData) {
    try {
        const { clientId, ticketId, assignedTo } = ticketData;
        
        console.log(`🎫 Broadcasting ticket assigned: ${ticketId} to ${assignedTo.userName}`);

        // Emit to ticket room
        io.to(`ticket_${ticketId}`).emit('ticket-assigned', {
            ticketId,
            assignedTo,
            timestamp: new Date().toISOString()
        });

        // Emit to assignee's personal room
        io.to(`user_${assignedTo._id}`).emit('ticket-assigned-to-me', {
            ticketId,
            message: 'A ticket has been assigned to you',
            timestamp: new Date().toISOString()
        });

        // Emit to client tickets room
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

/**
 * Broadcast new comment on ticket
 */
async function broadcastTicketComment(commentData) {
    try {
        const { clientId, ticketId, activity, isInternal } = commentData;
        
        console.log(`🎫 Broadcasting ticket comment: ${ticketId}${isInternal ? ' (internal)' : ''}`);

        // Emit to ticket room
        io.to(`ticket_${ticketId}`).emit('ticket-new-comment', {
            ticketId,
            activity,
            timestamp: new Date().toISOString()
        });

        // If not internal, broadcast to client room too
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

/**
 * Broadcast ticket escalated event
 */
async function broadcastTicketEscalated(ticketData) {
    try {
        const { clientId, ticketId, escalationLevel } = ticketData;
        
        console.log(`🎫 Broadcasting ticket escalated: ${ticketId} - Level ${escalationLevel}`);

        // Emit to ticket room
        io.to(`ticket_${ticketId}`).emit('ticket-escalated', {
            ticketId,
            escalationLevel,
            timestamp: new Date().toISOString()
        });

        // Emit to client room
        io.to(`client_${clientId}`).emit('ticket-escalated', {
            ticketId,
            escalationLevel,
            priority: 'high',
            timestamp: new Date().toISOString()
        });

        // Emit to admin rooms for immediate attention
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

/**
 * Broadcast ticket attachment added
 */
async function broadcastTicketAttachment(attachmentData) {
    try {
        const { clientId, ticketId, attachments } = attachmentData;
        
        console.log(`🎫 Broadcasting ticket attachment added: ${ticketId}`);

        // Emit to ticket room
        io.to(`ticket_${ticketId}`).emit('ticket-attachment-added', {
            ticketId,
            attachments,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error broadcasting ticket attachment:', error);
    }
}

/**
 * Broadcast ticket deleted
 */
async function broadcastTicketDeleted(ticketData) {
    try {
        const { clientId, ticketId } = ticketData;
        
        console.log(`🎫 Broadcasting ticket deleted: ${ticketId}`);

        // Emit to ticket room
        io.to(`ticket_${ticketId}`).emit('ticket-deleted', {
            ticketId,
            message: 'This ticket has been deleted',
            timestamp: new Date().toISOString()
        });

        // Emit to client tickets room
        io.to(`client-tickets_${clientId}`).emit('ticket-list-updated', {
            action: 'deleted',
            ticketId,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error broadcasting ticket deleted:', error);
    }
}

/**
 * Broadcast SLA warning or breach
 */
async function broadcastSLAAlert(alertData) {
    try {
        const { clientId, ticketId, type, ticket } = alertData;
        
        console.log(`🎫 Broadcasting SLA alert: ${ticketId} - ${type}`);

        // Emit to ticket room
        io.to(`ticket_${ticketId}`).emit('ticket-sla-alert', {
            ticketId,
            type, // 'warning' or 'breach'
            ticket,
            timestamp: new Date().toISOString()
        });

        // Emit to client room
        io.to(`client_${clientId}`).emit('ticket-sla-alert', {
            ticketId,
            type,
            priority: type === 'breach' ? 'critical' : 'high',
            timestamp: new Date().toISOString()
        });

        // Emit to admin rooms
        io.to('userType_super_admin').emit('sla-alert', alertData);
        io.to('userType_consultant_admin').emit('sla-alert', alertData);

    } catch (error) {
        console.error('Error broadcasting SLA alert:', error);
    }
}

// Make broadcast functions globally available
global.broadcastTicketCreated = broadcastTicketCreated;
global.broadcastTicketUpdated = broadcastTicketUpdated;
global.broadcastTicketStatusChanged = broadcastTicketStatusChanged;
global.broadcastTicketAssigned = broadcastTicketAssigned;
global.broadcastTicketComment = broadcastTicketComment;
global.broadcastTicketEscalated = broadcastTicketEscalated;
global.broadcastTicketAttachment = broadcastTicketAttachment;
global.broadcastTicketDeleted = broadcastTicketDeleted;
global.broadcastSLAAlert = broadcastSLAAlert;

console.log('✅ Ticket broadcast functions registered globally');

});

// 🌐 Make io globally accessible for notifications
global.io = io;

// 📨 Real-time Notification Broadcasting Functions
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
        
        // Get target users
        const targetUsers = await getTargetUsersForNotification(populatedNotification);
        
        // Broadcast to specific users
        for (const user of targetUsers) {
            const userConnection = connectedUsers.get(user._id.toString());
            
            if (userConnection) {
                io.to(`user_${user._id}`).emit('newNotification', notificationData);
                
                // Update unread count for connected user
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

// 🎯 Get target users for notification
const getTargetUsersForNotification = async (notification) => {
    const targetUsers = [];
    
    // Specific users
    if (notification.targetUsers.length > 0) {
        const users = await User.find({
            _id: { $in: notification.targetUsers },
            isActive: true
        });
        targetUsers.push(...users);
    }
    
    // User types
    if (notification.targetUserTypes.length > 0) {
        const users = await User.find({
            userType: { $in: notification.targetUserTypes },
            isActive: true
        });
        targetUsers.push(...users);
    }
    
    // Client-specific
    if (notification.targetClients.length > 0) {
        const users = await User.find({
            clientId: { $in: notification.targetClients },
            isActive: true
        });
        targetUsers.push(...users);
    }
    
    // Remove duplicates
    const uniqueUsers = targetUsers.filter((user, index, self) => 
        index === self.findIndex(u => u._id.toString() === user._id.toString())
    );
    
    return uniqueUsers;
};

// 📊 Get unread count for user
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

// 🔄 Real-time Dashboard Update Functions
const broadcastDashboardUpdate = async (updateType, data, targetUsers = []) => {
    try {
        const updateData = {
            type: updateType,
            data: data,
            timestamp: new Date().toISOString()
        };
        
        if (targetUsers.length > 0) {
            // Send to specific users
            targetUsers.forEach(userId => {
                io.to(`user_${userId}`).emit('dashboard_update', updateData);
            });
        } else {
            // Broadcast to all relevant users based on update type
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

// Export broadcast functions for use in controllers
global.broadcastNotification = broadcastNotification;
global.broadcastDashboardUpdate = broadcastDashboardUpdate;
global.getUnreadCountForUser = getUnreadCountForUser;
global.getTargetUsersForNotification = getTargetUsersForNotification
// For DataEntry / emissions
global.broadcastDataCompletionUpdate = broadcastDataCompletionUpdate;
// For NetReductionEntry / reduction projects
global.broadcastNetReductionCompletionUpdate = broadcastNetReductionCompletionUpdate;


// 🆕 Periodic summary health check and updates
setInterval(async () => {
  try {
    const now = new Date();
    
    // Check for clients that need summary updates
    const DataEntry = require('./models/Organization/DataEntry');
    const recentEntries = await DataEntry.find({
      timestamp: { $gte: new Date(now.getTime() - 60 * 60 * 1000) }, // Last hour
      calculatedEmissions: { $exists: true },
      summaryUpdateStatus: { $ne: 'completed' }
    }).distinct('clientId');
    
    if (recentEntries.length > 0) {
      console.log(`🔄 Found ${recentEntries.length} clients needing summary updates`);
      
      for (const clientId of recentEntries) {
        try {
          // Update current month summary
          const { recalculateAndSaveSummary } = calculationSummaryController;
          const monthlySummary = await recalculateAndSaveSummary(
            clientId,
            'monthly',
            now.getFullYear(),
            now.getMonth() + 1
          );
          
          if (monthlySummary) {
            // Emit update to connected clients
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
}, 5 * 60 * 1000); // Every 5 minutes

// Initialize MQTT subscriber variable
// let mqttSubscriber = null;

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
    
     // ✅ NEW: Start API Key Expiry Checker
    console.log('🔐 Starting API Key expiry checker...');
    startApiKeyExpiryChecker();

    // Initialize MQTT Subscriber
    // global.mqttSubscriber = new MQTTSubscriber();
    
    // Schedule cron jobs
    cron.schedule('0 2 * * *', async () => {
      console.log('🔄 Running daily subscription check...');
      await checkExpiredSubscriptions();
    });
}).catch((error) => {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
});

// 🔄 Enhanced scheduled notifications with real-time broadcasting
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
    // console.log(`📡 Socket.IO server running with authentication`);
    // console.log(`📨 Real-time notifications enabled`);
    // console.log(`📊 Real-time summary updates enabled`);
    // console.log(`🔗 MQTT broker: 13.233.116.100:1883`);
    // console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
    // console.log(`📊 System status: http://localhost:${PORT}/api/system/status`);
});

module.exports = { app, server, io };