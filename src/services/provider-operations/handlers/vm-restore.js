'use strict';

const { getDb } = require('../../../db');
const { fromHostRow } = require('../../proxmox');
const identityStore = require('../../provider-sdk/identity-store');
const recoveryCatalog = require('../../provider-sdk/recovery-point-catalog');
const registry = require('../../provider-sdk/registry');

const TYPE = 'vm.restore';
const RESTORE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const SUBMIT_DISCOVERY_TIMEOUT_MS = 30 * 60 * 1000;
const SAFE_POINT_ID = /^ddr_rp_[a-f0-9]{26}$/;
const SAFE_REPOSITORY_ID = /^ddr_repo_[a-f0-9]{26}$/;
const SAFE_NODE_ID = /^ddr_host_[a-f0-9]{26}$/;
const SAFE_STORAGE_ID = /^ddr_storage_[a-f0-9]{26}$/;
const SAFE_NODE = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_STORAGE = /^[A-Za-z0-9._-]{1,128}$/;

function _host(operation, database) {
  const host = database.prepare('SELECT * FROM docker_hosts WHERE id=? AND is_active=1')
    .get(operation.provider.endpointId);
  if (!host || host.daemon_type !== 'proxmox' || operation.provider.type !== 'proxmox') {
    throw Object.assign(new Error('Proxmox restore endpoint is unavailable'), {
      code: 'RECOVERY_RESTORE_PROVIDER_UNSUPPORTED',
    });
  }
  return host;
}

function _request(context) {
  const request = context.request || {};
  if (!SAFE_POINT_ID.test(String(request.recoveryPointId || ''))
    || !SAFE_REPOSITORY_ID.test(String(request.repositoryId || ''))
    || !SAFE_NODE_ID.test(String(request.targetNodeId || ''))
    || !SAFE_STORAGE_ID.test(String(request.targetStorageId || ''))
    || !/^[a-f0-9]{64}$/.test(String(request.planHash || ''))
    || !['qemu', 'lxc'].includes(request.guestType)
    || !Number.isSafeInteger(Number(request.targetVmid))
    || Number(request.targetVmid) < 100 || Number(request.targetVmid) > 999999999
    || (request.verificationOverride === true
      && (typeof request.overrideReason !== 'string' || request.overrideReason.length < 20
        || request.overrideReason.length > 240 || /[\u0000-\u001f\u007f]/.test(request.overrideReason)))
    || (request.verificationOverride !== true && request.overrideReason != null)
    || request.startAfterRestore !== false || request.liveRestore !== false || request.overwrite !== false) {
    throw Object.assign(new Error('Recovery restore request is invalid'), {
      code: 'INVALID_RECOVERY_RESTORE',
    });
  }
  return { ...request, targetVmid: Number(request.targetVmid) };
}

function _storageIdentity(nativeRef) {
  const value = String(nativeRef || '');
  let match = /^storage\/([^/]+)\/([^/]+)$/.exec(value);
  if (!match) match = /^([^/]+)\/([^/]+)$/.exec(value);
  if (match && SAFE_NODE.test(match[1]) && SAFE_STORAGE.test(match[2])) {
    return { node: match[1], storage: match[2] };
  }
  return SAFE_STORAGE.test(value) ? { node: null, storage: value } : null;
}

function _archive(nativeRef, repositoryNativeRef, targetNode) {
  const pointRef = String(nativeRef || '');
  const repositoryRef = String(repositoryNativeRef || '');
  let archive = pointRef;
  if (pointRef.includes('|')) {
    const separator = pointRef.indexOf('|');
    const prefix = pointRef.slice(0, separator);
    archive = pointRef.slice(separator + 1);
    if (prefix !== repositoryRef) throw Object.assign(new Error('Recovery-point repository identity changed'), {
      code: 'RECOVERY_RESTORE_SOURCE_CHANGED',
    });
  }
  const local = /^([A-Za-z0-9._-]{1,128})@([A-Za-z0-9._-]{1,128})$/.exec(repositoryRef);
  if (local && local[2] !== targetNode) throw Object.assign(new Error('Node-local recovery point cannot be restored on this target node'), {
    code: 'RECOVERY_RESTORE_SOURCE_NODE_MISMATCH',
  });
  if (!/^[A-Za-z0-9._:+/@=-]{1,255}$/.test(archive) || archive === '-') {
    throw Object.assign(new Error('Recovery-point archive identity is invalid'), {
      code: 'INVALID_RECOVERY_RESTORE',
    });
  }
  return archive;
}

