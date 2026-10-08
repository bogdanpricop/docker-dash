'use strict';

jest.mock('../services/provider-sdk/registry', () => ({ capabilitiesForHost: jest.fn(), resourcesForHost: jest.fn() }));

const registry = require('../services/provider-sdk/registry');
const posture = require('../services/provider-sdk/network-posture');
const host = { id: 7, daemon_type: 'vsphere', name: 'vcenter' };

describe('Provider network posture', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registry.capabilitiesForHost.mockResolvedValue({ probe: { status: 'reachable' }, features: {
      'network.health.read': { state: 'conditional', reason: 'read-only evidence' },
    } });
  });

  it('keeps absent VLAN and MTU evidence unknown while failing an inaccessible network', async () => {
    registry.resourcesForHost.mockResolvedValue({ provider: { type: 'vsphere', endpointId: 7 }, observedAt: '2026-07-28T17:00:00.000Z', items: [
      { id: 'ddr_network_a', displayName: 'prod', spec: { bridge: 'PG-prod', managed: true, vlanId: 120, mtu: 9000 }, status: { accessible: true } },
      { id: 'ddr_network_b', displayName: 'broken', spec: {}, status: { accessible: false } },
    ] });
    const result = await posture.postureForHost(host);
    expect(result.summary).toEqual({ state: 'fail', networkCount: 2, states: { pass: 1, warning: 0, fail: 1, unknown: 0 } });
    expect(result.networks[1]).toEqual(expect.objectContaining({ state: 'fail' }));
    expect(result.networks[1].signals).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'vlan', state: 'unknown' })]));
  });

  it('fails closed when network posture evidence is not available', async () => {
    registry.capabilitiesForHost.mockResolvedValue({ probe: { status: 'reachable' }, features: {
      'network.health.read': { state: 'unsupported', reason: 'Not released' },
    } });
    await expect(posture.postureForHost(host)).rejects.toMatchObject({ code: 'NETWORK_POSTURE_UNAVAILABLE' });
  });
});
