'use strict';

jest.mock('../config', () => ({
  app: { env: 'test' }, security: { encryptionKey: 'provider-placement-change-test-key' },
  features: {
    providerHaPolicyMutation: true, providerAffinityMutation: true,
    providerRebalanceApply: true, providerVmMigration: true,
  },
  providerPlacementChanges: { concurrency: 2, maxMoves: 20, approvalTtlMs: 15 * 60_000 },
}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('inject test database'); }) }));
jest.mock('../services/provider-sdk/registry', () => ({}));
jest.mock('../services/provider-sdk/placement-advisory', () => ({}));
jest.mock('../services/provider-operations/vm-migration', () => ({}));
jest.mock('../services/provider-operations/policy', () => ({ evaluate: jest.fn(() => ({ allowed: true })) }));
jest.mock('../services/provider-operations/placement-change-provider', () => ({}));

const Database = require('better-sqlite3');
const operationMigration = require('../db/migrations/107_provider_operations');
const changeMigration = require('../db/migrations/116_provider_placement_changes');
const changes = require('../services/provider-operations/placement-changes');

const VM = `ddr_vm_${'a'.repeat(26)}`;
const SOURCE = `ddr_host_${'b'.repeat(26)}`;
const TARGET = `ddr_host_${'c'.repeat(26)}`;
const host = { id: 7, name: 'pve-cluster', daemon_type: 'proxmox', is_active: 1 };

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT, daemon_type TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
    INSERT INTO users (id, username) VALUES (1, 'requester'), (2, 'approver');
    INSERT INTO docker_hosts (id, name, daemon_type, is_active) VALUES (7, 'pve-cluster', 'proxmox', 1);
  `);
  operationMigration.up(db); changeMigration.up(db);
  return db;
}

function insertOperation(db, id, type = 'placement.change', resourceId = VM) {
  db.prepare(`INSERT INTO provider_operations
    (id, operation_type, provider_type, host_id, resource_kind, resource_id, action,
     request_hash, request_enc, idempotency_key_hash, lock_scopes_json,
     retry_policy, max_attempts, timeout_seconds, available_at)
    VALUES (?, ?, 'proxmox', 7, 'virtualMachine', ?, 'apply', ?, ?, ?, '[]', 'none', 1, 86400, datetime('now'))`)
    .run(id, type, resourceId, 'a'.repeat(64), 'encrypted', id.padEnd(64, 'f').slice(0, 64));
}

function operationStore(db) {
  let number = 0; const states = new Map();
  return {
    states,
    create: jest.fn(() => {
      const id = `op_${String(++number).padStart(26, '0')}`;
      insertOperation(db, id); states.set(id, 'queued'); return { id, state: 'queued' };
    }),
    get: jest.fn(id => ({ id, state: states.get(id) || 'queued' })),
    requestCancel: jest.fn(),
  };
}

function registryFor(feature, constraints) {
  return {
    capabilitiesForHost: jest.fn(async () => ({ features: { [feature]: { state: 'conditional', constraints } } })),
    resourcesForHost: jest.fn(async (_host, kind) => {
      if (kind === 'virtual-machines') return { items: [{ id: VM, displayName: 'database-01', relationships: { host: TARGET } }], totalObserved: 1 };
      return { items: [], totalObserved: 0 };
    }),
  };
}

describe('placement/HA change control', () => {
  let db;
  beforeEach(() => { db = createDb(); });
  afterEach(() => db.close());

  it('rejects rebalance waves above the configured child-operation bound', () => {
    expect(() => changes._internals._rebalanceInput({ waveSize: 3, maxMoves: 3,
      advisoryPlanHash: '1'.repeat(64) })).toThrow(expect.objectContaining({ code: 'INVALID_PLACEMENT_CHANGE_INPUT' }));
  });

  it('persists an encrypted request, enforces four-eyes approval, and post-verifies apply', async () => {
    let observed = { vmId: VM, restartPolicy: 'guaranteed', maxRestarts: 1, maxRelocations: 1 };
    const registry = registryFor('cluster.ha.policy.mutate', { fields: ['restartPolicy', 'maxRestarts', 'maxRelocations'] });
    const native = {
      open: jest.fn(async () => ({ host, client: {} })), close: jest.fn(async () => {}),
      snapshot: jest.fn(async () => ({ portable: { ...observed }, native: { sid: 'vm:100', exists: true } })),
      apply: jest.fn(async (_target, plan) => { observed = { ...plan.desired }; return { completed: true }; }),
      taskRef: jest.fn(() => null), parseTask: jest.fn(), taskStatus: jest.fn(), taskOutcome: jest.fn(),
    };
    const request = { changeKind: 'ha_policy', vmId: VM, policy: { maxRestarts: 3 } };
    const plan = await changes.preflightForHost(host, request, { database: db, registry, native, canOperate: true, enabled: true });
    expect(plan).toEqual(expect.objectContaining({ allowed: true, action: 'update', planHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(plan.diff).toEqual([{ path: 'maxRestarts', before: 1, after: 3 }]);

    const created = await changes.createForHost(host, { ...request, planHash: plan.planHash,
      confirm: true, confirmName: 'database-01', idempotencyKey: 'ha-policy-request-one' },
    { database: db, registry, native, canOperate: true, enabled: true, createdBy: 1 });
    expect(created.change.state).toBe('pending_approval');
    const stored = db.prepare('SELECT plan_enc, request_enc, idempotency_key_hash FROM provider_placement_changes').get();
    expect(stored.plan_enc).not.toContain('database-01');
    expect(stored.request_enc).not.toContain('maxRestarts');
    expect(stored.idempotency_key_hash).not.toContain('ha-policy-request-one');

    await expect(changes.approveForHost(host, created.change.id,
      { database: db, registry, native, actorId: 1, canOperate: true, enabled: true }))
      .rejects.toMatchObject({ code: 'FOUR_EYES_APPROVAL_REQUIRED', status: 403 });

    const operations = operationStore(db);
    const approved = await changes.approveForHost(host, created.change.id,
      { database: db, registry, native, operations, actorId: 2, canOperate: true, enabled: true });
    expect(approved.change).toEqual(expect.objectContaining({ state: 'approved', operationId: approved.operation.id }));
    const context = { request: { changeId: created.change.id, planHash: plan.planHash }, nativeTaskRef: null, reportProgress: jest.fn() };
    const result = await changes.executeOperation(created.change.id, context, { database: db, registry, native, operations, enabled: true });
    expect(result).toEqual(expect.objectContaining({ state: 'succeeded', result: expect.objectContaining({ verified: true }) }));
    expect(changes.get(created.change.id, { database: db }).state).toBe('succeeded');
    expect(native.apply).toHaveBeenCalledTimes(1);
  });

  it('rejects stale provider state during approval without creating an operation', async () => {
    let observed = { vmId: VM, restartPolicy: 'guaranteed', maxRestarts: 1, maxRelocations: 1 };
    const registry = registryFor('cluster.ha.policy.mutate', { fields: ['restartPolicy', 'maxRestarts', 'maxRelocations'] });
    const native = { open: jest.fn(async () => ({})), close: jest.fn(async () => {}),
      snapshot: jest.fn(async () => ({ portable: { ...observed }, native: { sid: 'vm:100', exists: true } })) };
    const request = { changeKind: 'ha_policy', vmId: VM, policy: { maxRestarts: 3 } };
    const plan = await changes.preflightForHost(host, request, { database: db, registry, native, canOperate: true, enabled: true });
    const created = await changes.createForHost(host, { ...request, planHash: plan.planHash,
      confirm: true, confirmName: 'database-01', idempotencyKey: 'ha-policy-stale-one' },
    { database: db, registry, native, canOperate: true, enabled: true, createdBy: 1 });
    observed.maxRelocations = 4;
    const operations = operationStore(db);
    await expect(changes.approveForHost(host, created.change.id,
      { database: db, registry, native, operations, actorId: 2, canOperate: true, enabled: true }))
      .rejects.toMatchObject({ code: 'PLACEMENT_CHANGE_PLAN_STALE', status: 409 });
    expect(operations.create).not.toHaveBeenCalled();
    expect(changes.get(created.change.id, { database: db }).state).toBe('pending_approval');
  });

  it('post-verifies affinity deletion from a fresh full rule inventory', async () => {
    const ruleId = `ddp_rule_${'d'.repeat(26)}`;
    let exists = true;
    const portable = { id: ruleId, name: 'spread-databases', kind: 'vm_vm_anti_affinity',
      vmIds: [VM, `ddr_vm_${'e'.repeat(26)}`], hostIds: [], clusterId: null, enabled: true, mandatory: false };
    const registry = registryFor('placement.affinity.mutate', { kinds: ['vm_vm_anti_affinity'] });
    const native = {
      open: jest.fn(async () => ({ host, client: {} })), close: jest.fn(async () => {}),
      snapshot: jest.fn(async (_target, _kind, input) => input.action === 'create'
        ? { portable: null, native: null, rules: exists ? [{ portable, native: { id: 'rule-7' } }] : [] }
        : { portable, native: { id: 'rule-7' }, rules: [{ portable, native: { id: 'rule-7' } }] }),
      apply: jest.fn(async () => { exists = false; return { completed: true }; }),
      taskRef: jest.fn(() => null), parseTask: jest.fn(), taskStatus: jest.fn(), taskOutcome: jest.fn(),
    };
    const request = { changeKind: 'affinity_rule', action: 'delete', ruleId };
    const plan = await changes.preflightForHost(host, request,
      { database: db, registry, native, canOperate: true, enabled: true });
    const created = await changes.createForHost(host, { ...request, planHash: plan.planHash,
      confirm: true, confirmName: portable.name, idempotencyKey: 'affinity-delete-one' },
    { database: db, registry, native, canOperate: true, enabled: true, createdBy: 1 });
    const operations = operationStore(db);
    await changes.approveForHost(host, created.change.id,
      { database: db, registry, native, operations, actorId: 2, canOperate: true, enabled: true });
    const result = await changes.executeOperation(created.change.id,
      { request: { changeId: created.change.id, planHash: plan.planHash }, nativeTaskRef: null, reportProgress: jest.fn() },
      { database: db, registry, native, operations, enabled: true });
    expect(result).toEqual(expect.objectContaining({ state: 'succeeded', result: expect.objectContaining({ verified: true }) }));
    expect(native.snapshot).toHaveBeenLastCalledWith(expect.anything(), 'affinity_rule', { action: 'create' });
  });

  it('builds a bounded rebalance request and auto-pauses on an unknown child', async () => {
    const advisoryHash = '1'.repeat(64);
    const registry = registryFor('placement.rebalance.apply', { waves: true });
    const advisory = { rebalancePlanForHost: jest.fn(async () => ({
      planHash: advisoryHash, skipped: [], moves: [{
        vm: { id: VM, displayName: 'database-01' }, sourceHostId: SOURCE, targetHostId: TARGET,
        mode: 'live', score: 90, confidence: 'high', policyEvidence: [],
      }],
    })) };
    const request = { changeKind: 'rebalance_apply', advisoryPlanHash: advisoryHash,
      sourceThresholdPercent: 85, targetThresholdPercent: 75, maxMoves: 1, waveSize: 1 };
    const plan = await changes.preflightForHost(host, request,
      { database: db, registry, advisory, canOperate: true, enabled: true });
    expect(plan).toEqual(expect.objectContaining({ allowed: true, action: 'apply' }));
    expect(plan.moves).toHaveLength(1);
    const created = await changes.createForHost(host, { ...request, planHash: plan.planHash,
      confirm: true, confirmName: 'pve-cluster', idempotencyKey: 'rebalance-request-one' },
    { database: db, registry, advisory, canOperate: true, enabled: true, createdBy: 1 });
    const operations = operationStore(db);
    await changes.approveForHost(host, created.change.id,
      { database: db, registry, advisory, operations, actorId: 2, canOperate: true, enabled: true });
    const vmMigration = {
      preflightForHost: jest.fn(async () => ({ allowed: true, sourceTargetId: SOURCE,
        planHash: '2'.repeat(64), vm: { id: VM, displayName: 'database-01' } })),
      submitForHost: jest.fn(async () => {
        const id = `op_${'9'.repeat(26)}`; insertOperation(db, id, 'vm.migrate'); operations.states.set(id, 'running'); return { operation: { id } };
      }),
    };
    const context = { request: { changeId: created.change.id, planHash: plan.planHash }, nativeTaskRef: null, reportProgress: jest.fn() };
    let result = await changes.executeOperation(created.change.id, context,
      { database: db, registry, advisory, operations, vmMigration, enabled: true });
    expect(result.state).toBe('reconciling');
    const running = changes.get(created.change.id, { database: db });
    expect(running.counts.submitted).toBe(1);
    operations.states.set(running.items[0].operationId, 'unknown');
    result = await changes.executeOperation(created.change.id, context,
      { database: db, registry, advisory, operations, vmMigration, enabled: true });
    expect(result).toEqual(expect.objectContaining({ state: 'reconciling', phase: 'paused' }));
    expect(changes.get(created.change.id, { database: db })).toEqual(expect.objectContaining({ state: 'paused', counts: expect.objectContaining({ unknown: 1 }) }));
    expect(vmMigration.submitForHost).toHaveBeenCalledTimes(1);
  });
});
