'use strict';

const { Router } = require('express');
const dockerService = require('../services/docker');
const auditService = require('../services/audit');
const { dockerEvents } = require('../services/misc');
const { requireAuth, requireRole, writeable, requireFeature } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');

const { getDb } = require('../db');
const config = require('../config');

const { extractHostId } = require('../middleware/hostId');

const router = Router();
router.use(extractHostId);

// ─── Database Info & Maintenance ─────────────────────────────
router.get('/database', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const db = getDb();
    const fs = require('fs');

    const dbPath = config.db.path;
    const dbStat = fs.statSync(dbPath);
    let walSize = 0;
    try { walSize = fs.statSync(dbPath + '-wal').size; } catch {}

    const pageSize = db.pragma('page_size')[0].page_size;
    const pageCount = db.pragma('page_count')[0].page_count;
    const freelistCount = db.pragma('freelist_count')[0].freelist_count;
    const journalMode = db.pragma('journal_mode')[0].journal_mode;

    // Table sizes via dbstat
    const tables = [];
    try {
      const rows = db.prepare(`
        SELECT tbl as name, SUM(pgsize) as size
        FROM dbstat WHERE NOT name LIKE 'sqlite_%'
        GROUP BY tbl ORDER BY size DESC
      `).all();
      for (const r of rows) {
        const countRow = db.prepare(`SELECT COUNT(*) as c FROM "${r.name}"`).get();
        tables.push({ name: r.name, size: r.size, rows: countRow.c });
      }
    } catch {
      // Fallback if dbstat not available
      const allTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      for (const t of allTables) {
        try {
          const c = db.prepare(`SELECT COUNT(*) as c FROM "${t.name}"`).get();
          tables.push({ name: t.name, size: 0, rows: c.c });
        } catch {}
      }
    }

    // Index count per table
    const indexes = db.prepare("SELECT tbl_name, COUNT(*) as cnt FROM sqlite_master WHERE type='index' GROUP BY tbl_name").all();
    const indexMap = {};
    for (const ix of indexes) indexMap[ix.tbl_name] = ix.cnt;

    // Add index count to tables
    for (const t of tables) t.indexes = indexMap[t.name] || 0;

    // Retention config
    const retention = {
      statsRawHours: config.stats.retentionRawHours,
      stats1mDays: config.stats.retention1mDays,
      stats1hDays: config.stats.retention1hDays,
      auditDays: config.retention.auditDays,
      eventDays: config.retention.eventDays,
    };

    res.json({
      file: {
        path: dbPath,
        size: dbStat.size,
        walSize,
        modified: dbStat.mtime,
      },
      engine: {
        pageSize,
        pageCount,
        freelistCount,
        freelistBytes: freelistCount * pageSize,
        journalMode,
        sqliteVersion: db.prepare('SELECT sqlite_version() as v').get().v,
      },
      tables,
      retention,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/database/cleanup', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const db = getDb();
    const ret = config.retention;
    const stats = config.stats;
    const deleted = {};

    // Stats
    const r1 = db.prepare(`DELETE FROM container_stats WHERE recorded_at < datetime('now', '-' || ? || ' hours')`).run(stats.retentionRawHours);
    if (r1.changes) deleted.container_stats = r1.changes;
    const r2 = db.prepare(`DELETE FROM container_stats_1m WHERE bucket < datetime('now', '-' || ? || ' days')`).run(stats.retention1mDays);
    if (r2.changes) deleted.container_stats_1m = r2.changes;
    const r3 = db.prepare(`DELETE FROM container_stats_1h WHERE bucket < datetime('now', '-' || ? || ' days')`).run(stats.retention1hDays);
    if (r3.changes) deleted.container_stats_1h = r3.changes;

    // Docker events
    const r4 = db.prepare(`DELETE FROM docker_events WHERE event_time < datetime('now', '-' || ? || ' days')`).run(ret.eventDays);
    if (r4.changes) deleted.docker_events = r4.changes;

    // Audit log
    const r5 = db.prepare(`DELETE FROM audit_log WHERE created_at < datetime('now', '-' || ? || ' days')`).run(ret.auditDays);
    if (r5.changes) deleted.audit_log = r5.changes;

    // Health events
    try {
      const r = db.prepare(`DELETE FROM health_events WHERE recorded_at < datetime('now', '-' || ? || ' days')`).run(ret.eventDays);
      if (r.changes) deleted.health_events = r.changes;
    } catch {}

    // Alert events
    try {
      const r = db.prepare(`DELETE FROM alert_events WHERE triggered_at < datetime('now', '-' || ? || ' days')`).run(ret.eventDays);
      if (r.changes) deleted.alert_events = r.changes;
    } catch {}

    // Webhook deliveries
    try {
      const r = db.prepare(`DELETE FROM webhook_deliveries WHERE delivered_at < datetime('now', '-' || ? || ' days')`).run(ret.eventDays);
      if (r.changes) deleted.webhook_deliveries = r.changes;
    } catch {}

    // Login attempts
    try {
      const r = db.prepare(`DELETE FROM login_attempts WHERE attempted_at < datetime('now', '-' || ? || ' days')`).run(ret.eventDays);
      if (r.changes) deleted.login_attempts = r.changes;
    } catch {}

    // Expired tokens
    try {
      const r = db.prepare(`DELETE FROM password_reset_tokens WHERE expires_at < datetime('now')`).run();
      if (r.changes) deleted.password_reset_tokens = r.changes;
    } catch {}

    const totalDeleted = Object.values(deleted).reduce((a, b) => a + b, 0);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'database_cleanup', details: { deleted, totalDeleted },
      ip: getClientIp(req),
    });

    res.json({ ok: true, deleted, totalDeleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/database/vacuum', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const db = getDb();
    const fs = require('fs');
    const dbPath = config.db.path;

    const sizeBefore = fs.statSync(dbPath).size;
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    const sizeAfter = fs.statSync(dbPath).size;

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'database_vacuum',
      details: { sizeBefore, sizeAfter, freed: sizeBefore - sizeAfter },
      ip: getClientIp(req),
    });

    res.json({ ok: true, sizeBefore, sizeAfter, freed: sizeBefore - sizeAfter });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/info', requireAuth, async (req, res) => {
  try { res.json(await dockerService.getInfo(req.hostId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/disk-usage', requireAuth, async (req, res) => {
  try { res.json(await dockerService.getDiskUsage(req.hostId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/events', requireAuth, (req, res) => {
  try {
    const { type, action, since, limit } = req.query;
    res.json(dockerEvents.query({ type, action, since, limit: parseInt(limit) || 100 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/prune', requireAuth, requireRole('admin'), writeable, requireFeature('prune'), async (req, res) => {
  try {
    const { containers, images, volumes, networks } = req.body;
    const results = await dockerService.prune({ containers, images, volumes, networks }, req.hostId);
    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'system_prune', details: req.body, ip: getClientIp(req) });
    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Update Checks ───────────────────────────────────────────
const { execSync } = require('child_process');
const https = require('https');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'DockerDash/1.0' }, timeout: 8000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

router.get('/check-updates', requireAuth, async (req, res) => {
  try {
    const result = { docker: null, os: null, app: null };

    // ── Docker Engine update check ──
    try {
      const version = await dockerService.getDocker(req.hostId).version();
      const currentDocker = version.Version;
      // Fetch latest stable from Docker GitHub releases
      const releases = await fetchJSON('https://api.github.com/repos/moby/moby/releases?per_page=10');
      let latestDocker = null;
      if (Array.isArray(releases)) {
        for (const r of releases) {
          if (r.prerelease || r.draft) continue;
          const tag = (r.tag_name || '').replace(/^v/, '');
          if (/^\d+\.\d+\.\d+$/.test(tag)) { latestDocker = tag; break; }
        }
      }
      result.docker = {
        current: currentDocker,
        latest: latestDocker,
        updateAvailable: latestDocker && currentDocker ? latestDocker !== currentDocker && latestDocker > currentDocker : false,
      };
    } catch (e) {
      result.docker = { current: '?', latest: null, updateAvailable: false, error: e.message };
    }

    // ── OS update check (apt-based) ──
    try {
      const raw = execSync('apt list --upgradable 2>/dev/null | tail -n +2', { timeout: 15000, encoding: 'utf8' }).trim();
      const lines = raw ? raw.split('\n').filter(l => l.includes('upgradable')) : [];
      const packages = lines.map(l => {
        const name = l.split('/')[0];
        const versions = l.match(/\[upgradable from: (.*?)\]/);
        const newVer = l.match(/\s(\S+)\s/)?.[1];
        return { name, newVersion: newVer || '?', oldVersion: versions?.[1] || '?' };
      });
      result.os = {
        total: packages.length,
        packages: packages.slice(0, 30), // limit to 30
        updateAvailable: packages.length > 0,
      };
    } catch {
      result.os = { total: 0, packages: [], updateAvailable: false, error: 'apt not available' };
    }

    // ── Docker Dash app version ──
    result.app = { version: '1.5.1' };

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Firewall (UFW) ───────────────────────────────────────────

function runCmd(cmd) {
  try {
    return execSync(cmd, { timeout: 10000, encoding: 'utf8' }).trim();
  } catch (err) {
    return err.stdout?.trim() || err.stderr?.trim() || err.message;
  }
}

router.get('/firewall', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const statusRaw = runCmd('ufw status numbered 2>&1');
    const verboseRaw = runCmd('ufw status verbose 2>&1');

    // Check if ufw is available
    if (statusRaw.includes('command not found') || statusRaw.includes('not found')) {
      // Try iptables as fallback
      const iptables = runCmd('iptables -L -n --line-numbers 2>&1');
      return res.json({
        available: !!iptables && !iptables.includes('not found'),
        backend: 'iptables',
        status: 'unknown',
        rules: [],
        raw: iptables,
      });
    }

    // Parse UFW status
    const isActive = verboseRaw.includes('Status: active');
    const defaultPolicy = verboseRaw.match(/Default:\s*(.*)/)?.[1] || '';
    const logging = verboseRaw.match(/Logging:\s*(.*)/)?.[1] || '';

    // Parse rules
    const rules = [];
    const ruleLines = statusRaw.split('\n');
    for (const line of ruleLines) {
      const match = line.match(/\[\s*(\d+)\]\s+(.*?)\s+(ALLOW|DENY|REJECT|LIMIT)\s+(IN|OUT)?\s*(.*)/);
      if (match) {
        rules.push({
          number: parseInt(match[1]),
          to: match[2].trim(),
          action: match[3],
          direction: (match[4] || 'IN').trim(),
          from: (match[5] || 'Anywhere').trim(),
        });
      }
    }

    // Get listening ports
    const listening = runCmd('ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null');

    res.json({
      available: true,
      backend: 'ufw',
      status: isActive ? 'active' : 'inactive',
      defaultPolicy,
      logging,
      rules,
      listening,
      raw: statusRaw,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/firewall/rule', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const { action, port, proto, from, direction } = req.body;

    if (!action || !port) {
      return res.status(400).json({ error: 'action and port required' });
    }

    // Validate action
    if (!['allow', 'deny', 'limit', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Use: allow, deny, limit, reject' });
    }

    // Build UFW command
    let cmd = `ufw ${action}`;
    if (direction === 'out') cmd += ' out';
    if (from) cmd += ` from ${from}`;
    cmd += ` ${port}`;
    if (proto && proto !== 'any') cmd += `/${proto}`;

    const result = runCmd(`${cmd} 2>&1`);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'firewall_add_rule', details: { action, port, proto, from, direction, result },
      ip: getClientIp(req),
    });

    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/firewall/rule/:number', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const num = parseInt(req.params.number);
    if (!num || num < 1) return res.status(400).json({ error: 'Invalid rule number' });

    const result = runCmd(`echo y | ufw delete ${num} 2>&1`);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'firewall_delete_rule', details: { ruleNumber: num, result },
      ip: getClientIp(req),
    });

    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health Overview ─────────────────────────────────────────
router.get('/health-overview', requireAuth, async (req, res) => {
  try {
    const containers = await dockerService.listContainers(req.hostId);
    const docker = dockerService.getDocker(req.hostId);
    const healthData = [];

    for (const c of containers) {
      try {
        const full = await docker.getContainer(c.id).inspect();
        const health = full.State.Health || null;
        healthData.push({
          id: c.id,
          name: c.name,
          state: c.state,
          status: c.status,
          restartCount: full.RestartCount || 0,
          startedAt: full.State.StartedAt,
          finishedAt: full.State.FinishedAt,
          health: health ? {
            status: health.Status,
            failingStreak: health.FailingStreak,
            lastLog: health.Log?.slice(-3) || [],
          } : null,
          uptime: full.State.Running ? (Date.now() - new Date(full.State.StartedAt).getTime()) : 0,
        });
      } catch { /* skip */ }
    }

    res.json({ containers: healthData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Compose Stack Management ────────────────────────────────
router.post('/compose/:stack/:action', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  const { stack, action } = req.params;
  const validActions = ['up', 'down', 'restart', 'pull'];
  if (!validActions.includes(action)) return res.status(400).json({ error: 'Invalid action' });

  try {
    // Find compose project dir
    const containers = await dockerService.listContainers(req.hostId);
    const stackContainers = containers.filter(c => c.stack === stack);
    if (stackContainers.length === 0) return res.status(404).json({ error: 'Stack not found' });

    // Get compose file path from labels
    const docker = dockerService.getDocker(req.hostId);
    const firstContainer = await docker.getContainer(stackContainers[0].id).inspect();
    const workingDir = firstContainer.Config.Labels?.['com.docker.compose.project.working_dir'] || '';
    const configFile = firstContainer.Config.Labels?.['com.docker.compose.project.config_files'] || '';

    if (!workingDir) return res.status(400).json({ error: 'Cannot determine compose working directory' });

    let cmd;
    switch (action) {
      case 'up': cmd = `cd "${workingDir}" && docker compose up -d`; break;
      case 'down': cmd = `cd "${workingDir}" && docker compose down`; break;
      case 'restart': cmd = `cd "${workingDir}" && docker compose restart`; break;
      case 'pull': cmd = `cd "${workingDir}" && docker compose pull`; break;
    }

    const output = execSync(cmd, { timeout: 120000, encoding: 'utf8' });

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: `compose_${action}`, targetType: 'stack', targetId: stack,
      details: { workingDir }, ip: getClientIp(req),
    });

    res.json({ ok: true, output });
  } catch (err) {
    res.status(500).json({ error: err.stderr || err.message });
  }
});

router.get('/compose/:stack/config', requireAuth, async (req, res) => {
  try {
    const containers = await dockerService.listContainers(req.hostId);
    const stackContainers = containers.filter(c => c.stack === req.params.stack);
    if (stackContainers.length === 0) return res.status(404).json({ error: 'Stack not found' });

    const docker = dockerService.getDocker(req.hostId);
    const firstContainer = await docker.getContainer(stackContainers[0].id).inspect();
    const workingDir = firstContainer.Config.Labels?.['com.docker.compose.project.working_dir'] || '';
    const configFile = firstContainer.Config.Labels?.['com.docker.compose.project.config_files'] || '';

    if (!workingDir) return res.status(400).json({ error: 'Cannot determine compose directory' });

    let config = '';
    try {
      config = execSync(`cd "${workingDir}" && docker compose config 2>/dev/null`, { timeout: 10000, encoding: 'utf8' });
    } catch {
      // Try reading compose files directly
      const fs = require('fs');
      const path = require('path');
      for (const fname of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
        const fp = path.join(workingDir, fname);
        if (fs.existsSync(fp)) { config = fs.readFileSync(fp, 'utf8'); break; }
      }
    }

    res.json({ stack: req.params.stack, workingDir, configFile, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Container Scheduling ────────────────────────────────────
const schedulesFile = '/data/schedules.json';
const fs = require('fs');

function loadSchedules() {
  try {
    if (fs.existsSync(schedulesFile)) return JSON.parse(fs.readFileSync(schedulesFile, 'utf8'));
  } catch { /* ignore */ }
  return [];
}

function saveSchedules(schedules) {
  fs.writeFileSync(schedulesFile, JSON.stringify(schedules, null, 2));
}

router.get('/schedules', requireAuth, (req, res) => {
  res.json(loadSchedules());
});

router.post('/schedules', requireAuth, requireRole('admin', 'operator'), writeable, (req, res) => {
  const { containerId, containerName, action, cron, enabled } = req.body;
  if (!containerId || !action || !cron) return res.status(400).json({ error: 'containerId, action, cron required' });

  const schedules = loadSchedules();
  const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
  const entry = { id, containerId, containerName: containerName || '', action, cron, enabled: enabled !== false, createdAt: new Date().toISOString() };
  schedules.push(entry);
  saveSchedules(schedules);

  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'schedule_create', targetType: 'schedule', targetId: id,
    details: entry, ip: getClientIp(req),
  });

  res.status(201).json(entry);
});

router.delete('/schedules/:id', requireAuth, requireRole('admin'), writeable, (req, res) => {
  let schedules = loadSchedules();
  const idx = schedules.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Schedule not found' });

  schedules.splice(idx, 1);
  saveSchedules(schedules);

  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'schedule_delete', targetType: 'schedule', targetId: req.params.id,
    ip: getClientIp(req),
  });

  res.json({ ok: true });
});

router.put('/schedules/:id', requireAuth, requireRole('admin', 'operator'), writeable, (req, res) => {
  const schedules = loadSchedules();
  const idx = schedules.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Schedule not found' });

  const { enabled, cron, action } = req.body;
  if (enabled !== undefined) schedules[idx].enabled = enabled;
  if (cron) schedules[idx].cron = cron;
  if (action) schedules[idx].action = action;
  saveSchedules(schedules);

  res.json(schedules[idx]);
});

// ─── Backup & Restore ────────────────────────────────────────
router.get('/backup/config', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const db = require('../db');
    // Export settings, alert rules, webhooks, schedules
    const settings = db.prepare('SELECT * FROM settings').all?.() || [];
    const alertRules = db.prepare('SELECT * FROM alert_rules').all?.() || [];
    const users = db.prepare('SELECT id, username, role, active FROM users').all?.() || [];
    const schedules = loadSchedules();

    const backup = {
      version: '1.5.1',
      timestamp: new Date().toISOString(),
      settings, alertRules, users, schedules,
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="docker-dash-backup-${new Date().toISOString().substring(0, 10)}.json"`);
    res.send(JSON.stringify(backup, null, 2));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/backup/restore', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const data = req.body;
    if (!data || !data.version) return res.status(400).json({ error: 'Invalid backup file' });

    const db = require('../db');
    let restored = { settings: 0, alertRules: 0, schedules: 0 };

    // Restore settings
    if (data.settings?.length) {
      const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      for (const s of data.settings) { upsert.run(s.key, s.value); restored.settings++; }
    }

    // Restore alert rules
    if (data.alertRules?.length) {
      for (const r of data.alertRules) {
        try {
          db.prepare(`INSERT OR REPLACE INTO alert_rules (id, name, metric, operator, threshold, duration_seconds, cooldown_seconds, severity, target, enabled, channels, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            r.id, r.name, r.metric, r.operator, r.threshold, r.duration_seconds, r.cooldown_seconds, r.severity, r.target, r.enabled, r.channels || '', r.created_at
          );
          restored.alertRules++;
        } catch { /* skip */ }
      }
    }

    // Restore schedules
    if (data.schedules?.length) {
      saveSchedules(data.schedules);
      restored.schedules = data.schedules.length;
    }

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'config_restore', details: restored, ip: getClientIp(req),
    });

    res.json({ ok: true, restored });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Resource Limits Update ──────────────────────────────────
router.put('/containers/:id/resources', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const { memory, cpuQuota, cpuPeriod } = req.body;
    const docker = dockerService.getDocker(req.hostId);
    const container = docker.getContainer(req.params.id);

    const updateBody = {};
    if (memory !== undefined) updateBody.Memory = memory;
    if (cpuQuota !== undefined) updateBody.CpuQuota = cpuQuota;
    if (cpuPeriod !== undefined) updateBody.CpuPeriod = cpuPeriod || 100000;

    await container.update(updateBody);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'container_update_resources', targetType: 'container', targetId: req.params.id,
      details: updateBody, ip: getClientIp(req),
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Container Templates ─────────────────────────────────
const TEMPLATES = [
  { id: 'nginx', name: 'Nginx', icon: 'fa-globe', category: 'web', description: 'High-performance web server & reverse proxy',
    config: { Image: 'nginx:alpine', ExposedPorts: { '80/tcp': {} }, HostConfig: { PortBindings: { '80/tcp': [{ HostPort: '8080' }] }, RestartPolicy: { Name: 'unless-stopped' } } } },
  { id: 'postgres', name: 'PostgreSQL', icon: 'fa-database', category: 'database', description: 'Powerful open-source relational database',
    config: { Image: 'postgres:16-alpine', Env: ['POSTGRES_PASSWORD=changeme', 'POSTGRES_DB=mydb'], ExposedPorts: { '5432/tcp': {} }, HostConfig: { PortBindings: { '5432/tcp': [{ HostPort: '5432' }] }, RestartPolicy: { Name: 'unless-stopped' } } } },
  { id: 'redis', name: 'Redis', icon: 'fa-bolt', category: 'database', description: 'In-memory data structure store & cache',
    config: { Image: 'redis:7-alpine', ExposedPorts: { '6379/tcp': {} }, HostConfig: { PortBindings: { '6379/tcp': [{ HostPort: '6379' }] }, RestartPolicy: { Name: 'unless-stopped' } } } },
  { id: 'mysql', name: 'MySQL', icon: 'fa-database', category: 'database', description: 'Popular open-source relational database',
    config: { Image: 'mysql:8', Env: ['MYSQL_ROOT_PASSWORD=changeme', 'MYSQL_DATABASE=mydb'], ExposedPorts: { '3306/tcp': {} }, HostConfig: { PortBindings: { '3306/tcp': [{ HostPort: '3306' }] }, RestartPolicy: { Name: 'unless-stopped' } } } },
  { id: 'mongo', name: 'MongoDB', icon: 'fa-leaf', category: 'database', description: 'Document-oriented NoSQL database',
    config: { Image: 'mongo:7', ExposedPorts: { '27017/tcp': {} }, HostConfig: { PortBindings: { '27017/tcp': [{ HostPort: '27017' }] }, RestartPolicy: { Name: 'unless-stopped' } } } },
  { id: 'mariadb', name: 'MariaDB', icon: 'fa-database', category: 'database', description: 'Community-developed fork of MySQL',
    config: { Image: 'mariadb:11', Env: ['MARIADB_ROOT_PASSWORD=changeme', 'MARIADB_DATABASE=mydb'], ExposedPorts: { '3306/tcp': {} }, HostConfig: { PortBindings: { '3306/tcp': [{ HostPort: '3307' }] }, RestartPolicy: { Name: 'unless-stopped' } } } },
  { id: 'adminer', name: 'Adminer', icon: 'fa-table', category: 'tool', description: 'Lightweight database management UI',
    config: { Image: 'adminer:latest', ExposedPorts: { '8080/tcp': {} }, HostConfig: { PortBindings: { '8080/tcp': [{ HostPort: '8081' }] }, RestartPolicy: { Name: 'unless-stopped' } } } },
  { id: 'portainer', name: 'Portainer', icon: 'fa-ship', category: 'tool', description: 'Docker management UI',
    config: { Image: 'portainer/portainer-ce:latest', ExposedPorts: { '9443/tcp': {} }, HostConfig: { Binds: ['/var/run/docker.sock:/var/run/docker.sock', 'portainer_data:/data'], PortBindings: { '9443/tcp': [{ HostPort: '9443' }] }, RestartPolicy: { Name: 'always' } } } },
  { id: 'traefik', name: 'Traefik', icon: 'fa-random', category: 'web', description: 'Modern reverse proxy & load balancer',
    config: { Image: 'traefik:v3.0', Cmd: ['--api.dashboard=true', '--providers.docker'], ExposedPorts: { '80/tcp': {}, '8080/tcp': {} }, HostConfig: { Binds: ['/var/run/docker.sock:/var/run/docker.sock:ro'], PortBindings: { '80/tcp': [{ HostPort: '80' }], '8080/tcp': [{ HostPort: '8082' }] }, RestartPolicy: { Name: 'unless-stopped' } } } },
  { id: 'prometheus', name: 'Prometheus', icon: 'fa-fire', category: 'monitoring', description: 'Metrics collection & monitoring',
    config: { Image: 'prom/prometheus:latest', ExposedPorts: { '9090/tcp': {} }, HostConfig: { PortBindings: { '9090/tcp': [{ HostPort: '9090' }] }, RestartPolicy: { Name: 'unless-stopped' } } } },
  { id: 'grafana', name: 'Grafana', icon: 'fa-chart-line', category: 'monitoring', description: 'Analytics & monitoring dashboards',
    config: { Image: 'grafana/grafana:latest', ExposedPorts: { '3000/tcp': {} }, HostConfig: { PortBindings: { '3000/tcp': [{ HostPort: '3000' }] }, RestartPolicy: { Name: 'unless-stopped' } } } },
  { id: 'rabbitmq', name: 'RabbitMQ', icon: 'fa-exchange-alt', category: 'messaging', description: 'Message broker with management UI',
    config: { Image: 'rabbitmq:3-management-alpine', ExposedPorts: { '5672/tcp': {}, '15672/tcp': {} }, HostConfig: { PortBindings: { '5672/tcp': [{ HostPort: '5672' }], '15672/tcp': [{ HostPort: '15672' }] }, RestartPolicy: { Name: 'unless-stopped' } } } },
];

router.get('/templates', requireAuth, (req, res) => {
  res.json(TEMPLATES);
});

// ─── Health Check Logs ───────────────────────────────────
router.get('/containers/:id/health-logs', requireAuth, async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    const container = docker.getContainer(req.params.id);
    const data = await container.inspect();
    const health = data.State.Health || null;
    if (!health) return res.json({ logs: [], message: 'No health check configured' });
    res.json({
      status: health.Status,
      failingStreak: health.FailingStreak,
      logs: (health.Log || []).map(l => ({
        start: l.Start,
        end: l.End,
        exitCode: l.ExitCode,
        output: l.Output?.trim() || '',
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Network Topology (container connections) ────────────
router.get('/topology', requireAuth, async (req, res) => {
  try {
    const containers = await dockerService.listContainers(req.hostId);
    const docker = dockerService.getDocker(req.hostId);
    const networks = await docker.listNetworks();

    const nodes = [];
    const links = [];
    const networkMap = {};

    // Add container nodes
    for (const c of containers) {
      nodes.push({ id: c.id, label: c.name, type: 'container', state: c.state });
    }

    // Inspect each network to find connections
    for (const net of networks) {
      if (['none', 'host'].includes(net.Name)) continue;
      try {
        const detail = await docker.getNetwork(net.Id).inspect();
        const containerIds = Object.keys(detail.Containers || {});
        if (containerIds.length === 0) continue;

        networkMap[net.Id] = { id: net.Id, name: net.Name, driver: net.Driver, subnet: detail.IPAM?.Config?.[0]?.Subnet || '' };

        // Create links between containers sharing this network
        for (let i = 0; i < containerIds.length; i++) {
          for (let j = i + 1; j < containerIds.length; j++) {
            links.push({ source: containerIds[i], target: containerIds[j], network: net.Name });
          }
        }
      } catch { /* skip */ }
    }

    res.json({ nodes, links, networks: Object.values(networkMap) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Stacks Management ───────────────────────────────────────

router.get('/stacks', requireAuth, async (req, res) => {
  try {
    const containers = await dockerService.listContainers(req.hostId);
    const stacks = {};

    for (const c of containers) {
      const project = c.labels?.['com.docker.compose.project'];
      if (!project) continue;
      if (!stacks[project]) {
        stacks[project] = {
          name: project,
          workingDir: c.labels?.['com.docker.compose.project.working_dir'] || '',
          configFile: c.labels?.['com.docker.compose.project.config_files'] || '',
          containers: [], running: 0, total: 0,
        };
      }
      stacks[project].containers.push({ id: c.id, name: c.name, state: c.state, image: c.image });
      stacks[project].total++;
      if (c.state === 'running') stacks[project].running++;
    }

    res.json(Object.values(stacks));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stacks/:name', requireAuth, async (req, res) => {
  try {
    const containers = await dockerService.listContainers(req.hostId);
    const stackContainers = containers.filter(c => c.labels?.['com.docker.compose.project'] === req.params.name);
    if (stackContainers.length === 0) return res.status(404).json({ error: 'Stack not found' });

    const first = stackContainers[0];
    const workingDir = first.labels?.['com.docker.compose.project.working_dir'] || '';

    let config = '';
    if (workingDir) {
      const path = require('path');
      for (const fname of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
        const fp = path.join(workingDir, fname);
        try {
          if (fs.existsSync(fp)) { config = fs.readFileSync(fp, 'utf8'); break; }
        } catch {}
      }
    }

    // Read .env file if exists
    let envFile = '';
    if (workingDir) {
      const path = require('path');
      const envPath = path.join(workingDir, '.env');
      try { if (fs.existsSync(envPath)) envFile = fs.readFileSync(envPath, 'utf8'); } catch {}
    }

    res.json({
      name: req.params.name,
      workingDir,
      containers: stackContainers.map(c => ({ id: c.id, name: c.name, state: c.state, image: c.image })),
      config,
      envFile,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new stack from scratch
router.post('/stacks', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const { name, dir, yaml, env } = req.body;
    if (!name || !yaml) return res.status(400).json({ error: 'name and yaml required' });

    const path = require('path');
    const targetDir = dir || `/opt/${name}`;

    // Create directory
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Write compose file
    fs.writeFileSync(path.join(targetDir, 'docker-compose.yml'), yaml, 'utf8');

    // Write .env file if provided
    if (env && env.trim()) {
      fs.writeFileSync(path.join(targetDir, '.env'), env.trim() + '\n', 'utf8');
    }

    // Deploy the stack
    const { execSync } = require('child_process');
    const output = execSync(`cd "${targetDir}" && docker compose -p "${name}" up -d 2>&1`, { timeout: 120000, encoding: 'utf8' });

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'stack_create', targetType: 'stack', targetId: name,
      details: { dir: targetDir }, ip: getClientIp(req),
    });

    res.status(201).json({ ok: true, output });
  } catch (err) {
    res.status(500).json({ error: err.stderr || err.message });
  }
});

router.put('/stacks/:name/config', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const { config: yamlContent, workingDir } = req.body;
    if (!yamlContent || !workingDir) return res.status(400).json({ error: 'config and workingDir required' });

    const path = require('path');
    let targetFile = null;
    for (const fname of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
      const fp = path.join(workingDir, fname);
      if (fs.existsSync(fp)) { targetFile = fp; break; }
    }
    if (!targetFile) targetFile = path.join(workingDir, 'docker-compose.yml');

    // Backup existing file
    if (fs.existsSync(targetFile)) {
      fs.copyFileSync(targetFile, targetFile + '.bak');
    }
    fs.writeFileSync(targetFile, yamlContent, 'utf8');

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'stack_config_update', targetType: 'stack', targetId: req.params.name,
      details: { workingDir }, ip: getClientIp(req),
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save .env file for stack
router.post('/stacks/:name/env', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const { env, workingDir } = req.body;
    if (!workingDir) return res.status(400).json({ error: 'workingDir required' });
    const path = require('path');
    const envPath = path.join(workingDir, '.env');
    fs.writeFileSync(envPath, (env || '').trim() + '\n', 'utf8');
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'stack_env_update', targetType: 'stack', targetId: req.params.name,
      ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/stacks/:name/deploy', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const { workingDir } = req.body;
    if (!workingDir) return res.status(400).json({ error: 'workingDir required' });
    const { execSync } = require('child_process');
    const output = execSync(`cd "${workingDir}" && docker compose up -d 2>&1`, { timeout: 120000, encoding: 'utf8' });

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'stack_deploy', targetType: 'stack', targetId: req.params.name,
      details: { workingDir }, ip: getClientIp(req),
    });

    res.json({ ok: true, output });
  } catch (err) {
    res.status(500).json({ error: err.stderr || err.message });
  }
});

module.exports = router;
