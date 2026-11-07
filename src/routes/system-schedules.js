'use strict';

// v8.2.x further-split: extracted from src/routes/system.js.
// 7 routes covering /schedules CRUD + history + preview + run-now.
// Mounted at `/schedules`. External URL `/api/system/schedules` unchanged.

const { Router } = require('express');
const fs = require('fs');
const dispatch = require('../services/schedule-dispatch');
const { nextScheduleRuns, validScheduleCron } = require('../utils/schedule-cron');
const { randomUUID } = require('node:crypto');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const { getDb } = require('../db');
const { extractHostId } = require('../middleware/hostId');
const { requireHostAccess } = require('../middleware/hostAccess');
const { resolveEffectivePermission } = require('../services/host-permissions');
const config = require('../config');

const router = Router();
router.use(extractHostId);

// Schedule storage — DB-backed with JSON fallback (extracted from system.js)
const schedulesFile = '/data/schedules.json';
const validActions = new Set(['start', 'stop', 'restart', 'pause', 'unpause', 'kill']);
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

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
    return db.prepare(`SELECT s.*, h.name AS host_name FROM scheduled_actions s
      LEFT JOIN docker_hosts h ON h.id = s.host_id ORDER BY s.created_at DESC`).all();
  } catch {
    return null;
  }
}

function canAccess(user, hostId, operate = false) {
  if (user.role === 'admin') return true;
  const permission = resolveEffectivePermission(user.id, hostId ?? 0, false);
  return permission === 'admin' || permission === 'operate' || (!operate && permission === 'view');
}

router.get('/', requireAuth, (req, res) => {
  const dbSchedules = getSchedulesFromDb();
  const now = new Date();
  const nextByCron = new Map();
  const decorate = schedule => {
    if (schedule.enabled && !nextByCron.has(schedule.cron)) nextByCron.set(schedule.cron, nextScheduleRuns(schedule.cron, now)[0] ?? null);
    return { ...schedule, timeZone, nextRunAt: schedule.enabled ? nextByCron.get(schedule.cron) : null };
  };
  if (dbSchedules !== null) {
    return res.json(dbSchedules.filter(s => canAccess(req.user, s.host_id)).map(s => decorate({
      id: s.id, containerId: s.container_id, containerName: s.container_name,
      hostId: s.host_id, hostName: s.host_name, action: s.action, cron: s.cron, enabled: !!s.enabled,
      description: s.description, createdBy: s.created_by, createdAt: s.created_at,
      lastRunAt: s.last_run_at, lastRunStatus: s.last_run_status, runCount: s.run_count,
    })));
  }
  res.json(loadSchedules().filter(s => canAccess(req.user, s.hostId)).map(decorate));
});

router.post('/', requireAuth, requireRole('admin', 'operator'), requireHostAccess('operate'), writeable, (req, res) => {
  const { containerId, containerName, action, cron, enabled, description } = req.body;
  if (!containerId || !action || !cron) return res.status(400).json({ error: 'containerId, action, cron required' });
  if (!validActions.has(action) || !validScheduleCron(cron)) return res.status(400).json({ error: 'Invalid scheduled action or cron expression' });

  const id = randomUUID();

  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO scheduled_actions (id, container_id, container_name, host_id, action, cron, enabled, description, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, containerId, containerName || '', req.resolvedHostId, action, cron, enabled !== false ? 1 : 0, description || '', req.user.username);

    const entry = db.prepare('SELECT * FROM scheduled_actions WHERE id = ?').get(id);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'schedule_create', targetType: 'schedule', targetId: id,
      details: { containerId, hostId: entry.host_id, action, cron }, ip: getClientIp(req),
    });
    return res.status(201).json({
      id: entry.id, containerId: entry.container_id, containerName: entry.container_name,
      hostId: entry.host_id, action: entry.action, cron: entry.cron, enabled: !!entry.enabled,
      createdAt: entry.created_at,
    });
  } catch {
    res.status(503).json({ error: 'Unable to save a schedule for this Docker host', code: 'SCHEDULE_STORAGE_UNAVAILABLE' });
  }
});

// Cron preview — must be before /:id routes
router.get('/preview', requireAuth, (req, res) => {
  const cronExpr = req.query.cron;
  if (!cronExpr) return res.status(400).json({ error: 'cron required' });

  if (!validScheduleCron(cronExpr)) return res.status(400).json({ error: 'Invalid cron expression' });
  res.json({ cron: cronExpr, nextRuns: nextScheduleRuns(cronExpr, new Date(), 5), timeZone });
});

