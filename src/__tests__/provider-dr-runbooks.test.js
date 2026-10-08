'use strict';

process.env.ENCRYPTION_KEY = 'provider-dr-test-key-32-characters';

jest.mock('../config', () => ({
  app: { env: 'test' }, security: { encryptionKey: 'provider-dr-test-key-32-characters' },
  features: { providerDrRunbooks: true },
}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('inject database'); }) }));
jest.mock('../services/provider-sdk/registry', () => ({}));
jest.mock('../services/provider-operations/policy', () => ({ evaluate: jest.fn(() => ({ allowed: true })) }));
jest.mock('../utils/logger', () => () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));

const Database = require('better-sqlite3');
const { encrypt } = require('../utils/crypto');
const migration = require('../db/migrations/121_provider_dr_runbooks');
const service = require('../services/provider-operations/dr-runbooks');

describe('provider DR protection groups and rehearsals', () => {
  let db; let host; let registry; let proxmoxClient; let vmA; let vmB; let nodeId; let storageId;
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY,name TEXT,daemon_type TEXT,is_active INTEGER,daemon_config TEXT);
      CREATE TABLE provider_resource_identities (
        canonical_id TEXT PRIMARY KEY, host_id INTEGER, resource_kind TEXT, native_ref_enc TEXT);
      CREATE TABLE provider_resource_snapshots (
        canonical_id TEXT PRIMARY KEY, display_name TEXT, observed_at TEXT);
      CREATE TABLE provider_backup_policies (id TEXT PRIMARY KEY,host_id INTEGER,deleted_at TEXT);
      CREATE TABLE provider_restore_drill_policies (id TEXT PRIMARY KEY,host_id INTEGER,deleted_at TEXT);
      CREATE TABLE provider_recovery_points (
        canonical_id TEXT PRIMARY KEY,host_id INTEGER,workload_id TEXT,recovery_point_json TEXT,
        created_at TEXT,observed_at TEXT);
      CREATE TABLE provider_restore_drill_runs (
        id TEXT PRIMARY KEY,host_id INTEGER,recovery_point_id TEXT,state TEXT,rto_seconds INTEGER,
        completed_at TEXT,created_at TEXT);
      INSERT INTO users VALUES (9);
      INSERT INTO docker_hosts VALUES (7,'pve-primary','proxmox',1,'{}');`);
    migration.up(db);
    host = db.prepare('SELECT * FROM docker_hosts WHERE id=7').get();
    vmA = `ddr_vm_${'a'.repeat(26)}`; vmB = `ddr_vm_${'b'.repeat(26)}`;
    nodeId = `ddr_host_${'c'.repeat(26)}`; storageId = `ddr_storage_${'d'.repeat(26)}`;
    const identities = [
      [vmA, 'virtualMachine', '101', 'database'], [vmB, 'virtualMachine', '102', 'api'],
      [nodeId, 'host', 'pve-b', 'pve-b'], [storageId, 'storage', 'local-zfs', 'local-zfs'],
    ];
    for (const [id, kind, nativeRef, name] of identities) {
      db.prepare('INSERT INTO provider_resource_identities VALUES (?,?,?,?)')
        .run(id, 7, kind, encrypt(nativeRef));
      db.prepare('INSERT INTO provider_resource_snapshots VALUES (?,?,?)')
        .run(id, name, new Date().toISOString());
    }
    const createdAt = new Date(Date.now() - 300000).toISOString();
    for (const [index, vm] of [vmA, vmB].entries()) {
      const pointId = `ddr_rp_${String(index + 1).repeat(26)}`;
      db.prepare('INSERT INTO provider_recovery_points VALUES (?,?,?,?,?,?)').run(
        pointId, 7, vm, JSON.stringify({ createdAt, verification: { state: 'verified', method: 'provider' } }),
        createdAt, new Date().toISOString());
      db.prepare('INSERT INTO provider_restore_drill_runs VALUES (?,?,?,?,?,?,?)').run(
        `pdrr_${String(index + 3).repeat(26)}`, 7, pointId, 'succeeded', 120 + index,
        new Date().toISOString(), new Date().toISOString());
    }
    registry = { capabilitiesForHost: jest.fn(async () => ({
      provider: { type: 'proxmox', endpointId: 7 }, probe: { status: 'reachable' }, features: {
        'replication.read': { state: 'conditional', source: 'adapter', constraints: { scope: 'intra_cluster' } },
        'dr.failover': { state: 'unsupported', source: 'adapter', reason: 'No recovery-plan transport', constraints: {} },
        'dr.failback': { state: 'unsupported', source: 'adapter', reason: 'No reprotect transport', constraints: {} },
        'dr.test': { state: 'unsupported', source: 'adapter', reason: 'No bubble-network transport', constraints: {} },
      },
    })) };
    proxmoxClient = { listStorageReplicationJobs: jest.fn(async () => []), _agent: { destroy: jest.fn() } };
  });
  afterEach(() => { jest.restoreAllMocks(); db.close(); });

  function body(overrides = {}) {
    const name = 'Payments DR';
    return { name, enabled: true, authorization: `AUTHORIZE DR ${name}`,
      recoveryHostId: 7, strategy: 'backup_restore', rpoTargetSeconds: 3600,
      rtoTargetSeconds: 900, placement: { nodeId, storageId }, networkMappings: [],
      members: [
        { vmId: vmA, bootStage: 1, dependsOn: [], recoverySource: 'backup' },
        { vmId: vmB, bootStage: 2, dependsOn: [vmA], recoverySource: 'backup' },
      ], ...overrides };
  }

  it('persists a canonical DAG and compiles deterministic plan-only runbooks', async () => {
    const saved = service.upsertGroup(host, body(), { database: db, createdBy: 9 });
    expect(saved.group.members.map(item => item.vmName)).toEqual(['database', 'api']);
    const baseTime = Date.now(); const clock = jest.spyOn(Date, 'now').mockReturnValue(baseTime);
    const first = await service.preflightForHost(host, saved.group.id, { mode: 'planned_failover' },
      { database: db, registry, proxmoxClient, enabled: true, canOperate: true });
    clock.mockReturnValue(baseTime + 9000);
    const second = await service.preflightForHost(host, saved.group.id, { mode: 'planned_failover' },
      { database: db, registry, proxmoxClient, enabled: true, canOperate: true });
    expect(first.planHash).toBe(second.planHash);
    expect(first.allowed).toBe(false);
    expect(first.blockers.map(item => item.code)).toContain('DR_PROVIDER_MUTATION_UNAVAILABLE');
    expect(first.steps.find(step => step.id.startsWith('promote_') && step.id.endsWith('b'.repeat(26))).needs)
      .toContain(`promote_${'a'.repeat(26)}`);
  });

  it('ignores a newer unverified recovery point when compiling compliance evidence', async () => {
    const unverifiedId = `ddr_rp_${'9'.repeat(26)}`;
    const createdAt = new Date(Date.now() - 1000).toISOString();
    db.prepare('INSERT INTO provider_recovery_points VALUES (?,?,?,?,?,?)').run(
      unverifiedId, 7, vmA,
      JSON.stringify({ createdAt, verification: { state: 'unverified', method: 'provider' } }),
      createdAt, createdAt);
    const saved = service.upsertGroup(host, body(), { database: db, createdBy: 9 });
    const plan = await service.preflightForHost(host, saved.group.id, { mode: 'test' },
      { database: db, registry, proxmoxClient, enabled: true, canOperate: true, executionType: 'rehearsal' });
    expect(plan.evidence.members.find(member => member.vmId === vmA).recoveryPoint.id)
      .toBe(`ddr_rp_${'1'.repeat(26)}`);
  });

  it('records a non-mutating rehearsal with measured compliance evidence', async () => {
    const saved = service.upsertGroup(host, body(), { database: db, createdBy: 9 });
    const plan = await service.preflightForHost(host, saved.group.id, { mode: 'test' },
      { database: db, registry, proxmoxClient, enabled: true, canOperate: true, executionType: 'rehearsal' });
    expect(plan.allowed).toBe(true);
    const result = await service.rehearseForHost(host, saved.group.id, {
      mode: 'test', planHash: plan.planHash, confirm: true, confirmationText: 'REHEARSE Payments DR',
    }, { database: db, registry, proxmoxClient, enabled: true, canOperate: true, createdBy: 9 });
    expect(result.run).toEqual(expect.objectContaining({ state: 'succeeded', compliance: 'met',
      rpoMaxSeconds: expect.any(Number), rtoMaxSeconds: 121, evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(proxmoxClient.listStorageReplicationJobs).toHaveBeenCalled();
    expect(result.run.evidence.steps.some(step => step.mutation && step.verdict === 'not_executed')).toBe(true);
  });

  it('publishes workload RPO/RTO compliance and isolated-test readiness aggregates', async () => {
    service.upsertGroup(host, body(), { database: db, createdBy: 9 });
    const result = await service.overviewForHost(host,
      { database: db, registry, proxmoxClient, enabled: true });
    expect(result.objectives).toEqual({
      rpo: { met: 2, breached: 0, unknown: 0 },
      rto: { met: 2, breached: 0, unknown: 0 },
    });
    expect(result.testReadiness).toEqual({ ready: 1, blocked: 0 });
    expect(result.items[0].testReadiness).toEqual(expect.objectContaining({
      state: 'ready', temporaryCloneCount: 2, sourceIsolationRequired: true,
      ownershipMarkedCleanupRequired: true, executorReleased: false,
    }));
  });

  it('rejects cycles and stale rehearsal hashes without persisting a run', async () => {
    expect(() => service.upsertGroup(host, body({ members: [
      { vmId: vmA, bootStage: 1, dependsOn: [vmB], recoverySource: 'backup' },
      { vmId: vmB, bootStage: 1, dependsOn: [vmA], recoverySource: 'backup' },
    ] }), { database: db, createdBy: 9 })).toThrow(expect.objectContaining({ code: 'INVALID_DR_DEPENDENCY_GRAPH' }));
    const saved = service.upsertGroup(host, body(), { database: db, createdBy: 9 });
    await expect(service.rehearseForHost(host, saved.group.id, {
      mode: 'test', planHash: 'f'.repeat(64), confirm: true, confirmationText: 'REHEARSE Payments DR',
    }, { database: db, registry, proxmoxClient, enabled: true, canOperate: true, createdBy: 9 }))
      .rejects.toMatchObject({ code: 'DR_PLAN_STALE' });
    expect(service.listRuns(7, { database: db })).toHaveLength(0);
  });
});
