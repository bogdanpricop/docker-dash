'use strict';

const config = require('../../config');
const { getDb } = require('../../db');
const { sha256 } = require('../../utils/crypto');
const registrySingleton = require('../provider-sdk/registry');
const managedStore = require('../provider-sdk/managed-volume-store');
const snapshotStore = require('../provider-sdk/vm-snapshot-store');
const operationsSingleton = require('./index');
const policySingleton = require('./policy');
const { TYPE } = require('./handlers/vm-disk');

const SAFE_VM_ID = /^ddr_vm_[a-f0-9]{26}$/;
const SAFE_DISK_ID = /^ddh_disk_[a-f0-9]{26}$/;
const SAFE_STORAGE_ID = /^ddr_storage_[a-f0-9]{26}$/;
const ACTIVE_STATES = new Set(['queued', 'running', 'waiting_retry', 'reconciling', 'cancel_requested', 'unknown']);
const ACTIONS = Object.freeze({
  create: 'vm.disk.create', detach: 'vm.disk.detach', resize: 'vm.disk.resize',
  move: 'vm.disk.move', delete: 'vm.disk.delete',
});

class VmDiskError extends Error {
  constructor(message, code = 'VM_DISK_ERROR', status = 400, details = null) {
    super(message); this.name = 'VmDiskError'; this.code = code; this.status = status; this.details = details;
  }
}

