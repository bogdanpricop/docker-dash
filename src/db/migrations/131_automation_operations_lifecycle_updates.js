'use strict';

const PERMISSIONS = [
  ['infrastructure_operations.manage', 'infrastructure_operations', 'manage', 'Manage automation schedules, approvals, dry runs, secret brokers and workflow templates'],
  ['lifecycle_updates.manage', 'lifecycle_updates', 'manage', 'Manage version inventory, support lifecycle, update catalogs and upgrade prechecks'],
];

const WORKFLOW_TEMPLATES = [
  ['host-maintenance-safe', '1.0.0', 'maintenance', 'Drain, maintain and verify a host with explicit compensation.',
    ['hostId'], [
      { id: 'precheck', stage: 1, needs: [], actionKey: 'host.maintenance.precheck', input: { hostId: '${hostId}' }, lockScopes: ['host:${hostId}'] },
      { id: 'drain', stage: 2, needs: ['precheck'], actionKey: 'host.maintenance.drain', input: { hostId: '${hostId}' }, lockScopes: ['host:${hostId}'], compensation: { actionKey: 'host.maintenance.resume', strategy: 'required', input: { hostId: '${hostId}' } } },
      { id: 'verify', stage: 3, needs: ['drain'], actionKey: 'host.maintenance.verify', input: { hostId: '${hostId}' }, lockScopes: ['host:${hostId}'] },
    ]],
  ['vm-migration-safe', '1.0.0', 'migration', 'Precheck, migrate and verify a VM with a declared reverse migration.',
    ['vmId', 'sourceHostId', 'targetHostId'], [
      { id: 'precheck', stage: 1, needs: [], actionKey: 'vm.migration.precheck', input: { vmId: '${vmId}', targetHostId: '${targetHostId}' }, lockScopes: ['vm:${vmId}'] },
      { id: 'migrate', stage: 2, needs: ['precheck'], actionKey: 'vm.migration.execute', input: { vmId: '${vmId}', targetHostId: '${targetHostId}' }, lockScopes: ['vm:${vmId}', 'host:${targetHostId}'], compensation: { actionKey: 'vm.migration.execute', strategy: 'best_effort', input: { vmId: '${vmId}', targetHostId: '${sourceHostId}' } } },
      { id: 'verify', stage: 3, needs: ['migrate'], actionKey: 'vm.migration.verify', input: { vmId: '${vmId}', targetHostId: '${targetHostId}' }, lockScopes: ['vm:${vmId}'] },
    ]],
  ['backup-verified', '1.0.0', 'backup', 'Create a backup and require independent verification evidence.',
    ['resourceId', 'policyId'], [
      { id: 'precheck', stage: 1, needs: [], actionKey: 'backup.precheck', input: { resourceId: '${resourceId}', policyId: '${policyId}' }, lockScopes: ['resource:${resourceId}'] },
      { id: 'backup', stage: 2, needs: ['precheck'], actionKey: 'backup.execute', input: { resourceId: '${resourceId}', policyId: '${policyId}' }, lockScopes: ['resource:${resourceId}'] },
      { id: 'verify', stage: 3, needs: ['backup'], actionKey: 'backup.verify', input: { resourceId: '${resourceId}' }, lockScopes: ['resource:${resourceId}'] },
    ]],
  ['security-remediation-reviewed', '1.0.0', 'security', 'Validate, apply and verify a reviewed security remediation.',
    ['resourceId', 'controlId'], [
      { id: 'validate', stage: 1, needs: [], actionKey: 'security.remediation.validate', input: { resourceId: '${resourceId}', controlId: '${controlId}' }, lockScopes: ['resource:${resourceId}'] },
      { id: 'remediate', stage: 2, needs: ['validate'], actionKey: 'security.remediation.execute', input: { resourceId: '${resourceId}', controlId: '${controlId}' }, lockScopes: ['resource:${resourceId}'], compensationRequired: true },
      { id: 'verify', stage: 3, needs: ['remediate'], actionKey: 'security.remediation.verify', input: { resourceId: '${resourceId}', controlId: '${controlId}' }, lockScopes: ['resource:${resourceId}'] },
    ]],
  ['upgrade-readiness', '1.0.0', 'upgrade', 'Collect lifecycle evidence and record upgrade readiness without starting an upgrade.',
    ['inventoryId', 'targetVersion'], [
      { id: 'support', stage: 1, needs: [], actionKey: 'upgrade.support.check', input: { inventoryId: '${inventoryId}', targetVersion: '${targetVersion}' }, lockScopes: ['inventory:${inventoryId}'] },
      { id: 'precheck', stage: 2, needs: ['support'], actionKey: 'upgrade.readiness.precheck', input: { inventoryId: '${inventoryId}', targetVersion: '${targetVersion}' }, lockScopes: ['inventory:${inventoryId}'] },
      { id: 'review', stage: 3, needs: ['precheck'], actionKey: 'upgrade.readiness.review', input: { inventoryId: '${inventoryId}', targetVersion: '${targetVersion}' }, lockScopes: ['inventory:${inventoryId}'] },
    ]],
];

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS infrastructure_schedule_triggers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      workflow_id INTEGER NOT NULL REFERENCES infrastructure_workflows(id) ON DELETE RESTRICT,
      cron_expression TEXT NOT NULL,
      timezone TEXT NOT NULL,
      holidays_json TEXT NOT NULL DEFAULT '[]',
      blackout_windows_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 0,
      last_evaluated_at TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS infrastructure_schedule_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id INTEGER NOT NULL REFERENCES infrastructure_schedule_triggers(id) ON DELETE CASCADE,
      scheduled_for TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('ready','holiday_suppressed','blackout_suppressed','disabled')),
      reason TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(schedule_id,scheduled_for)
    );

    CREATE TABLE IF NOT EXISTS infrastructure_approval_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_key TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','escalated','approved','rejected','expired')),
      due_at TEXT NOT NULL,
      assignee_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      escalation_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      escalation_count INTEGER NOT NULL DEFAULT 0,
      escalation_grace_minutes INTEGER NOT NULL DEFAULT 30 CHECK(escalation_grace_minutes BETWEEN 1 AND 1440),
      requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      decision_reason TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_infrastructure_approval_due ON infrastructure_approval_requests(state,due_at);

    CREATE TABLE IF NOT EXISTS infrastructure_dry_run_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_type TEXT NOT NULL,
      adapter_key TEXT NOT NULL,
      action_key TEXT NOT NULL,
      target_ref TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('valid','invalid','unsupported','error')),
      result_json TEXT NOT NULL DEFAULT '{}',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS infrastructure_secret_broker_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      provider_kind TEXT NOT NULL CHECK(provider_kind IN ('environment','vault','aws_secrets_manager','azure_key_vault')),
      secret_reference TEXT NOT NULL,
      allowed_purposes_json TEXT NOT NULL,
      max_lease_seconds INTEGER NOT NULL DEFAULT 60 CHECK(max_lease_seconds BETWEEN 1 AND 300),
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS infrastructure_secret_access_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES infrastructure_secret_broker_profiles(id) ON DELETE RESTRICT,
      purpose TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('granted','denied','failed')),
      lease_seconds INTEGER NOT NULL,
      secret_fingerprint TEXT,
      reason TEXT,
      accessed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS infrastructure_workflow_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      version TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('maintenance','migration','backup','security','upgrade')),
      description TEXT NOT NULL,
      parameters_json TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      curated INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(slug,version)
    );

    CREATE TABLE IF NOT EXISTS lifecycle_version_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_host_id INTEGER NOT NULL DEFAULT 0,
      component_type TEXT NOT NULL CHECK(component_type IN ('host','control_plane','tool','firmware')),
      vendor TEXT NOT NULL,
      product TEXT NOT NULL,
      version TEXT NOT NULL,
      build TEXT,
      source TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider_host_id,component_type,vendor,product)
    );

    CREATE TABLE IF NOT EXISTS lifecycle_support_registry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor TEXT NOT NULL,
      product TEXT NOT NULL,
      version_line TEXT NOT NULL,
      ga_date TEXT,
      eol_date TEXT,
      eos_date TEXT,
      recommended_target TEXT,
      source_url TEXT NOT NULL,
      source_published_at TEXT,
      retrieved_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(vendor,product,version_line)
    );

    CREATE TABLE IF NOT EXISTS lifecycle_upgrade_paths (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor TEXT NOT NULL,
      product TEXT NOT NULL,
      from_version TEXT NOT NULL,
      to_version TEXT NOT NULL,
      supported_hops_json TEXT NOT NULL,
      prerequisites_json TEXT NOT NULL DEFAULT '[]',
      blockers_json TEXT NOT NULL DEFAULT '[]',
      source_url TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(vendor,product,from_version,to_version)
    );

    CREATE TABLE IF NOT EXISTS lifecycle_update_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor TEXT NOT NULL,
      product TEXT NOT NULL,
      advisory_id TEXT NOT NULL,
      title TEXT NOT NULL,
      update_kind TEXT NOT NULL CHECK(update_kind IN ('advisory','package','bundle','firmware')),
      target_version TEXT,
      severity TEXT NOT NULL CHECK(severity IN ('info','low','medium','high','critical')),
      published_at TEXT NOT NULL,
      source_url TEXT NOT NULL,
      source_digest TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      ingested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(vendor,product,advisory_id)
    );

    CREATE TABLE IF NOT EXISTS lifecycle_upgrade_prechecks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_id INTEGER NOT NULL REFERENCES lifecycle_version_inventory(id) ON DELETE RESTRICT,
      target_version TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('ready','blocked')),
      results_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const templateInsert = db.prepare(`INSERT OR IGNORE INTO infrastructure_workflow_templates
    (slug,version,category,description,parameters_json,steps_json) VALUES (?,?,?,?,?,?)`);
  for (const [slug, version, category, description, parameters, steps] of WORKFLOW_TEMPLATES) {
    templateInsert.run(slug, version, category, description, JSON.stringify(parameters), JSON.stringify(steps));
  }

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
exports._WORKFLOW_TEMPLATES = WORKFLOW_TEMPLATES;
