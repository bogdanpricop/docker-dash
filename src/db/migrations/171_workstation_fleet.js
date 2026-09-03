'use strict';

const PERMISSIONS = [
  ['workstation_fleet.view', 'workstation', 'view', 'View workstation fleet inventory and posture'],
  ['workstation_fleet.manage', 'workstation_connector', 'manage', 'Manage Foreman connections, mappings and artifact channels'],
  ['workstation_fleet.sync', 'workstation_connector', 'sync', 'Synchronize read-only Foreman and Katello inventory'],
  ['workstation_fleet.update', 'workstation', 'update', 'Plan and execute guarded bootc update or rollback workflows'],
];

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workstation_foreman_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      base_url TEXT NOT NULL,
      auth_type TEXT NOT NULL DEFAULT 'token' CHECK(auth_type IN ('token','basic')),
      username TEXT,
      secret_encrypted TEXT,
      ca_pem TEXT,
      tls_verify INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_sync_at TEXT,
      last_sync_state TEXT CHECK(last_sync_state IN ('success','partial','failed')),
      last_error_code TEXT,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workstation_foreman_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id INTEGER NOT NULL REFERENCES workstation_foreman_connections(id) ON DELETE CASCADE,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('location','host_group')),
      source_ref TEXT NOT NULL,
      edge_site_id INTEGER,
      scope_ref TEXT,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(connection_id, source_kind, source_ref)
    );

    CREATE TABLE IF NOT EXISTS workstation_bootc_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      registry_id INTEGER,
      name TEXT NOT NULL,
      repository TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      digest TEXT NOT NULL UNIQUE,
      image_reference TEXT NOT NULL,
      media_type TEXT,
      os_name TEXT,
      os_version TEXT,
      architecture TEXT,
      bootc_detected INTEGER NOT NULL DEFAULT 0,
      base_image TEXT,
      base_digest TEXT,
      source_url TEXT,
      revision TEXT,
      sbom_refs_json TEXT NOT NULL DEFAULT '[]',
      signature_policy TEXT NOT NULL DEFAULT 'none' CHECK(signature_policy IN ('none','annotation','cosign')),
      signature_state TEXT NOT NULL DEFAULT 'unknown' CHECK(signature_state IN ('absent','present','verified','rejected','unknown')),
      signer TEXT,
      signer_pattern TEXT,
      verification_hash TEXT,
      channel TEXT NOT NULL DEFAULT 'held' CHECK(channel IN ('held','canary','stable')),
      provenance_json TEXT NOT NULL DEFAULT '{}',
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workstation_artifact_promotions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact_id INTEGER NOT NULL REFERENCES workstation_bootc_artifacts(id) ON DELETE CASCADE,
      from_channel TEXT NOT NULL CHECK(from_channel IN ('held','canary','stable')),
      to_channel TEXT NOT NULL CHECK(to_channel IN ('held','canary','stable')),
      reason TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      promoted_by INTEGER,
      promoted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workstation_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id INTEGER NOT NULL REFERENCES workstation_foreman_connections(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL,
      name TEXT NOT NULL,
      organization TEXT,
      location TEXT,
      host_group TEXT,
      edge_site_id INTEGER,
      scope_ref TEXT,
      os_name TEXT,
      os_version TEXT,
      architecture TEXT,
      ip_address TEXT,
      mac_address TEXT,
      status TEXT NOT NULL DEFAULT 'unknown' CHECK(status IN ('online','offline','error','building','unknown')),
      last_seen_at TEXT,
      bootc_digest TEXT,
      bootc_version TEXT,
      lifecycle_environment TEXT,
      content_view TEXT,
      identity_realm TEXT,
      identity_enrolled INTEGER,
      secure_boot INTEGER,
      tpm_present INTEGER,
      disk_encrypted INTEGER,
      selinux_state TEXT CHECK(selinux_state IN ('enforcing','permissive','disabled','unknown')),
      patch_age_days INTEGER,
      applicable_errata INTEGER,
      facts_json TEXT NOT NULL DEFAULT '{}',
      source_hash TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      synced_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(connection_id, external_id)
    );

    CREATE TABLE IF NOT EXISTS workstation_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id INTEGER NOT NULL REFERENCES workstation_foreman_connections(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK(state IN ('running','success','partial','failed')),
      organizations_count INTEGER NOT NULL DEFAULT 0,
      locations_count INTEGER NOT NULL DEFAULT 0,
      host_groups_count INTEGER NOT NULL DEFAULT 0,
      workstations_count INTEGER NOT NULL DEFAULT 0,
      content_views_count INTEGER NOT NULL DEFAULT 0,
      lifecycle_environments_count INTEGER NOT NULL DEFAULT 0,
      source_hash TEXT,
      error_code TEXT,
      error_message TEXT,
      started_by INTEGER,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS workstation_update_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL REFERENCES workstation_devices(id) ON DELETE CASCADE,
      artifact_id INTEGER REFERENCES workstation_bootc_artifacts(id) ON DELETE SET NULL,
      artifact_verification_hash TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('update','rollback')),
      target_image_ref TEXT NOT NULL,
      target_digest TEXT NOT NULL,
      previous_digest TEXT NOT NULL,
      channel TEXT NOT NULL CHECK(channel IN ('canary','stable')),
      remote_job_template_id TEXT NOT NULL,
      maintenance_window_ref TEXT NOT NULL,
      approval_ref TEXT NOT NULL,
      device_source_hash TEXT NOT NULL,
      plan_hash TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','running','succeeded','failed','verification_failed','cancelled')),
      task_ref TEXT,
      post_read_digest TEXT,
      error_code TEXT,
      error_message TEXT,
      requested_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_workstation_devices_connection ON workstation_devices(connection_id);
    CREATE INDEX IF NOT EXISTS idx_workstation_devices_site ON workstation_devices(edge_site_id);
    CREATE INDEX IF NOT EXISTS idx_workstation_devices_digest ON workstation_devices(bootc_digest);
    CREATE INDEX IF NOT EXISTS idx_workstation_devices_status ON workstation_devices(status);
    CREATE INDEX IF NOT EXISTS idx_workstation_sync_runs_connection ON workstation_sync_runs(connection_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workstation_update_plans_device ON workstation_update_plans(device_id, created_at DESC);
  `);

  const insert = db.prepare(`INSERT OR IGNORE INTO governance_permissions
    (permission_key,resource_type,verb,description) VALUES (?,?,?,?)`);
  for (const permission of PERMISSIONS) insert.run(...permission);
};

exports.down = function (db) {
  db.exec(`
    DROP TABLE IF EXISTS workstation_update_plans;
    DROP TABLE IF EXISTS workstation_sync_runs;
    DROP TABLE IF EXISTS workstation_devices;
    DROP TABLE IF EXISTS workstation_artifact_promotions;
    DROP TABLE IF EXISTS workstation_bootc_artifacts;
    DROP TABLE IF EXISTS workstation_foreman_mappings;
    DROP TABLE IF EXISTS workstation_foreman_connections;
  `);
  const remove = db.prepare('DELETE FROM governance_permissions WHERE permission_key=?');
  for (const [permissionKey] of PERMISSIONS) remove.run(permissionKey);
};

exports._PERMISSIONS = PERMISSIONS;
