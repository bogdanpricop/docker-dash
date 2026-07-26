'use strict';

const mockResolveCanonical = jest.fn();
const mockProxmoxFromHost = jest.fn();
const mockVSphereFromHost = jest.fn();
const mockXenForHost = jest.fn();

jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must inject database'); }) }));
jest.mock('../services/provider-sdk/identity-store', () => ({
  resolveCanonical: (...args) => mockResolveCanonical(...args),
}));
jest.mock('../services/proxmox', () => ({ fromHostRow: (...args) => mockProxmoxFromHost(...args) }));
jest.mock('../services/vsphere', () => ({ fromHostRow: (...args) => mockVSphereFromHost(...args) }));
jest.mock('../services/xen', () => ({ clientForHost: (...args) => mockXenForHost(...args) }));

const handler = require('../services/provider-operations/handlers/vm-power');

const VM_ID = `ddr_vm_${'a'.repeat(26)}`;

function database(provider = 'proxmox') {
  return { prepare: () => ({ get: () => ({ id: 7, daemon_type: provider, is_active: 1 }) }) };
}

function operation(provider = 'proxmox', action = 'start') {
  return {
    id: `op_${'b'.repeat(26)}`, provider: { type: provider, endpointId: 7 },
    resource: { id: VM_ID, kind: 'virtualMachine' }, action,
    createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
  };
}

describe('durable VM power handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveCanonical.mockReturnValue({
      id: VM_ID, providerType: 'proxmox', nativeRef: 'qemu/101', uuid: null, stability: 'derived',
    });
  });

  it('submits exactly one Proxmox mutation after live state revalidation', async () => {
    const client = {
      listVMs: jest.fn().mockResolvedValue([{ id: 'qemu/101', node: 'pve-a', type: 'qemu', status: 'stopped' }]),
      vmPowerAction: jest.fn().mockResolvedValue({ taskRef: 'UPID:pve-a:secret', node: 'pve-a' }),
      _agent: { destroy: jest.fn() },
    };
    mockProxmoxFromHost.mockReturnValue(client);
    const reportProgress = jest.fn();
    const result = await handler.execute({ operation: operation(), reportProgress }, { database: database() });
    expect(client.vmPowerAction).toHaveBeenCalledTimes(1);
    expect(client.vmPowerAction).toHaveBeenCalledWith('pve-a', '101', 'qemu', 'start');
    expect(result).toEqual(expect.objectContaining({ state: 'reconciling', phase: 'native-task', nativeTaskState: 'pending' }));
    expect(handler._internals._parseTask(result.nativeTaskRef, 'proxmox')).toEqual({
      provider: 'proxmox', ref: 'UPID:pve-a:secret', node: 'pve-a',
    });
    expect(reportProgress).toHaveBeenCalledWith(20, 'pre-submit', expect.any(String), { powerState: 'stopped' });
  });

  it('waits for the native task and verifies the post-state before succeeding', async () => {
    const client = {
      listVMs: jest.fn().mockResolvedValue([{ id: 'qemu/101', node: 'pve-a', type: 'qemu', status: 'running' }]),
      getTaskStatus: jest.fn().mockResolvedValue({ status: 'stopped', exitstatus: 'OK' }),
      _agent: { destroy: jest.fn() },
    };
    mockProxmoxFromHost.mockReturnValue(client);
    const op = operation();
    const nativeTaskRef = handler._internals._taskRef('proxmox', { taskRef: 'UPID:pve-a:secret', node: 'pve-a' });
    const result = await handler.reconcile({ operation: op, nativeTaskRef, reportProgress: jest.fn() }, { database: database() });
    expect(result).toEqual({ state: 'succeeded', phase: 'verified', result: { powerState: 'running', verified: true } });
  });

  it('never dispatches transient raw-Xen identities', async () => {
    mockResolveCanonical.mockReturnValue({
      id: VM_ID, providerType: 'xen', nativeRef: '42', uuid: null, stability: 'transient',
    });
    await expect(handler.execute({ operation: operation('xen', 'shutdown'), reportProgress: jest.fn() }, {
      database: database('xen'),
    })).rejects.toMatchObject({ code: 'INVALID_OPERATION_RESOURCE' });
    expect(mockXenForHost).not.toHaveBeenCalled();
  });

  it('allows confirmed cancellation only for a native Proxmox task', async () => {
    const client = { stopTask: jest.fn().mockResolvedValue({ ok: true }), _agent: { destroy: jest.fn() } };
    mockProxmoxFromHost.mockReturnValue(client);
    const op = operation();
    const nativeTaskRef = handler._internals._taskRef('proxmox', { taskRef: 'UPID:pve-a:secret', node: 'pve-a' });
    await expect(handler.cancel({ operation: op, nativeTaskRef }, { database: database() }))
      .resolves.toEqual({ confirmed: true, result: { providerTaskCancelled: true } });
    expect(client.stopTask).toHaveBeenCalledWith('pve-a', 'UPID:pve-a:secret');
    await expect(handler.cancel({ operation: operation('vsphere'), nativeTaskRef: null }, { database: database('vsphere') }))
      .resolves.toEqual({ confirmed: false });
  });
});
