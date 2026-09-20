'use strict';

const config = require('../../config');
const { getDb } = require('../../db');
const { sha256 } = require('../../utils/crypto');
const registrySingleton = require('../provider-sdk/registry');
const snapshotStore = require('../provider-sdk/vm-snapshot-store');
const operationsSingleton = require('./index');
const policySingleton = require('./policy');
const bridge = require('./snapshot-provider');
const { TYPE } = require('./handlers/vm-snapshot');

const SAFE_VM_ID = /^ddr_vm_[a-f0-9]{26}$/;
const SAFE_SNAPSHOT_ID = /^dds_snap_[a-f0-9]{26}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const PLAN_TTL_MS = 5 * 60 * 1000;
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);
const ACTIONS = Object.freeze({ create: 'vm.snapshot.create', revert: 'vm.snapshot.revert', delete: 'vm.snapshot.delete', consolidate: 'vm.snapshot.consolidate' });

class VmSnapshotError extends Error {
  constructor(message, code = 'VM_SNAPSHOT_ERROR', status = 400, details = null) {
    super(message); this.name = 'VmSnapshotError'; this.code = code; this.status = status; this.details = details;
  }
}

function _text(value, max) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function _name(value) {
  const name = _text(value, 80);
  if (!name || !SAFE_NAME.test(name)) {
    throw new VmSnapshotError('Snapshot name must be 1-80 portable characters: letters, numbers, dot, underscore or hyphen', 'INVALID_SNAPSHOT_NAME');
  }
  return name;
}

function _consistency(value) {
  const consistency = String(value || 'crash');
  if (!['crash', 'quiesced'].includes(consistency)) {
    throw new VmSnapshotError('Snapshot consistency must be crash or quiesced', 'INVALID_SNAPSHOT_CONSISTENCY');
  }
  return consistency;
}

function _maxCount(options = {}) {
  const value = Number(options.maxCount ?? config.providerSnapshots?.maxCount ?? 32);
  return Math.min(128, Math.max(1, Number.isInteger(value) ? value : 32));
}

function _maxDepth(options = {}) {
  const value = Number(options.maxDepth ?? config.providerSnapshots?.maxDepth ?? 16);
  return Math.min(64, Math.max(1, Number.isInteger(value) ? value : 16));
}

function _graphDepth(items = []) {
  const byId = new Map(items.map(item => [item.id, item]));
  const memo = new Map();
  const visit = (item, path = new Set()) => {
    if (!item || path.has(item.id)) return 0;
    if (memo.has(item.id)) return memo.get(item.id);
    const next = new Set(path); next.add(item.id);
    const depth = 1 + (item.parentId ? visit(byId.get(item.parentId), next) : 0);
    memo.set(item.id, depth);
    return depth;
  };
  return items.reduce((max, item) => Math.max(max, visit(item)), 0);
}

function _blocker(type, reason, evidence = null) { return { type, reason, evidence }; }

function _protection() {
  return {
    isBackup: false, failureDomain: 'provider_storage',
    warning: 'A snapshot is not an independent backup and can be lost with the VM or provider storage',
  };
}

async function inventoryForHost(host, vmIdInput, options = {}) {
  const vmId = String(vmIdInput || '');
  if (!SAFE_VM_ID.test(vmId)) throw new VmSnapshotError('Virtual machine was not found', 'PROVIDER_VM_NOT_FOUND', 404);
  const database = options.database || getDb();
  const registry = options.registry || registrySingleton;
  const inventory = await registry.resourcesForHost(host, 'virtual-machines', { limit: 500, database });
  const vm = inventory.items.find(item => item.id === vmId);
  if (!vm) throw new VmSnapshotError('Virtual machine was not found', 'PROVIDER_VM_NOT_FOUND', 404);
  if (vm.identity?.stability === 'transient') {
    throw new VmSnapshotError('Stable VM identity is required for common snapshots', 'UNSTABLE_RESOURCE_IDENTITY', 409);
  }
  let target;
  try {
    target = await bridge.open(host, vmId, database);
    const items = snapshotStore.rememberMany({
      hostId: Number(host.id), vmId, providerType: host.daemon_type,
    }, await bridge.list(target), database);
    return {
      schemaVersion: '1.0', hostId: Number(host.id), providerType: host.daemon_type,
      vm: { id: vm.id, displayName: vm.displayName, powerState: vm.status?.powerState || 'unknown', actions: vm.actions || [], identity: vm.identity },
      providerState: { consolidationNeeded: target.row?.consolidationNeeded === true },
      count: items.length, maxCount: _maxCount(options), maxDepth: _maxDepth(options),
      observedDepth: _graphDepth(items), items, protection: _protection(),
      observedAt: new Date().toISOString(),
    };
  } finally { await bridge.close(target); }
}

