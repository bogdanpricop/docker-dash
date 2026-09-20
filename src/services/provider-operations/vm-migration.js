'use strict';

const config = require('../../config');
const { getDb } = require('../../db');
const { sha256 } = require('../../utils/crypto');
const migrationPreflight = require('../provider-sdk/vm-migration-preflight');
const registrySingleton = require('../provider-sdk/registry');
const identityStore = require('../provider-sdk/identity-store');
const operationsSingleton = require('./index');
const policySingleton = require('./policy');

const TYPE = 'vm.migrate';
const PLAN_TTL_MS = 5 * 60 * 1000;
const MODES = Object.freeze(['live', 'cold', 'storage']);
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);
const SAFE_VM_ID = /^ddr_vm_[a-f0-9]{26}$/;
const SAFE_HOST_ID = /^ddr_host_[a-f0-9]{26}$/;
const SAFE_STORAGE_ID = /^ddr_storage_[a-f0-9]{26}$/;

class VmMigrationError extends Error {
  constructor(message, code = 'VM_MIGRATION_ERROR', status = 400, details = null) {
    super(message); this.name = 'VmMigrationError'; this.code = code; this.status = status; this.details = details;
  }
}

function _blocker(type, reason, source = 'common') { return { type, reason, source }; }

function _selection(input = {}) {
  const targetId = String(input.targetId || '');
  const mode = String(input.mode || '');
  const targetStorageId = input.targetStorageId == null || input.targetStorageId === ''
    ? null : String(input.targetStorageId);
  if (!SAFE_HOST_ID.test(targetId)) throw new VmMigrationError('Canonical target host is required', 'INVALID_MIGRATION_TARGET');
  if (!MODES.includes(mode)) throw new VmMigrationError('Migration mode must be live, cold, or storage', 'INVALID_MIGRATION_MODE');
  if (targetStorageId && !SAFE_STORAGE_ID.test(targetStorageId)) {
    throw new VmMigrationError('Canonical target storage is invalid', 'INVALID_MIGRATION_STORAGE');
  }
  if (mode !== 'storage' && targetStorageId) {
    throw new VmMigrationError('Target storage is accepted only for storage migration', 'INVALID_MIGRATION_STORAGE');
  }
  return { targetId, mode, targetStorageId };
}

function _semanticPlan(plan) {
  return {
    schemaVersion: plan.schemaVersion, provider: plan.provider, vm: plan.vm,
    sourceTargetId: plan.sourceTargetId, target: plan.target, mode: plan.mode,
    targetStorage: plan.targetStorage, basePlanHash: plan.basePlanHash,
    selectedMode: {
      state: plan.selectedMode.state, blockers: plan.selectedMode.blockers,
      warnings: plan.selectedMode.warnings, estimate: plan.selectedMode.estimate,
    },
    blockers: plan.blockers, warnings: plan.warnings,
    expectedPowerState: plan.expectedPowerState, validUntil: plan.validUntil,
  };
}

function _identityReady(id, host, kind, database) {
  const value = identityStore.resolveCanonical(id, { hostId: Number(host.id), kind }, database);
  return !!value && value.providerType === host.daemon_type && value.stability !== 'transient';
}

async function _storage(host, selection, registry, database) {
  if (selection.mode !== 'storage') return { selected: null, options: [] };
  let items = [];
  try {
    const envelope = await registry.resourcesForHost(host, 'storages', { limit: 500, database });
    items = envelope.items.filter(item => item.status?.accessible !== false
      && String(item.status?.maintenanceMode || '').toLowerCase() !== 'inmaintenance');
  } catch { /* explicit selection is still blocked below when resolution is required */ }
  const options = items.map(item => ({
    id: item.id, displayName: item.displayName, type: item.spec?.type || null,
    freeBytes: item.status?.freeBytes || null, shared: item.spec?.shared,
  }));
  const selected = selection.targetStorageId
    ? items.find(item => item.id === selection.targetStorageId) || null : null;
  return { selected, options };
}

