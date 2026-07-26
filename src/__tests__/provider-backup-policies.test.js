'use strict';

jest.mock('../config', () => ({
  app: { env: 'test' }, security: { encryptionKey: 'backup-policy-test-key-32-characters' },
  features: { providerBackupPolicies: true, providerRecoveryPointInventory: true },
}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must inject database'); }) }));
jest.mock('../services/provider-sdk/registry', () => ({
  recoveryPointsForHost: jest.fn(), resourcesForHost: jest.fn(),
}));
jest.mock('../services/audit', () => ({ log: jest.fn() }));

const Database = require('better-sqlite3');
const identityMigration = require('../db/migrations/106_provider_resource_identities');
const recoveryMigration = require('../db/migrations/117_provider_recovery_points');
const policyMigration = require('../db/migrations/118_provider_backup_policies');
const identityStore = require('../services/provider-sdk/identity-store');
const recoveryCatalog = require('../services/provider-sdk/recovery-point-catalog');
const registry = require('../services/provider-sdk/registry');
const policies = require('../services/provider-operations/backup-policies');

const host = { id: 7, name: 'xo-a', daemon_type: 'xen', is_active: 1 };
let VM_A; let VM_B; let REPOSITORY;

function setup() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    INSERT INTO users (id, username) VALUES (9, 'admin');
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT, daemon_type TEXT, is_active INTEGER);
    INSERT INTO docker_hosts VALUES (7, 'xo-a', 'xen', 1);
    INSERT INTO docker_hosts VALUES (8, 'xo-b', 'xen', 1);`);
  identityMigration.up(database); recoveryMigration.up(database); policyMigration.up(database);
  VM_A = identityStore.remember({ hostId: 7, providerType: 'xen', kind: 'virtualMachine',
    uuid: 'vm-a-uuid', nativeRef: 'OpaqueRef:vm-a', stability: 'stable' }, database).id;
  VM_B = identityStore.remember({ hostId: 7, providerType: 'xen', kind: 'virtualMachine',
    uuid: 'vm-b-uuid', nativeRef: 'OpaqueRef:vm-b', stability: 'stable' }, database).id;
  REPOSITORY = recoveryCatalog.normalizeRepositoryAndRemember({ host, providerType: 'xen', database,
    observedAt: '2026-07-26T10:00:00Z', raw: { nativeRef: 'remote-a', name: 'Off-site A', type: 'xo',
      enabled: true, accessible: true, supportsVerification: true,
      supportsClientSideEncryption: true, supportsImmutableRetention: true } }).repository;
  return database;
}

function vm(id, name, labels = {}, stability = 'stable') {
  return { id, displayName: name, labels, status: { powerState: 'running' }, identity: { stability } };
}

function recovery(overrides = {}) {
  return { schemaVersion: '1.0', repositories: [REPOSITORY], items: [], truncated: false, ...overrides };
}

function resources(overrides = {}) {
  return { items: [vm(VM_A, 'web-01', { environment: 'prod', owner: 'payments' }),
    vm(VM_B, 'dev-01', { environment: 'dev' })], truncated: false, ...overrides };
}

function draft(overrides = {}) {
  return { name: 'Production GFS', repositoryId: REPOSITORY.id, enabled: false, mode: 'plan_only',
    schedule: { frequency: 'daily', minute: 15, hour: 2, weekday: 0, dayOfMonth: 1, timezone: 'Europe/Bucharest' },
    scope: { includeAll: false, workloadIds: [], selectors: { match: 'all', labels: { environment: 'prod' }, powerStates: [] },
      exclusions: { workloadIds: [], labels: {}, diskSelectors: [] } },
    retention: { keepLast: 2, hourly: 0, daily: 7, weekly: 4, monthly: 12, yearly: 3, weekStartsOn: 1 },
    protection: { encryption: { mode: 'required', keyReference: 'vault/backup/xo-a' },
      immutability: { mode: 'required', minimumLockDays: 30 } },
    ...overrides };
}

function point(char, createdAt, overrides = {}) {
  return { id: `ddr_rp_${char.repeat(26)}`, createdAt, repository: { id: REPOSITORY.id },
    workload: { id: VM_A }, backup: {}, retention: {}, ...overrides };
}

describe('provider backup policies', () => {
  let database;
  beforeEach(() => {
    jest.clearAllMocks(); database = setup();
    registry.recoveryPointsForHost.mockResolvedValue(recovery());
    registry.resourcesForHost.mockResolvedValue(resources());
  });
  afterEach(() => database.close());

  it('validates bounded portable policy metadata and rejects key material or execution mode', () => {
    const value = policies.validatePolicy(draft());
    expect(value).toEqual(expect.objectContaining({ mode: 'plan_only', repositoryId: REPOSITORY.id }));
    expect(value.retention.strategy).toBe('portable_newest');
    expect(() => policies.validatePolicy(draft({ mode: 'execute' })))
      .toThrow(expect.objectContaining({ code: 'BACKUP_EXECUTION_DISABLED' }));
    expect(() => policies.validatePolicy(draft({ protection: {
      encryption: { mode: 'required', keyReference: '-----BEGIN PRIVATE KEY-----' },
      immutability: { mode: 'none' },
    } }))).toThrow(/never key material/);
    expect(() => policies.validatePolicy(draft({ scope: { includeAll: false, workloadIds: [],
      selectors: { labels: {}, powerStates: [] }, exclusions: {} } }))).toThrow(/explicitly select/);
  });

  it('selects stable workloads using smart labels and applies exclusions last', () => {
    const transientId = `ddr_vm_${'f'.repeat(26)}`;
    const scope = policies.validatePolicy(draft()).scope;
    scope.exclusions.workloadIds = [VM_B];
    const result = policies.selectWorkloads([
      ...resources().items, vm(transientId, 'prod-temp', { environment: 'prod' }, 'transient'),
    ], scope);
    expect(result.selected.map(item => item.id)).toEqual([VM_A]);
    expect(result.selected[0]).not.toHaveProperty('labels');
    expect(result.transient).toEqual([transientId]);
  });

  it('fails required tri-state protection evidence closed and marks truncated previews', async () => {
    const unknownRepository = { ...REPOSITORY, capabilities: {}, provider: { type: 'xen', endpointId: 7 } };
    const plan = await policies.preflightForHost(host, draft(), { database,
      recoveryInventory: recovery({ repositories: [unknownRepository], truncated: true }),
      resourceInventory: resources({ truncated: true }), now: new Date('2026-07-26T10:00:00Z') });
    expect(plan.allowed).toBe(false);
    expect(plan.findings.map(item => item.code)).toEqual(expect.arrayContaining([
      'ENCRYPTION_CAPABILITY_UNPROVEN', 'IMMUTABILITY_CAPABILITY_UNPROVEN',
      'RECOVERY_POINT_INVENTORY_TRUNCATED', 'WORKLOAD_INVENTORY_TRUNCATED',
    ]));
    expect(plan.scope.workloads).toEqual([expect.objectContaining({ id: VM_A })]);
    expect(JSON.stringify(plan)).not.toContain('OpaqueRef');
    expect(plan.execution.authorized).toBe(false);
  });

  it('computes deterministic portable GFS protection without authorizing pruning', () => {
    const result = policies.evaluateGfs([
      point('a', '2026-07-26T08:00:00Z'), point('b', '2026-07-25T08:00:00Z'),
      point('c', '2026-07-18T08:00:00Z'), point('d', '2026-06-10T08:00:00Z', {
        retention: { immutableUntil: '2026-08-10T00:00:00Z' },
      }), point('e', '2025-01-01T08:00:00Z'),
    ], { keepLast: 1, hourly: 0, daily: 2, weekly: 1, monthly: 1, yearly: 1, weekStartsOn: 1 },
    'UTC', new Date('2026-07-26T10:00:00Z'));
    expect(result.mutationAuthorized).toBe(false);
    expect(result.protected.find(item => item.id.endsWith('d'.repeat(26))).reasons).toContain('immutable_lock');
    expect(result.protected.find(item => item.id.endsWith('a'.repeat(26))).reasons).toEqual(expect.arrayContaining(['keep_last', 'gfs_daily']));
    expect(result.observedCount).toBe(5);
  });

  it('keeps plan hashes stable across volatile inventory observation timestamps', async () => {
    const firstRepository = { ...REPOSITORY, observedAt: '2026-07-26T10:00:00Z' };
    const secondRepository = { ...REPOSITORY, observedAt: '2026-07-26T10:00:05Z' };
    const first = await policies.preflightForHost(host, draft(), { database,
      recoveryInventory: recovery({ repositories: [firstRepository] }), resourceInventory: resources() });
    const second = await policies.preflightForHost(host, draft(), { database,
      recoveryInventory: recovery({ repositories: [secondRepository] }), resourceInventory: resources() });
    expect(second.planHash).toBe(first.planHash);
    expect(second.repository.observedAt).not.toBe(first.repository.observedAt);
  });

  it('persists versioned policies and due plans once per timezone-aware slot', async () => {
    const saved = await policies.upsertForHost(host, draft({ enabled: true }), { database, createdBy: 9 });
    expect(saved.created).toBe(true); expect(saved.preflight.allowed).toBe(true);
    expect(saved.policy.policyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(registry.recoveryPointsForHost).toHaveBeenCalledWith(host,
      expect.objectContaining({ repositoryId: REPOSITORY.id, limit: 500, database }));

    const now = new Date('2026-07-26T23:15:00Z'); // 02:15 Monday in Europe/Bucharest
    const first = await policies.runDue({ database, now });
    const duplicate = await policies.runDue({ database, now });
    expect(first.started).toHaveLength(1); expect(first.started[0].state).toBe('planned');
    expect(first.started[0].plan.execution.authorized).toBe(false);
    expect(duplicate.started).toHaveLength(0);
    expect(policies.listRuns(7, { database })).toHaveLength(1);
  });

  it('records a blocked due-slot plan when live provider evidence is unavailable', async () => {
    const saved = await policies.upsertForHost(host, draft({ enabled: true }), { database, createdBy: 9 });
    registry.recoveryPointsForHost.mockRejectedValueOnce(Object.assign(new Error('secret endpoint detail'), {
      code: 'PROVIDER_UNREACHABLE', status: 502,
    }));
    const result = await policies.runDue({ database, now: new Date('2026-07-26T23:15:00Z') });
    expect(result.started).toHaveLength(1);
    expect(result.started[0]).toEqual(expect.objectContaining({ policyId: saved.policy.id, state: 'blocked' }));
    expect(result.started[0].findings[0]).toEqual(expect.objectContaining({ code: 'PROVIDER_UNREACHABLE' }));
    expect(JSON.stringify(result.started[0])).not.toContain('secret endpoint detail');
  });

  it('wraps only trusted provider evidence errors and never echoes upstream details', async () => {
    registry.recoveryPointsForHost.mockRejectedValueOnce(Object.assign(new Error('https://token@pbs.internal'), {
      name: 'ProviderAdapterError', code: 'PROVIDER_UNREACHABLE', status: 502,
    }));
    await expect(policies.preflightForHost(host, draft(), { database })).rejects.toMatchObject({
      name: 'BackupPolicyError', code: 'PROVIDER_UNREACHABLE', status: 502,
      message: 'Live provider backup evidence is unavailable',
    });
  });

  it('allows a blocked policy only while disabled and preserves run evidence after soft delete', async () => {
    const unknownRepository = { ...REPOSITORY, capabilities: {}, provider: { type: 'xen', endpointId: 7 } };
    registry.recoveryPointsForHost.mockResolvedValue(recovery({ repositories: [unknownRepository] }));
    const saved = await policies.upsertForHost(host, draft({ enabled: false }), { database, createdBy: 9 });
    expect(saved.preflight.allowed).toBe(false);
    await expect(policies.upsertForHost(host, { ...draft({ enabled: true }), id: saved.policy.id }, { database, createdBy: 9 }))
      .rejects.toMatchObject({ code: 'BACKUP_POLICY_PREFLIGHT_BLOCKED' });

    registry.recoveryPointsForHost.mockResolvedValue(recovery());
    await policies.planForHost(host, saved.policy.id, { database, createdBy: 9 });
    expect(policies.removeForHost(7, saved.policy.id, { database }).id).toBe(saved.policy.id);
    expect(policies.get(saved.policy.id, { database })).toBeNull();
    expect(policies.listRuns(7, { database })).toHaveLength(1);
  });
});
