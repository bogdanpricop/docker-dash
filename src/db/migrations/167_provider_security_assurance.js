'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_security_evidence (
      id TEXT PRIMARY KEY CHECK(id GLOB 'psec_[0-9a-f]*'),
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      resource_kind TEXT NOT NULL CHECK(resource_kind IN
        ('endpoint', 'host', 'virtualMachine', 'artifact')),
      resource_id TEXT NOT NULL,
      resource_name TEXT NOT NULL,
      pack_key TEXT NOT NULL,
      pack_version TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('provider', 'imported_evidence')),
      facts_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL CHECK(length(evidence_hash) = 64),
      observed_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(host_id, resource_kind, resource_id, pack_key)
    );

    CREATE INDEX IF NOT EXISTS idx_provider_security_evidence_host
      ON provider_security_evidence(host_id, resource_kind, updated_at DESC);

    CREATE TABLE IF NOT EXISTS provider_key_providers (
      id TEXT PRIMARY KEY CHECK(id GLOB 'pkpr_[0-9a-f]*'),
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      provider_kind TEXT NOT NULL CHECK(provider_kind IN
        ('native_kms', 'external_kms', 'hgs', 'key_broker')),
      endpoint_origin TEXT NOT NULL,
      secret_ref TEXT NOT NULL,
      health_state TEXT NOT NULL CHECK(health_state IN
        ('healthy', 'degraded', 'unavailable', 'unknown')),
      health_observed_at TEXT NOT NULL,
      certificate_expires_at TEXT,
      affected_resource_ids_json TEXT NOT NULL DEFAULT '[]',
      evidence_hash TEXT NOT NULL CHECK(length(evidence_hash) = 64),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_key_provider_name
      ON provider_key_providers(host_id, lower(name)) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_provider_key_provider_health
      ON provider_key_providers(host_id, health_state, deleted_at);

    CREATE TABLE IF NOT EXISTS provider_confidential_provisioning_plans (
      id TEXT PRIMARY KEY CHECK(id GLOB 'pcvp_[0-9a-f]*'),
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      artifact_id TEXT NOT NULL REFERENCES provider_artifact_catalog(canonical_id) ON DELETE RESTRICT,
      target_host_id TEXT NOT NULL REFERENCES provider_resource_identities(canonical_id) ON DELETE RESTRICT,
      confidential_mode TEXT NOT NULL CHECK(confidential_mode IN
        ('shielded', 'sev', 'sev_es', 'sev_snp', 'tdx')),
      request_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      plan_hash TEXT NOT NULL CHECK(length(plan_hash) = 64),
      allowed INTEGER NOT NULL CHECK(allowed IN (0, 1)),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_provider_confidential_plan_host
      ON provider_confidential_provisioning_plans(host_id, created_at DESC);
  `);
};

exports.down = function (db) {
  db.exec(`
    DROP TABLE IF EXISTS provider_confidential_provisioning_plans;
    DROP TABLE IF EXISTS provider_key_providers;
    DROP TABLE IF EXISTS provider_security_evidence;
  `);
};
