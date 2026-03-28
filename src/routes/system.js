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
const { execSync, execFileSync } = require('child_process');
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

    // Strict input validation — prevent command injection
    if (!/^\d{1,5}(:\d{1,5})?$/.test(String(port))) {
      return res.status(400).json({ error: 'Port must be a number or range (e.g., 80 or 8000:9000)' });
    }
    if (from && !/^[\d./]+$/.test(from)) {
      return res.status(400).json({ error: 'From must be an IP address or CIDR (e.g., 192.168.1.0/24)' });
    }
    if (proto && !['tcp', 'udp', 'any'].includes(proto)) {
      return res.status(400).json({ error: 'Protocol must be tcp, udp, or any' });
    }

    // Build UFW args array (no shell interpolation)
    const args = [action];
    if (direction === 'out') args.push('out');
    if (from) { args.push('from', from); }
    args.push(proto && proto !== 'any' ? `${port}/${proto}` : String(port));

    const result = execFileSync('ufw', args, { timeout: 10000, encoding: 'utf8' }).trim();

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

    const result = execFileSync('ufw', ['--force', 'delete', String(num)], { timeout: 10000, encoding: 'utf8' }).trim();

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

    const composeArgs = { up: ['up', '-d'], down: ['down'], restart: ['restart'], pull: ['pull'] };
    const args = ['compose', ...(composeArgs[action] || [])];

    const output = execFileSync('docker', args, { cwd: workingDir, timeout: 120000, encoding: 'utf8', stdio: 'pipe' });

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
      config = execFileSync('docker', ['compose', 'config'], { cwd: workingDir, timeout: 10000, encoding: 'utf8', stdio: 'pipe' });
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

// ─── Compose Validation ──────────────────────────────────────
const fs = require('fs');
const path = require('path');
const os = require('os');

router.post('/stacks/:name/validate', requireAuth, async (req, res) => {
  try {
    const { config: yamlContent, workingDir } = req.body;
    if (!yamlContent) return res.status(400).json({ error: 'config required' });

    // Write to temp file and validate with docker compose
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `dd-validate-${Date.now()}.yml`);
    try {
      fs.writeFileSync(tmpFile, yamlContent, 'utf8');
      execFileSync('docker', ['compose', '-f', tmpFile, 'config', '--quiet'], {
        timeout: 10000, encoding: 'utf8', stdio: 'pipe',
      });
      res.json({ valid: true });
    } catch (err) {
      const errorMsg = err.stderr || err.message || 'Validation failed';
      res.json({ valid: false, error: errorMsg });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Container Scheduling (DB-backed) ───────────────────────
const schedulesFile = '/data/schedules.json';

function loadSchedules() {
  try {
    if (fs.existsSync(schedulesFile)) return JSON.parse(fs.readFileSync(schedulesFile, 'utf8'));
  } catch { /* ignore */ }
  return [];
}

function saveSchedules(schedules) {
  fs.writeFileSync(schedulesFile, JSON.stringify(schedules, null, 2));
}

function getSchedulesFromDb() {
  try {
    const db = getDb();
    return db.prepare('SELECT * FROM scheduled_actions ORDER BY created_at DESC').all();
  } catch {
    // Table doesn't exist yet, fall back to JSON
    return null;
  }
}

router.get('/schedules', requireAuth, (req, res) => {
  const dbSchedules = getSchedulesFromDb();
  if (dbSchedules !== null) {
    return res.json(dbSchedules.map(s => ({
      id: s.id, containerId: s.container_id, containerName: s.container_name,
      hostId: s.host_id, action: s.action, cron: s.cron, enabled: !!s.enabled,
      description: s.description, createdBy: s.created_by, createdAt: s.created_at,
      lastRunAt: s.last_run_at, lastRunStatus: s.last_run_status, runCount: s.run_count,
    })));
  }
  res.json(loadSchedules());
});

router.post('/schedules', requireAuth, requireRole('admin', 'operator'), writeable, (req, res) => {
  const { containerId, containerName, action, cron, enabled, description } = req.body;
  if (!containerId || !action || !cron) return res.status(400).json({ error: 'containerId, action, cron required' });

  const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 4);

  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO scheduled_actions (id, container_id, container_name, host_id, action, cron, enabled, description, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, containerId, containerName || '', req.hostId || 0, action, cron, enabled !== false ? 1 : 0, description || '', req.user.username);

    const entry = db.prepare('SELECT * FROM scheduled_actions WHERE id = ?').get(id);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'schedule_create', targetType: 'schedule', targetId: id,
      details: { containerId, action, cron }, ip: getClientIp(req),
    });
    return res.status(201).json({
      id: entry.id, containerId: entry.container_id, containerName: entry.container_name,
      action: entry.action, cron: entry.cron, enabled: !!entry.enabled,
      createdAt: entry.created_at,
    });
  } catch {
    // Fallback to JSON
    const schedules = loadSchedules();
    const entry = { id, containerId, containerName: containerName || '', action, cron, enabled: enabled !== false, createdAt: new Date().toISOString() };
    schedules.push(entry);
    saveSchedules(schedules);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'schedule_create', targetType: 'schedule', targetId: id,
      details: entry, ip: getClientIp(req),
    });
    res.status(201).json(entry);
  }
});

