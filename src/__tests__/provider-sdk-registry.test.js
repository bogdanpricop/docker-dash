'use strict';

const mockVersion = jest.fn();
const mockDestroy = jest.fn();
const mockVSphereLogin = jest.fn();
const mockVSphereInfo = jest.fn();
const mockXenInfo = jest.fn();
const mockXenCaps = jest.fn();

jest.mock('../services/proxmox', () => ({
  fromHostRow: () => ({ version: mockVersion, _agent: { destroy: mockDestroy } }),
}));
jest.mock('../services/vsphere', () => ({
  fromHostRow: () => ({
    login: mockVSphereLogin, retrieveServiceContent: mockVSphereInfo,
    _agent: { destroy: mockDestroy },
  }),
}));
jest.mock('../services/xen', () => ({
  clientForHost: () => ({ provider: 'xapi', info: mockXenInfo, capabilities: mockXenCaps }),
}));

const registry = require('../services/provider-sdk/registry');
const metrics = require('../services/metrics');

const pveHost = { id: 3, name: 'pve-a', daemon_type: 'proxmox', is_active: 1 };

describe('Provider SDK registry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registry._internals.clear();
    metrics._reset();
    mockVersion.mockResolvedValue({ version: '9.0', repoid: 'pve-manager' });
    mockVSphereLogin.mockResolvedValue({});
    mockVSphereInfo.mockResolvedValue({ productFullName: 'VMware vCenter Server 9.0', version: '9.0', apiVersion: '9.0' });
    mockXenCaps.mockReturnValue({
      vms: true, hosts: true, pools: true, storages: true, networks: true,
      tasks: true, snapshots: true, taskCleanup: true, vmActions: ['start', 'shutdown'],
    });
    mockXenInfo.mockResolvedValue({ product: 'XCP-ng', version: '8.3', apiVersion: 'xapi' });
  });

  it('probes and caches a provider envelope', async () => {
    const first = await registry.capabilitiesForHost(pveHost);
    const second = await registry.capabilitiesForHost(pveHost);
    expect(first.probe).toEqual(expect.objectContaining({ status: 'reachable', cached: false }));
    expect(first.provider).toEqual(expect.objectContaining({ type: 'proxmox', version: '9.0' }));
    expect(second.probe.cached).toBe(true);
    expect(mockVersion).toHaveBeenCalledTimes(1);
    expect(metrics.snapshot().providerCapabilityCacheTotal).toEqual(expect.objectContaining({ miss: 1, hit: 1 }));
  });

  it('deduplicates concurrent probes', async () => {
    let resolveVersion;
    mockVersion.mockReturnValue(new Promise(resolve => { resolveVersion = resolve; }));
    const a = registry.capabilitiesForHost(pveHost);
    const b = registry.capabilitiesForHost(pveHost);
    resolveVersion({ version: '9.1', repoid: 'pve' });
    const [first, second] = await Promise.all([a, b]);
    expect(first.provider.version).toBe('9.1');
    expect(second.provider.version).toBe('9.1');
    expect(mockVersion).toHaveBeenCalledTimes(1);
  });

  it('returns sanitized unreachable evidence without leaking provider errors', async () => {
    mockVersion.mockRejectedValue(new Error('connect https://root:secret-token@pve.internal failed'));
    const envelope = await registry.capabilitiesForHost(pveHost, { refresh: true });
    expect(envelope.probe.status).toBe('unreachable');
    expect(envelope.probe.error.message).toBe('Provider endpoint could not be reached');
    expect(JSON.stringify(envelope)).not.toContain('secret-token');
    expect(envelope.features['inventory.vm'].state).toBe('supported');
  });

  it('invalidates cached evidence', async () => {
    await registry.capabilitiesForHost(pveHost);
    registry.invalidateHost(pveHost.id);
    await registry.capabilitiesForHost(pveHost);
    expect(mockVersion).toHaveBeenCalledTimes(2);
  });

  it('rejects daemon types outside the registered v2 slice', async () => {
    await expect(registry.capabilitiesForHost({ id: 9, name: 'k8s', daemon_type: 'kubernetes' }))
      .rejects.toMatchObject({ code: 'PROVIDER_ADAPTER_UNAVAILABLE', status: 400 });
  });
});

