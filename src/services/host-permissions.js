'use strict';

// v8.9.10-alpha.1 — Portainer G02 closure: per-host access control.
// resolveEffectivePermission(userId, hostId, isAdmin) returns
// null / 'view' / 'operate' / 'admin' — the highest level the user has
// for this host via direct grants OR team memberships OR host-group
// memberships. Admins always get 'admin'.

const { getDb } = require('../db');
const teamsService = require('./teams');

const LEVELS = ['view', 'operate', 'admin'];
const rank = (p) => LEVELS.indexOf(p);
const max = (a, b) => (rank(a) > rank(b) ? a : b);

/** Resolve the API's hostId=0 alias to the persisted default-host row. */
function normalizeHostId(hostId) {
  const parsed = Number.parseInt(hostId, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  if (parsed !== 0) return parsed;
  const row = getDb().prepare(
    'SELECT id FROM docker_hosts WHERE is_default = 1 ORDER BY id LIMIT 1'
  ).get();
  return row ? row.id : 0;
}

function _legacyDefaultEnabled() {
  const row = getDb().prepare("SELECT value FROM settings WHERE key='legacy_host_access_default'").get();
  return row && row.value === 'true';
}

/**
 * Return the effective permission level for a user on a host, or null.
 */
function resolveEffectivePermission(userId, hostId, isAdmin) {
  if (isAdmin) return 'admin';
  const effectiveHostId = normalizeHostId(hostId);
  if (!userId || effectiveHostId === null) return null;
  const db = getDb();
  const teamIds = teamsService.teamsForUser(userId);
  // Fetch every relevant grant in one shot.
  const params = [userId, effectiveHostId];
  let teamClause = '', groupClause = '';
  if (teamIds.length) {
    teamClause = ` OR (team_id IN (${teamIds.join(',')}) AND host_id = ?)`;
    params.push(effectiveHostId);
  }
  // Group-membership: get group ids that hostId belongs to.
  const groupRows = db.prepare(
    'SELECT group_id FROM host_group_members WHERE host_id = ?'
  ).all(effectiveHostId);
  const groupIds = groupRows.map(r => r.group_id);
  if (groupIds.length) {
    groupClause = ` OR (host_group_id IN (${groupIds.join(',')}) AND (user_id = ? OR ${teamIds.length ? `team_id IN (${teamIds.join(',')})` : '1=0'}))`;
    params.push(userId);
  }
  const rows = db.prepare(`
    SELECT permission FROM host_permissions
    WHERE ((user_id = ? AND host_id = ?)${teamClause}${groupClause})
  `).all(...params);
  if (rows.length === 0) {
    // Legacy default: pre-upgrade behavior — every user has 'operate'.
    if (_legacyDefaultEnabled()) return 'operate';
    return null;
  }
  return rows.reduce((acc, r) => (acc === null ? r.permission : max(acc, r.permission)), null);
}

/** Filter a list of hostIds to those the user can at least 'view'. */
function filterVisibleHosts(userId, isAdmin, hostIds) {
  if (isAdmin) return hostIds;
  return hostIds.filter(hid => resolveEffectivePermission(userId, hid, false) !== null);
}

function _grantsForTarget(column, id) {
  if (!['host_id', 'host_group_id'].includes(column)) throw new Error('Invalid permission target');
  return getDb().prepare(`
    SELECT hp.*, u.username, t.name AS team_name, hg.name AS host_group_name
    FROM host_permissions hp
    LEFT JOIN users u ON u.id = hp.user_id
    LEFT JOIN teams t ON t.id = hp.team_id
    LEFT JOIN host_groups hg ON hg.id = hp.host_group_id
    WHERE hp.${column} = ?
    ORDER BY hp.granted_at DESC
  `).all(id);
}

function grantsForHost(hostId) {
  return _grantsForTarget('host_id', normalizeHostId(hostId));
}

function grantsForGroup(hostGroupId) {
  return _grantsForTarget('host_group_id', hostGroupId);
}

function grant({ hostId, hostGroupId, userId, teamId, permission }, grantedBy) {
  if (!['view', 'operate', 'admin'].includes(permission)) {
    throw new Error('permission must be view / operate / admin');
  }
  const hasHostId = hostId !== undefined && hostId !== null && hostId !== '';
  const hasHostGroupId = hostGroupId !== undefined && hostGroupId !== null && hostGroupId !== '';
  if ((hasHostId ? 1 : 0) + (hasHostGroupId ? 1 : 0) !== 1) {
    throw new Error('exactly one of hostId or hostGroupId required');
  }
  if ((userId ? 1 : 0) + (teamId ? 1 : 0) !== 1) {
    throw new Error('exactly one of userId or teamId required');
  }
  const effectiveHostId = hasHostId ? normalizeHostId(hostId) : null;
  const db = getDb();
  const existing = db.prepare(`
    SELECT id FROM host_permissions
    WHERE host_id IS ? AND host_group_id IS ? AND user_id IS ? AND team_id IS ?
  `).get(effectiveHostId, hostGroupId || null, userId || null, teamId || null);
  if (existing) {
    db.prepare(`
      UPDATE host_permissions
      SET permission = ?, granted_by = ?, granted_at = datetime('now')
      WHERE id = ?
    `).run(permission, grantedBy || null, existing.id);
    return existing.id;
  }
  const result = db.prepare(`
    INSERT INTO host_permissions
      (host_id, host_group_id, user_id, team_id, permission, granted_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(effectiveHostId, hostGroupId || null, userId || null, teamId || null,
    permission, grantedBy || null);
  return result.lastInsertRowid;
}

function revoke(id) {
  getDb().prepare('DELETE FROM host_permissions WHERE id = ?').run(id);
}

function isLegacyDefaultEnabled() { return _legacyDefaultEnabled(); }

function setLegacyDefault(enabled) {
  getDb().prepare(`
    INSERT INTO settings (key, value) VALUES ('legacy_host_access_default', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(enabled ? 'true' : 'false');
}

module.exports = {
  normalizeHostId, resolveEffectivePermission, filterVisibleHosts,
  grantsForHost, grantsForGroup, grant, revoke,
  isLegacyDefaultEnabled, setLegacyDefault,
};
