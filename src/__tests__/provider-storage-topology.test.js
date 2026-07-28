'use strict';

jest.mock('../services/provider-sdk/registry', () => ({
  capabilitiesForHost: jest.fn(), resourcesForHost: jest.fn(), vmHardwareForHost: jest.fn(),
}));

const registry = require('../services/provider-sdk/registry');
const topology = require('../services/provider-sdk/storage-topology');

const host = { id: 7, daemon_type: 'vsphere', name: 'vcenter' };
const database = { prepare: () => ({ get: () => undefined }) };
const capabilities = {
  probe: { status: 'reachable' },
  features: { 'storage.sharedTopology.read': { state: 'conditional', reason: 'read-only evidence' } },
};
const hardware = (backingId, shared) => ({
  sections: { disks: { available: true, truncated: false } },
  disks: [{ id: `ddh_disk_${backingId.slice(-4)}`, label: 'data', type: 'disk',
    backing: { id: backingId, storageId: 'native-datastore-should-not-leak' },
    attachment: { connected: true, readOnly: false, shared } }],
});

describe('Provider shared-disk topology', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registry.capabilitiesForHost.mockResolvedValue(capabilities);
    registry.resourcesForHost.mockImplementation((_host, kind) => Promise.resolve(kind === 'virtual-machines'
      ? { provider: { type: 'vsphere', endpointId: 7 }, count: 2, totalObserved: 2, truncated: false,
        items: [{ id: 'ddr_vm_a', displayName: 'db-a' }, { id: 'ddr_vm_b', displayName: 'db-b' }] }
      : { items: [] }));
  });

  it('confirms only a provider-declared shared backing and keeps native references out of the response', async () => {
    registry.vmHardwareForHost.mockImplementation((_host, vm) => Promise.resolve(hardware('ddh_backing_shared', true)));
    const result = await topology.topologyForHost(host, { database });
    expect(result.coverage.complete).toBe(true);
    expect(result.summary).toEqual({ sharedBackingCount: 1, confirmedCount: 1, reviewCount: 0 });
    expect(result.sharedBackings[0]).toEqual(expect.objectContaining({ state: 'confirmed', consumerCount: 2 }));
    expect(JSON.stringify(result)).not.toContain('native-datastore-should-not-leak');
  });

  it('keeps a common backing in review when shared evidence is absent', async () => {
    registry.vmHardwareForHost.mockImplementation((_host, vm) => Promise.resolve(hardware('ddh_backing_review', vm.id === 'ddr_vm_a')));
    const result = await topology.topologyForHost(host, { database });
    expect(result.summary).toEqual({ sharedBackingCount: 1, confirmedCount: 0, reviewCount: 1 });
    expect(result.sharedBackings[0]).toEqual(expect.objectContaining({ state: 'review' }));
  });

  it('fails closed when the feature is not available', async () => {
    registry.capabilitiesForHost.mockResolvedValue({ probe: { status: 'reachable' }, features: {
      'storage.sharedTopology.read': { state: 'unsupported', reason: 'Not implemented' },
    } });
    await expect(topology.topologyForHost(host, { database })).rejects.toMatchObject({ code: 'STORAGE_TOPOLOGY_UNAVAILABLE' });
  });
});
