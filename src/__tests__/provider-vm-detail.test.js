'use strict';

const vmDetail = require('../services/provider-sdk/vm-detail');

const VM_ID = `ddr_vm_${'b'.repeat(26)}`;
const host = { id: 7, daemon_type: 'xen' };

function resource(overrides = {}) {
  return {
    schemaVersion: '1.0', kind: 'virtualMachine', id: VM_ID,
    displayName: 'worker-01', observedAt: new Date().toISOString(),
    provider: { type: 'xen', endpointId: 7 },
    identity: { uuid: null, stability: 'derived' },
    labels: { owner: 'platform', runbook: '/runbooks/worker' }, relationships: {},
    spec: { cpuCount: 4, memoryBytes: 8 * 1024 ** 3, guestOS: 'Linux' },
    status: { powerState: 'running', health: 'green', ipAddress: '10.0.0.5' },
    actions: ['shutdown', 'reboot'], extensions: { toolsStatus: 'running' },
    ...overrides,
  };
}

function dependencies(snapshot = resource()) {
  return {
    database: {},
    snapshots: { get: jest.fn(() => snapshot) },
    registry: {
      capabilitiesForHost: jest.fn(async () => ({
        schemaVersion: '1.0', probe: { status: 'reachable' },
        provider: { type: 'xen', endpointId: 7 },
        features: {
          'vm.power.start': { state: 'conditional' },
          'vm.power.shutdown': { state: 'conditional' },
          'vm.power.reboot': { state: 'conditional' },
          'vm.power.force': { state: 'unsupported', reason: 'Forced power is disabled' },
          'vm.snapshot.list': { state: 'conditional', reason: 'Depends on storage' },
          'event.stream': { state: 'unsupported', reason: 'No event stream' },
        },
      })),
      resourcesForHost: jest.fn(async () => ({ items: [resource()] })),
    },
    operations: { list: jest.fn(() => [{ id: `op_${'c'.repeat(26)}`, resource: { id: VM_ID }, state: 'running' }]) },
    policy: { evaluate: jest.fn(() => ({ allowed: true })) },
    canOperate: true,
  };
}

