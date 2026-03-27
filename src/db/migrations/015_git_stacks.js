'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS git_stacks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      stack_name      TEXT NOT NULL UNIQUE,
      host_id         INTEGER NOT NULL DEFAULT 0,
      repo_url        TEXT NOT NULL,
      branch          TEXT NOT NULL DEFAULT 'main',
      compose_path    TEXT NOT NULL DEFAULT 'docker-compose.yml',
      credential_id   INTEGER,
      env_overrides   TEXT,
      force_redeploy  INTEGER NOT NULL DEFAULT 1,
      re_pull_images  INTEGER NOT NULL DEFAULT 0,
      tls_skip_verify INTEGER NOT NULL DEFAULT 0,
      last_commit_hash    TEXT,
      last_commit_message TEXT,
      last_commit_author  TEXT,
      last_deployed_at    TEXT,
      last_check_at       TEXT,
      status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending','cloning','deploying','running','error','stopped')),
      error_message   TEXT,
      created_by      INTEGER NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (credential_id) REFERENCES git_credentials(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_git_stacks_status ON git_stacks(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_git_stacks_credential ON git_stacks(credential_id)`);
};