// Cron preview — must be before /:id routes
router.get('/schedules/preview', requireAuth, (req, res) => {
  const cronExpr = req.query.cron;
  if (!cronExpr) return res.status(400).json({ error: 'cron required' });

  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return res.status(400).json({ error: 'Invalid cron expression' });

  const runs = [];
  const now = new Date();
  const check = new Date(now);
  check.setSeconds(0, 0);

  for (let i = 0; i < 60 * 24 * 7 && runs.length < 5; i++) {
    check.setMinutes(check.getMinutes() + 1);
    if (cronMatchesDate(parts, check)) {
      runs.push(check.toISOString());
    }
  }
  res.json({ cron: cronExpr, nextRuns: runs });
});

router.delete('/schedules/:id', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const db = getDb();
    const existing = db.prepare('SELECT id FROM scheduled_actions WHERE id = ?').get(req.params.id);
    if (existing) {
      db.prepare('DELETE FROM schedule_history WHERE schedule_id = ?').run(req.params.id);
      db.prepare('DELETE FROM scheduled_actions WHERE id = ?').run(req.params.id);
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'schedule_delete', targetType: 'schedule', targetId: req.params.id,
        ip: getClientIp(req),
      });
      return res.json({ ok: true });
    }
  } catch { /* fallback */ }

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
  const { enabled, cron, action, description } = req.body;

  try {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM scheduled_actions WHERE id = ?').get(req.params.id);
    if (existing) {
      if (enabled !== undefined) db.prepare('UPDATE scheduled_actions SET enabled = ?, updated_at = datetime(\'now\') WHERE id = ?').run(enabled ? 1 : 0, req.params.id);
      if (cron) db.prepare('UPDATE scheduled_actions SET cron = ?, updated_at = datetime(\'now\') WHERE id = ?').run(cron, req.params.id);
      if (action) db.prepare('UPDATE scheduled_actions SET action = ?, updated_at = datetime(\'now\') WHERE id = ?').run(action, req.params.id);
      if (description !== undefined) db.prepare('UPDATE scheduled_actions SET description = ?, updated_at = datetime(\'now\') WHERE id = ?').run(description, req.params.id);
      const updated = db.prepare('SELECT * FROM scheduled_actions WHERE id = ?').get(req.params.id);
      return res.json({
        id: updated.id, containerId: updated.container_id, containerName: updated.container_name,
        action: updated.action, cron: updated.cron, enabled: !!updated.enabled,
      });
    }
  } catch { /* fallback */ }

  const schedules = loadSchedules();
  const idx = schedules.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Schedule not found' });
  if (enabled !== undefined) schedules[idx].enabled = enabled;
  if (cron) schedules[idx].cron = cron;
  if (action) schedules[idx].action = action;
  saveSchedules(schedules);
  res.json(schedules[idx]);
});

// Schedule history
router.get('/schedules/:id/history', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const history = db.prepare(`
      SELECT * FROM schedule_history WHERE schedule_id = ?
      ORDER BY executed_at DESC LIMIT 50
    `).all(req.params.id);
    res.json(history);
  } catch {
    res.json([]);
  }
});

// Run schedule now
router.post('/schedules/:id/run-now', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  try {
    const db = getDb();
    const schedule = db.prepare('SELECT * FROM scheduled_actions WHERE id = ?').get(req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Schedule not found' });

    const start = Date.now();
    try {
      await dockerService.containerAction(schedule.container_id, schedule.action, schedule.host_id || 0);
      const duration = Date.now() - start;
      db.prepare(`INSERT INTO schedule_history (schedule_id, container_id, action, status, duration_ms) VALUES (?, ?, ?, 'success', ?)`).run(schedule.id, schedule.container_id, schedule.action, duration);
      db.prepare(`UPDATE scheduled_actions SET last_run_at = datetime('now'), last_run_status = 'success', run_count = run_count + 1 WHERE id = ?`).run(schedule.id);
      res.json({ ok: true, duration });
    } catch (err) {
      const duration = Date.now() - start;
      db.prepare(`INSERT INTO schedule_history (schedule_id, container_id, action, status, error_message, duration_ms) VALUES (?, ?, ?, 'error', ?, ?)`).run(schedule.id, schedule.container_id, schedule.action, err.message, duration);
      db.prepare(`UPDATE scheduled_actions SET last_run_at = datetime('now'), last_run_status = 'error', last_run_error = ? WHERE id = ?`).run(err.message, schedule.id);
      res.status(500).json({ error: err.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function cronMatchesDate(parts, date) {
  const checks = [
    { val: date.getMinutes(), part: parts[0] },
    { val: date.getHours(), part: parts[1] },
    { val: date.getDate(), part: parts[2] },
    { val: date.getMonth() + 1, part: parts[3] },
    { val: date.getDay(), part: parts[4] },
  ];
  return checks.every(({ val, part }) => {
    if (part === '*') return true;
    if (part.includes('/')) {
      const step = parseInt(part.split('/')[1]);
      return step > 0 && val % step === 0;
    }
    if (part.includes(',')) return part.split(',').map(Number).includes(val);
    if (part.includes('-')) {
      const [min, max] = part.split('-').map(Number);
      return val >= min && val <= max;
    }
    return parseInt(part) === val;
  });
}

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
    const output = execFileSync('docker', ['compose', '-p', name, 'up', '-d'], { cwd: targetDir, timeout: 120000, encoding: 'utf8', stdio: 'pipe' });

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
    const output = execFileSync('docker', ['compose', 'up', '-d'], { cwd: workingDir, timeout: 120000, encoding: 'utf8', stdio: 'pipe' });

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
