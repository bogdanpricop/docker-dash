'use strict';

// Repair databases that applied the first git_stack_targets migration while
// legacy Git stacks still used host_id=0 as the local/default-host alias.
exports.up = function (db) {
  const hasTables = db.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'table' AND name IN ('git_stacks', 'git_stack_targets', 'docker_hosts')
  `).get().count === 3;
  if (!hasTables) return;

  const defaultHost = db.prepare(`
    SELECT id FROM docker_hosts WHERE is_default = 1 ORDER BY id LIMIT 1
  `).get();
  if (!defaultHost) return;

  db.prepare('DELETE FROM git_stack_targets WHERE host_id = 0').run();
  db.prepare('UPDATE git_stacks SET host_id = ? WHERE host_id = 0').run(defaultHost.id);
  db.prepare(`
    INSERT OR IGNORE INTO git_stack_targets
      (stack_id, host_id, last_deployed_commit, last_deployed_at, last_deploy_status)
    SELECT id, host_id, last_commit_hash, last_deployed_at,
           CASE WHEN last_deployed_at IS NULL THEN 'never'
                WHEN status = 'running' THEN 'success'
                WHEN status = 'error' THEN 'failed'
                ELSE 'never' END
    FROM git_stacks
    WHERE host_id IS NOT NULL
  `).run();
};
