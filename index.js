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
const clientR = require("./router/clientR");
const adminR = require("./router/adminR");
const authR = require("./router/authR");
const flowchartR = require("./router/flowchartR");
const EmissionFactorRoute = require("./router/EmissionFactor");
const gwpRoutes = require("./router/gwpRoutes");
const fuelCombustionRoutes = require("./router/fuelCombustionRoutes");
const CountryemissionFactorRouter = require("./router/countryemissionFactorRouter");
const CalculateEmissionCO2eRouter = require("./router/CalculateEmissionCO2eRoute");
const TotalEmissionCO2eControllerRouter = require("./router/TotalEmissionCO2eControllerRoute");
const CalculationOfElectricityRouter = require("./router/CalculationOfElectricityRouter");
const TotalEmissionElectricityRouter = require("./router/TotalEmissionElectricityRouter");
const processFlowR = require("./router/processflowR");
const dataEntryRoutes = require('./router/dataEntryRoutes');
const EmissionFactorScope3Routes = require('./router/EmissionFactorScope3Routes');

// NEW: Import notification routes (MISSING FROM YOUR CURRENT INDEX.JS)
const notificationRoutes = require('./router/notificationRoutes');

// NEW: Import IoT routes and MQTT subscriber
const iotRoutes = require('./router/iotRoutes');
const MQTTSubscriber = require('./mqtt/mqttSubscriber');

// Import controllers
const { checkExpiredSubscriptions } = require("./controllers/clientController");
const { initializeSuperAdmin } = require("./controllers/userController");
const { publishScheduledNotifications } = require('./controllers/notificationControllers');

// Import models for real-time features
const User = require('./models/User');
const Notification = require('./models/Notification');




dotenv.config();

const app = express();

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

app.use(cors({
    origin: ["http://localhost:3000", "http://localhost:3002", "https://api.zerohero.ebhoom.com", "https://zerotohero.ebhoom.com"],
    credentials: true,
}));





// Routes
app.use("/api/users", userR);
app.use("/api/clients", clientR);
app.use("/api/admin", adminR);
app.use("/api/auth", authR);
app.use("/api/flowchart", flowchartR);
app.use("/api", EmissionFactorRoute);
app.use("/api/gwp", gwpRoutes);
app.use("/api/fuelCombustion", fuelCombustionRoutes);
app.use("/api/country-emission-factors", CountryemissionFactorRouter);
app.use("/api", CalculateEmissionCO2eRouter);
app.use("/api", TotalEmissionCO2eControllerRouter);
app.use("/api", CalculationOfElectricityRouter);
app.use("/api", TotalEmissionElectricityRouter);
app.use("/api/processflow", processFlowR);
app.use('/api/data-entry', dataEntryRoutes);
app.use('/api/scope3-emission-factors', EmissionFactorScope3Routes);
app.use('/api', iotRoutes);

// 🚀 ADD NOTIFICATION ROUTES (MISSING IN YOUR ORIGINAL)
app.use('/api/notifications', notificationRoutes);

// Create HTTP server and bind Socket.io
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: ["http://localhost:3000", "http://localhost:3002", "https://api.zerohero.ebhoom.com", "https://zerotohero.ebhoom.com"],
    credentials: true
  }
});

