'use strict';

const PERMISSIONS = [
  ['infrastructure_gitops.manage', 'infrastructure_gitops', 'manage', 'Manage infrastructure drift, reconciliation and external plan evidence'],
  ['infrastructure_webhook.manage', 'infrastructure_webhook', 'manage', 'Manage signed runbook webhook triggers'],
];

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS infrastructure_resource_manifests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      manifest_kind TEXT NOT NULL CHECK(manifest_kind IN ('storage','network')),
      name TEXT NOT NULL,
      provider_host_id INTEGER NOT NULL DEFAULT 0,
      resource_id TEXT,
      schema_version TEXT NOT NULL DEFAULT 'docker-dash.io/v1alpha1',
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
      ownership_mode TEXT NOT NULL CHECK(ownership_mode IN ('managed','shared','external')),
      owner TEXT NOT NULL,
      deletion_protection INTEGER NOT NULL DEFAULT 1,
      document_json TEXT NOT NULL,
      document_hash TEXT NOT NULL,
      resource_versions_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(manifest_kind,provider_host_id,name)
    );
    CREATE INDEX IF NOT EXISTS idx_infrastructure_resource_manifest_target
      ON infrastructure_resource_manifests(provider_host_id,manifest_kind,resource_id);

    CREATE TABLE IF NOT EXISTS infrastructure_reconcile_controllers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      manifest_source TEXT NOT NULL CHECK(manifest_source IN ('core','resource')),
      manifest_id INTEGER NOT NULL,
      scope_type TEXT NOT NULL CHECK(scope_type IN ('resource','host','fabric')),
      scope_key TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'observe' CHECK(mode IN ('observe','continuous')),
      interval_seconds INTEGER NOT NULL DEFAULT 900 CHECK(interval_seconds BETWEEN 60 AND 86400),
      conflict_policy TEXT NOT NULL DEFAULT 'pause' CHECK(conflict_policy='pause'),
      enabled INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'idle' CHECK(state IN ('idle','in_sync','drifted','paused','conflict','error')),
      pause_reason TEXT,
      observation_json TEXT NOT NULL DEFAULT '{}',
      observation_versions_json TEXT NOT NULL DEFAULT '{}',
      last_state_hash TEXT,
      last_plan_hash TEXT,
      last_checked_at TEXT,
      next_check_at TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS infrastructure_reconcile_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      controller_id INTEGER REFERENCES infrastructure_reconcile_controllers(id) ON DELETE SET NULL,
      manifest_source TEXT NOT NULL CHECK(manifest_source IN ('core','resource','fleet')),
      manifest_id INTEGER,
      trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('manual','continuous','fleet_gitops')),
      plan_hash TEXT NOT NULL,
      state_hash TEXT NOT NULL,
      document_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('in_sync','planned','approved','apply_authorized','applied','blocked','stale','conflict','failed')),
      actions_json TEXT NOT NULL DEFAULT '[]',
      blocked_json TEXT NOT NULL DEFAULT '[]',
      summary_json TEXT NOT NULL DEFAULT '{}',
      resource_versions_json TEXT NOT NULL DEFAULT '{}',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      commit_sha TEXT,
      approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_at TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_infrastructure_reconcile_runs_controller
      ON infrastructure_reconcile_runs(controller_id,created_at DESC);

    CREATE TABLE IF NOT EXISTS infrastructure_external_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('pull_request','terraform')),
      external_ref TEXT NOT NULL,
      artifact_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'reviewed' CHECK(status IN ('reviewed','blocked','approved','apply_authorized','rejected')),
      normalized_plan_json TEXT NOT NULL,
      policy_json TEXT NOT NULL DEFAULT '{}',
      cost_json TEXT NOT NULL DEFAULT '{}',
      blast_radius_json TEXT NOT NULL DEFAULT '{}',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS infrastructure_webhook_triggers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      secret_enc TEXT NOT NULL,
      procedure_id INTEGER NOT NULL REFERENCES procedures(id) ON DELETE RESTRICT,
      event_allowlist_json TEXT NOT NULL,
      timestamp_skew_seconds INTEGER NOT NULL DEFAULT 300 CHECK(timestamp_skew_seconds BETWEEN 30 AND 900),
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS infrastructure_webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_id INTEGER NOT NULL REFERENCES infrastructure_webhook_triggers(id) ON DELETE CASCADE,
      nonce_hash TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('accepted','rejected','started','failed')),
      procedure_run_id INTEGER REFERENCES procedure_runs(id) ON DELETE SET NULL,
      reason TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(trigger_id,nonce_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_infrastructure_webhook_deliveries_received
      ON infrastructure_webhook_deliveries(trigger_id,received_at DESC);
  `);

  const insert = db.prepare(`INSERT OR IGNORE INTO governance_permissions
    (permission_key,resource_type,verb,description) VALUES (?,?,?,?)`);
  for (const permission of PERMISSIONS) insert.run(...permission);
  const siteAdmin = db.prepare("SELECT id FROM governance_roles WHERE slug='site-admin'").get();
  if (siteAdmin) {
    const grant = db.prepare('INSERT OR IGNORE INTO governance_role_permissions (role_id,permission_key) VALUES (?,?)');
    for (const permission of PERMISSIONS) grant.run(siteAdmin.id, permission[0]);
  }
};

exports._PERMISSIONS = PERMISSIONS;
