'use strict';
exports.up = db => db.exec(`CREATE TABLE container_replacements (
  id TEXT PRIMARY KEY, host_id INTEGER NOT NULL, daemon_id TEXT NOT NULL,
  container_name TEXT NOT NULL, original_id TEXT NOT NULL, candidate_id TEXT, history_id INTEGER,
  recovery_name TEXT NOT NULL, lock_id TEXT, phase TEXT NOT NULL,
  was_running INTEGER NOT NULL, restart_policy TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  error TEXT
);
CREATE INDEX idx_container_replacements_original ON container_replacements(original_id, host_id);`);
exports.down = () => { throw new Error('Retained replacement recovery records require explicit reconciliation'); };
