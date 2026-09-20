'use strict';

const mockBasePreflight = jest.fn();
const mockResolveCanonical = jest.fn();

jest.mock('../config', () => ({ features: { providerVmMigration: false } }));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must inject database'); }) }));
jest.mock('../services/provider-sdk/vm-migration-preflight', () => ({
  preflightForHost: (...args) => mockBasePreflight(...args),
}));
jest.mock('../services/provider-sdk/identity-store', () => ({
  resolveCanonical: (...args) => mockResolveCanonical(...args),
}));
jest.mock('../services/provider-sdk/registry', () => ({}));
jest.mock('../services/provider-operations/index', () => ({ list: jest.fn(() => []), create: jest.fn() }));
jest.mock('../services/provider-operations/policy', () => ({}));

const migration = require('../services/provider-operations/vm-migration');

const VM_ID = `ddr_vm_${'a'.repeat(26)}`;
const SOURCE_ID = `ddr_host_${'b'.repeat(26)}`;
const TARGET_ID = `ddr_host_${'c'.repeat(26)}`;
const STORAGE_ID = `ddr_storage_${'d'.repeat(26)}`;

function base(modeState = 'ready') {
  return {
    schemaVersion: '1.0', planHash: '1'.repeat(64),
    provider: { type: 'proxmox', endpointId: 7 },
    vm: { id: VM_ID, displayName: 'app-01', powerState: 'running' },
    sourceTargetId: SOURCE_ID, warnings: [], capabilityMatrix: {},
    candidates: [{
      target: { id: TARGET_ID, displayName: 'pve-b', status: { powerState: 'running' } },
      modes: {
        live: { state: modeState, blockers: modeState === 'ready' ? [] : [{ type: 'BLOCKED', reason: 'not ready' }], warnings: [], estimate: {} },
        cold: { state: 'blocked', blockers: [{ type: 'POWER_STATE_BLOCKED', reason: 'stop first' }], warnings: [], estimate: {} },
        storage: { state: 'ready', blockers: [], warnings: [], estimate: {} },
      },
    }],
  };
}

function dependencies(provider = 'proxmox') {
  const operations = { list: jest.fn(() => []), create: jest.fn(input => ({ id: `op_${'e'.repeat(26)}`, input })) };
  const registry = {
    capabilitiesForHost: jest.fn(async () => ({ features: { 'vm.migrate': { state: 'conditional' } } })),
    resourcesForHost: jest.fn(async () => ({ items: [{
      id: STORAGE_ID, displayName: 'fast', spec: { type: 'zfs', shared: false },
      status: { accessible: true, freeBytes: 1024 },
    }] })),
  };
  return {
    enabled: true, canOperate: true, createdBy: 9, operations, registry, database: {},
    policy: { evaluate: jest.fn(() => ({ allowed: true })) },
    host: { id: 7, name: 'cluster-a', daemon_type: provider },
  };
}

describe('native VM migration plan and submission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBasePreflight.mockResolvedValue(base());
    mockResolveCanonical.mockReturnValue({ providerType: 'proxmox', nativeRef: 'stable', stability: 'derived' });
  });

  it('builds a typed, hashed same-endpoint live migration plan', async () => {
    const deps = dependencies();
    const plan = await migration.preflightForHost(deps.host, VM_ID, { targetId: TARGET_ID, mode: 'live' }, deps);
    expect(plan).toEqual(expect.objectContaining({
      allowed: true, mode: 'live', sourceTargetId: SOURCE_ID,
      expectedPowerState: 'running', planHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      confirmation: { required: true, mode: 'typed_name', expected: 'app-01' },
    }));
    expect(plan.scope).toEqual({ sameEndpointOnly: true, crossProvider: false });
  });

  it('fails closed for release, permission, policy, conflict and unstable identity gates', async () => {
    const deps = dependencies();
    deps.enabled = false; deps.canOperate = false;
    deps.policy.evaluate.mockReturnValue({ allowed: false, code: 'OPERATION_FROZEN', reason: 'freeze' });
    deps.operations.list.mockReturnValue([{ state: 'running', resource: { id: VM_ID } }]);
    mockResolveCanonical.mockReturnValue({ providerType: 'proxmox', nativeRef: 'x', stability: 'transient' });
    const plan = await migration.preflightForHost(deps.host, VM_ID, { targetId: TARGET_ID, mode: 'live' }, deps);
    expect(plan.allowed).toBe(false);
    expect(plan.blockers.map(item => item.type)).toEqual(expect.arrayContaining([
      'RELEASE_DISABLED', 'PERMISSION_DENIED', 'OPERATION_FROZEN',
      'ACTIVE_OPERATION_CONFLICT', 'UNSTABLE_PROVIDER_IDENTITY',
    ]));
  });

  it('requires vSphere datastore selection and blocks XAPI storage remapping', async () => {
    const vsphere = dependencies('vsphere');
    mockResolveCanonical.mockReturnValue({ providerType: 'vsphere', nativeRef: 'stable', stability: 'derived' });
    let plan = await migration.preflightForHost(vsphere.host, VM_ID, { targetId: TARGET_ID, mode: 'storage' }, vsphere);
    expect(plan.blockers.map(item => item.type)).toContain('TARGET_STORAGE_REQUIRED');
    plan = await migration.preflightForHost(vsphere.host, VM_ID, {
      targetId: TARGET_ID, mode: 'storage', targetStorageId: STORAGE_ID,
    }, vsphere);
    expect(plan.targetStorage).toEqual(expect.objectContaining({ id: STORAGE_ID, displayName: 'fast' }));

    const xen = dependencies('xen');
    mockResolveCanonical.mockReturnValue({ providerType: 'xen', nativeRef: 'stable', stability: 'derived' });
    plan = await migration.preflightForHost(xen.host, VM_ID, { targetId: TARGET_ID, mode: 'storage' }, xen);
    expect(plan.blockers.map(item => item.type)).toContain('STORAGE_MAPPING_UNSUPPORTED');
  });

  it('rejects stale or mistyped confirmation and creates one locked durable operation', async () => {
    const deps = dependencies();
    const plan = await migration.preflightForHost(deps.host, VM_ID, { targetId: TARGET_ID, mode: 'live' }, deps);
    await expect(migration.submitForHost(deps.host, VM_ID, {
      targetId: TARGET_ID, mode: 'live', planHash: '0'.repeat(64), confirm: true,
      confirmName: 'app-01', idempotencyKey: 'migration-one',
    }, deps)).rejects.toMatchObject({ code: 'VM_MIGRATION_PREFLIGHT_STALE', status: 409 });
    await expect(migration.submitForHost(deps.host, VM_ID, {
      targetId: TARGET_ID, mode: 'live', planHash: plan.planHash, confirm: true,
      confirmName: 'wrong', idempotencyKey: 'migration-two',
    }, deps)).rejects.toMatchObject({ code: 'VM_MIGRATION_TYPED_CONFIRMATION_REQUIRED' });
    const result = await migration.submitForHost(deps.host, VM_ID, {
      targetId: TARGET_ID, mode: 'live', planHash: plan.planHash, confirm: true,
      confirmName: 'app-01', idempotencyKey: 'migration-three',
    }, deps);
    expect(result.operation.id).toMatch(/^op_/);
    expect(deps.operations.create).toHaveBeenCalledWith(expect.objectContaining({
      type: 'vm.migrate', action: 'live', resourceId: VM_ID,
      idempotencyKey: 'migration-three',
      lockScopes: [`resource:${VM_ID}`, `resource:${TARGET_ID}`],
    }));
  });
});
