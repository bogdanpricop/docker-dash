'use strict';

process.env.APP_SECRET = 'placement-test';
process.env.ENCRYPTION_KEY = 'placement-advisory-test-key-32-chars';
process.env.DB_PATH = ':memory:';

const placement = require('../services/provider-sdk/placement-advisory');
const Database = require('better-sqlite3');
const identityMigration = require('../db/migrations/106_provider_resource_identities');
const identityStore = require('../services/provider-sdk/identity-store');

const VM_ID = `ddr_vm_${'a'.repeat(26)}`;
const PEER_ID = `ddr_vm_${'b'.repeat(26)}`;
const SOURCE_ID = `ddr_host_${'c'.repeat(26)}`;
const TARGET_ID = `ddr_host_${'d'.repeat(26)}`;

function affinity(rules = []) {
  return {
    schemaVersion: '1.0', capability: { state: 'conditional' }, rules,
    nativeRecommendations: [], limitations: [],
  };
}

function preflight() {
  const sourceTelemetry = { observedAt: new Date().toISOString(), memoryBytes: 100, memoryFreeBytes: 10,
    memoryUtilizationPercent: 90, cpuUtilizationPercent: 45 };
  const targetTelemetry = { observedAt: new Date().toISOString(), memoryBytes: 100, memoryFreeBytes: 50,
    memoryUtilizationPercent: 50, cpuUtilizationPercent: 20 };
  const blockedModes = { live: { blockers: [{ type: 'CURRENT_HOST', reason: 'Current host' }], warnings: [] },
    cold: { blockers: [{ type: 'CURRENT_HOST', reason: 'Current host' }], warnings: [] },
    storage: { blockers: [{ type: 'CURRENT_HOST', reason: 'Current host' }], warnings: [] } };
  return {
    provider: { type: 'xen', endpointId: 7 }, sourceTargetId: SOURCE_ID,
    vm: { id: VM_ID, displayName: 'app', powerState: 'running', memoryBytes: 10, cpuCount: 2 },
    candidates: [{
      target: { id: SOURCE_ID, displayName: 'source', telemetry: sourceTelemetry }, eligible: false,
      readyModes: [], unknownModes: [], modes: blockedModes, checks: [],
    }, {
      target: { id: TARGET_ID, displayName: 'target', telemetry: targetTelemetry }, eligible: true,
      readyModes: ['live'], unknownModes: [], modes: {
        live: { blockers: [], warnings: [], estimate: { durationSeconds: { min: 10, max: 60 }, downtimeSeconds: { min: 1, max: 5 } } },
        cold: { blockers: [{ type: 'POWER_STATE_BLOCKED', reason: 'Running VM' }], warnings: [] },
        storage: { blockers: [], warnings: [] },
      },
      checks: [{ key: 'cpu', state: 'pass' }, { key: 'network', state: 'unknown' }],
    }],
  };
}

