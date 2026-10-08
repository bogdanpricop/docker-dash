'use strict';

// v8.9.7-alpha.1 — Gap Closure Komodo G01.
// Multi-host git stack targets: join table lets a single git_stacks row
// deploy to N hosts. Backfills existing single-host stacks from
// git_stacks.host_id to preserve backward compatibility.

exports.up = function (db) {
  // Guard: only run if git_stacks table exists (defensive — migration 015
  // creates it, but this migration should be idempotent).
  const gitStacksExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='git_stacks'`
  ).get();
  if (!gitStacksExists) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS git_stack_targets (
      stack_id INTEGER NOT NULL REFERENCES git_stacks(id) ON DELETE CASCADE,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      last_deployed_commit TEXT,
      last_deployed_at TEXT,
      last_deploy_status TEXT CHECK(last_deploy_status IN ('success', 'failed', 'pending', 'never')) DEFAULT 'never',
      last_deploy_error TEXT,
      previous_deployed_commit TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (stack_id, host_id)
    );

    CREATE INDEX IF NOT EXISTS idx_git_stack_targets_host ON git_stack_targets(host_id);
  `);

  // Backfill: resolve the legacy host_id=0 local alias to the persisted
  // default-host row before inserting into the FK-backed target table.
  const hasHostIdCol = db.prepare('PRAGMA table_info(git_stacks)').all()
    .some(c => c.name === 'host_id');
  if (hasHostIdCol) {
    db.exec(`
      INSERT OR IGNORE INTO git_stack_targets (stack_id, host_id, last_deployed_commit, last_deployed_at, last_deploy_status)
      SELECT gs.id,
             CASE WHEN gs.host_id = 0 THEN defaults.id ELSE gs.host_id END,
             NULL, NULL, 'never'
      FROM git_stacks gs
      LEFT JOIN (
        SELECT id FROM docker_hosts WHERE is_default = 1 ORDER BY id LIMIT 1
      ) defaults ON 1 = 1
      WHERE gs.host_id IS NOT NULL
        AND (gs.host_id != 0 OR defaults.id IS NOT NULL);
    `);
  }
};
