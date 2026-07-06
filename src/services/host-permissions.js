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

function _legacyDefaultEnabled() {
  const row = getDb().prepare("SELECT value FROM settings WHERE key='legacy_host_access_default'").get();
  return row && row.value === 'true';
}

/**
 * Return the effective permission level for a user on a host, or null.
 */
function resolveEffectivePermission(userId, hostId, isAdmin) {
  if (isAdmin) return 'admin';
  if (!userId || !hostId) return null;
  const db = getDb();
  const teamIds = teamsService.teamsForUser(userId);
  // Fetch every relevant grant in one shot.
  const params = [userId, hostId];
  let teamClause = '', groupClause = '';
  if (teamIds.length) {
    teamClause = ` OR (team_id IN (${teamIds.join(',')}) AND host_id = ?)`;
    params.push(hostId);
  }
  // Group-membership: get group ids that hostId belongs to.
  const groupRows = db.prepare(
    'SELECT group_id FROM host_group_members WHERE host_id = ?'
  ).all(hostId);
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

function grantsForHost(hostId) {
  return getDb().prepare(`
    SELECT hp.*, u.username, t.name AS team_name, hg.name AS host_group_name
    FROM host_permissions hp
    LEFT JOIN users u ON u.id = hp.user_id
    LEFT JOIN teams t ON t.id = hp.team_id
    LEFT JOIN host_groups hg ON hg.id = hp.host_group_id
    WHERE hp.host_id = ?
    ORDER BY hp.granted_at DESC
  `).all(hostId);
}

function grant({ hostId, hostGroupId, userId, teamId, permission }, grantedBy) {
  if (!['view', 'operate', 'admin'].includes(permission)) {
    throw new Error('permission must be view / operate / admin');
  }
  if ((hostId ? 1 : 0) + (hostGroupId ? 1 : 0) !== 1) {
    throw new Error('exactly one of hostId or hostGroupId required');
  }
  if ((userId ? 1 : 0) + (teamId ? 1 : 0) !== 1) {
    throw new Error('exactly one of userId or teamId required');
  }
  const result = getDb().prepare(`
    INSERT INTO host_permissions
      (host_id, host_group_id, user_id, team_id, permission, granted_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(hostId || null, hostGroupId || null, userId || null, teamId || null,
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
  resolveEffectivePermission, filterVisibleHosts, grantsForHost, grant, revoke,
  isLegacyDefaultEnabled, setLegacyDefault,
};
