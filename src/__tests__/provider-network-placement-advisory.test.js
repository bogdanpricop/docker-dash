'use strict';
jest.mock('../services/provider-sdk/registry', () => ({ capabilitiesForHost: jest.fn(), resourcesForHost: jest.fn() }));
const registry = require('../services/provider-sdk/registry'); const advisory = require('../services/provider-sdk/network-placement-advisory');
describe('network placement advisory', () => {
  it('keeps missing management evidence out of candidates', async () => { registry.capabilitiesForHost.mockResolvedValue({ probe: { status: 'reachable' }, features: { 'network.placement.read': { state: 'conditional' } } }); registry.resourcesForHost.mockResolvedValue({ provider: { type: 'vsphere' }, observedAt: '2026-07-28T00:00:00Z', items: [{ id: 'n1', displayName: 'a', status: { accessible: true }, spec: {} }] }); const result = await advisory.advisoryForHost({ id: 7 }); expect(result.summary).toEqual({ candidateCount: 0, blockedCount: 0, unknownCount: 1 }); expect(result.networks[0].state).toBe('unknown'); });
});
