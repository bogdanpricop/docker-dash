'use strict';

const config = require('../../config');
const { getDb } = require('../../db');
const { sha256 } = require('../../utils/crypto');
const registrySingleton = require('../provider-sdk/registry');
const operationsSingleton = require('./index');
const policySingleton = require('./policy');
const { TYPE } = require('./handlers/vm-power');

const PREFLIGHT_SCHEMA_VERSION = '1.0';
const PLAN_TTL_MS = 5 * 60 * 1000;
const MAX_BULK = 20;
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);
const SAFE_VM_ID = /^ddr_vm_[a-f0-9]{26}$/;
const ACTIONS = Object.freeze({
  start: Object.freeze({ capability: 'vm.power.start', expectedPowerState: 'running', states: ['stopped', 'suspended', 'offline'], force: false }),
  shutdown: Object.freeze({ capability: 'vm.power.shutdown', expectedPowerState: 'stopped', states: ['running', 'paused'], force: false, guest: true }),
  reboot: Object.freeze({ capability: 'vm.power.reboot', expectedPowerState: 'running', states: ['running'], force: false, guest: true }),
  forceShutdown: Object.freeze({ capability: 'vm.power.force', expectedPowerState: 'stopped', states: ['running', 'paused'], force: true }),
  forceReboot: Object.freeze({ capability: 'vm.power.force', expectedPowerState: 'running', states: ['running', 'paused'], force: true }),
});

class VmPowerError extends Error {
  constructor(message, code = 'VM_POWER_ERROR', status = 400, details = null) {
    super(message); this.name = 'VmPowerError'; this.code = code; this.status = status; this.details = details;
  }
}

function _action(value) {
  const action = String(value || '');
  if (!ACTIONS[action]) throw new VmPowerError('Unsupported VM power action', 'INVALID_VM_POWER_ACTION');
  return action;
}

function _resourceIds(values) {
  if (!Array.isArray(values)) throw new VmPowerError('resourceIds must be an array', 'INVALID_VM_POWER_RESOURCES');
  const ids = [...new Set(values.map(String))];
  if (!ids.length || ids.length > MAX_BULK || ids.some(id => !SAFE_VM_ID.test(id))) {
    throw new VmPowerError(`resourceIds must contain 1-${MAX_BULK} canonical VM IDs`, 'INVALID_VM_POWER_RESOURCES');
  }
  return ids;
}

function _blocker(type, reason, evidence = null) { return { type, reason, evidence }; }

function _semanticPlan(plan) {
  return {
    hostId: plan.hostId, providerType: plan.providerType, resourceId: plan.resource.id,
    displayName: plan.resource.displayName, action: plan.action,
    currentPowerState: plan.currentPowerState, expectedPowerState: plan.expectedPowerState,
    resourceActions: [...plan.resource.actions].sort(),
    capability: { key: plan.capability.key, state: plan.capability.state },
    blockerTypes: plan.blockers.map(item => `${item.type}:${item.evidence?.code || item.evidence?.state || ''}`).sort(),
    validUntil: plan.validUntil,
  };
}

