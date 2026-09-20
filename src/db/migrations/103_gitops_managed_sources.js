'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gitops_managed_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      git_stack_id INTEGER NOT NULL UNIQUE REFERENCES git_stacks(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL DEFAULT '.docker-dash/fleet.yaml',
      enabled INTEGER NOT NULL DEFAULT 0,
      auto_writeback INTEGER NOT NULL DEFAULT 0,
      last_export_hash TEXT,
      last_commit_hash TEXT,
      last_written_at TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
};

