'use strict';

// v8.2.x further-split: extracted from src/routes/system.js.
// 7 routes covering /schedules CRUD + history + preview + run-now.
// Mounted at `/schedules`. External URL `/api/system/schedules` unchanged.

const { Router } = require('express');
const fs = require('fs');
const dispatch = require('../services/schedule-dispatch');
const { compileScheduleCron, validScheduleCron } = require('../utils/schedule-cron');
const { randomUUID } = require('node:crypto');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const { getDb } = require('../db');
const { extractHostId } = require('../middleware/hostId');
const { requireHostAccess } = require('../middleware/hostAccess');
const { resolveEffectivePermission } = require('../services/host-permissions');

const router = Router();
router.use(extractHostId);

// Schedule storage — DB-backed with JSON fallback (extracted from system.js)
const schedulesFile = '/data/schedules.json';
const validActions = new Set(['start', 'stop', 'restart', 'pause', 'unpause', 'kill']);

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
  if (dbSchedules !== null) {
    return res.json(dbSchedules.filter(s => canAccess(req.user, s.host_id)).map(s => ({
      id: s.id, containerId: s.container_id, containerName: s.container_name,
      hostId: s.host_id, action: s.action, cron: s.cron, enabled: !!s.enabled,
      description: s.description, createdBy: s.created_by, createdAt: s.created_at,
      lastRunAt: s.last_run_at, lastRunStatus: s.last_run_status, runCount: s.run_count,
    })));
  }
  res.json(loadSchedules().filter(s => canAccess(req.user, s.hostId)));
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

  const matches = compileScheduleCron(cronExpr);
  if (!matches) return res.status(400).json({ error: 'Invalid cron expression' });

  const runs = [];
  const now = new Date();
  const check = new Date(now);
  check.setSeconds(0, 0);

  for (let i = 0; i < 60 * 24 * 7 && runs.length < 5; i++) {
    check.setMinutes(check.getMinutes() + 1);
    if (matches(check)) {
      runs.push(check.toISOString());
    }
  }
  res.json({ cron: cronExpr, nextRuns: runs });
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
