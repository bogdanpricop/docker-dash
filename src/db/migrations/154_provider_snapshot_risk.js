'use strict';

// B090 — read-only stale snapshot growth monitoring and daily trend evidence.
exports.up = function up(db) {
  const columns = db.prepare('PRAGMA table_info(provider_vm_snapshots)').all();
  if (!columns.some(column => column.name === 'size_bytes')) {
    db.exec(`ALTER TABLE provider_vm_snapshots ADD COLUMN size_bytes INTEGER
      CHECK(size_bytes IS NULL OR size_bytes >= 0)`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_snapshot_risk_policies (
      host_id INTEGER PRIMARY KEY REFERENCES docker_hosts(id) ON DELETE CASCADE,
      warning_age_days INTEGER NOT NULL CHECK(warning_age_days BETWEEN 1 AND 3650),
      critical_age_days INTEGER NOT NULL CHECK(critical_age_days BETWEEN 2 AND 3650),
      warning_chain_depth INTEGER NOT NULL CHECK(warning_chain_depth BETWEEN 1 AND 64),
      critical_chain_depth INTEGER NOT NULL CHECK(critical_chain_depth BETWEEN 2 AND 64),
      warning_growth_percent INTEGER NOT NULL CHECK(warning_growth_percent BETWEEN 1 AND 10000),
      critical_growth_percent INTEGER NOT NULL CHECK(critical_growth_percent BETWEEN 2 AND 10000),
      version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(critical_age_days > warning_age_days),
      CHECK(critical_chain_depth > warning_chain_depth),
      CHECK(critical_growth_percent > warning_growth_percent)
    );

    CREATE TABLE IF NOT EXISTS provider_snapshot_risk_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      observation_day TEXT NOT NULL CHECK(length(observation_day) = 10),
      observed_at TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      items_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(host_id, observation_day)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_snapshot_risk_history
      ON provider_snapshot_risk_observations(host_id, observation_day DESC);

    CREATE TABLE IF NOT EXISTS provider_snapshot_risk_states (
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      snapshot_id TEXT NOT NULL REFERENCES provider_vm_snapshots(canonical_id) ON DELETE CASCADE,
      severity TEXT NOT NULL CHECK(severity IN ('healthy','unknown','warning','critical')),
      fingerprint TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(host_id, snapshot_id)
    );
  `);
};

exports.down = function down() {};
