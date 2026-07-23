'use strict';

const http = require('http');
const fs = require('fs');
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');

// ─── Single source of truth for version ─────────────────────
// index.html uses __VERSION__ placeholder — replaced here at startup.
// To release a new version: bump package.json (npm version X.Y.Z) → restart. Done.
// src/version.js is auto-updated by scripts/sync-version.js (npm lifecycle hook).
const _appVersion = require('./version');
const _indexHtml = fs
  .readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
  .replace(/__VERSION__/g, _appVersion);

const config = require('./config');
const { getDb, closeDb } = require('./db');
const log = require('./utils/logger')('server');

// ─── Express App ────────────────────────────────────────────

const app = express();

// Security headers
// Helmet defaults (v8+) already set HSTS (1yr + includeSubDomains), Referrer-Policy
// no-referrer, COOP/CORP same-origin, X-Content-Type-Options nosniff, X-XSS-Protection 0.
// Overrides below:
//   - CSP: unsafe-eval kept for Chart.js (tracked in SECURITY.md as a known tradeoff);
//     unsafe-inline for <style> only (no inline scripts — scriptSrcAttr 'none' blocks them).
//   - frameguard: tightened from default SAMEORIGIN to DENY — Docker Dash is a standalone
//     admin UI; no legitimate use case for iframe embedding.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      // v8.2.x post-audit: removed third-party CDN allowlist entries.
      // Chart.js (/lib/chart.umd.min.js), xterm + addon-fit (/lib/xterm.*),
      // FontAwesome CSS + webfonts (/lib/fontawesome.min.css + /webfonts/*)
      // are all served from 'self'. CSP is now strict 'self' for everything
      // — no third-party origins allowed.
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      upgradeInsecureRequests: null,
    },
  },
  frameguard: { action: 'deny' },
  // v7.3.7: disable Origin-Agent-Cluster (Helmet default sends `?1`).
  // Without explicitly opting in on every page, the header gets ignored
  // with a console warning ("could not be origin-keyed since the origin
  // had previously been placed in a site-keyed agent cluster"). We don't
  // need agent-cluster keying for our SPA, so just stop sending it.
  originAgentCluster: false,
}));

// Permissions-Policy — explicitly deny browser APIs we never use. Any future
// feature that needs one of these (e.g. audio notifications) must opt-in here.
// v7.3.7: dropped 6 features that current browsers don't recognize (Edge
// console flagged each as "Unrecognized feature"):
//   - ambient-light-sensor (early proposal, never standardized)
//   - battery (removed from spec for privacy)
//   - document-domain (not a Permissions-Policy feature; lives in CSP/headers)
//   - execution-while-not-rendered, execution-while-out-of-viewport (Chrome-only,
//     never standardized)
//   - navigation-override (Chrome-only, never standardized)
// All six are still safe defaults at the platform level — listing them
// here was warning-noise, not protection.
app.use((req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    'accelerometer=(), autoplay=(), camera=(), ' +
    'cross-origin-isolated=(), display-capture=(), encrypted-media=(), ' +
    'fullscreen=(self), geolocation=(), gyroscope=(), keyboard-map=(), ' +
    'magnetometer=(), microphone=(), midi=(), payment=(), ' +
    'picture-in-picture=(), publickey-credentials-get=(), ' +
    'screen-wake-lock=(), sync-xhr=(), usb=(), web-share=(), xr-spatial-tracking=()'
  );
  next();
});

app.use(express.json({ limit: '2mb' })); // Reduced from 10mb — increase per-route if needed

// Global prototype pollution protection on all JSON bodies
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    delete req.body.__proto__;
    delete req.body.constructor;
    delete req.body.prototype;
  }
  next();
});

// Request timeout — prevent hanging requests (5 min default)
app.use((req, res, next) => {
  req.setTimeout(300000); // 5 minutes
  res.setTimeout(300000);
  next();
});
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(require('./middleware/csrf'));

