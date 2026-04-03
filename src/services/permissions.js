'use strict';

const { getDb } = require('../db');
const log = require('../utils/logger')('permissions');

const ROLE_HIERARCHY = { none: 0, view: 1, operate: 2, admin: 3 };

/**
 * Get the effective role for a user on a specific stack.
 * Per-stack permission overrides global role. If no per-stack permission, use global role.
 * @param {number} userId
 * @param {string} stackName
 * @param {string} globalRole - user's global role (admin/operator/viewer)
 * @returns {string} effective role: 'none' | 'view' | 'operate' | 'admin'
 */
function getEffectiveRole(userId, stackName, globalRole) {
  // Global admins always have full access (cannot be restricted per-stack)
  if (globalRole === 'admin') return 'admin';

  if (!stackName || stackName === '_standalone') {
    return mapGlobalToPermission(globalRole);
  }

  try {
    const db = getDb();
    const row = db.prepare(
      'SELECT permission FROM stack_permissions WHERE user_id = ? AND stack_name = ?'
    ).get(userId, stackName);

    if (row) return row.permission;
  } catch (err) {
    log.error('Error checking stack permission', err);
  }

  // Fallback to global role mapping
  return mapGlobalToPermission(globalRole);
}

/**
 * Map global role to permission level
 */
function mapGlobalToPermission(role) {
  switch (role) {
    case 'admin': return 'admin';
    case 'operator': return 'operate';
    case 'viewer': return 'view';
    default: return 'view';
  }
}

/**
 * Check if effective role has at least the required level
 */
function hasPermission(effectiveRole, requiredLevel) {
  return (ROLE_HIERARCHY[effectiveRole] || 0) >= (ROLE_HIERARCHY[requiredLevel] || 0);
}

/**
 * List all per-stack permissions for a user
 */
function listUserPermissions(userId) {
  const db = getDb();
  return db.prepare(`
    SELECT sp.*, u.username AS granted_by_username
    FROM stack_permissions sp
    LEFT JOIN users u ON u.id = sp.granted_by
    WHERE sp.user_id = ?
    ORDER BY sp.stack_name
  `).all(userId);
}

/**
 * List all per-stack permissions (for admin view)
 */
function listAllPermissions() {
  const db = getDb();
  return db.prepare(`
    SELECT sp.*, u.username, g.username AS granted_by_username
    FROM stack_permissions sp
    JOIN users u ON u.id = sp.user_id
    LEFT JOIN users g ON g.id = sp.granted_by
    ORDER BY sp.stack_name, u.username
  `).all();
}

/**
 * Set a per-stack permission for a user
 */
function setPermission(stackName, userId, permission, grantedBy) {
  const db = getDb();
  db.prepare(`
    INSERT INTO stack_permissions (stack_name, user_id, permission, granted_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(stack_name, user_id) DO UPDATE SET
      permission = excluded.permission,
      granted_by = excluded.granted_by,
      created_at = datetime('now')
  `).run(stackName, userId, permission, grantedBy);
  log.info(`Stack permission set: user=${userId} stack=${stackName} perm=${permission} by=${grantedBy}`);
}

/**
 * Remove a per-stack permission (revert to global role)
 */
function removePermission(stackName, userId) {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM stack_permissions WHERE stack_name = ? AND user_id = ?'
  ).run(stackName, userId);
  log.info(`Stack permission removed: user=${userId} stack=${stackName} (${result.changes} rows)`);
  return result.changes > 0;
}

/**
 * Remove all permissions for a stack (used when stack is deleted)
 */
function removeAllForStack(stackName) {
  const db = getDb();
  return db.prepare('DELETE FROM stack_permissions WHERE stack_name = ?').run(stackName);
}

/**
 * Filter a container list based on user's effective permissions
 * Returns only containers the user can see (permission >= 'view')
 */
function filterContainers(containers, userId, globalRole) {
  // Global admins see everything
  if (globalRole === 'admin') return containers;

  // Preload all user permissions for efficiency
  const perms = {};
  try {
    const db = getDb();
    const rows = db.prepare('SELECT stack_name, permission FROM stack_permissions WHERE user_id = ?').all(userId);
    for (const r of rows) {
      perms[r.stack_name] = r.permission;
    }
  } catch (err) {
    log.error('Error loading permissions for filter', err);
    return containers; // fail open
  }

  return containers.filter(c => {
    const stack = c.stack || c.Labels?.['com.docker.compose.project'] || '_standalone';
    const perm = perms[stack]; // undefined means use global role
    if (perm === 'none') return false;
    if (perm) return true; // view, operate, admin all can see
    return true; // no per-stack override = use global (which is at least viewer)
  });
}

module.exports = {
  getEffectiveRole,
  hasPermission,
  listUserPermissions,
  listAllPermissions,
  setPermission,
  removePermission,
  removeAllForStack,
  filterContainers,
  mapGlobalToPermission,
  ROLE_HIERARCHY,
};
