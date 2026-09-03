'use strict';

// Manage the git_stack_targets join table so a single git_stacks row can
// deploy to N Docker-compatible hosts. The git service owns orchestration;
// this module owns validation, persistence, and per-target status.

const { getDb } = require('../db');
const hostPermissions = require('./host-permissions');

function listTargets(stackId) {
  const db = getDb();
  return db.prepare(`
    SELECT t.*, h.name AS host_name, h.daemon_type, h.connection_type,
           h.is_active, h.environment
    FROM git_stack_targets t
    JOIN docker_hosts h ON h.id = t.host_id
    WHERE t.stack_id = ?
    ORDER BY h.name
  `).all(stackId);
}

function normalizeTargetHostIds(hostIds) {
  if (!Array.isArray(hostIds)) throw new Error('target_host_ids must be an array');
  const normalized = [...new Set(hostIds.map((raw) => {
    const hostId = hostPermissions.normalizeHostId(raw);
    if (!Number.isInteger(hostId) || hostId <= 0) throw new Error(`Invalid target host: ${raw}`);
    return hostId;
  }))];
  if (!normalized.length) throw new Error('At least one target host is required');

  const placeholders = normalized.map(() => '?').join(',');
  const rows = getDb().prepare(`
    SELECT id, name, daemon_type, is_active
    FROM docker_hosts
    WHERE id IN (${placeholders})
  `).all(...normalized);
  const byId = new Map(rows.map(row => [row.id, row]));
  for (const hostId of normalized) {
    const host = byId.get(hostId);
    if (!host) throw new Error(`Target host ${hostId} not found`);
    if (!host.is_active) throw new Error(`Target host "${host.name}" is not active`);
    if (!['docker', 'podman'].includes(host.daemon_type || 'docker')) {
      throw new Error(`Target host "${host.name}" is not Docker-compatible`);
    }
  }
  return normalized;
}

function setTargets(stackId, hostIds) {
  const normalized = normalizeTargetHostIds(hostIds);
  const db = getDb();
  const stack = db.prepare('SELECT id, host_id FROM git_stacks WHERE id = ?').get(stackId);
  if (!stack) throw Object.assign(new Error('Git stack not found'), { status: 404 });
  const tx = db.transaction(() => {
    const placeholders = normalized.map(() => '?').join(',');
    db.prepare(`DELETE FROM git_stack_targets
      WHERE stack_id = ? AND host_id NOT IN (${placeholders})`).run(stackId, ...normalized);
    const ins = db.prepare(`INSERT OR IGNORE INTO git_stack_targets
      (stack_id, host_id, last_deploy_status) VALUES (?, ?, 'never')`);
    for (const hostId of normalized) ins.run(stackId, hostId);
    // Update the legacy scalar host_id to the first target so single-host code
    // paths continue to see something meaningful.
    db.prepare('UPDATE git_stacks SET host_id = ? WHERE id = ?').run(normalized[0], stackId);
  });
  tx();
  return listTargets(stackId);
}

function updateTargetStatus(stackId, hostId, { commit, status, error }) {
  if (!['success', 'failed', 'pending', 'never'].includes(status)) {
    throw new Error(`Invalid target deploy status: ${status}`);
  }
  const db = getDb();
  const existing = db.prepare(
    'SELECT last_deployed_commit FROM git_stack_targets WHERE stack_id = ? AND host_id = ?'
  ).get(stackId, hostId);
  const previousCommit = existing && existing.last_deployed_commit;
  db.prepare(`
    UPDATE git_stack_targets
    SET last_deployed_commit = CASE WHEN ? = 'success'
                                    THEN COALESCE(?, last_deployed_commit)
                                    ELSE last_deployed_commit END,
        last_deployed_at = CASE WHEN ? IN ('success', 'failed')
                                THEN datetime('now') ELSE last_deployed_at END,
        last_deploy_status = ?,
        last_deploy_error = ?,
        previous_deployed_commit = CASE WHEN ? = 'success' AND ? IS NOT NULL
                                             AND ? != last_deployed_commit
                                        THEN last_deployed_commit ELSE previous_deployed_commit END
    WHERE stack_id = ? AND host_id = ?
  `).run(
    status, commit || null, status, status, error || null,
    status, commit, commit, stackId, hostId
  );
  return { previousCommit };
}

function markTargetsPending(stackId) {
  getDb().prepare(`
    UPDATE git_stack_targets
    SET last_deploy_status = 'pending', last_deploy_error = NULL
    WHERE stack_id = ?
  `).run(stackId);
  return listTargets(stackId);
}

function restoreTargetState(stackId, hostId, {
  commit = null, previousCommit = null, status = 'success', error = null,
} = {}) {
  if (!['success', 'failed', 'pending', 'never'].includes(status)) {
    throw new Error(`Invalid restored target status: ${status}`);
  }
  getDb().prepare(`
    UPDATE git_stack_targets
    SET last_deployed_commit = ?,
        previous_deployed_commit = ?,
        last_deployed_at = CASE WHEN ? IN ('success', 'failed') THEN datetime('now') ELSE last_deployed_at END,
        last_deploy_status = ?,
        last_deploy_error = ?
    WHERE stack_id = ? AND host_id = ?
  `).run(commit, previousCommit, status, status, error, stackId, hostId);
  return listTargets(stackId).find(target => target.host_id === hostId) || null;
}

module.exports = {
  listTargets, normalizeTargetHostIds, setTargets,
  updateTargetStatus, markTargetsPending, restoreTargetState,
};
