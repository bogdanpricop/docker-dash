'use strict';

// B096 — bounded, read-only NFS/SMB repository health observations.
exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS storage_repository_endpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      protocol TEXT NOT NULL CHECK(protocol IN ('nfs','smb')),
      hostname TEXT NOT NULL,
      port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
      repository_path TEXT NOT NULL,
      secret_id INTEGER REFERENCES secrets_vault(id) ON DELETE SET NULL,
      write_test_enabled INTEGER NOT NULL DEFAULT 0 CHECK(write_test_enabled IN (0,1)),
      warning_latency_ms INTEGER NOT NULL DEFAULT 500 CHECK(warning_latency_ms BETWEEN 1 AND 30000),
      critical_latency_ms INTEGER NOT NULL DEFAULT 2000 CHECK(critical_latency_ms BETWEEN 2 AND 30000),
      interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK(interval_minutes BETWEEN 15 AND 1440),
      is_enabled INTEGER NOT NULL DEFAULT 1 CHECK(is_enabled IN (0,1)),
      version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(critical_latency_ms > warning_latency_ms)
    );

    CREATE TABLE IF NOT EXISTS storage_repository_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repository_id INTEGER NOT NULL REFERENCES storage_repository_endpoints(id) ON DELETE CASCADE,
      observed_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('healthy','unknown','degraded','unavailable','critical')),
      latency_ms INTEGER CHECK(latency_ms IS NULL OR latency_ms >= 0),
      stages_json TEXT NOT NULL,
      addresses_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      write_test INTEGER NOT NULL DEFAULT 0 CHECK(write_test IN (0,1)),
      cleanup_proven INTEGER CHECK(cleanup_proven IS NULL OR cleanup_proven IN (0,1)),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_storage_repository_observations_history
      ON storage_repository_observations(repository_id, observed_at DESC);

    CREATE TABLE IF NOT EXISTS storage_repository_states (
      repository_id INTEGER PRIMARY KEY REFERENCES storage_repository_endpoints(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK(state IN ('healthy','unknown','degraded','unavailable','critical')),
      fingerprint TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
};

exports.down = function down() {};
