'use strict';

const Database = require('better-sqlite3');
const migration044 = require('../db/migrations/044_tracked_certificates');
const migration132 = require('../db/migrations/132_lifecycle_maintenance_compatibility');
const { LifecycleMaintenanceService, _internals } = require('../services/lifecycle-maintenance');

function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE governance_permissions (permission_key TEXT PRIMARY KEY, resource_type TEXT NOT NULL, verb TEXT NOT NULL, description TEXT NOT NULL);
    CREATE TABLE governance_roles (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE);
    CREATE TABLE governance_role_permissions (role_id INTEGER REFERENCES governance_roles(id), permission_key TEXT REFERENCES governance_permissions(permission_key), PRIMARY KEY(role_id,permission_key));
    CREATE TABLE provider_operations (id TEXT PRIMARY KEY, host_id INTEGER, state TEXT NOT NULL);
    CREATE TABLE infrastructure_approval_requests (id INTEGER PRIMARY KEY, action_key TEXT NOT NULL, target_id TEXT NOT NULL, payload_hash TEXT NOT NULL, state TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO users (id,username,role) VALUES (1,'admin','admin'),(2,'escalation','admin')").run();
  db.prepare("INSERT INTO governance_roles (id,slug) VALUES (1,'site-admin')").run();
  migration044.up(db); migration132.up(db); return db;
}

const admin = { id: 1, username: 'admin', role: 'admin' };
const future = (hours = 24) => new Date(Date.now() + hours * 3600000).toISOString();
const target = (ref, overrides = {}) => ({ ref, providerHostId: 7, owner: 'platform', availabilityGroup: ref,
  estimatedMinutes: 20, precheck: { healthReady: true, compatible: true, haReady: true,
    evacuationReady: true, guestResponsive: true }, protection: { backupVerified: true }, ...overrides });

