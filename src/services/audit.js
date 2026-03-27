'use strict';

const { getDb } = require('../db');

class AuditService {
  log({ userId, username, action, targetType, targetId, details, ip, userAgent }) {
    const db = getDb();
    db.prepare(`
      INSERT INTO audit_log (user_id, username, action, target_type, target_id, details, ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId || null,
      username || null,
      action,
      targetType || null,
      targetId || null,
      typeof details === 'object' ? JSON.stringify(details) : details || null,
      ip || null,
      userAgent || null
    );
  }

  query({ action, targetType, userId, page = 1, limit = 50, since, until } = {}) {
    const db = getDb();
    const where = [];
    const params = [];

    if (action) { where.push('action = ?'); params.push(action); }
    if (targetType) { where.push('target_type = ?'); params.push(targetType); }
    if (userId) { where.push('user_id = ?'); params.push(userId); }
    if (since) { where.push('created_at >= ?'); params.push(since); }
    if (until) { where.push('created_at <= ?'); params.push(until); }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    const offset = (page - 1) * limit;

    const total = db.prepare(`SELECT COUNT(*) as c FROM audit_log ${whereClause}`).get(...params).c;
    const rows = db.prepare(`
      SELECT * FROM audit_log ${whereClause}
      ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return { rows, total, page, limit, pages: Math.ceil(total / limit) };
  }

  /** Clean old entries (default: keep 90 days) */
  cleanup(days = 90) {
    const db = getDb();
    const result = db.prepare(
      `DELETE FROM audit_log WHERE created_at < datetime('now', '-' || ? || ' days')`
    ).run(days);
    return result.changes;
  }
}

module.exports = new AuditService();
