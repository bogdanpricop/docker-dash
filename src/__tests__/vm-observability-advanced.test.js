'use strict';

const Database = require('better-sqlite3');
const migration124 = require('../db/migrations/124_governance_foundation');
const migration125 = require('../db/migrations/125_governance_identity_policy');
const migration126 = require('../db/migrations/126_governance_metrics_foundation');
const migration127 = require('../db/migrations/127_vm_observability_correlation');
const migration128 = require('../db/migrations/128_vm_observability_operations');
const { VmMetricsService } = require('../services/vm-metrics');
const { VmObservabilityService } = require('../services/vm-observability');
const advancedModule = require('../services/vm-observability-advanced');
const { VmObservabilityAdvancedService } = advancedModule;
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
  migration124.up(db); migration125.up(db); migration126.up(db); migration127.up(db); migration128.up(db);
  return db;
}

const admin = { id: 1, username: 'admin', role: 'admin' };
const isoAgo = milliseconds => new Date(Date.now() - milliseconds).toISOString();

describe('V6.4b advanced VM observability operations (B216-B225)', () => {
  let db; let metrics; let observability; let advanced;
  beforeEach(() => {
    db = database(); metrics = new VmMetricsService(() => db); observability = new VmObservabilityService(() => db);
    advanced = new VmObservabilityAdvancedService(() => db);
  });
  afterEach(() => { jest.restoreAllMocks(); db.close(); });

  function insertMetric(resourceKey, metricKey, value, sampleAt, host = 0, labels = {}) {
    const unit = db.prepare('SELECT unit FROM vm_metric_definitions WHERE metric_key=?').get(metricKey).unit;
    db.prepare(`INSERT INTO vm_metric_samples
      (provider_host_id,provider,adapter,resource_type,resource_key,metric_key,value,unit,sample_at,labels_json,provenance_json,series_fingerprint)
      VALUES (?,'manual','test','vm',?,?,?,?,?,'{}',?,?)`).run(host, resourceKey, metricKey, value, unit, sampleAt,
      JSON.stringify(labels), `${host}-${resourceKey}-${metricKey}-${sampleAt}-${value}`);
  }

  test('migration installs policies, permissions and versioned default runbooks', () => {
    expect(db.prepare('SELECT COUNT(*) count FROM governance_permissions').get().count).toBe(29);
    expect(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name LIKE 'vm_observability_%'").get().count).toBe(16);
    const overview = advanced.overview(admin);
    expect(overview.runbooks).toHaveLength(3);
    expect(overview.privacyPolicies[0]).toMatchObject({ provider_host_id: 0, sampling_ratio: 1, redactedLabelKeys: expect.any(Array) });
  });

  test('dynamic baselines use seasonal evidence and retain explainable assessments', () => {
    for (let day = 5; day >= 1; day -= 1) insertMetric('vm-baseline', 'cpu.utilization_ratio', 0.2,
      new Date(Date.now() - day * 86400000).toISOString());
    insertMetric('vm-baseline', 'cpu.utilization_ratio', 0.8, new Date().toISOString());
    const policy = advanced.createBaseline({ name: 'CPU seasonal', metricKey: 'cpu.utilization_ratio',
      seasonality: 'hour_of_day', minimumSamples: 4, deviationMultiplier: 2 }, admin);
    const result = advanced.evaluateBaselines({ policyId: policy.id }, admin);
    expect(result.assessments[0]).toMatchObject({ resourceKey: 'vm-baseline', status: 'above_baseline', sampleCount: 5 });
    expect(result.assessments[0].explanation).toMatchObject({ seasonality: 'hour_of_day', minimumSamples: 4 });
  });

  test('dependency and maintenance suppression coexist and reconcile safely', () => {
    const rule = observability.createSignalRule({ name: 'Incident', conditions: [
      { type: 'state', field: 'collection_error', operator: '>', threshold: 0 },
      { type: 'event', eventTypes: ['Failure'], withinSeconds: 300 },
    ] }, admin);
    const addAlert = resourceKey => Number(db.prepare(`INSERT INTO vm_observability_signal_alerts
      (rule_id,provider_host_id,resource_type,resource_key,evidence_json) VALUES (?,?,?,?,?)`)
      .run(rule.id, 0, 'vm', resourceKey, '[]').lastInsertRowid);
    addAlert('upstream'); const downstream = addAlert('downstream');
    observability.saveTopologyEdge({ fromType: 'vm', fromKey: 'upstream', toType: 'vm', toKey: 'downstream', relation: 'depends_on' }, admin);
    advanced.createMaintenance({ name: 'Patch', scopeType: 'vm', scopeKey: 'downstream', startsAt: isoAgo(60000),
      endsAt: new Date(Date.now() + 3600000).toISOString(), reason: 'Approved patch' }, admin);
    expect(advanced.reconcileSuppressions(admin)).toMatchObject({ created: 2, active: 2 });
    expect(db.prepare('SELECT suppression_kind FROM vm_observability_alert_suppressions WHERE alert_id=? ORDER BY suppression_kind')
      .all(downstream).map(row => row.suppression_kind)).toEqual(['dependency', 'maintenance']);
  });

  test('capacity forecast selects the latest daily points and records confidence evidence', () => {
    for (let day = 4; day >= 1; day -= 1) {
      const at = new Date(Date.now() - day * 86400000).toISOString(); insertMetric('vm-disk', 'disk.used_bytes', (5 - day) * 10, at);
      insertMetric('vm-disk', 'disk.used_bytes', 1, new Date(Date.parse(at) - 3600000).toISOString());
    }
    insertMetric('vm-disk', 'disk.provisioned_bytes', 100, new Date().toISOString());
    const forecast = advanced.capacityForecast({ resourceType: 'vm', resourceKey: 'vm-disk', metricKey: 'disk.used_bytes' }, admin);
    expect(forecast).toMatchObject({ status: 'forecast', capacityValue: 100, sampleCount: 4 });
    expect(forecast.evidence).toMatchObject({ confidenceBand: 'high', capacitySource: 'canonical_metric' });
    expect(Date.parse(forecast.projectedFullAt)).toBeGreaterThan(Date.now());
  });

  test('triage ranks topology evidence and attaches matching versioned runbooks', () => {
    observability.saveTopologyEdge({ fromType: 'storage', fromKey: 'ds-1', toType: 'vm', toKey: 'vm-1', relation: 'serves' }, admin);
    observability.ingestEvents({ adapter: 'webhook', events: [{ nativeEventId: 'storage-1', eventType: 'DatastoreFailure',
      category: 'fabric', severity: 'critical', resourceType: 'storage', resourceKey: 'ds-1', title: 'Datastore storage failure' }] }, admin);
    const incident = observability.ingestEvents({ adapter: 'webhook', events: [{ nativeEventId: 'vm-1', eventType: 'VmRestarted',
      category: 'lifecycle', severity: 'high', resourceType: 'vm', resourceKey: 'vm-1', title: 'VM restart after storage fault' }] }, admin);
    const report = advanced.triage({ eventId: incident.events[0].id }, admin);
    expect(report.summary).toContain('advisory');
    expect(report.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'upstream_dependency', resourceKey: 'ds-1' })]));
    expect(report.runbooks).toEqual(expect.arrayContaining([expect.objectContaining({ version: '1.0' })]));
  });

  test('privacy policies redact intake, sample deterministically and require typed retention confirmation', () => {
    advanced.privacyPolicy(9, { redactedLabelKeys: ['user'], redactEventMessage: true, redactRawPayload: true,
      samplingRatio: 1, metricRetentionDays: 1, eventRetentionDays: 1, residencyRegion: 'eu' }, admin);
    metrics.ingest({ providerHostId: 9, adapter: 'normalized-ingest', provider: 'manual', samples: [{ resourceKey: 'private-vm',
      metricKey: 'cpu.utilization_ratio', value: 0.4, sampleAt: isoAgo(2 * 86400000), labels: { user: 'secret', zone: 'eu-1' } }] }, admin);
    const metricRow = db.prepare('SELECT labels_json FROM vm_metric_samples WHERE provider_host_id=9').get();
    expect(JSON.parse(metricRow.labels_json)).toEqual({ zone: 'eu-1' });
    observability.ingestEvents({ providerHostId: 9, adapter: 'webhook', events: [{ eventType: 'Failure', resourceKey: 'private-vm',
      title: 'Failure', message: 'private details', occurredAt: isoAgo(2 * 86400000), secret: 'raw secret' }] }, admin);
    const event = db.prepare('SELECT message,payload_json FROM vm_observability_events WHERE provider_host_id=9').get();
    expect(event).toEqual({ message: '[REDACTED]', payload_json: '{"redacted":true}' });
    expect(advanced.retentionPlan(9, admin)).toMatchObject({ metricSamples: 1, events: 1, confirmation: 'PURGE TELEMETRY' });
    expect(() => advanced.applyRetention(9, { confirmation: 'purge' }, admin)).toThrow(/Exact confirmation/);
    expect(advanced.applyRetention(9, { confirmation: 'PURGE TELEMETRY' }, admin)).toMatchObject({ deletedMetricSamples: 1, deletedEvents: 1 });

    advanced.privacyPolicy(10, { samplingRatio: 0.5, metricRetentionDays: 30, eventRetentionDays: 90,
      residencyRegion: 'local' }, admin);
    const batch = Array.from({ length: 20 }, (_, index) => ({ resourceKey: `vm-${index}`, metricKey: 'cpu.utilization_ratio',
      value: index / 100, sampleAt: '2026-01-01T00:00:00.000Z' }));
    const first = metrics.ingest({ providerHostId: 10, adapter: 'normalized-ingest', provider: 'manual', samples: batch }, admin);
    const second = metrics.ingest({ providerHostId: 10, adapter: 'normalized-ingest', provider: 'manual', samples: batch }, admin);
    expect(first.sampledOut).toBeGreaterThan(0); expect(first.sampledOut).toBe(second.sampledOut);
  });

  test('bounded exports apply per-host redaction, residency and explicit delivery', async () => {
    advanced.privacyPolicy(7, { redactedLabelKeys: ['user'], samplingRatio: 1, metricRetentionDays: 30,
      eventRetentionDays: 90, residencyRegion: 'eu' }, admin);
    metrics.ingest({ providerHostId: 7, adapter: 'normalized-ingest', provider: 'manual', samples: [{ resourceKey: 'vm-export',
      metricKey: 'cpu.utilization_ratio', value: 0.5, labels: { user: 'hidden', zone: 'eu-1' } }] }, admin);
    const target = advanced.createExportTarget({ name: 'EU webhook', exportKind: 'webhook', endpoint: 'https://example.com/ingest',
      region: 'eu', filters: { providerHostIds: [7] } }, admin);
    const preview = advanced.exportPreview(target.id, {}, admin);
    expect(preview.byteSize).toBeLessThan(1024 * 1024); expect(preview.preview).not.toContain('hidden'); expect(preview.preview).toContain('eu-1');
    const send = jest.spyOn(advancedModule._transport, 'http').mockResolvedValue({ responseCode: 202, responseBody: 'accepted' });
    await expect(advanced.deliverExport(target.id, {}, admin)).resolves.toMatchObject({ status: 'delivered', responseCode: 202 });
    expect(send).toHaveBeenCalledTimes(1);
    const wrongRegion = advanced.createExportTarget({ name: 'US webhook', exportKind: 'webhook', endpoint: 'https://example.com/ingest',
      region: 'us', filters: { providerHostIds: [7] } }, admin);
    await expect(advanced.deliverExport(wrongRegion.id, {}, admin)).rejects.toMatchObject({ code: 'TELEMETRY_RESIDENCY_MISMATCH' });
  });

  test('SLO reports exclude the union of overlapping maintenance windows', () => {
    const up = isoAgo(2 * 3600000); const down = isoAgo(3600000); const recovered = isoAgo(30 * 60000);
    for (const [nativeEventId, eventType, occurredAt] of [['up', 'VmPoweredUp', up], ['down', 'VmPoweredDown', down], ['recovered', 'VmPoweredUp', recovered]]) {
      observability.ingestEvents({ adapter: 'webhook', events: [{ nativeEventId, eventType, resourceKey: 'vm-slo', title: eventType, occurredAt }] }, admin);
    }
    advanced.createMaintenance({ name: 'Window A', scopeType: 'vm', scopeKey: 'vm-slo', startsAt: isoAgo(50 * 60000),
      endsAt: isoAgo(20 * 60000), reason: 'Approved' }, admin);
    advanced.createMaintenance({ name: 'Window B', scopeType: 'vm', scopeKey: 'vm-slo', startsAt: isoAgo(45 * 60000),
      endsAt: isoAgo(15 * 60000), reason: 'Overlapping approved work' }, admin);
    advanced.saveSlo({ name: 'VM availability', resourceType: 'vm', resourceKey: 'vm-slo', targetRatio: 0.9,
      windowDays: 1, excludeMaintenance: true }, admin);
    const report = advanced.sloReports(admin).reports[0];
    expect(report).toMatchObject({ status: 'met', evidenceEvents: 3 });
    expect(report.maintenanceExcludedSeconds).toBeGreaterThanOrEqual(2090);
    expect(report.maintenanceExcludedSeconds).toBeLessThanOrEqual(2110);
  });

  test('API and governance UI expose all ten operational contracts', () => {
    const root = path.join(__dirname, '..', '..');
    const route = fs.readFileSync(path.join(root, 'src/routes/vm-observability.js'), 'utf8');
    const api = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
    const page = fs.readFileSync(path.join(root, 'public/js/pages/governance-controls.js'), 'utf8');
    for (const endpoint of ['/baselines/evaluate', '/suppressions/reconcile', '/maintenance', '/capacity-forecast', '/triage',
      '/runbooks', '/exports/:id/deliver', '/slo/reports', '/privacy/:hostId/retention/apply']) expect(route).toContain(endpoint);
    for (const contract of ['createVmDynamicBaseline', 'createVmObservabilityMaintenance', 'createVmCapacityForecast',
      'createVmIncidentTriage', 'deliverVmObservabilityExport', 'saveVmSlo', 'saveVmTelemetryPrivacy']) expect(api).toContain(contract);
    for (const label of ['Dynamic baseline', 'Dependency & maintenance suppression', 'Capacity forecast', 'Triage assistant',
      'Runbook links', 'Observability export', 'SLO availability', 'Telemetry privacy']) expect(page).toContain(label);
  });
});