function _target(operation, request, database) {
  const point = recoveryCatalog.resolveRecoveryPoint(request.recoveryPointId,
    { hostId: operation.provider.endpointId }, database);
  const repository = recoveryCatalog.resolveRepository(request.repositoryId,
    { hostId: operation.provider.endpointId }, database);
  const node = identityStore.resolveCanonical(request.targetNodeId,
    { hostId: operation.provider.endpointId, kind: 'host' }, database);
  const storage = identityStore.resolveCanonical(request.targetStorageId,
    { hostId: operation.provider.endpointId, kind: 'storage' }, database);
  const storageTarget = _storageIdentity(storage?.nativeRef);
  if (!point || point.providerType !== 'proxmox' || point.repositoryId !== request.repositoryId
    || !repository || repository.providerType !== 'proxmox'
    || !node || node.providerType !== 'proxmox' || !SAFE_NODE.test(node.nativeRef)
    || !storage || storage.providerType !== 'proxmox' || !storageTarget) {
    throw Object.assign(new Error('Recovery restore identities are unavailable'), {
      code: 'RECOVERY_RESTORE_IDENTITY_UNAVAILABLE',
    });
  }
  if (storageTarget.node && storageTarget.node !== node.nativeRef) {
    throw Object.assign(new Error('Restore target storage belongs to a different node'), {
      code: 'RECOVERY_RESTORE_TARGET_STORAGE_NODE_MISMATCH',
    });
  }
  return {
    point, repository, node: node.nativeRef, storage: storageTarget.storage,
    archive: _archive(point.nativeRef, repository.nativeRef, node.nativeRef),
  };
}

function _taskRef(target, upid = null, stage = 'submit') {
  const task = {
    provider: 'proxmox', stage, node: target.node,
    vmid: Number(target.vmid), guestType: target.guestType,
  };
  if (upid) task.upid = upid;
  return JSON.stringify(task);
}

function _parseTask(value) {
  try {
    const task = JSON.parse(value || '{}');
    if (task?.provider !== 'proxmox' || !['submit', 'native'].includes(task.stage)
      || !SAFE_NODE.test(String(task.node || '')) || !['qemu', 'lxc'].includes(task.guestType)
      || !Number.isSafeInteger(Number(task.vmid)) || Number(task.vmid) < 100 || Number(task.vmid) > 999999999
      || (task.stage === 'native' && (typeof task.upid !== 'string' || !task.upid.startsWith('UPID:')))) return null;
    return { ...task, vmid: Number(task.vmid) };
  } catch { return null; }
}

function _deadline(operation, duration = RESTORE_TIMEOUT_MS) {
  const started = Date.parse(operation.startedAt || operation.createdAt || 0);
  return (Number.isFinite(started) ? started : Date.now()) + duration;
}

function _findRawTarget(vms, task) {
  return (vms || []).find(item => Number(item.vmid) === task.vmid
    && String(item.type || 'qemu') === task.guestType);
}

function _manualEvidence(request, extra = {}) {
  return {
    recoveryPointId: request.recoveryPointId, targetVmid: request.targetVmid,
    startAfterRestore: false, overwrite: false,
    partialTargetMayExist: true, automaticCleanupAuthorized: false, ...extra,
  };
}

