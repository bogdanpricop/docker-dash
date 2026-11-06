'use strict';

// V4.6c governance lifecycle + VM metrics foundation (B196-B205).
// All provider-facing state is additive and accounting-only. Lease expiry,
// access-review revocation and tenant offboarding require explicit API actions.

const METRIC_DEFINITIONS = [
  ['cpu.utilization_ratio', 'ratio', 'gauge', 'CPU utilization from 0 to 1'],
  ['cpu.usage_mhz', 'MHz', 'gauge', 'CPU consumption in megahertz'],
  ['cpu.time_seconds_total', 'seconds', 'counter', 'Accumulated CPU time'],
  ['memory.used_bytes', 'bytes', 'gauge', 'Memory currently consumed'],
  ['memory.total_bytes', 'bytes', 'gauge', 'Configured or available memory'],
  ['memory.utilization_ratio', 'ratio', 'gauge', 'Memory utilization from 0 to 1'],
  ['disk.used_bytes', 'bytes', 'gauge', 'Guest storage currently consumed'],
  ['disk.provisioned_bytes', 'bytes', 'gauge', 'Guest storage provisioned'],
  ['disk.read_bytes_total', 'bytes', 'counter', 'Accumulated disk reads'],
  ['disk.write_bytes_total', 'bytes', 'counter', 'Accumulated disk writes'],
  ['network.receive_bytes_total', 'bytes', 'counter', 'Accumulated received network traffic'],
  ['network.transmit_bytes_total', 'bytes', 'counter', 'Accumulated transmitted network traffic'],
  ['uptime.seconds', 'seconds', 'gauge', 'Resource uptime'],
];