// 🔐 Socket.IO Authentication Middleware
io.use(async (socket, next) => {
    try {
        const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
        
        if (!token) {
            return next(new Error('Authentication token required'));
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.userId).select('-password');
        
        if (!user || !user.isActive) {
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

// 🔄 Enhanced Socket.IO connection handling with Real-time Notifications
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
    
    // 🔌 Handle disconnect
    socket.on('disconnect', () => {
        console.log(`🔌 Client disconnected: ${socket.user.userName} (${socket.id})`);
        connectedUsers.delete(socket.userId);
    });
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

// 📡 Export broadcast function for use in controllers
global.broadcastNotification = broadcastNotification;

// Initialize MQTT subscriber variable
let mqttSubscriber = null;

// Connect to Database and start services
connectDB().then(() => {
    console.log('✅ Database connected successfully');
    
    // Initialize Super Admin account
    initializeSuperAdmin();
    
    // Start MQTT subscriber after database connection
    console.log('🚀 Starting MQTT subscriber...');
    mqttSubscriber = new MQTTSubscriber();
    mqttSubscriber.connect();
    
    // Add MQTT status tracking
    setInterval(() => {
        if (mqttSubscriber) {
            const status = mqttSubscriber.getStatus();
            if (!status.connected) {
                console.log('⚠️ MQTT subscriber disconnected, attempting reconnect...');
            }
        }
    }, 30000);
    
    // Schedule cron job to check expired subscriptions daily at midnight
    cron.schedule('0 0 * * *', () => {
        console.log('🔄 Running daily subscription check...');
        checkExpiredSubscriptions();
    });
    
    // Run subscription check on startup
    checkExpiredSubscriptions();
    
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

// ... (other requires and setup above)

// Start background scheduler for notifications (runs every minute)
cron.schedule('*/10 * * * *', async () => {
  console.log('🔄 Checking for scheduled notifications...');
  try {
    await publishScheduledNotifications();
  } catch (error) {
    console.error('Error in scheduled notification job:', error);
  }
});


// Add MQTT status endpoint
app.get('/api/mqtt/status', (req, res) => {
    if (mqttSubscriber) {
        const status = mqttSubscriber.getStatus();
        res.json({
            success: true,
            mqtt: status,
            timestamp: new Date().toISOString()
        });
    } else {
        res.status(503).json({
            success: false,
            message: 'MQTT subscriber not initialized',
            timestamp: new Date().toISOString()
        });
    }
});

// 📊 Real-time system status endpoint
app.get('/api/system/status', (req, res) => {
    const mongoose = require('mongoose');
    const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    const mqttStatus = mqttSubscriber ? mqttSubscriber.getStatus() : { connected: false };
    
    res.json({
        success: true,
        status: 'healthy',
        services: {
            database: dbStatus,
            mqtt: mqttStatus.connected ? 'connected' : 'disconnected',
            socketio: 'running',
            connectedUsers: connectedUsers.size
        },
        realtime: {
            connectedUsers: Array.from(connectedUsers.values()).map(conn => ({
                userId: conn.user._id,
                userName: conn.user.userName,
                userType: conn.user.userType,
                connectedAt: conn.connectedAt
            }))
        },
        timestamp: new Date().toISOString()
    });
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
    try {
        const mongoose = require('mongoose');
        const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
        const mqttStatus = mqttSubscriber ? mqttSubscriber.getStatus() : { connected: false };
        
        res.json({
            success: true,
            status: 'healthy',
            services: {
                database: dbStatus,
                mqtt: mqttStatus.connected ? 'connected' : 'disconnected',
                socketio: 'running'
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            status: 'unhealthy',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Graceful shutdown
const gracefulShutdown = () => {
    console.log('\n🛑 Received shutdown signal, closing gracefully...');
    
    // Close MQTT connection
    if (mqttSubscriber) {
        mqttSubscriber.disconnect();
        console.log('✅ MQTT subscriber disconnected');
    }
    
    // Close Socket.IO server
    io.close(() => {
        console.log('✅ Socket.IO server closed');
    });
    
    // Close HTTP server
    server.close(() => {
        console.log('✅ HTTP server closed');
        process.exit(0);
    });
    
    // Force close after 10 seconds
    setTimeout(() => {
        console.log('⚠️ Forcing shutdown after timeout');
        process.exit(1);
    }, 10000);
};

// Handle shutdown signals
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    gracefulShutdown();
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    gracefulShutdown();
});

// Start Server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`🚀 Server started on port ${PORT}`);
    console.log(`📡 Socket.IO server running with authentication`);
    console.log(`📨 Real-time notifications enabled`);
    console.log(`🔗 MQTT broker: 13.233.116.100:1883`);
    console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
    console.log(`📊 System status: http://localhost:${PORT}/api/system/status`);
});

module.exports = { app, server, io };