async function preflightForHost(host, resourceId, input = {}, options = {}) {
  if (!host || !Number.isInteger(Number(host.id)) || !SAFE_VM_ID.test(String(resourceId || ''))) {
    throw new VmMigrationError('Virtual machine was not found', 'PROVIDER_VM_NOT_FOUND', 404);
  }
  const selection = _selection(input);
  const database = options.database || getDb();
  const registry = options.registry || registrySingleton;
  const operations = options.operations || operationsSingleton;
  const policy = options.policy || policySingleton;
  const enabled = options.enabled === undefined ? config.features.providerVmMigration : options.enabled === true;
  const base = await migrationPreflight.preflightForHost(host, resourceId, {
    database, registry, executionEnabled: enabled,
  });
  const candidate = base.candidates.find(item => item.target.id === selection.targetId);
  if (!candidate) throw new VmMigrationError('Migration target was not found in this endpoint', 'PROVIDER_MIGRATION_TARGET_NOT_FOUND', 404);
  const selectedMode = candidate.modes[selection.mode];
  const blockers = [...(selectedMode?.blockers || [])];
  const warnings = [...(selectedMode?.warnings || []), ...(base.warnings || []).map(reason => _blocker('PROVIDER_WARNING', reason, 'provider'))];
  if (selectedMode?.state !== 'ready' && blockers.length === 0) {
    blockers.push(_blocker('MIGRATION_MODE_NOT_READY', `The ${selection.mode} migration mode is ${selectedMode?.state || 'unknown'}`));
  }
  if (!enabled) blockers.push(_blocker('RELEASE_DISABLED', 'Native VM migration is disabled by the release flag'));
  if (options.canOperate !== true) blockers.push(_blocker('PERMISSION_DENIED', 'Host operate permission is required'));
  const decision = policy.evaluate({ providerType: host.daemon_type, hostId: Number(host.id) });
  if (!decision.allowed) blockers.push(_blocker(decision.code || 'OPERATION_POLICY_BLOCKED', decision.reason || 'Provider operation policy blocks migration', 'policy'));
  const capability = base.capabilityMatrix && (await registry.capabilitiesForHost(host)).features?.['vm.migrate'];
  if (!['supported', 'conditional'].includes(capability?.state)) {
    blockers.push(_blocker('MIGRATION_EXECUTION_UNSUPPORTED', capability?.reason || 'Provider migration execution is unavailable', 'provider'));
  }
  if (!base.sourceTargetId) blockers.push(_blocker('SOURCE_PLACEMENT_UNKNOWN', 'Current VM host could not be resolved'));
  if (!_identityReady(resourceId, host, 'virtualMachine', database)
    || !_identityReady(selection.targetId, host, 'host', database)) {
    blockers.push(_blocker('UNSTABLE_PROVIDER_IDENTITY', 'Stable VM and target identities are required'));
  }
  let active = [];
  try {
    active = operations.list({ hostId: Number(host.id), limit: 500 })
      .filter(operation => !TERMINAL_STATES.has(operation.state)
        && (operation.resource.id === resourceId || operation.resource.id === selection.targetId));
  } catch { blockers.push(_blocker('OPERATION_STATE_UNAVAILABLE', 'Active operation state could not be verified')); }
  if (active.length) blockers.push(_blocker('ACTIVE_OPERATION_CONFLICT', 'Another provider operation is active for this VM or target'));

  const storage = await _storage(host, selection, registry, database);
  if (selection.mode === 'storage') {
    if (host.daemon_type === 'xen') {
      blockers.push(_blocker('STORAGE_MAPPING_UNSUPPORTED', 'Same-pool Xen storage remapping is not part of this execution workflow', 'provider'));
    }
    if (host.daemon_type === 'vsphere' && !selection.targetStorageId) {
      blockers.push(_blocker('TARGET_STORAGE_REQUIRED', 'vSphere storage relocation requires a canonical target datastore'));
    }
    if (host.daemon_type === 'proxmox' && !selection.targetStorageId
      && (selectedMode?.warnings || []).some(item => item.type === 'TARGET_STORAGE_SELECTION_REQUIRED')) {
      blockers.push(_blocker('TARGET_STORAGE_REQUIRED', 'Proxmox local disks require a canonical destination storage'));
    }
    if (selection.targetStorageId && (!storage.selected
      || !_identityReady(selection.targetStorageId, host, 'storage', database))) {
      blockers.push(_blocker('TARGET_STORAGE_UNAVAILABLE', 'Selected target storage is not currently accessible'));
    }
  }
  const validUntil = new Date((Math.floor(Date.now() / PLAN_TTL_MS) + 1) * PLAN_TTL_MS).toISOString();
  const expectedPowerState = selection.mode === 'cold' ? 'stopped' : base.vm.powerState;
  const plan = {
    schemaVersion: '1.0', generatedAt: new Date().toISOString(),
    provider: base.provider, vm: base.vm, sourceTargetId: base.sourceTargetId,
    target: candidate.target, mode: selection.mode,
    targetStorage: storage.selected ? {
      id: storage.selected.id, displayName: storage.selected.displayName,
      type: storage.selected.spec?.type || null,
    } : null,
    storageOptions: storage.options, selectedMode, basePlanHash: base.planHash,
    allowed: blockers.length === 0, blockers: blockers.slice(0, 64), warnings: warnings.slice(0, 64),
    expectedPowerState, confirmation: { required: true, mode: 'typed_name', expected: base.vm.displayName },
    validUntil, scope: { sameEndpointOnly: true, crossProvider: false },
  };
  plan.planHash = sha256(JSON.stringify(_semanticPlan(plan)));
  return plan;
}

