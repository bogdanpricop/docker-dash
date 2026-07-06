'use strict';

const express = require('express');
const { Router } = require('express');
// favorites / notifications / apiKeys destructured imports moved into the
// extracted sub-router files (misc-favorites.js, misc-notifications.js,
// misc-api-keys.js). Other ../services/misc exports may still be used below.
const auditService = require('../services/audit');
const settingsService = require('../services/settings');
const statsService = require('../services/stats');
const { requireAuth, optionalAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp, formatBytes } = require('../utils/helpers');
const { getDb } = require('../db');
const dockerService = require('../services/docker');
const log = require('../utils/logger')('misc');

const router = Router();

// Version — read from src/version.js (mounted volume, updated without image rebuild)
const _pkgVersion = require('../version');

// ─── Health ─────────────────────────────────────────────────

router.get('/health', (req, res) => {
  try {
    getDb().prepare('SELECT 1').get();
    // v7.0.0: expose cluster role so load balancers can route writes
    // to the leader (sticky-session LBs use this via health-check-conditional
    // routing; e.g. Caddy `health_uri` + `health_headers` matchers).
    const cluster = require('../services/cluster');
    const status = cluster.getStatus();
    res.json({
      status: 'ok',
      version: _pkgVersion,
      timestamp: new Date().toISOString(),
      mode: status.mode,
      role: status.role,
      nodeId: status.nodeId,
    });
  } catch {
    res.status(503).json({ status: 'error', message: 'Database unavailable' });
  }
});

// ─── Cluster Status (v7.0.0) ─────────────────────────────────
//
// Returns the full cluster state snapshot — useful for:
//   - Operator dashboards / Grafana (`docker_dash_cluster_*` gauges below
//     cover the time-series view; this endpoint is the JSON snapshot)
//   - Load-balancer health check scripts that need more than `role`
//   - Failover troubleshooting (heartbeatAgeMs surfaces a stalled leader)

router.get('/cluster/status', optionalAuth, (req, res) => {
  const cluster = require('../services/cluster');
  res.json(cluster.getStatus());
});

// ─── Prometheus Metrics ─────────────────────────────────────

router.get('/metrics', optionalAuth, (req, res) => {
  try {
    const overview = statsService.getOverview();
    const metricsService = require('../services/metrics');

    const lines = [
      '# HELP docker_dash_containers_total Total containers',
      '# TYPE docker_dash_containers_total gauge',
      `docker_dash_containers_total ${overview.containers.length}`,
      '# HELP docker_dash_cpu_total Total CPU usage percent',
      '# TYPE docker_dash_cpu_total gauge',
      `docker_dash_cpu_total ${overview.totals.cpu.toFixed(2)}`,
      '# HELP docker_dash_memory_used_bytes Total memory usage',
      '# TYPE docker_dash_memory_used_bytes gauge',
      `docker_dash_memory_used_bytes ${overview.totals.memory}`,
    ];

    for (const c of overview.containers) {
      const name = c.container_name?.replace(/[^a-zA-Z0-9_]/g, '_') || 'unknown';
      lines.push(`docker_dash_container_cpu{name="${name}"} ${c.cpu_percent}`);
      lines.push(`docker_dash_container_memory_bytes{name="${name}"} ${c.mem_usage}`);
    }

    // v6.15.0: application-level metrics (uptime, HTTP stats, WS gauge, background jobs).
    // Appended to the existing stats-derived container gauges above.
    const appMetrics = metricsService.renderPrometheus();

    // v7.0.0: cluster metrics (standalone: role=0; HA: role=1 leader / 2 reader)
    const cluster = require('../services/cluster');
    const cs = cluster.getStatus();
    const roleCode = cs.role === 'standalone' ? 0 : cs.role === 'leader' ? 1 : cs.role === 'reader' ? 2 : -1;
    const clusterLines = [
      '# HELP docker_dash_cluster_role Cluster role (0=standalone, 1=leader, 2=reader, -1=unknown)',
      '# TYPE docker_dash_cluster_role gauge',
      `docker_dash_cluster_role{mode="${cs.mode}",nodeId="${cs.nodeId}"} ${roleCode}`,
      '# HELP docker_dash_cluster_leader_age_seconds Seconds since this node became leader (0 if not leader)',
      '# TYPE docker_dash_cluster_leader_age_seconds gauge',
      `docker_dash_cluster_leader_age_seconds ${cs.leaderSinceMs != null ? Math.floor(cs.leaderSinceMs / 1000) : 0}`,
      '# HELP docker_dash_cluster_heartbeat_age_seconds Seconds since last successful leader heartbeat / election poll (0 in standalone)',
      '# TYPE docker_dash_cluster_heartbeat_age_seconds gauge',
      `docker_dash_cluster_heartbeat_age_seconds ${cs.heartbeatAgeMs != null ? Math.floor(cs.heartbeatAgeMs / 1000) : 0}`,
      '# HELP docker_dash_cluster_redis_connected Whether the Redis connection is up (1=yes, 0=no, only meaningful when mode=ha)',
      '# TYPE docker_dash_cluster_redis_connected gauge',
      `docker_dash_cluster_redis_connected ${cs.redisConnected === true ? 1 : 0}`,
    ];

    res.type('text/plain').send(lines.join('\n') + '\n' + appMetrics + clusterLines.join('\n') + '\n');
  } catch (err) {
    res.status(500).send('# Error generating metrics\n');
  }
});

// ─── Resource Footprint (self-reporting) ────────────────────

router.get('/footprint', requireAuth, (req, res) => {
  const mem = process.memoryUsage();
  const uptime = process.uptime();
  const db = getDb();
  let dbSize = 0;
  try {
    const stat = db.pragma('page_count')[0].page_count * db.pragma('page_size')[0].page_size;
    dbSize = stat;
  } catch (err) { /* non-critical, db size is optional */ }

  res.json({
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
    },
    uptime: Math.floor(uptime),
    pid: process.pid,
    nodeVersion: process.version,
    dbSizeBytes: dbSize,
    cpuUsage: process.cpuUsage(),
  });
});

// ─── Favorites ──────────────────────────────────────────────





