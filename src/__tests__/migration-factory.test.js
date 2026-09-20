'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const migration124 = require('../db/migrations/124_governance_foundation');
const migration148 = require('../db/migrations/148_migration_factory');
const { MigrationFactoryService } = require('../services/migration-factory');

const admin = { id: 1, username: 'admin', role: 'admin' };
function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY,username TEXT UNIQUE,email TEXT,password_hash TEXT,role TEXT,is_active INTEGER DEFAULT 1,display_name TEXT,auth_source TEXT DEFAULT 'local',must_change_password INTEGER DEFAULT 0,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE tenants (id INTEGER PRIMARY KEY,slug TEXT UNIQUE,name TEXT,kind TEXT DEFAULT 'internal',usage_mode TEXT DEFAULT 'production',status TEXT DEFAULT 'active',is_default INTEGER DEFAULT 0,trial_expires_at TEXT,created_by TEXT,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE user_tenants (user_id INTEGER,tenant_id INTEGER,role TEXT,is_owner INTEGER,created_at TEXT,PRIMARY KEY(user_id,tenant_id));
    CREATE TABLE teams (id INTEGER PRIMARY KEY,name TEXT UNIQUE,description TEXT,created_by INTEGER,created_at TEXT,updated_at TEXT);
    CREATE TABLE team_members (team_id INTEGER,user_id INTEGER,is_leader INTEGER,added_by INTEGER,added_at TEXT,PRIMARY KEY(team_id,user_id));
    INSERT INTO users (id,username,email,password_hash,role) VALUES (1,'admin','admin@test','x','admin');
    INSERT INTO tenants (id,slug,name) VALUES (1,'platform','Platform');
  `); migration124.up(db); migration148.up(db); return db;
}
function assessment(service) {
  return service.assess({ sourceProvider: 'vmware', targetProvider: 'proxmox', sourceInventory: { clusterRef: 'source-a', vms: [
    { resourceKey: 'vm-db', name: 'Database', cpu: 4, memoryBytes: 8589934592, diskBytes: 107374182400, networks: ['prod'], diskFormats: ['vmdk'], devices: [], os: 'linux' },
    { resourceKey: 'vm-web', name: 'Web', cpu: 2, memoryBytes: 4294967296, diskBytes: 53687091200, networks: ['prod'], diskFormats: ['vmdk'], devices: [], os: 'linux' },
  ] }, dependencies: [{ from: 'vm-web', to: 'vm-db', kind: 'application' }], targetCandidates: [
    { targetRef: 'pve-a', capacityScore: 90, compatibilityScore: 95, networkScore: 85, storageScore: 88, blockers: [] },
    { targetRef: 'pve-b', capacityScore: 70, compatibilityScore: 80, networkScore: 60, storageScore: 75, blockers: ['maintenance'] },
  ] }, admin);
}
function pipeline(service, assessmentId) {
  const network = service.mapNetworks(assessmentId, { mappings: [{ sourceNetwork: 'prod', targetNetwork: 'vmbr-prod', sourceVlan: 20, targetVlan: 20, sourceCidr: '10.20.0.0/24', targetCidr: '10.20.0.0/24', securityProfile: 'production', ipMode: 'preserve' }] }, admin);
  const storage = service.mapStorage(assessmentId, { mappings: [{ diskRef: 'disk-db', sizeBytes: 107374182400, targetDatastore: 'ceph-prod', targetPolicy: 'replicated-3', targetTier: 'ssd', availableBytes: 1099511627776, thinProvisioned: true }] }, admin);
  const clone = service.recordTestClone(assessmentId, { networkMappingId: network.id, storageMappingId: storage.id, targetRef: 'pve-a', isolationMode: 'isolated', checks: [{ name: 'boot', state: 'pass', evidenceHash: '1'.repeat(64) }, { name: 'app_health', state: 'pass', evidenceHash: '2'.repeat(64) }] }, admin);
  const wave = service.planWaves(assessmentId, { maxConcurrent: 1, workloads: [{ resourceKey: 'vm-db', application: 'shop', dependencies: [], downtimeMinutes: 15, windowRef: 'mw-1' }, { resourceKey: 'vm-web', application: 'shop', dependencies: ['vm-db'], downtimeMinutes: 5, windowRef: 'mw-1' }] }, admin);
  const cutover = service.planCutover(assessmentId, { wavePlanId: wave.id, testCloneId: clone.id, targetRef: 'pve-a', approvalHash: '3'.repeat(64), confirmation: `CUTOVER ${assessmentId} pve-a` }, admin);
  const rollback = service.planRollback(cutover.id, { triggerReason: 'Post-boot validation failed', sourceNetworkRestorable: true, sourcePowerRestorable: true, targetCleanupSupported: true }, admin);
  return { network, storage, clone, wave, cutover, rollback };
}

describe('v8.74 migration factory (B416-B425)', () => {
  let db; let service; let assessed;
  beforeEach(() => { db = database(); service = new MigrationFactoryService(() => db); assessed = assessment(service); });
  afterEach(() => db.close());

  test('B416 scans inventory/dependencies/blockers and ranks target candidates', () => {
    expect(assessed).toMatchObject({ state: 'ready', blockers: [], providerMutationsStarted: 0 });
    expect(assessed.candidates).toHaveLength(2); expect(assessed.candidates[0]).toMatchObject({ targetRef: 'pve-a', score: 89.5, blockers: [] });
    expect(assessed.dependencies).toEqual([{ from: 'vm-web', to: 'vm-db', kind: 'application' }]);
  });
  test('B417 uses a fixed out-of-process conversion contract with input/output checksums', async () => {
    const conversion = await service.planConversion(assessed.id, { inputFormat: 'vmdk', outputFormat: 'qcow2', inputChecksumSha256: 'a'.repeat(64), expectedOutputChecksumSha256: 'b'.repeat(64), normalizeGuest: false }, admin);
    expect(conversion).toMatchObject({ tool: 'qemu-img', outOfProcess: true, conversionExecuted: false, diskIoStarted: 0, sandboxPolicy: { network: 'none', inputPathsExposed: false } });
  });
  test('B418 maps VLAN/subnet/security/IP and blocks unsafe address preservation', () => {
    expect(service.mapNetworks(assessed.id, { mappings: [{ sourceNetwork: 'prod', targetNetwork: 'vmbr-prod', sourceVlan: 20, targetVlan: 120, sourceCidr: '10.20.0.0/24', targetCidr: '10.120.0.0/24', securityProfile: 'production', ipMode: 'preserve' }] }, admin)).toMatchObject({ state: 'blocked', conflicts: ['prod:preserve_ip_cidr_mismatch'], providerMutationsStarted: 0 });
  });
  test('B419 reserves target policy/tier capacity and blocks an oversized disk', () => {
    expect(service.mapStorage(assessed.id, { mappings: [{ diskRef: 'disk-db', sizeBytes: 2000, targetDatastore: 'ceph-prod', targetPolicy: 'replicated-3', targetTier: 'ssd', availableBytes: 1000, thinProvisioned: true }] }, admin)).toMatchObject({ state: 'blocked', blockers: ['disk-db:insufficient_capacity'], providerMutationsStarted: 0 });
  });
  test('B420 records isolated test-clone boot evidence without source cutover', () => {
    const { clone } = pipeline(service, assessed.id); expect(clone).toMatchObject({ isolationMode: 'isolated', state: 'validated', externalExecutionAttested: true, sourceCutoverStarted: 0, providerMutationsStarted: 0 });
  });
  test('B421 topologically orders dependency-aware waves with downtime/windows', () => {
    const { wave } = pipeline(service, assessed.id); expect(wave).toMatchObject({ state: 'ready', waves: [{ number: 1, workloads: ['vm-db'], estimatedDowntimeMinutes: 15 }, { number: 2, workloads: ['vm-web'], estimatedDowntimeMinutes: 5 }] });
  });
  test('B422 creates an approval/confirmation-bound cutover plan with no executor', () => {
    const { cutover } = pipeline(service, assessed.id); expect(cutover).toMatchObject({ state: 'ready', steps: [{ name: 'final_sync' }, { name: 'source_shutdown' }, { name: 'network_switch' }, { name: 'target_boot' }, { name: 'post_boot_validation' }], executeEndpoint: null, providerMutationsStarted: 0 });
    expect(() => service.planCutover(assessed.id, { wavePlanId: 1, testCloneId: 1, targetRef: 'pve-a', approvalHash: '3'.repeat(64), confirmation: 'CUTOVER WRONG' }, admin)).toThrow(expect.objectContaining({ code: 'CONFIRMATION_REQUIRED' }));
  });
  test('B423 plans reversible source restoration and target cleanup without execution', () => {
    const { rollback } = pipeline(service, assessed.id); expect(rollback).toMatchObject({ state: 'ready', steps: [{ name: 'isolate_target' }, { name: 'restore_source_network' }, { name: 'power_on_source' }, { name: 'validate_source' }, { name: 'cleanup_target' }], executeEndpoint: null, providerMutationsStarted: 0 });
  });
  test('B424 builds a hash-bound report over conversion, cutover, rollback, tests and approvals', async () => {
    const flow = pipeline(service, assessed.id); const conversion = await service.planConversion(assessed.id, { inputFormat: 'vmdk', outputFormat: 'qcow2', inputChecksumSha256: 'a'.repeat(64), expectedOutputChecksumSha256: 'b'.repeat(64), normalizeGuest: false }, admin); const report = service.createEvidenceReport(assessed.id, { conversionJobIds: [conversion.id], cutoverPlanId: flow.cutover.id, rollbackPlanId: flow.rollback.id, timings: { assessmentMs: 100, conversionMs: 1000 }, tests: { boot: 'pass', app: 'pass' }, approvals: { change: 'approved', fourEyes: true } }, admin);
    expect(report).toMatchObject({ rawArtifactsStored: false, references: { assessmentHash: assessed.assessmentHash, conversionRequestHashes: [conversion.requestHash], cutoverPlanHash: flow.cutover.planHash, rollbackPlanHash: flow.rollback.planHash }, reportHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  test('B425 identifies legacy xm/xend blockers and provides XAPI/XCP-ng guided steps', () => {
    const legacy = service.assessLegacyXen({ hostRef: 'xen-legacy-1', toolstack: 'xend', version: '4.2', vms: [{ vmRef: 'legacy-vm', configHash: 'd'.repeat(64), diskFormats: ['vhd'], networkRefs: ['xenbr0'], passthroughDevices: [] }], targetCandidates: ['xcp-ng','xapi'] }, admin);
    expect(legacy).toMatchObject({ state: 'blocked', blockers: ['legacy_xend_or_xm_requires_offline_config_capture'], targetCandidates: ['xcp-ng','xapi'], providerMutationsStarted: 0 }); expect(legacy.guidedSteps).toContain('create_isolated_test_vm');
    const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'migration-factory.js'), 'utf8'); expect(routes).not.toMatch(/router\.(?:post|put)\([^\n]*(?:execute|apply|run-cutover)/i);
  });
});
