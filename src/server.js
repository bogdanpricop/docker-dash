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

app.use(express.json({ limit: '2mb' })); // Reduced from 10mb — increase per-route if needed

// Request timeout — prevent hanging requests (5 min default)
app.use((req, res, next) => {
  req.setTimeout(300000); // 5 minutes
  res.setTimeout(300000);
  next();
});
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Trust proxy — set to specific proxy IPs or 'loopback' for security
// 'true' trusts ALL proxies (allows IP spoofing). Use specific IPs in production.
// Trust proxy — configurable via TRUST_PROXY env var.
// 'loopback' = trust only localhost proxies (safe default for production)
// 'true' = trust all (development convenience)
// '10.0.0.1' = trust specific proxy IP
app.set('trust proxy', process.env.TRUST_PROXY || (config.app.env === 'production' ? 'loopback' : true));

// Request latency tracking + logging
app.use((req, res, next) => {
  if (req.url.startsWith('/api/health') || req.url.startsWith('/ws') || !req.url.startsWith('/api')) {
    return next();
  }
  const start = Date.now();
  const origEnd = res.end;
  res.end = function(...args) {
    const duration = Date.now() - start;
    // Log slow requests (>2s) as warnings
    if (duration > 2000) {
      log.warn('Slow request', { method: req.method, url: req.url, duration: `${duration}ms`, status: res.statusCode });
    } else if (config.app.env === 'development') {
      log.debug(`${req.method} ${req.url} ${res.statusCode} ${duration}ms`);
    }
    // Expose latency header for debugging
    res.setHeader('X-Response-Time', `${duration}ms`);
    origEnd.apply(this, args);
  };
  next();
});

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
app.use('/api/workflows', apiLimiter, require('./routes/workflows'));
app.use('/api/migrate', apiLimiter, require('./routes/migration'));
app.use('/api/bundles', apiLimiter, require('./routes/stackBundle'));
const statusPageLimiter = rateLimit(30, 60 * 1000); // 30/min for public endpoint
app.use('/api/status-page', statusPageLimiter, require('./routes/statusPage'));
app.use('/api/groups', apiLimiter, require('./routes/groups'));
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

// Central error handler — sanitize errors before sending to client
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  const isOperational = status < 500; // 4xx errors are operational (user's fault)

  // Log server errors fully, operational errors briefly
  if (isOperational) {
    log.warn('Request error', { status, message: err.message, path: req.path });
  } else {
    log.error('Server error', { message: err.message, stack: err.stack?.substring(0, 500), path: req.path });
  }

  // Never expose internal details for 500 errors
  const clientMessage = isOperational ? err.message : 'Internal server error';

  // Remove any potential credential/path leaks from error messages
  const sanitized = clientMessage
    .replace(/\/home\/[^\s]+/g, '[path]')
    .replace(/\/data\/[^\s]+/g, '[path]')
    .replace(/https?:\/\/[^@\s]+@/g, 'https://***@')
    .substring(0, 500);

  res.status(status).json({ error: sanitized });
});

// ─── Server Startup ─────────────────────────────────────────

const server = http.createServer(app);

async function start() {
  // ─── Security Validation ─────────────────────────────────
  const isProduction = config.app.env === 'production';
  const weakSecrets = ['change-me-in-production-', 'generate-a-random-string-here'];
  const weakEncKeys = ['change-me-to-a-random-32-char-hex'];

  if (isProduction) {
    let securityFatal = false;
    const secret = config.app.secret || '';
    if (weakSecrets.some(w => secret.startsWith(w)) || secret.length < 32) {
      log.error('FATAL: APP_SECRET is weak or default. Refusing to start in production.');
      log.error('Fix: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))" >> .env');
      securityFatal = true;
    }
    const encKey = config.security.encryptionKey || '';
    if (weakEncKeys.some(w => encKey === w) || encKey.length < 16) {
      log.error('FATAL: ENCRYPTION_KEY is weak or default. Refusing to start in production.');
      log.error('Fix: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" >> .env');
      securityFatal = true;
    }
    if (securityFatal) {
      log.error('Set strong secrets in .env and restart. Exiting.');
      process.exit(1);
    }
    if (config.admin.defaultPassword === 'admin') {
      log.warn('SECURITY: Default admin password is "admin". Change it immediately after first login.');
    }
    if (!config.session.secureCookie) {
      log.warn('SECURITY: COOKIE_SECURE is false. Set COOKIE_SECURE=true when behind HTTPS.');
    }
  }

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
    log.info(`🐳 Docker Dash running`, {
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
