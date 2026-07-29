'use strict';

// V6.4a observability, event correlation and multi-signal alert foundation
// (B206-B215). Provider payloads are normalized into local evidence only;
// this migration does not enable a provider collector or mutation path.

const METRICS = [
  ['cpu.ready_ratio', 'ratio', 'gauge', 'Time ready to run but waiting for physical CPU'],
  ['cpu.steal_ratio', 'ratio', 'gauge', 'Guest CPU time involuntarily waiting for the hypervisor'],
  ['memory.balloon_bytes', 'bytes', 'gauge', 'Memory reclaimed by the hypervisor balloon driver'],
  ['memory.swap_bytes', 'bytes', 'gauge', 'Guest or hypervisor swap currently in use'],
  ['disk.read_operations_total', 'operations', 'counter', 'Accumulated disk read operations'],
  ['disk.write_operations_total', 'operations', 'counter', 'Accumulated disk write operations'],
  ['disk.read_latency_seconds', 'seconds', 'gauge', 'Observed disk read latency'],
  ['disk.write_latency_seconds', 'seconds', 'gauge', 'Observed disk write latency'],
  ['disk.queue_depth', 'operations', 'gauge', 'Outstanding storage operations'],
  ['storage.resync_ratio', 'ratio', 'gauge', 'Storage resynchronization progress from 0 to 1'],
  ['network.receive_errors_total', 'errors', 'counter', 'Accumulated receive errors'],
  ['network.transmit_errors_total', 'errors', 'counter', 'Accumulated transmit errors'],
  ['network.receive_drops_total', 'packets', 'counter', 'Accumulated receive packet drops'],
  ['network.transmit_drops_total', 'packets', 'counter', 'Accumulated transmit packet drops'],
  ['network.active_flows', 'flows', 'gauge', 'Observed active network flows'],
  ['network.mtu_incidents_total', 'incidents', 'counter', 'Accumulated MTU-related incidents'],
];

const PERMISSIONS = [
  ['vm_observability.read', 'vm_observability', 'read', 'Read VM charts, dashboards, events, topology and alerts'],
  ['vm_observability.manage', 'vm_observability', 'manage', 'Ingest events and configure topology and multi-signal rules'],
];

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vm_observability_event_cursors (
      provider_host_id INTEGER NOT NULL DEFAULT 0,
      adapter TEXT NOT NULL,
      cursor_value TEXT NOT NULL,
      cursor_kind TEXT NOT NULL DEFAULT 'opaque' CHECK(cursor_kind IN ('opaque','sequence','timestamp','resource_version')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(provider_host_id, adapter)
    );

    CREATE TABLE IF NOT EXISTS vm_observability_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_host_id INTEGER NOT NULL DEFAULT 0,
      provider TEXT NOT NULL,
      adapter TEXT NOT NULL,
      source TEXT NOT NULL,
      native_event_id TEXT,
      fingerprint TEXT NOT NULL,
      event_type TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('state','task','config','alert','metric','lifecycle','security','fabric')),
      severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','warning','high','critical')),
      resource_type TEXT NOT NULL DEFAULT 'vm',
      resource_key TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT,
      related_resources_json TEXT NOT NULL DEFAULT '[]',
      payload_json TEXT NOT NULL DEFAULT '{}',
      provenance_json TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      repeat_count INTEGER NOT NULL DEFAULT 1 CHECK(repeat_count >= 1)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vm_observability_native_event
      ON vm_observability_events(provider_host_id, adapter, native_event_id)
      WHERE native_event_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_vm_observability_event_fingerprint
      ON vm_observability_events(provider_host_id, fingerprint, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vm_observability_resource_time
      ON vm_observability_events(provider_host_id, resource_type, resource_key, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS vm_observability_topology_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_host_id INTEGER NOT NULL DEFAULT 0,
      from_type TEXT NOT NULL,
      from_key TEXT NOT NULL,
      to_type TEXT NOT NULL,
      to_key TEXT NOT NULL,
      relation TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      active INTEGER NOT NULL DEFAULT 1,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider_host_id, from_type, from_key, to_type, to_key, relation)
    );
    CREATE INDEX IF NOT EXISTS idx_vm_observability_topology_from
      ON vm_observability_topology_edges(provider_host_id, from_type, from_key, active);
    CREATE INDEX IF NOT EXISTS idx_vm_observability_topology_to
      ON vm_observability_topology_edges(provider_host_id, to_type, to_key, active);

    CREATE TABLE IF NOT EXISTS vm_observability_signal_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      resource_type TEXT NOT NULL DEFAULT 'vm',
      severity TEXT NOT NULL DEFAULT 'warning' CHECK(severity IN ('warning','high','critical')),
      match_mode TEXT NOT NULL DEFAULT 'all' CHECK(match_mode IN ('all','any')),
      duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK(duration_seconds BETWEEN 0 AND 604800),
      conditions_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vm_observability_signal_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER NOT NULL REFERENCES vm_observability_signal_rules(id) ON DELETE CASCADE,
      provider_host_id INTEGER NOT NULL DEFAULT 0,
      resource_type TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','resolved')),
      evidence_json TEXT NOT NULL,
      first_triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_evaluated_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK(occurrence_count >= 1)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vm_observability_active_signal
      ON vm_observability_signal_alerts(rule_id, provider_host_id, resource_type, resource_key)
      WHERE state = 'active';
    CREATE INDEX IF NOT EXISTS idx_vm_observability_signal_state
      ON vm_observability_signal_alerts(state, last_evaluated_at DESC);
  `);

  const metricInsert = db.prepare(`INSERT OR IGNORE INTO vm_metric_definitions
    (metric_key,unit,metric_kind,description) VALUES (?,?,?,?)`);
  for (const metric of METRICS) metricInsert.run(...metric);

  const permissionInsert = db.prepare(`INSERT OR IGNORE INTO governance_permissions
    (permission_key,resource_type,verb,description) VALUES (?,?,?,?)`);
  for (const permission of PERMISSIONS) permissionInsert.run(...permission);
  const roleId = db.prepare('SELECT id FROM governance_roles WHERE slug=?');
  const grant = db.prepare(`INSERT OR IGNORE INTO governance_role_permissions
    (role_id,permission_key) VALUES (?,?)`);
  const projectAdmin = roleId.get('project-admin');
  const siteAdmin = roleId.get('site-admin');
  if (projectAdmin) grant.run(projectAdmin.id, 'vm_observability.read');
  for (const permission of ['vm_observability.read', 'vm_observability.manage']) {
    if (siteAdmin) grant.run(siteAdmin.id, permission);
  }
};

exports._METRICS = METRICS;
exports._PERMISSIONS = PERMISSIONS;
