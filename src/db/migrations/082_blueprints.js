'use strict';

// v8.9.42-alpha.1 — Declarative Reconciler ("Estate Blueprint"). A blueprint is a
// Git-friendly JSON desired-state document; docker-dash plans (diff) and applies
// (converges) it through the existing firewall primitives. blueprint_runs keeps a
// plan/apply/drift history.

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS blueprints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      doc TEXT NOT NULL,                     -- canonical JSON desired-state
      enforce INTEGER NOT NULL DEFAULT 0,    -- opt-in auto-apply on drift
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_plan_at TEXT,
      last_apply_at TEXT
    );

    CREATE TABLE IF NOT EXISTS blueprint_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      blueprint_id INTEGER NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,                    -- plan | apply | drift
      summary TEXT,                          -- JSON: counts / details
      by TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_blueprint_runs_bp_time
      ON blueprint_runs(blueprint_id, at);
  `);
};
