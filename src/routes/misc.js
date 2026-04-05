'use strict';

const express = require('express');
const { Router } = require('express');
const { favorites, notifications, apiKeys } = require('../services/misc');
const auditService = require('../services/audit');
const settingsService = require('../services/settings');
const statsService = require('../services/stats');
const { requireAuth, optionalAuth, requireRole } = require('../middleware/auth');
const { getClientIp, formatBytes } = require('../utils/helpers');
const { getDb } = require('../db');
const config = require('../config');
const dockerService = require('../services/docker');

const router = Router();

// Version — read from src/version.js (mounted volume, updated without image rebuild)
const _pkgVersion = require('../version');

// ─── Health ─────────────────────────────────────────────────

router.get('/health', (req, res) => {
  try {
    getDb().prepare('SELECT 1').get();
    res.json({ status: 'ok', version: _pkgVersion, timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'error', message: 'Database unavailable' });
  }
});

// ─── Prometheus Metrics ─────────────────────────────────────

router.get('/metrics', optionalAuth, (req, res) => {
  try {
    const db = getDb();
    const overview = statsService.getOverview();
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

    res.type('text/plain').send(lines.join('\n') + '\n');
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

router.get('/favorites', requireAuth, (req, res) => {
  res.json(favorites.list(req.user.id));
});

router.post('/favorites', requireAuth, (req, res) => {
  try { favorites.add(req.user.id, req.body.containerId); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/favorites/:containerId', requireAuth, (req, res) => {
  try { favorites.remove(req.user.id, req.params.containerId); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Notifications ──────────────────────────────────────────

router.get('/notifications', requireAuth, (req, res) => {
  const { unreadOnly, page, limit, type } = req.query;
  res.json(notifications.list(req.user.id, {
    unreadOnly: unreadOnly === 'true',
    page: parseInt(page) || 1,
    limit: parseInt(limit) || 50,
    type: type || undefined,
  }));
});

router.get('/notifications/count', requireAuth, (req, res) => {
  res.json({ count: notifications.unreadCount(req.user.id) });
});

router.post('/notifications/:id/read', requireAuth, (req, res) => {
  try { notifications.markRead(parseInt(req.params.id), req.user.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/notifications/read-all', requireAuth, (req, res) => {
  try { notifications.markAllRead(req.user.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/notifications/:id', requireAuth, (req, res) => {
  try { notifications.delete(parseInt(req.params.id), req.user.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/notifications/bulk', requireAuth, (req, res) => {
  try {
    const { ids, action } = req.body;
    if (!ids || !Array.isArray(ids) || !['read', 'delete'].includes(action)) {
      return res.status(400).json({ error: 'ids (array) and action (read|delete) required' });
    }
    notifications.bulkAction(ids.map(id => parseInt(id)), req.user.id, action);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── API Keys ───────────────────────────────────────────────

router.get('/api-keys', requireAuth, (req, res) => {
  res.json(apiKeys.list(req.user.id));
});

router.post('/api-keys', requireAuth, (req, res) => {
  try {
    const result = apiKeys.create(req.user.id, req.body);
    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'apikey_create', details: { name: req.body.name }, ip: getClientIp(req) });
    res.status(201).json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/api-keys/:id', requireAuth, (req, res) => {
  try { apiKeys.revoke(parseInt(req.params.id), req.user.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Audit Log ──────────────────────────────────────────────

router.get('/audit', requireAuth, requireRole('admin'), (req, res) => {
  const { action, targetType, userId, page, limit, since, until } = req.query;
  res.json(auditService.query({
    action, targetType, userId: userId ? parseInt(userId) : undefined,
    page: parseInt(page) || 1, limit: parseInt(limit) || 50, since, until,
  }));
});

// ─── Audit CSV Export ───────────────────────────────────────

router.get('/audit/export', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const db = getDb();
    const days = parseInt(req.query.days) || 30;
    const rows = db.prepare(`
      SELECT id, username, action, target_type, target_id, ip, created_at
      FROM audit_log WHERE created_at >= datetime('now', '-' || ? || ' days')
      ORDER BY created_at DESC LIMIT 10000
    `).all(days);

    const csv = [
      'ID,Username,Action,Target Type,Target ID,IP,Timestamp',
      ...rows.map(r =>
        `${r.id},"${(r.username || '').replace(/"/g, '""')}","${r.action}","${r.target_type || ''}","${(r.target_id || '').replace(/"/g, '""')}","${r.ip || ''}","${r.created_at}"`
      ),
    ].join('\n');

    const ts = new Date().toISOString().substring(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${ts}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Audit Analytics ────────────────────────────────────────

router.get('/audit/analytics', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const db = getDb();
    const days = parseInt(req.query.days) || 7;

    // Top users by action count
    const topUsers = db.prepare(`
      SELECT username, COUNT(*) AS action_count
      FROM audit_log WHERE created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY username ORDER BY action_count DESC LIMIT 10
    `).all(days);

    // Top actions
    const topActions = db.prepare(`
      SELECT action, COUNT(*) AS count
      FROM audit_log WHERE created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY action ORDER BY count DESC LIMIT 15
    `).all(days);

    // Most actioned containers/targets
    const topTargets = db.prepare(`
      SELECT target_id, target_type, COUNT(*) AS count
      FROM audit_log WHERE created_at >= datetime('now', '-' || ? || ' days')
        AND target_id IS NOT NULL AND target_id != ''
      GROUP BY target_id, target_type ORDER BY count DESC LIMIT 10
    `).all(days);

    // Activity by hour (heatmap data)
    const hourly = db.prepare(`
      SELECT strftime('%H', created_at) AS hour, COUNT(*) AS count
      FROM audit_log WHERE created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY hour ORDER BY hour
    `).all(days);

    // Activity by day
    const daily = db.prepare(`
      SELECT date(created_at) AS day, COUNT(*) AS count
      FROM audit_log WHERE created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY day ORDER BY day
    `).all(days);

    // Total counts
    const total = db.prepare(
      "SELECT COUNT(*) AS cnt FROM audit_log WHERE created_at >= datetime('now', '-' || ? || ' days')"
    ).get(days)?.cnt || 0;

    res.json({ days, total, topUsers, topActions, topTargets, hourly, daily });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Database Backup ────────────────────────────────────────

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
      res.status(500).json({ error: 'Backup failed: ' + err.message });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Database Restore ──────────────────────────────────────

const SQLITE_MAGIC = 'SQLite format 3\0';

router.post('/backup/restore', express.json({ limit: '750mb' }), requireAuth, requireRole('admin'), (req, res) => {
  try {
    const { content } = req.body || {};

    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Database file content (base64) is required' });
    }

    // Decode base64
    const fileBuffer = Buffer.from(content, 'base64');

    // Validate minimum size (SQLite header is 100 bytes)
    if (fileBuffer.length < 100) {
      return res.status(400).json({ error: 'File is too small to be a valid SQLite database' });
    }

    // Validate SQLite magic bytes (first 16 bytes = "SQLite format 3\0")
    const header = fileBuffer.slice(0, 16).toString('ascii');
    if (header !== SQLITE_MAGIC) {
      return res.status(400).json({ error: 'Invalid file: not a SQLite database (magic bytes mismatch)' });
    }

    // Limit size to 500MB
    if (fileBuffer.length > 500 * 1024 * 1024) {
      return res.status(413).json({ error: 'Database file too large (max 500MB)' });
    }

    const path = require('path');
    const fs = require('fs');
    const dbPath = process.env.DB_PATH || path.join(process.env.DATA_DIR || '/data', 'docker-dash.db');
    const backupDir = process.env.DATA_DIR || '/data';

    // Create a safety backup of current DB before replacing
    const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const safetyBackupPath = path.join(backupDir, `pre-restore-${ts}.db`);

    const db = getDb();

    // Log the restore action before closing
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'database_restore',
      details: JSON.stringify({ uploadSize: fileBuffer.length, safetyBackup: safetyBackupPath }),
      ip: getClientIp(req),
    });

    // Safety backup, then replace
    db.backup(safetyBackupPath).then(() => {
      // Close the current database
      try { db.close(); } catch (_e) { /* may already be closed */ }

      // Write the uploaded database
      fs.writeFileSync(dbPath, fileBuffer);

      // Respond before restart so the client gets confirmation
      res.json({
        ok: true,
        message: 'Database restored successfully. The application will restart.',
        safetyBackup: safetyBackupPath,
        restoredSize: fileBuffer.length,
      });

      // Graceful restart after a short delay
      setTimeout(() => {
        process.exit(0); // Docker/systemd will restart the process
      }, 1000);
    }).catch(err => {
      res.status(500).json({ error: 'Failed to create safety backup: ' + err.message });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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

      // Detect dependencies from env vars (DB_HOST, REDIS_URL, etc.)
      const envDeps = [];
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    let content = null, exists = false, size = 0;
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
    res.status(500).json({ error: err.message });
  }
});

// ─── AI Chat (OpenAI / Ollama) ─────────────────────────────
// POST /api/ai/chat  { prompt, provider, config: { apiKey?, model?, baseUrl? } }
router.post('/ai/chat', requireAuth, async (req, res) => {
  const { prompt, provider = 'ollama', config: aiConfig = {} } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  try {
    let response = '';

    if (provider === 'openai') {
      const apiKey = aiConfig.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) return res.status(400).json({ error: 'OpenAI API key not configured. Set OPENAI_API_KEY env var or provide it in the request.' });
      const model = aiConfig.model || 'gpt-4o-mini';
      const https = require('https');
      const body = JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 1500 });
      response = await new Promise((resolve, reject) => {
        const req2 = https.request({
          hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(body) },
        }, (r) => {
          let data = '';
          r.on('data', d => { data += d; });
          r.on('end', () => {
            try { resolve(JSON.parse(data)?.choices?.[0]?.message?.content || 'No response'); }
            catch { resolve(data); }
          });
        });
        req2.on('error', reject);
        req2.write(body);
        req2.end();
      });

    } else if (provider === 'ollama') {
      const baseUrl = aiConfig.baseUrl || process.env.OLLAMA_URL || 'http://localhost:11434';
      const model = aiConfig.model || 'llama3';
      const http = require(baseUrl.startsWith('https') ? 'https' : 'http');
      const bodyStr = JSON.stringify({ model, prompt, stream: false });
      const urlObj = new URL(`${baseUrl.replace(/\/$/, '')}/api/generate`);
      response = await new Promise((resolve, reject) => {
        const req2 = http.request({
          hostname: urlObj.hostname, port: urlObj.port || (baseUrl.startsWith('https') ? 443 : 80),
          path: urlObj.pathname, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
        }, (r) => {
          let data = '';
          r.on('data', d => { data += d; });
          r.on('end', () => {
            try { resolve(JSON.parse(data)?.response || 'No response'); }
            catch { resolve(data); }
          });
        });
        req2.on('error', reject);
        req2.write(bodyStr);
        req2.end();
      });

    } else {
      return res.status(400).json({ error: `Unknown provider: ${provider}. Use 'openai' or 'ollama'.` });
    }

    res.json({ response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GitHub-to-Compose Generator ─────────────────────────────
// POST /api/ai/github-compose  { repoUrl, provider, config }
// Fetches README + package.json from GitHub, asks AI to generate docker-compose
router.post('/ai/github-compose', requireAuth, async (req, res) => {
  const { repoUrl, provider = 'ollama', config: aiConfig = {} } = req.body;
  if (!repoUrl) return res.status(400).json({ error: 'repoUrl is required' });

  // Parse GitHub URL  → owner/repo
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/i);
  if (!match) return res.status(400).json({ error: 'Invalid GitHub URL. Expected: https://github.com/owner/repo' });
  const [, owner, repo] = match;

  try {
    const https = require('https');
    const fetchGH = (path) => new Promise((resolve) => {
      const opts = {
        hostname: 'raw.githubusercontent.com', path, method: 'GET',
        headers: { 'User-Agent': 'docker-dash/1.0' },
        timeout: 8000,
      };
      const req2 = https.request(opts, (r) => {
        let data = '';
        r.on('data', d => { data += d; });
        r.on('end', () => resolve(r.statusCode === 200 ? data : null));
      });
      req2.on('error', () => resolve(null));
      req2.on('timeout', () => { req2.destroy(); resolve(null); });
      req2.end();
    });

    // Fetch useful files (limit to avoid huge prompts)
    const [readme, pkgJson, requirements, goMod, pyProject, composeSample] = await Promise.all([
      fetchGH(`/${owner}/${repo}/HEAD/README.md`),
      fetchGH(`/${owner}/${repo}/HEAD/package.json`),
      fetchGH(`/${owner}/${repo}/HEAD/requirements.txt`),
      fetchGH(`/${owner}/${repo}/HEAD/go.mod`),
      fetchGH(`/${owner}/${repo}/HEAD/pyproject.toml`),
      fetchGH(`/${owner}/${repo}/HEAD/docker-compose.yml`)
        .then(r => r || fetchGH(`/${owner}/${repo}/HEAD/docker-compose.yaml`)),
    ]);

    // Build context (truncate to keep prompt manageable)
    const trim = (s, n = 1500) => s ? s.substring(0, n) + (s.length > n ? '\n...(truncated)' : '') : null;
    const context = [
      readme && `=== README ===\n${trim(readme, 2000)}`,
      pkgJson && `=== package.json ===\n${trim(pkgJson)}`,
      requirements && `=== requirements.txt ===\n${trim(requirements, 500)}`,
      goMod && `=== go.mod ===\n${trim(goMod, 500)}`,
      pyProject && `=== pyproject.toml ===\n${trim(pyProject, 500)}`,
      composeSample && `=== Existing compose (reference only) ===\n${trim(composeSample)}`,
    ].filter(Boolean).join('\n\n');

    if (!context) return res.status(422).json({ error: 'Could not fetch any files from the repository. Make sure it is public.' });

    const prompt = `You are a Docker expert. Analyze the following GitHub repository context and generate a production-ready docker-compose.yml file.

Repository: https://github.com/${owner}/${repo}

${context}

Requirements:
- Identify all services (web, database, cache, worker, etc.)
- Use appropriate Docker images with specific version tags (not :latest)
- Add health checks where applicable
- Include restart: unless-stopped
- Use named volumes for persistent data
- Define a custom network
- Add reasonable environment variable placeholders
- Add resource limits (mem_limit, cpus) for production

Respond with ONLY the docker-compose.yml content, no markdown fences, no explanations.`;

    // Reuse the ai/chat logic by making an internal call
    const callAi = async () => {
      if (provider === 'openai') {
        const apiKey = aiConfig.apiKey || process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error('OpenAI API key not configured');
        const model = aiConfig.model || 'gpt-4o-mini';
        const body = JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 2000 });
        return new Promise((resolve, reject) => {
          const req2 = https.request({
            hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(body) },
          }, (r) => {
            let data = '';
            r.on('data', d => { data += d; });
            r.on('end', () => {
              try { resolve(JSON.parse(data)?.choices?.[0]?.message?.content || 'No response'); }
              catch { resolve(data); }
            });
          });
          req2.on('error', reject);
          req2.write(body); req2.end();
        });
      } else {
        const baseUrl = aiConfig.baseUrl || process.env.OLLAMA_URL || 'http://localhost:11434';
        const model = aiConfig.model || 'llama3';
        const http2 = require(baseUrl.startsWith('https') ? 'https' : 'http');
        const bodyStr = JSON.stringify({ model, prompt, stream: false });
        const urlObj = new URL(`${baseUrl.replace(/\/$/, '')}/api/generate`);
        return new Promise((resolve, reject) => {
          const req2 = http2.request({
            hostname: urlObj.hostname, port: urlObj.port || (baseUrl.startsWith('https') ? 443 : 80),
            path: urlObj.pathname, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
          }, (r) => {
            let data = '';
            r.on('data', d => { data += d; });
            r.on('end', () => {
              try { resolve(JSON.parse(data)?.response || 'No response'); }
              catch { resolve(data); }
            });
          });
          req2.on('error', reject);
          req2.write(bodyStr); req2.end();
        });
      }
    };

    const compose = await callAi();
    res.json({ compose, repo: `${owner}/${repo}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Multi-Host Overview ────────────────────────────────────

router.get('/multi-host/overview', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const dbHosts = db.prepare('SELECT * FROM docker_hosts WHERE is_active = 1').all();

    // If no hosts configured, use the default local connection (id=0)
    // Otherwise, use only what's in the DB to avoid duplicates
    const hostList = dbHosts.length > 0
      ? dbHosts.map(h => ({ id: h.id, name: h.name, connectionType: h.connection_type, environment: h.environment || 'production' }))
      : [{ id: 0, name: 'Local', connectionType: 'socket', environment: 'production' }];

    // Fetch data from all hosts in parallel
    const results = await Promise.allSettled(hostList.map(async (host) => {
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
        healthy: true,
        info: {
          hostname: info.Name || host.name,
          os: info.OperatingSystem || '',
          dockerVersion: info.ServerVersion || '',
          cpus: info.NCPU || 0,
          memTotal: info.MemTotal || 0,
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
        info: { hostname: hostList[i].name, os: '', dockerVersion: '', cpus: 0, memTotal: 0 },
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
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
