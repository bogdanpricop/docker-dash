'use strict';

jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must provide its database'); }) }));

const migration = require('../services/provider-sdk/vm-migration-preflight');

const VM_ID = `ddr_vm_${'a'.repeat(26)}`;
const TARGET_A = `ddr_host_${'b'.repeat(26)}`;
const TARGET_B = `ddr_host_${'c'.repeat(26)}`;
const host = { id: 7, name: 'pool-a', daemon_type: 'xen' };
const vm = {
  kind: 'virtualMachine', id: VM_ID, displayName: 'app-01', provider: { type: 'xen', endpointId: 7 },
  spec: { memoryBytes: 8 * 1024 ** 3 }, status: { powerState: 'running' },
};
const targets = [{
  kind: 'host', id: TARGET_A, displayName: 'xen-a', provider: { type: 'xen', endpointId: 7 },
  status: { powerState: 'running', enabled: true, maintenanceMode: 'normal', memoryFreeBytes: 32 * 1024 ** 3 },
}, {
  kind: 'host', id: TARGET_B, displayName: 'xen-b', provider: { type: 'xen', endpointId: 7 },
  status: { powerState: 'running', enabled: true, maintenanceMode: 'maintenance', memoryFreeBytes: 4 * 1024 ** 3 },
}];

function fixture(overrides = {}) {
  const capabilities = {
    features: {
      'vm.migration.preflight': { state: 'conditional', reason: 'read-only' },
      'vm.migration.live': { state: 'conditional', reason: 'per target' },
      'vm.migration.cold': { state: 'conditional', reason: 'per target' },
      'vm.migration.storage': { state: 'conditional', reason: 'per target' },
      'vm.migration.crossCluster': { state: 'unsupported', reason: 'same endpoint only' },
    },
  };
  const registry = {
    capabilitiesForHost: jest.fn().mockResolvedValue(capabilities),
    resourcesForHost: jest.fn(async (_host, kind) => kind === 'virtual-machines'
      ? { items: [vm] } : { items: targets }),
    vmHardwareForHost: jest.fn().mockResolvedValue({ summary: { totalDiskAllocatedBytes: 25 * 1024 ** 3 } }),
    migrationCompatibilityForHost: jest.fn().mockResolvedValue({
      sourceTargetId: null,
      candidates: [{
        targetId: TARGET_A, current: false, blockers: [], warnings: [],
        checks: [{ key: 'xapi.assertCanBootHere', state: 'pass', reason: 'XAPI accepted target', confidence: 'high' }],
        modes: { live: 'conditional', cold: 'conditional', storage: 'unknown' },
      }, {
        targetId: TARGET_B, current: false, blockers: [], warnings: [], checks: [],
        modes: { live: 'conditional', cold: 'conditional', storage: 'unknown' },
      }],
      warnings: [],
    }),
  };
  return { capabilities, registry, snapshots: { get: jest.fn().mockReturnValue(null) }, ...overrides };
}

describe('read-only VM migration preflight contract', () => {
  it('scores ready candidates and blocks maintenance/capacity failures without exposing native refs', async () => {
    const options = fixture();
    const result = await migration.preflightForHost(host, VM_ID, { database: {}, ...options });
    expect(result.scope).toEqual(expect.objectContaining({
      sameEndpointOnly: true, crossProvider: false, executionEnabled: false, maxTargets: 64,
    }));
    expect(result.candidates[0]).toEqual(expect.objectContaining({ target: expect.objectContaining({ id: TARGET_A }), eligible: true }));
    const blocked = result.candidates.find(candidate => candidate.target.id === TARGET_B);
    expect(blocked.modes.live.state).toBe('blocked');
    expect(blocked.modes.live.blockers.map(item => item.type)).toEqual(expect.arrayContaining([
      'TARGET_MAINTENANCE', 'INSUFFICIENT_MEMORY',
    ]));
    expect(result.capabilityMatrix.crossCluster.state).toBe('unsupported');
    expect(result.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toMatch(/OpaqueRef:|nativeRef/);
  });

  it('keeps missing provider evidence unknown instead of claiming support', async () => {
    const options = fixture();
    options.registry.migrationCompatibilityForHost.mockRejectedValue(Object.assign(new Error('read failed'), {
      code: 'PROVIDER_MIGRATION_PREFLIGHT_READ_FAILED',
    }));
    const result = await migration.preflightForHost(host, VM_ID, { database: {}, ...options });
    const candidate = result.candidates.find(item => item.target.id === TARGET_A);
    expect(candidate.modes.live.state).toBe('unknown');
    expect(result.warnings).toContain('Live provider compatibility checks could not be completed');
  });

  it('rejects non-canonical VM IDs before any provider access', async () => {
    const options = fixture();
    await expect(migration.preflightForHost(host, 'OpaqueRef:vm-secret', { database: {}, ...options }))
      .rejects.toEqual(expect.objectContaining({ code: 'PROVIDER_VM_NOT_FOUND', status: 404 }));
    expect(options.registry.capabilitiesForHost).not.toHaveBeenCalled();
  });

  it('blocks targets reserved by an active host maintenance run', async () => {
    const options = fixture();
    const database = {
      prepare: jest.fn(() => ({ all: jest.fn(() => [{ source_host_id: TARGET_A }]) })),
    };
    const result = await migration.preflightForHost(host, VM_ID, { database, ...options });
    const candidate = result.candidates.find(item => item.target.id === TARGET_A);
    expect(candidate.modes.live.state).toBe('blocked');
    expect(candidate.modes.live.blockers.map(item => item.type)).toContain('TARGET_MAINTENANCE_RESERVED');
    expect(candidate.checks).toContainEqual(expect.objectContaining({ key: 'target.maintenanceReservation', state: 'fail' }));
  });
});
