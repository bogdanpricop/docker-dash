'use strict';

// v8.3.0 — GitOps drift detection (read-only).
//
// Stores the latest "does the running state match the git-checked-out compose"
// result per git-managed stack. One row per stack (latest only — no history in
// v1). See plans/deep-spec-gitops-drift-detection.md.

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS git_stack_drift (
      stack_id    INTEGER PRIMARY KEY REFERENCES git_stacks(id) ON DELETE CASCADE,
      in_sync     INTEGER NOT NULL DEFAULT 1,
      drift_count INTEGER NOT NULL DEFAULT 0,
      drift_json  TEXT NOT NULL DEFAULT '[]',
      checked_at  TEXT,
      error       TEXT
    )
  `);
};

exports.down = function (db) {
  db.exec('DROP TABLE IF EXISTS git_stack_drift');
};
