'use strict';

const Database = require('better-sqlite3');
const migration124 = require('../db/migrations/124_governance_foundation');
const migration125 = require('../db/migrations/125_governance_identity_policy');
const migration126 = require('../db/migrations/126_governance_metrics_foundation');
const migration127 = require('../db/migrations/127_vm_observability_correlation');
const { VmMetricsService } = require('../services/vm-metrics');
const { VmObservabilityService, EVENT_ADAPTERS } = require('../services/vm-observability');
const fs = require('fs');
const path = require('path');

function database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT, email TEXT,
      password_hash TEXT NOT NULL DEFAULT 'x', role TEXT NOT NULL DEFAULT 'viewer', is_active INTEGER NOT NULL DEFAULT 1,
      auth_source TEXT NOT NULL DEFAULT 'local', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE tenants (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT DEFAULT 'internal',
      usage_mode TEXT DEFAULT 'production', status TEXT DEFAULT 'active', is_default INTEGER DEFAULT 0, trial_expires_at TEXT,
      created_by TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE tenant_settings (tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE, key TEXT, value TEXT,
      updated_at TEXT DEFAULT (datetime('now')), PRIMARY KEY(tenant_id,key));
    CREATE TABLE user_tenants (user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      role TEXT DEFAULT 'viewer', is_owner INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY(user_id,tenant_id));
    CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE team_members (team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      is_leader INTEGER DEFAULT 0, added_by INTEGER, added_at TEXT DEFAULT (datetime('now')), PRIMARY KEY(team_id,user_id));
  `);
  db.prepare("INSERT INTO users (id,username,email,role) VALUES (1,'admin','admin@example.com','admin')").run();
  db.prepare("INSERT INTO tenants (id,slug,name,usage_mode,status,is_default) VALUES (1,'default','Default','production','active',1)").run();
  migration124.up(db); migration125.up(db); migration126.up(db); migration127.up(db);
  return db;
}

const admin = { id: 1, username: 'admin', role: 'admin' };
const metric = (resourceKey, metricKey, value, sampleAt, labels = { host: 'node-1' }) => ({
  resourceKey, metricKey, value, sampleAt, labels,
});

describe('V6.4a VM observability and event correlation (B206-B215)', () => {
  let db; let metrics; let observability;
  beforeEach(() => { db = database(); metrics = new VmMetricsService(() => db); observability = new VmObservabilityService(() => db); });
  afterEach(() => db.close());

  test('migration extends the metric catalog and event adapter catalog', () => {
    expect(db.prepare('SELECT COUNT(*) count FROM vm_metric_definitions').get().count).toBe(29);
    expect(db.prepare('SELECT COUNT(*) count FROM governance_permissions').get().count).toBe(27);
    expect(EVENT_ADAPTERS.map(item => item.key)).toEqual([
      'vsphere-watch', 'xapi-events', 'pve-cluster-log', 'azure-event-grid', 'webhook', 'poll',
    ]);
  });

  test('performance charts compare resources and include normalized event annotations', () => {
    const at = new Date(Date.now() - 60000).toISOString();
    metrics.ingest({ adapter: 'normalized-ingest', provider: 'manual', samples: [
      metric('vm-1', 'cpu.utilization_ratio', 0.4, at), metric('vm-2', 'cpu.utilization_ratio', 0.7, at),
    ] }, admin);
    observability.ingestEvents({ adapter: 'webhook', events: [{ nativeEventId: 'evt-1', eventType: 'VmMigrated',
      resourceKey: 'vm-1', title: 'VM migrated', occurredAt: at }] }, admin);
    const chart = observability.performance({ resourceKeys: 'vm-1,vm-2', metricKeys: 'cpu.utilization_ratio',
      from: new Date(Date.now() - 3600000).toISOString() }, admin);
    expect(chart.series).toHaveLength(2);
    expect(chart.annotations).toEqual([expect.objectContaining({ event_type: 'VmMigrated', resource_key: 'vm-1' })]);
  });

  test('contention dashboard exposes ready, steal, balloon and noisy-neighbor evidence', () => {
    const at = new Date().toISOString();
    metrics.ingest({ adapter: 'normalized-ingest', provider: 'manual', samples: [
      metric('vm-1', 'cpu.utilization_ratio', 0.3, at), metric('vm-1', 'cpu.ready_ratio', 0.08, at),
      metric('vm-1', 'cpu.steal_ratio', 0.06, at), metric('vm-1', 'memory.balloon_bytes', 1024, at),
      metric('vm-2', 'cpu.utilization_ratio', 0.95, at),
    ] }, admin);
    const row = observability.dashboard('contention', {}, admin).rows.find(item => item.resourceKey === 'vm-1');
    expect(row).toMatchObject({ status: 'contended', noisyNeighbor: { resourceKey: 'vm-2', cpuUtilizationRatio: 0.95 } });
    expect(row.signals).toEqual(expect.arrayContaining(['cpu-ready', 'cpu-steal', 'balloon', 'noisy-neighbor']));
  });

  test('storage and network dashboards derive bounded rates and incident signals', () => {
    const first = new Date(Date.now() - 60000).toISOString(); const last = new Date().toISOString();
    const ingest = sampleAt => metrics.ingest({ adapter: 'normalized-ingest', provider: 'manual', samples: [
      metric('vm-io', 'disk.read_bytes_total', sampleAt === first ? 1000 : 61000, sampleAt),
      metric('vm-io', 'disk.read_operations_total', sampleAt === first ? 10 : 70, sampleAt),
      metric('vm-io', 'disk.read_latency_seconds', 0.03, sampleAt),
      metric('vm-io', 'disk.queue_depth', 10, sampleAt),
      metric('vm-io', 'network.receive_bytes_total', sampleAt === first ? 1000 : 121000, sampleAt),
      metric('vm-io', 'network.receive_drops_total', sampleAt === first ? 1 : 61, sampleAt),
      metric('vm-io', 'network.mtu_incidents_total', sampleAt === first ? 0 : 1, sampleAt),
    ] }, admin);
    ingest(first); ingest(last);
    const storage = observability.dashboard('storage', {}, admin).rows[0];
    const network = observability.dashboard('network', {}, admin).rows[0];
    expect(storage).toMatchObject({ status: 'degraded' });
    expect(storage.readBytesPerSecond).toBeCloseTo(1000, -1);
    expect(storage.signals).toEqual(expect.arrayContaining(['read-latency', 'queue']));
    expect(network).toMatchObject({ status: 'degraded' });
    expect(network.signals).toEqual(expect.arrayContaining(['drops', 'mtu']));
  });

  test('event ingestion advances cursor and deduplicates native IDs with repeat evidence', () => {
    const body = { adapter: 'vsphere-watch', providerHostId: 7, cursor: { value: '102', kind: 'sequence' }, events: [{
      key: 'event-101', eventTypeId: 'VmReconfiguredEvent', vm: { value: 'vm-44' },
      fullFormattedMessage: 'VM configuration changed', createdTime: new Date().toISOString(),
    }] };
    expect(observability.ingestEvents(body, admin)).toMatchObject({ inserted: 1, duplicates: 0 });
    expect(observability.ingestEvents(body, admin)).toMatchObject({ inserted: 0, duplicates: 1 });
    expect(db.prepare('SELECT repeat_count FROM vm_observability_events').get().repeat_count).toBe(2);
    expect(db.prepare('SELECT cursor_value,cursor_kind FROM vm_observability_event_cursors').get())
      .toEqual({ cursor_value: '102', cursor_kind: 'sequence' });
  });

  test('correlation and VM incident timelines combine metrics with lifecycle context', () => {
    const at = new Date().toISOString();
    metrics.ingest({ adapter: 'normalized-ingest', provider: 'manual', samples: [metric('vm-incident', 'memory.used_bytes', 42, at)] }, admin);
    observability.ingestEvents({ adapter: 'poll', events: [{ eventType: 'VmRestarted', category: 'lifecycle',
      severity: 'warning', resourceKey: 'vm-incident', title: 'VM restarted', occurredAt: at }] }, admin);
    const timeline = observability.timeline({ resourceKey: 'vm-incident' }, admin);
    expect(timeline.items.map(item => item.kind)).toEqual(expect.arrayContaining(['event', 'metric']));
    expect(observability.incidentTimeline('vm-incident', {}, admin).summary).toMatchObject({ lifecycle: 1, metrics: 1 });
  });

  test('fabric topology propagates an upstream event through bounded dependencies', () => {
    observability.saveTopologyEdge({ fromType: 'storage', fromKey: 'ds-1', toType: 'host', toKey: 'host-1', relation: 'serves' }, admin);
    observability.saveTopologyEdge({ fromType: 'host', fromKey: 'host-1', toType: 'vm', toKey: 'vm-1', relation: 'runs' }, admin);
    const result = observability.ingestEvents({ adapter: 'webhook', events: [{ eventType: 'DatastoreDegraded', category: 'fabric',
      severity: 'high', resourceType: 'storage', resourceKey: 'ds-1', title: 'Datastore degraded' }] }, admin);
    expect(observability.topologyImpact(result.events[0].id, admin).impacted).toEqual([
      expect.objectContaining({ type: 'host', key: 'host-1', depth: 1 }),
      expect.objectContaining({ type: 'vm', key: 'vm-1', depth: 2 }),
    ]);
  });

  test('multi-signal rules require distinct signal types and create explainable alerts', () => {
    const first = new Date(Date.now() - 120000).toISOString(); const last = new Date().toISOString();
    metrics.ingest({ adapter: 'normalized-ingest', provider: 'manual', samples: [metric('vm-alert', 'cpu.utilization_ratio', 0.9, first)] }, admin);
    metrics.ingest({ adapter: 'normalized-ingest', provider: 'manual', samples: [metric('vm-alert', 'cpu.utilization_ratio', 0.95, last)] }, admin);
    observability.ingestEvents({ adapter: 'webhook', events: [{ eventType: 'VmRestarted', resourceKey: 'vm-alert',
      title: 'VM restarted', occurredAt: last }] }, admin);
    expect(() => observability.createSignalRule({ name: 'invalid', conditions: [{ type: 'metric',
      metricKey: 'cpu.utilization_ratio', operator: '>', threshold: 0.8 }, { type: 'metric',
      metricKey: 'cpu.ready_ratio', operator: '>', threshold: 0.1 }] }, admin)).toThrow(/signal types/);
    observability.createSignalRule({ name: 'CPU after restart', durationSeconds: 60, conditions: [{ type: 'metric',
      metricKey: 'cpu.utilization_ratio', operator: '>', threshold: 0.8, windowSeconds: 300 },
    { type: 'event', eventTypes: ['VmRestarted'], withinSeconds: 300 }] }, admin);
    expect(observability.evaluateSignals({}, admin)).toMatchObject({ triggered: 1, active: 1 });
    const alert = observability.signalRules(admin).alerts[0];
    expect(alert).toMatchObject({ rule_name: 'CPU after restart', resource_key: 'vm-alert', state: 'active' });
    expect(alert.evidence).toHaveLength(2);
  });

  test('API and Observability UI expose the ten feature contracts', () => {
    const root = path.join(__dirname, '..', '..');
    const route = fs.readFileSync(path.join(root, 'src/routes/vm-observability.js'), 'utf8');
    const api = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
    const page = fs.readFileSync(path.join(root, 'public/js/pages/governance-controls.js'), 'utf8');
    for (const endpoint of ['/performance', '/dashboards/:kind', '/events/ingest', '/timeline', '/incidents/:resourceKey',
      '/topology/impact/:eventId', '/signal-rules/evaluate']) expect(route).toContain(endpoint);
    for (const contract of ['getVmPerformance', 'getVmIncidentTimeline', 'saveVmObservabilityTopologyEdge',
      'evaluateVmSignalRules']) expect(api).toContain(contract);
    for (const label of ['VM performance comparison', 'Host contention', 'Storage performance', 'Network performance',
      'Normalized event timeline', 'Fabric topology edge', 'Create metric + event rule']) expect(page).toContain(label);
  });
});
