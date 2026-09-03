'use strict';
jest.mock('../services/provider-sdk/registry', () => ({ capabilitiesForHost: jest.fn(), resourcesForHost: jest.fn(), vmHardwareForHost: jest.fn() }));
const registry = require('../services/provider-sdk/registry'); const topology = require('../services/provider-sdk/network-attachment-topology');
const host = { id: 7, daemon_type: 'vsphere' };
describe('network attachment topology', () => {
  beforeEach(() => { jest.clearAllMocks(); registry.capabilitiesForHost.mockResolvedValue({ probe: { status: 'reachable' }, features: { 'network.attachmentTopology.read': { state: 'conditional' } } }); });
  it('returns opaque network groups and marks failed VM NIC reads as partial coverage', async () => {
    registry.resourcesForHost.mockResolvedValue({ provider: { type: 'vsphere' }, count: 2, totalObserved: 2, truncated: false, items: [{ id: 'vm1', displayName: 'one' }, { id: 'vm2', displayName: 'two' }] });
    registry.vmHardwareForHost.mockResolvedValueOnce({ sections: { network: { available: true, truncated: false } }, nics: [{ id: 'nic1', label: 'NIC 1', macAddress: '00:11:22:33:44:55', network: { id: 'native-secret', name: 'Production' }, attachment: { connected: true }, addresses: [] }] }).mockRejectedValueOnce(new Error('unavailable'));
    const result = await topology.topologyForHost(host);
    expect(result.coverage).toEqual(expect.objectContaining({ hardwareUnavailable: 1, complete: false }));
    expect(result.networks[0]).toEqual(expect.objectContaining({ displayName: 'Production', consumerCount: 1, connectedCount: 1 }));
    expect(result.networks[0].id).toMatch(/^ddn_net_/); expect(JSON.stringify(result)).not.toContain('native-secret');
  });
});
