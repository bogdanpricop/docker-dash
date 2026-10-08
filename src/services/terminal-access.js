'use strict';

const config = require('../config');
const { getDb } = require('../db');

const MAX_REASON_LENGTH = 500;

function _override() {
  const value = String(config.security.terminalAccessOverride || 'managed').trim().toLowerCase();
  return ['allow', 'deny'].includes(value) ? value : 'managed';
}

function _reason(value) {
  return String(value || '').trim().slice(0, MAX_REASON_LENGTH);
}

function normalizeHostId(value) {
  const raw = String(value);
  if (!/^\d+$/.test(raw)) {
    throw Object.assign(new Error('hostId must be a non-negative integer'), { status: 400 });
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw Object.assign(new Error('hostId must be a non-negative integer'), { status: 400 });
  }
  if (parsed !== 0) return parsed;
  const row = getDb().prepare('SELECT id FROM docker_hosts WHERE is_default = 1 ORDER BY id LIMIT 1').get();
  return row?.id || 0;
}

function _row(scopeKey) {
  return getDb().prepare(`
    SELECT l.scope_key, l.host_id, l.reason, l.updated_by, l.updated_at,
           u.username AS updated_by_username
    FROM terminal_access_locks l
    LEFT JOIN users u ON u.id = l.updated_by
    WHERE l.scope_key = ?
  `).get(scopeKey) || null;
}

function _serialize(row) {
  if (!row) return { locked: false, reason: '', updatedBy: null, updatedAt: null };
  return {
    locked: true,
    reason: row.reason || '',
    updatedBy: row.updated_by_username || null,
    updatedAt: row.updated_at || null,
  };
}

function effective(hostId = 0) {
  const resolvedHostId = normalizeHostId(hostId);
  if (!config.features.exec) {
    return { locked: true, source: 'feature_flag', hostId: resolvedHostId, reason: 'ENABLE_EXEC=false' };
  }

  const override = _override();
  if (override === 'deny') {
    return {
      locked: true,
      source: 'environment',
      hostId: resolvedHostId,
      reason: 'DD_TERMINAL_ACCESS_OVERRIDE=deny',
    };
  }
  if (override === 'allow') {
    return {
      locked: false,
      source: 'environment_recovery',
      hostId: resolvedHostId,
      reason: 'DD_TERMINAL_ACCESS_OVERRIDE=allow',
    };
  }

  const global = _row('global');
  if (global) return { locked: true, source: 'global', hostId: resolvedHostId, reason: global.reason || '' };
  const host = resolvedHostId ? _row(`host:${resolvedHostId}`) : null;
  if (host) return { locked: true, source: 'host', hostId: resolvedHostId, reason: host.reason || '' };
  return { locked: false, source: 'managed', hostId: resolvedHostId, reason: '' };
}

function status(hostId = 0) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT l.scope_key, l.host_id, l.reason, l.updated_by, l.updated_at,
           u.username AS updated_by_username
    FROM terminal_access_locks l
    LEFT JOIN users u ON u.id = l.updated_by
    ORDER BY CASE WHEN l.scope_key = 'global' THEN 0 ELSE 1 END, l.host_id
  `).all();
  const global = rows.find(row => row.scope_key === 'global') || null;
  return {
    featureEnabled: !!config.features.exec,
    override: _override(),
    global: _serialize(global),
    hosts: rows.filter(row => row.host_id !== null).map(row => ({
      hostId: row.host_id,
      ..._serialize(row),
    })),
    effective: effective(hostId),
  };
}

function _set(scopeKey, hostId, locked, reason, userId) {
  const db = getDb();
  if (locked) {
    db.prepare(`
      INSERT INTO terminal_access_locks (scope_key, host_id, reason, updated_by, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(scope_key) DO UPDATE SET
        reason = excluded.reason,
        updated_by = excluded.updated_by,
        updated_at = datetime('now')
    `).run(scopeKey, hostId, _reason(reason), userId || null);
  } else {
    db.prepare('DELETE FROM terminal_access_locks WHERE scope_key = ?').run(scopeKey);
  }
}

function setGlobal({ locked, reason, userId }) {
  _set('global', null, !!locked, reason, userId);
  return status();
}

function setHost(hostId, { locked, reason, userId }) {
  const resolvedHostId = normalizeHostId(hostId);
  const exists = getDb().prepare('SELECT 1 FROM docker_hosts WHERE id = ?').get(resolvedHostId);
  if (!exists) throw Object.assign(new Error('Host not found'), { status: 404 });
  _set(`host:${resolvedHostId}`, resolvedHostId, !!locked, reason, userId);
  return status(resolvedHostId);
}

module.exports = {
  MAX_REASON_LENGTH,
  normalizeHostId,
  effective,
  status,
  setGlobal,
  setHost,
};
