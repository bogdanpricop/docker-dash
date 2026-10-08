'use strict';

const config = require('../../../config');
const { getDb } = require('../../../db');
const managedStore = require('../../provider-sdk/managed-volume-store');
const snapshotStore = require('../../provider-sdk/vm-snapshot-store');
const bridge = require('../disk-provider');

const TYPE = 'vm.disk';
const VERIFY_TIMEOUT_MS = 60 * 60 * 1000;
const PENDING = new Set(['pending', 'queued', 'running', 'created']);
const SUCCEEDED = new Set(['success', 'succeeded', 'completed', 'complete']);
const FAILED = new Set(['failure', 'failed', 'error', 'cancelled', 'canceled']);

function _taskRef(provider, result) {
  const ref = typeof result?.taskRef === 'string' ? result.taskRef : null;
  if (ref && ref.length > 1600) return null;
  const task = ref ? { provider, ref } : { provider, synchronous: true };
  if (provider === 'proxmox' && ref) task.node = result.node;
  if (typeof result?.backingRef === 'string' && result.backingRef.length <= 2048) task.backingRef = result.backingRef;
  return JSON.stringify(task);
}

function _parseTask(value, provider) {
  if (!value) return null;
  try {
    const task = JSON.parse(value);
    if (task?.provider !== provider) return null;
    if (task.synchronous !== true && (typeof task.ref !== 'string' || !task.ref || task.ref.length > 1600)) return null;
    if (task.node !== undefined && !/^[A-Za-z0-9._-]{1,160}$/.test(task.node)) return null;
    if (task.backingRef !== undefined && (typeof task.backingRef !== 'string' || task.backingRef.length > 2048)) return null;
    return task;
  } catch { return null; }
}

function _taskOutcome(provider, status) {
  const state = String(status?.status || status?.state || '').toLowerCase();
  if (provider === 'proxmox' && state === 'stopped') {
    return String(status?.exitstatus || '').toUpperCase() === 'OK'
      ? { done: true, progress: 100 }
      : { failed: true, message: status?.exitstatus || 'Proxmox disk task failed' };
  }
  if (SUCCEEDED.has(state)) return { done: true, progress: 100 };
  if (FAILED.has(state)) return { failed: true, message: status?.error || 'Provider disk task failed' };
  if (PENDING.has(state) || !state || state === 'unknown') {
    const raw = Number(status?.progress);
    const progress = Number.isFinite(raw) ? (raw <= 1 ? raw * 100 : raw) : 70;
    return { pending: true, progress: Math.max(5, Math.min(94, Math.round(progress))) };
  }
  return { pending: true, progress: 70 };
}

function _host(operation, database) {
  const host = database.prepare('SELECT * FROM docker_hosts WHERE id=? AND is_active=1')
    .get(operation.provider.endpointId);
  if (!host || host.daemon_type !== operation.provider.type) {
    throw Object.assign(new Error('Provider endpoint is unavailable'), { code: 'INVALID_OPERATION_HOST' });
  }
  return host;
}

function _deadline(operation) {
  const started = Date.parse(operation.startedAt || operation.createdAt || 0);
  return Number.isFinite(started) ? started + VERIFY_TIMEOUT_MS : Date.now() + VERIFY_TIMEOUT_MS;
}

function _request(context) {
  const request = context.request || {};
  if (!/^[a-f0-9]{64}$/.test(String(request.planHash || ''))
    || (request.diskId && !/^ddh_disk_[a-f0-9]{26}$/.test(String(request.diskId)))
    || (request.managedVolumeId && !managedStore.SAFE_ID.test(String(request.managedVolumeId)))) {
    throw Object.assign(new Error('Stored disk operation request is invalid'), { code: 'INVALID_VM_DISK_REQUEST' });
  }
  return request;
}

function _findCreated(current, request) {
  const matches = current.disks.filter(item => item.portable.type === 'disk'
    && item.portable.bus === request.bus && item.portable.unit === request.unit
    && Number(item.portable.capacityBytes) >= Number(request.sizeBytes));
  return matches.length === 1 ? matches[0] : null;
}

function _recentVerifiedRecovery(database, hostId, vmId) {
  const rows = database.prepare(`SELECT recovery_point_json, created_at FROM provider_recovery_points
    WHERE host_id=? AND workload_id=? ORDER BY created_at DESC LIMIT 100`).all(hostId, vmId);
  const maxAge = Number(config.providerVmDisks?.deletionRecoveryMaxAgeHours || 24) * 60 * 60 * 1000;
  return rows.some(row => {
    try {
      const point = JSON.parse(row.recovery_point_json);
      const age = Date.now() - Date.parse(row.created_at || point.createdAt || 0);
      return point?.verification?.state === 'verified' && Number.isFinite(age) && age >= 0 && age <= maxAge;
    } catch { return false; }
  });
}

