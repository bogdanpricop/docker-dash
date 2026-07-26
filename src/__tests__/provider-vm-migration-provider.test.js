'use strict';

jest.mock('../db', () => ({}));
jest.mock('../services/provider-sdk/identity-store', () => ({}));
jest.mock('../services/proxmox', () => ({}));
jest.mock('../services/vsphere', () => ({}));
jest.mock('../services/xen', () => ({}));

const bridge = require('../services/provider-operations/migration-provider');

describe('provider-native migration bridge', () => {
  it('submits Proxmox migration with server-resolved target and storage references', async () => {
    const migrateVm = jest.fn(async () => ({ taskRef: 'UPID:pve-a:1', node: 'pve-a' }));
    const target = {
      host: { daemon_type: 'proxmox' }, identity: { nativeRef: 'qemu/101' },
      targetIdentity: { nativeRef: 'pve-b' }, storageIdentity: { nativeRef: 'fast-zfs' },
      client: { migrateVm },
    };
    await expect(bridge.submit(target, { id: 'qemu/101', vmid: 101, type: 'qemu', node: 'pve-a' }, { mode: 'storage' }))
      .resolves.toEqual({ taskRef: 'UPID:pve-a:1', node: 'pve-a' });
    expect(migrateVm).toHaveBeenCalledWith('pve-a', '101', 'qemu', {
      target: 'pve-b', mode: 'storage', targetStorage: 'fast-zfs',
    });
  });

  it('submits vSphere RelocateVM_Task and XAPI pool_migrate without client native refs', async () => {
    const relocateVm = jest.fn(async () => ({ taskRef: 'task-7' }));
    const vsphere = {
      host: { daemon_type: 'vsphere' }, identity: { nativeRef: 'vm-42' },
      targetIdentity: { nativeRef: 'host-9' }, storageIdentity: { nativeRef: 'datastore-3' },
      client: { relocateVm },
    };
    await bridge.submit(vsphere, { moref: 'vm-42', hostRef: 'host-1' }, { mode: 'storage' });
    expect(relocateVm).toHaveBeenCalledWith('vm-42', { hostRef: 'host-9', datastoreRef: 'datastore-3' });

    const migrateVm = jest.fn(async () => ({ taskRef: 'OpaqueRef:task' }));
    const xapi = {
      host: { daemon_type: 'xen' }, identity: { nativeRef: 'OpaqueRef:vm', uuid: 'vm-uuid' },
      targetIdentity: { nativeRef: 'OpaqueRef:host-b' }, storageIdentity: null,
      client: { provider: 'xapi', migrateVm },
    };
    await bridge.submit(xapi, { uuid: 'vm-uuid', hostRef: 'OpaqueRef:host-a' }, { mode: 'live' });
    expect(migrateVm).toHaveBeenCalledWith('vm-uuid', 'OpaqueRef:host-b', { live: true, targetStorage: null });
  });

  it('normalizes provider task outcomes and gates vSphere cancellation', async () => {
    expect(bridge.taskOutcome('proxmox', { status: 'stopped', exitstatus: 'OK' })).toEqual({ done: true, progress: 100 });
    expect(bridge.taskOutcome('xen', { status: 'pending', progress: 0.4 })).toEqual({ pending: true, progress: 40 });
    expect(bridge.taskOutcome('vsphere', { status: 'error', error: 'incompatible' }))
      .toEqual({ failed: true, message: 'incompatible' });
    const client = { getTaskStatus: jest.fn(async () => ({ cancelable: false })), cancelTask: jest.fn() };
    const target = { host: { daemon_type: 'vsphere' }, client };
    await expect(bridge.cancel(target, { ref: 'task-7' })).resolves.toBe(false);
    expect(client.cancelTask).not.toHaveBeenCalled();
  });
});
