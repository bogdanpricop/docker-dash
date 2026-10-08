'use strict';

// v8.72.0 — V6.6c/V5.8a performance evidence and signed plugin foundation.
const PERMISSIONS = [
  ['hardware_advanced.manage', 'hardware_performance', 'manage', 'Record benchmarks and run non-mutating compatibility/performance assessments'],
  ['provider_plugins.manage', 'provider_plugin', 'manage', 'Register signed provider manifests and manage explicit permission consent'],
];

exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS virtual_hardware_scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resource_key TEXT NOT NULL,
      source_host_id INTEGER REFERENCES docker_hosts(id) ON DELETE SET NULL,
      target_host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      target_provider_version TEXT NOT NULL,
      requirements_json TEXT NOT NULL,
      checks_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('compatible','warning','blocked')),
      evidence_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS hardware_benchmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      suite TEXT NOT NULL,
      suite_version TEXT NOT NULL,
      metric TEXT NOT NULL,
      unit TEXT NOT NULL,
      score REAL NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('higher','lower')),
      controlled INTEGER NOT NULL CHECK(controlled IN (0,1)),
      hardware_json TEXT NOT NULL,
      run_config_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      evidence_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS workload_performance_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      resource_key TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS performance_regression_assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      baseline_benchmark_id INTEGER NOT NULL REFERENCES hardware_benchmarks(id),
      candidate_benchmark_id INTEGER NOT NULL REFERENCES hardware_benchmarks(id),
      change_ref TEXT NOT NULL,
      threshold_percent REAL NOT NULL,
      delta_percent REAL NOT NULL,
      regression_percent REAL NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pass','warning','regression')),
      assessment_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS workload_performance_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resource_key TEXT NOT NULL UNIQUE,
      preset TEXT NOT NULL CHECK(preset IN ('batch','database','vdi','latency','ai')),
      thresholds_json TEXT NOT NULL,
      profile_hash TEXT NOT NULL,
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS provider_plugin_manifests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_key TEXT NOT NULL UNIQUE,
      version TEXT NOT NULL,
      api_version TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      min_core_version TEXT NOT NULL,
      max_core_version TEXT,
      manifest_json TEXT NOT NULL,
      permissions_json TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      public_key_pem TEXT NOT NULL,
      signature_base64 TEXT NOT NULL,
      manifest_hash TEXT NOT NULL UNIQUE,
      signature_state TEXT NOT NULL CHECK(signature_state='verified'),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS provider_plugin_consents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_id INTEGER NOT NULL REFERENCES provider_plugin_manifests(id) ON DELETE CASCADE,
      manifest_hash TEXT NOT NULL,
      permission_key TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('granted','denied')),
      reason TEXT NOT NULL,
      decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      decided_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(plugin_id,manifest_hash,permission_key)
    );
    CREATE TABLE IF NOT EXISTS provider_plugin_sandbox_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_id INTEGER NOT NULL REFERENCES provider_plugin_manifests(id) ON DELETE CASCADE,
      method TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('passed','failed','timeout')),
      duration_ms INTEGER NOT NULL,
      response_json TEXT,
      response_hash TEXT,
      error_code TEXT,
      policy_json TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS provider_plugin_health_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_id INTEGER NOT NULL REFERENCES provider_plugin_manifests(id) ON DELETE CASCADE,
      observed_at TEXT NOT NULL,
      latency_ms REAL NOT NULL,
      request_count INTEGER NOT NULL,
      error_count INTEGER NOT NULL,
      crash_count INTEGER NOT NULL,
      evidence_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_virtual_hardware_scan_resource ON virtual_hardware_scans(resource_key,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_hardware_benchmark_metric ON hardware_benchmarks(suite,metric,observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workload_performance_window ON workload_performance_samples(host_id,resource_key,observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_plugin_health_window ON provider_plugin_health_metrics(plugin_id,observed_at DESC);
  `);
  const insert = db.prepare(`INSERT OR IGNORE INTO governance_permissions
    (permission_key,resource_type,verb,description) VALUES (?,?,?,?)`);
  for (const permission of PERMISSIONS) insert.run(...permission);
  const role = db.prepare("SELECT id FROM governance_roles WHERE slug='site-admin'").get();
  if (role) {
    const grant = db.prepare('INSERT OR IGNORE INTO governance_role_permissions (role_id,permission_key) VALUES (?,?)');
    for (const permission of PERMISSIONS) grant.run(role.id, permission[0]);
  }
};

exports._PERMISSIONS = PERMISSIONS;
