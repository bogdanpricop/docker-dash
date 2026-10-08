'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_security_findings (
      id TEXT PRIMARY KEY CHECK(id GLOB 'psfd_[0-9a-f]*'),
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      inventory_id INTEGER NOT NULL REFERENCES lifecycle_version_inventory(id) ON DELETE RESTRICT,
      advisory_catalog_id INTEGER NOT NULL REFERENCES lifecycle_update_catalog(id) ON DELETE RESTRICT,
      resource_kind TEXT NOT NULL CHECK(resource_kind IN ('endpoint','host','virtualMachine')),
      resource_id TEXT NOT NULL,
      resource_name TEXT NOT NULL,
      advisory_id TEXT NOT NULL,
      cve_ids_json TEXT NOT NULL DEFAULT '[]',
      severity TEXT NOT NULL CHECK(severity IN ('info','low','medium','high','critical')),
      priority_score INTEGER NOT NULL CHECK(priority_score BETWEEN 0 AND 100),
      confidence TEXT NOT NULL CHECK(confidence IN ('low','medium','high')),
      exposure_json TEXT NOT NULL DEFAULT '{}',
      match_evidence_json TEXT NOT NULL DEFAULT '{}',
      evidence_hash TEXT NOT NULL CHECK(length(evidence_hash) = 64),
      state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','excepted','planned','remediated')),
      observed_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(host_id, inventory_id, advisory_catalog_id, resource_id)
    );

    CREATE INDEX IF NOT EXISTS idx_provider_security_findings_host
      ON provider_security_findings(host_id, state, priority_score DESC, updated_at DESC);

    CREATE TABLE IF NOT EXISTS provider_security_finding_exceptions (
      id TEXT PRIMARY KEY CHECK(id GLOB 'psfx_[0-9a-f]*'),
      finding_id TEXT NOT NULL REFERENCES provider_security_findings(id) ON DELETE CASCADE,
      owner TEXT NOT NULL,
      reason TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      compensating_controls_json TEXT NOT NULL,
      exception_hash TEXT NOT NULL CHECK(length(exception_hash) = 64),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      revoked_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_provider_security_exceptions_finding
      ON provider_security_finding_exceptions(finding_id, expires_at DESC, revoked_at);

    CREATE TABLE IF NOT EXISTS provider_security_remediation_plans (
      id TEXT PRIMARY KEY CHECK(id GLOB 'psrp_[0-9a-f]*'),
      finding_id TEXT NOT NULL REFERENCES provider_security_findings(id) ON DELETE RESTRICT,
      action_key TEXT NOT NULL,
      risk TEXT NOT NULL CHECK(risk IN ('low','moderate','high')),
      steps_json TEXT NOT NULL,
      downtime_seconds INTEGER NOT NULL CHECK(downtime_seconds BETWEEN 0 AND 604800),
      dependencies_json TEXT NOT NULL,
      rollback_json TEXT NOT NULL,
      dry_run_json TEXT NOT NULL,
      plan_hash TEXT NOT NULL UNIQUE CHECK(length(plan_hash) = 64),
      allowed INTEGER NOT NULL CHECK(allowed IN (0,1)),
      state TEXT NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','blocked','executing','succeeded','failed','rollback_required')),
      expires_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_provider_security_remediation_plans_finding
      ON provider_security_remediation_plans(finding_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS provider_security_remediation_runs (
      id TEXT PRIMARY KEY CHECK(id GLOB 'psrr_[0-9a-f]*'),
      plan_id TEXT NOT NULL REFERENCES provider_security_remediation_plans(id) ON DELETE RESTRICT,
      adapter_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('executing','succeeded','failed','rollback_required')),
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started IN (0,1)),
      evidence_json TEXT NOT NULL DEFAULT '{}',
      evidence_hash TEXT NOT NULL CHECK(length(evidence_hash) = 64),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_provider_security_remediation_runs_plan
      ON provider_security_remediation_runs(plan_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS provider_secret_reference_validations (
      id TEXT PRIMARY KEY CHECK(id GLOB 'psrv_[0-9a-f]*'),
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      document_kind TEXT NOT NULL CHECK(document_kind IN ('manifest','job','template')),
      document_hash TEXT NOT NULL CHECK(length(document_hash) = 64),
      reference_hashes_json TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL CHECK(state IN ('valid','invalid')),
      findings_json TEXT NOT NULL DEFAULT '[]',
      network_calls_started INTEGER NOT NULL DEFAULT 0 CHECK(network_calls_started = 0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(host_id, document_kind, document_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_provider_secret_validations_host
      ON provider_secret_reference_validations(host_id, created_at DESC);
  `);
};

exports.down = function (db) {
  db.exec(`
    DROP TABLE IF EXISTS provider_secret_reference_validations;
    DROP TABLE IF EXISTS provider_security_remediation_runs;
    DROP TABLE IF EXISTS provider_security_remediation_plans;
    DROP TABLE IF EXISTS provider_security_finding_exceptions;
    DROP TABLE IF EXISTS provider_security_findings;
  `);
};