function _buildPlan(context, resource, action, options = {}) {
  const definition = ACTIONS[action];
  const capability = context.capabilities.features[definition.capability]
    || { state: 'unknown', reason: 'Capability evidence is unavailable' };
  const blockers = [];
  if (!context.enabled) blockers.push(_blocker('RELEASE_DISABLED', 'Common VM power operations are disabled by release policy', { code: 'DD_PROVIDER_VM_POWER' }));
  if (!['supported', 'conditional'].includes(capability.state)) {
    blockers.push(_blocker(capability.state === 'unknown' ? 'CAPABILITY_UNKNOWN' : 'CAPABILITY_UNSUPPORTED',
      capability.reason || 'Provider capability is unavailable', { state: capability.state }));
  }
  const currentPowerState = resource.status?.powerState || 'unknown';
  if (!definition.states.includes(currentPowerState)) {
    blockers.push(_blocker('RESOURCE_STATE_BLOCKED', `Action is unavailable while the VM is ${currentPowerState}`, { state: currentPowerState }));
  }
  if (!(resource.actions || []).includes(action)) {
    blockers.push(_blocker('RESOURCE_ACTION_BLOCKED', 'The provider did not advertise this action for the VM'));
  }
  if (resource.identity?.stability === 'transient') {
    blockers.push(_blocker('UNSTABLE_RESOURCE_IDENTITY',
      'Durable power operations require a VM identity that survives provider and worker restarts',
      { stability: 'transient' }));
  }
  if (!context.policy.allowed) blockers.push(_blocker('POLICY_BLOCKED', context.policy.reason, { code: context.policy.code, mode: context.policy.mode }));
  if (options.canOperate !== true) blockers.push(_blocker('PERMISSION_BLOCKED', 'Operate permission is required for this endpoint'));
  const conflict = context.activeOperations.find(operation => operation.resource?.id === resource.id);
  if (conflict) blockers.push(_blocker('OPERATION_CONFLICT', 'Another provider operation is active for this VM', { operationId: conflict.id, state: conflict.state }));
  const warnings = [];
  if (definition.guest) warnings.push({ type: 'GUEST_COORDINATION', reason: 'Clean guest operations depend on guest tools and OS cooperation' });
  if (definition.force) warnings.push({ type: 'DATA_LOSS_RISK', reason: 'Forced power can cause guest data loss or filesystem corruption' });
  const plan = {
    schemaVersion: PREFLIGHT_SCHEMA_VERSION,
    hostId: Number(context.host.id), providerType: context.host.daemon_type,
    resource: { id: resource.id, displayName: resource.displayName, actions: resource.actions || [] },
    action, currentPowerState, expectedPowerState: definition.expectedPowerState,
    capability: { key: definition.capability, state: capability.state, reason: capability.reason || null },
    allowed: blockers.length === 0, blockers, warnings,
    confirmation: definition.force
      ? { required: true, mode: 'typed_name', expected: resource.displayName }
      : { required: true, mode: 'explicit' },
    validUntil: new Date((Math.floor(Date.now() / PLAN_TTL_MS) + 1) * PLAN_TTL_MS).toISOString(),
  };
  plan.planHash = sha256(JSON.stringify(_semanticPlan(plan)));
  return plan;
}

async function _context(host, options = {}) {
  const registry = options.registry || registrySingleton;
  const operations = options.operations || operationsSingleton;
  const policyService = options.policy || policySingleton;
  const database = options.database || getDb();
  const [inventory, capabilities] = await Promise.all([
    registry.resourcesForHost(host, 'virtual-machines', { limit: 500, database }),
    registry.capabilitiesForHost(host),
  ]);
  let activeOperations = [];
  try {
    activeOperations = operations.list({ hostId: Number(host.id), limit: 500 })
      .filter(operation => !TERMINAL_STATES.has(operation.state));
  } catch { /* operation table is an explicit blocker only through submit */ }
  const policy = policyService.evaluate({ providerType: host.daemon_type, hostId: Number(host.id) });
  return {
    host, inventory, capabilities, activeOperations, policy, database,
    enabled: options.enabled === undefined ? config.features.providerVmPower : options.enabled === true,
  };
}

async function preflightForHost(host, resourceId, actionInput, options = {}) {
  const action = _action(actionInput);
  const id = String(resourceId || '');
  if (!SAFE_VM_ID.test(id)) throw new VmPowerError('Virtual machine was not found', 'PROVIDER_VM_NOT_FOUND', 404);
  const context = await _context(host, options);
  const resource = context.inventory.items.find(item => item.id === id);
  if (!resource) throw new VmPowerError('Virtual machine was not found', 'PROVIDER_VM_NOT_FOUND', 404);
  return _buildPlan(context, resource, action, options);
}

