'use strict';

jest.mock('../config', () => ({
  features: { providerVmDiskLifecycle: true, providerVmDiskDelete: true },
  providerVmDisks: { deletionRecoveryMaxAgeHours: 24 },
}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('inject database'); }) }));
jest.mock('../services/provider-sdk/managed-volume-store', () => ({
  SAFE_ID: /^ddv_vol_[a-f0-9]{26}$/, findForDisk: jest.fn(), create: jest.fn(),
  resolve: jest.fn(), transition: jest.fn(),
}));
jest.mock('../services/provider-sdk/vm-snapshot-store', () => ({ list: jest.fn(() => []) }));
jest.mock('../services/provider-operations/disk-provider', () => ({
  open: jest.fn(), close: jest.fn(), inventory: jest.fn(), diskById: jest.fn(),
  backingRef: jest.fn(), mutate: jest.fn(), deleteBacking: jest.fn(), backingExists: jest.fn(),
  taskStatus: jest.fn(), cancelTask: jest.fn(),
}));

const handler = require('../services/provider-operations/handlers/vm-disk');
const bridge = require('../services/provider-operations/disk-provider');
const managedStore = require('../services/provider-sdk/managed-volume-store');

const VM_ID = `ddr_vm_${'a'.repeat(26)}`;
const DISK_ID = `ddh_disk_${'b'.repeat(26)}`;
const STORAGE_ID = `ddr_storage_${'c'.repeat(26)}`;
const host = { id: 7, daemon_type: 'xen', is_active: 1 };
const target = { host, vmId: VM_ID };

function database() {
  return { prepare: () => ({ get: () => host, all: () => [] }) };
}

function context(action = 'create', request = {}) {
  return {
    operation: {
      id: `op_${'d'.repeat(26)}`, provider: { type: 'xen', endpointId: 7 },
      resource: { id: VM_ID, kind: 'virtualMachine' }, action, createdBy: 9,
      createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
    }, reportProgress: jest.fn(), request: {
      planHash: 'e'.repeat(64), diskId: action === 'create' ? null : DISK_ID,
      label: 'ledger-data', sizeBytes: 2 * 1024 ** 3, bus: 'xen-vbd', unit: 1,
      targetStorageId: STORAGE_ID, targetStorageName: 'sr-b', ...request,
    },
  };
}

function createdDisk() {
  return { raw: { nativeRef: 'OpaqueRef:vbd', backing: { nativeRef: 'OpaqueRef:vdi' } }, portable: {
    id: DISK_ID, type: 'disk', bus: 'xen-vbd', unit: 1, capacityBytes: 2 * 1024 ** 3,
    attachment: { readOnly: false }, backing: { storageName: 'sr-b' },
  } };
}

describe('durable VM disk operation handler', () => {
  beforeEach(() => {
    jest.clearAllMocks(); bridge.open.mockResolvedValue(target); bridge.close.mockResolvedValue();
    managedStore.findForDisk.mockReturnValue(null);
  });

  it('post-verifies synchronous create before recording encrypted ownership', async () => {
    const disk = createdDisk();
    bridge.inventory.mockResolvedValueOnce({ disks: [] }).mockResolvedValueOnce({ disks: [disk] });
    bridge.mutate.mockResolvedValue({ synchronous: true, backingRef: 'OpaqueRef:vdi' });
    bridge.backingRef.mockReturnValue('OpaqueRef:vdi');
    managedStore.create.mockReturnValue({ id: `ddv_vol_${'f'.repeat(26)}` });
    const result = await handler.execute(context(), { database: database() });
    expect(result).toEqual(expect.objectContaining({
      state: 'succeeded', phase: 'verified', result: expect.objectContaining({
        diskId: DISK_ID, managedVolumeId: `ddv_vol_${'f'.repeat(26)}`, verified: true,
      }),
    }));
    expect(managedStore.create).toHaveBeenCalledWith(expect.objectContaining({
      nativeRef: 'OpaqueRef:vdi', diskId: DISK_ID, state: 'attached',
    }), expect.anything());
    expect(bridge.close).toHaveBeenCalledWith(target);
  });

  it('persists only an encrypted native-task envelope for async resize', async () => {
    const disk = createdDisk();
    bridge.inventory.mockResolvedValue({ disks: [disk] });
    bridge.diskById.mockReturnValue(disk);
    bridge.mutate.mockResolvedValue({ taskRef: 'OpaqueRef:task-secret', backingRef: 'OpaqueRef:vdi' });
    const result = await handler.execute(context('resize', { sizeBytes: 3 * 1024 ** 3 }), { database: database() });
    expect(result).toEqual(expect.objectContaining({ state: 'reconciling', nativeTaskRef: expect.any(String) }));
    expect(handler._internals._parseTask(result.nativeTaskRef, 'xen')).toEqual({
      provider: 'xen', ref: 'OpaqueRef:task-secret', backingRef: 'OpaqueRef:vdi',
    });
  });

  it('registers without automatic replay', () => {
    const engine = { registerHandler: jest.fn() };
    handler.register(engine, { database: database() });
    expect(engine.registerHandler).toHaveBeenCalledWith(expect.objectContaining({
      type: 'vm.disk', idempotent: false, retryPolicy: 'none',
    }));
  });
});