router.get('/catalog', requireAuth, requireRole('admin'), (req, res) => {
  const db = getDb();
  const now = new Date();
  const hostNames = new Map(db.prepare('SELECT id, name FROM docker_hosts').all().map(host => [host.id, host.name]));
  const git = require('../services/git').listStacks().map(stack => ({
    source: 'git', name: stack.stack_name,
    target: (stack.target_host_ids?.length ? stack.target_host_ids : [stack.host_id ?? 0])
      .map(id => hostNames.get(id) || (id ? `Host #${id}` : 'Default Docker host')).join(', '),
    schedule: `Every ${Math.max(stack.polling_interval_seconds || 300, 60)} seconds`,
    enabled: !!stack.polling_enabled, lastRunAt: stack.last_check_at, nextRunAt: null,
    result: stack.status, href: `#/stacks/git/${stack.id}`,
  }));
  const s3 = require('../services/s3-backup').getStatus();
  const cloud = require('../services/pcloud-backup').getStatus();
  const cronEntry = (source, name, schedule, enabled, last, href) => ({
    source, name, target: 'Application instance', schedule, enabled,
    lastRunAt: last?.time || last?.at || null, result: last?.status || null,
    nextRunAt: enabled ? nextScheduleRuns(schedule, now)[0] || null : null, href,
  });
  const backup = [
    cronEntry('backup', 'Local database backup', '0 2 * * *', true, null, '#/system/backup'),
    cronEntry('backup', 'S3 database backup', s3.schedule, s3.enabled, s3.lastBackup, '#/system/backup'),
    cronEntry('backup', 'pCloud database upload', '0 2 * * *', cloud.enabled, cloud.lastBackup?.db, '#/system/backup'),
    cronEntry('backup', 'pCloud stack archive', cloud.schedules?.stack || '0 4 * * 0', cloud.enabled, cloud.lastBackup?.stack, '#/system/backup'),
    cronEntry('backup', 'pCloud audit archive', cloud.schedules?.audit || '5 4 1 * *', cloud.enabled, cloud.lastBackup?.audit, '#/system/backup'),
  ];
  const system = [cronEntry('system', 'Container schedule dispatcher', '* * * * *', !config.features.readOnly, null, '#/system/schedules')];
  res.json({ timeZone, items: [...git, ...backup, ...system] });
});

router.delete('/:id', requireAuth, requireRole('admin'), writeable, (req, res) => {
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

router.put('/:id', requireAuth, requireRole('admin', 'operator'), writeable, (req, res) => {
  const { enabled, cron, action, description } = req.body;
  if ((action !== undefined && !validActions.has(action)) || (cron !== undefined && !validScheduleCron(cron))) {
    return res.status(400).json({ error: 'Invalid scheduled action or cron expression' });
  }

  try {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM scheduled_actions WHERE id = ?').get(req.params.id);
    if (existing) {
      if (!canAccess(req.user, existing.host_id, true)) {
        return res.status(403).json({ error: 'Insufficient permissions for this host', code: 'HOST_ACCESS_DENIED' });
      }
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
  if (!canAccess(req.user, schedules[idx].hostId, true)) {
    return res.status(403).json({ error: 'Insufficient permissions for this host', code: 'HOST_ACCESS_DENIED' });
  }
  if (enabled !== undefined) schedules[idx].enabled = enabled;
  if (cron) schedules[idx].cron = cron;
  if (action) schedules[idx].action = action;
  saveSchedules(schedules);
  res.json(schedules[idx]);
});

// Schedule history
router.get('/:id/history', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const schedule = db.prepare('SELECT host_id FROM scheduled_actions WHERE id = ?').get(req.params.id);
    if (!schedule) return res.json([]);
    if (!canAccess(req.user, schedule.host_id)) {
      return res.status(403).json({ error: 'Insufficient permissions for this host', code: 'HOST_ACCESS_DENIED' });
    }
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
router.post('/:id/run-now', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  try {
    const db = getDb();
    const schedule = db.prepare('SELECT * FROM scheduled_actions WHERE id = ?').get(req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
    if (!canAccess(req.user, schedule.host_id, true)) {
      return res.status(403).json({ error: 'Insufficient permissions for this host', code: 'HOST_ACCESS_DENIED' });
    }

    res.json({ ok: true, ...await dispatch.execute(schedule, db) });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
