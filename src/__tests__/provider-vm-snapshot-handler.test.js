'use strict';

jest.mock('../config', () => ({ providerSnapshots: { maxCount: 32, maxDepth: 16 } }));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must inject database'); }) }));
jest.mock('../services/provider-sdk/vm-snapshot-store', () => ({
  rememberMany: jest.fn(), resolve: jest.fn(),
}));
jest.mock('../services/provider-operations/snapshot-provider', () => ({
  open: jest.fn(), close: jest.fn(), list: jest.fn(), mutate: jest.fn(),
  taskStatus: jest.fn(), cancelTask: jest.fn(),
}));

const handler = require('../services/provider-operations/handlers/vm-snapshot');
const bridge = require('../services/provider-operations/snapshot-provider');
const snapshotStore = require('../services/provider-sdk/vm-snapshot-store');

const VM_ID = `ddr_vm_${'a'.repeat(26)}`;
const SNAP_ID = `dds_snap_${'b'.repeat(26)}`;
const host = { id: 7, daemon_type: 'vsphere', is_active: 1 };
const target = { host, vmId: VM_ID };

function database() {
  return { prepare: () => ({ get: () => host }) };
}

function operation(action = 'create') {
  return {
    id: `op_${'c'.repeat(26)}`, provider: { type: 'vsphere', endpointId: 7 },
    resource: { id: VM_ID, kind: 'virtualMachine' }, action,
    createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
  };
}

function context(action = 'create', request = {}) {
  return {
    operation: operation(action), reportProgress: jest.fn(),
    request: action === 'create'
      ? { name: 'before-upgrade', consistency: 'crash', ...request }
      : { snapshotId: SNAP_ID, ...request },
  };
}

function publicSnapshot(overrides = {}) {
  return {
    id: SNAP_ID, name: 'before-upgrade', childCount: 0, consistency: 'crash',
    protection: { isBackup: false }, nativeRef: 'snapshot-42', ...overrides,
  };
}

describe('durable common VM snapshot handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    bridge.open.mockResolvedValue(target);
    bridge.close.mockResolvedValue(undefined);
    bridge.list.mockResolvedValue([]);
    snapshotStore.rememberMany.mockReturnValue([]);
    snapshotStore.resolve.mockReturnValue(null);
  });

  it('dispatches exactly one mutation and persists only an opaque task envelope', async () => {
    bridge.mutate.mockResolvedValue({ taskRef: 'haTask-secret-42', provider: 'vsphere' });
    const result = await handler.execute(context(), { database: database() });
    expect(bridge.mutate).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({
      state: 'reconciling', phase: 'native-task', nativeTaskState: 'pending',
      nativeTaskRef: expect.any(String),
    }));
    expect(handler._internals._parseTask(result.nativeTaskRef, 'vsphere')).toEqual({
      provider: 'vsphere', ref: 'haTask-secret-42',
    });
    expect(bridge.close).toHaveBeenCalledWith(target);
  });

  it('completes synchronous verification before closing the provider client', async () => {
    const item = publicSnapshot();
    bridge.mutate.mockResolvedValue({ taskRef: null, provider: 'vsphere' });
    snapshotStore.rememberMany.mockReturnValueOnce([]).mockReturnValueOnce([item]);
    const result = await handler.execute(context(), { database: database() });
    expect(result).toEqual(expect.objectContaining({
      state: 'succeeded', phase: 'verified', result: expect.objectContaining({ snapshotId: SNAP_ID, verified: true }),
    }));
    expect(bridge.list).toHaveBeenCalledTimes(2);
    expect(bridge.close.mock.invocationCallOrder[0]).toBeGreaterThan(bridge.list.mock.invocationCallOrder[1]);
  });

  it('reconciles a completed provider task against refreshed inventory', async () => {
    bridge.taskStatus.mockResolvedValue({ status: 'success', progress: 100 });
    snapshotStore.rememberMany.mockReturnValue([publicSnapshot()]);
    const nativeTaskRef = handler._internals._taskRef('vsphere', { taskRef: 'haTask-42' });
    const result = await handler.reconcile({ ...context(), nativeTaskRef }, { database: database() });
    expect(result).toEqual(expect.objectContaining({ state: 'succeeded', phase: 'verified' }));
    expect(bridge.taskStatus).toHaveBeenCalledTimes(1);
  });

  it('revalidates child dependencies immediately before delete', async () => {
    snapshotStore.rememberMany.mockReturnValue([publicSnapshot({ childCount: 1 })]);
    snapshotStore.resolve.mockReturnValue(publicSnapshot({ childCount: 1 }));
    await expect(handler.execute(context('delete'), { database: database() }))
      .rejects.toMatchObject({ code: 'SNAPSHOT_HAS_CHILDREN' });
    expect(bridge.mutate).not.toHaveBeenCalled();
  });

  it('revalidates graph integrity and maximum chain depth before create', async () => {
    const chain = Array.from({ length: 16 }, (_, index) => publicSnapshot({
      id: `dds_snap_${index.toString(16).padStart(26, '0')}`,
      name: `snapshot-${index}`,
      parentId: index ? `dds_snap_${(index - 1).toString(16).padStart(26, '0')}` : null,
      integrity: { state: 'valid' },
    }));
    snapshotStore.rememberMany.mockReturnValue(chain);
    await expect(handler.execute(context(), { database: database() }))
      .rejects.toMatchObject({ code: 'SNAPSHOT_CHAIN_LIMIT_REACHED' });
    expect(bridge.mutate).not.toHaveBeenCalled();
  });

  it('does not replay a mutation after an ambiguous provider failure', async () => {
    bridge.mutate.mockRejectedValue(Object.assign(new Error('upstream timed out'), { code: 'ETIMEDOUT' }));
    await expect(handler.execute(context(), { database: database() })).rejects.toThrow('upstream timed out');
    expect(bridge.mutate).toHaveBeenCalledTimes(1);
  });

  it('registers as non-idempotent with retries disabled', () => {
    const engine = { registerHandler: jest.fn() };
    handler.register(engine, { database: database() });
    expect(engine.registerHandler).toHaveBeenCalledWith(expect.objectContaining({
      type: 'vm.snapshot', idempotent: false, retryPolicy: 'none',
    }));
  });
});
