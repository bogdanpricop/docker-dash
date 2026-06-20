'use strict';

// v8.2.x further-split: extracted from src/routes/misc.js.
// 3 routes for /audit/* — list, export (CSV/JSON/syslog), analytics.
// Mounted at /audit.

const { Router } = require('express');
const auditService = require('../services/audit');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getDb } = require('../db');
const log = require('../utils/logger')('misc');

const router = Router();

router.get('/', requireAuth, requireRole('admin'), (req, res) => {
  // v8.7.33 — cap user-supplied limit at 500 (matches sibling audit.js route).
  const { action, targetType, userId, page, limit, since, until } = req.query;
  const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 500);
  res.json(auditService.query({
    action, targetType, userId: userId ? parseInt(userId) : undefined,
    page: parseInt(page) || 1, limit: safeLimit, since, until,
  }));
});

// ─── Audit CSV Export ───────────────────────────────────────

router.get('/export', requireAuth, requireRole('admin'), (req, res) => {
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
    log.error('audit export', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Audit Analytics ────────────────────────────────────────

router.get('/analytics', requireAuth, requireRole('admin'), (req, res) => {
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
    log.error('audit analytics', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Database Backup ────────────────────────────────────────

module.exports = router;
