'use strict';

jest.mock('../config', () => ({
  app: { env: 'test' },
  security: { encryptionKey: 'snapshot-policy-test-key-32-bytes' },
  features: { providerVmSnapshots: true, providerVmSnapshotAutomation: false },
}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must inject database'); }) }));
jest.mock('../services/provider-sdk/registry', () => ({ resourcesForHost: jest.fn() }));
jest.mock('../services/provider-operations/index', () => ({ get: jest.fn(), list: jest.fn(() => []) }));
jest.mock('../services/provider-operations/vm-snapshots', () => ({
  inventoryForHost: jest.fn(), preflightForHost: jest.fn(), submitForHost: jest.fn(),
}));
jest.mock('../services/audit', () => ({ log: jest.fn() }));

const Database = require('better-sqlite3');
const identitiesMigration = require('../db/migrations/106_provider_resource_identities');
const operationsMigration = require('../db/migrations/107_provider_operations');
const policyMigration = require('../db/migrations/111_provider_vm_snapshot_policies');
const identityStore = require('../services/provider-sdk/identity-store');
const { sha256 } = require('../utils/crypto');
const registry = require('../services/provider-sdk/registry');
const snapshots = require('../services/provider-operations/vm-snapshots');
const operations = require('../services/provider-operations/index');
const policies = require('../services/provider-operations/snapshot-policies');

const host = { id: 7, name: 'esxi-a', daemon_type: 'vsphere', is_active: 1 };
let VM_ID;

function database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    INSERT INTO users (id, username) VALUES (9, 'admin');
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT, daemon_type TEXT, is_active INTEGER);
    INSERT INTO docker_hosts (id, name, daemon_type, is_active) VALUES (7, 'esxi-a', 'vsphere', 1);`);
  identitiesMigration.up(db);
  operationsMigration.up(db);
  policyMigration.up(db);
  VM_ID = identityStore.remember({
    hostId: 7, providerType: 'vsphere', kind: 'virtualMachine', uuid: 'vm-uuid-7',
    nativeRef: 'vm-7', stability: 'stable',
  }, db).id;
  return db;
}

function vm() {
  return {
    id: VM_ID, displayName: 'web-01', identity: { stability: 'stable' },
    status: { powerState: 'running' }, actions: ['snapshot', 'snapshotQuiesced'],
  };
}

function inventory(items = []) {
  return {
    vm: { id: VM_ID, displayName: 'web-01', powerState: 'running' },
    count: items.length, maxCount: 32, observedDepth: 0, maxDepth: 16, items,
  };
}

function snap(idChar, name, createdAt, overrides = {}) {
  return {
    id: `dds_snap_${idChar.repeat(26)}`, name, createdAt, parentId: null, childCount: 0,
    isCurrent: false, integrity: { state: 'valid' }, ...overrides,
  };
}

function rememberOperation(db, id, action, idempotencyKey = null) {
  db.prepare(`INSERT INTO provider_operations
    (id, operation_type, provider_type, host_id, resource_kind, resource_id,
     action, request_hash, request_enc, idempotency_key_hash)
    VALUES (?, 'vm.snapshot', 'vsphere', 7, 'virtualMachine', ?, ?, ?, ?, ?)`)
    .run(id, VM_ID, action, id, 'encrypted-test-request',
      idempotencyKey ? sha256(`7|vm.snapshot|${idempotencyKey}`) : null);
}

describe('persistent common VM snapshot policies', () => {
  let db;
  beforeEach(() => {
    jest.clearAllMocks(); db = database();
    registry.resourcesForHost.mockResolvedValue({ items: [vm()] });
    snapshots.inventoryForHost.mockResolvedValue(inventory([]));
    snapshots.preflightForHost.mockResolvedValue({ allowed: true, planHash: 'a'.repeat(64) });
  });
  afterEach(() => db.close());

  it('creates conservative dry-run defaults and validates typed execute enablement', async () => {
    const result = await policies.upsertForHost(host, VM_ID, {}, { database: db, createdBy: 9 });
    expect(result.created).toBe(true);
    expect(result.policy).toEqual(expect.objectContaining({
      enabled: false, mode: 'dry_run', consistency: 'crash', retainCount: 3,
      maxAgeDays: 3, maxDeletesPerRun: 2, namePrefix: 'dd-auto',
    }));
    expect(result.policy.schedule).toEqual(expect.objectContaining({
      frequency: 'daily', minute: 15, hour: 2, timezone: 'UTC', cron: '15 2 * * *',
    }));

    await expect(policies.upsertForHost(host, VM_ID, {
      enabled: true, mode: 'execute', confirm: true, confirmName: 'web-01',
    }, { database: db, createdBy: 9 })).rejects.toMatchObject({ code: 'SNAPSHOT_AUTOMATION_DISABLED' });
    await expect(policies.upsertForHost(host, VM_ID, {
      enabled: true, mode: 'execute', confirm: true, confirmName: 'wrong',
    }, { database: db, createdBy: 9, automationEnabled: true }))
      .rejects.toMatchObject({ code: 'VM_SNAPSHOT_POLICY_TYPED_CONFIRMATION_REQUIRED' });
  });

  it('selects only old managed leaf snapshots beyond retain count', () => {
    const policy = {
      id: `vmsp_${'a'.repeat(26)}`, namePrefix: 'dd-auto', consistency: 'crash',
      retainCount: 2, maxAgeDays: 3, maxDeletesPerRun: 2,
    };
    const plan = policies.evaluate(policy, inventory([
      snap('1', 'dd-auto-20260710-0000', '2026-07-10T00:00:00Z'),
      snap('2', 'dd-auto-20260720-0000', '2026-07-20T00:00:00Z', { childCount: 1 }),
      snap('3', 'dd-auto-20260724-0000', '2026-07-24T00:00:00Z'),
      snap('4', 'dd-auto-20260725-0000', '2026-07-25T00:00:00Z'),
      snap('5', 'manual-checkpoint', '2026-06-01T00:00:00Z'),
      snap('6', 'dd-auto-missing-time', null),
    ]), new Date('2026-07-26T12:00:00Z'));
    expect(plan.retention.candidates.map(item => item.name)).toEqual(['dd-auto-20260710-0000']);
    expect(plan.retention.managedCount).toBe(5);
    expect(plan.retention.protectedReasons).toEqual(expect.objectContaining({
      retain_count: 2, has_children: 1, missing_timestamp: 1,
    }));
    expect(plan.protection.isBackup).toBe(false);
  });

  it('records scheduled dry-runs once per UTC slot without provider mutation', async () => {
    await policies.upsertForHost(host, VM_ID, {
      enabled: true, mode: 'dry_run', frequency: 'hourly', minute: 15,
    }, { database: db, createdBy: 9 });
    const now = new Date('2026-07-26T12:15:00Z');
    const first = await policies.runDue({ database: db, now });
    const second = await policies.runDue({ database: db, now });
    expect(first.started).toHaveLength(1);
    expect(first.started[0].state).toBe('previewed');
    expect(second.started).toHaveLength(0);
    expect(snapshots.submitForHost).not.toHaveBeenCalled();
    expect(policies.listRuns(7, VM_ID, { database: db })).toHaveLength(1);
  });

  it('soft-deletes a policy while preserving run evidence and permits safe recreation', async () => {
    await policies.upsertForHost(host, VM_ID, { enabled: false }, { database: db, createdBy: 9 });
    await policies.runForHost(host, VM_ID, { database: db, allowDisabled: true, dryRun: true });
    const removed = policies.removeForVm(7, VM_ID, { database: db });
    expect(removed.id).toMatch(/^vmsp_/);
    expect(policies.getForVm(7, VM_ID, { database: db })).toBeNull();
    expect(policies.listRuns(7, VM_ID, { database: db })).toHaveLength(1);

    const recreated = await policies.upsertForHost(host, VM_ID, {}, { database: db, createdBy: 9 });
    expect(recreated.created).toBe(true);
    expect(recreated.policy.id).toBe(removed.id);
    expect(policies.listRuns(7, VM_ID, { database: db })).toHaveLength(1);
  });

  it('persists create then submits one retention delete after child success', async () => {
    const saved = await policies.upsertForHost(host, VM_ID, {
      enabled: true, mode: 'execute', frequency: 'daily', minute: 15, hour: 2,
      retainCount: 1, maxAgeDays: 3, maxDeletesPerRun: 2,
      confirm: true, confirmName: 'web-01',
    }, { database: db, createdBy: 9, automationEnabled: true });
    const old = snap('1', 'dd-auto-20260701-0000', '2026-07-01T00:00:00Z');
    snapshots.inventoryForHost.mockResolvedValueOnce(inventory([old]));
    const createOperationId = `op_${'c'.repeat(26)}`;
    rememberOperation(db, createOperationId, 'create');
    snapshots.submitForHost.mockResolvedValueOnce({ operation: { id: createOperationId } });
    const run = await policies.runForHost(host, VM_ID, {
      database: db, automationEnabled: true, confirm: true, confirmName: 'web-01', createdBy: 9,
    });
    expect(run.state).toBe('create_pending');
    expect(run.currentOperationId).toBe(`op_${'c'.repeat(26)}`);
    expect(snapshots.submitForHost).toHaveBeenLastCalledWith(host, VM_ID, 'create', expect.objectContaining({
      name: expect.stringMatching(/^dd-auto-\d{12}$/), confirm: true,
      idempotencyKey: expect.stringContaining(`snapshot-policy:${saved.policy.id}:`),
    }), null, expect.objectContaining({ canOperate: true, enabled: true }));

    operations.get.mockReturnValueOnce({ id: run.currentOperationId, state: 'succeeded' });
    snapshots.inventoryForHost.mockResolvedValueOnce(inventory([
      old, snap('2', 'dd-auto-20260726-1200', '2026-07-26T12:00:00Z'),
    ]));
    const deleteOperationId = `op_${'d'.repeat(26)}`;
    rememberOperation(db, deleteOperationId, 'delete');
    snapshots.submitForHost.mockResolvedValueOnce({ operation: { id: deleteOperationId } });
    const retaining = await policies.reconcileRun(run.id, { database: db, automationEnabled: true });
    expect(retaining).toEqual(expect.objectContaining({ state: 'retention_pending', currentOperationId: `op_${'d'.repeat(26)}` }));
    expect(snapshots.submitForHost).toHaveBeenLastCalledWith(host, VM_ID, 'delete', expect.objectContaining({
      confirmName: old.name, confirm: true,
    }), old.id, expect.objectContaining({ canOperate: true, enabled: true }));

    operations.get.mockReturnValueOnce({ id: retaining.currentOperationId, state: 'succeeded' });
    snapshots.inventoryForHost.mockResolvedValueOnce(inventory([
      snap('2', 'dd-auto-20260726-1200', '2026-07-26T12:00:00Z'),
    ]));
    const complete = await policies.reconcileRun(run.id, { database: db, automationEnabled: true });
    expect(complete).toEqual(expect.objectContaining({ state: 'succeeded', deleteCount: 1 }));
  });

  it('propagates unknown child state and refuses policy deletion while active', async () => {
    await policies.upsertForHost(host, VM_ID, {
      enabled: true, mode: 'execute', confirm: true, confirmName: 'web-01',
    }, { database: db, createdBy: 9, automationEnabled: true });
    const createOperationId = `op_${'e'.repeat(26)}`;
    rememberOperation(db, createOperationId, 'create');
    snapshots.submitForHost.mockResolvedValue({ operation: { id: createOperationId } });
    const run = await policies.runForHost(host, VM_ID, {
      database: db, automationEnabled: true, confirm: true, confirmName: 'web-01',
    });
    expect(() => policies.removeForVm(7, VM_ID, { database: db }))
      .toThrow(expect.objectContaining({ code: 'SNAPSHOT_POLICY_RUN_ACTIVE' }));
    operations.get.mockReturnValue({ id: run.currentOperationId, state: 'unknown' });
    await expect(policies.reconcileRun(run.id, { database: db, automationEnabled: true }))
      .resolves.toEqual(expect.objectContaining({ state: 'unknown' }));
  });

  it('recovers a durable child binding after a crash window without resubmitting create', async () => {
    await policies.upsertForHost(host, VM_ID, {
      enabled: true, mode: 'execute', confirm: true, confirmName: 'web-01',
    }, { database: db, createdBy: 9, automationEnabled: true });
    const operationId = `op_${'f'.repeat(26)}`;
    snapshots.submitForHost.mockImplementationOnce(async (_host, _vmId, action, body) => {
      rememberOperation(db, operationId, action, body.idempotencyKey);
      return { operation: { id: operationId } };
    });
    const run = await policies.runForHost(host, VM_ID, {
      database: db, automationEnabled: true, confirm: true, confirmName: 'web-01',
    });
    db.prepare('UPDATE provider_vm_snapshot_policy_runs SET current_operation_id = NULL WHERE id = ?').run(run.id);
    operations.get.mockReturnValue({ id: operationId, state: 'succeeded' });
    snapshots.inventoryForHost.mockResolvedValue(inventory([]));

    const recovered = await policies.reconcileRun(run.id, { database: db, automationEnabled: true });
    expect(recovered.state).toBe('succeeded');
    expect(snapshots.submitForHost).toHaveBeenCalledTimes(1);
  });
});
