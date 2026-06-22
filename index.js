'use strict';

const express     = require('express');
const dotenv      = require('dotenv');
const cors        = require('cors');
const http        = require('http');
const socketIo    = require('socket.io');
const helmet      = require('helmet');
const compression = require('compression');
const path        = require('path');
const mongoose    = require('mongoose');

dotenv.config();

const connectDB = require('./src/common/config/db');
const logger    = require('./src/common/config/logger');
const pinoHttp  = require('pino-http');
const { initializeSuperAdmin } = require('./src/common/controllers/user/userController');

const { registerRoutes }  = require('./src/app/bootstrap/registerRoutes');
const { registerSockets } = require('./src/app/bootstrap/registerSockets');
const { registerJobs }    = require('./src/app/bootstrap/registerJobs');

// ============================================================================
// EXPRESS APP
// ============================================================================

const app = express();

// Gzip/deflate compression for all responses (JSON payloads, etc.)
// SSE responses (Content-Type: text/event-stream) must be excluded — gzip
// buffers chunks internally and never flushes small writes, so the response
// headers/body never reach the client and EventSource hangs on "connecting".
app.use(compression({
  filter: (req, res) => {
    if (res.getHeader('Content-Type') === 'text/event-stream') return false;
    return compression.filter(req, res);
  }
}));

// Security headers — explicit CSP + HSTS (single call, no duplicate overhead)
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

// Structured request logger — redacts auth headers, passwords, tokens.
// /health is excluded from auto-logging to keep logs clean.
app.use(pinoHttp({
  logger,
  autoLogging: { ignore: (req) => req.url === '/health' },
}))

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

// ── Health check — load balancers, Docker HEALTHCHECK, PM2, k6 smoke tests ──
app.get('/health', (req, res) => {
  const dbState  = mongoose.connection.readyState;
  // readyState: 0=disconnected 1=connected 2=connecting 3=disconnecting
  const dbStatus = dbState === 1 ? 'connected' : 'disconnected';
  const status   = dbState === 1 ? 'ok' : 'degraded';
  const mem      = process.memoryUsage();

  res.status(status === 'ok' ? 200 : 503).json({
    status,
    timestamp:   new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    environment: process.env.NODE_ENV || 'development',
    db:          dbStatus,
    memory: {
      heapUsedMB:  Math.round(mem.heapUsed  / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB:       Math.round(mem.rss       / 1024 / 1024),
    },
  });
});

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

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

function shutdown(signal) {
  console.log(`\n[${new Date().toISOString()}] ${signal} received — shutting down gracefully…`);

  // Force-exit safety net: if shutdown takes longer than 10 s, bail out hard.
  // .unref() so this timer never prevents the process from exiting on its own.
  const forceExit = setTimeout(() => {
    console.error('❌ Graceful shutdown timed out after 10 s — forcing exit.');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  // Step 1 — stop accepting new connections; let in-flight requests finish.
  server.close(async () => {
    console.log('✅ HTTP server closed.');

    // Step 2 — close the Mongoose connection pool cleanly.
    try {
      await mongoose.connection.close();
      console.log('✅ MongoDB connection closed.');
    } catch (err) {
      console.error('⚠️  Error closing MongoDB connection:', err.message);
    }

    // Step 3 — clean exit.
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = { app, server, io };
