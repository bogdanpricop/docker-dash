'use strict';

// v8.9.9-alpha.1 — Komodo G09 closure: scoped alert channel routing.
// scope_type in {all, host, host_group}. When an alert fires, resolve
// routes in precedence: host > host_group > all. Fallback: the existing
// per-rule channel_id on the alert_rules row.

const { getDb } = require('../db');

function list() {
  return getDb().prepare(`
    SELECT * FROM alert_channel_routes ORDER BY id
  `).all();
}

function create({ scopeType, scopeId, channelId, severityMin = 'info' }) {
  if (!['all', 'host', 'host_group'].includes(scopeType)) {
    throw new Error('scope_type must be one of all, host, host_group');
  }
  if (scopeType !== 'all' && !scopeId) throw new Error('scope_id required when scope_type != all');
  if (!channelId) throw new Error('channel_id required');
  const result = getDb().prepare(`
    INSERT INTO alert_channel_routes (scope_type, scope_id, channel_id, severity_min)
    VALUES (?, ?, ?, ?)
  `).run(scopeType, scopeType === 'all' ? null : scopeId, channelId, severityMin);
  return result.lastInsertRowid;
}

function remove(id) {
  getDb().prepare('DELETE FROM alert_channel_routes WHERE id = ?').run(id);
}

/**
 * Resolve which channels to notify for an alert.
 * @param {{ hostId?: number, severity: 'info'|'warning'|'critical' }} ctx
 * @returns {number[]} channel ids
 */
function resolve({ hostId, severity = 'info' } = {}) {
  const db = getDb();
  const sevRank = { info: 0, warning: 1, critical: 2 };
  const wantRank = sevRank[severity] || 0;
  const channels = new Set();
  // Direct host-scope matches
  if (hostId) {
    const rows = db.prepare(
      `SELECT channel_id, severity_min FROM alert_channel_routes WHERE scope_type='host' AND scope_id=?`
    ).all(hostId);
    for (const r of rows) {
      if ((sevRank[r.severity_min] || 0) <= wantRank) channels.add(r.channel_id);
    }
    if (channels.size) return [...channels];
  }
  // Host-group scope: any group the host belongs to
  if (hostId) {
    const rows = db.prepare(`
      SELECT r.channel_id, r.severity_min
      FROM alert_channel_routes r
      JOIN host_group_members m ON m.group_id = r.scope_id
      WHERE r.scope_type = 'host_group' AND m.host_id = ?
    `).all(hostId);
    for (const r of rows) {
      if ((sevRank[r.severity_min] || 0) <= wantRank) channels.add(r.channel_id);
    }
    if (channels.size) return [...channels];
  }
  // Fallback: scope_type='all' routes
  const rows = db.prepare(
    `SELECT channel_id, severity_min FROM alert_channel_routes WHERE scope_type='all'`
  ).all();
  for (const r of rows) {
    if ((sevRank[r.severity_min] || 0) <= wantRank) channels.add(r.channel_id);
  }
  return [...channels];
}

module.exports = { list, create, remove, resolve };
