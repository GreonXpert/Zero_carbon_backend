'use strict';

// NOTE: Socket.IO in cluster mode requires @socket.io/redis-adapter so that
// events are broadcast across all workers. Until that adapter is added,
// keep instances: 1 in production. Change to 'max' only after adding the
// Redis adapter (see P0-12 checklist for the follow-up task).

module.exports = {
  apps: [
    // ── Production ─────────────────────────────────────────────────────────
    {
      name: 'zerocarbon-api',
      script: 'index.js',

      // Single process until Socket.IO Redis adapter is in place.
      // Switch to exec_mode: 'cluster' + instances: 'max' after that.
      instances: 1,
      exec_mode: 'fork',

      // Auto-restart on crash
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',

      // Restart back-off — avoids tight crash loops
      min_uptime: '10s',
      max_restarts: 10,

      // Log paths
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      env: {
        NODE_ENV: 'development',
        PORT: 5000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 5000,
      },
    },

    // ── Cluster-ready config (activate after Redis adapter is added) ────────
    // Uncomment and switch the block above to this one once
    // @socket.io/redis-adapter is installed and wired up in index.js.
    //
    // {
    //   name        : 'zerocarbon-api-cluster',
    //   script      : 'index.js',
    //   instances   : 'max',
    //   exec_mode   : 'cluster',
    //   autorestart : true,
    //   watch       : false,
    //   max_memory_restart: '512M',
    //   min_uptime  : '10s',
    //   max_restarts: 10,
    //   out_file    : './logs/pm2-out.log',
    //   error_file  : './logs/pm2-error.log',
    //   merge_logs  : true,
    //   log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    //   env_production: {
    //     NODE_ENV: 'production',
    //     PORT    : 5000,
    //   },
    // },
  ],
};
