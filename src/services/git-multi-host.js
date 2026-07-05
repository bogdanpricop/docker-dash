'use strict';

// v8.9.7-alpha.1 — Komodo G01 closure (partial): manage the git_stack_targets
// join table so a single git_stacks row can deploy to N hosts.
//
// This service exposes CRUD on the targets. Deploy fan-out is wired in
// src/routes/git-multi-host.js — it calls the existing deployStack() logic
// per target sequentially. Parallel fan-out is a follow-up.

const { getDb } = require('../db');

function listTargets(stackId) {
  const db = getDb();
  return db.prepare(`
    SELECT t.*, h.name AS host_name, h.daemon_type
    FROM git_stack_targets t
    JOIN docker_hosts h ON h.id = t.host_id
    WHERE t.stack_id = ?
    ORDER BY h.name
  `).all(stackId);
}

function setTargets(stackId, hostIds) {
  if (!Array.isArray(hostIds)) throw new Error('hostIds must be an array');
  const db = getDb();
  const stack = db.prepare('SELECT id, host_id FROM git_stacks WHERE id = ?').get(stackId);
  if (!stack) throw Object.assign(new Error('Git stack not found'), { status: 404 });
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM git_stack_targets WHERE stack_id = ?').run(stackId);
    const ins = db.prepare(`INSERT INTO git_stack_targets
      (stack_id, host_id, last_deploy_status) VALUES (?, ?, 'never')`);
    for (const hid of hostIds) ins.run(stackId, hid);
    // Update the legacy scalar host_id to the first target so single-host code
    // paths continue to see something meaningful.
    if (hostIds.length > 0) {
      db.prepare('UPDATE git_stacks SET host_id = ? WHERE id = ?').run(hostIds[0], stackId);
    }
  });
  tx();
  return listTargets(stackId);
}

function updateTargetStatus(stackId, hostId, { commit, status, error }) {
  const db = getDb();
  const existing = db.prepare(
    'SELECT last_deployed_commit FROM git_stack_targets WHERE stack_id = ? AND host_id = ?'
  ).get(stackId, hostId);
  const previousCommit = existing && existing.last_deployed_commit;
  db.prepare(`
    UPDATE git_stack_targets
    SET last_deployed_commit = COALESCE(?, last_deployed_commit),
        last_deployed_at = datetime('now'),
        last_deploy_status = ?,
        last_deploy_error = ?,
        previous_deployed_commit = CASE WHEN ? IS NOT NULL AND ? != last_deployed_commit
                                        THEN last_deployed_commit ELSE previous_deployed_commit END
    WHERE stack_id = ? AND host_id = ?
  `).run(commit || null, status, error || null, commit, commit, stackId, hostId);
  return { previousCommit };
}

module.exports = { listTargets, setTargets, updateTargetStatus };