describe('provider placement advisory', () => {
  afterEach(() => placement._internals.clearCache());

  it('deduplicates affinity reads and maps native members to opaque canonical IDs', async () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO docker_hosts (id, name) VALUES (7, 'pool')`);
    identityMigration.up(db);
    try {
      const vmIdentity = identityStore.remember({ hostId: 7, providerType: 'xen', kind: 'virtualMachine',
        nativeRef: 'OpaqueRef:vm-a', uuid: 'vm-uuid-a', stability: 'stable' }, db);
      const hostIdentity = identityStore.remember({ hostId: 7, providerType: 'xen', kind: 'host',
        nativeRef: 'OpaqueRef:host-a', uuid: 'host-uuid-a', stability: 'stable' }, db);
      const registry = {
        capabilitiesForHost: jest.fn(async () => ({ probe: { status: 'reachable' }, features: {
          'placement.affinity.read': { state: 'conditional', reason: 'read-only' },
        } })),
        resourcesForHost: jest.fn(async (_host, kind) => ({ items: kind === 'hosts'
          ? [{ id: hostIdentity.id, displayName: 'xen-a', identity: { uuid: 'host-uuid-a' }, status: {}, relationships: {} }]
          : [{ id: vmIdentity.id, displayName: 'app', identity: { uuid: 'vm-uuid-a' }, status: { powerState: 'running' }, relationships: { host: hostIdentity.id } }] })),
        placementInventoryForHost: jest.fn(async () => ({ rules: [{
          nativeId: 'rule-secret', name: '<spread>', kind: 'vm-host-affinity', enabled: true, mandatory: true,
          vmRefs: ['OpaqueRef:vm-a'], hostRefs: ['OpaqueRef:host-a'], source: 'xen-test',
        }], nativeRecommendations: [], limitations: [] })),
      };
      const options = { enabled: true, registry, database: db };
      const [first, second] = await Promise.all([
        placement.affinityForHost({ id: 7, name: 'pool', daemon_type: 'xen' }, options),
        placement.affinityForHost({ id: 7, name: 'pool', daemon_type: 'xen' }, options),
      ]);
      expect(first.rules[0]).toEqual(expect.objectContaining({
        name: '<spread>', virtualMachineIds: [vmIdentity.id], hostIds: [hostIdentity.id],
        compliance: expect.objectContaining({ state: 'compliant' }),
      }));
      expect(second).toEqual(first);
      expect(registry.placementInventoryForHost).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(first)).not.toMatch(/OpaqueRef:|rule-secret|host-uuid-a|vm-uuid-a/);
    } finally { db.close(); }
  });

  it('treats mandatory policy violations and incomplete membership as hard blockers', () => {
    const rules = [{
      id: 'ddp_rule_1', kind: 'vm_host_affinity', enabled: true, mandatory: true,
      virtualMachineIds: [VM_ID], hostIds: [SOURCE_ID], unmappedMembers: 0, currentPlacements: { [VM_ID]: SOURCE_ID },
    }, {
      id: 'ddp_rule_2', kind: 'vm_vm_anti_affinity', enabled: true, mandatory: false,
      virtualMachineIds: [VM_ID, PEER_ID], hostIds: [], unmappedMembers: 0,
      currentPlacements: { [VM_ID]: SOURCE_ID, [PEER_ID]: TARGET_ID },
    }];
    const result = placement._internals._policyForTarget(VM_ID, TARGET_ID, rules);
    expect(result.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'PLACEMENT_POLICY_VIOLATION', ruleId: 'ddp_rule_1' })]));
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: 'ddp_rule_2' })]));

    rules[0].unmappedMembers = 1;
    expect(placement._internals._policyForTarget(VM_ID, SOURCE_ID, rules).blockers)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'PLACEMENT_POLICY_UNKNOWN' })]));
  });

  it('preserves telemetry units/freshness and caps score by evidence coverage', () => {
    const result = placement._internals._scoreCandidate(preflight().candidates[1], preflight(), affinity(), null, Date.now());
    expect(result.eligible).toBe(true);
    expect(result.target.telemetry).toEqual(expect.objectContaining({
      freshness: expect.objectContaining({ state: 'fresh' }),
      cpu: expect.objectContaining({ unit: 'percent', value: 20 }),
      memory: expect.objectContaining({ unit: 'bytes', totalBytes: 100, freeBytes: 50 }),
    }));
    expect(result.dimensions.cpu.projection).toBe('current-target-utilization-only');
    expect(result.evidenceCoveragePercent).toBeLessThan(100);
    expect(result.score).toBeLessThanOrEqual(50 + result.evidenceCoveragePercent / 2);
    expect(JSON.stringify(result)).not.toMatch(/OpaqueRef:|moref|nativeRef/);
  });

  it('returns deterministic explainable recommendations and never calls a mutation', async () => {
    const migration = { preflightForHost: jest.fn(async () => preflight()) };
    const registry = { capabilitiesForHost: jest.fn(async () => ({ features: {
      'placement.recommend': { state: 'conditional', reason: 'read-only' },
    } })) };
    const result = await placement.recommendForVm({ id: 7, name: 'pool', daemon_type: 'xen' }, VM_ID, {
      enabled: true, migration, registry, affinity: affinity(), haSnapshot: { score: 80 },
    });
    expect(result.candidates[0]).toEqual(expect.objectContaining({ target: expect.objectContaining({ id: TARGET_ID }), eligible: true }));
    expect(result.planHash).toHaveLength(64);
    expect(result.scope).toEqual(expect.objectContaining({ readOnly: true, executionEnabled: false }));
    expect(migration.preflightForHost).toHaveBeenCalledTimes(1);
    expect(Object.keys(migration)).toEqual(['preflightForHost']);
  });

  it('builds a capacity-reserved rebalance dry-run with concurrency bounded to two', async () => {
    const hosts = [{ id: SOURCE_ID, displayName: 'source', spec: { memoryBytes: 100 },
      status: { powerState: 'running', memoryFreeBytes: 10, memoryUtilizationPercent: 90, cpuUtilizationPercent: 45 } },
    { id: TARGET_ID, displayName: 'target', spec: { memoryBytes: 100 },
      status: { powerState: 'running', memoryFreeBytes: 50, memoryUtilizationPercent: 50, cpuUtilizationPercent: 20 } }];
    const vms = [{ id: VM_ID, displayName: 'app', spec: { memoryBytes: 10 }, status: { powerState: 'running' }, relationships: { host: SOURCE_ID } }];
    const registry = {
      resourcesForHost: jest.fn(async (_host, kind) => ({ items: kind === 'hosts' ? hosts : vms })),
      capabilitiesForHost: jest.fn(async () => ({ features: {
        'placement.recommend': { state: 'conditional' }, 'placement.rebalance.plan': { state: 'conditional' },
      } })),
    };
    const migration = { preflightForHost: jest.fn(async () => preflight()) };
    const result = await placement.rebalancePlanForHost({ id: 7, name: 'pool', daemon_type: 'xen' }, {
      sourceThresholdPercent: 85, targetThresholdPercent: 75, maxMoves: 1,
    }, { enabled: true, registry, migration, affinity: affinity(), haSnapshot: { score: 80 } });
    expect(result.scope).toEqual(expect.objectContaining({ readOnly: true, executable: false, maxMoves: 1 }));
    expect(result.moves).toEqual([expect.objectContaining({ sourceHostId: SOURCE_ID, targetHostId: TARGET_ID, mode: 'live' })]);
    expect(result.expiresAt).toBeTruthy();
    expect(result.planHash).toHaveLength(64);
    expect(registry.resourcesForHost).toHaveBeenCalledTimes(2);
  });

  it('rejects unsafe rebalance thresholds and marks CPU-only pressure non-projectable', async () => {
    await expect(placement.rebalancePlanForHost({ id: 7, daemon_type: 'xen' }, {
      sourceThresholdPercent: 60, targetThresholdPercent: 75,
    }, { enabled: true })).rejects.toMatchObject({ code: 'INVALID_REBALANCE_OPTIONS' });
    expect(placement._internals._knownPressure({ status: { cpuUtilizationPercent: 91 } }))
      .toEqual({ memory: null, cpu: 91, pressure: 91 });
  });
});
