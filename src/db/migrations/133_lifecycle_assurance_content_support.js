'use strict';

const PERMISSIONS = [
  ['lifecycle_renewal.manage', 'lifecycle_renewal', 'manage', 'Manage approved certificate renewal adapter jobs and rollback evidence'],
  ['license_entitlement.manage', 'license_entitlement', 'manage', 'Manage license entitlement, assignment, usage and alert evidence'],
  ['configuration_assurance.manage', 'configuration_assurance', 'manage', 'Manage redacted snapshots, drift policies and host compliance profiles'],
  ['lifecycle_support.manage', 'lifecycle_support', 'manage', 'Manage air-gap mirrors, support bundles and post-upgrade validation evidence'],
];

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lifecycle_certificate_renewal_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ownership_id INTEGER NOT NULL REFERENCES lifecycle_certificate_ownership(id) ON DELETE CASCADE,
      adapter_key TEXT NOT NULL,
      maintenance_plan_id INTEGER REFERENCES lifecycle_maintenance_plans(id) ON DELETE RESTRICT,
      state TEXT NOT NULL CHECK(state IN ('unsupported','ready','approved','applying','verifying','succeeded','rollback_required','rolling_back','rolled_back','failed')),
      plan_hash TEXT NOT NULL UNIQUE,
      rollback_on_failure INTEGER NOT NULL DEFAULT 1,
      operation_id TEXT REFERENCES provider_operations(id) ON DELETE SET NULL,
      approval_id INTEGER REFERENCES infrastructure_approval_requests(id) ON DELETE SET NULL,
      previous_fingerprint TEXT,
      renewed_fingerprint TEXT,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS license_entitlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor TEXT NOT NULL,
      product TEXT NOT NULL,
      edition TEXT NOT NULL,
      entitlement_reference TEXT NOT NULL,
      entitlement_hash TEXT NOT NULL UNIQUE,
      metric TEXT NOT NULL CHECK(metric IN ('host','socket','core','vm','capacity','subscription')),
      capacity REAL NOT NULL CHECK(capacity >= 0),
      unit TEXT NOT NULL,
      starts_at TEXT,
      expires_at TEXT,
      support_expires_at TEXT,
      source_url TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS license_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entitlement_id INTEGER NOT NULL REFERENCES license_entitlements(id) ON DELETE CASCADE,
      resource_type TEXT NOT NULL,
      resource_ref TEXT NOT NULL,
      assigned_capacity REAL NOT NULL CHECK(assigned_capacity >= 0),
      owner TEXT NOT NULL,
      environment TEXT NOT NULL CHECK(environment IN ('production','nonproduction')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(entitlement_id,resource_type,resource_ref)
    );
    CREATE TABLE IF NOT EXISTS license_usage_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entitlement_id INTEGER NOT NULL REFERENCES license_entitlements(id) ON DELETE CASCADE,
      used_capacity REAL NOT NULL CHECK(used_capacity >= 0),
      assigned_capacity REAL NOT NULL CHECK(assigned_capacity >= 0),
      evidence_hash TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      observed_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(entitlement_id,observed_at,evidence_hash)
    );
    CREATE TABLE IF NOT EXISTS license_alert_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      entitlement_id INTEGER REFERENCES license_entitlements(id) ON DELETE CASCADE,
      over_percent REAL NOT NULL DEFAULT 100 CHECK(over_percent BETWEEN 1 AND 1000),
      under_percent REAL NOT NULL DEFAULT 20 CHECK(under_percent BETWEEN 0 AND 100),
      expiry_days INTEGER NOT NULL DEFAULT 60 CHECK(expiry_days BETWEEN 0 AND 3650),
      forecast_days INTEGER NOT NULL DEFAULT 30 CHECK(forecast_days BETWEEN 1 AND 365),
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS license_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id INTEGER NOT NULL REFERENCES license_alert_policies(id) ON DELETE CASCADE,
      entitlement_id INTEGER NOT NULL REFERENCES license_entitlements(id) ON DELETE CASCADE,
      alert_type TEXT NOT NULL CHECK(alert_type IN ('over_assignment','over_usage','under_assignment','expiry','forecast')),
      severity TEXT NOT NULL CHECK(severity IN ('info','warning','critical')),
      state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','acknowledged','resolved')),
      message TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(policy_id,entitlement_id,alert_type,evidence_hash)
    );

    CREATE TABLE IF NOT EXISTS host_configuration_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_host_id INTEGER NOT NULL DEFAULT 0,
      scope_ref TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('actual','desired','imported')),
      configuration_json TEXT NOT NULL,
      configuration_hash TEXT NOT NULL,
      redacted_paths_json TEXT NOT NULL DEFAULT '[]',
      observed_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider_host_id,scope_ref,source_kind,configuration_hash)
    );
    CREATE TABLE IF NOT EXISTS host_configuration_diffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_snapshot_id INTEGER NOT NULL REFERENCES host_configuration_snapshots(id) ON DELETE CASCADE,
      to_snapshot_id INTEGER NOT NULL REFERENCES host_configuration_snapshots(id) ON DELETE CASCADE,
      changes_json TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      diff_hash TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(from_snapshot_id,to_snapshot_id,diff_hash)
    );
    CREATE TABLE IF NOT EXISTS host_drift_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      provider_host_id INTEGER NOT NULL DEFAULT 0,
      scope_pattern TEXT NOT NULL,
      owner TEXT NOT NULL,
      rules_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS host_drift_assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id INTEGER NOT NULL REFERENCES host_drift_policies(id) ON DELETE CASCADE,
      diff_id INTEGER NOT NULL REFERENCES host_configuration_diffs(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK(state IN ('compliant','review','denied')),
      classifications_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(policy_id,diff_id,evidence_hash)
    );
    CREATE TABLE IF NOT EXISTS host_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      scope_pattern TEXT NOT NULL,
      baseline_json TEXT NOT NULL,
      baseline_hash TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('info','warning','critical')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(name,version)
    );
    CREATE TABLE IF NOT EXISTS host_profile_assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES host_profiles(id) ON DELETE CASCADE,
      snapshot_id INTEGER NOT NULL REFERENCES host_configuration_snapshots(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK(state IN ('compliant','noncompliant','unknown')),
      findings_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      remediation_plan_json TEXT NOT NULL DEFAULT '[]',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(profile_id,snapshot_id,evidence_hash)
    );

    CREATE TABLE IF NOT EXISTS airgap_mirrors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      site_ref TEXT NOT NULL,
      adapter_key TEXT NOT NULL,
      root_reference TEXT NOT NULL,
      trust_roots_json TEXT NOT NULL,
      max_bytes INTEGER NOT NULL CHECK(max_bytes BETWEEN 1 AND 1099511627776),
      state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','syncing','degraded','disabled')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS airgap_mirror_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mirror_id INTEGER NOT NULL REFERENCES airgap_mirrors(id) ON DELETE CASCADE,
      artifact_kind TEXT NOT NULL CHECK(artifact_kind IN ('package','image','advisory')),
      artifact_name TEXT NOT NULL,
      artifact_version TEXT NOT NULL,
      digest TEXT NOT NULL,
      signature_identity TEXT NOT NULL,
      signature_verified INTEGER NOT NULL,
      byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
      local_reference TEXT NOT NULL,
      source_url TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(mirror_id,artifact_kind,artifact_name,artifact_version,digest)
    );
    CREATE TABLE IF NOT EXISTS airgap_mirror_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mirror_id INTEGER NOT NULL REFERENCES airgap_mirrors(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK(state IN ('unsupported','running','succeeded','partial','failed')),
      requested_json TEXT NOT NULL,
      result_json TEXT NOT NULL DEFAULT '{}',
      bytes_added INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS support_bundle_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      adapter_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('unsupported','collecting','ready','partial','failed','expired')),
      target_refs_json TEXT NOT NULL,
      requested_sections_json TEXT NOT NULL,
      redaction_json TEXT NOT NULL,
      manifest_json TEXT NOT NULL DEFAULT '{}',
      checksum_sha256 TEXT,
      byte_size INTEGER NOT NULL DEFAULT 0,
      artifact_reference TEXT,
      expires_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS support_bundle_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES support_bundle_requests(id) ON DELETE CASCADE,
      target_ref TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('unsupported','collected','failed')),
      evidence_json TEXT NOT NULL DEFAULT '{}',
      evidence_hash TEXT NOT NULL,
      byte_size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(request_id,target_ref)
    );

    CREATE TABLE IF NOT EXISTS post_upgrade_validation_packs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      checks_json TEXT NOT NULL,
      pack_hash TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(name,version)
    );
    CREATE TABLE IF NOT EXISTS post_upgrade_validation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pack_id INTEGER NOT NULL REFERENCES post_upgrade_validation_packs(id) ON DELETE CASCADE,
      campaign_id INTEGER REFERENCES lifecycle_change_campaigns(id) ON DELETE SET NULL,
      target_ref TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('running','passed','failed','partial')),
      results_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT NOT NULL,
      UNIQUE(pack_id,campaign_id,target_ref,evidence_hash)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_post_upgrade_validation_runs_idempotent
      ON post_upgrade_validation_runs(pack_id,IFNULL(campaign_id,0),target_ref,evidence_hash);
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