describe('common provider VM detail', () => {
  it('returns a vendor-neutral detail envelope and read-only action explanations', async () => {
    const result = await vmDetail.detailForHost(host, VM_ID, dependencies());
    expect(result).toEqual(expect.objectContaining({ schemaVersion: '1.0', resource: expect.objectContaining({ id: VM_ID }) }));
    expect(result.sections.overview.data.ownership.owner).toBe('platform');
    expect(result.sections.tasks.items).toHaveLength(1);
    expect(result.sections.disks).toEqual(expect.objectContaining({ available: false, items: [] }));
    expect(result.actions.every(action => action.available === false)).toBe(true);
    expect(result.actions.every(action => action.blockers.some(blocker => blocker.type === 'ACTION_NOT_ENABLED'))).toBe(true);
    expect(result.actions.find(action => action.key === 'vm.power.force').blockers)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'CAPABILITY_UNSUPPORTED' })]));
  });

  it('adds permission, policy, resource-state, and resource-action blockers', async () => {
    const deps = dependencies(resource({ status: { powerState: 'stopped', health: 'green' }, actions: [] }));
    deps.canOperate = false;
    deps.policy.evaluate.mockReturnValue({ allowed: false, code: 'OPERATION_FROZEN', mode: 'frozen', reason: 'Change freeze' });
    const result = await vmDetail.detailForHost(host, VM_ID, deps);
    const reboot = result.actions.find(action => action.key === 'vm.power.reboot');
    expect(reboot.blockers.map(blocker => blocker.type)).toEqual(expect.arrayContaining([
      'RESOURCE_STATE_BLOCKED', 'RESOURCE_ACTION_BLOCKED', 'POLICY_BLOCKED', 'PERMISSION_BLOCKED', 'ACTION_NOT_ENABLED',
    ]));
  });

  it('mounts live disk and NIC inventory without exposing provider references', async () => {
    const deps = dependencies();
    deps.registry.vmHardwareForHost = jest.fn(async () => ({
      summary: { diskCount: 1, nicCount: 1, totalDiskCapacityBytes: 1024 },
      disks: [{ id: `ddh_disk_${'a'.repeat(26)}`, label: 'root' }],
      nics: [{ id: `ddh_nic_${'b'.repeat(26)}`, label: 'LAN' }],
      sections: {
        disks: { available: true, warnings: [], truncated: false },
        network: { available: true, warnings: [], truncated: false },
      },
    }));
    const result = await vmDetail.detailForHost(host, VM_ID, deps);
    expect(result.sections.disks).toEqual(expect.objectContaining({ available: true, items: [expect.objectContaining({ label: 'root' })] }));
    expect(result.sections.network).toEqual(expect.objectContaining({ available: true, items: [expect.objectContaining({ label: 'LAN' })] }));
    expect(deps.registry.vmHardwareForHost).toHaveBeenCalledWith(host, expect.objectContaining({ id: VM_ID }), expect.objectContaining({ database: {} }));
  });

  it('projects an explicit vSphere consolidation requirement without inferring one', async () => {
    const needed = resource({ extensions: { consolidationNeeded: true } });
    const required = await vmDetail.detailForHost(host, VM_ID, dependencies(needed));
    expect(required.sections.snapshots.providerState).toEqual({ consolidationNeeded: true });
    const unknown = await vmDetail.detailForHost(host, VM_ID, dependencies(resource()));
    expect(unknown.sections.snapshots.providerState).toEqual({ consolidationNeeded: false });
  });

  it('keeps the rest of VM detail available when live hardware inventory fails', async () => {
    const deps = dependencies();
    deps.registry.vmHardwareForHost = jest.fn(async () => { throw Object.assign(new Error('provider secret'), { code: 'PROVIDER_VM_HARDWARE_READ_FAILED' }); });
    const result = await vmDetail.detailForHost(host, VM_ID, deps);
    expect(result.sections.overview.available).toBe(true);
    expect(result.sections.disks).toEqual(expect.objectContaining({ available: false, reason: expect.stringContaining('could not be read') }));
    expect(JSON.stringify(result)).not.toContain('provider secret');
  });

  it('enables only state-valid power actions after the release gate is enabled', async () => {
    const deps = dependencies();
    deps.powerEnabled = true;
    const result = await vmDetail.detailForHost(host, VM_ID, deps);
    expect(result.actions.find(action => action.action === 'shutdown').available).toBe(true);
    expect(result.actions.find(action => action.action === 'reboot').available).toBe(true);
    expect(result.actions.find(action => action.action === 'start').available).toBe(false);
    expect(result.actions.find(action => action.action === 'forceShutdown').available).toBe(false);
  });

  it('keeps a cached resource when an explicit refresh fails', async () => {
    const cached = resource({ observedAt: new Date(Date.now() - 300_000).toISOString() });
    const deps = dependencies(cached);
    deps.refresh = true;
    deps.registry.resourcesForHost.mockRejectedValue(Object.assign(new Error('offline secret'), { code: 'PROVIDER_UNREACHABLE' }));
    const result = await vmDetail.detailForHost(host, VM_ID, deps);
    expect(result.resource.id).toBe(VM_ID);
    expect(result.freshness).toEqual(expect.objectContaining({
      state: 'stale', refreshError: { code: 'PROVIDER_UNREACHABLE', message: expect.stringContaining('cached data') },
    }));
    expect(JSON.stringify(result)).not.toContain('offline secret');
  });

  it('refreshes on a cache miss and returns 404 without cross-host disclosure', async () => {
    const deps = dependencies(null);
    const result = await vmDetail.detailForHost(host, VM_ID, deps);
    expect(result.resource.id).toBe(VM_ID);
    expect(deps.registry.resourcesForHost).toHaveBeenCalledWith(host, 'virtual-machines', { limit: 500, database: {} });
    deps.registry.resourcesForHost.mockResolvedValue({ items: [] });
    await expect(vmDetail.detailForHost(host, VM_ID, deps)).rejects.toMatchObject({
      status: 404, code: 'PROVIDER_VM_NOT_FOUND',
    });
  });

  it('rejects malformed canonical IDs as not found', async () => {
    await expect(vmDetail.detailForHost(host, 'OpaqueRef:secret', dependencies()))
      .rejects.toMatchObject({ status: 404, code: 'PROVIDER_VM_NOT_FOUND' });
  });
});
