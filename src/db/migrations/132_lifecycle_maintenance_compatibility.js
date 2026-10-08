'use strict';

const PERMISSIONS = [
  ['lifecycle_maintenance.manage', 'lifecycle_maintenance', 'manage', 'Manage maintenance plans, staged lifecycle campaigns and compatibility evidence'],
  ['lifecycle_certificates.manage', 'lifecycle_certificates', 'manage', 'Manage certificate ownership and renewal reminder policies'],
];

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lifecycle_maintenance_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      scope_type TEXT NOT NULL CHECK(scope_type IN ('host','cluster','site','fleet')),
      scope_key TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      timezone TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL CHECK(duration_minutes BETWEEN 15 AND 10080),
      wave_size INTEGER NOT NULL CHECK(wave_size BETWEEN 1 AND 100),
      evacuation_json TEXT NOT NULL DEFAULT '{}',
      owner_constraints_json TEXT NOT NULL DEFAULT '{}',
      conflicts_json TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','ready','approved','running','paused','completed','cancelled')),
      plan_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lifecycle_maintenance_waves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES lifecycle_maintenance_plans(id) ON DELETE CASCADE,
      wave_number INTEGER NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      targets_json TEXT NOT NULL,
      owners_json TEXT NOT NULL DEFAULT '[]',
      evacuation_json TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','running','verified','blocked','skipped')),
      evidence_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(plan_id,wave_number)
    );

    CREATE TABLE IF NOT EXISTS lifecycle_change_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_kind TEXT NOT NULL CHECK(campaign_kind IN ('rolling_cluster','guest_tools','vm_hardware')),
      name TEXT NOT NULL UNIQUE,
      maintenance_plan_id INTEGER REFERENCES lifecycle_maintenance_plans(id) ON DELETE RESTRICT,
      target_version TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','ready','approved','running','paused','completed','failed','cancelled')),
      current_stage INTEGER NOT NULL DEFAULT 0,
      gates_json TEXT NOT NULL,
      rollback_policy_json TEXT NOT NULL DEFAULT '{}',
      plan_hash TEXT NOT NULL UNIQUE,
      pause_reason TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lifecycle_campaign_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES lifecycle_change_campaigns(id) ON DELETE CASCADE,
      target_ref TEXT NOT NULL,
      provider_host_id INTEGER NOT NULL DEFAULT 0,
      stage INTEGER NOT NULL CHECK(stage BETWEEN 1 AND 1000),
      current_version TEXT,
      target_version TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','prechecked','running','verified','blocked','failed','rolled_back','skipped')),
      precheck_json TEXT NOT NULL DEFAULT '{}',
      protection_json TEXT NOT NULL DEFAULT '{}',
      operation_id TEXT REFERENCES provider_operations(id) ON DELETE SET NULL,
      verification_json TEXT NOT NULL DEFAULT '{}',
      rollback_operation_id TEXT REFERENCES provider_operations(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(campaign_id,target_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_lifecycle_campaign_targets_stage
      ON lifecycle_campaign_targets(campaign_id,stage,state);

    CREATE TABLE IF NOT EXISTS lifecycle_live_patch_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_type TEXT NOT NULL,
      provider_host_id INTEGER NOT NULL DEFAULT 0,
      target_ref TEXT NOT NULL,
      patch_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('inventory','planned','applied','verified','unsupported','failed')),
      request_hash TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      operation_id TEXT REFERENCES provider_operations(id) ON DELETE SET NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lifecycle_reboot_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_host_id INTEGER NOT NULL DEFAULT 0,
      target_ref TEXT NOT NULL,
      signal_source TEXT NOT NULL CHECK(signal_source IN ('kernel','hypervisor','toolstack','vendor')),
      signal_key TEXT NOT NULL,
      required_state TEXT NOT NULL CHECK(required_state IN ('required','not_required','unknown')),
      current_version TEXT,
      pending_version TEXT,
      guidance TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider_host_id,target_ref,signal_source,signal_key)
    );

    CREATE TABLE IF NOT EXISTS lifecycle_firmware_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor TEXT NOT NULL,
      device_model TEXT NOT NULL,
      component_type TEXT NOT NULL CHECK(component_type IN ('bios','bmc','nic','storage','gpu')),
      firmware_version TEXT NOT NULL,
      compatible_host_releases_json TEXT NOT NULL,
      minimum_driver_version TEXT,
      severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','recommended','critical')),
      source_url TEXT NOT NULL,
      published_at TEXT NOT NULL,
      source_digest TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(vendor,device_model,component_type,firmware_version)
    );

    CREATE TABLE IF NOT EXISTS lifecycle_driver_compatibility (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor TEXT NOT NULL,
      device_model TEXT NOT NULL,
      driver_name TEXT NOT NULL,
      driver_version TEXT NOT NULL,
      firmware_version TEXT NOT NULL,
      host_release TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('supported','deprecated','blocked')),
      notes TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL,
      source_digest TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(vendor,device_model,driver_name,driver_version,firmware_version,host_release)
    );

    CREATE TABLE IF NOT EXISTS lifecycle_certificate_ownership (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      certificate_id INTEGER REFERENCES tracked_certificates(id) ON DELETE CASCADE,
      inventory_key TEXT NOT NULL UNIQUE,
      endpoint TEXT,
      resource_type TEXT NOT NULL CHECK(resource_type IN ('endpoint','service','host')),
      resource_ref TEXT NOT NULL,
      owner TEXT NOT NULL,
      escalation_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      maintenance_plan_id INTEGER REFERENCES lifecycle_maintenance_plans(id) ON DELETE SET NULL,
      environment TEXT NOT NULL DEFAULT 'production' CHECK(environment IN ('production','nonproduction')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lifecycle_certificate_reminder_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      thresholds_json TEXT NOT NULL,
      environment TEXT NOT NULL DEFAULT 'production' CHECK(environment IN ('production','nonproduction','all')),
      require_maintenance_window INTEGER NOT NULL DEFAULT 1,
      escalation_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lifecycle_certificate_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id INTEGER NOT NULL REFERENCES lifecycle_certificate_reminder_policies(id) ON DELETE CASCADE,
      ownership_id INTEGER NOT NULL REFERENCES lifecycle_certificate_ownership(id) ON DELETE CASCADE,
      certificate_id INTEGER REFERENCES tracked_certificates(id) ON DELETE CASCADE,
      threshold_days INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('open','acknowledged','resolved','expired')),
      severity TEXT NOT NULL CHECK(severity IN ('info','warning','critical','expired')),
      owner TEXT NOT NULL,
      escalation_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      maintenance_dependency TEXT,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(policy_id,ownership_id,threshold_days,expires_at)
    );
  `);

  const permissionInsert = db.prepare(`INSERT OR IGNORE INTO governance_permissions
    (permission_key,resource_type,verb,description) VALUES (?,?,?,?)`);
  for (const permission of PERMISSIONS) permissionInsert.run(...permission);
  const siteAdmin = db.prepare("SELECT id FROM governance_roles WHERE slug='site-admin'").get();
  if (siteAdmin) {
    const grant = db.prepare('INSERT OR IGNORE INTO governance_role_permissions (role_id,permission_key) VALUES (?,?)');
    for (const permission of PERMISSIONS) grant.run(siteAdmin.id, permission[0]);
  }
};

exports._PERMISSIONS = PERMISSIONS;
