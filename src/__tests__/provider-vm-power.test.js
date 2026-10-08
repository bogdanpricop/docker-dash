'use strict';

jest.mock('../config', () => ({ features: { providerVmPower: false } }));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must inject database'); }) }));
jest.mock('../services/provider-operations/index', () => ({
  list: jest.fn(() => []), create: jest.fn(),
}));
jest.mock('../services/provider-sdk/registry', () => ({}));
jest.mock('../services/provider-operations/policy', () => ({}));
jest.mock('../services/provider-operations/handlers/vm-power', () => ({ TYPE: 'vm.power' }));

const power = require('../services/provider-operations/vm-power');

const VM_A = `ddr_vm_${'a'.repeat(26)}`;
const VM_B = `ddr_vm_${'b'.repeat(26)}`;
const host = { id: 7, daemon_type: 'xen' };

function vm(id = VM_A, overrides = {}) {
  return {
    id, displayName: id === VM_A ? 'worker-a' : 'worker-b',
    status: { powerState: 'stopped' }, actions: ['start'],
    identity: { stability: 'stable' },
    ...overrides,
  };
}

function dependencies(resources = [vm()]) {
  const operations = { list: jest.fn(() => []), create: jest.fn(input => ({ id: `op_${input.resourceId.slice(-26)}` })) };
  return {
    enabled: true, canOperate: true, createdBy: 1,
    registry: {
      resourcesForHost: jest.fn(async () => ({ items: resources })),
      capabilitiesForHost: jest.fn(async () => ({
        features: {
          'vm.power.start': { state: 'conditional' },
          'vm.power.shutdown': { state: 'conditional' },
          'vm.power.reboot': { state: 'conditional' },
          'vm.power.force': { state: 'conditional' },
        },
      })),
    },
    operations,
    policy: { evaluate: jest.fn(() => ({ allowed: true, mode: 'normal', code: null, reason: null })) },
    database: { transaction: fn => fn },
  };
}

describe('safe VM power preflight and submission', () => {
  it('builds a bounded, hashed and state-aware plan', async () => {
    const deps = dependencies();
    const plan = await power.preflightForHost(host, VM_A, 'start', deps);
    expect(plan).toEqual(expect.objectContaining({
      schemaVersion: '1.0', allowed: true, action: 'start',
      currentPowerState: 'stopped', expectedPowerState: 'running', planHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(Date.parse(plan.validUntil)).toBeGreaterThan(Date.now());
    expect(plan.confirmation).toEqual({ required: true, mode: 'explicit' });
  });

  it('returns explicit release, permission, policy, state and conflict blockers', async () => {
    const deps = dependencies([vm(VM_A, { status: { powerState: 'running' }, actions: [], identity: { stability: 'transient' } })]);
    deps.enabled = false;
    deps.canOperate = false;
    deps.policy.evaluate.mockReturnValue({ allowed: false, mode: 'frozen', code: 'OPERATION_FROZEN', reason: 'Change freeze' });
    deps.operations.list.mockReturnValue([{ id: `op_${'c'.repeat(26)}`, state: 'running', resource: { id: VM_A } }]);
    const plan = await power.preflightForHost(host, VM_A, 'start', deps);
    expect(plan.allowed).toBe(false);
    expect(plan.blockers.map(item => item.type)).toEqual(expect.arrayContaining([
      'RELEASE_DISABLED', 'PERMISSION_BLOCKED', 'POLICY_BLOCKED',
      'RESOURCE_STATE_BLOCKED', 'RESOURCE_ACTION_BLOCKED', 'OPERATION_CONFLICT',
      'UNSTABLE_RESOURCE_IDENTITY',
    ]));
  });

  it('requires the exact current plan hash and explicit confirmation', async () => {
    const deps = dependencies();
    const plan = await power.preflightForHost(host, VM_A, 'start', deps);
    await expect(power.submitForHost(host, VM_A, {
      action: 'start', planHash: '0'.repeat(64), confirm: true, idempotencyKey: 'power-request-one',
    }, deps)).rejects.toMatchObject({ code: 'VM_POWER_PREFLIGHT_STALE', status: 409 });
    await expect(power.submitForHost(host, VM_A, {
      action: 'start', planHash: plan.planHash, confirm: false, idempotencyKey: 'power-request-two',
    }, deps)).rejects.toMatchObject({ code: 'VM_POWER_CONFIRMATION_REQUIRED' });

    const submitted = await power.submitForHost(host, VM_A, {
      action: 'start', planHash: plan.planHash, confirm: true, idempotencyKey: 'power-request-three',
    }, deps);
    expect(submitted.operation.id).toMatch(/^op_/);
    expect(deps.operations.create).toHaveBeenCalledWith(expect.objectContaining({
      type: 'vm.power', action: 'start', resourceId: VM_A,
      idempotencyKey: 'power-request-three', lockScopes: [`resource:${VM_A}`],
    }));
  });

  it('requires typed names for force and creates an all-or-nothing bulk batch', async () => {
    const resources = [VM_A, VM_B].map(id => vm(id, {
      status: { powerState: 'running' }, actions: ['forceShutdown'],
    }));
    const deps = dependencies(resources);
    const preflight = await power.preflightManyForHost(host, [VM_A, VM_B], 'forceShutdown', deps);
    await expect(power.submitManyForHost(host, [VM_A, VM_B], {
      action: 'forceShutdown', confirm: true, plans: Object.fromEntries(preflight.plans.map(plan => [plan.resource.id, plan.planHash])),
      confirmNames: { [VM_A]: 'wrong', [VM_B]: 'worker-b' }, idempotencyKey: 'bulk-force-request',
    }, deps)).rejects.toMatchObject({ code: 'VM_POWER_TYPED_CONFIRMATION_REQUIRED' });
    expect(deps.operations.create).not.toHaveBeenCalled();

    const result = await power.submitManyForHost(host, [VM_A, VM_B], {
      action: 'forceShutdown', confirm: true, plans: Object.fromEntries(preflight.plans.map(plan => [plan.resource.id, plan.planHash])),
      confirmNames: { [VM_A]: 'worker-a', [VM_B]: 'worker-b' }, idempotencyKey: 'bulk-force-request',
    }, deps);
    expect(result.operations).toHaveLength(2);
    expect(deps.operations.create).toHaveBeenCalledTimes(2);
    expect(deps.operations.create.mock.calls.map(call => call[0].idempotencyKey))
      .toEqual([`bulk-force-request:${VM_A}`, `bulk-force-request:${VM_B}`]);
  });

  it('blocks an entire bulk request when any resource is missing', async () => {
    const deps = dependencies([vm(VM_A)]);
    const preflight = await power.preflightManyForHost(host, [VM_A, VM_B], 'start', deps);
    expect(preflight.allowed).toBe(false);
    expect(preflight.plans.find(plan => plan.resource.id === VM_B).blockers[0].type).toBe('RESOURCE_NOT_FOUND');
    await expect(power.submitManyForHost(host, [VM_A, VM_B], {
      action: 'start', confirm: true,
      plans: Object.fromEntries(preflight.plans.map(plan => [plan.resource.id, plan.planHash])),
      idempotencyKey: 'bulk-missing-vm',
    }, deps)).rejects.toMatchObject({ code: 'VM_POWER_PREFLIGHT_BLOCKED' });
    expect(deps.operations.create).not.toHaveBeenCalled();
  });
});
