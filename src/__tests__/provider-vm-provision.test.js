'use strict';

jest.mock('../config', () => ({ features: { providerVmProvisioning: false, providerVmGuestCustomization: false } }));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must inject database'); }) }));
jest.mock('../services/provider-operations/index', () => ({ list: jest.fn(() => []), create: jest.fn() }));
jest.mock('../services/provider-sdk/registry', () => ({}));
jest.mock('../services/provider-operations/policy', () => ({}));
jest.mock('../services/provider-operations/handlers/vm-provision', () => ({ TYPE: 'vm.provision' }));

const service = require('../services/provider-operations/vm-provision');

const ARTIFACT_ID = `dda_art_${'a'.repeat(26)}`;
const STORAGE_ID = `ddr_storage_${'b'.repeat(26)}`;
const host = { id: 7, daemon_type: 'xen' };

function dependencies(overrides = {}) {
  const artifact = {
    id: ARTIFACT_ID, kind: 'vmTemplate', displayName: 'Debian Gold',
    identity: { stability: 'stable' }, provenance: { pool: 'main' }, spec: { cpuCount: 2 },
  };
  const storage = {
    id: STORAGE_ID, displayName: 'Shared SR', spec: { type: 'lvm' },
    status: { freeBytes: 1000, accessible: true },
  };
  const operations = {
    list: jest.fn(() => overrides.active || []),
    create: jest.fn(input => ({ id: `op_${'c'.repeat(26)}`, ...input })),
  };
  return {
    enabled: overrides.enabled ?? true, guestCustomizationEnabled: overrides.guestCustomizationEnabled ?? true,
    canOperate: overrides.canOperate ?? true,
    database: {}, operations, createdBy: 9,
    policy: { evaluate: jest.fn(() => overrides.policy || { allowed: true, code: null, mode: 'active', reason: null }) },
    registry: {
      artifactsForHost: jest.fn(async () => ({ items: [artifact] })),
      resourcesForHost: jest.fn(async (_host, kind) => kind === 'virtual-machines'
        ? { items: overrides.vms || [] } : { items: [storage] }),
      capabilitiesForHost: jest.fn(async () => ({
        provider: { variant: overrides.variant || 'xapi' },
        features: {
          'vm.create': overrides.capability || { state: 'conditional', reason: 'live validation' },
          'vm.guestCustomize': overrides.customizationCapability || { state: 'unsupported', reason: 'not available' },
        },
      })),
    },
  };
}

describe('common create-from-template plans and submission', () => {
  it('builds a typed-confirmation XAPI linked-clone plan with storage candidates', async () => {
    const deps = dependencies();
    const plan = await service.preflightForHost(host, ARTIFACT_ID, {
      name: 'app-01', mode: 'auto', storageId: STORAGE_ID,
    }, deps);
    expect(plan).toEqual(expect.objectContaining({
      allowed: true, name: 'app-01', mode: { requested: 'auto', effective: 'linked' },
      confirmation: { required: true, mode: 'typed_name', expected: 'app-01' },
      planHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(plan.placement.candidates).toContainEqual(expect.objectContaining({ id: STORAGE_ID, displayName: 'Shared SR' }));
    expect(plan.warnings).toContainEqual(expect.objectContaining({ type: 'LINKED_CLONE_DEPENDENCY' }));
  });

  it('fails closed on release, permission, policy, capability and conflicts', async () => {
    const deps = dependencies({
      enabled: false, canOperate: false, variant: 'xo', capability: { state: 'unsupported', reason: 'not exposed' },
      vms: [{ displayName: 'app-01' }],
      active: [{ id: `op_${'d'.repeat(26)}`, state: 'running', resource: { id: ARTIFACT_ID } }],
      policy: { allowed: false, code: 'CHANGE_FREEZE', mode: 'frozen', reason: 'freeze' },
    });
    const plan = await service.preflightForHost(host, ARTIFACT_ID, { name: 'app-01', mode: 'full' }, deps);
    expect(plan.allowed).toBe(false);
    expect(plan.blockers.map(item => item.type)).toEqual(expect.arrayContaining([
      'RELEASE_DISABLED', 'PERMISSION_BLOCKED', 'POLICY_BLOCKED', 'CAPABILITY_UNSUPPORTED',
      'OPERATION_CONFLICT', 'VM_NAME_CONFLICT',
    ]));
  });

  it('submits one non-idempotent artifact operation only after an exact fresh plan', async () => {
    const deps = dependencies();
    const plan = await service.preflightForHost(host, ARTIFACT_ID, { name: 'app-01', mode: 'linked' }, deps);
    await expect(service.submitForHost(host, ARTIFACT_ID, {
      name: 'app-01', mode: 'linked', planHash: '0'.repeat(64), confirm: true,
      confirmName: 'app-01', idempotencyKey: 'provision-app-01',
    }, deps)).rejects.toMatchObject({ code: 'VM_PROVISION_PREFLIGHT_STALE' });
    const result = await service.submitForHost(host, ARTIFACT_ID, {
      name: 'app-01', mode: 'linked', planHash: plan.planHash, confirm: true,
      confirmName: 'app-01', idempotencyKey: 'provision-app-01',
    }, deps);
    expect(result.operation.type).toBe('vm.provision');
    expect(deps.operations.create).toHaveBeenCalledWith(expect.objectContaining({
      resourceKind: 'artifact', resourceId: ARTIFACT_ID, action: 'clone',
      request: expect.objectContaining({ name: 'app-01', mode: 'linked', startAfterCreate: false }),
      lockScopes: expect.arrayContaining([`resource:${ARTIFACT_ID}`, expect.stringMatching(/^provider-name:[a-f0-9]{32}$/)]),
    }));
  });

  it('plans and submits supported Xen Orchestra cloud-init without exposing raw fields in the plan', async () => {
    const deps = dependencies({
      variant: 'xo', customizationCapability: { state: 'conditional', reason: 'XO create_vm cloud config' },
    });
    const request = {
      name: 'app-01', mode: 'full', customization: {
        hostname: 'app-01', domain: 'example.internal', timezone: 'Europe/Bucharest', user: 'deploy',
        network: { mode: 'static', address: '192.0.2.10/24', gateway: '192.0.2.1', dnsServers: ['1.1.1.1'] },
      },
    };
    const plan = await service.preflightForHost(host, ARTIFACT_ID, request, deps);
    expect(plan.allowed).toBe(true);
    expect(plan.customization).toMatchObject({
      enabled: true, hostname: 'app-01', user: 'deploy', network: { mode: 'static' },
      capability: { key: 'vm.guestCustomize', state: 'conditional' },
    });
    expect(plan).not.toHaveProperty('customization.sshAuthorizedKeys');
    const result = await service.submitForHost(host, ARTIFACT_ID, {
      ...request, planHash: plan.planHash, confirm: true, confirmName: 'app-01', idempotencyKey: 'xo-cloud-init-app-01',
    }, deps);
    expect(result.operation.request.customization).toMatchObject({ hostname: 'app-01', user: 'deploy' });
    expect(result.operation.request.customization.network).toMatchObject({ address: '192.0.2.10/24' });
  });
});
