'use strict';

const Database = require('better-sqlite3');
const migration124 = require('../db/migrations/124_governance_foundation');
const migration125 = require('../db/migrations/125_governance_identity_policy');
const migration126 = require('../db/migrations/126_governance_metrics_foundation');
const { GovernanceService } = require('../services/governance');
const { GovernanceLifecycleService } = require('../services/governance-lifecycle');
const { VmMetricsService, ADAPTER_CATALOG } = require('../services/vm-metrics');
const appMetrics = require('../services/metrics');
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
  db.prepare("INSERT INTO users (id,username,email,role) VALUES (2,'holder','holder@example.com','viewer')").run();
  db.prepare("INSERT INTO users (id,username,email,role) VALUES (3,'cleanup','cleanup@example.com','operator')").run();
  db.prepare("INSERT INTO tenants (id,slug,name,usage_mode,status,is_default) VALUES (1,'default','Default','production','active',1)").run();
  migration124.up(db); migration125.up(db); migration126.up(db);
  return db;
}

const admin = { id: 1, username: 'admin', role: 'admin' };
const holder = { id: 2, username: 'holder', role: 'viewer' };
const cleanup = { id: 3, username: 'cleanup', role: 'operator' };

function resource(db, tenantId = 1, key = 'vm-1') {
  return Number(db.prepare(`INSERT INTO governance_project_resources
    (tenant_id,resource_type,resource_key,display_name) VALUES (?,'vm',?,?)`).run(tenantId, key, key).lastInsertRowid);
}