function _assertSubmission(plan, input) {
  if (!plan.allowed) throw new VmMigrationError('VM migration preflight is blocked', 'VM_MIGRATION_PREFLIGHT_BLOCKED', 409, plan.blockers);
  if (!/^[a-f0-9]{64}$/.test(String(input.planHash || '')) || input.planHash !== plan.planHash) {
    throw new VmMigrationError('VM migration preflight changed; review the new plan', 'VM_MIGRATION_PREFLIGHT_STALE', 409);
  }
  if (Date.parse(plan.validUntil) <= Date.now()) {
    throw new VmMigrationError('VM migration preflight expired', 'VM_MIGRATION_PREFLIGHT_STALE', 409);
  }
  if (input.confirm !== true) throw new VmMigrationError('VM migration requires confirm=true', 'VM_MIGRATION_CONFIRMATION_REQUIRED');
  if (input.confirmName !== plan.vm.displayName) {
    throw new VmMigrationError('VM migration requires the exact VM name', 'VM_MIGRATION_TYPED_CONFIRMATION_REQUIRED');
  }
}

async function submitForHost(host, resourceId, input = {}, options = {}) {
  const plan = await preflightForHost(host, resourceId, input, options);
  _assertSubmission(plan, input);
  const operations = options.operations || operationsSingleton;
  const lockScopes = [`resource:${plan.vm.id}`, `resource:${plan.target.id}`];
  if (plan.targetStorage) lockScopes.push(`resource:${plan.targetStorage.id}`);
  const operation = operations.create({
    type: TYPE, providerType: host.daemon_type, hostId: Number(host.id),
    resourceKind: 'virtualMachine', resourceId: plan.vm.id, action: plan.mode,
    idempotencyKey: input.idempotencyKey,
    request: {
      targetId: plan.target.id, targetStorageId: plan.targetStorage?.id || null,
      sourceTargetId: plan.sourceTargetId, mode: plan.mode,
      expectedPowerState: plan.expectedPowerState, planHash: plan.planHash,
    },
    lockScopes, createdBy: options.createdBy,
  });
  return { plan, operation };
}

module.exports = {
  TYPE, MODES, VmMigrationError, preflightForHost, submitForHost,
  _internals: { _selection, _semanticPlan, _assertSubmission, _identityReady, _storage },
};
