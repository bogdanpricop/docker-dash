'use strict';

const { Router } = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const auditService = require('../services/audit');
const { getDb } = require('../db');
const log = require('../utils/logger')('secretsRotations');

const router = Router();

function computeStatus(nextDueAt) {
  const due = new Date(nextDueAt).getTime();
  const now = Date.now();
  const days = Math.floor((due - now) / 86400000);
  if (days < 0) return 'overdue';
  if (days <= 14) return 'due_soon';
  return 'ok';
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// GET / — list all tracked rotations with computed status + days-remaining
router.get('/', requireAuth, requireRole('admin', 'operator'), (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM secret_rotation_history h WHERE h.rotation_id = r.id) AS history_count
      FROM secret_rotations r
      ORDER BY r.next_due_at ASC
    `).all();

    const now = Date.now();
    const enriched = rows.map(r => {
      const due = new Date(r.next_due_at).getTime();
      const daysUntilDue = Math.floor((due - now) / 86400000);
      return { ...r, daysUntilDue, status: computeStatus(r.next_due_at) };
    });
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /summary — counts by status
router.get('/summary', requireAuth, requireRole('admin', 'operator'), (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`SELECT next_due_at FROM secret_rotations`).all();
    const summary = { total: rows.length, ok: 0, due_soon: 0, overdue: 0 };
    for (const r of rows) summary[computeStatus(r.next_due_at)]++;
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /bulk — register a list of secrets from the wizard (idempotent on unique key)
// FIX #25 — honour force_update_intervals flag to preserve user-tuned rotation fields
router.post('/bulk', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const { appName = '', hostId = 0, secrets = [], force_update_intervals = false } = req.body;
    if (!Array.isArray(secrets) || secrets.length === 0) {
      return res.status(400).json({ error: 'secrets array required' });
    }
    // v8.7.36 — cap batch size. Each entry runs 2 prepared queries inside
    // the transaction (existence check + insert/update); pre-fix a caller
    // could submit 100k+ entries and pin the DB writer for several
    // seconds. 1000 is generous for any realistic single-app secret
    // inventory (typical apps have 5-30 env vars).
    const MAX_BULK = 1000;
    if (secrets.length > MAX_BULK) {
      return res.status(413).json({ error: `secrets array exceeds max of ${MAX_BULK}; split into multiple bulk calls` });
    }
    const db = getDb();

    // Two prepared statements depending on whether the caller wants to clobber intervals.
    // force_update_intervals = true  → full update (original behaviour)
    // force_update_intervals = false → preserve rotation_interval_days, last_rotated_at, next_due_at, notes
    const stmtFull = db.prepare(`
      INSERT INTO secret_rotations
        (app_name, host_id, env_key, secret_name, secret_type, label, action, rotation_interval_days, last_rotated_at, next_due_at, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, 'ok', ?)
      ON CONFLICT(app_name, host_id, env_key) DO UPDATE SET
        secret_name = excluded.secret_name,
        secret_type = excluded.secret_type,
        label = excluded.label,
        action = excluded.action,
        rotation_interval_days = excluded.rotation_interval_days,
        updated_at = datetime('now')
    `);

    const stmtPreserve = db.prepare(`
      INSERT INTO secret_rotations
        (app_name, host_id, env_key, secret_name, secret_type, label, action, rotation_interval_days, last_rotated_at, next_due_at, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, 'ok', ?)
      ON CONFLICT(app_name, host_id, env_key) DO UPDATE SET
        secret_name = excluded.secret_name,
        label = excluded.label,
        action = excluded.action,
        secret_type = excluded.secret_type,
        updated_at = datetime('now')
    `);

    const now = new Date();
    const tx = db.transaction(() => {
      let inserted = 0;
      let updated = 0;
      let preserved = 0;

      for (const s of secrets) {
        const interval = Number(s.rotation_interval_days ?? s.rotation ?? 180);
        const nextDue = new Date(now.getTime() + interval * 86400000).toISOString().slice(0, 19).replace('T', ' ');
        const appNameStr = String(appName);
        const hostIdNum = Number(hostId) || 0;
        const envKey = String(s.envKey);

        // Check whether this row already exists to track insert vs update counters
        const existing = db.prepare(
          'SELECT id FROM secret_rotations WHERE app_name = ? AND host_id = ? AND env_key = ?'
        ).get(appNameStr, hostIdNum, envKey);

        if (force_update_intervals) {
          stmtFull.run(
            appNameStr, hostIdNum, envKey,
            String(s.secretName || s.envKey),
            String(s.type || 'generic_secret'),
            String(s.label || ''),
            String(s.action || 'manual'),
            interval, nextDue, req.user.id,
          );
          if (existing) { updated++; } else { inserted++; }
        } else {
          stmtPreserve.run(
            appNameStr, hostIdNum, envKey,
            String(s.secretName || s.envKey),
            String(s.type || 'generic_secret'),
            String(s.label || ''),
            String(s.action || 'manual'),
            interval, nextDue, req.user.id,
          );
          if (existing) { preserved++; } else { inserted++; }
        }
      }

      return { inserted, updated, preserved };
    });

    const counts = tx();

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'secret_rotation_register', targetType: 'secret_rotation', targetId: appName,
      details: { appName, hostId, force_update_intervals, ...counts },
      ip: getClientIp(req),
    });
    res.json({ ok: true, ...counts });
  } catch (err) {
    log.error('secrets rotations bulk', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/mark-rotated — mark as rotated now, reset next_due_at
router.post('/:id/mark-rotated', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM secret_rotations WHERE id = ?').get(parseInt(req.params.id));
    if (!row) return res.status(404).json({ error: 'Not found' });

    const { notes = '' } = req.body || {};
    const now = new Date();
    const nextDue = new Date(now.getTime() + row.rotation_interval_days * 86400000)
      .toISOString().slice(0, 19).replace('T', ' ');

    db.transaction(() => {
      db.prepare(`UPDATE secret_rotations
        SET last_rotated_at = datetime('now'), next_due_at = ?, status = 'ok', updated_at = datetime('now')
        WHERE id = ?`).run(nextDue, row.id);
      db.prepare(`INSERT INTO secret_rotation_history (rotation_id, rotated_by, rotated_by_name, status, notes)
        VALUES (?, ?, ?, 'rotated', ?)`)
        .run(row.id, req.user.id, req.user.username || '', String(notes));
    })();

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'secret_rotation_mark', targetType: 'secret_rotation', targetId: String(row.id),
      details: { envKey: row.env_key, appName: row.app_name, notes },
      ip: getClientIp(req),
    });
    res.json({ ok: true, nextDueAt: nextDue });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /:id — update interval / notes
router.patch('/:id', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM secret_rotations WHERE id = ?').get(parseInt(req.params.id));
    if (!row) return res.status(404).json({ error: 'Not found' });

    const { rotation_interval_days, notes } = req.body || {};
    const interval = rotation_interval_days != null ? Number(rotation_interval_days) : row.rotation_interval_days;
    const nextDue = addDays(row.last_rotated_at, interval);

    db.prepare(`UPDATE secret_rotations
      SET rotation_interval_days = ?, notes = ?, next_due_at = ?, updated_at = datetime('now')
      WHERE id = ?`).run(interval, notes ?? row.notes, nextDue, row.id);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /:id — untrack
router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM secret_rotations WHERE id = ?').get(parseInt(req.params.id));
    if (!row) return res.status(404).json({ error: 'Not found' });

    db.prepare('DELETE FROM secret_rotations WHERE id = ?').run(row.id);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'secret_rotation_delete', targetType: 'secret_rotation', targetId: String(row.id),
      details: { envKey: row.env_key, appName: row.app_name },
      ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id/history
router.get('/:id/history', requireAuth, requireRole('admin', 'operator'), (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM secret_rotation_history WHERE rotation_id = ? ORDER BY rotated_at DESC LIMIT 100
    `).all(parseInt(req.params.id));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