// Trust proxy — set to specific proxy IPs or 'loopback' for security
// 'true' trusts ALL proxies (allows IP spoofing). Use specific IPs in production.
// Trust proxy — configurable via TRUST_PROXY env var.
// 'loopback' = trust only localhost proxies (safe default for production)
// 'true' = trust all (development convenience)
// '10.0.0.1' = trust specific proxy IP
app.set('trust proxy', process.env.TRUST_PROXY || (config.app.env === 'production' ? 'loopback' : true));

// Request latency tracking + logging + Prometheus metrics
const metricsService = require('./services/metrics');
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
    // Record for Prometheus (v6.15.0). Exclude /api/metrics itself to avoid self-measurement skew.
    if (!req.url.startsWith('/api/metrics')) {
      metricsService.recordRequest(req.method, res.statusCode, duration);
    }
    // Expose latency header for debugging (guard: headers may already be sent for streamed responses)
    if (!res.headersSent) res.setHeader('X-Response-Time', `${duration}ms`);
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
// Mount /api/system/update-check BEFORE /api/system so its specific routes
// win and we skip the system router's extractHostId middleware (no host needed).
app.use('/api/system/update-check', apiLimiter, require('./routes/update-check'));
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
app.use('/api/permissions', apiLimiter, require('./routes/permissions'));
app.use('/api/audit', apiLimiter, require('./routes/audit'));
app.use('/api/security-alerts', apiLimiter, require('./routes/securityAlerts'));
app.use('/api/secrets', apiLimiter, require('./routes/secrets'));
app.use('/api/secrets-rotations', apiLimiter, require('./routes/secretsRotations'));
app.use('/api/system/acme', apiLimiter, require('./routes/acme'));
app.use('/api/egress-filter', apiLimiter, require('./routes/egress-filter'));
app.use('/api/translations', apiLimiter, require('./routes/translations'));
app.use('/api/remediate', apiLimiter, require('./routes/remediate'));
app.use('/api/log-forwarders', apiLimiter, require('./routes/log-forwarders'));
app.use('/api/observability', apiLimiter, require('./routes/observability'));
app.use('/api/ai', apiLimiter, require('./routes/ai'));
app.use('/api/swarm', apiLimiter, require('./routes/swarm'));
// v8.9.0-alpha.2 — Sprint 3 (Incus / LXD-successor). Feature-gated at
// route level by daemon_type='incus' on the target hosts row.
app.use('/api/incus', apiLimiter, require('./routes/incus'));
// v8.9.1-alpha.1 — Sprint 4 (Proxmox VE). Read-only alpha.
app.use('/api/proxmox', apiLimiter, require('./routes/proxmox'));
// v8.9.2-alpha.1 — Sprint 7: cross-hypervisor VM migration to Proxmox.
app.use('/api/migration-vm', apiLimiter, require('./routes/migration-vm'));
// v8.9.4-alpha.1 — Sprint 5 (Kubernetes). Read-only alpha: namespaces,
// pods, deployments, services, nodes. Write ops (scale, rollout-
// restart, delete pod) land in alpha.2. Feature-gated per-host by
// daemon_type='kubernetes' on the target row.
app.use('/api/kubernetes', apiLimiter, require('./routes/kubernetes'));
// v8.9.5-alpha.1 — Sprint 10 (Nomad). Read-only alpha: jobs,
// allocations, nodes, deployments, namespaces. Feature-gated per-host
// by daemon_type='nomad' on the target row.
app.use('/api/nomad', apiLimiter, require('./routes/nomad'));
// v8.9.7-alpha.1 — Gap Closure ship 1
app.use('/api/host-groups', apiLimiter, require('./routes/host-groups'));
app.use('/api/git', apiLimiter, require('./routes/git-multi-host'));
// v8.9.8-alpha.1 — Gap closure ship 2
{
  const cw = require('./routes/container-webhooks');
  app.use('/api/container-webhooks', apiLimiter, cw.mgmt);
  // Public trigger endpoint — separate mount so it doesn't inherit apiLimiter
  // (has its own tighter limiter). No auth here — token IS the auth.
  app.use('/webhook/container', cw.trigger);
}
app.use('/api/docker', apiLimiter, require('./routes/docker-events'));
// v8.9.9-alpha.1 — Gap closure ship 3
app.use('/api/volumes', apiLimiter, require('./routes/volume-browser'));
app.use('/api/integrations', apiLimiter, require('./routes/integrations'));
app.use('/api/alert-routes', apiLimiter, require('./routes/alert-routes'));
// v8.9.10-alpha.1 — Gap closure ship 4: Teams + Per-host access control
app.use('/api/teams', apiLimiter, require('./routes/teams'));
app.use('/api/host-permissions', apiLimiter, require('./routes/host-permissions'));
// v8.9.11-alpha.1 — VMware vSphere / ESXi read-only alpha
app.use('/api/vsphere', apiLimiter, require('./routes/vsphere'));
// v8.9.16-alpha.1 — SSH Key Deployer (System → Tools)
app.use('/api/ssh-keys', apiLimiter, require('./routes/ssh-keys'));
app.use('/api/firewall', apiLimiter, require('./routes/firewall'));
app.use('/api/posture', apiLimiter, require('./routes/posture'));
app.use('/api/blueprints', apiLimiter, require('./routes/blueprints'));
app.use('/api/copilot', apiLimiter, require('./routes/copilot'));
// v8.15.0 — Onboarding & Provisioning Wizard (Phase 1 backend): tenant model +
// provisioning saga engine. All routes admin-gated + audited; secrets redacted.
app.use('/api/onboarding', apiLimiter, require('./routes/onboarding'));