function _text(value, max) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function _canonical(value) {
  if (Array.isArray(value)) return `[${value.map(_canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${_canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function _blocker(type, reason, evidence = null) { return { type, reason, ...(evidence ? { evidence } : {}) }; }
function _database(options) { return options.database || getDb(); }
function _registry(options) { return options.registry || registrySingleton; }
function _operations(options) { return options.operations || operationsSingleton; }
function _policy(options) { return options.policy || policySingleton; }

function _size(value) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < Number(config.providerVmDisks?.minimumSizeBytes || 64 * 1024 * 1024)) {
    throw new VmDiskError('Disk size must be an exact safe integer above the configured minimum', 'INVALID_VM_DISK_SIZE');
  }
  return size;
}

function _label(value) {
  const label = _text(value, 160);
  if (!label || label.length > 160) throw new VmDiskError('Disk label is required', 'INVALID_VM_DISK_LABEL');
  return label;
}

function _defaults(providerType, hardware) {
  if (providerType === 'proxmox') return { bus: 'scsi', maxUnit: 30 };
  if (providerType === 'xen') return { bus: 'xen-vbd', maxUnit: 63 };
  const bus = hardware.disks.find(item => item.type === 'disk' && item.bus)?.bus || null;
  return { bus, maxUnit: 15 };
}

function _deviceSlot(providerType, hardware, input) {
  const defaults = _defaults(providerType, hardware);
  const bus = _text(input.bus ?? defaults.bus, 40);
  const allowed = providerType === 'proxmox' ? ['scsi', 'virtio']
    : providerType === 'xen' ? ['xen-vbd'] : [...new Set(hardware.disks.map(item => item.bus).filter(Boolean))];
  if (!bus || !allowed.includes(bus)) throw new VmDiskError('Requested disk bus is unavailable for this VM', 'VM_DISK_BUS_UNAVAILABLE');
  const used = new Set(hardware.disks.filter(item => item.bus === bus && Number.isInteger(item.unit)).map(item => item.unit));
  let unit;
  if (input.unit === undefined || input.unit === null || input.unit === '') {
    unit = Array.from({ length: defaults.maxUnit + 1 }, (_, index) => index).find(index => !used.has(index));
  } else unit = Number(input.unit);
  if (!Number.isInteger(unit) || unit < 0 || unit > defaults.maxUnit || used.has(unit)) {
    throw new VmDiskError('Requested disk unit is invalid or already in use', 'VM_DISK_SLOT_CONFLICT');
  }
  return { bus, unit };
}

function _activeOperations(operations, hostId, vmId) {
  try {
    return operations.list({ hostId, limit: 500 })
      .filter(item => ACTIVE_STATES.has(item.state) && item.resource?.id === vmId);
  } catch { return [{ id: null, state: 'unknown' }]; }
}

async function _context(host, vmIdInput, options = {}) {
  const vmId = String(vmIdInput || '');
  if (!SAFE_VM_ID.test(vmId)) throw new VmDiskError('Virtual machine was not found', 'PROVIDER_VM_NOT_FOUND', 404);
  const database = _database(options); const registry = _registry(options);
  const inventory = await registry.resourcesForHost(host, 'virtual-machines', { limit: 500, database });
  const vm = inventory.items.find(item => item.id === vmId);
  if (!vm) throw new VmDiskError('Virtual machine was not found', 'PROVIDER_VM_NOT_FOUND', 404);
  if (vm.identity?.stability === 'transient') {
    throw new VmDiskError('Stable VM identity is required for disk lifecycle operations', 'UNSTABLE_RESOURCE_IDENTITY', 409);
  }
  const [hardware, capabilities, storages] = await Promise.all([
    registry.vmHardwareForHost(host, vm, { database }),
    registry.capabilitiesForHost(host),
    registry.resourcesForHost(host, 'storages', { limit: 500, database }),
  ]);
  let policy;
  try { policy = _policy(options).evaluate({ providerType: host.daemon_type, hostId: Number(host.id) }); }
  catch { policy = { allowed: false, code: 'POLICY_UNAVAILABLE', mode: 'unknown', reason: 'Operation policy is unavailable' }; }
  return {
    host, database, vm, hardware, capabilities, storages, policy,
    snapshots: snapshotStore.list(Number(host.id), vmId, database),
    managed: managedStore.list(Number(host.id), { vmId, includeDeleted: false, limit: 500 }, database),
    activeOperations: _activeOperations(_operations(options), Number(host.id), vmId),
    canOperate: options.canOperate === true,
    enabled: options.enabled === undefined ? config.features.providerVmDiskLifecycle : options.enabled === true,
    deleteEnabled: options.deleteEnabled === undefined ? config.features.providerVmDiskDelete : options.deleteEnabled === true,
  };
}

async function inventoryForHost(host, vmId, options = {}) {
  const context = await _context(host, vmId, options);
  const byDisk = new Map(context.managed.filter(item => item.diskId).map(item => [item.diskId, item]));
  return {
    schemaVersion: '1.0', hostId: Number(host.id), providerType: host.daemon_type,
    vm: { id: context.vm.id, displayName: context.vm.displayName, powerState: context.vm.status?.powerState || 'unknown' },
    summary: context.hardware.summary, sections: context.hardware.sections,
    disks: context.hardware.disks.map(disk => ({
      ...disk, ownership: byDisk.has(disk.id)
        ? { managed: true, managedVolumeId: byDisk.get(disk.id).id, scope: 'docker_dash_created' }
        : { managed: false, managedVolumeId: null, scope: 'provider_existing' },
    })),
    managedVolumes: context.managed,
    release: { lifecycleEnabled: context.enabled, deleteEnabled: context.deleteEnabled },
    observedAt: context.hardware.observedAt,
  };
}

function _baseBlockers(context, capabilityKey) {
  const blockers = [];
  const capability = context.capabilities.features?.[capabilityKey]
    || { state: 'unknown', reason: 'Disk capability evidence is unavailable', constraints: {} };
  if (!context.enabled) blockers.push(_blocker('RELEASE_DISABLED', 'VM disk lifecycle is disabled by release policy', { code: 'DD_PROVIDER_VM_DISK_LIFECYCLE' }));
  if (!context.canOperate) blockers.push(_blocker('PERMISSION_BLOCKED', 'Operate permission is required for this endpoint'));
  if (!context.policy.allowed) blockers.push(_blocker('POLICY_BLOCKED', context.policy.reason,
    { code: context.policy.code, mode: context.policy.mode }));
  if (!['supported', 'conditional'].includes(capability.state)) blockers.push(_blocker(
    capability.state === 'unknown' ? 'CAPABILITY_UNKNOWN' : 'CAPABILITY_UNSUPPORTED',
    capability.reason || 'Disk action is unavailable', { capability: capabilityKey, state: capability.state }));
  if (context.activeOperations.length) blockers.push(_blocker('OPERATION_CONFLICT',
    'Another provider operation is active for this VM', context.activeOperations[0]));
  return { blockers, capability };
}

function _storage(context, id, sizeBytes, blockers, warnings, currentDisk = null) {
  if (!SAFE_STORAGE_ID.test(String(id || ''))) {
    blockers.push(_blocker('TARGET_STORAGE_REQUIRED', 'A canonical target storage is required')); return null;
  }
  const storage = context.storages.items.find(item => item.id === id) || null;
  if (!storage) { blockers.push(_blocker('TARGET_STORAGE_UNAVAILABLE', 'Target storage was not found')); return null; }
  if (storage.status?.accessible === false) blockers.push(_blocker('TARGET_STORAGE_OFFLINE', 'Target storage is not accessible'));
  const content = String(storage.extensions?.contentType || '').split(',').map(item => item.trim()).filter(Boolean);
  if (context.host.daemon_type === 'proxmox' && content.length && !content.includes('images')) {
    blockers.push(_blocker('TARGET_STORAGE_CONTENT_UNSUPPORTED', 'Target storage does not support VM disk images'));
  }
  const free = Number(storage.status?.freeBytes);
  const headroom = Number(config.providerVmDisks?.capacityHeadroomPercent || 10);
  const required = Math.ceil(sizeBytes * (1 + headroom / 100));
  if (Number.isFinite(free) && free >= 0 && free < required) {
    blockers.push(_blocker('TARGET_STORAGE_CAPACITY_INSUFFICIENT', 'Target storage does not satisfy capacity headroom',
      { freeBytes: free, requiredBytes: required, headroomPercent: headroom }));
  } else if (!Number.isFinite(free)) warnings.push({ type: 'TARGET_STORAGE_CAPACITY_UNKNOWN', reason: 'Target free capacity was not reported' });
  if (currentDisk && storage.displayName && currentDisk.backing?.storageName
    && storage.displayName === currentDisk.backing.storageName) {
    blockers.push(_blocker('TARGET_STORAGE_UNCHANGED', 'Target storage is the current disk storage'));
  }
  return storage;
}

function _diskSafety(context, disk, action, blockers, warnings, managed) {
  if (disk.type !== 'disk') blockers.push(_blocker('VM_DISK_TYPE_UNSAFE', 'Only data disks can use this action', { type: disk.type }));
  if (disk.attachment?.readOnly !== false) blockers.push(_blocker('VM_DISK_READ_ONLY_OR_UNKNOWN', 'Read-only safety must be positively false'));
  if (disk.attachment?.shared !== false) blockers.push(_blocker('VM_DISK_SHARED_OR_UNKNOWN', 'Shared-disk safety must be positively false'));
  if (action === 'detach') {
    if (disk.attachment?.bootable !== false && !managed) blockers.push(_blocker('VM_DISK_BOOT_STATUS_UNPROVEN', 'A foreign disk requires positive non-boot evidence before detach'));
    if (context.vm.status?.powerState === 'running' && disk.capabilities?.hotUnplug !== true) {
      blockers.push(_blocker('VM_DISK_HOT_UNPLUG_UNAVAILABLE', 'Stop the VM or provide positive hot-unplug evidence'));
    }
    if (context.snapshots.length) blockers.push(_blocker('VM_DISK_SNAPSHOT_DEPENDENCY', 'Detach is blocked while VM snapshots exist', { count: context.snapshots.length }));
  }
  if (['resize', 'move'].includes(action) && context.snapshots.length) {
    warnings.push({ type: 'VM_DISK_SNAPSHOT_CHAIN_PRESENT', reason: 'Snapshot chains can increase operation duration and consolidation risk', count: context.snapshots.length });
  }
}

function _semanticPlan(plan) {
  return {
    schemaVersion: plan.schemaVersion, hostId: plan.hostId, providerType: plan.providerType,
    vm: plan.vm, disk: plan.disk, managedVolume: plan.managedVolume, action: plan.action,
    request: plan.request, storage: plan.storage, snapshotCount: plan.snapshotCount,
    capability: { key: plan.capability.key, state: plan.capability.state },
    allowed: plan.allowed, blockers: plan.blockers, warnings: plan.warnings,
    confirmation: plan.confirmation, recoveryPoint: plan.recoveryPoint || null, validUntil: plan.validUntil,
  };
}

async function preflightForHost(host, vmId, actionInput, input = {}, diskIdInput = null, options = {}) {
  const action = String(actionInput || '');
  if (!['create', 'detach', 'resize', 'move'].includes(action)) throw new VmDiskError('Unsupported disk action', 'INVALID_VM_DISK_ACTION');
  const context = await _context(host, vmId, options);
  const { blockers, capability } = _baseBlockers(context, ACTIONS[action]);
  const warnings = [{ type: 'GUEST_FILESYSTEM_OUT_OF_SCOPE', reason: 'Docker Dash does not change guest partitions or filesystems' }];
  let disk = null; let managed = null; let storage = null; let request;
  if (action === 'create') {
    const sizeBytes = _size(input.sizeBytes); const label = _label(input.label);
    const slot = _deviceSlot(host.daemon_type, context.hardware, input);
    const provisioning = ['thin', 'thick'].includes(String(input.provisioning)) ? String(input.provisioning) : 'thin';
    storage = _storage(context, input.targetStorageId, sizeBytes, blockers, warnings);
    request = { label, sizeBytes, bus: slot.bus, unit: slot.unit, provisioning,
      targetStorageId: storage?.id || String(input.targetStorageId || '') };
  } else {
    const diskId = String(diskIdInput || '');
    if (!SAFE_DISK_ID.test(diskId)) throw new VmDiskError('Disk was not found', 'PROVIDER_VM_DISK_NOT_FOUND', 404);
    disk = context.hardware.disks.find(item => item.id === diskId) || null;
    if (!disk) throw new VmDiskError('Disk was not found', 'PROVIDER_VM_DISK_NOT_FOUND', 404);
    managed = managedStore.findForDisk(Number(host.id), context.vm.id, disk.id, context.database);
    _diskSafety(context, disk, action, blockers, warnings, managed);
    if (action === 'resize') {
      const sizeBytes = _size(input.sizeBytes);
      if (!Number.isSafeInteger(Number(disk.capacityBytes))) blockers.push(_blocker('VM_DISK_CAPACITY_UNKNOWN', 'Current disk capacity is unknown'));
      else if (sizeBytes <= Number(disk.capacityBytes)) blockers.push(_blocker('VM_DISK_SHRINK_FORBIDDEN', 'Disk size must grow; shrink and equal-size requests are rejected'));
      if (context.vm.status?.powerState === 'running' && disk.capabilities?.onlineResize !== true) {
        blockers.push(_blocker('VM_DISK_ONLINE_RESIZE_UNAVAILABLE', 'Stop the VM or provide positive online-resize evidence'));
      }
      request = { sizeBytes };
    } else if (action === 'move') {
      storage = _storage(context, input.targetStorageId, Number(disk.capacityBytes) || 0, blockers, warnings, disk);
      request = { targetStorageId: storage?.id || String(input.targetStorageId || '') };
    } else request = { retainBacking: true };
  }
  const ttl = Number(config.providerVmDisks?.planTtlMs || 5 * 60_000);
  const plan = {
    schemaVersion: '1.0', hostId: Number(host.id), providerType: host.daemon_type,
    vm: { id: context.vm.id, displayName: context.vm.displayName, powerState: context.vm.status?.powerState || 'unknown' },
    disk: disk ? {
      id: disk.id, label: disk.label, type: disk.type, bus: disk.bus, unit: disk.unit,
      capacityBytes: disk.capacityBytes, backing: { storageName: disk.backing?.storageName || null },
      attachment: disk.attachment, capabilities: disk.capabilities,
    } : null,
    managedVolume: managed, action, request,
    storage: storage ? { id: storage.id, displayName: storage.displayName,
      freeBytes: storage.status?.freeBytes ?? null, accessible: storage.status?.accessible ?? null } : null,
    snapshotCount: context.snapshots.length,
    capability: { key: ACTIONS[action], state: capability.state, reason: capability.reason || null },
    allowed: blockers.length === 0, blockers, warnings,
    confirmation: { required: true, mode: 'typed_vm_name', expected: context.vm.displayName },
    validUntil: new Date((Math.floor(Date.now() / ttl) + 1) * ttl).toISOString(),
  };
  plan.planHash = sha256(_canonical(_semanticPlan(plan)));
  return plan;
}

function _latestVerifiedRecovery(database, hostId, vmId) {
  const rows = database.prepare(`SELECT canonical_id, recovery_point_json, created_at
    FROM provider_recovery_points WHERE host_id=? AND workload_id=? ORDER BY created_at DESC LIMIT 100`)
    .all(hostId, vmId);
  for (const row of rows) {
    try {
      const point = JSON.parse(row.recovery_point_json);
      if (point?.verification?.state === 'verified') return { id: row.canonical_id, createdAt: row.created_at || point.createdAt };
    } catch { /* malformed evidence is ignored */ }
  }
  return null;
}

async function preflightDeleteForHost(host, volumeId, _input = {}, options = {}) {
  const database = _database(options);
  const managed = managedStore.resolve(volumeId, { hostId: Number(host.id) }, database);
  if (!managed || managed.providerType !== host.daemon_type || managed.state === 'deleted') {
    throw new VmDiskError('Managed volume was not found', 'MANAGED_VOLUME_NOT_FOUND', 404);
  }
  const context = await _context(host, managed.vmId, { ...options, database });
  const { blockers, capability } = _baseBlockers(context, ACTIONS.delete);
  const warnings = [{ type: 'PERMANENT_DATA_REMOVAL', reason: 'Backing deletion is permanent and detach is not a substitute for backup' }];
  if (!context.deleteEnabled) blockers.push(_blocker('DELETE_RELEASE_DISABLED', 'Managed-volume deletion is disabled by release policy', { code: 'DD_PROVIDER_VM_DISK_DELETE' }));
  if (managed.state !== 'detached') blockers.push(_blocker('MANAGED_VOLUME_NOT_DETACHED', 'Managed volume must be positively detached before deletion', { state: managed.state }));
  if (managed.vmId !== context.vm.id) blockers.push(_blocker('MANAGED_VOLUME_SCOPE_MISMATCH', 'Managed volume ownership does not match the VM'));
  if (context.snapshots.length) blockers.push(_blocker('VM_DISK_SNAPSHOT_DEPENDENCY', 'Delete is blocked while VM snapshots exist', { count: context.snapshots.length }));
  const recovery = _latestVerifiedRecovery(database, Number(host.id), context.vm.id);
  const maxAgeMs = Number(config.providerVmDisks?.deletionRecoveryMaxAgeHours || 24) * 60 * 60 * 1000;
  const recoveryAge = recovery?.createdAt ? Date.now() - Date.parse(recovery.createdAt) : Number.POSITIVE_INFINITY;
  if (!recovery || !Number.isFinite(recoveryAge) || recoveryAge < 0 || recoveryAge > maxAgeMs) {
    blockers.push(_blocker('VERIFIED_RECOVERY_POINT_REQUIRED', 'A recent verified VM recovery point is required', {
      maxAgeHours: Number(config.providerVmDisks?.deletionRecoveryMaxAgeHours || 24),
    }));
  }
  const expected = `DELETE VOLUME ${managed.label}`;
  const ttl = Number(config.providerVmDisks?.planTtlMs || 5 * 60_000);
  const plan = {
    schemaVersion: '1.0', hostId: Number(host.id), providerType: host.daemon_type,
    vm: { id: context.vm.id, displayName: context.vm.displayName, powerState: context.vm.status?.powerState || 'unknown' },
    disk: null, managedVolume: { ...managed, nativeRef: undefined, nativeRefHash: undefined },
    action: 'delete', request: { managedVolumeId: managed.id }, storage: null,
    snapshotCount: context.snapshots.length, recoveryPoint: recovery,
    capability: { key: ACTIONS.delete, state: capability.state, reason: capability.reason || null },
    allowed: blockers.length === 0, blockers, warnings,
    confirmation: { required: true, mode: 'typed_volume_phrase', expected },
    validUntil: new Date((Math.floor(Date.now() / ttl) + 1) * ttl).toISOString(),
  };
  plan.planHash = sha256(_canonical(_semanticPlan(plan)));
  return plan;
}

function _assertSubmission(plan, input = {}) {
  if (!plan.allowed) throw new VmDiskError('Disk preflight is blocked', 'VM_DISK_PREFLIGHT_BLOCKED', 409, plan.blockers);
  if (!/^[a-f0-9]{64}$/.test(String(input.planHash || '')) || input.planHash !== plan.planHash) {
    throw new VmDiskError('Disk preflight changed; review the new plan', 'VM_DISK_PREFLIGHT_STALE', 409);
  }
  if (input.confirm !== true || input.confirmName !== plan.confirmation.expected) {
    throw new VmDiskError('Disk operation requires the exact typed confirmation', 'VM_DISK_TYPED_CONFIRMATION_REQUIRED');
  }
}

function _submit(plan, input, options) {
  const engine = _operations(options);
  const storageScopes = [plan.storage?.id].filter(Boolean).map(id => `storage:${id}`);
  return engine.create({
    type: TYPE, providerType: plan.providerType, hostId: plan.hostId,
    resourceKind: 'virtualMachine', resourceId: plan.vm.id, action: plan.action,
    idempotencyKey: input.idempotencyKey,
    request: {
      planHash: plan.planHash, diskId: plan.disk?.id || null,
      managedVolumeId: plan.managedVolume?.id || null,
      label: plan.request.label || null, sizeBytes: plan.request.sizeBytes || null,
      bus: plan.request.bus || null, unit: plan.request.unit ?? null,
      provisioning: plan.request.provisioning || null,
      targetStorageId: plan.request.targetStorageId || null,
      targetStorageName: plan.storage?.displayName || null,
    },
    lockScopes: [`resource:${plan.vm.id}`, ...storageScopes,
      ...(plan.managedVolume?.id ? [`managed-volume:${plan.managedVolume.id}`] : [])],
    createdBy: options.createdBy,
  });
}

async function submitForHost(host, vmId, action, input = {}, diskId = null, options = {}) {
  const plan = await preflightForHost(host, vmId, action, input, diskId, options);
  _assertSubmission(plan, input);
  return { plan, operation: _submit(plan, input, options) };
}

async function submitDeleteForHost(host, volumeId, input = {}, options = {}) {
  const plan = await preflightDeleteForHost(host, volumeId, input, options);
  _assertSubmission(plan, { ...input, confirmName: input.confirmPhrase });
  return { plan, operation: _submit(plan, input, options) };
}

function listManagedForHost(hostId, options = {}) {
  return managedStore.list(Number(hostId), options, _database(options));
}

module.exports = {
  ACTIONS, VmDiskError, inventoryForHost, preflightForHost, submitForHost,
  preflightDeleteForHost, submitDeleteForHost, listManagedForHost,
  _internals: {
    _text, _canonical, _size, _label, _deviceSlot, _storage, _diskSafety,
    _semanticPlan, _latestVerifiedRecovery, _assertSubmission,
  },
};
