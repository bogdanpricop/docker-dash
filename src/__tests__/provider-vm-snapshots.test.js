'use strict';

jest.mock('../config', () => ({
  features: { providerVmSnapshots: false }, providerSnapshots: { maxCount: 32 },
}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must inject database'); }) }));
jest.mock('../services/provider-operations/index', () => ({ list: jest.fn(() => []), create: jest.fn() }));
jest.mock('../services/provider-sdk/registry', () => ({}));
jest.mock('../services/provider-sdk/vm-snapshot-store', () => ({
  rememberMany: jest.fn(), list: jest.fn(), resolve: jest.fn(),
}));
jest.mock('../services/provider-operations/policy', () => ({}));
jest.mock('../services/provider-operations/snapshot-provider', () => ({
  open: jest.fn(), list: jest.fn(), close: jest.fn(),
}));
jest.mock('../services/provider-operations/handlers/vm-snapshot', () => ({ TYPE: 'vm.snapshot' }));

const service = require('../services/provider-operations/vm-snapshots');
const bridge = require('../services/provider-operations/snapshot-provider');
const snapshotStore = require('../services/provider-sdk/vm-snapshot-store');

const VM_ID = `ddr_vm_${'a'.repeat(26)}`;
const SNAP_ID = `dds_snap_${'b'.repeat(26)}`;
const host = { id: 7, daemon_type: 'vsphere' };

function snapshot(overrides = {}) {
  return {
    id: SNAP_ID, name: 'before-upgrade', parentId: null, childCount: 0,
    isCurrent: true, consistency: 'crash', integrity: { state: 'valid' },
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  const items = overrides.items || [];
  const inventory = {
    vm: {
      id: VM_ID, displayName: 'web-01', powerState: 'running',
      actions: ['snapshot', 'snapshotQuiesced'], identity: { stability: 'stable' },
    }, count: items.length, maxCount: overrides.maxCount || 32,
    observedDepth: overrides.observedDepth || 0, maxDepth: overrides.maxDepth || 16, items,
    protection: { warning: 'A snapshot is not a backup' },
  };
  const operations = {
    list: jest.fn(() => overrides.active || []),
    create: jest.fn(input => ({ id: `op_${'c'.repeat(26)}`, ...input })),
  };
  return {
    enabled: overrides.enabled ?? true, canOperate: overrides.canOperate ?? true, createdBy: 9,
    database: {}, operations,
    registry: {
      resourcesForHost: jest.fn(async () => ({ items: [inventory.vm] })),
      capabilitiesForHost: jest.fn(async () => ({ features: {
        'vm.snapshot.create': { state: 'conditional', constraints: { consistency: overrides.consistency || ['crash', 'quiesced'] } },
        'vm.snapshot.revert': { state: 'conditional', constraints: {} },
        'vm.snapshot.delete': { state: 'conditional', constraints: {} },
      } })),
    },
    policy: { evaluate: jest.fn(() => overrides.policy || { allowed: true, code: null, mode: 'normal', reason: null }) },
    inventory,
  };
}

async function plan(action, input, snapshotId, deps) {
  const context = {
    host, database: deps.database, inventory: deps.inventory,
    capabilities: await deps.registry.capabilitiesForHost(host),
    activeOperations: deps.operations.list(), policy: deps.policy.evaluate(),
    enabled: deps.enabled, canOperate: deps.canOperate, input,
  };
  return service._internals._plan(context, action, input, snapshotId);
}

describe('common VM snapshot plans and submission', () => {
  it('builds a portable create plan with backup guardrails and stable hash', async () => {
    const deps = dependencies();
    const result = await plan('create', { name: 'before-upgrade', description: 'release checkpoint', consistency: 'quiesced' }, null, deps);
    expect(result).toEqual(expect.objectContaining({
      allowed: true, action: 'create', name: 'before-upgrade', consistency: 'quiesced',
      planHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      protection: expect.objectContaining({ isBackup: false }),
    }));
    expect(result.warnings.map(item => item.type)).toEqual(expect.arrayContaining(['NOT_A_BACKUP', 'GUEST_QUIESCE']));
  });

  it('fails closed on release, permission, policy, conflict, duplicate, limit and consistency', async () => {
    const deps = dependencies({
      items: [snapshot()], maxCount: 1, enabled: false, canOperate: false,
      active: [{ id: `op_${'d'.repeat(26)}`, state: 'running', resource: { id: VM_ID } }],
      policy: { allowed: false, code: 'CHANGE_FREEZE', mode: 'frozen', reason: 'Change freeze' },
      consistency: ['crash'], observedDepth: 1, maxDepth: 1,
    });
    const result = await plan('create', { name: 'before-upgrade', consistency: 'quiesced' }, null, deps);
    expect(result.allowed).toBe(false);
    expect(result.blockers.map(item => item.type)).toEqual(expect.arrayContaining([
      'RELEASE_DISABLED', 'PERMISSION_BLOCKED', 'POLICY_BLOCKED', 'OPERATION_CONFLICT',
      'SNAPSHOT_NAME_CONFLICT', 'SNAPSHOT_LIMIT_REACHED', 'SNAPSHOT_CONSISTENCY_UNAVAILABLE',
      'SNAPSHOT_CHAIN_LIMIT_REACHED',
    ]));
  });

  it('requires typed VM/snapshot names and blocks delete with children', async () => {
    const deps = dependencies({ items: [snapshot({ childCount: 2 })] });
    const revert = await plan('revert', {}, SNAP_ID, deps);
    expect(revert.confirmation).toEqual({ required: true, mode: 'typed_name', expected: 'web-01' });
    expect(() => service._internals._assertSubmission(revert, {
      planHash: revert.planHash, confirm: true, confirmName: 'wrong',
    })).toThrow(expect.objectContaining({ code: 'VM_SNAPSHOT_TYPED_CONFIRMATION_REQUIRED' }));
    const deletion = await plan('delete', {}, SNAP_ID, deps);
    expect(deletion.allowed).toBe(false);
    expect(deletion.blockers).toContainEqual(expect.objectContaining({ type: 'SNAPSHOT_HAS_CHILDREN' }));
  });

  it('submits a durable non-idempotent operation only after exact preflight confirmation', async () => {
    const deps = dependencies();
    bridge.open.mockResolvedValue({ host, vmId: VM_ID });
    bridge.list.mockResolvedValue([]);
    bridge.close.mockResolvedValue(undefined);
    snapshotStore.rememberMany.mockReturnValue([]);
    const createPlan = await service.preflightForHost(host, VM_ID, 'create', {
      name: 'release-1', consistency: 'crash',
    }, null, deps);
    await expect(service.submitForHost(host, VM_ID, 'create', {
      name: 'release-1', consistency: 'crash', planHash: '0'.repeat(64), confirm: true,
    }, null, deps)).rejects.toMatchObject({ code: 'VM_SNAPSHOT_PREFLIGHT_STALE' });
    const result = await service.submitForHost(host, VM_ID, 'create', {
      name: 'release-1', consistency: 'crash', planHash: createPlan.planHash,
      confirm: true, idempotencyKey: 'snapshot-release-1',
    }, null, deps);
    expect(result.operation.type).toBe('vm.snapshot');
    expect(deps.operations.create).toHaveBeenCalledWith(expect.objectContaining({
      type: 'vm.snapshot', action: 'create', resourceId: VM_ID,
      idempotencyKey: 'snapshot-release-1', lockScopes: [`resource:${VM_ID}`],
    }));
  });
});