function cachedForHost(host, vmId, options = {}) {
  const database = options.database || getDb();
  return snapshotStore.list(Number(host.id), vmId, database);
}

function _semanticPlan(plan) {
  return {
    hostId: plan.hostId, providerType: plan.providerType, vm: plan.vm,
    action: plan.action, name: plan.name, description: plan.description,
    consistency: plan.consistency, snapshot: plan.snapshot && {
      id: plan.snapshot.id, name: plan.snapshot.name, parentId: plan.snapshot.parentId,
      childCount: plan.snapshot.childCount, isCurrent: plan.snapshot.isCurrent,
    },
    inventory: plan.inventory, capability: { key: plan.capability.key, state: plan.capability.state },
    blockers: plan.blockers.map(item => `${item.type}:${item.evidence?.code || item.evidence?.state || ''}`).sort(),
    validUntil: plan.validUntil,
  };
}

async function _context(host, vmId, action, input, options = {}) {
  if (!ACTIONS[action]) throw new VmSnapshotError('Unsupported snapshot action', 'INVALID_SNAPSHOT_ACTION');
  const database = options.database || getDb();
  const registry = options.registry || registrySingleton;
  const operations = options.operations || operationsSingleton;
  const policyService = options.policy || policySingleton;
  const [inventory, capabilities] = await Promise.all([
    inventoryForHost(host, vmId, { ...options, database, registry }),
    registry.capabilitiesForHost(host),
  ]);
  let activeOperations = [];
  try {
    activeOperations = operations.list({ hostId: Number(host.id), limit: 500 })
      .filter(operation => !TERMINAL_STATES.has(operation.state) && operation.resource?.id === vmId);
  } catch { /* engine submit remains fail-closed */ }
  let policy;
  try { policy = policyService.evaluate({ providerType: host.daemon_type, hostId: Number(host.id) }); }
  catch { policy = { allowed: false, code: 'POLICY_UNAVAILABLE', mode: 'unknown', reason: 'Operation policy is unavailable' }; }
  return {
    host, database, inventory, capabilities, activeOperations, policy,
    enabled: options.enabled === undefined ? config.features.providerVmSnapshots : options.enabled === true,
    consolidationEnabled: options.consolidationEnabled === undefined
      ? config.features.providerVmSnapshotConsolidation : options.consolidationEnabled === true,
    canOperate: options.canOperate === true, input,
  };
}