describe('V4.6c governance lifecycle and VM metrics foundation', () => {
  let db; let lifecycle; let vmMetrics;
  beforeEach(() => { db = database(); lifecycle = new GovernanceLifecycleService(() => db); vmMetrics = new VmMetricsService(() => db); });
  afterEach(() => db.close());

  test('migration seeds the unified metric schema, adapter catalog and permissions', () => {
    expect(db.prepare('SELECT COUNT(*) AS count FROM vm_metric_definitions').get().count).toBe(13);
    expect(ADAPTER_CATALOG.map(item => item.key)).toEqual([
      'pve-rrd', 'xapi-rrd', 'vsphere-performance', 'prometheus', 'azure-monitor',
    ]);
    const permissions = db.prepare('SELECT permission_key FROM governance_permissions').all().map(row => row.permission_key);
    expect(permissions).toEqual(expect.arrayContaining(['resource_lease.manage', 'tenant.offboard', 'vm_metrics.manage']));
  });

  test('lease policies enforce TTL, renewal rights, renewal count and cleanup ownership', () => {
    const resourceId = resource(db);
    lifecycle.saveLeasePolicy(1, { resourceType: 'vm', maxTtlSeconds: 600,
      maxRenewals: 1, renewalMode: 'holder', cleanupOwnerUserId: 3 }, admin);
    expect(() => lifecycle.createLease(1, { resourceId, holderUserId: 2,
      expiresAt: new Date(Date.now() + 601000).toISOString() }, admin))
      .toThrow(expect.objectContaining({ code: 'LEASE_TTL_EXCEEDED' }));
    const lease = lifecycle.createLease(1, { resourceId, holderUserId: 2,
      expiresAt: new Date(Date.now() + 300000).toISOString() }, admin);
    expect(() => lifecycle.renewLease(lease.id, { ttlSeconds: 300 }, cleanup)).toThrow(expect.objectContaining({ code: 'LEASE_RENEWAL_FORBIDDEN' }));
    expect(lifecycle.renewLease(lease.id, { ttlSeconds: 300 }, holder).renewal_count).toBe(1);
    expect(() => lifecycle.renewLease(lease.id, { ttlSeconds: 300 }, holder)).toThrow(expect.objectContaining({ code: 'LEASE_RENEWAL_LIMIT' }));
    db.prepare("UPDATE governance_resource_leases SET expires_at=datetime('now','-1 minute') WHERE id=?").run(lease.id);
    expect(lifecycle.reconcileLeases()).toEqual({ flaggedForCleanup: 1 });
    expect(lifecycle.releaseLease(lease.id, { cleaned: true }, cleanup).state).toBe('cleaned');
  });

  test('production assignment is blocked until owner, service and cost center are complete', () => {
    const governance = new GovernanceService(() => db);
    lifecycle.ownershipPolicy(1, {}, admin);
    expect(() => governance.assignResource(1, { resourceType: 'vm', resourceKey: 'prod-1' }, admin))
      .toThrow(expect.objectContaining({ code: 'OWNERSHIP_INCOMPLETE' }));
    const assigned = governance.assignResource(1, { resourceType: 'vm', resourceKey: 'prod-1', metadata: {
      ownership: { ownerUserId: 2, serviceName: 'billing', costCenter: 'CC-42', environment: 'production' },
    } }, admin);
    expect(db.prepare('SELECT * FROM governance_resource_ownership WHERE resource_id=?').get(assigned.resource.id))
      .toMatchObject({ completeness_state: 'complete', service_name: 'billing', cost_center: 'CC-42' });
  });

  test('SoD report detects effective direct plus team role conflicts', () => {
    const scopeId = db.prepare("SELECT id FROM governance_scopes WHERE tenant_id=1").get().id;
    const left = db.prepare("SELECT id FROM governance_roles WHERE slug='project-operator'").get().id;
    const right = db.prepare("SELECT id FROM governance_roles WHERE slug='project-admin'").get().id;
    db.prepare("INSERT INTO teams (id,name) VALUES (1,'Privileged')").run();
    db.prepare('INSERT INTO team_members (team_id,user_id) VALUES (1,2)').run();
    db.prepare('INSERT INTO governance_role_bindings (role_id,scope_id,user_id) VALUES (?,?,2)').run(left, scopeId);
    db.prepare('INSERT INTO governance_role_bindings (role_id,scope_id,team_id) VALUES (?,?,1)').run(right, scopeId);
    lifecycle.saveSodRule({ name: 'Operate vs approve', leftRoleId: left, rightRoleId: right, severity: 'critical' }, admin);
    expect(lifecycle.sodReport(admin).findings).toEqual([expect.objectContaining({ username: 'holder', severity: 'critical' })]);
  });

  test('access reviews snapshot bindings and service accounts, then apply revoke decisions', () => {
    const scopeId = db.prepare("SELECT id FROM governance_scopes WHERE tenant_id=1").get().id;
    const roleId = db.prepare("SELECT id FROM governance_roles WHERE slug='project-viewer'").get().id;
    const bindingId = Number(db.prepare('INSERT INTO governance_role_bindings (role_id,scope_id,user_id) VALUES (?,?,2)')
      .run(roleId, scopeId).lastInsertRowid);
    const tokenId = Number(db.prepare(`INSERT INTO governance_service_tokens
      (name,principal,token_prefix,token_hash,scopes_json,tenant_id,expires_at,created_by)
      VALUES ('automation','svc:ci','ddst_ci','hash-ci','["api.read"]',1,datetime('now','+1 day'),1)`).run().lastInsertRowid);
    const campaign = lifecycle.createReviewCampaign({ name: 'Quarterly review', tenantId: 1, reviewKind: 'all',
      dueAt: new Date(Date.now() + 86400000).toISOString() }, admin);
    const items = lifecycle.reviewItems(campaign.id, admin);
    const bindingItem = items.find(item => item.binding_id === bindingId);
    const tokenItem = items.find(item => item.service_token_id === tokenId);
    lifecycle.decideReviewItem(bindingItem.id, { decision: 'revoke', comment: 'no longer needed' }, admin);
    lifecycle.decideReviewItem(tokenItem.id, { decision: 'revoke', comment: 'pipeline retired' }, admin);
    expect(db.prepare('SELECT expires_at FROM governance_role_bindings WHERE id=?').get(bindingId).expires_at).toBeTruthy();
    expect(db.prepare('SELECT revoked_at FROM governance_service_tokens WHERE id=?').get(tokenId).revoked_at).toBeTruthy();
    expect(lifecycle.completeReviewCampaign(campaign.id, admin).state).toBe('completed');
  });

  test('tenant export and controlled offboarding preserve the export and reject unsafe deletion', () => {
    db.prepare("INSERT INTO tenants (id,slug,name,status) VALUES (2,'retired','Retired','suspended')").run();
    const resourceId = resource(db, 2, 'retired-vm');
    db.prepare(`INSERT INTO governance_resource_ownership
      (resource_id,tenant_id,owner_user_id,service_name,cost_center,environment,completeness_state,updated_by)
      VALUES (?,2,2,'archive','CC-9','nonproduction','complete',1)`).run(resourceId);
    const tenantExport = lifecycle.exportTenant(2, admin);
    const plan = lifecycle.planOffboarding(2, { exportId: tenantExport.id }, admin);
    expect(plan).toMatchObject({ state: 'ready', blockers: [] });
    expect(() => lifecycle.completeOffboarding(plan.id, { confirmation: 'DELETE retired', checksumSha256: '0'.repeat(64) }, admin))
      .toThrow(expect.objectContaining({ code: 'EXPORT_CHECKSUM_MISMATCH' }));
    expect(lifecycle.completeOffboarding(plan.id, { confirmation: 'DELETE retired', checksumSha256: tenantExport.checksumSha256 }, admin))
      .toMatchObject({ completed: true, tenantSlug: 'retired' });
    expect(db.prepare('SELECT 1 FROM tenants WHERE id=2').get()).toBeUndefined();
    expect(lifecycle.getTenantExport(tenantExport.id, admin).tenantId).toBeNull();
    const defaultExport = lifecycle.exportTenant(1, admin);
    expect(lifecycle.planOffboarding(1, { exportId: defaultExport.id }, admin).blockers.map(item => item.code)).toContain('DEFAULT_TENANT');
  });

  test.each([
    ['pve-rrd', [{ vmid: 101, cpu: 0.5, mem: 1024, maxmem: 2048, netin: 10 }]],
    ['xapi-rrd', [{ uuid: 'xen-1', values: { cpu0: 0.2, memory_actual: 1024, vif_0_rx: 9 } }]],
    ['vsphere-performance', [{ moref: 'vm-44', cpuUsageMHz: 500, memoryUsageMB: 2, memoryMB: 4 }]],
    ['prometheus', [{ name: 'docker_dash_vm_cpu_utilization_ratio', resourceKey: 'prom-1', value: 0.3 }]],
    ['azure-monitor', [{ resourceId: 'azure-1', name: { value: 'Percentage CPU' }, points: [{ average: 25 }] }]],
  ])('%s adapter normalizes provider samples into the shared schema', (adapter, samples) => {
    const result = vmMetrics.ingest({ adapter, providerHostId: 4, samples }, admin);
    expect(result.acceptedSamples).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM vm_metric_samples WHERE adapter=?').get(adapter).count).toBeGreaterThan(0);
    const row = db.prepare('SELECT metric_key,unit,provenance_json FROM vm_metric_samples WHERE adapter=? LIMIT 1').get(adapter);
    expect(row.unit).toBeTruthy();
    expect(JSON.parse(row.provenance_json).source).toBeTruthy();
  });

  test('freshness exposes lag and collection errors per resource', () => {
    vmMetrics.ingest({ adapter: 'prometheus', providerHostId: 8, samples: [{
      metricKey: 'memory.used_bytes', resourceKey: 'vm-stale', value: 42,
      timestamp: new Date(Date.now() - 3600000).toISOString(),
    }] }, admin);
    expect(vmMetrics.freshness({ providerHostId: 8 }, admin).resources[0]).toMatchObject({ status: 'stale' });
    const failed = vmMetrics.recordCollectionError({ adapter: 'prometheus', providerHostId: 8,
      resourceKey: 'vm-stale', error: 'query timeout' }, admin);
    expect(failed).toMatchObject({ status: 'error', consecutive_errors: 1, last_error: 'query timeout' });
  });

  test('adaptive polling honors activity, page visibility and provider rate budget', () => {
    vmMetrics.savePollingPolicy(9, { activeIntervalSeconds: 20, idleIntervalSeconds: 300,
      hiddenMultiplier: 5, rateBudgetPerMinute: 60, activityWindowSeconds: 120 }, admin);
    expect(vmMetrics.pollingDecision(9, { active: true, pageVisible: false, resourceCount: 600 }, admin))
      .toMatchObject({ intervalSeconds: 600, reasons: ['recent-activity', 'page-hidden', 'rate-budget'] });
    expect(vmMetrics.pollingDecision(9, { active: false, activityAgeSeconds: 999, resourceCount: 1 }, admin).intervalSeconds).toBe(300);
  });

  test('cardinality guard drops excess metrics and records bounded rejection evidence', () => {
    vmMetrics.saveCardinalityPolicy(10, { maxResourcesPerBatch: 1, maxMetricsPerResource: 1,
      maxLabelKeys: 1, maxLabelValueLength: 20, maxSeriesPerBatch: 1 }, admin);
    const result = vmMetrics.ingest({ adapter: 'pve-rrd', providerHostId: 10,
      samples: [{ vmid: 100, node: 'pve1', cpu: 0.2, mem: 100, maxmem: 200, netin: 5 }] }, admin);
    expect(result.acceptedSamples).toBe(1);
    expect(result.droppedSamples).toBeGreaterThan(0);
    expect(db.prepare('SELECT SUM(dropped_count) AS count FROM vm_metric_cardinality_events WHERE provider_host_id=10').get().count)
      .toBeGreaterThan(0);
  });

  test('lifecycle UI/API are wired and bounded telemetry is exported to Prometheus', () => {
    appMetrics._reset();
    vmMetrics.ingest({ adapter: 'pve-rrd', samples: [{ vmid: 7, cpu: 0.1, mem: 100 }] }, admin);
    expect(appMetrics.renderPrometheus()).toContain('docker_dash_vm_metric_ingest_total{adapter="pve-rrd",result="accepted"}');
    const root = path.join(__dirname, '..', '..');
    expect(fs.readFileSync(path.join(root, 'src/routes/governance.js'), 'utf8')).toContain("router.use('/lifecycle'");
    const api = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
    const page = fs.readFileSync(path.join(root, 'public/js/pages/governance-controls.js'), 'utf8');
    for (const contract of ['saveResourceLeasePolicy', 'createAccessReviewCampaign', 'planGovernanceTenantOffboarding',
      'saveVmMetricCardinalityPolicy']) expect(api).toContain(contract);
    for (const label of ['Resource leases', 'Separation of duties', 'Provider metric adapters', 'Freshness by VM resource']) {
      expect(page).toContain(label);
    }
    appMetrics._reset();
  });
});
