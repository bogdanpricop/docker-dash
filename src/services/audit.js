'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');
const config = require('../config');
const log = require('../utils/logger')('audit');

class AuditService {
  constructor() {
    this._onLog = null; // callback for security alerting hook
  }

  /**
   * Register a callback to be called after each audit log entry.
   * Used by security alerting to evaluate rules.
   */
  onLog(callback) {
    this._onLog = callback;
  }

  log({ userId, username, action, targetType, targetId, details, ip, userAgent }) {
    const db = getDb();
    const createdAt = new Date().toISOString();
    const detailsStr = typeof details === 'object' ? JSON.stringify(details) : details || null;

    // Get previous hash for chain
    let prevHash = '0'.repeat(64); // genesis hash
    try {
      const prev = db.prepare('SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1').get();
      if (prev?.entry_hash) prevHash = prev.entry_hash;
    } catch { /* entry_hash column may not exist yet during migration */ }

    // Compute entry hash: SHA-256(prev_hash + canonical entry data)
    const payload = [
      prevHash,
      userId || '',
      username || '',
      action,
      targetType || '',
      targetId || '',
      detailsStr || '',
      ip || '',
      createdAt,
    ].join('|');
    const entryHash = crypto.createHash('sha256').update(payload).digest('hex');

    try {
      db.prepare(`
        INSERT INTO audit_log (user_id, username, action, target_type, target_id, details, ip, user_agent, created_at, entry_hash, prev_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId || null,
        username || null,
        action,
        targetType || null,
        targetId || null,
        detailsStr,
        ip || null,
        userAgent || null,
        createdAt,
        entryHash,
        prevHash
      );
    } catch {
      // Fallback for databases that haven't run the hash chain migration yet
      db.prepare(`
        INSERT INTO audit_log (user_id, username, action, target_type, target_id, details, ip, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId || null,
        username || null,
        action,
        targetType || null,
        targetId || null,
        detailsStr,
        ip || null,
        userAgent || null
      );
    }

    // Fire security alerting hook
    if (this._onLog) {
      try {
        this._onLog({ userId, username, action, targetType, targetId, details: detailsStr, ip, userAgent, createdAt });
      } catch (err) {
        log.error('Security alert evaluation failed', { error: err.message });
      }
    }
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

  /**
   * Verify the integrity of the audit log hash chain.
   * Walks entries in order, recomputes hashes, checks for tampering.
   */
  verify({ fromId, toId } = {}) {
    const db = getDb();
    const where = [];
    const params = [];

    if (fromId) { where.push('id >= ?'); params.push(fromId); }
    if (toId) { where.push('id <= ?'); params.push(toId); }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    const rows = db.prepare(`
      SELECT * FROM audit_log ${whereClause}
      ORDER BY id ASC
    `).all(...params);

    if (rows.length === 0) {
      return { valid: true, entriesChecked: 0, brokenAt: null };
    }

    let expectedPrevHash = null;

    for (const row of rows) {
      // Skip entries without hashes (pre-migration)
      if (!row.entry_hash) continue;

      // Verify prev_hash chain
      if (expectedPrevHash !== null && row.prev_hash !== expectedPrevHash) {
        return {
          valid: false,
          entriesChecked: row.id,
          brokenAt: { id: row.id, reason: 'prev_hash mismatch', expected: expectedPrevHash, actual: row.prev_hash },
        };
      }

      // Recompute entry hash
      const payload = [
        row.prev_hash || '0'.repeat(64),
        row.user_id || '',
        row.username || '',
        row.action,
        row.target_type || '',
        row.target_id || '',
        row.details || '',
        row.ip || '',
        row.created_at,
      ].join('|');
      const computedHash = crypto.createHash('sha256').update(payload).digest('hex');

      if (computedHash !== row.entry_hash) {
        return {
          valid: false,
          entriesChecked: row.id,
          brokenAt: { id: row.id, reason: 'entry_hash mismatch', expectedHash: computedHash, actualHash: row.entry_hash, createdAt: row.created_at },
        };
      }

      expectedPrevHash = row.entry_hash;
    }

    return {
      valid: true,
      entriesChecked: rows.length,
      firstId: rows[0].id,
      lastId: rows[rows.length - 1].id,
      chainStart: rows[0].created_at,
      chainEnd: rows[rows.length - 1].created_at,
      brokenAt: null,
    };
  }

  /**
   * Export audit log entries in various formats.
   * @param {string} format - 'json', 'csv', or 'syslog'
   * @param {object} filters - { since, until, action, userId }
   */
  export(format = 'json', filters = {}) {
    const db = getDb();
    const where = [];
    const params = [];

    if (filters.action) { where.push('action = ?'); params.push(filters.action); }
    if (filters.userId) { where.push('user_id = ?'); params.push(filters.userId); }
    if (filters.since) { where.push('created_at >= ?'); params.push(filters.since); }
    if (filters.until) { where.push('created_at <= ?'); params.push(filters.until); }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    const rows = db.prepare(`
      SELECT * FROM audit_log ${whereClause}
      ORDER BY id ASC
    `).all(...params);

    switch (format) {
      case 'csv':
        return this._toCsv(rows);
      case 'syslog':
        return this._toSyslog(rows);
      case 'json':
      default:
        return JSON.stringify(rows, null, 2);
    }
  }

  _toCsv(rows) {
    if (rows.length === 0) return '';
    const headers = ['id', 'user_id', 'username', 'action', 'target_type', 'target_id', 'details', 'ip', 'user_agent', 'created_at', 'entry_hash', 'prev_hash'];
    const lines = [headers.join(',')];
    for (const row of rows) {
      const values = headers.map(h => {
        const val = row[h];
        if (val === null || val === undefined) return '';
        const str = String(val);
        // Escape CSV: quote if contains comma, newline, or quotes
        if (str.includes(',') || str.includes('\n') || str.includes('"')) {
          return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
      });
      lines.push(values.join(','));
    }
    return lines.join('\n');
  }

  _toSyslog(rows) {
    // RFC 5424 format: <priority>version timestamp hostname app-name procid msgid structured-data msg
    const hostname = require('os').hostname();
    const appName = 'docker-dash';
    const lines = [];

    for (const row of rows) {
      // Priority: facility=10 (security/auth) * 8 + severity
      // severity: 6=info, 4=warning, 2=critical
      const pri = 10 * 8 + 6; // info level by default
      const timestamp = row.created_at || new Date().toISOString();
      const msgId = row.action || '-';
      const esc = (s) => String(s || '').replace(/[\\"\\]\n]/g, (c) => '\\' + c);
      const structuredData = `[audit@0 userId="${esc(row.user_id)}" username="${esc(row.username)}" action="${esc(row.action)}" targetType="${esc(row.target_type)}" targetId="${esc(row.target_id)}" ip="${esc(row.ip)}" hash="${esc(row.entry_hash)}"]`;
      const msg = row.details || '-';

      lines.push(`<${pri}>1 ${timestamp} ${hostname} ${appName} - ${msgId} ${structuredData} ${msg}`);
    }

    return lines.join('\n');
  }

  /** Clean old entries (default: keep 90 days) */
  cleanup(days = 90) {
    const db = getDb();

    // In strict mode, refuse to delete audit entries
    if (config.security.isStrict) {
      log.warn('Audit log cleanup blocked in strict security mode');
      return 0;
    }

    const result = db.prepare(
      `DELETE FROM audit_log WHERE created_at < datetime('now', '-' || ? || ' days')`
    ).run(days);
    return result.changes;
  }
}

module.exports = new AuditService();