function _plan(context, action, input = {}, snapshotId = null) {
  const blockers = [];
  const warnings = [{ type: 'NOT_A_BACKUP', reason: context.inventory.protection.warning }];
  const capabilityKey = ACTIONS[action];
  const capability = context.capabilities.features[capabilityKey]
    || { state: 'unknown', reason: 'Snapshot capability evidence is unavailable', constraints: {} };
  if (!context.enabled) blockers.push(_blocker('RELEASE_DISABLED', 'Common VM snapshots are disabled by release policy', { code: 'DD_PROVIDER_VM_SNAPSHOTS' }));
  if (action === 'consolidate' && !context.consolidationEnabled) {
    blockers.push(_blocker('RELEASE_DISABLED', 'Snapshot consolidation is disabled by release policy', { code: 'DD_PROVIDER_VM_SNAPSHOT_CONSOLIDATION' }));
  }
  if (!['supported', 'conditional'].includes(capability.state)) {
    blockers.push(_blocker(capability.state === 'unknown' ? 'CAPABILITY_UNKNOWN' : 'CAPABILITY_UNSUPPORTED',
      capability.reason || 'Snapshot capability is unavailable', { state: capability.state }));
  }
  if (!context.canOperate) blockers.push(_blocker('PERMISSION_BLOCKED', 'Operate permission is required for this endpoint'));
  if (!context.policy.allowed) blockers.push(_blocker('POLICY_BLOCKED', context.policy.reason, { code: context.policy.code, mode: context.policy.mode }));
  if (context.activeOperations.length) blockers.push(_blocker('OPERATION_CONFLICT', 'Another provider operation is active for this VM', {
    operationId: context.activeOperations[0].id, state: context.activeOperations[0].state,
  }));
  if (context.inventory.vm.identity?.stability === 'transient') blockers.push(_blocker('UNSTABLE_RESOURCE_IDENTITY', 'Stable VM identity is required'));
  const invalidGraph = context.inventory.items.filter(item => !['valid', 'unknown'].includes(item.integrity?.state));
  if (invalidGraph.length) blockers.push(_blocker('SNAPSHOT_GRAPH_INVALID', 'Snapshot parent graph must be repaired before mutation', { count: invalidGraph.length }));

  let name = null; let description = null; let consistency = null; let snapshot = null;
  if (action === 'create') {
    name = _name(input.name); description = _text(input.description, 1000); consistency = _consistency(input.consistency);
    if (context.inventory.items.some(item => item.name.toLowerCase() === name.toLowerCase())) {
      blockers.push(_blocker('SNAPSHOT_NAME_CONFLICT', 'A snapshot with this name already exists'));
    }
    if (context.inventory.count >= context.inventory.maxCount) {
      blockers.push(_blocker('SNAPSHOT_LIMIT_REACHED', 'Snapshot count reached the configured maximum', { maxCount: context.inventory.maxCount }));
    }
    if (context.inventory.observedDepth >= context.inventory.maxDepth) {
      blockers.push(_blocker('SNAPSHOT_CHAIN_LIMIT_REACHED', 'Snapshot chain reached the configured maximum depth', {
        maxDepth: context.inventory.maxDepth, observedDepth: context.inventory.observedDepth,
      }));
    }
    const supportedConsistency = capability.constraints?.consistency || ['crash'];
    if (!supportedConsistency.includes(consistency)) {
      blockers.push(_blocker('SNAPSHOT_CONSISTENCY_UNAVAILABLE', `${consistency} consistency is unavailable for this provider`, { consistency }));
    }
    const requiredAction = consistency === 'quiesced' ? 'snapshotQuiesced' : 'snapshot';
    if (!context.inventory.vm.actions.includes(requiredAction)) {
      blockers.push(_blocker('RESOURCE_ACTION_BLOCKED', `The provider did not advertise ${requiredAction} for this VM`));
    }
    if (consistency === 'quiesced') warnings.push({ type: 'GUEST_QUIESCE', reason: 'Quiesced consistency depends on guest tools and provider-native freeze behavior' });
  } else if (action === 'consolidate') {
    if (context.host.daemon_type !== 'vsphere') {
      blockers.push(_blocker('CAPABILITY_UNSUPPORTED', 'Snapshot consolidation is released only for vSphere endpoints'));
    }
    if (context.inventory.providerState?.consolidationNeeded !== true) {
      blockers.push(_blocker('SNAPSHOT_CONSOLIDATION_NOT_REQUIRED', 'Provider does not currently report that this VM requires disk consolidation'));
    }
    warnings.push({ type: 'STORAGE_IO', reason: 'Provider disk consolidation can generate material datastore I/O; monitor the native task to completion' });
  } else {
    if (!SAFE_SNAPSHOT_ID.test(String(snapshotId || ''))) throw new VmSnapshotError('Snapshot was not found', 'PROVIDER_SNAPSHOT_NOT_FOUND', 404);
    snapshot = context.inventory.items.find(item => item.id === snapshotId) || null;
    if (!snapshot) throw new VmSnapshotError('Snapshot was not found', 'PROVIDER_SNAPSHOT_NOT_FOUND', 404);
    name = snapshot.name;
    if (action === 'delete' && snapshot.childCount > 0) {
      blockers.push(_blocker('SNAPSHOT_HAS_CHILDREN', 'Delete is blocked while this snapshot has child snapshots', { childCount: snapshot.childCount }));
    }
    if (action === 'revert') warnings.push({ type: 'CURRENT_STATE_REPLACED', reason: 'Revert replaces the VM current disk state and may change its power state' });
    if (action === 'delete') warnings.push({ type: 'SNAPSHOT_DATA_REMOVED', reason: 'Delete removes snapshot data and may trigger storage consolidation' });
  }
  const plan = {
    schemaVersion: '1.0', hostId: Number(context.host.id), providerType: context.host.daemon_type,
    vm: { id: context.inventory.vm.id, displayName: context.inventory.vm.displayName, powerState: context.inventory.vm.powerState, actions: [...context.inventory.vm.actions].sort() },
    action, name, description, consistency, snapshot,
    inventory: {
      count: context.inventory.count, maxCount: context.inventory.maxCount,
      observedDepth: context.inventory.observedDepth, maxDepth: context.inventory.maxDepth,
      consolidationNeeded: context.inventory.providerState?.consolidationNeeded === true,
      graphHash: sha256(JSON.stringify(context.inventory.items.map(item => [item.id, item.name, item.parentId, item.childCount, item.isCurrent]).sort())),
    },
    capability: { key: capabilityKey, state: capability.state, reason: capability.reason || null },
    protection: _protection(), allowed: blockers.length === 0, blockers, warnings,
    confirmation: action === 'create'
      ? { required: true, mode: 'explicit' }
      : { required: true, mode: 'typed_name', expected: ['revert', 'consolidate'].includes(action) ? context.inventory.vm.displayName : snapshot.name },
    validUntil: new Date((Math.floor(Date.now() / PLAN_TTL_MS) + 1) * PLAN_TTL_MS).toISOString(),
  };
  plan.planHash = sha256(JSON.stringify(_semanticPlan(plan)));
  return plan;
}

