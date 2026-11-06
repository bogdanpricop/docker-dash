'use strict';

jest.mock('../services/provider-sdk/registry', () => ({ capabilitiesForHost: jest.fn(), resourcesForHost: jest.fn() }));

const registry = require('../services/provider-sdk/registry');
const advisory = require('../services/provider-sdk/storage-policy-advisory');

const host = { id: 7, daemon_type: 'xen', name: 'pool' };

describe('Provider storage policy advisory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registry.capabilitiesForHost.mockResolvedValue({ probe: { status: 'reachable' }, features: {
      'storage.policy.read': { state: 'conditional', reason: 'read-only evidence' },
    } });
  });

  it('marks absent policy evidence unknown rather than compliant', async () => {
    registry.resourcesForHost.mockResolvedValue({ provider: { type: 'xen', endpointId: 7 }, observedAt: '2026-07-28T17:00:00.000Z', items: [
      { id: 'ddr_storage_a', displayName: 'shared', spec: { shared: true }, status: { accessible: true, freeBytes: 200 } },
      { id: 'ddr_storage_b', displayName: 'local', spec: { shared: false }, status: { accessible: true, freeBytes: 200 } },
      { id: 'ddr_storage_c', displayName: 'unknown', spec: {}, status: { accessible: null } },
    ] });
    const result = await advisory.advisoryForHost(host, { minFreeBytes: 100, requireShared: true });
    expect(result.policy).toEqual({ requireAccessible: true, minFreeBytes: 100, requireShared: true });
    expect(result.summary).toEqual({ compliantCount: 1, noncompliantCount: 1, unknownCount: 1 });
    expect(result.storages.map(item => item.state)).toEqual(['compliant', 'noncompliant', 'unknown']);
  });

  it('rejects invalid policy values and unavailable policy evidence', async () => {
    await expect(advisory.advisoryForHost(host, { minFreeBytes: -1 })).rejects.toMatchObject({ code: 'INVALID_MIN_FREE_BYTES' });
    registry.capabilitiesForHost.mockResolvedValue({ probe: { status: 'reachable' }, features: {
      'storage.policy.read': { state: 'unsupported', reason: 'No policy evidence' },
    } });
    await expect(advisory.advisoryForHost(host)).rejects.toMatchObject({ code: 'STORAGE_POLICY_ADVISORY_UNAVAILABLE' });
  });
});
