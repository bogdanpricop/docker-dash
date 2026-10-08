'use strict';

// V6.4b observability operations and governance (B216-B225). All analyses are
// advisory. Export delivery and retention deletion require explicit admin
// actions; policies alone never create network traffic or purge evidence.

const PERMISSIONS = [
  ['observability_export.manage', 'vm_observability_export', 'manage', 'Configure and explicitly deliver bounded observability exports'],
  ['telemetry_policy.manage', 'telemetry_policy', 'manage', 'Configure telemetry privacy, residency, sampling and retention'],
];

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vm_observability_baseline_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      provider_host_id INTEGER NOT NULL DEFAULT 0,
      resource_type TEXT NOT NULL DEFAULT 'vm',
      resource_key TEXT,
      metric_key TEXT NOT NULL REFERENCES vm_metric_definitions(metric_key) ON DELETE CASCADE,
      window_days INTEGER NOT NULL DEFAULT 14 CHECK(window_days BETWEEN 2 AND 90),
      seasonality TEXT NOT NULL DEFAULT 'hour_of_day' CHECK(seasonality IN ('none','hour_of_day','day_of_week')),
      percentile REAL NOT NULL DEFAULT 0.95 CHECK(percentile BETWEEN 0.5 AND 0.999),
      deviation_multiplier REAL NOT NULL DEFAULT 1.5 CHECK(deviation_multiplier BETWEEN 1 AND 100),
      minimum_samples INTEGER NOT NULL DEFAULT 20 CHECK(minimum_samples BETWEEN 4 AND 100000),
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vm_observability_baseline_assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id INTEGER NOT NULL REFERENCES vm_observability_baseline_policies(id) ON DELETE CASCADE,
      resource_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('normal','above_baseline','insufficient_evidence')),
      current_value REAL,
      baseline_value REAL,
      threshold_value REAL,
      sample_count INTEGER NOT NULL,
      explanation_json TEXT NOT NULL,
      assessed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_vm_observability_baseline_latest
      ON vm_observability_baseline_assessments(policy_id,resource_key,assessed_at DESC);

    CREATE TABLE IF NOT EXISTS vm_observability_alert_suppressions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id INTEGER NOT NULL REFERENCES vm_observability_signal_alerts(id) ON DELETE CASCADE,
      suppression_kind TEXT NOT NULL CHECK(suppression_kind IN ('dependency','maintenance')),
      upstream_alert_id INTEGER REFERENCES vm_observability_signal_alerts(id) ON DELETE CASCADE,
      maintenance_window_id INTEGER REFERENCES vm_observability_maintenance_windows(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      cleared_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vm_observability_active_suppression
      ON vm_observability_alert_suppressions(alert_id,suppression_kind)
      WHERE active=1;

    CREATE TABLE IF NOT EXISTS vm_observability_maintenance_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      provider_host_id INTEGER NOT NULL DEFAULT 0,
      scope_type TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      reason TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(ends_at > starts_at)
    );
    CREATE INDEX IF NOT EXISTS idx_vm_observability_maintenance_active
      ON vm_observability_maintenance_windows(enabled,starts_at,ends_at,provider_host_id,scope_type,scope_key);

    CREATE TABLE IF NOT EXISTS vm_observability_capacity_forecasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_host_id INTEGER NOT NULL DEFAULT 0,
      resource_type TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      metric_key TEXT NOT NULL,
      capacity_value REAL,
      slope_per_day REAL,
      projected_full_at TEXT,
      confidence REAL NOT NULL DEFAULT 0,
      sample_count INTEGER NOT NULL,
      evidence_json TEXT NOT NULL,
      calculated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vm_observability_triage_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_alert_id INTEGER REFERENCES vm_observability_signal_alerts(id) ON DELETE SET NULL,
      event_id INTEGER REFERENCES vm_observability_events(id) ON DELETE SET NULL,
      resource_type TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      summary TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      candidates_json TEXT NOT NULL,
      runbooks_json TEXT NOT NULL DEFAULT '[]',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK((signal_alert_id IS NOT NULL) + (event_id IS NOT NULL) = 1)
    );

    CREATE TABLE IF NOT EXISTS vm_observability_runbook_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      event_pattern TEXT NOT NULL,
      resource_type TEXT,
      minimum_severity TEXT NOT NULL DEFAULT 'warning' CHECK(minimum_severity IN ('info','warning','high','critical')),
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      version TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vm_observability_export_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      export_kind TEXT NOT NULL CHECK(export_kind IN ('prometheus','otlp_http','webhook','syslog_udp')),
      endpoint TEXT,
      region TEXT NOT NULL DEFAULT 'local',
      filters_json TEXT NOT NULL DEFAULT '{}',
      allow_private_network INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vm_observability_export_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id INTEGER NOT NULL REFERENCES vm_observability_export_targets(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('preview','delivered','failed','pull_only')),
      event_count INTEGER NOT NULL DEFAULT 0,
      byte_size INTEGER NOT NULL DEFAULT 0,
      payload_sha256 TEXT NOT NULL,
      response_code INTEGER,
      error TEXT,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      delivered_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vm_observability_slo_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      provider_host_id INTEGER NOT NULL DEFAULT 0,
      resource_type TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      target_ratio REAL NOT NULL CHECK(target_ratio BETWEEN 0.5 AND 0.99999),
      window_days INTEGER NOT NULL DEFAULT 30 CHECK(window_days BETWEEN 1 AND 365),
      exclude_maintenance INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider_host_id,resource_type,resource_key)
    );

    CREATE TABLE IF NOT EXISTS vm_observability_privacy_policies (
      provider_host_id INTEGER PRIMARY KEY,
      redacted_label_keys_json TEXT NOT NULL DEFAULT '["user","email","ip","hostname"]',
      redact_event_message INTEGER NOT NULL DEFAULT 0,
      redact_raw_payload INTEGER NOT NULL DEFAULT 1,
      sampling_ratio REAL NOT NULL DEFAULT 1 CHECK(sampling_ratio BETWEEN 0.01 AND 1),
      metric_retention_days INTEGER NOT NULL DEFAULT 30 CHECK(metric_retention_days BETWEEN 1 AND 3650),
      event_retention_days INTEGER NOT NULL DEFAULT 90 CHECK(event_retention_days BETWEEN 1 AND 3650),
      residency_region TEXT NOT NULL DEFAULT 'local',
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.prepare('INSERT OR IGNORE INTO vm_observability_privacy_policies (provider_host_id) VALUES (0)').run();
  const runbookInsert = db.prepare(`INSERT INTO vm_observability_runbook_mappings
    (name,event_pattern,resource_type,minimum_severity,title,url,version) VALUES (?,?,?,?,?,?,?)`);
  const existing = db.prepare('SELECT COUNT(*) count FROM vm_observability_runbook_mappings').get().count;
  if (!existing) {
    runbookInsert.run('VM restart triage', 'restart|power', 'vm', 'warning', 'VM lifecycle investigation', '/docs/features/provider-operation-core', '1.0');
    runbookInsert.run('Storage latency triage', 'storage|disk|datastore', null, 'warning', 'Storage posture investigation', '/docs/features/provider-backup-execution', '1.0');
    runbookInsert.run('Network incident triage', 'network|mtu|drop', null, 'warning', 'Network evidence investigation', '/docs/features/observability', '1.0');
  }

  const permissionInsert = db.prepare(`INSERT OR IGNORE INTO governance_permissions
    (permission_key,resource_type,verb,description) VALUES (?,?,?,?)`);
  for (const permission of PERMISSIONS) permissionInsert.run(...permission);
  const siteAdmin = db.prepare("SELECT id FROM governance_roles WHERE slug='site-admin'").get();
  const grant = db.prepare('INSERT OR IGNORE INTO governance_role_permissions (role_id,permission_key) VALUES (?,?)');
  for (const permission of PERMISSIONS) if (siteAdmin) grant.run(siteAdmin.id, permission[0]);
};

exports._PERMISSIONS = PERMISSIONS;
