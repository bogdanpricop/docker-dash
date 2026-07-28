'use strict';

jest.mock('../services/provider-sdk/registry', () => ({
  capabilitiesForHost: jest.fn(), resourcesForHost: jest.fn(),
}));

const registry = require('../services/provider-sdk/registry');
const posture = require('../services/provider-sdk/storage-posture');

const capability = state => ({ state, reason: state === 'unsupported' ? 'Not implemented' : null });
const host = { id: 7, daemon_type: 'vsphere', name: 'vcenter' };

describe('Provider storage posture', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registry.capabilitiesForHost.mockResolvedValue({
      probe: { status: 'reachable' },
      features: {
        'storage.health.read': capability('conditional'),
        'storage.policy.read': capability('conditional'),
        'storage.qos.read': capability('unsupported'),
        'storage.multipath.read': capability('unsupported'),
      },
    });
  });

  it('flags inaccessible and critically full storage without treating absent telemetry as healthy', () => {
    const item = {
      id: `ddr_storage_${'a'.repeat(26)}`, displayName: 'prod-vsan', observedAt: '2026-07-28T10:00:00.000Z',
      spec: { type: 'vsan', capacityBytes: 1000, shared: true },
      status: { usedBytes: 970, freeBytes: 30, accessible: false, maintenanceMode: 'inMaintenance' }, extensions: {},
    };
    const result = posture.assessStorage(item, { features: {
      'storage.qos.read': capability('unsupported'), 'storage.multipath.read': capability('unsupported'),
    } });
    expect(result.state).toBe('fail');
    expect(result.usedPercent).toBe(97);
    expect(result.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'accessibility', state: 'fail' }),
      expect.objectContaining({ key: 'capacity', state: 'fail' }),
      expect.objectContaining({ key: 'qos', state: 'unknown' }),
      expect.objectContaining({ key: 'multipath', state: 'unknown' }),
    ]));
  });

  it('reports overcommit as a warning and preserves a healthy capacity observation', () => {
    const result = posture.assessStorage({
      id: `ddr_storage_${'b'.repeat(26)}`, displayName: 'thin', observedAt: '2026-07-28T10:00:00.000Z',
      spec: { type: 'lvmthin', capacityBytes: 1000, shared: false },
      status: { usedBytes: 400, freeBytes: 600, accessible: true, maintenanceMode: 'normal' },
      extensions: { virtualAllocationBytes: 1200 },
    }, { features: {} });
    expect(result.state).toBe('warning');
    expect(result.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'capacity', state: 'pass' }),
      expect.objectContaining({ key: 'overcommit', state: 'warning' }),
    ]));
  });

  it('uses normalized live inventory and blocks providers without health capability', async () => {
    registry.resourcesForHost.mockResolvedValue({
      provider: { type: 'vsphere', endpointId: 7 }, observedAt: '2026-07-28T10:00:00.000Z', items: [{
        id: `ddr_storage_${'c'.repeat(26)}`, displayName: 'ds1', observedAt: '2026-07-28T10:00:00.000Z',
        spec: { capacityBytes: 1000 }, status: { usedBytes: 100, freeBytes: 900, accessible: true }, extensions: {},
      }],
    });
    const result = await posture.postureForHost(host);
    expect(result.summary).toEqual(expect.objectContaining({ state: 'pass', storageCount: 1, freeBytes: 900 }));
    expect(registry.resourcesForHost).toHaveBeenCalledWith(host, 'storage', expect.objectContaining({ limit: 500 }));

    registry.capabilitiesForHost.mockResolvedValue({ probe: { status: 'reachable' }, features: {
      'storage.health.read': capability('unsupported'),
    } });
    await expect(posture.postureForHost(host)).rejects.toMatchObject({ code: 'STORAGE_POSTURE_UNAVAILABLE', status: 400 });
  });
});