async function preflightForHost(host, vmId, action, input = {}, snapshotId = null, options = {}) {
  return _plan(await _context(host, vmId, action, input, options), action, input, snapshotId);
}

function _assertSubmission(plan, input = {}) {
  if (!plan.allowed) throw new VmSnapshotError('Snapshot preflight is blocked', 'VM_SNAPSHOT_PREFLIGHT_BLOCKED', 409, plan.blockers);
  if (!/^[a-f0-9]{64}$/.test(String(input.planHash || '')) || input.planHash !== plan.planHash) {
    throw new VmSnapshotError('Snapshot preflight changed; review the new plan', 'VM_SNAPSHOT_PREFLIGHT_STALE', 409);
  }
  if (input.confirm !== true) throw new VmSnapshotError('Snapshot operation requires confirm=true', 'VM_SNAPSHOT_CONFIRMATION_REQUIRED');
  if (plan.confirmation.mode === 'typed_name' && input.confirmName !== plan.confirmation.expected) {
    throw new VmSnapshotError('Snapshot operation requires the exact confirmation name', 'VM_SNAPSHOT_TYPED_CONFIRMATION_REQUIRED');
  }
}

async function submitForHost(host, vmId, action, input = {}, snapshotId = null, options = {}) {
  const plan = await preflightForHost(host, vmId, action, input, snapshotId, options);
  _assertSubmission(plan, input);
  const engine = options.operations || operationsSingleton;
  return { plan, operation: engine.create({
    type: TYPE, providerType: host.daemon_type, hostId: Number(host.id),
    resourceKind: 'virtualMachine', resourceId: vmId, action,
    idempotencyKey: input.idempotencyKey,
    request: {
      planHash: plan.planHash, snapshotId: plan.snapshot?.id || null,
      name: plan.name, description: plan.description, consistency: plan.consistency,
      consolidationNeeded: plan.inventory.consolidationNeeded === true,
    },
    lockScopes: [`resource:${vmId}`], createdBy: options.createdBy,
  }) };
}

module.exports = {
  ACTIONS, VmSnapshotError, inventoryForHost, cachedForHost, preflightForHost, submitForHost,
  _internals: { _text, _name, _consistency, _maxCount, _maxDepth, _graphDepth, _protection, _semanticPlan, _plan, _assertSubmission },
};