async function _verify(context, target, database, task = {}) {
  const request = _request(context);
  const action = context.operation.action;
  if (action === 'delete') {
    const managed = managedStore.resolve(request.managedVolumeId,
      { hostId: context.operation.provider.endpointId }, database);
    if (!managed) return { state: 'unknown', result: { managedVolumeId: request.managedVolumeId, ownershipMissing: true } };
    if (!(await bridge.backingExists(target, managed))) {
      managedStore.transition(managed.id, { hostId: managed.hostId }, 'deleted', { operationId: context.operation.id }, database);
      return { state: 'succeeded', phase: 'verified', result: {
        managedVolumeId: managed.id, deleted: true, verified: true,
      } };
    }
  } else {
    const current = await bridge.inventory(target);
    if (action === 'create') {
      const created = _findCreated(current, request);
      if (created) {
        let managed = managedStore.findForDisk(context.operation.provider.endpointId,
          context.operation.resource.id, created.portable.id, database);
        if (!managed) {
          const nativeRef = bridge.backingRef(created) || task.backingRef;
          if (!nativeRef) return { state: 'unknown', result: { diskId: created.portable.id, ownershipUnproven: true } };
          managed = managedStore.create({
            hostId: context.operation.provider.endpointId, vmId: context.operation.resource.id,
            providerType: context.operation.provider.type, nativeRef, diskId: created.portable.id,
            label: request.label, storageId: request.targetStorageId, bus: request.bus, unit: request.unit,
            capacityBytes: Number(created.portable.capacityBytes), state: 'attached',
            operationId: context.operation.id, createdBy: context.operation.createdBy,
          }, database);
        }
        return { state: 'succeeded', phase: 'verified', result: {
          diskId: created.portable.id, managedVolumeId: managed.id,
          capacityBytes: created.portable.capacityBytes, storageId: request.targetStorageId,
          verified: true, guestExpansionRequired: false,
        } };
      }
    } else if (action === 'detach') {
      if (!bridge.diskById(current, request.diskId)) {
        const managed = managedStore.findForDisk(context.operation.provider.endpointId,
          context.operation.resource.id, request.diskId, database);
        if (managed) managedStore.transition(managed.id, { hostId: managed.hostId }, 'detached', {
          diskId: null, operationId: context.operation.id,
        }, database);
        return { state: 'succeeded', phase: 'verified', result: {
          diskId: request.diskId, managedVolumeId: managed?.id || null,
          detached: true, backingRetained: true, verified: true,
        } };
      }
    } else if (action === 'resize') {
      const disk = bridge.diskById(current, request.diskId);
      if (disk && Number(disk.portable.capacityBytes) >= Number(request.sizeBytes)) {
        const managed = managedStore.findForDisk(context.operation.provider.endpointId,
          context.operation.resource.id, request.diskId, database);
        if (managed) managedStore.transition(managed.id, { hostId: managed.hostId }, 'attached', {
          capacityBytes: Number(disk.portable.capacityBytes), operationId: context.operation.id,
        }, database);
        return { state: 'succeeded', phase: 'verified', result: {
          diskId: request.diskId, capacityBytes: disk.portable.capacityBytes,
          verified: true, guestExpansionRequired: true,
        } };
      }
    } else if (action === 'move') {
      const disk = bridge.diskById(current, request.diskId);
      if (disk && (!request.targetStorageName
        || disk.portable.backing?.storageName === request.targetStorageName)) {
        const managed = managedStore.findForDisk(context.operation.provider.endpointId,
          context.operation.resource.id, request.diskId, database);
        if (managed) managedStore.transition(managed.id, { hostId: managed.hostId }, 'attached', {
          storageId: request.targetStorageId, operationId: context.operation.id,
        }, database);
        return { state: 'succeeded', phase: 'verified', result: {
          diskId: request.diskId, storageId: request.targetStorageId, verified: true,
        } };
      }
    }
  }
  if (Date.now() < _deadline(context.operation)) {
    context.reportProgress(95, 'post-verify', 'Waiting for disk inventory verification');
    return { state: 'reconciling', phase: 'post-verify', delayMs: 2000 };
  }
  return { state: 'unknown', result: { diskId: request.diskId || null, expected: action } };
}