router.post('/backup/database', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const db = getDb();
    const path = require('path');
    const fs = require('fs');
    const backupDir = process.env.DATA_DIR || '/data';
    const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const backupPath = path.join(backupDir, `backup-${ts}.db`);

    // Use better-sqlite3's backup API (safe, non-blocking for WAL mode)
    db.backup(backupPath).then(() => {
      const stat = fs.statSync(backupPath);
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'database_backup', details: JSON.stringify({ path: backupPath, size: stat.size }),
        ip: getClientIp(req),
      });
      res.json({ ok: true, path: backupPath, size: stat.size, timestamp: ts });
    }).catch(err => {
      log.error('database backup', err);
      res.status(500).json({ error: 'Backup failed' });
    });
  } catch (err) {
    log.error('database backup', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Database Restore ──────────────────────────────────────

const SQLITE_MAGIC = 'SQLite format 3\0';

router.post('/backup/restore', express.json({ limit: '750mb' }), requireAuth, requireRole('admin'), (req, res) => {
  try {
    const crypto = require('crypto');
    const { content } = req.body || {};

    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Database file content (base64) is required' });
    }

    // Decode base64
    const fileBuffer = Buffer.from(content, 'base64');

    // FIX #5 — enforce 500MB hard limit (before any further validation)
    if (fileBuffer.length > 500 * 1024 * 1024) {
      return res.status(413).json({ error: 'Database file too large (max 500MB)' });
    }

    // FIX #5 — SHA-256 checksum validation
    const expectedSha256 = req.headers['x-backup-sha256'];
    const allowUnchecked = process.env.ALLOW_UNCHECKED_DB_RESTORE === 'true';
    const computedSha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    if (!allowUnchecked) {
      if (!expectedSha256) {
        return res.status(400).json({
          error: 'X-Backup-Sha256 header required (64 hex chars). Compute locally: sha256sum <file>. ' +
                 'Set ALLOW_UNCHECKED_DB_RESTORE=true to skip (not recommended).',
        });
      }
      if (!/^[0-9a-f]{64}$/i.test(expectedSha256)) {
        return res.status(400).json({ error: 'X-Backup-Sha256 must be a 64-character hex string' });
      }
      if (expectedSha256.toLowerCase() !== computedSha256) {
        return res.status(400).json({
          error: `SHA-256 mismatch: expected ${expectedSha256.toLowerCase()}, got ${computedSha256}`,
          code: 'CHECKSUM_MISMATCH',
        });
      }
    } else {
      log.warn('ALLOW_UNCHECKED_DB_RESTORE=true — skipping SHA-256 verification for restore', {
        computedSha256, sizeBytes: fileBuffer.length, userId: req.user.id,
      });
    }

    // Validate minimum size (SQLite header is 100 bytes)
    if (fileBuffer.length < 100) {
      return res.status(400).json({ error: 'File is too small to be a valid SQLite database' });
    }

    // Validate SQLite magic bytes (first 16 bytes = "SQLite format 3\0")
    const header = fileBuffer.slice(0, 16).toString('ascii');
    if (header !== SQLITE_MAGIC) {
      return res.status(400).json({ error: 'Invalid file: not a SQLite database (magic bytes mismatch)' });
    }

    const path = require('path');
    const fs = require('fs');
    const dbPath = process.env.DB_PATH || path.join(process.env.DATA_DIR || '/data', 'docker-dash.db');
    const backupDir = process.env.DATA_DIR || '/data';

    // Create a safety backup of current DB before replacing
    const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const safetyBackupPath = path.join(backupDir, `pre-restore-${ts}.db`);

    const db = getDb();

    // FIX #5 — Audit log BEFORE writing
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'db_restore_initiated',
      details: JSON.stringify({ sizeBytes: fileBuffer.length, sha256: computedSha256, safetyBackup: safetyBackupPath }),
      ip: getClientIp(req),
    });

    // Safety backup, then replace
    db.backup(safetyBackupPath).then(() => {
      // Close the current database
      try { db.close(); } catch (_e) { /* may already be closed */ }

      // Write the uploaded database
      fs.writeFileSync(dbPath, fileBuffer);

      // FIX #5 — Audit log AFTER writing (before process exit)
      try {
        auditService.log({
          userId: req.user.id, username: req.user.username,
          action: 'db_restore_completed',
          details: JSON.stringify({ sizeBytes: fileBuffer.length, sha256: computedSha256, safetyBackup: safetyBackupPath }),
          ip: getClientIp(req),
        });
      } catch (_e) { /* best-effort, db may be closed */ }

      // Respond before restart so the client gets confirmation
      res.json({
        ok: true,
        message: 'Database restored successfully. The application will restart.',
        safetyBackup: safetyBackupPath,
        restoredSize: fileBuffer.length,
        sha256: computedSha256,
      });

      // Graceful restart after a short delay
      setTimeout(() => {
        process.exit(0); // Docker/systemd will restart the process
      }, 1000);
    }).catch(err => {
      log.error('Failed to create safety backup before restore', err);
      res.status(500).json({ error: 'Failed to create safety backup' });
    });
  } catch (err) {
    log.error('Database restore error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Global Search ──────────────────────────────────────────

router.get('/search', requireAuth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ results: [], query: q });

    const query = q.toLowerCase();
    // dockerService imported at top
    const hostId = req.query.hostId ? parseInt(req.query.hostId) : 0;
    const results = [];

    // Search containers
    try {
      const containers = await dockerService.listContainers(hostId);
      for (const c of containers) {
        if (c.name?.toLowerCase().includes(query) || c.image?.toLowerCase().includes(query)) {
          results.push({
            type: 'container', id: c.id, name: c.name,
            detail: `${c.image} (${c.state})`,
            url: `#/containers/${c.id}`, icon: 'fas fa-cube',
          });
        }
      }
    } catch (err) { /* search section failed, skip */ }

    // Search images
    try {
      const images = await dockerService.listImages(hostId);
      for (const img of images) {
        const tags = img.RepoTags || img.repoTags || [];
        for (const tag of tags) {
          if (tag.toLowerCase().includes(query)) {
            results.push({
              type: 'image', id: (img.Id || img.id || '').substring(7, 19),
              name: tag, detail: `Size: ${formatBytes(img.Size || img.size)}`,
              url: `#/images`, icon: 'fas fa-layer-group',
            });
            break;
          }
        }
      }
    } catch (err) { /* search section failed, skip */ }

    // Search volumes
    try {
      const docker = dockerService.getDocker(hostId);
      const volData = await docker.listVolumes();
      for (const vol of (volData.Volumes || [])) {
        if (vol.Name.toLowerCase().includes(query)) {
          results.push({
            type: 'volume', id: vol.Name, name: vol.Name,
            detail: vol.Driver || 'local',
            url: `#/volumes`, icon: 'fas fa-database',
          });
        }
      }
    } catch (err) { /* search section failed, skip */ }

    // Search networks
    try {
      const docker = dockerService.getDocker(hostId);
      const networks = await docker.listNetworks();
      for (const net of networks) {
        if (net.Name?.toLowerCase().includes(query)) {
          results.push({
            type: 'network', id: net.Id?.substring(0, 12), name: net.Name,
            detail: `${net.Driver} — ${Object.keys(net.Containers || {}).length} containers`,
            url: `#/networks`, icon: 'fas fa-network-wired',
          });
        }
      }
    } catch (err) { /* search section failed, skip */ }

    // Search Git stacks
    try {
      const db = getDb();
      const stacks = db.prepare(
        "SELECT id, stack_name, repo_url, branch, status FROM git_stacks WHERE stack_name LIKE ? OR repo_url LIKE ? LIMIT 10"
      ).all(`%${query}%`, `%${query}%`);
      for (const s of stacks) {
        results.push({
          type: 'git-stack', id: s.id, name: s.stack_name,
          detail: `${s.repo_url} (${s.status})`,
          url: `#/git-stacks/${s.id}`, icon: 'fab fa-git-alt',
        });
      }
    } catch (err) { /* search section failed, skip */ }

    // Search audit log
    try {
      const db = getDb();
      const audits = db.prepare(
        "SELECT id, username, action, target_id, created_at FROM audit_log WHERE action LIKE ? OR target_id LIKE ? OR username LIKE ? ORDER BY created_at DESC LIMIT 5"
      ).all(`%${query}%`, `%${query}%`, `%${query}%`);
      for (const a of audits) {
        results.push({
          type: 'audit', id: a.id, name: `${a.username}: ${a.action}`,
          detail: `${a.target_id || ''} — ${a.created_at}`,
          url: `#/system`, icon: 'fas fa-clipboard-list',
        });
      }
    } catch (err) { /* search section failed, skip */ }

    res.json({ results: results.slice(0, 30), query: q, total: results.length });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Cluster Health Score ────────────────────────────────────

router.get('/cluster-health', requireAuth, async (req, res) => {
  try {
    const hostId = req.query.hostId ? parseInt(req.query.hostId) : 0;
    const containers = await dockerService.listContainers(hostId).catch(() => []);
    const overview = statsService.getOverview(hostId);

    const total = containers.length;
    const running = containers.filter(c => c.state === 'running').length;
    const unhealthy = containers.filter(c => /unhealthy/i.test(c.status || '')).length;
    const restarting = containers.filter(c => /restarting/i.test(c.state || c.status || '')).length;
    const exited = containers.filter(c => c.state === 'exited').length;

    const cpuTotal = overview?.totals?.cpu || 0;
    const memUsed = overview?.totals?.memory || 0;
    const memLimit = overview?.totals?.memoryLimit || 1;
    const memPct = memLimit > 0 ? (memUsed / memLimit) * 100 : 0;

    // Scoring (100 = perfect)
    let score = 100;

    // Container health (max -40 points)
    if (total > 0) {
      const runRatio = running / total;
      score -= Math.round((1 - runRatio) * 25); // -25 if all stopped
    }
    score -= unhealthy * 5;  // -5 per unhealthy container
    score -= restarting * 3; // -3 per restarting container

    // Resource pressure (max -30 points)
    if (cpuTotal > 80) score -= Math.round((cpuTotal - 80) * 0.5);
    if (memPct > 80) score -= Math.round((memPct - 80) * 0.5);

    // Stopped containers penalty (max -10 points)
    if (total > 0) score -= Math.min(10, Math.round((exited / total) * 10));

    score = Math.max(0, Math.min(100, score));
    const status = score >= 80 ? 'healthy' : score >= 50 ? 'degraded' : 'critical';

    res.json({
      score,
      status,
      breakdown: {
        containersRunning: running,
        containersTotal: total,
        unhealthy,
        restarting,
        exited,
        cpuUsage: Math.round(cpuTotal * 10) / 10,
        memoryUsage: Math.round(memPct * 10) / 10,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── System Overview (complete infrastructure snapshot) ──────

router.get('/overview', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const hostId = req.query.hostId ? parseInt(req.query.hostId) : 0;

    let containers = [];
    try { containers = await dockerService.listContainers(hostId); } catch (err) { /* host may be unreachable */ }
    const running = containers.filter(c => c.state === 'running').length;

    const overview = statsService.getOverview(hostId);

    let gitStacks = 0, activeAlerts = 0, channels = 0, workflows = 0, recentDeploys = 0;
    try { gitStacks = db.prepare('SELECT COUNT(*) AS cnt FROM git_stacks').get()?.cnt || 0; } catch (err) { /* table may not exist */ }
    try { activeAlerts = db.prepare("SELECT COUNT(*) AS cnt FROM alert_events WHERE resolved_at IS NULL").get()?.cnt || 0; } catch (err) { /* table may not exist */ }
    try { channels = db.prepare('SELECT COUNT(*) AS cnt FROM notification_channels WHERE is_active = 1').get()?.cnt || 0; } catch (err) { /* table may not exist */ }
    try { workflows = db.prepare('SELECT COUNT(*) AS cnt FROM workflow_rules WHERE is_active = 1').get()?.cnt || 0; } catch (err) { /* table may not exist */ }
    try { recentDeploys = db.prepare("SELECT COUNT(*) AS cnt FROM git_deployments WHERE started_at > datetime('now', '-1 day')").get()?.cnt || 0; } catch (err) { /* table may not exist */ }

    const mem = process.memoryUsage();

    res.json({
      timestamp: new Date().toISOString(),
      version: _pkgVersion,
      status: activeAlerts > 0 ? 'warning' : running === 0 && containers.length > 0 ? 'critical' : 'healthy',
      containers: { total: containers.length, running, stopped: containers.length - running },
      resources: { totalCpu: Math.round(overview.totals.cpu * 10) / 10, totalMemory: overview.totals.memory, totalMemoryHuman: formatBytes(overview.totals.memory) },
      operations: { activeAlerts, gitStacks, recentDeploys24h: recentDeploys, notificationChannels: channels, workflowRules: workflows },
      dockerDash: { memoryRss: mem.rss, memoryHuman: formatBytes(mem.rss), uptime: Math.floor(process.uptime()), nodeVersion: process.version },
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── API Documentation ──────────────────────────────────────

router.get('/docs', (req, res) => {
  res.json({
    name: 'Docker Dash API',
    version: _pkgVersion,
    description: 'Lightweight Docker management dashboard REST API',
    endpoints: [
      { method: 'GET', path: '/api/health', auth: false, description: 'Health check with DB verification' },
      { method: 'GET', path: '/api/metrics', auth: false, description: 'Prometheus metrics export' },
      { method: 'GET', path: '/api/compare', auth: false, description: 'Feature comparison matrix (75+ features)' },
      { method: 'GET', path: '/api/docs', auth: false, description: 'This API documentation' },
      { group: 'Auth', endpoints: [
        { method: 'POST', path: '/api/auth/login', description: 'Login with username + password' },
        { method: 'GET', path: '/api/auth/me', description: 'Current user info' },
        { method: 'POST', path: '/api/auth/logout', description: 'Invalidate session' },
        { method: 'POST', path: '/api/auth/change-password', description: 'Change own password' },
      ]},
      { group: 'Containers', endpoints: [
        { method: 'GET', path: '/api/containers', description: 'List all containers' },
        { method: 'GET', path: '/api/containers/:id/inspect', description: 'Inspect container' },
        { method: 'GET', path: '/api/containers/:id/logs', description: 'Container logs (search, regex, level filter)' },
        { method: 'POST', path: '/api/containers/:id/:action', description: 'Action: start/stop/restart/pause/kill' },
        { method: 'POST', path: '/api/containers/:id/update', description: 'Pull + recreate container' },
        { method: 'POST', path: '/api/containers/:id/safe-update', description: 'Safe-pull: scan before swap' },
        { method: 'GET', path: '/api/containers/:id/deploy-preview', description: 'Check for image updates' },
        { method: 'GET', path: '/api/containers/:id/diagnose', description: 'Troubleshooting wizard (8 steps)' },
        { method: 'POST', path: '/api/containers/:id/smart-restart', description: 'Restart with backoff' },
      ]},
      { group: 'Images', endpoints: [
        { method: 'GET', path: '/api/images', description: 'List images' },
        { method: 'GET', path: '/api/images/:id/scan', description: 'Vulnerability scan (Trivy/Scout)' },
        { method: 'GET', path: '/api/images/freshness', description: 'Image freshness dashboard' },
      ]},
      { group: 'Git Stacks', endpoints: [
        { method: 'GET', path: '/api/git/stacks', description: 'List Git-linked stacks' },
        { method: 'POST', path: '/api/git/stacks', description: 'Deploy from Git repo' },
        { method: 'POST', path: '/api/git/stacks/:id/deploy', description: 'Pull & redeploy' },
        { method: 'GET', path: '/api/git/stacks/:id/diff', description: 'Diff view (what changed)' },
        { method: 'POST', path: '/api/git/stacks/:id/rollback/:deploymentId', description: 'Rollback deployment' },
        { method: 'POST', path: '/api/git/stacks/:id/push', description: 'Push compose changes to Git' },
        { method: 'POST', path: '/api/git/webhook/:token', auth: false, description: 'Webhook receiver (GitHub/GitLab/Gitea/Bitbucket)' },
      ]},
      { group: 'Notifications', endpoints: [
        { method: 'GET', path: '/api/notifications', description: 'List notifications (paginated, filterable by type/read status)' },
        { method: 'GET', path: '/api/notifications/count', description: 'Unread notification count' },
        { method: 'POST', path: '/api/notifications/:id/read', description: 'Mark notification as read' },
        { method: 'POST', path: '/api/notifications/read-all', description: 'Mark all notifications as read' },
        { method: 'DELETE', path: '/api/notifications/:id', description: 'Delete a notification' },
        { method: 'POST', path: '/api/notifications/bulk', description: 'Bulk mark read or delete notifications' },
      ]},
      { group: 'Container Groups', endpoints: [
        { method: 'GET', path: '/api/groups', description: 'List container groups with member counts' },
        { method: 'GET', path: '/api/groups/:id', description: 'Get group with member container IDs' },
        { method: 'POST', path: '/api/groups', description: 'Create a new container group' },
        { method: 'PUT', path: '/api/groups/:id', description: 'Update group (name, color, icon)' },
        { method: 'DELETE', path: '/api/groups/:id', description: 'Delete a container group' },
        { method: 'POST', path: '/api/groups/:id/containers', description: 'Add containers to group' },
        { method: 'DELETE', path: '/api/groups/:id/containers/:containerId', description: 'Remove container from group' },
        { method: 'PUT', path: '/api/groups/order', description: 'Reorder groups' },
      ]},
      { group: 'Dashboard', endpoints: [
        { method: 'GET', path: '/api/dashboard/preferences', description: 'Get dashboard widget order and hidden widgets' },
        { method: 'PUT', path: '/api/dashboard/preferences', description: 'Save dashboard widget order and hidden widgets' },
      ]},
      { group: 'Stats & Monitoring', endpoints: [
        { method: 'GET', path: '/api/stats/overview', description: 'Real-time stats overview' },
        { method: 'GET', path: '/api/stats/uptime', description: 'Container uptime reports' },
        { method: 'GET', path: '/api/stats/trends/:id', description: 'Resource trends + 24h forecast' },
        { method: 'GET', path: '/api/stats/cost', description: 'Per-container cost estimation' },
        { method: 'GET', path: '/api/stats/recommendations', description: 'Resource recommendations' },
      ]},
      { group: 'Operations', endpoints: [
        { method: 'GET', path: '/api/notification-channels', description: 'List notification channels' },
        { method: 'GET', path: '/api/workflows', description: 'List workflow automation rules' },
        { method: 'GET', path: '/api/maintenance', description: 'List maintenance windows' },
        { method: 'GET', path: '/api/templates', description: 'App template marketplace (20 templates)' },
        { method: 'POST', path: '/api/migrate/container', description: 'Cross-host migration (zero-downtime)' },
        { method: 'GET', path: '/api/bundles/export/stack/:name', description: 'Export stack as bundle' },
        { method: 'POST', path: '/api/bundles/import', description: 'Import stack bundle' },
      ]},
      { group: 'Admin', endpoints: [
        { method: 'GET', path: '/api/search', description: 'Global search (containers, images, stacks, audit)' },
        { method: 'GET', path: '/api/dependencies', description: 'Container dependency graph' },
        { method: 'GET', path: '/api/audit', description: 'Audit log (paginated)' },
        { method: 'GET', path: '/api/audit/analytics', description: 'Audit analytics (top users, actions)' },
        { method: 'GET', path: '/api/footprint', description: 'Docker Dash resource footprint' },
        { method: 'POST', path: '/api/backup/database', description: 'Create database backup' },
        { method: 'POST', path: '/api/backup/restore', description: 'Restore database from uploaded SQLite file' },
        { method: 'GET', path: '/api/status-page/public', auth: false, description: 'Public status page' },
        { method: 'GET', path: '/api/watchtower', description: 'Detect Watchtower containers' },
      ]},
    ],
  });
});

// ─── Dashboard Preferences ──────────────────────────────────

router.get('/dashboard/preferences', requireAuth, (req, res) => {
  const db = getDb();
  const prefs = db.prepare('SELECT * FROM dashboard_preferences WHERE user_id = ?').get(req.user.id);
  if (!prefs) {
    return res.json({
      widget_order: ['containers', 'cpu', 'memory', 'events'],
      hidden_widgets: [],
    });
  }
  res.json({
    widget_order: JSON.parse(prefs.widget_order),
    hidden_widgets: JSON.parse(prefs.hidden_widgets),
  });
});

router.put('/dashboard/preferences', requireAuth, (req, res) => {
  const db = getDb();
  const { widget_order, hidden_widgets } = req.body;
  db.prepare(`
    INSERT INTO dashboard_preferences (user_id, widget_order, hidden_widgets, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET widget_order = ?, hidden_widgets = ?, updated_at = datetime('now')
  `).run(
    req.user.id,
    JSON.stringify(widget_order || []),
    JSON.stringify(hidden_widgets || []),
    JSON.stringify(widget_order || []),
    JSON.stringify(hidden_widgets || [])
  );
  res.json({ ok: true });
});

// ─── Container Dependency Graph ─────────────────────────────

router.get('/dependencies', requireAuth, async (req, res) => {
  try {
    // dockerService imported at top
    const hostId = req.query.hostId ? parseInt(req.query.hostId) : 0;
    const docker = dockerService.getDocker(hostId);

    const containers = await docker.listContainers({ all: true });
    const networks = await docker.listNetworks();

    const nodes = [];
    const edges = [];
    const networkMap = {};

    // Build network membership map
    for (const net of networks) {
      if (['bridge', 'host', 'none'].includes(net.Name)) continue;
      const members = Object.entries(net.Containers || {}).map(([id, info]) => ({
        id: id.substring(0, 12),
        name: info.Name,
        ipv4: info.IPv4Address?.split('/')[0],
      }));
      networkMap[net.Name] = members;
    }

    // Build nodes
    for (const c of containers) {
      const name = c.Names?.[0]?.replace(/^\//, '') || '';
      const stack = c.Labels?.['com.docker.compose.project'];
      const service = c.Labels?.['com.docker.compose.service'];

      // We can't read env from list, but we can infer from links and networks

      nodes.push({
        id: c.Id.substring(0, 12),
        name,
        image: c.Image,
        state: c.State,
        stack,
        service,
        networks: Object.keys(c.NetworkSettings?.Networks || {}),
        ports: (c.Ports || []).filter(p => p.PublicPort).map(p => `${p.PublicPort}→${p.PrivatePort}`),
      });
    }

    // Build edges: containers on same network can communicate
    for (const [netName, members] of Object.entries(networkMap)) {
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          edges.push({
            source: members[i].id,
            target: members[j].id,
            network: netName,
            type: 'network',
          });
        }
      }
    }

    // Detect depends_on from compose labels (same stack = likely dependent)
    const stacks = {};
    for (const node of nodes) {
      if (node.stack) {
        if (!stacks[node.stack]) stacks[node.stack] = [];
        stacks[node.stack].push(node);
      }
    }

    // Detect link patterns: if container A has env like DB_HOST=containerB
    // This is heuristic — we can improve with inspect, but list is faster

    res.json({
      nodes,
      edges,
      stacks: Object.entries(stacks).map(([name, members]) => ({
        name,
        containers: members.map(m => m.id),
      })),
      networks: Object.entries(networkMap).map(([name, members]) => ({
        name,
        members: members.length,
      })),
      summary: {
        totalContainers: nodes.length,
        totalEdges: edges.length,
        totalStacks: Object.keys(stacks).length,
        totalNetworks: Object.keys(networkMap).length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Comparison Data (for marketing/about pages) ────────────

router.get('/compare', (req, res) => {
  // Public endpoint — no auth required (for embedding in docs/README)
  const features = [
    { feature: 'Container CRUD',                    dockerDash: true,              portainerCE: true,             portainerBE: true,          coolify: true,          yacht: true,       rancher: true,         dockge: 'compose only', dockhand: true },
    { feature: 'Image Management',                  dockerDash: true,              portainerCE: true,             portainerBE: true,          coolify: true,          yacht: true,       rancher: true,         dockge: false,          dockhand: true },
    { feature: 'Volume Management',                 dockerDash: true,              portainerCE: true,             portainerBE: true,          coolify: true,          yacht: true,       rancher: true,         dockge: false,          dockhand: true },
    { feature: 'Network Management',                dockerDash: true,              portainerCE: true,             portainerBE: true,          coolify: 'basic',       yacht: 'basic',    rancher: true,         dockge: false,          dockhand: true },
    { feature: 'Network Topology',                  dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Real-time Stats',                   dockerDash: true,              portainerCE: true,             portainerBE: true,          coolify: true,          yacht: 'basic',    rancher: true,         dockge: 'basic',        dockhand: true },
    { feature: 'Terminal (xterm.js)',               dockerDash: true,              portainerCE: true,             portainerBE: true,          coolify: true,          yacht: false,      rancher: true,         dockge: true,           dockhand: true },
    { feature: 'Vulnerability Scanning',            dockerDash: 'Trivy + Scout',   portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: 'NeuVector',  dockge: false,          dockhand: 'Grype + Trivy' },
    { feature: 'Safe-Pull Updates',                 dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: true },
    { feature: 'Multi-Host (agentless)',             dockerDash: true,              portainerCE: 'agent required', portainerBE: 'agent req.',  coolify: 'agent',       yacht: false,      rancher: true,         dockge: 'agent',        dockhand: true },
    { feature: 'Git Integration',                   dockerDash: true,              portainerCE: 'BE only',        portainerBE: true,          coolify: true,          yacht: false,      rancher: 'Fleet',      dockge: false,          dockhand: false },
    { feature: 'Webhooks + Polling',                dockerDash: true,              portainerCE: 'BE only',        portainerBE: true,          coolify: true,          yacht: false,      rancher: true,         dockge: false,          dockhand: false },
    { feature: 'Deployment Rollback',               dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: true,          yacht: false,      rancher: true,         dockge: false,          dockhand: false },
    { feature: 'Audit Log',                         dockerDash: true,              portainerCE: 'BE only',        portainerBE: true,          coolify: 'basic',       yacht: false,      rancher: true,         dockge: false,          dockhand: false },
    { feature: 'Alerts',                            dockerDash: '7 channels',      portainerCE: 'BE only',        portainerBE: true,          coolify: true,          yacht: false,      rancher: true,         dockge: false,          dockhand: false },
    { feature: 'SSO (OAuth / LDAP)',                dockerDash: true,              portainerCE: 'BE only',        portainerBE: true,          coolify: true,          yacht: false,      rancher: true,         dockge: false,          dockhand: false },
    { feature: 'Health Score',                      dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Resource Forecasting',              dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: 'basic',      dockge: false,          dockhand: false },
    { feature: 'Cost Estimation',                   dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: 'basic',      dockge: false,          dockhand: false },
    { feature: 'App Templates',                     dockerDash: '33 + custom',     portainerCE: '500+ community', portainerBE: '500+',        coolify: 'many',        yacht: 'basic',    rancher: 'Helm charts', dockge: false,         dockhand: false },
    { feature: 'Troubleshooting Wizard',            dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Public Status Page',                dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: true,          yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Maintenance Windows',               dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Workflow Automation (IF-THEN)',      dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Cross-Host Migration',              dockerDash: 'zero-downtime',   portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: true,         dockge: false,          dockhand: false },
    { feature: 'Stack Export/Import',               dockerDash: true,              portainerCE: false,            portainerBE: true,          coolify: 'partial',     yacht: false,      rancher: true,         dockge: false,          dockhand: false },
    { feature: 'Event-Driven Notifications',        dockerDash: true,              portainerCE: false,            portainerBE: true,          coolify: true,          yacht: false,      rancher: true,         dockge: false,          dockhand: false },
    { feature: 'Global Search',                     dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: true,         dockge: false,          dockhand: false },
    { feature: 'Container Dependency Graph',        dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Uptime Reports',                    dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Image Freshness Score',             dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Audit Log Analytics',               dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: 'basic',      dockge: false,          dockhand: false },
    { feature: 'AI Log Analysis Prompts',           dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'docker run \u2192 Compose Converter', dockerDash: true,            portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: true,           dockhand: false },
    { feature: 'Reverse Proxy Label Generator',     dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Resource Recommendations',          dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Smart Restart (backoff)',            dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Deploy Preview',                    dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Push to Git',                       dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Database Backup API',               dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Watchtower Detection',              dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Prometheus Metrics',                dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: true,         dockge: false,          dockhand: false },
    { feature: 'Welcome Onboarding',                dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: true,          yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Error Boundary (crash recovery)',   dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Insights Dashboard',               dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: 'basic',      dockge: false,          dockhand: false },
    { feature: 'Docker Swarm Mode',                 dockerDash: true,              portainerCE: true,             portainerBE: true,          coolify: false,         yacht: false,      rancher: 'K8s focus',  dockge: false,          dockhand: false },
    { feature: 'CIS Docker Benchmark',              dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: 'partial',    dockge: false,          dockhand: false },
    { feature: 'LDAP / AD Sync',                    dockerDash: true,              portainerCE: 'BE only',        portainerBE: true,          coolify: false,         yacht: false,      rancher: true,         dockge: false,          dockhand: false },
    { feature: 'Container Rename',                  dockerDash: true,              portainerCE: true,             portainerBE: true,          coolify: false,         yacht: true,       rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Keyboard Shortcuts (vim-style)',    dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Admin Password Reset (no email)',   dockerDash: true,              portainerCE: true,             portainerBE: true,          coolify: true,          yacht: true,       rancher: true,         dockge: false,          dockhand: false },
    { feature: 'Daily Auto-Backup',                 dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: true,          yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Audit CSV Export',                  dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: 'basic',      dockge: false,          dockhand: false },
    { feature: 'API Documentation Endpoint',        dockerDash: true,              portainerCE: false,            portainerBE: true,          coolify: true,          yacht: false,      rancher: true,         dockge: false,          dockhand: false },
    { feature: 'i18n',                              dockerDash: '11 languages',    portainerCE: 'partial',        portainerBE: 'partial',     coolify: 'partial',     yacht: false,      rancher: true,         dockge: false,          dockhand: false },
    { feature: 'Command Palette',                   dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Mobile Responsive',                 dockerDash: true,              portainerCE: true,             portainerBE: true,          coolify: true,          yacht: true,       rancher: 'partial',    dockge: true,           dockhand: true },
    { feature: 'Test Suite',                        dockerDash: '384 tests',       portainerCE: true,             portainerBE: true,          coolify: true,          yacht: false,      rancher: true,         dockge: false,          dockhand: false },
    { feature: 'CI/CD Pipeline',                    dockerDash: 'GitHub Actions',  portainerCE: true,             portainerBE: true,          coolify: true,          yacht: false,      rancher: true,         dockge: false,          dockhand: false },
    { feature: 'Build Step',                        dockerDash: 'none',            portainerCE: 'Angular',        portainerBE: 'Angular',     coolify: 'required',    yacht: 'none',     rancher: 'none',       dockge: 'required',     dockhand: 'required' },
    { feature: 'Container Size',                    dockerDash: '~80MB',           portainerCE: '~250MB',         portainerBE: '~250MB',      coolify: '~200MB',      yacht: '~100MB',   rancher: '~500MB+',    dockge: '~100MB',       dockhand: '~80MB' },
    { feature: 'RAM Usage',                         dockerDash: '~50MB',           portainerCE: '~200MB',         portainerBE: '~200MB',      coolify: '~150MB',      yacht: '~50MB',    rancher: '~500MB+',    dockge: '~50MB',        dockhand: '~60MB' },
    { feature: 'License',                           dockerDash: 'MIT',             portainerCE: 'Zlib',           portainerBE: 'commercial',  coolify: 'Apache 2.0',  yacht: 'MIT',      rancher: 'Apache 2.0', dockge: 'MIT',          dockhand: 'BSL 1.1' },
    // v5.4.0+ features
    { feature: 'One-Click Port Access',              dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Live CPU/RAM Sparklines',            dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Log Time Filter (since)',            dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Dual AI Provider (OpenAI + Ollama)', dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Image Layer Visualization',          dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Generate Compose from GitHub',       dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Sandbox Mode (ephemeral/persistent)',dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Sandbox Project Source (GitHub)',     dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'CIS Hardened Container Creation',    dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Image Picker (20 popular images)',   dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Multi-Host Overview (ESXi-style)',   dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: 'basic',      dockge: false,          dockhand: false },
    { feature: 'Enterprise UI Mode (switchable)',    dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Right-Click Context Menus',          dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Bottom Task Bar',                    dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Column Configuration',               dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'View Density (3 levels)',             dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Centralized Log Explorer',           dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: 'basic',      dockge: false,          dockhand: false },
    { feature: 'Cluster Health Score Gauge',         dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Chart Export (PNG/CSV)',              dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Session Management',                 dockerDash: true,              portainerCE: true,             portainerBE: true,          coolify: false,         yacht: false,      rancher: true,         dockge: false,          dockhand: false },
    { feature: 'Support Bundle / Diagnostics',       dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: true,         dockge: false,          dockhand: false },
    { feature: 'Type-to-Confirm (destructive ops)',  dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Saved Filter Presets',               dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Inline Edit (metadata)',             dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Maintenance Mode / Node Drain',      dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: true,         dockge: false,          dockhand: false },
    { feature: 'Certificate Management UI',          dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: true,         dockge: false,          dockhand: false },
    { feature: 'Stack Creation Wizard',              dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'DataTable Pagination (Enterprise)',   dockerDash: true,              portainerCE: true,             portainerBE: true,          coolify: false,         yacht: false,      rancher: true,         dockge: false,          dockhand: false },
    { feature: 'Master/Detail Split View',           dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Event Timeline',                     dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: 'basic',      dockge: false,          dockhand: false },
    { feature: 'Container Migration Wizard',         dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: true,         dockge: false,          dockhand: false },
    { feature: 'Workload Balancing Recommendations', dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: 'basic',      dockge: false,          dockhand: false },
    { feature: 'Container Comparison Charts',        dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Theme Customizer (accent colors)',   dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'S3 Backup Export',                   dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: true,          yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Cost Allocation by Team',            dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Docker Version Checker',             dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: true,         dockge: false,          dockhand: false },
    { feature: 'Login Banner (MOTD)',                dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Clone/Duplicate Stack',              dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'How-To Knowledge Base (46 guides)',  dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: 'Custom Attributes (key-value)',      dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: true,         dockge: false,          dockhand: false },
    { feature: 'Smart Container Icons (canvas)',     dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
    { feature: '20 Developer Tools',                 dockerDash: true,              portainerCE: false,            portainerBE: false,         coolify: false,         yacht: false,      rancher: false,        dockge: false,          dockhand: false },
  ];

  const summary = {
    dockerDash: { exclusive: features.filter(f => f.dockerDash === true && !f.portainerCE && !f.portainerBE && !f.dockge && !f.dockhand && !f.coolify && !f.yacht && !f.rancher).length },
    version: _pkgVersion,
  };

  res.json({ features, summary });
});

// ─── Watchtower Detection ───────────────────────────────────

router.get('/watchtower', requireAuth, async (req, res) => {
  try {
    // dockerService imported at top
    const containers = await dockerService.listContainers(req.query.hostId || 0);
    const watchtower = containers.filter(c => {
      const image = (c.Image || c.image || '').toLowerCase();
      const name = ((c.Names || c.names || [])[0] || '').toLowerCase();
      const labels = c.Labels || c.labels || {};
      return image.includes('watchtower') || name.includes('watchtower')
        || labels['com.centurylinklabs.watchtower'] !== undefined;
    });

    if (watchtower.length === 0) {
      return res.json({ detected: false });
    }

    const wt = watchtower[0];
    const name = ((wt.Names || wt.names || [])[0] || '').replace(/^\//, '');
    const state = wt.State || wt.state;

    // Count containers Watchtower is monitoring
    const monitoredCount = containers.filter(c => {
      const labels = c.Labels || c.labels || {};
      return labels['com.centurylinklabs.watchtower.enable'] !== 'false';
    }).length;

    res.json({
      detected: true,
      container: { name, state, image: wt.Image || wt.image },
      monitored_count: monitoredCount,
      advisory: 'Docker Dash now offers native safe-pull updates with vulnerability scanning. Consider migrating from Watchtower for more control.',
      migration_steps: [
        'Docker Dash safe-update scans for vulnerabilities before swapping images (Watchtower does not)',
        'Use maintenance windows for scheduled updates with scan-before-deploy',
        'Set up notification channels (Discord/Slack/Telegram) for update alerts',
        'Once migrated, stop Watchtower: docker stop ' + name,
      ],
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Settings ───────────────────────────────────────────────

router.get('/settings', requireAuth, requireRole('admin'), (req, res) => {
  res.json(settingsService.getAll());
});

router.put('/settings', requireAuth, requireRole('admin'), (req, res) => {
  settingsService.setBulk(req.body, req.user.id);
  auditService.log({ userId: req.user.id, username: req.user.username,
    action: 'settings_update', details: Object.keys(req.body), ip: getClientIp(req) });
  res.json({ ok: true });
});

// ─── Login Banner (MOTD) ────────────────────────────────────

// GET /motd — public, returns one message to display on login
router.get('/motd', (req, res) => {
  try {
    const linesStr = settingsService.get('login_motd_lines', '');
    const random = settingsService.get('login_motd_random_flag', 'false') === 'true';
    const lines = linesStr.split('\n').map(l => l.trim()).filter(Boolean);
    let motd = '';
    if (lines.length > 0) {
      motd = random ? lines[Math.floor(Math.random() * lines.length)] : lines[0];
    }
    res.json({ motd });
  } catch { res.json({ motd: '' }); }
});

// GET /motd/config — admin, returns full config for editor
router.get('/motd/config', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const lines = settingsService.get('login_motd_lines', '');
    const random = settingsService.get('login_motd_random_flag', 'false') === 'true';
    res.json({ lines, random });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// PUT /motd — admin only, saves lines + random flag
router.put('/motd', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const { lines, random } = req.body;
    if (lines !== undefined) settingsService.set('login_motd_lines', lines, req.user?.id);
    if (random !== undefined) settingsService.set('login_motd_random_flag', String(!!random), req.user?.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ─── Export ─────────────────────────────────────────────────

router.get('/export/:type', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const db = getDb();
    const { type } = req.params;
    const { format } = req.query;

    let data;
    switch (type) {
      case 'audit':
        data = db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 10000').all();
        break;
      case 'alerts':
        data = db.prepare('SELECT * FROM alert_events ORDER BY triggered_at DESC LIMIT 10000').all();
        break;
      case 'stats':
        data = db.prepare('SELECT * FROM container_stats ORDER BY recorded_at DESC LIMIT 10000').all();
        break;
      default:
        return res.status(400).json({ error: 'Invalid export type' });
    }

    if (format === 'csv') {
      if (data.length === 0) return res.type('text/csv').send('');
      const headers = Object.keys(data[0]);
      const csv = [headers.join(','), ...data.map(r =>
        headers.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(',')
      )].join('\n');
      res.type('text/csv').attachment(`${type}-export.csv`).send(csv);
    } else {
      res.json(data);
    }
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// ─── User Preferences ───────────────────────────────────────

router.get('/preferences', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT pref_key, pref_value FROM user_preferences WHERE user_id = ?').all(req.user.id);
    const prefs = {};
    for (const row of rows) {
      prefs[row.pref_key] = row.pref_value;
    }
    res.json(prefs);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/preferences', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const { key, value } = req.body;
    if (!key || typeof key !== 'string') return res.status(400).json({ error: 'key required' });
    db.prepare(`
      INSERT INTO user_preferences (user_id, pref_key, pref_value, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, pref_key) DO UPDATE SET pref_value = ?, updated_at = datetime('now')
    `).run(req.user.id, key, value || '', value || '');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── About / Open Source Files ─────────────────────────────

const fs = require('fs');
const path = require('path');

const ABOUT_FILES = ['README.md', 'LICENSE', 'CONTRIBUTING.md', '.env.example', '.gitignore'];
const ROOT = path.join(__dirname, '..', '..');

router.get('/about/files', requireAuth, (req, res) => {
  const files = ABOUT_FILES.map(name => {
    const filePath = path.join(ROOT, name);
    let exists = false, size = 0;
    try {
      const stat = fs.statSync(filePath);
      exists = true;
      size = stat.size;
    } catch (err) { /* file may not exist */ }
    return { name, exists, size };
  });
  res.json({ files, version: _pkgVersion });
});

router.get('/about/file/:name', requireAuth, (req, res) => {
  const name = req.params.name;
  if (!ABOUT_FILES.includes(name)) return res.status(400).json({ error: 'File not allowed' });
  const filePath = path.join(ROOT, name);
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ name, content });
  } catch {
    res.status(404).json({ error: `${name} not found` });
  }
});

router.put('/about/file/:name', requireAuth, requireRole('admin'), (req, res) => {
  const name = req.params.name;
  if (!ABOUT_FILES.includes(name)) return res.status(400).json({ error: 'File not allowed' });
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
  const filePath = path.join(ROOT, name);
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'file_edit', targetType: 'file', targetId: name,
      ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── AI Chat (OpenAI / Ollama) ─────────────────────────────
// POST /api/ai/chat  { prompt, provider, config: { apiKey?, model?, baseUrl? } }

// ─── Docker Version Checker ────────────────────────────────
router.get('/docker-versions', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const dbHosts = db.prepare('SELECT * FROM docker_hosts WHERE is_active = 1').all();
    const hostList = dbHosts.length > 0
      ? dbHosts.map(h => ({ id: h.id, name: h.name }))
      : [{ id: 0, name: 'Local' }];

    const results = await Promise.allSettled(hostList.map(async (host) => {
      const docker = dockerService.getDocker(host.id);
      const [info, version] = await Promise.all([
        docker.info(),
        docker.version(),
      ]);
      return {
        hostId: host.id,
        hostName: host.name,
        serverVersion: info.ServerVersion || version?.Version || 'unknown',
        apiVersion: version?.ApiVersion || 'unknown',
        os: info.OperatingSystem || '',
        arch: version?.Arch || '',
        kernelVersion: info.KernelVersion || '',
        goVersion: version?.GoVersion || '',
        buildTime: version?.BuildTime || '',
      };
    }));

    const versions = results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { hostId: hostList[i].id, hostName: hostList[i].name, serverVersion: 'unreachable', error: true }
    );

    res.json({ versions });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Multi-Host Overview ────────────────────────────────────

// v8.9.11-alpha.4 — non-Docker enrichment helper. For hosts with
// daemon_type ∈ {vsphere, incus, lxd, proxmox, kubernetes, nomad}, do
// a best-effort read to populate a small summary the multi-host tab
// can render. Returns { daemonType, daemonName, resources: {...},
// version } or { daemonType, error }.
async function _nonDockerOverview(row) {
  try {
    switch (row.daemon_type) {
      case 'vsphere': {
        const { fromHostRow } = require('../services/vsphere');
        const client = fromHostRow(row);
        await client.login();
        try {
          const [info, vms, esxiHosts, datastores] = await Promise.all([
            client.retrieveServiceContent(),
            client.listVMs().catch(() => []),
            client.listHosts().catch(() => []),
            client.listDatastores().catch(() => []),
          ]);
          const powerRunning = vms.filter(v => v.powerState === 'poweredOn').length;
          const capBytes = datastores.reduce((s, d) => s + (d.capacityBytes || 0), 0);
          const freeBytes = datastores.reduce((s, d) => s + (d.freeSpaceBytes || 0), 0);
          return {
            daemonType: 'vsphere', daemonName: 'VMware vSphere / ESXi',
            version: info.version || null, apiVersion: info.apiVersion || null,
            productFullName: info.productFullName || null,
            resources: {
              vms: vms.length, vmsRunning: powerRunning, vmsStopped: vms.length - powerRunning,
              esxiHosts: esxiHosts.length,
              datastores: datastores.length,
              capacityGiB: capBytes ? Math.round(capBytes / (1024**3)) : 0,
              freeGiB: freeBytes ? Math.round(freeBytes / (1024**3)) : 0,
              topVMs: vms.slice(0, 8).map(v => ({
                name: v.name, powerState: v.powerState, guestOS: v.guestOS,
                cpu: v.numCPU, memoryGiB: v.memoryMB ? Math.round(v.memoryMB / 1024) : 0,
              })),
            },
          };
        } finally { await client.logout().catch(() => {}); }
      }
      case 'incus':
      case 'lxd': {
        const { fromHostRow } = require('../services/incus');
        const client = fromHostRow(row);
        const [info, instances] = await Promise.all([
          client.info().catch(() => ({})),
          client.listInstances().catch(() => []),
        ]);
        const env = (info && info.metadata && info.metadata.environment) || {};
        const running = instances.filter(i => i.status === 'Running').length;
        return {
          daemonType: row.daemon_type,
          daemonName: row.daemon_type === 'lxd' ? 'LXD' : 'Incus',
          version: env.server_version, productFullName: env.server_name,
          resources: {
            instances: instances.length, instancesRunning: running,
            instancesStopped: instances.length - running,
            topInstances: instances.slice(0, 8).map(i => ({
              name: i.name, status: i.status, type: i.type,
            })),
          },
        };
      }
      case 'proxmox': {
        const { fromHostRow } = require('../services/proxmox');
        const client = fromHostRow(row);
        const [version, nodes, vms, lxc] = await Promise.all([
          client.version().catch(() => ({})),
          client.listNodes().catch(() => []),
          client.listVMs().catch(() => []),
          client.listLXC().catch(() => []),
        ]);
        return {
          daemonType: 'proxmox', daemonName: 'Proxmox VE',
          version: version && version.version, apiVersion: version && version.repoid,
          resources: {
            nodes: nodes.length,
            vms: vms.length, vmsRunning: vms.filter(v => v.status === 'running').length,
            lxc: lxc.length, lxcRunning: lxc.filter(c => c.status === 'running').length,
            topVMs: vms.slice(0, 8).map(v => ({
              name: v.name, status: v.status, node: v.node, vmid: v.vmid,
            })),
          },
        };
      }
      case 'kubernetes': {
        const { fromHostRow } = require('../services/kubernetes');
        const client = fromHostRow(row);
        const [version, nss, pods, deps, nodes] = await Promise.all([
          client.version().catch(() => ({})),
          client.listNamespaces().catch(() => []),
          client.listPods().catch(() => []),
          client.listDeployments().catch(() => []),
          client.listNodes().catch(() => []),
        ]);
        const podsRunning = pods.filter(p => (p.status && p.status.phase) === 'Running').length;
        return {
          daemonType: 'kubernetes', daemonName: 'Kubernetes',
          version: version && (version.gitVersion || version.version),
          apiVersion: version && `${version.major}.${version.minor}`,
          resources: {
            namespaces: nss.length,
            pods: pods.length, podsRunning,
            deployments: deps.length,
            nodes: nodes.length,
            topDeployments: deps.slice(0, 8).map(d => ({
              name: d.metadata && d.metadata.name,
              namespace: d.metadata && d.metadata.namespace,
              ready: `${(d.status && d.status.readyReplicas) || 0}/${(d.spec && d.spec.replicas) || 0}`,
            })),
          },
        };
      }
      case 'nomad': {
        const { fromHostRow } = require('../services/nomad');
        const client = fromHostRow(row);
        const [self, jobs, allocs, nodes] = await Promise.all([
          client.agentSelf().catch(() => ({})),
          client.listJobs().catch(() => []),
          client.listAllocations().catch(() => []),
          client.listNodes().catch(() => []),
        ]);
        const tags = (self && self.member && self.member.Tags) || {};
        return {
          daemonType: 'nomad', daemonName: 'Nomad',
          version: tags.build || tags.version,
          resources: {
            jobs: jobs.length,
            running: jobs.filter(j => j.Status === 'running').length,
            allocations: allocs.length,
            allocsRunning: allocs.filter(a => a.ClientStatus === 'running').length,
            nodes: nodes.length,
            topJobs: jobs.slice(0, 8).map(j => ({
              name: j.Name || j.ID, status: j.Status, type: j.Type,
            })),
          },
        };
      }
      default:
        return { daemonType: row.daemon_type, error: 'Unknown daemon type' };
    }
  } catch (err) {
    return { daemonType: row.daemon_type, error: err.message };
  }
}

router.get('/multi-host/overview', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const dbHosts = db.prepare('SELECT * FROM docker_hosts WHERE is_active = 1').all();

    // If no hosts configured, use the default local connection (id=0)
    // Otherwise, use only what's in the DB to avoid duplicates
    const hostList = dbHosts.length > 0
      ? dbHosts.map(h => ({
          id: h.id, name: h.name, connectionType: h.connection_type,
          environment: h.environment || 'production',
          daemonType: h.daemon_type || 'docker',
          _row: h,
        }))
      : [{ id: 0, name: 'Local', connectionType: 'socket', environment: 'production', daemonType: 'docker' }];

    // Fetch data from all hosts in parallel
    const results = await Promise.allSettled(hostList.map(async (host) => {
      // v8.9.11-alpha.4 — non-Docker daemon types get their own enrichment
      // path that returns { resources: {...} } instead of Docker containers.
      if (host.daemonType && host.daemonType !== 'docker' && host.daemonType !== 'podman') {
        const summary = await _nonDockerOverview(host._row);
        return {
          id: host.id, name: host.name, environment: host.environment,
          connectionType: host.connectionType,
          daemonType: host.daemonType,
          healthy: !summary.error,
          nonDocker: summary,
          info: { hostname: host.name, os: summary.productFullName || '',
            dockerVersion: summary.version || '', cpus: 0, memTotal: 0, kernelVersion: '', storageDriver: '' },
          containers: [],
          stats: { cpu: 0, memory: 0, memoryLimit: 0 },
          counts: { total: 0, running: 0, stopped: 0, images: 0 },
        };
      }
      const docker = dockerService.getDocker(host.id);

      const [containers, info, statsOverview] = await Promise.all([
        dockerService.listContainers(host.id).catch(() => []),
        docker.info().catch(() => ({})),
        statsService.getOverview(host.id),
      ]);

      return {
        id: host.id,
        name: host.name,
        environment: host.environment,
        connectionType: host.connectionType,
        daemonType: host.daemonType || 'docker',
        healthy: true,
        info: {
          hostname: info.Name || host.name,
          os: info.OperatingSystem || '',
          dockerVersion: info.ServerVersion || '',
          cpus: info.NCPU || 0,
          memTotal: info.MemTotal || 0,
          kernelVersion: info.KernelVersion || '',
          storageDriver: info.Driver || '',
        },
        containers: containers.map(c => ({
          id: c.id?.substring(0, 12) || c.Id?.substring(0, 12),
          name: c.name || (c.Names?.[0] || '').replace(/^\//, ''),
          image: c.image || c.Image,
          state: c.state || c.State,
          stack: c.stack || c.Labels?.['com.docker.compose.project'] || '_standalone',
          ports: c.ports || c.Ports || [],
          created: c.created || c.Created,
        })),
        stats: {
          cpu: statsOverview?.totals?.cpu || 0,
          memory: statsOverview?.totals?.memory || 0,
          memoryLimit: statsOverview?.totals?.memoryLimit || 0,
        },
        counts: {
          total: containers.length,
          running: containers.filter(c => (c.state || c.State) === 'running').length,
          stopped: containers.filter(c => (c.state || c.State) !== 'running').length,
          images: info.Images || 0,
        },
      };
    }));

    const hosts = results
      .map((r, i) => r.status === 'fulfilled' ? r.value : {
        ...hostList[i], healthy: false, containers: [],
        stats: { cpu: 0, memory: 0, memoryLimit: 0 },
        counts: { total: 0, running: 0, stopped: 0, images: 0 },
        info: { hostname: hostList[i].name, os: '', dockerVersion: '', cpus: 0, memTotal: 0, kernelVersion: '', storageDriver: '' },
      });

    const totals = {
      hosts: hosts.length,
      healthyHosts: hosts.filter(h => h.healthy).length,
      containers: hosts.reduce((s, h) => s + h.counts.total, 0),
      running: hosts.reduce((s, h) => s + h.counts.running, 0),
      images: hosts.reduce((s, h) => s + h.counts.images, 0),
    };

    res.json({ hosts, totals });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Event Timeline ─────────────────────────────────────────

// GET /timeline — aggregated event timeline from all sources
router.get('/timeline', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const hours = parseInt(req.query.hours) || 24;
    const events = [];

    // Audit log events (deployments, container actions, user actions)
    try {
      const audits = db.prepare(`
        SELECT id, action, target_type, target_id, username, details, created_at
        FROM audit_log
        WHERE created_at > datetime('now', '-${hours} hours')
        ORDER BY created_at DESC LIMIT 200
      `).all();
      audits.forEach(a => {
        let category = 'action';
        if (/deploy|stack_deploy|git/.test(a.action)) category = 'deploy';
        else if (/create|remove|delete/.test(a.action)) category = 'lifecycle';
        else if (/start|stop|restart|kill/.test(a.action)) category = 'action';
        else if (/login|logout|password|mfa/.test(a.action)) category = 'auth';
        else if (/scan|cis|security/.test(a.action)) category = 'security';
        events.push({
          id: `audit-${a.id}`, source: 'audit', category,
          action: a.action, target: a.target_id, user: a.username,
          details: a.details, time: a.created_at,
        });
      });
    } catch { /* table may not exist */ }

    // Alert events
    try {
      const alerts = db.prepare(`
        SELECT id, rule_name, container_name, severity, message, triggered_at, resolved_at
        FROM alert_events
        WHERE triggered_at > datetime('now', '-${hours} hours')
        ORDER BY triggered_at DESC LIMIT 100
      `).all();
      alerts.forEach(a => events.push({
        id: `alert-${a.id}`, source: 'alert', category: 'alert',
        action: a.rule_name, target: a.container_name,
        severity: a.severity, message: a.message,
        time: a.triggered_at, resolvedAt: a.resolved_at,
      }));
    } catch { /* table may not exist */ }

    // Docker events (container lifecycle)
    try {
      const dkEvents = db.prepare(`
        SELECT id, event_type, actor_name, event_action, event_time
        FROM docker_events
        WHERE event_time > datetime('now', '-${hours} hours')
        ORDER BY event_time DESC LIMIT 200
      `).all();
      dkEvents.forEach(e => events.push({
        id: `docker-${e.id}`, source: 'docker', category: 'lifecycle',
        action: `${e.event_type}:${e.event_action}`, target: e.actor_name,
        time: e.event_time,
      }));
    } catch { /* table may not exist */ }

    // Sort all by time descending
    events.sort((a, b) => (b.time || '').localeCompare(a.time || ''));

    res.json({ events: events.slice(0, 300), hours });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Workload Balancing Recommendations ─────────────────────

// GET /recommendations/balancing — workload balancing suggestions
router.get('/recommendations/balancing', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const dbHosts = db.prepare('SELECT * FROM docker_hosts WHERE is_active = 1').all();
    const hostList = dbHosts.length > 0
      ? dbHosts.map(h => ({ id: h.id, name: h.name }))
      : [{ id: 0, name: 'Local' }];

    if (hostList.length < 2) {
      return res.json({ recommendations: [], message: 'Balancing requires at least 2 hosts.' });
    }

    const hostData = await Promise.allSettled(hostList.map(async (host) => {
      const overview = statsService.getOverview(host.id);
      const containers = await dockerService.listContainers(host.id).catch(() => []);
      const running = containers.filter(c => c.state === 'running');
      return {
        id: host.id, name: host.name,
        containerCount: running.length,
        cpuUsage: overview?.totals?.cpu || 0,
        memUsage: overview?.totals?.memory || 0,
        memLimit: overview?.totals?.memoryLimit || 0,
        containers: running.map(c => ({
          name: c.name, image: c.image, stack: c.stack,
        })),
      };
    }));

    const hosts = hostData.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (hosts.length < 2) return res.json({ recommendations: [] });

    const recommendations = [];
    const avgContainers = hosts.reduce((s, h) => s + h.containerCount, 0) / hosts.length;

    hosts.forEach(h => {
      if (h.containerCount > avgContainers * 1.5 && h.containerCount > 3) {
        const excess = Math.floor(h.containerCount - avgContainers);
        const leastLoaded = hosts.reduce((min, x) => x.containerCount < min.containerCount && x.id !== h.id ? x : min, hosts[0]);
        recommendations.push({
          type: 'rebalance',
          severity: 'warning',
          message: `Host "${h.name}" has ${h.containerCount} containers (${excess} above average). Consider moving ${excess} container(s) to "${leastLoaded.name}" (${leastLoaded.containerCount} containers).`,
          from: h.name, to: leastLoaded.name,
          excess,
        });
      }
      if (h.cpuUsage > 80) {
        recommendations.push({
          type: 'cpu_pressure',
          severity: h.cpuUsage > 90 ? 'critical' : 'warning',
          message: `Host "${h.name}" CPU at ${Math.round(h.cpuUsage)}%. Consider migrating CPU-intensive containers to less loaded hosts.`,
          host: h.name,
        });
      }
      const memPct = h.memLimit > 0 ? (h.memUsage / h.memLimit) * 100 : 0;
      if (memPct > 80) {
        recommendations.push({
          type: 'memory_pressure',
          severity: memPct > 90 ? 'critical' : 'warning',
          message: `Host "${h.name}" RAM at ${Math.round(memPct)}%. Consider adding memory limits or migrating containers.`,
          host: h.name,
        });
      }
    });

    if (recommendations.length === 0) {
      recommendations.push({ type: 'balanced', severity: 'info', message: 'All hosts are well-balanced. No action needed.' });
    }

    res.json({
      recommendations,
      hosts: hosts.map(h => ({
        name: h.name,
        containers: h.containerCount,
        cpu: Math.round(h.cpuUsage),
        memPct: h.memLimit > 0 ? Math.round((h.memUsage / h.memLimit) * 100) : 0,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── How-To Knowledge Base ─────────────────────────────

// GET /howto — list all guides
router.get('/howto', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const { category, difficulty, search } = req.query;
    let sql = 'SELECT id, slug, title, title_ro, category, difficulty, icon, summary, summary_ro, is_builtin, created_at FROM howto_guides';
    const conditions = [];
    const params = [];

    if (category) { conditions.push('category = ?'); params.push(category); }
    if (difficulty) { conditions.push('difficulty = ?'); params.push(difficulty); }
    if (search) { conditions.push('(title LIKE ? OR summary LIKE ? OR title_ro LIKE ? OR summary_ro LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }

    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY is_builtin DESC, category, difficulty, title';

    const guides = db.prepare(sql).all(...params);
    res.json({ guides });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /howto/:slug — get full guide
router.get('/howto/:slug', requireAuth, (req, res) => {
  try {
    const guide = getDb().prepare('SELECT * FROM howto_guides WHERE slug = ?').get(req.params.slug);
    if (!guide) return res.status(404).json({ error: 'Guide not found' });
    res.json(guide);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /howto — create guide (admin)
router.post('/howto', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const { slug, title, title_ro, category, difficulty, icon, summary, summary_ro, content, content_ro } = req.body;
    if (!slug || !title) return res.status(400).json({ error: 'slug and title are required' });

    getDb().prepare(`
      INSERT INTO howto_guides (slug, title, title_ro, category, difficulty, icon, summary, summary_ro, content, content_ro, is_builtin, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(slug, title, title_ro || '', category || 'general', difficulty || 'beginner', icon || 'fas fa-book', summary || '', summary_ro || '', content || '', content_ro || '', req.user?.id);

    res.status(201).json({ ok: true, slug });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Guide with this slug already exists' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /howto/:slug — update guide (admin)
router.put('/howto/:slug', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const { title, title_ro, category, difficulty, icon, summary, summary_ro, content, content_ro } = req.body;
    const result = getDb().prepare(`
      UPDATE howto_guides SET title = ?, title_ro = ?, category = ?, difficulty = ?, icon = ?, summary = ?, summary_ro = ?, content = ?, content_ro = ?, updated_at = datetime('now')
      WHERE slug = ?
    `).run(title, title_ro || '', category || 'general', difficulty || 'beginner', icon || 'fas fa-book', summary || '', summary_ro || '', content || '', content_ro || '', req.params.slug);

    if (result.changes === 0) return res.status(404).json({ error: 'Guide not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /howto/:slug — delete custom guide (admin, not built-in)
router.delete('/howto/:slug', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const guide = getDb().prepare('SELECT is_builtin FROM howto_guides WHERE slug = ?').get(req.params.slug);
    if (!guide) return res.status(404).json({ error: 'Guide not found' });
    if (guide.is_builtin) return res.status(400).json({ error: 'Cannot delete built-in guides' });

    getDb().prepare('DELETE FROM howto_guides WHERE slug = ?').run(req.params.slug);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Sub-routers (v8.2.x post-audit further-split) ────────────────────
// External URLs unchanged — mounts replicate original path prefixes.
router.use('/favorites', require('./misc-favorites'));      // 3 routes
router.use('/notifications', require('./misc-notifications')); // 6 routes
router.use('/api-keys', require('./misc-api-keys'));        // 3 routes
router.use('/audit', require('./misc-audit'));              // 3 routes
router.use('/ai', require('./misc-ai'));                    // 2 routes

module.exports = router;
