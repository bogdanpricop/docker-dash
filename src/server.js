'use strict';

const http = require('http');
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');

const config = require('./config');
const { getDb, closeDb } = require('./db');
const log = require('./utils/logger')('server');

// ─── Express App ────────────────────────────────────────────

const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://unpkg.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:", "https://cdn.jsdelivr.net"],
      upgradeInsecureRequests: null,
    },
  },
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Trust proxy (for Cloudflare/nginx)
app.set('trust proxy', true);

// Request logging (dev only)
if (config.app.env === 'development') {
  app.use((req, res, next) => {
    if (!req.url.startsWith('/api/health') && !req.url.startsWith('/ws')) {
      log.debug(`${req.method} ${req.url}`);
    }
    next();
  });
}

// ─── API Routes ─────────────────────────────────────────────

const { rateLimit } = require('./middleware/rateLimit');
const apiLimiter = rateLimit(config.rateLimit.apiMaxRequests, config.rateLimit.apiWindowMs);

// Git webhook receiver — public, no auth, separate rate limit
const webhookReceiverLimiter = rateLimit(30, 60 * 1000);
app.use('/api/git/webhook', webhookReceiverLimiter, require('./routes/gitWebhook'));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/containers', apiLimiter, require('./routes/containers'));
app.use('/api/images', apiLimiter, require('./routes/images'));
app.use('/api/volumes', apiLimiter, require('./routes/volumes'));
app.use('/api/networks', apiLimiter, require('./routes/networks'));
app.use('/api/system', apiLimiter, require('./routes/system'));
app.use('/api/stats', apiLimiter, require('./routes/stats'));
app.use('/api/alerts', apiLimiter, require('./routes/alerts'));
app.use('/api/webhooks', apiLimiter, require('./routes/webhooks'));
app.use('/api/registries', apiLimiter, require('./routes/registries'));
app.use('/api/hosts', apiLimiter, require('./routes/hosts'));
app.use('/api/git', apiLimiter, require('./routes/git'));
app.use('/api/notification-channels', apiLimiter, require('./routes/notificationChannels'));
app.use('/api/maintenance', apiLimiter, require('./routes/maintenance'));
app.use('/api/templates', apiLimiter, require('./routes/templates'));
app.use('/api/status-page', require('./routes/statusPage'));
app.use('/api', apiLimiter, require('./routes/misc'));

// ─── Static Files ───────────────────────────────────────────

app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: config.app.env === 'development' ? 0 : '1d',
  etag: true,
}));

// SPA fallback
app.get('*', (req, res) => {
  if (req.accepts('html')) {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// Error handler
app.use((err, req, res, next) => {
  log.error('Unhandled error', { message: err.message, stack: err.stack?.substring(0, 500) });
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Server Startup ─────────────────────────────────────────

const server = http.createServer(app);

async function start() {
  // Initialize DB (runs migrations)
  getDb();
  log.info('Database initialized');

  // Seed admin user
  const authService = require('./services/auth');
  authService.seedAdmin();

  // Detect self container ID
  const dockerService = require('./services/docker');
  await dockerService.detectSelfId();

  // Initialize SSH tunnels for existing hosts (before stats/events)
  await dockerService.initSshTunnels();

  // Attach WebSocket server
  const wsServer = require('./ws');
  wsServer.attach(server);

  // Start stats collector
  const statsService = require('./services/stats');
  statsService.start();

  statsService.on('collected', (liveData, hostId) => {
    const overview = {
      containers: liveData,
      hostId: hostId || 0,
      totals: {
        cpu: liveData.reduce((s, c) => s + c.cpu, 0),
        memory: liveData.reduce((s, c) => s + c.memUsage, 0),
      },
    };
    wsServer.broadcast('stats:overview', overview, 'stats:overview');
    for (const c of liveData) {
      wsServer.broadcast('stats:update', c, `stats:${c.containerId}`);
    }
  });

  // Start background jobs
  const jobs = require('./jobs');
  jobs.startAll();

  // Start host health checks
  dockerService.startHealthChecks();

  // Listen
  server.listen(config.app.port, config.app.host, () => {
    log.info(`🐳 Docker Dash v2 running`, {
      url: `http://${config.app.host}:${config.app.port}`,
      env: config.app.env,
    });
  });
}

// ─── Graceful Shutdown ──────────────────────────────────────

function shutdown(signal) {
  log.info(`${signal} received, shutting down...`);

  const statsService = require('./services/stats');
  statsService.stop();

  const dockerService2 = require('./services/docker');
  dockerService2.stopHealthChecks();

  try { require('./services/ssh-tunnel').closeAll(); } catch {}

  const jobs = require('./jobs');
  jobs.stopAll();

  server.close(() => {
    closeDb();
    log.info('Server stopped');
    process.exit(0);
  });

  // Force exit after 10s
  setTimeout(() => {
    log.warn('Forced shutdown');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => {
  log.error('Failed to start', err.message);
  process.exit(1);
});

module.exports = app; // For testing