async function _verify(context, client, task, request, database, duration = RESTORE_TIMEOUT_MS) {
  const raw = _findRawTarget(await client.listVMs(), task);
  if (!raw) {
    if (Date.now() < _deadline(context.operation, duration)) {
      context.reportProgress(94, 'target-discovery', 'Waiting for the restored target to appear in live inventory');
      return { state: 'reconciling', phase: 'target-discovery', delayMs: 3000 };
    }
    return { state: 'unknown', result: _manualEvidence(request, { targetObserved: false }) };
  }
  if (String(raw.node || '') !== task.node) {
    return { state: 'unknown', result: _manualEvidence(request, {
      targetObserved: true, targetNodeMismatch: true,
    }) };
  }
  if (raw.lock) {
    if (Date.now() < _deadline(context.operation, duration)) {
      context.reportProgress(96, 'target-unlock', 'Waiting for the restored target lock to clear');
      return { state: 'reconciling', phase: 'target-unlock', delayMs: 3000 };
    }
    return { state: 'unknown', result: _manualEvidence(request, { targetObserved: true, targetLocked: true }) };
  }
  const powerState = String(raw.status || raw.powerState || 'unknown').toLowerCase();
  if (['running', 'paused', 'poweredon'].includes(powerState)) {
    return { state: 'unknown', result: _manualEvidence(request, {
      targetObserved: true, unexpectedRunningState: true,
    }) };
  }
  const inventory = await registry.resourcesForHost(
    database.prepare('SELECT * FROM docker_hosts WHERE id=?').get(context.operation.provider.endpointId),
    'virtual-machines', { limit: 500, database });
  const normalized = inventory.items.find(item => {
    const identity = identityStore.resolveCanonical(item.id,
      { hostId: context.operation.provider.endpointId, kind: 'virtualMachine' }, database);
    return identity?.nativeRef === `${task.guestType}/${task.vmid}`;
  });
  if (!normalized) {
    if (Date.now() < _deadline(context.operation, duration)) {
      context.reportProgress(98, 'canonical-target', 'Waiting for canonical target inventory evidence');
      return { state: 'reconciling', phase: 'canonical-target', delayMs: 3000 };
    }
    return { state: 'unknown', result: _manualEvidence(request, {
      targetObserved: true, canonicalIdentityObserved: false,
    }) };
  }
  return { state: 'succeeded', phase: 'verified', result: {
    recoveryPointId: request.recoveryPointId,
    target: { id: normalized.id, displayName: normalized.displayName,
      vmid: request.targetVmid, nodeId: request.targetNodeId,
      storageId: request.targetStorageId, powerState: normalized.status?.powerState || powerState },
    verifiedBy: 'provider_task_and_live_canonical_vm_inventory',
    createOnly: true, overwrite: false, startAfterRestore: false,
    uniqueNetworkIdentity: true, automaticCleanupAuthorized: false,
  } };
}

async function execute(context, options = {}) {
  const database = options.database || getDb();
  const request = _request(context);
  const host = _host(context.operation, database);
  const target = _target(context.operation, request, database);
  const client = (options.clientFactory || fromHostRow)(host);
  try {
    const [vms, nodes, fabric, source] = await Promise.all([
      client.listVMs(), client.listNodes(), client.getNodeMigrationInventory(target.node), client.listRecoveryPoints(),
    ]);
    if (_findRawTarget(vms, { vmid: request.targetVmid, guestType: request.guestType })) {
      throw Object.assign(new Error('Restore target VMID already exists'), {
        code: 'RECOVERY_RESTORE_TARGET_CONFLICT',
      });
    }
    const node = nodes.find(item => String(item.node) === target.node);
    if (!node || ['offline', 'unknown'].includes(String(node.status || '').toLowerCase())) {
      throw Object.assign(new Error('Restore target node is unavailable'), {
        code: 'RECOVERY_RESTORE_TARGET_NODE_UNAVAILABLE',
      });
    }
    const storage = (fabric.storages || []).find(item => String(item.storage) === target.storage);
    const requiredContent = request.guestType === 'lxc' ? 'rootdir' : 'images';
    if (!storage || storage.enabled === 0 || storage.active === 0
      || (storage.content && !String(storage.content).split(',').includes(requiredContent))) {
      throw Object.assign(new Error('Restore target storage is unavailable or incompatible'), {
        code: 'RECOVERY_RESTORE_TARGET_STORAGE_UNAVAILABLE',
      });
    }
    const livePoint = (source.points || []).find(item => String(item.nativeRef) === target.point.nativeRef);
    const liveRepository = (source.repositories || []).find(item => String(item.nativeRef) === target.repository.nativeRef);
    if (!livePoint || !liveRepository || liveRepository.enabled === false || liveRepository.accessible === false) {
      throw Object.assign(new Error('Recovery restore source is no longer available'), {
        code: 'RECOVERY_RESTORE_SOURCE_UNAVAILABLE',
      });
    }
    const checkpointTarget = { node: target.node, vmid: request.targetVmid, guestType: request.guestType };
    context.bindNativeTask(_taskRef(checkpointTarget), 'submitting');
    context.reportProgress(20, 'pre-submit', 'Source, target node, storage and VMID were revalidated live');
    const result = await client.restoreVmBackup(target.node, request.targetVmid,
      request.guestType, target.archive, {
        storage: target.storage, force: false, start: false, liveRestore: false,
        bwlimitKiB: request.bandwidthLimitMbps
          ? Math.max(1, Math.round(Number(request.bandwidthLimitMbps) * 125)) : undefined,
      });
    return { state: 'reconciling', phase: 'native-task',
      nativeTaskRef: _taskRef(checkpointTarget, result.taskRef, 'native'),
      nativeTaskState: 'running', delayMs: 1500 };
  } finally { client._agent?.destroy?.(); }
}

