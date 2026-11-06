'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS git_preview_configs (
      stack_id INTEGER PRIMARY KEY REFERENCES git_stacks(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id),
      ttl_minutes INTEGER NOT NULL DEFAULT 1440,
      url_template TEXT,
      allow_forks INTEGER NOT NULL DEFAULT 0,
      cpu_limit REAL NOT NULL DEFAULT 1,
      memory_limit_mb INTEGER NOT NULL DEFAULT 512,
      env_encrypted TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS git_preview_environments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stack_id INTEGER NOT NULL REFERENCES git_stacks(id) ON DELETE CASCADE,
      provider TEXT NOT NULL DEFAULT 'github',
      repository TEXT NOT NULL,
      head_repository_url TEXT,
      pr_number INTEGER NOT NULL,
      head_ref TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      project_name TEXT NOT NULL UNIQUE,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id),
      url TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','deploying','running','error','deleting','expired')),
      expires_at TEXT NOT NULL,
      deployed_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(stack_id, pr_number)
    );
    CREATE INDEX IF NOT EXISTS idx_git_previews_expiry
      ON git_preview_environments(status, expires_at);
  `);
};
