'use strict';

const Database = require('better-sqlite3');
const migration129 = require('../db/migrations/129_infrastructure_automation_manifests');
const migration131 = require('../db/migrations/131_automation_operations_lifecycle_updates');
const { InfrastructureAutomationService } = require('../services/infrastructure-automation');
const { InfrastructureOperationsService } = require('../services/infrastructure-operations');
const { LifecycleUpdatesService } = require('../services/lifecycle-updates');

function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE governance_permissions (permission_key TEXT PRIMARY KEY, resource_type TEXT NOT NULL, verb TEXT NOT NULL, description TEXT NOT NULL);
    CREATE TABLE governance_roles (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE);
    CREATE TABLE governance_role_permissions (role_id INTEGER REFERENCES governance_roles(id), permission_key TEXT REFERENCES governance_permissions(permission_key), PRIMARY KEY(role_id,permission_key));
  `);
  db.prepare("INSERT INTO users (id,username,role) VALUES (1,'admin','admin'),(2,'approver','admin'),(3,'escalation','admin')").run();
  db.prepare("INSERT INTO governance_roles (id,slug) VALUES (1,'site-admin')").run();
  migration129.up(db); migration131.up(db); return db;
}

const admin = { id: 1, username: 'admin', role: 'admin' };

describe('V0.3d automation operations and lifecycle readiness (B246-B255)', () => {
  let db; let automation; let operations; let lifecycle;
  beforeEach(() => {
    db = database(); automation = new InfrastructureAutomationService(() => db);
    operations = new InfrastructureOperationsService(() => db, { automationService: automation });
    lifecycle = new LifecycleUpdatesService(() => db);
  });
  afterEach(() => db.close());

  function workflow() {
    return automation.createWorkflow({ name: `fixture-${Date.now()}`, version: '1.0.0', steps: [
      { id: 'verify', stage: 1, needs: [], actionKey: 'host.verify', input: {}, lockScopes: ['host:7'] },
    ] }, admin);
  }
  function inventory(overrides = {}) {
    return lifecycle.recordInventory({ providerHostId: 7, componentType: 'host', vendor: 'Acme', product: 'Hypervisor',
      version: '7.0', build: 'build-42', source: 'provider-api', observedAt: new Date().toISOString(), evidence: { probe: 'api' }, ...overrides }, admin);
  }

  test('migration creates the twelve bounded stores, permissions and curated templates', () => {
    const names = ['infrastructure_schedule_triggers','infrastructure_schedule_runs','infrastructure_approval_requests',
      'infrastructure_dry_run_evidence','infrastructure_secret_broker_profiles','infrastructure_secret_access_events',
      'infrastructure_workflow_templates','lifecycle_version_inventory','lifecycle_support_registry','lifecycle_upgrade_paths',
      'lifecycle_update_catalog','lifecycle_upgrade_prechecks'];
    const placeholders = names.map(() => '?').join(',');
    expect(db.prepare(`SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`).get(...names).count).toBe(12);
    expect(db.prepare("SELECT COUNT(*) count FROM governance_permissions WHERE permission_key IN ('infrastructure_operations.manage','lifecycle_updates.manage')").get().count).toBe(2);
    expect(db.prepare('SELECT COUNT(*) count FROM infrastructure_workflow_templates WHERE curated=1').get().count).toBe(5);
  });

  test('calendar schedules honor timezone holidays and deduplicate minute evidence without executing workflows', () => {
    const item = operations.saveSchedule({ name: 'holiday-window', workflowId: workflow().id, cron: '* * * * *',
      timezone: 'Europe/Bucharest', holidays: ['2026-12-25'], enabled: true,
      blackoutWindows: [{ name: 'night-freeze', weekdays: [], start: '22:00', end: '06:00' }] }, admin);
    expect(operations.evaluateSchedule(item.id, '2026-12-25T10:15:00Z', admin)).toMatchObject({
      matchesCron: true, decision: 'holiday_suppressed', workflowExecutionStarted: false, local: { date: '2026-12-25' } });
    expect(operations.runDueSchedules(new Date('2026-12-25T10:15:30Z'))).toHaveLength(1);
    expect(operations.runDueSchedules(new Date('2026-12-25T10:15:55Z'))).toHaveLength(0);
    expect(operations.scheduleRuns(admin)[0].decision).toBe('holiday_suppressed');
  });

  test('approval deadlines escalate then expire and never imply apply', () => {
    const request = operations.createApproval({ actionKey: 'host.maintenance', targetType: 'host', targetId: 'host-7',
      payload: { mode: 'maintenance' }, dueMinutes: 1, escalationUserId: 3, escalationGraceMinutes: 5 }, admin);
    const escalated = operations.sweepApprovals(new Date(Date.now() + 2 * 60000))[0];
    expect(escalated).toMatchObject({ id: request.id, state: 'escalated', assigneeUserId: 3, escalationCount: 1, applyStarted: false });
    const expired = operations.sweepApprovals(new Date(Date.now() + 10 * 60000))[0];
    expect(expired).toMatchObject({ state: 'expired', applyStarted: false });
  });

  test('approval decisions require the reviewed payload hash and assigned actor', () => {
    const request = operations.createApproval({ actionKey: 'backup.execute', targetType: 'vm', targetId: 'vm-9',
      payload: { policy: 'daily' }, assigneeUserId: 2 }, admin);
    expect(() => operations.decideApproval(request.id, { decision: 'approved', payloadHash: request.payloadHash }, admin)).toThrow(/another user/);
    const approver = { id: 2, username: 'approver', role: 'admin' };
    expect(() => operations.decideApproval(request.id, { decision: 'approved', payloadHash: '0'.repeat(64) }, approver)).toThrow(/does not match/);
    expect(operations.decideApproval(request.id, { decision: 'approved', payloadHash: request.payloadHash }, approver))
      .toMatchObject({ state: 'approved', applyStarted: false });
  });

  test('dry-run adapters persist native evidence and report unsupported providers explicitly', async () => {
    operations = new InfrastructureOperationsService(() => db, { automationService: automation, dryRunAdapters: {
      proxmox: async input => ({ supported: true, valid: input.request.cpu <= 16, warnings: ['simulation only'] }),
    } });
    const valid = await operations.dryRun({ providerType: 'proxmox', actionKey: 'vm.resize', targetRef: 'vm-101', request: { cpu: 8 } }, admin);
    expect(valid).toMatchObject({ status: 'valid', providerMutationStarted: false, result: { supported: true, valid: true } });
    const unsupported = await operations.dryRun({ providerType: 'unknown', actionKey: 'vm.resize', targetRef: 'vm-101', request: {} }, admin);
    expect(unsupported).toMatchObject({ status: 'unsupported', result: { supported: false } });
    expect(operations.dryRuns(admin)).toHaveLength(2);
  });

  test('secret broker fetches just in time, zeroes the buffer and returns audit metadata only', async () => {
    let retained;
    operations = new InfrastructureOperationsService(() => db, { automationService: automation,
      secretAdapters: { vault: async () => 'super-sensitive-value' } });
    const profile = operations.saveSecretBroker({ name: 'ops-vault', providerKind: 'vault', secretReference: 'kv/ops/app',
      allowedPurposes: ['backup.execute'], maxLeaseSeconds: 30 }, admin);
    const result = await operations.withSecretLease(profile.id, 'backup.execute', admin, async (secret, lease) => {
      retained = secret; return { length: secret.length, fingerprint: lease.fingerprint, secretReturned: false };
    });
    expect(result).toMatchObject({ length: 21, secretReturned: false });
    expect([...retained].every(value => value === 0)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('super-sensitive-value');
    expect(operations.secretAccessEvents(admin)[0]).toMatchObject({ outcome: 'granted', purpose: 'backup.execute' });
    await expect(operations.probeSecretBroker(profile.id, 'vm.migrate', admin)).rejects.toThrow(/not allowed/);
  });

  test('curated workflow templates instantiate validated DAGs without starting execution', () => {
    const template = operations.workflowTemplates(admin).find(item => item.slug === 'host-maintenance-safe');
    const result = operations.instantiateTemplate(template.id, { name: 'host-seven-maintenance', version: '1.0.1',
      parameters: { hostId: '7' } }, admin);
    expect(result).toMatchObject({ template: { slug: 'host-maintenance-safe' }, executionStarted: false,
      workflow: { name: 'host-seven-maintenance', version: '1.0.1' } });
    expect(result.workflow.steps).toHaveLength(3);
    expect(result.workflow.steps[1].lockScopes).toEqual(['host:7']);
  });

  test('version inventory is upserted with build evidence and rejects secret-shaped fields', () => {
    const first = inventory(); const second = inventory({ version: '7.1', build: 'build-43' });
    expect(second).toMatchObject({ id: first.id, componentType: 'host', version: '7.1', build: 'build-43' });
    expect(lifecycle.inventory(admin)).toHaveLength(1);
    expect(() => inventory({ evidence: { apiToken: 'leak' } })).toThrow(/secret material/);
  });

  test('support registry derives EOL/EOS state and requires credential-free HTTPS evidence', () => {
    const support = lifecycle.saveSupport({ vendor: 'Acme', product: 'Hypervisor', versionLine: '7',
      gaDate: '2020-01-01', eolDate: '2025-01-01', eosDate: '2026-01-01', recommendedTarget: '8.0',
      sourceUrl: 'https://vendor.example/support/hypervisor-7', retrievedAt: new Date().toISOString() }, admin);
    expect(support.state).toBe('unsupported');
    expect(() => lifecycle.saveSupport({ vendor: 'Acme', product: 'Tool', versionLine: '1',
      sourceUrl: 'http://vendor.example/support' }, admin)).toThrow(/HTTPS/);
  });

  test('upgrade advisor returns vendor hops, prerequisites, blockers and no execution', () => {
    const item = inventory();
    lifecycle.saveSupport({ vendor: 'Acme', product: 'Hypervisor', versionLine: '8', eolDate: '2030-01-01',
      recommendedTarget: '8.2', sourceUrl: 'https://vendor.example/support/8' }, admin);
    lifecycle.saveUpgradePath({ vendor: 'Acme', product: 'Hypervisor', fromVersion: '7.0', toVersion: '8.2',
      supportedHops: ['7.0', '7.4', '8.0', '8.2'], prerequisites: ['verified backup'], blockers: [],
      sourceUrl: 'https://vendor.example/upgrade/7-to-8' }, admin);
    const advice = lifecycle.advise(item.id, '8.2', admin);
    expect(advice).toMatchObject({ status: 'advisory_ready', targetVersion: '8.2', upgradeStarted: false,
      path: { supportedHops: ['7.0', '7.4', '8.0', '8.2'] }, prerequisites: ['verified backup'], blockers: [] });
  });

  test('official update catalog ingestion is idempotent and never installs packages', () => {
    const body = { vendor: 'Acme', product: 'Hypervisor', sourceKind: 'official_vendor',
      sourceUrl: 'https://vendor.example/advisories/feed', items: [{ advisoryId: 'ADV-2026-01', title: 'Security bundle',
        updateKind: 'bundle', targetVersion: '8.2', severity: 'critical', publishedAt: '2026-07-01T00:00:00Z', metadata: { cves: 3 } }] };
    expect(lifecycle.ingestCatalog(body, admin)).toMatchObject({ created: 1, updated: 0, packagesInstalled: 0 });
    expect(lifecycle.ingestCatalog(body, admin)).toMatchObject({ created: 0, updated: 1, packagesInstalled: 0 });
    expect(() => lifecycle.ingestCatalog({ ...body, sourceKind: 'community' }, admin)).toThrow(/official_vendor/);
  });

  test('upgrade prechecks evaluate health, capacity, backup, compatibility and free space without upgrading', () => {
    const item = inventory(); const evidence = { health: { status: 'healthy' }, capacity: { headroomPercent: 35, requiredHeadroomPercent: 20 },
      backup: { verified: true, ageHours: 3 }, compatibility: { compatible: true },
      freeSpace: { availableBytes: 2000, requiredBytes: 1000 } };
    expect(lifecycle.runPrecheck({ inventoryId: item.id, targetVersion: '8.2', evidence }, admin))
      .toMatchObject({ status: 'ready', upgradeStarted: false });
    const blocked = lifecycle.runPrecheck({ inventoryId: item.id, targetVersion: '8.2', evidence: {
      ...evidence, backup: { verified: false, ageHours: 99 }, freeSpace: { availableBytes: 1, requiredBytes: 1000 } } }, admin);
    expect(blocked.status).toBe('blocked');
    expect(blocked.results.filter(result => !result.passed).map(result => result.check)).toEqual(expect.arrayContaining(['backup', 'free_space']));
  });
});