async function preflightManyForHost(host, resourceIdsInput, actionInput, options = {}) {
  const action = _action(actionInput);
  const ids = _resourceIds(resourceIdsInput);
  const context = await _context(host, options);
  const byId = new Map(context.inventory.items.map(item => [item.id, item]));
  const plans = ids.map(id => {
    const resource = byId.get(id);
    if (resource) return _buildPlan(context, resource, action, options);
    const missing = {
      schemaVersion: PREFLIGHT_SCHEMA_VERSION, hostId: Number(host.id), providerType: host.daemon_type,
      resource: { id, displayName: 'Unavailable', actions: [] }, action,
      currentPowerState: 'unknown', expectedPowerState: ACTIONS[action].expectedPowerState,
      capability: { key: ACTIONS[action].capability, state: 'unknown', reason: null },
      allowed: false, blockers: [_blocker('RESOURCE_NOT_FOUND', 'Virtual machine was not found')], warnings: [],
      confirmation: { required: true, mode: ACTIONS[action].force ? 'typed_name' : 'explicit' },
      validUntil: new Date((Math.floor(Date.now() / PLAN_TTL_MS) + 1) * PLAN_TTL_MS).toISOString(),
    };
    missing.planHash = sha256(JSON.stringify(_semanticPlan(missing)));
    return missing;
  });
  return { schemaVersion: PREFLIGHT_SCHEMA_VERSION, hostId: Number(host.id), action, count: plans.length, allowed: plans.every(plan => plan.allowed), plans };
}

function _assertSubmission(plan, input = {}) {
  if (!plan.allowed) throw new VmPowerError('VM power preflight is blocked', 'VM_POWER_PREFLIGHT_BLOCKED', 409, plan.blockers);
  if (!/^[a-f0-9]{64}$/.test(String(input.planHash || '')) || input.planHash !== plan.planHash) {
    throw new VmPowerError('VM power preflight changed; review the new plan', 'VM_POWER_PREFLIGHT_STALE', 409);
  }
  if (input.confirm !== true) throw new VmPowerError('VM power operation requires confirm=true', 'VM_POWER_CONFIRMATION_REQUIRED');
  if (ACTIONS[plan.action].force && input.confirmName !== plan.resource.displayName) {
    throw new VmPowerError('Forced power requires the exact VM name', 'VM_POWER_TYPED_CONFIRMATION_REQUIRED');
  }
}

async function submitForHost(host, resourceId, input = {}, options = {}) {
  const plan = await preflightForHost(host, resourceId, input.action, options);
  _assertSubmission(plan, input);
  const engine = options.operations || operationsSingleton;
  return { plan, operation: engine.create({
    type: TYPE, providerType: host.daemon_type, hostId: Number(host.id),
    resourceKind: 'virtualMachine', resourceId: plan.resource.id, action: plan.action,
    idempotencyKey: input.idempotencyKey,
    request: { planHash: plan.planHash, expectedPowerState: plan.expectedPowerState },
    lockScopes: [`resource:${plan.resource.id}`], createdBy: options.createdBy,
  }) };
}

async function submitManyForHost(host, resourceIds, input = {}, options = {}) {
  const preflight = await preflightManyForHost(host, resourceIds, input.action, options);
  const hashes = input.plans && typeof input.plans === 'object' && !Array.isArray(input.plans) ? input.plans : {};
  for (const plan of preflight.plans) {
    _assertSubmission(plan, { ...input, planHash: hashes[plan.resource.id], confirmName: input.confirmNames?.[plan.resource.id] });
  }
  const baseKey = String(input.idempotencyKey || '');
  if (!/^[\x21-\x7e]{8,160}$/.test(baseKey)) throw new VmPowerError('Idempotency-Key must contain 8-160 visible ASCII characters', 'INVALID_IDEMPOTENCY_KEY');
  const engine = options.operations || operationsSingleton;
  const database = options.database || getDb();
  const operations = database.transaction(() => preflight.plans.map(plan => engine.create({
    type: TYPE, providerType: host.daemon_type, hostId: Number(host.id),
    resourceKind: 'virtualMachine', resourceId: plan.resource.id, action: plan.action,
    idempotencyKey: `${baseKey}:${plan.resource.id}`,
    request: { planHash: plan.planHash, expectedPowerState: plan.expectedPowerState, bulk: true },
    lockScopes: [`resource:${plan.resource.id}`], createdBy: options.createdBy,
  })))();
  return { preflight, operations };
}

module.exports = {
  ACTIONS, MAX_BULK, VmPowerError, preflightForHost, preflightManyForHost,
  submitForHost, submitManyForHost,
  _internals: { _action, _resourceIds, _semanticPlan, _buildPlan, _assertSubmission },
};
