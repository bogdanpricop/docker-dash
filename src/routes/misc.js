'use strict';

const { Router } = require('express');
const { favorites, notifications, apiKeys } = require('../services/misc');
const auditService = require('../services/audit');
const settingsService = require('../services/settings');
const statsService = require('../services/stats');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const { getDb } = require('../db');

const router = Router();

// ─── Health ─────────────────────────────────────────────────

router.get('/health', (req, res) => {
  try {
    getDb().prepare('SELECT 1').get();
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'error', message: 'Database unavailable' });
  }
});

// ─── Prometheus Metrics ─────────────────────────────────────

router.get('/metrics', (req, res) => {
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
  } catch {}

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
  favorites.add(req.user.id, req.body.containerId);
  res.json({ ok: true });
});

router.delete('/favorites/:containerId', requireAuth, (req, res) => {
  favorites.remove(req.user.id, req.params.containerId);
  res.json({ ok: true });
});

// ─── Notifications ──────────────────────────────────────────

router.get('/notifications', requireAuth, (req, res) => {
  const { unreadOnly } = req.query;
  res.json(notifications.list(req.user.id, { unreadOnly: unreadOnly === 'true' }));
});

router.get('/notifications/count', requireAuth, (req, res) => {
  res.json({ count: notifications.unreadCount(req.user.id) });
});

router.post('/notifications/:id/read', requireAuth, (req, res) => {
  notifications.markRead(parseInt(req.params.id), req.user.id);
  res.json({ ok: true });
});

router.post('/notifications/read-all', requireAuth, (req, res) => {
  notifications.markAllRead(req.user.id);
  res.json({ ok: true });
});

// ─── API Keys ───────────────────────────────────────────────

router.get('/api-keys', requireAuth, (req, res) => {
  res.json(apiKeys.list(req.user.id));
});

router.post('/api-keys', requireAuth, (req, res) => {
  const result = apiKeys.create(req.user.id, req.body);
  auditService.log({ userId: req.user.id, username: req.user.username,
    action: 'apikey_create', details: { name: req.body.name }, ip: getClientIp(req) });
  res.status(201).json(result);
});

router.delete('/api-keys/:id', requireAuth, (req, res) => {
  apiKeys.revoke(parseInt(req.params.id), req.user.id);
  res.json({ ok: true });
});

// ─── Audit Log ──────────────────────────────────────────────

router.get('/audit', requireAuth, requireRole('admin'), (req, res) => {
  const { action, targetType, userId, page, limit, since, until } = req.query;
  res.json(auditService.query({
    action, targetType, userId: userId ? parseInt(userId) : undefined,
    page: parseInt(page) || 1, limit: parseInt(limit) || 50, since, until,
  }));
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

// ─── Comparison Data (for marketing/about pages) ────────────

router.get('/compare', (req, res) => {
  // Public endpoint — no auth required (for embedding in docs/README)
  const features = [
    { feature: 'Container CRUD', dockerDash: true, portainerCE: true, dockge: 'compose only', dockhand: true },
    { feature: 'Image Management', dockerDash: true, portainerCE: true, dockge: false, dockhand: true },
    { feature: 'Volume Management', dockerDash: true, portainerCE: true, dockge: false, dockhand: true },
    { feature: 'Network Management', dockerDash: true, portainerCE: true, dockge: false, dockhand: true },
    { feature: 'Network Topology', dockerDash: true, portainerCE: false, dockge: false, dockhand: false },
    { feature: 'Real-time Stats', dockerDash: true, portainerCE: true, dockge: 'basic', dockhand: true },
    { feature: 'Terminal (xterm.js)', dockerDash: true, portainerCE: true, dockge: true, dockhand: true },
    { feature: 'Vulnerability Scanning', dockerDash: 'Trivy + Scout', portainerCE: false, dockge: false, dockhand: 'Grype + Trivy' },
    { feature: 'Safe-Pull Updates', dockerDash: true, portainerCE: false, dockge: false, dockhand: true },
    { feature: 'Multi-Host (agentless)', dockerDash: true, portainerCE: 'agent required', dockge: 'agent', dockhand: true },
    { feature: 'Git Integration', dockerDash: true, portainerCE: 'BE only', dockge: false, dockhand: false },
    { feature: 'Webhooks + Polling', dockerDash: true, portainerCE: 'BE only', dockge: false, dockhand: false },
    { feature: 'Deployment Rollback', dockerDash: true, portainerCE: false, dockge: false, dockhand: false },
    { feature: 'Audit Log', dockerDash: true, portainerCE: 'BE only', dockge: false, dockhand: false },
    { feature: 'Alerts', dockerDash: '7 channels', portainerCE: 'BE only', dockge: false, dockhand: false },
    { feature: 'SSO (Authelia/Authentik)', dockerDash: true, portainerCE: 'BE only', dockge: false, dockhand: false },
    { feature: 'Health Score', dockerDash: true, portainerCE: false, dockge: false, dockhand: false },
    { feature: 'Resource Forecasting', dockerDash: true, portainerCE: false, dockge: false, dockhand: false },
    { feature: 'Cost Estimation', dockerDash: true, portainerCE: false, dockge: false, dockhand: false },
    { feature: 'App Templates', dockerDash: '20 built-in', portainerCE: '500+ community', dockge: false, dockhand: false },
    { feature: 'Troubleshooting Wizard', dockerDash: true, portainerCE: false, dockge: false, dockhand: false },
    { feature: 'Public Status Page', dockerDash: true, portainerCE: false, dockge: false, dockhand: false },
    { feature: 'Maintenance Windows', dockerDash: true, portainerCE: false, dockge: false, dockhand: false },
    { feature: 'i18n', dockerDash: 'EN/RO/DE', portainerCE: 'partial', dockge: false, dockhand: false },
    { feature: 'Command Palette', dockerDash: true, portainerCE: false, dockge: false, dockhand: false },
    { feature: 'Build Step', dockerDash: 'none', portainerCE: 'Angular', dockge: 'required', dockhand: 'required' },
    { feature: 'Container Size', dockerDash: '~80MB', portainerCE: '~250MB', dockge: '~100MB', dockhand: '~80MB' },
    { feature: 'RAM Usage', dockerDash: '~50MB', portainerCE: '~200MB', dockge: '~50MB', dockhand: '~60MB' },
    { feature: 'License', dockerDash: 'MIT', portainerCE: 'Zlib', dockge: 'MIT', dockhand: 'BSL 1.1' },
  ];

  const summary = {
    dockerDash: { exclusive: features.filter(f => f.dockerDash === true && !f.portainerCE && !f.dockge && !f.dockhand).length },
    version: require('../../package.json').version,
  };

  res.json({ features, summary });
});

// ─── Watchtower Detection ───────────────────────────────────

router.get('/watchtower', requireAuth, async (req, res) => {
  try {
    const dockerService = require('../services/docker');
    const containers = await dockerService.listContainers(req.query.hostId || 0);
    const watchtower = containers.filter(c => {
      const image = (c.Image || c.image || '').toLowerCase();
      const name = ((c.Names || c.names || [])[0] || '').toLowerCase();
      return image.includes('watchtower') || name.includes('watchtower');
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
    } catch {}
    return { name, exists, size };
  });
  // Also include package.json version
  let version = '?';
  try { version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch {}
  res.json({ files, version });
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

module.exports = router;
