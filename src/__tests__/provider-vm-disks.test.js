'use strict';

jest.mock('../config', () => ({
  features: { providerVmDiskLifecycle: false, providerVmDiskDelete: false },
  providerVmDisks: { minimumSizeBytes: 64 * 1024 * 1024, capacityHeadroomPercent: 10, planTtlMs: 300000,
    deletionRecoveryMaxAgeHours: 24 },
}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('inject database'); }) }));
jest.mock('../services/provider-operations/index', () => ({}));
jest.mock('../services/provider-sdk/registry', () => ({}));
jest.mock('../services/provider-sdk/managed-volume-store', () => ({
  list: jest.fn(() => []), findForDisk: jest.fn(() => null), resolve: jest.fn(), SAFE_ID: /^ddv_vol_[a-f0-9]{26}$/,
}));
jest.mock('../services/provider-sdk/vm-snapshot-store', () => ({ list: jest.fn(() => []) }));
jest.mock('../services/provider-operations/policy', () => ({}));
jest.mock('../services/provider-operations/handlers/vm-disk', () => ({ TYPE: 'vm.disk' }));

const service = require('../services/provider-operations/vm-disks');
const snapshotStore = require('../services/provider-sdk/vm-snapshot-store');

const VM_ID = `ddr_vm_${'a'.repeat(26)}`;
const DISK_ID = `ddh_disk_${'b'.repeat(26)}`;
const STORAGE_ID = `ddr_storage_${'c'.repeat(26)}`;
const host = { id: 7, daemon_type: 'xen' };

function dependencies(overrides = {}) {
  const vm = { id: VM_ID, kind: 'virtualMachine', displayName: 'payments-01',
    identity: { stability: 'stable' }, status: { powerState: overrides.powerState || 'stopped' } };
  const disk = {
    id: DISK_ID, label: 'data', type: 'disk', bus: 'xen-vbd', unit: 0,
    capacityBytes: 1024 ** 3, backing: { storageName: 'sr-a' },
    attachment: { readOnly: false, shared: false, bootable: false },
    capabilities: { hotUnplug: true, onlineResize: overrides.onlineResize ?? false },
  };
  const storage = { id: STORAGE_ID, displayName: 'sr-b', identity: { stability: 'stable' },
    status: { accessible: true, freeBytes: 20 * 1024 ** 3 }, extensions: {} };
  const capabilities = { features: Object.fromEntries(Object.values(service.ACTIONS).map(key => [key,
    { state: overrides.capabilityState || 'conditional', reason: 'available', constraints: {} }])) };
  const operations = { list: jest.fn(() => overrides.active || []), create: jest.fn(input => ({ id: `op_${'d'.repeat(26)}`, ...input })) };
  snapshotStore.list.mockReturnValue(overrides.snapshots || []);
  return {
    enabled: overrides.enabled ?? true, deleteEnabled: overrides.deleteEnabled ?? true,
    canOperate: overrides.canOperate ?? true, createdBy: 9, database: {}, operations,
    registry: {
      resourcesForHost: jest.fn(async (_host, kind) => kind === 'virtual-machines'
        ? { items: [vm] } : { items: [storage] }),
      vmHardwareForHost: jest.fn(async () => ({
        observedAt: '2026-07-26T00:00:00.000Z', summary: { diskCount: 1 }, sections: {}, disks: [disk],
      })),
      capabilitiesForHost: jest.fn(async () => capabilities),
    },
    policy: { evaluate: jest.fn(() => overrides.policy || { allowed: true, mode: 'normal' }) },
    vm, disk, storage,
  };
}

describe('common VM disk lifecycle plans', () => {
  beforeEach(() => jest.clearAllMocks());

  it('builds a bounded create-and-attach plan with storage headroom and a free slot', async () => {
    const deps = dependencies();
    const plan = await service.preflightForHost(host, VM_ID, 'create', {
      label: 'ledger-data', sizeBytes: 2 * 1024 ** 3, targetStorageId: STORAGE_ID,
    }, null, deps);
    expect(plan).toEqual(expect.objectContaining({
      allowed: true, action: 'create', planHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      request: expect.objectContaining({ bus: 'xen-vbd', unit: 1, provisioning: 'thin' }),
      storage: expect.objectContaining({ id: STORAGE_ID }),
    }));
  });

  it('permanently rejects shrink and blocks online growth without positive evidence', async () => {
    const deps = dependencies({ powerState: 'running', onlineResize: false });
    const plan = await service.preflightForHost(host, VM_ID, 'resize', {
      sizeBytes: 512 * 1024 ** 2,
    }, DISK_ID, deps);
    expect(plan.allowed).toBe(false);
    expect(plan.blockers.map(item => item.type)).toEqual(expect.arrayContaining([
      'VM_DISK_SHRINK_FORBIDDEN', 'VM_DISK_ONLINE_RESIZE_UNAVAILABLE',
    ]));
  });

  it('blocks detach when snapshot dependency evidence exists', async () => {
    const deps = dependencies({ snapshots: [{ id: 'snapshot' }] });
    const plan = await service.preflightForHost(host, VM_ID, 'detach', {}, DISK_ID, deps);
    expect(plan.allowed).toBe(false);
    expect(plan.blockers).toContainEqual(expect.objectContaining({ type: 'VM_DISK_SNAPSHOT_DEPENDENCY' }));
    expect(plan.request).toEqual({ retainBacking: true });
  });

  it('submits only the exact reviewed plan to the non-idempotent operation engine', async () => {
    const deps = dependencies();
    const input = { label: 'ledger-data', sizeBytes: 2 * 1024 ** 3, targetStorageId: STORAGE_ID };
    const plan = await service.preflightForHost(host, VM_ID, 'create', input, null, deps);
    await expect(service.submitForHost(host, VM_ID, 'create', {
      ...input, planHash: '0'.repeat(64), confirm: true, confirmName: 'payments-01', idempotencyKey: 'disk-create-01',
    }, null, deps)).rejects.toMatchObject({ code: 'VM_DISK_PREFLIGHT_STALE' });
    const result = await service.submitForHost(host, VM_ID, 'create', {
      ...input, planHash: plan.planHash, confirm: true, confirmName: 'payments-01', idempotencyKey: 'disk-create-01',
    }, null, deps);
    expect(result.operation.type).toBe('vm.disk');
    expect(deps.operations.create).toHaveBeenCalledWith(expect.objectContaining({
      type: 'vm.disk', action: 'create', resourceId: VM_ID,
      lockScopes: [`resource:${VM_ID}`, `storage:${STORAGE_ID}`],
    }));
  });
});
