'use strict';

const express   = require('express');
const dotenv    = require('dotenv');
const cors      = require('cors');
const http      = require('http');
const socketIo  = require('socket.io');
const helmet    = require('helmet');
const path      = require('path');

dotenv.config();

const connectDB = require('./src/common/config/db');
const { initializeSuperAdmin } = require('./src/common/controllers/user/userController');

const { registerRoutes }  = require('./src/app/bootstrap/registerRoutes');
const { registerSockets } = require('./src/app/bootstrap/registerSockets');
const { registerJobs }    = require('./src/app/bootstrap/registerJobs');

// ============================================================================
// EXPRESS APP
// ============================================================================

const app = express();

// Security headers (first pass — default)
app.use(helmet());

// Security headers (second pass — explicit CSP + HSTS)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true }
}));

// Body parser
app.use(express.json({ limit: '10mb' }));

// Global request logger
app.use((req, res, next) => {
  console.log(`\n[${new Date().toISOString()}] ➜ ${req.method} ${req.originalUrl}`);
  console.log('  Params:', req.params);
  console.log('  Query :', req.query);
  console.log('  Body  :', req.body);
  next();
});

if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    next();
  });
}

// CORS
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3002',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5501',
    'https://zerocarbon.greonxpert.com',
    'https://www.zerocarbon.greonxpert.com',
    'https://ccts.greonxpert.com',
  ],
  credentials: true,
}));

// Static file serving
app.use(
  '/uploads',
  helmet.crossOriginResourcePolicy({ policy: 'cross-origin' }),
  express.static('uploads')
);

// ── Mount all API routes ────────────────────────────────────────────────────
registerRoutes(app);

// ============================================================================
// HTTP SERVER + SOCKET.IO
// ============================================================================

const server = http.createServer(app);

const io = socketIo(server, {
  cors: {
    origin: [
      'http://localhost:3000',
      'http://localhost:3002',
      'http://localhost:5173',
      'http://localhost:5174',
      'http://127.0.0.1:5501',
      'https://zerocarbon.greonxpert.com',
      'https://www.zerocarbon.greonxpert.com',
      'https://ccts.greonxpert.com',
    ],
    credentials: true
  }
});

// ── Wire up all Socket.IO handlers and global broadcast functions ───────────
registerSockets(io);

// ============================================================================
// DATABASE + BACKGROUND JOBS
// ============================================================================

connectDB()
  .then(async () => {
    console.log('✅ Database connected successfully');

    // Seed super-admin on first boot
    initializeSuperAdmin();

    // Seed built-in ESG rollUpBehaviors
    try {
      const { seedBuiltInBehaviors } = require('./src/modules/esg-link/esgLink_core/rollup/services/rollUpService');
      await seedBuiltInBehaviors();
      console.log('✅ ESG rollUpBehavior built-ins seeded');
    } catch (err) {
      console.error('⚠️  ESG rollUpBehavior seed error (non-fatal):', err.message);
    }

    // ── Start all cron jobs and background workers ──────────────────────────
    registerJobs();
  })
  .catch((error) => {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  });

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
  console.log(`📡 Socket.IO server running with authentication`);
});

module.exports = { app, server, io };