// v7.4.0 — Sample feature for contributors (gated by env so it can be
// hidden from production deployments). See examples/sample-feature/README.md
// and docs/CONTRIBUTING.md for the full walkthrough.
if (process.env.DD_SHOW_SAMPLE_PLUGIN !== 'false') {
  app.use('/api/sample-feature', apiLimiter, require('./routes/sample-feature'));
}

app.use('/api', apiLimiter, require('./routes/misc'));

// ─── Static Files ───────────────────────────────────────────

// index.html is served from memory (version already injected).
// express.static must NOT serve it — intercept before static middleware.
app.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(_indexHtml);
});

app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: config.app.env === 'development' ? 0 : '1d',
  etag: true,
  // Prevent static middleware from serving index.html for directory requests
  index: false,
}));

// SPA fallback — all non-static HTML requests get the version-injected index.
// Express 5 / path-to-regexp v8 requires named splat syntax instead of bare '*'.
app.get('/*splat', (req, res) => {
  if (req.accepts('html')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(_indexHtml);
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
    // Refuse to boot with default admin password in production
    if (process.env.ADMIN_PASSWORD === 'admin' && process.env.ALLOW_DEFAULT_ADMIN !== 'true') {
      log.error('FATAL: ADMIN_PASSWORD is "admin" in production. Set a strong ADMIN_PASSWORD or ALLOW_DEFAULT_ADMIN=true to override.');
      process.exit(1);
    }
    if (!config.session.secureCookie) {
      log.warn('SECURITY: COOKIE_SECURE is false. Set COOKIE_SECURE=true when behind HTTPS.');
    }
  }

  // Warn if audit retention is below recommended minimum
  if (config.retention.auditDays < 90) {
    log.warn(`SECURITY: AUDIT_RETENTION_DAYS is ${config.retention.auditDays} (below recommended 90). Audit logs may be purged too aggressively.`);
  }

  // Log security mode
  if (config.security.isStrict) {
    log.info('SECURITY MODE: strict', {
      sessionTtlHours: config.session.ttl / 3600000,
      secureCookie: config.session.secureCookie,
      tokenInBody: !config.security.disableTokenInBody,
      wsQueryAuth: !config.security.disableWsQueryAuth,
      passwordMaxAgeDays: config.security.passwordMaxAgeDays,
    });
  }

  // Initialize DB (runs migrations)
  const db = getDb();
  log.info('Database initialized');

  // v8.3.0-prep — UPSERT howto markdown content (idempotent, no-op if dir empty)
  try {
    const howtoLoader = require('./services/howto-loader');
    howtoLoader.loadAll(db);
  } catch (err) {
    log.warn('How-to markdown loader failed (continuing)', err.message);
  }

  // Seed admin user
  const authService = require('./services/auth');
  authService.seedAdmin();

  // Initialize security alerting (hook into audit service)
  const securityAlerts = require('./services/securityAlerts');
  const auditService = require('./services/audit');
  securityAlerts.init();
  auditService.onLog((entry) => securityAlerts.evaluate(entry));

  // Detect self container ID
  const dockerService = require('./services/docker');
  await dockerService.detectSelfId();

  // Initialize SSH tunnels for existing hosts (before stats/events)
  await dockerService.initSshTunnels();

  // Attach WebSocket server
  const wsServer = require('./ws');
  wsServer.attach(server);

  // v7.4.0 — Wire the sample-feature broadcaster (contributor demo).
  // Demonstrates the standard "service emits event → ws broadcasts →
  // page subscribes" pattern. Skip when the sample is disabled in env.
  if (process.env.DD_SHOW_SAMPLE_PLUGIN !== 'false') {
    const sampleFeature = require('./services/sample-feature');
    sampleFeature.setWsBroadcaster(
      (type, data, channel) => wsServer.broadcast(type, data, channel)
    );
  }

  // Wire WS broadcaster into services that publish job progress
  const acmeService = require('./services/acme');
  acmeService.setWsBroadcaster(
    (channel, data) => wsServer.broadcast('acme:job:update', data, channel)
  );

  // ACME watcher: transitions stuck 'running' jobs to success/failed so the
  // LE Wizard UI doesn't hang indefinitely.
  const acmeWatcher = require('./services/acme-watcher');
  acmeWatcher.setPublishUpdate((jobId) => {
    try {
      const row = require('./db').getDb().prepare(
        'SELECT id, status, error_class, output, started_at, completed_at FROM acme_jobs WHERE id = ?'
      ).get(jobId);
      if (row) wsServer.broadcast('acme:job:update', row, `acme:job:${jobId}`);
    } catch { /* non-fatal */ }
  });
  acmeWatcher.start();

  // Remediation Wizard — per-job WS progress
  const remediateService = require('./services/remediate');
  remediateService.setWsBroadcaster(
    (channel, data) => wsServer.broadcast('remediate:job:update', data, channel)
  );

  // Remediation Scheduler (v6.9.0): promotes scheduled jobs when their
  // scheduled_at arrives. Wired AFTER remediate so we can inject the runner
  // without a circular require.
  const remediationScheduler = require('./services/remediation-scheduler');
  remediationScheduler.setRunner((jobId) => remediateService.runJob(jobId));
  remediationScheduler.start();

  // v8.9.13-alpha.1 — vSphere metric history poller (feeds the Trends tab).
  // Best-effort, unref'd timer; no-op when no vSphere hosts are registered.
  try { require('./services/vsphere-history').start(); }
  catch (e) { require('./utils/logger')('vsphere-history').debug('poller start skipped', { error: e.message }); }

  // v8.9.24 — Firewall temporary-rule auto-expiry. Every 60s, remove rules whose
  // expires_at has passed (over the same SSH/agent channel). Best-effort, unref'd.
  try {
    const fw = require('./services/firewall');
    const fwTimer = setInterval(() => {
      fw.cleanupExpired().catch(() => {});
    }, 60 * 1000);
    fwTimer.unref();
  } catch (e) { require('./utils/logger')('firewall').debug('expiry job start skipped', { error: e.message }); }

  // v8.9.31 — proactive firewall drift monitor (alerts when app-managed rules go
  // missing on a host). Every 10 min, best-effort, unref'd, de-duplicated.
  try { require('./services/firewall/monitor').start(); }
  catch (e) { require('./utils/logger')('firewall').debug('drift monitor start skipped', { error: e.message }); }

  // v8.11 — Platform (Proxmox) firewall commit-confirmed auto-revert sweep. Every
  // 60s, revert any provisional hypervisor firewall change whose deadline passed
  // without an admin confirming it (self-healing lockout net). Best-effort, unref'd.
  try { require('./services/firewall/platform-write').startSweep(); }
  catch (e) { require('./utils/logger')('firewall').debug('platform auto-revert sweep start skipped', { error: e.message }); }

  // v8.9.37/8.9.40 — Security Posture monitor. Every 15 min: scan, alert on a
  // regression (score drop / new critical) vs the previous snapshot, then store a
  // snapshot for the trend. Best-effort, unref'd. First run 60s after boot.
  try { require('./services/posture/monitor').start(); }
  catch (e) { require('./utils/logger')('posture').debug('posture monitor start skipped', { error: e.message }); }

  // v8.9.42 — Reconciler drift monitor. Every 15 min: plan each active blueprint,
  // alert on drift (or auto-apply if enforce is on). Best-effort, unref'd.
  try { require('./services/reconciler/monitor').start(); }
  catch (e) { require('./utils/logger')('reconciler').debug('reconciler monitor start skipped', { error: e.message }); }

  // Egress Filter block-log ingester (v6.7.0-rc1): tails the sidecar's
  // deny log and inserts new entries into egress_block_log every 30s.
  // Opt-in via DD_EGRESS_BLOCKLOG_INGESTER=1 (off by default for alpha users
  // who don't run the sidecar).
  if (process.env.DD_EGRESS_BLOCKLOG_INGESTER === '1') {
    require('./services/egress-blocklog-ingester').start();
  }

  // Egress Filter boot sync (v6.7.0-rc.2): if Docker Dash restarted while
  // policies existed, the sidecar's on-disk policy.json may be stale. Write
  // it once at startup so the sidecar (if running) picks up via SIGHUP.
  try {
    require('./services/egress-filter').writePolicyFile();
  } catch (e) {
    require('./utils/logger')('egress-filter').debug('boot-time policy sync skipped', { error: e.message });
  }

  // Egress Filter (v6.7.0-alpha.2): after each policy write, SIGHUP the sidecar.
  // The sidecar is opt-in — user runs a container named `dd-egress-filter`. If it's
  // absent, this hook silently succeeds (alpha testing without the sidecar is fine).
  const egressFilter = require('./services/egress-filter');
  const SIDECAR_CONTAINER = process.env.DD_EGRESS_SIDECAR_NAME || 'dd-egress-filter';
  egressFilter.setOnPolicyWritten(async () => {
    try {
      const docker = dockerService.getDocker(0);
      const container = docker.getContainer(SIDECAR_CONTAINER);
      // inspect first so we only signal a running sidecar
      const info = await container.inspect();
      if (info?.State?.Running) {
        await container.kill({ signal: 'SIGHUP' });
      }
    } catch (e) {
      // Sidecar not running or not present — fine for alpha.
      if (!/no such container/i.test(e.message || '')) {
        require('./utils/logger')('egress-filter').debug('sidecar SIGHUP skipped', { error: e.message });
      }
    }
  });

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

async function shutdown(signal) {
  log.info(`${signal} received, shutting down...`);

  const statsService = require('./services/stats');
  statsService.stop();

  const dockerService2 = require('./services/docker');
  dockerService2.stopHealthChecks();

  try { require('./services/ssh-tunnel').closeAll(); } catch {}
  try { require('./services/log-forwarder').stopAll(); } catch {}
  // v8.7.38 — stop the remediation scheduler. start() is called above at
  // line 384; the symmetric stop was missing, so the setInterval kept
  // firing through the rest of shutdown. With the .unref() added in
  // remediation-scheduler.js, the process exits even without this call,
  // but explicit stop avoids a final tick mid-shutdown that could try
  // to write to a closing DB or fire runJob against a tearing-down
  // dockerService.
  try { require('./services/remediation-scheduler').stop(); } catch {}

  const jobs = require('./jobs');
  jobs.stopAll();

  // v7.0.0: release the leader lock in Redis (via Lua DEL-if-owned) and
  // close Redis connections. Without this, a rolling restart in HA mode
  // waits up to 30s (TTL) for another replica to take over instead of
  // handover happening in milliseconds.
  try { await require('./services/cluster').shutdown(); } catch (e) {
    log.warn('Cluster shutdown failed (non-fatal)', { message: e.message });
  }

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
