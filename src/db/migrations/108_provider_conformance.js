'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_conformance_runs (
      id TEXT PRIMARY KEY,
      schema_version TEXT NOT NULL DEFAULT '1.0',
      host_id INTEGER REFERENCES docker_hosts(id) ON DELETE SET NULL,
      provider_type TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('static', 'live_readonly')),
      state TEXT NOT NULL DEFAULT 'running' CHECK(state IN ('running', 'passed', 'warning', 'failed')),
      grade TEXT CHECK(grade IN ('certified', 'conditional', 'failed')),
      score INTEGER NOT NULL DEFAULT 0 CHECK(score >= 0),
      max_score INTEGER NOT NULL DEFAULT 0 CHECK(max_score >= 0),
      manifest_hash TEXT NOT NULL,
      evidence_hash TEXT,
      provider_version TEXT,
      api_version TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_provider_conformance_host
      ON provider_conformance_runs(host_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provider_conformance_provider
      ON provider_conformance_runs(provider_type, created_at DESC);

    CREATE TABLE IF NOT EXISTS provider_conformance_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES provider_conformance_runs(id) ON DELETE CASCADE,
      check_key TEXT NOT NULL,
      category TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('passed', 'warning', 'failed', 'skipped')),
      weight INTEGER NOT NULL DEFAULT 1 CHECK(weight BETWEEN 0 AND 100),
      duration_ms INTEGER NOT NULL DEFAULT 0 CHECK(duration_ms >= 0),
      message TEXT,
      evidence_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_id, check_key)
    );

    CREATE INDEX IF NOT EXISTS idx_provider_conformance_checks_run
      ON provider_conformance_checks(run_id, id);
  `);
};

exports.down = function (db) {
  db.exec(`
    DROP TABLE IF EXISTS provider_conformance_checks;
    DROP TABLE IF EXISTS provider_conformance_runs;
  `);
};
