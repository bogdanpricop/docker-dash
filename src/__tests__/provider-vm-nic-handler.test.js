'use strict';

jest.mock('../config', () => ({
  features: { providerVmNicLinkProxmox: true, providerVmNicLinkVsphere: true, providerVmNicLinkXen: true },
  providerVmNics: { verifyTimeoutMs: 120000 },
}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('inject database'); }) }));
jest.mock('../services/provider-operations/nic-provider', () => ({
  open: jest.fn(), close: jest.fn(), inventory: jest.fn(), nicById: jest.fn(),
  mutate: jest.fn(), taskStatus: jest.fn(), cancelTask: jest.fn(),
}));

const handler = require('../services/provider-operations/handlers/vm-nic-link');
const bridge = require('../services/provider-operations/nic-provider');

const VM_ID = `ddr_vm_${'a'.repeat(26)}`;
const NIC_A = `ddh_nic_${'b'.repeat(26)}`;
const NIC_B = `ddh_nic_${'c'.repeat(26)}`;
const host = { id: 7, daemon_type: 'proxmox', is_active: 1 };
const target = { host, vmId: VM_ID };

function portable(id, connected) {
  return {
    id, label: id === NIC_A ? 'NIC 0' : 'NIC 1', device: id === NIC_A ? 'net0' : 'net1',
    model: 'virtio', macAddress: id === NIC_A ? '02:00:00:00:00:01' : '02:00:00:00:00:02',
    network: { id: id === NIC_A ? 'prod' : 'backup', bridge: id === NIC_A ? 'vmbr0' : 'vmbr1', vlanId: 10 },
    attachment: { connected }, capabilities: { connectDisconnect: true },
  };
}

function inventory(firstConnected) {
  return { nics: [
    { raw: { nativeRef: 'net0' }, portable: portable(NIC_A, firstConnected) },
    { raw: { nativeRef: 'net1' }, portable: portable(NIC_B, true) },
  ] };
}

function database(safety = {}) {
  return {
    prepare: sql => ({ get: (...args) => sql.includes('docker_hosts') ? host : {
      id: 4, host_id: 7, vm_id: VM_ID, nic_id: NIC_A,
      nic_fingerprint: safety.fingerprint, management_role: safety.managementRole || 'non_management',
      boot_dependency: safety.bootDependency || 'not_required', guest_dependency: safety.guestDependency || 'not_required',
      expires_at: safety.expiresAt || new Date(Date.now() + 60_000).toISOString(),
      args,
    } }),
  };
}

function context(action, fingerprint) {
  return {
    operation: {
      id: `op_${'d'.repeat(26)}`, provider: { type: 'proxmox', endpointId: 7 },
      resource: { id: VM_ID, kind: 'virtualMachine' }, action,
      createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
    },
    reportProgress: jest.fn(),
    request: {
      planHash: 'e'.repeat(64), nicId: NIC_A, nicFingerprint: fingerprint,
      expectedConnected: action === 'connect', previousConnected: action !== 'connect',
      safetyDeclarationId: action === 'disconnect' ? 4 : null,
      rollbackAction: action === 'connect' ? 'disconnect' : 'connect',
    },
  };
}

describe('durable VM NIC link handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    bridge.open.mockResolvedValue(target); bridge.close.mockResolvedValue();
    bridge.nicById.mockImplementation((current, id) => current.nics.find(item => item.portable.id === id));
  });

  it('revalidates disconnect safety and post-verifies a synchronous link change', async () => {
    const before = inventory(true); const after = inventory(false);
    const fingerprint = handler._internals._fingerprint(VM_ID, before.nics[0].portable);
    bridge.inventory.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    bridge.mutate.mockResolvedValue({ synchronous: true });
    const result = await handler.execute(context('disconnect', fingerprint), {
      database: database({ fingerprint }), enabled: true,
    });
    expect(result).toEqual(expect.objectContaining({
      state: 'succeeded', phase: 'verified',
      result: expect.objectContaining({ nicId: NIC_A, connected: false, verified: true }),
    }));
    expect(bridge.mutate).toHaveBeenCalledWith(target, 'disconnect', expect.objectContaining({ portable: expect.any(Object) }));
  });

  it('blocks execution if the safety declaration expired after preflight', async () => {
    const before = inventory(true);
    const fingerprint = handler._internals._fingerprint(VM_ID, before.nics[0].portable);
    bridge.inventory.mockResolvedValue(before);
    await expect(handler.execute(context('disconnect', fingerprint), {
      database: database({ fingerprint, expiresAt: new Date(Date.now() - 60_000).toISOString() }), enabled: true,
    })).rejects.toMatchObject({ code: 'VM_NIC_SAFETY_CHANGED' });
    expect(bridge.mutate).not.toHaveBeenCalled();
  });

  it('stores only a bounded native task envelope and never retries automatically', async () => {
    const before = inventory(false);
    const fingerprint = handler._internals._fingerprint(VM_ID, before.nics[0].portable);
    bridge.inventory.mockResolvedValue(before);
    bridge.mutate.mockResolvedValue({ taskRef: 'UPID:secret', node: 'pve-1' });
    const result = await handler.execute(context('connect', fingerprint), {
      database: database({ fingerprint }), enabled: true,
    });
    expect(handler._internals._parseTask(result.nativeTaskRef, 'proxmox')).toEqual({
      provider: 'proxmox', ref: 'UPID:secret', node: 'pve-1',
    });
    const engine = { registerHandler: jest.fn() };
    handler.register(engine, { database: database({ fingerprint }) });
    expect(engine.registerHandler).toHaveBeenCalledWith(expect.objectContaining({
      type: 'vm.nic.link', idempotent: false, retryPolicy: 'none',
    }));
  });
});