async function execute(context, options = {}) {
  const database = options.database || getDb();
  const request = _request(context);
  const host = _host(context.operation, database);
  if (config.features.providerVmDiskLifecycle !== true && options.enabled !== true) {
    throw Object.assign(new Error('VM disk lifecycle is disabled'), { code: 'VM_DISK_LIFECYCLE_DISABLED' });
  }
  const target = await bridge.open(host, context.operation.resource.id, database);
  try {
    if (context.operation.action === 'delete') {
      if (config.features.providerVmDiskDelete !== true && options.deleteEnabled !== true) {
        throw Object.assign(new Error('Managed-volume deletion is disabled'), { code: 'VM_DISK_DELETE_DISABLED' });
      }
      const managed = managedStore.resolve(request.managedVolumeId,
        { hostId: context.operation.provider.endpointId }, database);
      if (!managed || managed.vmId !== context.operation.resource.id || managed.state !== 'detached') {
        throw Object.assign(new Error('Managed detached-volume ownership could not be proven'), { code: 'VM_DISK_OWNERSHIP_UNPROVEN' });
      }
      if (snapshotStore.list(managed.hostId, managed.vmId, database).length
        || !_recentVerifiedRecovery(database, managed.hostId, managed.vmId)) {
        throw Object.assign(new Error('Deletion recovery or snapshot safety evidence changed'), { code: 'VM_DISK_DELETE_SAFETY_CHANGED' });
      }
      managedStore.transition(managed.id, { hostId: managed.hostId }, 'deleting', { operationId: context.operation.id }, database);
      context.reportProgress(20, 'pre-submit', 'Managed-volume ownership and recovery evidence revalidated');
      const result = await bridge.deleteBacking(target, managed);
      const nativeTaskRef = _taskRef(host.daemon_type, result);
      const task = _parseTask(nativeTaskRef, host.daemon_type);
      if (task?.synchronous) return _verify(context, target, database, task);
      return { state: 'reconciling', nativeTaskRef, nativeTaskState: 'pending', phase: 'native-task', delayMs: 1000 };
    }
    const current = await bridge.inventory(target);
    let disk = null;
    if (context.operation.action === 'create') {
      if (current.disks.some(item => item.portable.bus === request.bus && item.portable.unit === request.unit)) {
        throw Object.assign(new Error('Disk slot changed before execution'), { code: 'VM_DISK_SLOT_CONFLICT' });
      }
    } else {
      disk = bridge.diskById(current, request.diskId);
      if (!disk) throw Object.assign(new Error('Provider disk was not found'), { code: 'PROVIDER_VM_DISK_NOT_FOUND' });
      if (disk.portable.type !== 'disk' || disk.portable.attachment?.readOnly !== false) {
        throw Object.assign(new Error('Disk safety evidence changed before execution'), { code: 'VM_DISK_SAFETY_CHANGED' });
      }
      if (context.operation.action === 'resize'
        && Number(request.sizeBytes) <= Number(disk.portable.capacityBytes)) {
        throw Object.assign(new Error('Disk resize would not be a strict expansion'), { code: 'VM_DISK_SHRINK_FORBIDDEN' });
      }
      if (context.operation.action === 'detach'
        && snapshotStore.list(context.operation.provider.endpointId, context.operation.resource.id, database).length) {
        throw Object.assign(new Error('Snapshot dependency changed before detach'), { code: 'VM_DISK_SNAPSHOT_DEPENDENCY' });
      }
    }
    context.reportProgress(20, 'pre-submit', 'Disk identity, slot and safety state revalidated');
    const result = await bridge.mutate(target, context.operation.action, request, disk, database);
    const nativeTaskRef = _taskRef(host.daemon_type, result);
    const task = _parseTask(nativeTaskRef, host.daemon_type);
    if (task?.synchronous) return _verify(context, target, database, task);
    return { state: 'reconciling', nativeTaskRef, nativeTaskState: 'pending', phase: 'native-task', delayMs: 1000 };
  } finally { await bridge.close(target); }
}

async function reconcile(context, options = {}) {
  const database = options.database || getDb();
  const host = _host(context.operation, database);
  const target = await bridge.open(host, context.operation.resource.id, database);
  try {
    const task = _parseTask(context.nativeTaskRef, host.daemon_type);
    if (task?.ref) {
      const outcome = _taskOutcome(host.daemon_type, await bridge.taskStatus(target, task));
      if (outcome.failed) throw Object.assign(new Error(outcome.message), { code: 'PROVIDER_TASK_FAILED' });
      if (outcome.pending) {
        if (Date.now() >= _deadline(context.operation)) return { state: 'unknown', result: { nativeTaskTimedOut: true } };
        context.reportProgress(outcome.progress, 'native-task', 'Waiting for provider disk task');
        return { state: 'reconciling', phase: 'native-task', delayMs: 1500 };
      }
    }
    return _verify(context, target, database, task || {});
  } finally { await bridge.close(target); }
}

async function cancel(context, options = {}) {
  const task = _parseTask(context.nativeTaskRef, context.operation.provider.type);
  if (!task?.ref) return { confirmed: false };
  const database = options.database || getDb();
  let target;
  try {
    target = await bridge.open(_host(context.operation, database), context.operation.resource.id, database);
    return { confirmed: await bridge.cancelTask(target, task), result: { providerTaskCancellationRequested: true } };
  } catch { return { confirmed: false }; }
  finally { await bridge.close(target); }
}

function register(engine, options = {}) {
  engine.registerHandler({
    type: TYPE, idempotent: false, retryPolicy: 'none', timeoutSeconds: 300,
    execute: context => execute(context, options),
    reconcile: context => reconcile(context, options),
    cancel: context => cancel(context, options),
  });
}

module.exports = {
  TYPE, register, execute, reconcile, cancel,
  _internals: { _taskRef, _parseTask, _taskOutcome, _host, _deadline, _request, _findCreated, _recentVerifiedRecovery, _verify },
};
