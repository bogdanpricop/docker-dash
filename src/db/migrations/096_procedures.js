'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS procedures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      steps_json TEXT NOT NULL DEFAULT '[]',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS procedure_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      procedure_id INTEGER REFERENCES procedures(id) ON DELETE SET NULL,
      procedure_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK(status IN ('running', 'success', 'partial', 'failed', 'cancelled')),
      current_step INTEGER NOT NULL DEFAULT 0,
      total_steps INTEGER NOT NULL DEFAULT 0,
      log_json TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      started_by INTEGER REFERENCES users(id),
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_procedure_runs_procedure
      ON procedure_runs(procedure_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_procedure_runs_status
      ON procedure_runs(status, started_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_procedure_one_active_run
      ON procedure_runs(procedure_id)
      WHERE status = 'running' AND procedure_id IS NOT NULL;
  `);
};
