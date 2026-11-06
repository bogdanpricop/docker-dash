'use strict';
jest.mock('../services/provider-sdk/registry', () => ({ capabilitiesForHost: jest.fn(), resourcesForHost: jest.fn() }));
const registry = require('../services/provider-sdk/registry'); const advisory = require('../services/provider-sdk/network-policy-advisory');
const host = { id: 7, daemon_type: 'vsphere' };
describe('network policy advisory', () => {
  beforeEach(() => { jest.clearAllMocks(); registry.capabilitiesForHost.mockResolvedValue({ probe: { status: 'reachable' }, features: { 'network.policy.read': { state: 'conditional' } } }); });
  it('keeps absent VLAN evidence unknown', async () => { registry.resourcesForHost.mockResolvedValue({ provider: { type: 'vsphere' }, items: [{ id: 'n1', displayName: 'a', spec: { managed: true, mtu: 1500 }, status: { accessible: true } }, { id: 'n2', displayName: 'b', spec: { managed: false, vlanId: 10, mtu: 1400 }, status: { accessible: true } }] }); const result = await advisory.advisoryForHost(host, { requireManaged: true, requireVlan: true, minMtu: 1500 }); expect(result.summary).toEqual({ compliantCount: 0, noncompliantCount: 1, unknownCount: 1 }); });
});
