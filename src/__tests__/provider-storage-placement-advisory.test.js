'use strict';

jest.mock('../services/provider-sdk/registry', () => ({ capabilitiesForHost: jest.fn(), resourcesForHost: jest.fn() }));
jest.mock('../config', () => ({ providerVmDisks: { capacityHeadroomPercent: 10 } }));

const registry = require('../services/provider-sdk/registry');
const advisory = require('../services/provider-sdk/storage-placement-advisory');

const host = { id: 7, daemon_type: 'proxmox', name: 'pve' };
const capability = { probe: { status: 'reachable' }, features: {
  'storage.placement.read': { state: 'conditional', reason: 'read-only' },
} };

describe('Provider storage placement advisory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registry.capabilitiesForHost.mockResolvedValue(capability);
  });

  it('returns only proven capacity/content candidates and does not reserve them', async () => {
    registry.resourcesForHost.mockResolvedValue({ provider: { type: 'proxmox', endpointId: 7 }, observedAt: '2026-07-28T16:00:00.000Z', items: [
      { id: 'ddr_storage_fast', displayName: 'fast', spec: { type: 'zfs' }, status: { accessible: true, maintenanceMode: 'normal', freeBytes: 2 * 1024 * 1024 * 1024 }, extensions: { contentType: 'images' } },
      { id: 'ddr_storage_iso', displayName: 'iso', spec: { type: 'dir' }, status: { accessible: true, maintenanceMode: 'normal', freeBytes: 2 * 1024 * 1024 * 1024 }, extensions: { contentType: 'iso' } },
      { id: 'ddr_storage_unknown', displayName: 'unknown', spec: {}, status: { accessible: true }, extensions: {} },
    ] });
    const requestedBytes = 1024 * 1024 * 1024;
    const result = await advisory.advisoryForHost(host, { requestedBytes });
    expect(result.requested).toEqual({ bytes: requestedBytes, headroomPercent: 10, requiredBytes: 1181116007 });
    expect(result.summary).toEqual({ candidateCount: 1, blockedCount: 1, unknownCount: 1 });
    expect(result.storages.map(item => item.state)).toEqual(['candidate', 'blocked', 'unknown']);
    expect(result.limitations.join(' ')).toContain('not a capacity reservation');
  });

  it('rejects invalid size and unavailable provider capability', async () => {
    await expect(advisory.advisoryForHost(host, { requestedBytes: 1 })).rejects.toMatchObject({ code: 'INVALID_REQUESTED_BYTES' });
    registry.capabilitiesForHost.mockResolvedValue({ probe: { status: 'reachable' }, features: {
      'storage.placement.read': { state: 'unsupported', reason: 'No evidence' },
    } });
    await expect(advisory.advisoryForHost(host, { requestedBytes: 64 * 1024 * 1024 })).rejects.toMatchObject({ code: 'STORAGE_PLACEMENT_ADVISORY_UNAVAILABLE' });
  });
});
