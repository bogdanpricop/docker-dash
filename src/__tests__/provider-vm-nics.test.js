'use strict';

const Database = require('better-sqlite3');

jest.mock('../config', () => ({
  features: {
    providerVmNicLinkProxmox: false, providerVmNicLinkVsphere: false, providerVmNicLinkXen: false,
  },
  providerVmNics: { safetyDeclarationMaxHours: 4, verifyTimeoutMs: 120000 },
}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('inject database'); }) }));
jest.mock('../services/provider-operations/index', () => ({}));
jest.mock('../services/provider-sdk/registry', () => ({}));
jest.mock('../services/provider-operations/policy', () => ({}));
jest.mock('../services/provider-operations/handlers/vm-nic-link', () => ({ TYPE: 'vm.nic.link' }));

const migration = require('../db/migrations/163_provider_vm_nic_safety');
const service = require('../services/provider-operations/vm-nics');

const VM_ID = `ddr_vm_${'a'.repeat(26)}`;
const NIC_A = `ddh_nic_${'b'.repeat(26)}`;
const NIC_B = `ddh_nic_${'c'.repeat(26)}`;
const host = { id: 7, daemon_type: 'proxmox' };

function database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY);
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    INSERT INTO docker_hosts(id) VALUES (7);
    INSERT INTO users(id) VALUES (9);`);
  migration.up(db);
  return db;
}

function dependencies(overrides = {}) {
  const db = overrides.database || database();
  const vm = {
    id: VM_ID, kind: 'virtualMachine', displayName: 'payments-01',
    identity: { stability: 'stable' }, status: { powerState: 'running' },
  };
  const nics = overrides.nics || [
    {
      id: NIC_A, label: 'NIC 0', device: 'net0', model: 'virtio', macAddress: '02:00:00:00:00:01',
      network: { id: 'prod', bridge: 'vmbr0', vlanId: 10 }, attachment: { connected: true },
      capabilities: { connectDisconnect: true },
    },
    {
      id: NIC_B, label: 'NIC 1', device: 'net1', model: 'virtio', macAddress: '02:00:00:00:00:02',
      network: { id: 'backup', bridge: 'vmbr1', vlanId: 20 }, attachment: { connected: true },
      capabilities: { connectDisconnect: true },
    },
  ];
  const capabilities = { features: {
    'vm.nic.connect': { state: overrides.capabilityState || 'conditional', reason: 'available' },
    'vm.nic.disconnect': { state: overrides.capabilityState || 'conditional', reason: 'available' },
  } };
  const operations = {
    list: jest.fn(() => overrides.active || []),
    create: jest.fn(input => ({ id: `op_${'d'.repeat(26)}`, ...input })),
  };
  return {
    database: db, enabled: overrides.enabled ?? true, canOperate: overrides.canOperate ?? true,
    createdBy: 9, operations,
    registry: {
      resourcesForHost: jest.fn(async () => ({ items: [vm] })),
      vmHardwareForHost: jest.fn(async () => ({
        observedAt: '2026-07-30T00:00:00.000Z', summary: { nicCount: nics.length },
        sections: { network: { available: true } }, nics,
      })),
      capabilitiesForHost: jest.fn(async () => capabilities),
    },
    policy: { evaluate: jest.fn(() => overrides.policy || { allowed: true, mode: 'normal' }) },
    vm, nics,
  };
}

describe('common VM NIC link control', () => {
  const open = [];
  afterEach(() => { while (open.length) open.pop().close(); });

  it('fails closed on disconnect until a current safe declaration exists', async () => {
    const deps = dependencies(); open.push(deps.database);
    const blocked = await service.preflightForHost(host, VM_ID, NIC_A, 'disconnect', deps);
    expect(blocked.allowed).toBe(false);
    expect(blocked.blockers).toContainEqual(expect.objectContaining({ type: 'VM_NIC_SAFETY_DECLARATION_REQUIRED' }));

    const declared = await service.declareSafetyForHost(host, VM_ID, NIC_A, {
      managementRole: 'non_management', bootDependency: 'not_required', guestDependency: 'not_required',
      validForHours: 1, reason: 'Checked workload runbook and active service routes',
    }, deps);
    expect(declared.safety).toEqual(expect.objectContaining({ state: 'valid', valid: true }));
    const ready = await service.preflightForHost(host, VM_ID, NIC_A, 'disconnect', deps);
    expect(ready).toEqual(expect.objectContaining({
      allowed: true, action: 'disconnect', expectedConnected: false,
      planHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it('blocks the last connected NIC even with an otherwise safe declaration', async () => {
    const deps = dependencies({ nics: [{
      id: NIC_A, label: 'NIC 0', device: 'net0', model: 'virtio', macAddress: '02:00:00:00:00:01',
      network: { id: 'prod', bridge: 'vmbr0', vlanId: 10 }, attachment: { connected: true },
      capabilities: { connectDisconnect: true },
    }] }); open.push(deps.database);
    await service.declareSafetyForHost(host, VM_ID, NIC_A, {
      managementRole: 'non_management', bootDependency: 'not_required', guestDependency: 'not_required',
      validForHours: 1, reason: 'Checked workload runbook and active service routes',
    }, deps);
    const plan = await service.preflightForHost(host, VM_ID, NIC_A, 'disconnect', deps);
    expect(plan.blockers).toContainEqual(expect.objectContaining({ type: 'LAST_CONNECTED_NIC' }));
  });

  it('invalidates a declaration when the NIC network identity changes', async () => {
    const deps = dependencies(); open.push(deps.database);
    await service.declareSafetyForHost(host, VM_ID, NIC_A, {
      managementRole: 'non_management', bootDependency: 'not_required', guestDependency: 'not_required',
      validForHours: 1, reason: 'Checked workload runbook and active service routes',
    }, deps);
    deps.nics[0].network.vlanId = 99;
    const plan = await service.preflightForHost(host, VM_ID, NIC_A, 'disconnect', deps);
    expect(plan.safety.state).toBe('hardware_changed');
    expect(plan.allowed).toBe(false);
  });

  it('submits only the exact typed, reviewed plan and locks both VM and NIC', async () => {
    const deps = dependencies(); open.push(deps.database);
    await service.declareSafetyForHost(host, VM_ID, NIC_A, {
      managementRole: 'non_management', bootDependency: 'not_required', guestDependency: 'not_required',
      validForHours: 1, reason: 'Checked workload runbook and active service routes',
    }, deps);
    const plan = await service.preflightForHost(host, VM_ID, NIC_A, 'disconnect', deps);
    await expect(service.submitForHost(host, VM_ID, NIC_A, {
      action: 'disconnect', planHash: '0'.repeat(64), confirm: true,
      confirmText: plan.confirmation.expected, idempotencyKey: 'nic-link-01',
    }, deps)).rejects.toMatchObject({ code: 'VM_NIC_PREFLIGHT_STALE' });
    const result = await service.submitForHost(host, VM_ID, NIC_A, {
      action: 'disconnect', planHash: plan.planHash, confirm: true,
      confirmText: plan.confirmation.expected, idempotencyKey: 'nic-link-01',
    }, deps);
    expect(result.operation.type).toBe('vm.nic.link');
    expect(deps.operations.create).toHaveBeenCalledWith(expect.objectContaining({
      action: 'disconnect', resourceId: VM_ID,
      lockScopes: [`resource:${VM_ID}`, `device:${NIC_A}`],
      request: expect.objectContaining({ safetyDeclarationId: expect.any(Number), expectedConnected: false }),
    }));
  });
});