describe('V0.3e lifecycle maintenance and compatibility (B256-B265)', () => {
  let db; let lifecycle;
  beforeEach(() => { db = database(); lifecycle = new LifecycleMaintenanceService(() => db); });
  afterEach(() => db.close());

  function readyPlan(overrides = {}) {
    return lifecycle.createMaintenancePlan({ name: `window-${Date.now()}`, scopeType: 'cluster', scopeKey: 'cluster-a',
      startsAt: future(), timezone: 'Europe/Bucharest', durationMinutes: 180, waveSize: 2,
      maxConcurrentPerOwner: 1, evacuation: { capacityVerified: true, destinationRefs: ['cluster-b'] },
      targets: [target('node-a'), target('node-b', { owner: 'database' })], ...overrides }, admin);
  }
  function campaign(kind = 'rolling_cluster', overrides = {}) {
    return lifecycle.createCampaign({ kind, name: `${kind}-${Date.now()}`, targetVersion: '8.0.2', waveSize: 1,
      targets: [target('node-a', { currentVersion: '8.0.1' }), target('node-b', { currentVersion: '8.0.1' })],
      ...overrides }, admin);
  }
  function operation(state = 'succeeded', hostId = 7) {
    const id = `op_${'a'.repeat(25)}${state === 'failed' ? 'b' : 'a'}`;
    db.prepare('INSERT OR REPLACE INTO provider_operations (id,host_id,state) VALUES (?,?,?)').run(id, hostId, state);
    return id;
  }

  test('migration creates eleven bounded stores, permissions and site-admin grants', () => {
    const names = ['lifecycle_maintenance_plans','lifecycle_maintenance_waves','lifecycle_change_campaigns',
      'lifecycle_campaign_targets','lifecycle_live_patch_evidence','lifecycle_reboot_signals','lifecycle_firmware_catalog',
      'lifecycle_driver_compatibility','lifecycle_certificate_ownership','lifecycle_certificate_reminder_policies',
      'lifecycle_certificate_reminders'];
    const placeholders = names.map(() => '?').join(',');
    expect(db.prepare(`SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`).get(...names).count).toBe(11);
    expect(db.prepare("SELECT COUNT(*) count FROM governance_permissions WHERE permission_key IN ('lifecycle_maintenance.manage','lifecycle_certificates.manage')").get().count).toBe(2);
    expect(db.prepare('SELECT COUNT(*) count FROM governance_role_permissions').get().count).toBe(2);
  });

  test('maintenance planner respects wave, owner, availability and evacuation gates without mutations', () => {
    const result = readyPlan({ targets: [target('node-a', { availabilityGroup: 'rack-1' }),
      target('node-b', { availabilityGroup: 'rack-1' }), target('node-c', { owner: 'database', availabilityGroup: 'rack-2' })] });
    expect(result.plan).toMatchObject({ state: 'ready', conflicts: [] });
    expect(result.waves).toHaveLength(2);
    expect(result.waves[0].targets.map(item => item.ref)).toEqual(['node-a', 'node-c']);
    expect(result).toMatchObject({ providerMutationsStarted: 0 });
    const blocked = readyPlan({ name: 'blocked-window', evacuation: { capacityVerified: false },
      targets: [target('node-z', { evacuationRequired: true })] });
    expect(blocked.plan.conflicts[0].code).toBe('EVACUATION_CAPACITY_UNVERIFIED');
  });

  test('maintenance approval requires the immutable plan hash and typed phrase', () => {
    const created = readyPlan();
    expect(() => lifecycle.approveMaintenance(created.plan.id, { planHash: created.plan.planHash, confirmation: 'APPROVE' }, admin)).toThrow(/confirmation/);
    expect(lifecycle.approveMaintenance(created.plan.id, { planHash: created.plan.planHash,
      confirmation: `APPROVE MAINTENANCE ${created.plan.id}` }, admin)).toMatchObject({ state: 'approved', providerMutationsStarted: 0 });
  });

  test('rolling cluster campaigns create ordered gates and never create provider operations', () => {
    const result = campaign();
    expect(result).toMatchObject({ kind: 'rolling_cluster', state: 'ready', currentStage: 0, providerOperationsCreated: 0 });
    expect(result.targets.map(item => item.stage)).toEqual([1, 2]);
    expect(db.prepare('SELECT COUNT(*) count FROM provider_operations').get().count).toBe(0);
  });

  test('campaign advances only from succeeded durable operations and pauses on failed verification', () => {
    const created = campaign();
    const approved = lifecycle.approveCampaign(created.id, { planHash: created.planHash,
      confirmation: `APPROVE CAMPAIGN ${created.id}` }, admin);
    const succeeded = operation();
    const running = lifecycle.advanceCampaign(approved.id, { targetId: approved.targets[0].id,
      operationId: succeeded, verification: { passed: true, health: 'green' } }, admin);
    expect(running).toMatchObject({ state: 'running', currentStage: 2 });
    const failed = operation('failed');
    const paused = lifecycle.advanceCampaign(approved.id, { targetId: approved.targets[1].id,
      operationId: failed, verification: { passed: false } }, admin);
    expect(paused).toMatchObject({ state: 'paused' });
    expect(paused.pauseReason).toContain('failed');
  });

  test('live-patch adapters are explicit and apply requires matching approval plus durable operation', async () => {
    const unsupported = await lifecycle.livePatch({ providerType: 'unknown', providerHostId: 7,
      targetRef: 'node-a', patchId: 'LP-1', phase: 'inventory' }, admin);
    expect(unsupported).toMatchObject({ phase: 'unsupported', implicitRebootScheduled: false });
    lifecycle = new LifecycleMaintenanceService(() => db, { livePatchAdapters: {
      linux: async input => ({ supported: true, verified: input.phase === 'verify', nativeEvidence: 'fixture' }),
    } });
    const operationId = operation('succeeded');
    const payloadHash = _internals.hash({ providerType: 'linux', providerHostId: 7, targetRef: 'node-a', patchId: 'LP-1', operationId });
    db.prepare("INSERT INTO infrastructure_approval_requests (id,action_key,target_id,payload_hash,state) VALUES (1,'live_patch.apply','node-a',?,'approved')").run(payloadHash);
    await expect(lifecycle.livePatch({ providerType: 'linux', providerHostId: 7, targetRef: 'node-a', patchId: 'LP-1',
      phase: 'apply', operationId, approvalId: 99, confirmation: 'APPLY LIVE PATCH LP-1 node-a' }, admin)).rejects.toThrow(/approved/);
    const applied = await lifecycle.livePatch({ providerType: 'linux', providerHostId: 7, targetRef: 'node-a', patchId: 'LP-1',
      phase: 'apply', operationId, approvalId: 1, confirmation: 'APPLY LIVE PATCH LP-1 node-a' }, admin);
    expect(applied).toMatchObject({ phase: 'applied', operationId, implicitRebootScheduled: false });
  });

  test('reboot detector aggregates independent kernel, hypervisor, toolstack and vendor signals', () => {
    lifecycle.recordRebootSignal({ providerHostId: 7, targetRef: 'node-a', signalSource: 'kernel', signalKey: 'pending-kernel',
      requiredState: 'not_required', guidance: 'No reboot', evidence: { probe: 'kernel' } }, admin);
    const result = lifecycle.recordRebootSignal({ providerHostId: 7, targetRef: 'node-a', signalSource: 'vendor', signalKey: 'firmware',
      requiredState: 'required', currentVersion: '1.0', pendingVersion: '1.1', guidance: 'Schedule maintenance', evidence: { advisory: 'ADV-1' } }, admin);
    expect(result).toMatchObject({ requiredState: 'required', rebootScheduled: false });
    expect(result.signals).toHaveLength(2);
  });

  test('firmware catalog accepts only official HTTPS evidence and records compatibility metadata', () => {
    expect(() => lifecycle.saveFirmware({ vendor: 'Acme', deviceModel: 'NIC-1', componentType: 'nic', firmwareVersion: '2.0',
      compatibleHostReleases: ['8.0'], sourceUrl: 'http://vendor.example/fw', publishedAt: new Date().toISOString() }, admin)).toThrow(/HTTPS/);
    const saved = lifecycle.saveFirmware({ vendor: 'Acme', deviceModel: 'NIC-1', componentType: 'nic', firmwareVersion: '2.0',
      compatibleHostReleases: ['8.0'], minimumDriverVersion: '3.0', severity: 'critical', sourceUrl: 'https://vendor.example/fw',
      publishedAt: new Date().toISOString(), metadata: { advisory: 'ADV-2' } }, admin);
    expect(saved).toMatchObject({ minimumDriverVersion: '3.0', severity: 'critical', compatibleHostReleases: ['8.0'] });
  });

  test('driver compatibility returns supported, blocked and unknown decisions without remediation', () => {
    const body = { vendor: 'Acme', deviceModel: 'NIC-1', driverName: 'enic', driverVersion: '3.1',
      firmwareVersion: '2.0', hostRelease: '8.0', status: 'supported', sourceUrl: 'https://vendor.example/matrix' };
    lifecycle.saveDriverCompatibility(body, admin);
    expect(lifecycle.checkDriver(body, admin)).toMatchObject({ status: 'supported', compatible: true, remediationScheduled: false });
    expect(lifecycle.checkDriver({ ...body, driverVersion: '9.9' }, admin)).toMatchObject({ status: 'unknown', compatible: null });
  });

  test('guest-tools and VM hardware campaigns enforce their distinct prechecks', () => {
    const tools = campaign('guest_tools', { targets: [target('vm-a', { precheck: { healthReady: true, compatible: true, guestResponsive: false } })] });
    expect(tools).toMatchObject({ state: 'planned' });
    expect(tools.targets[0].precheck.failures).toContain('guest_tools');
    const hardware = campaign('vm_hardware', { targets: [target('vm-b', { protection: {} })] });
    expect(hardware.targets[0].precheck.failures).toContain('protection');
  });

  test('certificate inventory joins ownership, expiry, service and maintenance dependencies', () => {
    const certId = Number(db.prepare(`INSERT INTO tracked_certificates
      (name,subject,issuer,sans,not_before,not_after,fingerprint_sha256,last_checked_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run('api-cert','CN=api','CN=issuer','api.example.com',new Date().toISOString(),future(20 * 24),'abc123',new Date().toISOString()).lastInsertRowid);
    const plan = readyPlan();
    const item = lifecycle.saveCertificateOwnership({ certificateId: certId, inventoryKey: 'tls/api', endpoint: 'https://api.example.com',
      resourceType: 'service', resourceRef: 'api', owner: 'platform', escalationUserId: 2,
      maintenancePlanId: plan.plan.id, environment: 'production' }, admin);
    expect(item).toMatchObject({ certificateId: certId, resourceType: 'service', owner: 'platform', maintenancePlanId: plan.plan.id });
    expect(item.daysRemaining).toBeGreaterThan(19);
  });

  test('certificate reminder evaluation is idempotent and never starts renewal', () => {
    const certId = Number(db.prepare('INSERT INTO tracked_certificates (name,not_after,fingerprint_sha256) VALUES (?,?,?)')
      .run('expiring', future(5 * 24), 'def456').lastInsertRowid);
    lifecycle.saveCertificateOwnership({ certificateId: certId, inventoryKey: 'tls/expiring', resourceType: 'endpoint',
      resourceRef: 'api-edge', endpoint: 'https://edge.example.com', owner: 'platform', environment: 'production' }, admin);
    lifecycle.saveReminderPolicy({ name: 'production-expiry', thresholdDays: [90, 30, 7], environment: 'production',
      escalationUserId: 2, requireMaintenanceWindow: true }, admin);
    expect(lifecycle.evaluateCertificateReminders(admin)).toMatchObject({ created: 1, renewalsStarted: 0 });
    const second = lifecycle.evaluateCertificateReminders(admin);
    expect(second).toMatchObject({ created: 0, renewalsStarted: 0 });
    expect(second.reminders[0]).toMatchObject({ thresholdDays: 7,
      maintenanceDependency: 'approved maintenance plan required before renewal' });
  });
});
