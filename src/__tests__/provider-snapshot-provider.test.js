'use strict';

const mockResolveCanonical = jest.fn();
const mockProxmoxFromHost = jest.fn();
const mockVsphereFromHost = jest.fn();
const mockXenForHost = jest.fn();

jest.mock('../services/provider-sdk/identity-store', () => ({
  resolveCanonical: (...args) => mockResolveCanonical(...args),
}));
jest.mock('../services/proxmox', () => ({ fromHostRow: (...args) => mockProxmoxFromHost(...args) }));
jest.mock('../services/vsphere', () => ({ fromHostRow: (...args) => mockVsphereFromHost(...args) }));
jest.mock('../services/xen', () => ({ clientForHost: (...args) => mockXenForHost(...args) }));

const bridge = require('../services/provider-operations/snapshot-provider');

describe('shared provider snapshot collection session', () => {
  beforeEach(() => jest.clearAllMocks());

  test('opens one vSphere VM inventory and resolves multiple canonical targets from it', async () => {
    const client = { listVMs: jest.fn().mockResolvedValue([
      { moref: 'vm-101', uuid: 'uuid-1' }, { moref: 'vm-102', uuid: 'uuid-2' },
    ]), _agent: { destroy: jest.fn() } };
    mockVsphereFromHost.mockReturnValue(client);
    mockResolveCanonical.mockImplementation(vmId => ({
      providerType: 'vsphere', stability: 'stable', uuid: vmId === 'canonical-1' ? 'uuid-1' : 'uuid-2', nativeRef: 'unused',
    }));
    const host = { id: 7, daemon_type: 'vsphere' };
    const session = await bridge.openHost(host);
    const first = bridge.targetFromSession(session, 'canonical-1');
    const second = bridge.targetFromSession(session, 'canonical-2');

    expect(client.listVMs).toHaveBeenCalledTimes(1);
    expect(first.native).toEqual({ vmMoref: 'vm-101' });
    expect(second.native).toEqual({ vmMoref: 'vm-102' });
    await bridge.close(session);
    expect(client._agent.destroy).toHaveBeenCalledTimes(1);
  });

  test('preserves optional provider-reported snapshot bytes in the normalized list', async () => {
    const target = {
      host: { daemon_type: 'vsphere' }, native: { vmMoref: 'vm-101' },
      client: { listVMSnapshots: jest.fn().mockResolvedValue([
        { nativeRef: 'snapshot-1', name: 'daily', createdAt: '2026-07-30T00:00:00Z', sizeBytes: 8192 },
      ]) },
    };
    await expect(bridge.list(target)).resolves.toEqual([
      expect.objectContaining({ nativeRef: 'snapshot-1', name: 'daily', sizeBytes: 8192 }),
    ]);
  });
});
