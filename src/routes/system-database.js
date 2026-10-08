'use strict';

// v8.2.x further-split: extracted from src/routes/system.js.
// 5 routes covering /database info + cleanup + cleanup-aggressive +
// diagnostics + vacuum. Mounted at `/database`. External URLs
// `/api/system/database/*` unchanged.

const { Router } = require('express');
const dockerService = require('../services/docker');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const { getDb } = require('../db');
const config = require('../config');
const { extractHostId } = require('../middleware/hostId');

const router = Router();
router.use(extractHostId);

router.get('/', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const db = getDb();
    const fs = require('fs');

    const dbPath = config.db.path;
    const dbStat = fs.statSync(dbPath);
    let walSize = 0;
    try { walSize = fs.statSync(dbPath + '-wal').size; } catch (err) { /* WAL file may not exist */ }

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
        } catch (err) { /* table may have been dropped */ }
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/cleanup', requireAuth, requireRole('admin'), writeable, (req, res) => {
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
    } catch (err) { /* table may not exist */ }

    // Alert events
    try {
      const r = db.prepare(`DELETE FROM alert_events WHERE triggered_at < datetime('now', '-' || ? || ' days')`).run(ret.eventDays);
      if (r.changes) deleted.alert_events = r.changes;
    } catch (err) { /* table may not exist */ }

    // Webhook deliveries
    try {
      const r = db.prepare(`DELETE FROM webhook_deliveries WHERE delivered_at < datetime('now', '-' || ? || ' days')`).run(ret.eventDays);
      if (r.changes) deleted.webhook_deliveries = r.changes;
    } catch (err) { /* table may not exist */ }

    // Login attempts
    try {
      const r = db.prepare(`DELETE FROM login_attempts WHERE attempted_at < datetime('now', '-' || ? || ' days')`).run(ret.eventDays);
      if (r.changes) deleted.login_attempts = r.changes;
    } catch (err) { /* table may not exist */ }

    // Expired tokens
    try {
      const r = db.prepare(`DELETE FROM password_reset_tokens WHERE COALESCE(julianday(expires_at),0) <= julianday('now')`).run();
      if (r.changes) deleted.password_reset_tokens = r.changes;
    } catch (err) { /* table may not exist */ }

    const totalDeleted = Object.values(deleted).reduce((a, b) => a + b, 0);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'database_cleanup', details: { deleted, totalDeleted },
      ip: getClientIp(req),
    });

    res.json({ ok: true, deleted, totalDeleted });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Aggressive cleanup — keep only last N hours (default 24)
router.post('/cleanup-aggressive', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const hours = parseInt(req.body.hours) || 24;
    const db = getDb();
    const deleted = {};

    const tables = [
      { name: 'container_stats', col: 'recorded_at' },
      { name: 'container_stats_1m', col: 'bucket' },
      { name: 'container_stats_1h', col: 'bucket' },
      { name: 'docker_events', col: 'event_time' },
      { name: 'audit_log', col: 'created_at' },
      { name: 'health_events', col: 'recorded_at' },
      { name: 'alert_events', col: 'triggered_at' },
      { name: 'webhook_deliveries', col: 'delivered_at' },
      { name: 'login_attempts', col: 'attempted_at' },
      { name: 'notifications', col: 'created_at' },
      { name: 'scan_results', col: 'scanned_at' },
      { name: 'schedule_history', col: 'executed_at' },
      { name: 'password_reset_tokens', col: 'expires_at' },
    ];

    for (const { name, col } of tables) {
      try {
        const r = db.prepare(`DELETE FROM ${name} WHERE ${col} < datetime('now', '-${hours} hours')`).run();
        if (r.changes) deleted[name] = r.changes;
      } catch { /* table may not exist */ }
    }

    const totalDeleted = Object.values(deleted).reduce((a, b) => a + b, 0);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'database_cleanup_aggressive', details: { hours, deleted, totalDeleted },
      ip: getClientIp(req),
    });

    res.json({ ok: true, hours, deleted, totalDeleted });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /database/diagnostics — download full system diagnostic bundle
router.get('/diagnostics', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    const db = getDb();

    const [info, containers, images, volumes, networks] = await Promise.all([
      docker.info().catch(() => ({})),
      dockerService.listContainers(req.hostId).catch(() => []),
      docker.listImages().catch(() => []),
      docker.listVolumes().then(r => r.Volumes || []).catch(() => []),
      docker.listNetworks().catch(() => []),
    ]);

    // Collect recent logs per container (last 20 lines each)
    const containerLogs = {};
    for (const c of containers.slice(0, 20)) {
      try {
        const id = c.id || c.Id;
        const container = docker.getContainer(id);
        const logs = await container.logs({ stdout: true, stderr: true, tail: 20, timestamps: true });
        containerLogs[c.name || id] = logs.toString('utf8').replace(/[\x00-\x08]/g, '').trim().split('\n');
      } catch { /* skip */ }
    }

    // DB stats
    const dbStats = {};
    const tables = ['container_stats', 'audit_log', 'docker_events', 'alert_events', 'scan_results', 'notifications', 'users'];
    for (const t of tables) {
      try { dbStats[t] = db.prepare(`SELECT COUNT(*) AS cnt FROM ${t}`).get()?.cnt || 0; } catch { }
    }

    const bundle = {
      generated: new Date().toISOString(),
      version: require('../version'),
      dockerInfo: {
        serverVersion: info.ServerVersion,
        os: info.OperatingSystem,
        kernel: info.KernelVersion,
        cpus: info.NCPU,
        memTotal: info.MemTotal,
        containers: info.Containers,
        images: info.Images,
        storageDriver: info.Driver,
      },
      containers: containers.map(c => ({
        name: c.name, image: c.image, state: c.state, status: c.status,
        created: c.created, stack: c.stack,
      })),
      images: images.slice(0, 50).map(i => ({
        repoTags: i.RepoTags, size: i.Size, created: i.Created,
      })),
      volumes: volumes.length,
      networks: networks.map(n => ({ name: n.Name, driver: n.Driver })),
      recentLogs: containerLogs,
      databaseStats: dbStats,
      memoryUsage: process.memoryUsage(),
      uptime: process.uptime(),
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="docker-dash-diagnostics-${new Date().toISOString().slice(0,10)}.json"`);
    res.json(bundle);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/vacuum', requireAuth, requireRole('admin'), writeable, (req, res) => {
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