const PERMISSIONS = [
  ['resource_lease.manage', 'resource_lease', 'manage', 'Create, renew and reconcile resource leases'],
  ['resource_ownership.manage', 'resource_ownership', 'manage', 'Configure and satisfy production ownership policy'],
  ['access_review.manage', 'access_review', 'manage', 'Run separation-of-duties and access recertification campaigns'],
  ['tenant.offboard', 'tenant', 'offboard', 'Export and delete a non-default tenant through controlled offboarding'],
  ['vm_metrics.read', 'vm_metric', 'read', 'Read normalized VM metrics and freshness state'],
  ['vm_metrics.manage', 'vm_metric', 'manage', 'Ingest metrics and configure polling/cardinality policies'],
];

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS governance_lease_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      resource_type TEXT NOT NULL,
      max_ttl_seconds INTEGER NOT NULL CHECK(max_ttl_seconds BETWEEN 300 AND 31536000),
      renewal_mode TEXT NOT NULL DEFAULT 'holder' CHECK(renewal_mode IN ('holder','cleanup_owner','admin')),
      max_renewals INTEGER NOT NULL DEFAULT 12 CHECK(max_renewals BETWEEN 0 AND 10000),
      cleanup_owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, resource_type)
    );

    CREATE TABLE IF NOT EXISTS governance_resource_leases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      resource_id INTEGER NOT NULL REFERENCES governance_project_resources(id) ON DELETE CASCADE,
      policy_id INTEGER NOT NULL REFERENCES governance_lease_policies(id) ON DELETE RESTRICT,
      holder_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      cleanup_owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      expires_at TEXT NOT NULL,
      renewal_count INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','cleanup_pending','released','cleaned')),
      last_renewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      released_at TEXT,
      cleaned_at TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_governance_active_resource_lease
      ON governance_resource_leases(resource_id) WHERE state IN ('active','cleanup_pending');
    CREATE INDEX IF NOT EXISTS idx_governance_lease_expiry
      ON governance_resource_leases(state, expires_at);

    CREATE TABLE IF NOT EXISTS governance_ownership_policies (
      tenant_id INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      enforce_production INTEGER NOT NULL DEFAULT 1,
      require_owner INTEGER NOT NULL DEFAULT 1,
      require_service INTEGER NOT NULL DEFAULT 1,
      require_cost_center INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS governance_resource_ownership (
      resource_id INTEGER PRIMARY KEY REFERENCES governance_project_resources(id) ON DELETE CASCADE,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      owner_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
      service_name TEXT,
      cost_center TEXT,
      environment TEXT NOT NULL DEFAULT 'nonproduction' CHECK(environment IN ('production','nonproduction')),
      completeness_state TEXT NOT NULL CHECK(completeness_state IN ('complete','incomplete')),
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_governance_ownership_project
      ON governance_resource_ownership(tenant_id, environment, completeness_state);

    CREATE TABLE IF NOT EXISTS governance_sod_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      left_role_id INTEGER NOT NULL REFERENCES governance_roles(id) ON DELETE CASCADE,
      right_role_id INTEGER NOT NULL REFERENCES governance_roles(id) ON DELETE CASCADE,
      scope_id INTEGER REFERENCES governance_scopes(id) ON DELETE CASCADE,
      severity TEXT NOT NULL DEFAULT 'high' CHECK(severity IN ('low','medium','high','critical')),
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(left_role_id <> right_role_id),
      UNIQUE(left_role_id, right_role_id, scope_id)
    );

    CREATE TABLE IF NOT EXISTS governance_access_review_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      scope_id INTEGER REFERENCES governance_scopes(id) ON DELETE CASCADE,
      review_kind TEXT NOT NULL DEFAULT 'all' CHECK(review_kind IN ('access','service_accounts','all')),
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','completed','cancelled')),
      due_at TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS governance_access_review_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES governance_access_review_campaigns(id) ON DELETE CASCADE,
      subject_type TEXT NOT NULL CHECK(subject_type IN ('user','team','service_account')),
      subject_key TEXT NOT NULL,
      subject_label TEXT NOT NULL,
      binding_id INTEGER REFERENCES governance_role_bindings(id) ON DELETE SET NULL,
      service_token_id INTEGER REFERENCES governance_service_tokens(id) ON DELETE SET NULL,
      role_id INTEGER REFERENCES governance_roles(id) ON DELETE SET NULL,
      scope_id INTEGER REFERENCES governance_scopes(id) ON DELETE SET NULL,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      decision TEXT NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','keep','revoke')),
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      comment TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK((binding_id IS NOT NULL) + (service_token_id IS NOT NULL) = 1)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_governance_review_binding
      ON governance_access_review_items(campaign_id, binding_id) WHERE binding_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_governance_review_token
      ON governance_access_review_items(campaign_id, service_token_id) WHERE service_token_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS governance_tenant_exports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
      tenant_slug TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      checksum_sha256 TEXT NOT NULL,
      byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
      expires_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS governance_tenant_offboarding_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
      tenant_slug TEXT NOT NULL,
      export_id INTEGER REFERENCES governance_tenant_exports(id) ON DELETE SET NULL,
      state TEXT NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','ready','completed','cancelled')),
      blockers_json TEXT NOT NULL DEFAULT '[]',
      requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vm_metric_definitions (
      metric_key TEXT PRIMARY KEY,
      unit TEXT NOT NULL,
      metric_kind TEXT NOT NULL CHECK(metric_kind IN ('gauge','counter')),
      description TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vm_metric_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_host_id INTEGER NOT NULL DEFAULT 0,
      provider TEXT NOT NULL,
      adapter TEXT NOT NULL,
      resource_type TEXT NOT NULL DEFAULT 'vm',
      resource_key TEXT NOT NULL,
      metric_key TEXT NOT NULL REFERENCES vm_metric_definitions(metric_key) ON DELETE RESTRICT,
      value REAL NOT NULL,
      unit TEXT NOT NULL,
      sample_at TEXT NOT NULL,
      collected_at TEXT NOT NULL DEFAULT (datetime('now')),
      labels_json TEXT NOT NULL DEFAULT '{}',
      provenance_json TEXT NOT NULL DEFAULT '{}',
      series_fingerprint TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vm_metric_resource_time
      ON vm_metric_samples(provider_host_id, resource_type, resource_key, sample_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vm_metric_retention
      ON vm_metric_samples(sample_at);

    CREATE TABLE IF NOT EXISTS vm_metric_collection_state (
      provider_host_id INTEGER NOT NULL DEFAULT 0,
      provider TEXT NOT NULL,
      adapter TEXT NOT NULL,
      resource_type TEXT NOT NULL DEFAULT 'vm',
      resource_key TEXT NOT NULL,
      last_sample_at TEXT,
      last_success_at TEXT,
      last_error_at TEXT,
      last_error TEXT,
      consecutive_errors INTEGER NOT NULL DEFAULT 0,
      accepted_samples INTEGER NOT NULL DEFAULT 0,
      dropped_samples INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(provider_host_id, resource_type, resource_key)
    );

    CREATE TABLE IF NOT EXISTS vm_metric_polling_policies (
      provider_host_id INTEGER PRIMARY KEY,
      active_interval_seconds INTEGER NOT NULL DEFAULT 30 CHECK(active_interval_seconds BETWEEN 10 AND 3600),
      idle_interval_seconds INTEGER NOT NULL DEFAULT 300 CHECK(idle_interval_seconds BETWEEN 30 AND 86400),
      hidden_multiplier INTEGER NOT NULL DEFAULT 4 CHECK(hidden_multiplier BETWEEN 1 AND 20),
      rate_budget_per_minute INTEGER NOT NULL DEFAULT 120 CHECK(rate_budget_per_minute BETWEEN 1 AND 100000),
      activity_window_seconds INTEGER NOT NULL DEFAULT 300 CHECK(activity_window_seconds BETWEEN 30 AND 86400),
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vm_metric_cardinality_policies (
      provider_host_id INTEGER PRIMARY KEY,
      max_resources_per_batch INTEGER NOT NULL DEFAULT 1000 CHECK(max_resources_per_batch BETWEEN 1 AND 100000),
      max_metrics_per_resource INTEGER NOT NULL DEFAULT 24 CHECK(max_metrics_per_resource BETWEEN 1 AND 1000),
      max_label_keys INTEGER NOT NULL DEFAULT 8 CHECK(max_label_keys BETWEEN 0 AND 64),
      max_label_value_length INTEGER NOT NULL DEFAULT 120 CHECK(max_label_value_length BETWEEN 8 AND 1000),
      max_series_per_batch INTEGER NOT NULL DEFAULT 5000 CHECK(max_series_per_batch BETWEEN 1 AND 1000000),
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vm_metric_cardinality_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_host_id INTEGER NOT NULL DEFAULT 0,
      adapter TEXT NOT NULL,
      reason TEXT NOT NULL,
      dropped_count INTEGER NOT NULL CHECK(dropped_count > 0),
      observed_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const metricInsert = db.prepare(`INSERT OR IGNORE INTO vm_metric_definitions
    (metric_key,unit,metric_kind,description) VALUES (?,?,?,?)`);
  for (const metric of METRIC_DEFINITIONS) metricInsert.run(...metric);

  db.prepare(`INSERT OR IGNORE INTO vm_metric_polling_policies (provider_host_id) VALUES (0)`).run();
  db.prepare(`INSERT OR IGNORE INTO vm_metric_cardinality_policies (provider_host_id) VALUES (0)`).run();

  const permissionInsert = db.prepare(`INSERT OR IGNORE INTO governance_permissions
    (permission_key,resource_type,verb,description) VALUES (?,?,?,?)`);
  for (const permission of PERMISSIONS) permissionInsert.run(...permission);
  const roleId = db.prepare('SELECT id FROM governance_roles WHERE slug=?');
  const grant = db.prepare(`INSERT OR IGNORE INTO governance_role_permissions
    (role_id,permission_key) VALUES (?,?)`);
  const projectAdmin = roleId.get('project-admin');
  const siteAdmin = roleId.get('site-admin');
  for (const permission of ['resource_lease.manage', 'resource_ownership.manage', 'vm_metrics.read']) {
    if (projectAdmin) grant.run(projectAdmin.id, permission);
  }
  for (const permission of ['resource_lease.manage', 'resource_ownership.manage', 'access_review.manage',
    'tenant.offboard', 'vm_metrics.read', 'vm_metrics.manage']) {
    if (siteAdmin) grant.run(siteAdmin.id, permission);
  }
};

exports._METRIC_DEFINITIONS = METRIC_DEFINITIONS;
exports._PERMISSIONS = PERMISSIONS;