async function reconcile(context, options = {}) {
  const database = options.database || getDb();
  const request = _request(context);
  const host = _host(context.operation, database);
  const task = _parseTask(context.nativeTaskRef);
  if (!task) return { state: 'unknown', result: _manualEvidence(request, { durableCheckpointValid: false }) };
  const client = (options.clientFactory || fromHostRow)(host);
  try {
    if (task.stage === 'submit') {
      return await _verify(context, client, task, request, database, SUBMIT_DISCOVERY_TIMEOUT_MS);
    }
    const status = await client.getTaskStatus(task.node, task.upid);
    if (String(status?.status || '').toLowerCase() !== 'stopped') {
      if (Date.now() >= _deadline(context.operation)) {
        return { state: 'unknown', result: _manualEvidence(request, { nativeTaskTimedOut: true }) };
      }
      context.reportProgress(75, 'native-task', 'Waiting for the Proxmox restore task');
      return { state: 'reconciling', phase: 'native-task', delayMs: 3000 };
    }
    if (String(status?.exitstatus || '').toUpperCase() !== 'OK') {
      return { state: 'failed', phase: 'native-task',
        errorCode: 'PROVIDER_RESTORE_TASK_FAILED_PARTIAL_TARGET_POSSIBLE',
        errorMessage: 'Proxmox restore task failed; inspect the target before cleanup or retry',
        result: _manualEvidence(request, { providerTaskFailed: true }) };
    }
    return await _verify(context, client, task, request, database);
  } finally { client._agent?.destroy?.(); }
}

async function cancel(context, options = {}) {
  const request = _request(context);
  const task = _parseTask(context.nativeTaskRef);
  if (!task || task.stage !== 'native') return { confirmed: false,
    result: _manualEvidence(request, { cancellationUnconfirmed: true }) };
  const database = options.database || getDb();
  let host;
  try { host = _host(context.operation, database); } catch { return { confirmed: false }; }
  const client = (options.clientFactory || fromHostRow)(host);
  try {
    await client.stopTask(task.node, task.upid);
    return { confirmed: true, result: _manualEvidence(request, { providerTaskCancelled: true }) };
  } catch { return { confirmed: false, result: _manualEvidence(request, { cancellationUnconfirmed: true }) }; }
  finally { client._agent?.destroy?.(); }
}

function register(engine, options = {}) {
  engine.registerHandler({
    type: TYPE, idempotent: false, retryPolicy: 'none', timeoutSeconds: 86400,
    execute: context => execute(context, options),
    reconcile: context => reconcile(context, options),
    cancel: context => cancel(context, options),
  });
}

module.exports = {
  TYPE, register, execute, reconcile, cancel,
  _internals: {
    _host, _request, _storageIdentity, _archive, _target,
    _taskRef, _parseTask, _deadline, _findRawTarget, _manualEvidence, _verify,
  },
};
