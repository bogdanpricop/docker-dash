'use strict';

const { getDb } = require('../../../db');
const { fromHostRow } = require('../../proxmox');
const restoreHandler = require('./vm-restore');

const TYPE = 'recovery.drill';
const SAFE_RUN_ID = /^pdrr_[a-f0-9]{26}$/;
const SAFE_POINT_ID = /^ddr_rp_[a-f0-9]{26}$/;
const SAFE_REPOSITORY_ID = /^ddr_repo_[a-f0-9]{26}$/;
const SAFE_NODE_ID = /^ddr_host_[a-f0-9]{26}$/;
const SAFE_STORAGE_ID = /^ddr_storage_[a-f0-9]{26}$/;
const SAFE_NODE = /^[A-Za-z0-9._-]{1,128}$/;
const STAGES = new Set([
  'restore-submit', 'restore-native', 'isolation-submit', 'isolation-verify',
  'start-submit', 'start-native', 'assertions', 'shutdown-submit', 'shutdown-native',
  'force-stop-submit', 'force-stop-native', 'destroy-submit', 'destroy-native',
]);
const RESTORE_DISCOVERY_MS = 30 * 60 * 1000;
const CLEANUP_DISCOVERY_MS = 10 * 60 * 1000;

function _host(operation, database) {
  return restoreHandler._internals._host(operation, database);
}

function _request(context) {
  const request = context.request || {};
  const assertions = request.assertions || {};
  if (!SAFE_RUN_ID.test(String(request.runId || ''))
    || !SAFE_POINT_ID.test(String(request.recoveryPointId || ''))
    || !SAFE_REPOSITORY_ID.test(String(request.repositoryId || ''))
    || !SAFE_NODE_ID.test(String(request.targetNodeId || ''))
    || !SAFE_STORAGE_ID.test(String(request.targetStorageId || ''))
    || !['qemu', 'lxc'].includes(request.guestType)
    || !Number.isSafeInteger(Number(request.targetVmid))
    || Number(request.targetVmid) < 100 || Number(request.targetVmid) > 999999999
    || !/^[a-f0-9]{64}$/.test(String(request.planHash || ''))
    || !['required', 'optional', 'disabled'].includes(assertions.guestAgent)
    || assertions.boot !== true
    || (request.guestType === 'lxc' && assertions.guestAgent !== 'disabled')
    || typeof assertions.osInfo !== 'boolean'
    || (request.guestType === 'lxc' && assertions.osInfo !== false)
    || !Number.isSafeInteger(Number(assertions.bootTimeoutSeconds))
    || Number(assertions.bootTimeoutSeconds) < 30 || Number(assertions.bootTimeoutSeconds) > 900
    || !Number.isSafeInteger(Number(request.shutdownTimeoutSeconds))
    || Number(request.shutdownTimeoutSeconds) < 30 || Number(request.shutdownTimeoutSeconds) > 300
    || request.allowForceStop !== true
    || !['on_success', 'never'].includes(request.cleanupMode)
    || (request.cleanupMode === 'on_success' && request.automaticCleanupAuthorized !== true)
    || (request.cleanupMode === 'never' && request.automaticCleanupAuthorized !== false)
    || (request.verificationOverride === true
      && (typeof request.overrideReason !== 'string' || request.overrideReason.length < 20
        || request.overrideReason.length > 240 || /[\u0000-\u001f\u007f]/.test(request.overrideReason)))
    || (request.verificationOverride !== true && request.overrideReason != null)
    || (request.bandwidthLimitMbps != null
      && (!Number.isSafeInteger(Number(request.bandwidthLimitMbps))
        || Number(request.bandwidthLimitMbps) < 1 || Number(request.bandwidthLimitMbps) > 100000))
    || request.startAfterRestore !== false || request.liveRestore !== false || request.overwrite !== false) {
    throw Object.assign(new Error('Restore drill request is invalid'), { code: 'INVALID_RESTORE_DRILL' });
  }
  return {
    ...request, targetVmid: Number(request.targetVmid),
    assertions: { boot: true, guestAgent: assertions.guestAgent,
      bootTimeoutSeconds: Number(assertions.bootTimeoutSeconds), osInfo: assertions.osInfo === true },
    shutdownTimeoutSeconds: Number(request.shutdownTimeoutSeconds),
  };
}

function _marker(request) { return `Docker Dash restore drill ${request.runId}`; }

function _checkpoint(value) {
  const json = JSON.stringify(value);
  if (json.length > 1900) throw Object.assign(new Error('Restore drill checkpoint is too large'), {
    code: 'INVALID_RESTORE_DRILL_CHECKPOINT',
  });
  return json;
}

function _parseCheckpoint(value) {
  try {
    const item = JSON.parse(value || '{}');
    if (item.v !== 1 || !STAGES.has(item.stage) || !SAFE_NODE.test(String(item.node || ''))
      || !['qemu', 'lxc'].includes(item.guestType)
      || !Number.isSafeInteger(Number(item.vmid)) || Number(item.vmid) < 100
      || Number(item.vmid) > 999999999
      || (item.taskRef != null && (typeof item.taskRef !== 'string' || !item.taskRef.startsWith('UPID:')))
      || (item.failure != null && (!/^[A-Z][A-Z0-9_]{1,79}$/.test(String(item.failure.code || ''))
        || typeof item.failure.message !== 'string' || item.failure.message.length > 200))) return null;
    return { ...item, vmid: Number(item.vmid), evidence: item.evidence || {} };
  } catch { return null; }
}

function _baseCheckpoint(request, target, stage, extra = {}) {
  return {
    v: 1, stage, node: target.node, vmid: request.targetVmid,
    guestType: request.guestType, evidence: {}, ...extra,
  };
}

function _deadline(operation, milliseconds) {
  const started = Date.parse(operation.startedAt || operation.createdAt || 0);
  return (Number.isFinite(started) ? started : Date.now()) + milliseconds;
}

function _stageDeadline(checkpoint, key, fallbackStart, seconds) {
  const started = Date.parse(checkpoint.evidence?.[key] || fallbackStart || 0);
  return (Number.isFinite(started) ? started : Date.now()) + seconds * 1000;
}

function _findTarget(rows, checkpoint) {
  return (rows || []).find(item => Number(item.vmid) === checkpoint.vmid
    && String(item.type || 'qemu') === checkpoint.guestType);
}

function _powerState(item) {
  const value = String(item?.status || item?.powerState || 'unknown').toLowerCase();
  if (['running', 'poweredon', 'paused'].includes(value)) return 'running';
  if (['stopped', 'poweredoff', 'halted'].includes(value)) return 'stopped';
  return value;
}

function _safeOsInfo(value) {
  const text = key => value?.[key] == null ? null
    : String(value[key]).replace(/[\r\n\t]+/g, ' ').slice(0, 120);
  return {
    name: text('name'), version: text('version'),
    kernelRelease: text('kernel-release'), machine: text('machine'),
  };
}

function _result(request, checkpoint, extra = {}) {
  const evidence = checkpoint.evidence || {};
  return {
    runId: request.runId, recoveryPointId: request.recoveryPointId,
    target: { nodeId: request.targetNodeId, storageId: request.targetStorageId,
      vmid: request.targetVmid, guestType: request.guestType },
    isolation: evidence.isolation || null,
    assertions: evidence.assertions || null,
    stop: evidence.stop || null,
    cleanup: evidence.cleanup || { mode: request.cleanupMode, completed: false },
    timing: {
      restoreStartedAt: evidence.restoreStartedAt || null,
      restoreCompletedAt: evidence.restoreCompletedAt || null,
      bootStartedAt: evidence.bootStartedAt || null,
      assertionCompletedAt: evidence.assertionCompletedAt || null,
      shutdownStartedAt: evidence.shutdownStartedAt || null,
      cleanupStartedAt: evidence.cleanupStartedAt || null,
      cleanupCompletedAt: evidence.cleanup?.completedAt || null,
    },
    targetRetained: extra.targetRetained !== undefined ? extra.targetRetained : true,
    automaticCleanupAuthorized: request.automaticCleanupAuthorized,
    arbitraryGuestCommandsAuthorized: false,
    ...extra,
  };
}

function _failed(request, checkpoint, code, message, extra = {}) {
  return { state: 'failed', phase: checkpoint.stage, errorCode: code, errorMessage: message,
    result: _result(request, checkpoint, { targetRetained: true, ...extra }) };
}

function _unknown(request, checkpoint, code, extra = {}) {
  return { state: 'unknown', result: _result(request, checkpoint, {
    targetRetained: true, manualInspectionRequired: true, evidenceCode: code, ...extra,
  }) };
}

async function _task(client, checkpoint) {
  if (!checkpoint.taskRef) return { state: 'missing' };
  const value = await client.getTaskStatus(checkpoint.node, checkpoint.taskRef);
  if (String(value?.status || '').toLowerCase() !== 'stopped') return { state: 'running' };
  return String(value?.exitstatus || '').toUpperCase() === 'OK'
    ? { state: 'succeeded' } : { state: 'failed' };
}

async function _restoreChecks(client, target, request) {
  const [vms, nodes, fabric, source] = await Promise.all([
    client.listVMs(), client.listNodes(), client.getNodeMigrationInventory(target.node),
    client.listRecoveryPoints(),
  ]);
  if (_findTarget(vms, { vmid: request.targetVmid, guestType: request.guestType })) {
    throw Object.assign(new Error('Restore drill target VMID already exists'), {
      code: 'RESTORE_DRILL_TARGET_CONFLICT',
    });
  }
  const node = nodes.find(item => String(item.node) === target.node);
  if (!node || ['offline', 'unknown'].includes(String(node.status || '').toLowerCase())) {
    throw Object.assign(new Error('Restore drill target node is unavailable'), {
      code: 'RESTORE_DRILL_TARGET_NODE_UNAVAILABLE',
    });
  }
  const storage = (fabric.storages || []).find(item => String(item.storage) === target.storage);
  const content = request.guestType === 'lxc' ? 'rootdir' : 'images';
  if (!storage || storage.enabled === 0 || storage.active === 0
    || (storage.content && !String(storage.content).split(',').includes(content))) {
    throw Object.assign(new Error('Restore drill target storage is unavailable'), {
      code: 'RESTORE_DRILL_TARGET_STORAGE_UNAVAILABLE',
    });
  }
  const point = (source.points || []).find(item => String(item.nativeRef) === target.point.nativeRef);
  const repository = (source.repositories || []).find(item => String(item.nativeRef) === target.repository.nativeRef);
  if (!point || !repository || repository.enabled === false || repository.accessible === false) {
    throw Object.assign(new Error('Restore drill source is unavailable'), {
      code: 'RESTORE_DRILL_SOURCE_UNAVAILABLE',
    });
  }
}

async function _beginIsolation(context, client, request, checkpoint) {
  const rows = await client.listVMs();
  const target = _findTarget(rows, checkpoint);
  if (!target) {
    if (Date.now() < _deadline(context.operation, RESTORE_DISCOVERY_MS)) {
      context.reportProgress(30, 'restore-discovery', 'Waiting for the restored drill target');
      return { state: 'reconciling', phase: 'restore-discovery', delayMs: 3000,
        nativeTaskRef: _checkpoint(checkpoint), nativeTaskState: 'target-discovery' };
    }
    return _unknown(request, checkpoint, 'RESTORE_DRILL_TARGET_NOT_OBSERVED');
  }
  if (String(target.node || '') !== checkpoint.node || _powerState(target) !== 'stopped') {
    return _unknown(request, checkpoint, 'RESTORE_DRILL_TARGET_STATE_UNSAFE');
  }
  if (target.lock) {
    context.reportProgress(35, 'restore-unlock', 'Waiting for the restored drill target lock');
    return { state: 'reconciling', phase: 'restore-unlock', delayMs: 3000,
      nativeTaskRef: _checkpoint(checkpoint), nativeTaskState: 'target-locked' };
  }
  const next = { ...checkpoint, stage: 'isolation-submit', taskRef: undefined,
    evidence: { ...checkpoint.evidence, restoreCompletedAt: new Date().toISOString() } };
  context.bindNativeTask(_checkpoint(next), 'isolation-submitting');
  const isolation = await client.configureRestoreDrillIsolation(
    checkpoint.node, checkpoint.vmid, checkpoint.guestType, _marker(request));
  next.stage = 'isolation-verify';
  next.evidence.isolation = { configured: false, networkCount: isolation.networkCount,
    isolatedCount: 0, checkedAt: null };
  return { state: 'reconciling', phase: 'isolation-verify', delayMs: 500,
    nativeTaskRef: _checkpoint(next), nativeTaskState: 'isolation-pending' };
}

async function _beginStart(context, client, request, checkpoint) {
  const checked = await client.verifyRestoreDrillIsolation(
    checkpoint.node, checkpoint.vmid, checkpoint.guestType, _marker(request));
  checkpoint.evidence.isolation = {
    configured: checked.configured, markerMatches: checked.markerMatches,
    networkCount: checked.networkCount, isolatedCount: checked.isolatedCount,
    checkedAt: new Date().toISOString(),
  };
  if (!checked.configured) return _failed(request, checkpoint,
    'RESTORE_DRILL_ISOLATION_FAILED', 'Every restored NIC must be disconnected before boot');
  const next = { ...checkpoint, stage: 'start-submit', taskRef: undefined,
    evidence: { ...checkpoint.evidence, bootStartedAt: new Date().toISOString() } };
  context.bindNativeTask(_checkpoint(next), 'start-submitting');
  const task = await client.vmPowerAction(checkpoint.node, checkpoint.vmid, checkpoint.guestType, 'start');
  next.stage = 'start-native'; next.taskRef = task.taskRef;
  return { state: 'reconciling', phase: 'start-native', delayMs: 1500,
    nativeTaskRef: _checkpoint(next), nativeTaskState: 'running' };
}

async function _beginShutdown(context, client, request, checkpoint, failure = null) {
  const next = { ...checkpoint, stage: 'shutdown-submit', taskRef: undefined,
    failure: failure || checkpoint.failure || null,
    evidence: { ...checkpoint.evidence, assertionCompletedAt: new Date().toISOString(),
      shutdownStartedAt: new Date().toISOString() } };
  context.bindNativeTask(_checkpoint(next), 'shutdown-submitting');
  const task = await client.vmPowerAction(checkpoint.node, checkpoint.vmid, checkpoint.guestType, 'shutdown');
  next.stage = 'shutdown-native'; next.taskRef = task.taskRef;
  return { state: 'reconciling', phase: 'shutdown-native', delayMs: 1500,
    nativeTaskRef: _checkpoint(next), nativeTaskState: 'running' };
}

async function _beginForceStop(context, client, request, checkpoint) {
  const next = { ...checkpoint, stage: 'force-stop-submit', taskRef: undefined };
  context.bindNativeTask(_checkpoint(next), 'force-stop-submitting');
  const task = await client.vmPowerAction(
    checkpoint.node, checkpoint.vmid, checkpoint.guestType, 'forceShutdown');
  next.stage = 'force-stop-native'; next.taskRef = task.taskRef;
  return { state: 'reconciling', phase: 'force-stop-native', delayMs: 1500,
    nativeTaskRef: _checkpoint(next), nativeTaskState: 'running' };
}

async function _afterStopped(context, client, request, checkpoint, forced = false) {
  checkpoint.evidence.stop = { completed: true, forced,
    completedAt: new Date().toISOString() };
  if (checkpoint.failure) return _failed(request, checkpoint,
    checkpoint.failure.code, checkpoint.failure.message);
  if (request.cleanupMode === 'never') {
    checkpoint.evidence.cleanup = { mode: 'never', completed: false, retainedByPolicy: true };
    return { state: 'succeeded', phase: 'retained', result: _result(request, checkpoint, {
      targetRetained: true, verifiedBy: 'restore_isolation_boot_assertions_and_stop',
    }) };
  }
  const status = await client.getVmStatus(checkpoint.node, checkpoint.vmid, checkpoint.guestType);
  const isolation = await client.verifyRestoreDrillIsolation(
    checkpoint.node, checkpoint.vmid, checkpoint.guestType, _marker(request));
  if (!isolation.configured || _powerState(status) !== 'stopped') {
    return _unknown(request, checkpoint, 'RESTORE_DRILL_CLEANUP_OWNERSHIP_UNPROVEN');
  }
  const next = { ...checkpoint, stage: 'destroy-submit', taskRef: undefined,
    evidence: { ...checkpoint.evidence, cleanupStartedAt: new Date().toISOString() } };
  context.bindNativeTask(_checkpoint(next), 'destroy-submitting');
  const task = await client.destroyRestoreDrillTarget(
    checkpoint.node, checkpoint.vmid, checkpoint.guestType);
  next.stage = 'destroy-native'; next.taskRef = task.taskRef;
  return { state: 'reconciling', phase: 'destroy-native', delayMs: 1500,
    nativeTaskRef: _checkpoint(next), nativeTaskState: 'running' };
}

async function _assert(context, client, request, checkpoint) {
  const target = _findTarget(await client.listVMs(), checkpoint);
  const deadline = _stageDeadline(checkpoint, 'bootStartedAt', context.operation.startedAt,
    request.assertions.bootTimeoutSeconds);
  if (!target || _powerState(target) !== 'running') {
    if (Date.now() < deadline) {
      context.reportProgress(62, 'boot-assertion', 'Waiting for the isolated drill target to boot');
      return { state: 'reconciling', phase: 'boot-assertion', delayMs: 3000,
        nativeTaskRef: _checkpoint(checkpoint), nativeTaskState: 'booting' };
    }
    checkpoint.evidence.assertions = { boot: { passed: false, checkedAt: new Date().toISOString() },
      guestAgent: { mode: request.assertions.guestAgent, passed: false, skipped: true } };
    if (!target || _powerState(target) === 'stopped') return _failed(request, checkpoint,
      'RESTORE_DRILL_BOOT_FAILED', 'Restored target did not reach running state');
    return _beginShutdown(context, client, request, checkpoint, {
      code: 'RESTORE_DRILL_BOOT_TIMEOUT', message: 'Restored target boot assertion timed out',
    });
  }
  checkpoint.evidence.assertions = checkpoint.evidence.assertions || {};
  checkpoint.evidence.assertions.boot = { passed: true, checkedAt: new Date().toISOString() };
  if (request.assertions.guestAgent === 'disabled') {
    checkpoint.evidence.assertions.guestAgent = { mode: 'disabled', passed: null, skipped: true };
    return _beginShutdown(context, client, request, checkpoint);
  }
  try {
    await client.pingGuestAgent(checkpoint.node, checkpoint.vmid);
    let osInfo = null;
    if (request.assertions.osInfo) {
      try { osInfo = _safeOsInfo(await client.getGuestAgentOsInfo(checkpoint.node, checkpoint.vmid)); }
      catch { osInfo = null; }
    }
    checkpoint.evidence.assertions.guestAgent = {
      mode: request.assertions.guestAgent, passed: true,
      checkedAt: new Date().toISOString(), ...(osInfo ? {
        osName: osInfo.name, osVersion: osInfo.version,
        kernelRelease: osInfo.kernelRelease, machine: osInfo.machine,
      } : {}),
    };
    return _beginShutdown(context, client, request, checkpoint);
  } catch {
    if (Date.now() < deadline) {
      context.reportProgress(70, 'guest-agent-assertion', 'Waiting for the isolated QEMU guest agent');
      return { state: 'reconciling', phase: 'guest-agent-assertion', delayMs: 5000,
        nativeTaskRef: _checkpoint(checkpoint), nativeTaskState: 'agent-pending' };
    }
    checkpoint.evidence.assertions.guestAgent = { mode: request.assertions.guestAgent,
      passed: false, checkedAt: new Date().toISOString() };
    const failure = request.assertions.guestAgent === 'required' ? {
      code: 'RESTORE_DRILL_GUEST_AGENT_FAILED',
      message: 'Required guest-agent assertion did not pass before timeout',
    } : null;
    return _beginShutdown(context, client, request, checkpoint, failure);
  }
}

async function execute(context, options = {}) {
  const database = options.database || getDb();
  const request = _request(context);
  const host = _host(context.operation, database);
  const target = restoreHandler._internals._target(context.operation, request, database);
  const client = (options.clientFactory || fromHostRow)(host);
  try {
    await _restoreChecks(client, target, request);
    const checkpoint = _baseCheckpoint(request, target, 'restore-submit', {
      evidence: { restoreStartedAt: new Date().toISOString() },
    });
    context.bindNativeTask(_checkpoint(checkpoint), 'restore-submitting');
    context.reportProgress(10, 'restore-submit', 'Restore source and isolated target were revalidated');
    const task = await client.restoreVmBackup(target.node, request.targetVmid,
      request.guestType, target.archive, {
        storage: target.storage, force: false, start: false, liveRestore: false,
        bwlimitKiB: request.bandwidthLimitMbps
          ? Math.max(1, Math.round(Number(request.bandwidthLimitMbps) * 125)) : undefined,
      });
    checkpoint.stage = 'restore-native'; checkpoint.taskRef = task.taskRef;
    return { state: 'reconciling', phase: 'restore-native', delayMs: 1500,
      nativeTaskRef: _checkpoint(checkpoint), nativeTaskState: 'running' };
  } finally { client._agent?.destroy?.(); }
}

async function reconcile(context, options = {}) {
  const database = options.database || getDb();
  const request = _request(context);
  const checkpoint = _parseCheckpoint(context.nativeTaskRef);
  if (!checkpoint) return { state: 'unknown', result: {
    runId: request.runId, recoveryPointId: request.recoveryPointId,
    manualInspectionRequired: true, evidenceCode: 'RESTORE_DRILL_CHECKPOINT_INVALID',
    automaticCleanupAuthorized: request.automaticCleanupAuthorized,
  } };
  const host = _host(context.operation, database);
  const client = (options.clientFactory || fromHostRow)(host);
  try {
    if (checkpoint.stage === 'restore-submit') return _beginIsolation(context, client, request, checkpoint);
    if (checkpoint.stage === 'restore-native') {
      const task = await _task(client, checkpoint);
      if (task.state === 'running') {
        context.reportProgress(25, 'restore-native', 'Waiting for the Proxmox restore task');
        return { state: 'reconciling', phase: 'restore-native', delayMs: 3000,
          nativeTaskRef: _checkpoint(checkpoint), nativeTaskState: 'running' };
      }
      if (task.state !== 'succeeded') return _failed(request, checkpoint,
        'RESTORE_DRILL_RESTORE_FAILED', 'Proxmox restore task failed; partial target may exist');
      return _beginIsolation(context, client, request, checkpoint);
    }
    if (checkpoint.stage === 'isolation-submit') {
      const current = await client.verifyRestoreDrillIsolation(
        checkpoint.node, checkpoint.vmid, checkpoint.guestType, _marker(request));
      if (!current.configured) await client.configureRestoreDrillIsolation(
        checkpoint.node, checkpoint.vmid, checkpoint.guestType, _marker(request));
      checkpoint.stage = 'isolation-verify';
      return { state: 'reconciling', phase: 'isolation-verify', delayMs: 500,
        nativeTaskRef: _checkpoint(checkpoint), nativeTaskState: 'isolation-pending' };
    }
    if (checkpoint.stage === 'isolation-verify') return _beginStart(context, client, request, checkpoint);
    if (checkpoint.stage === 'start-submit') {
      const target = _findTarget(await client.listVMs(), checkpoint);
      if (target && _powerState(target) === 'running') {
        checkpoint.stage = 'assertions'; checkpoint.taskRef = undefined;
        return _assert(context, client, request, checkpoint);
      }
      if (Date.now() < _stageDeadline(checkpoint, 'bootStartedAt', context.operation.startedAt,
        request.assertions.bootTimeoutSeconds)) {
        return { state: 'reconciling', phase: 'start-discovery', delayMs: 3000,
          nativeTaskRef: _checkpoint(checkpoint), nativeTaskState: 'start-ambiguous' };
      }
      return _unknown(request, checkpoint, 'RESTORE_DRILL_START_AMBIGUOUS');
    }
    if (checkpoint.stage === 'start-native') {
      const task = await _task(client, checkpoint);
      if (task.state === 'running') return { state: 'reconciling', phase: 'start-native', delayMs: 2000,
        nativeTaskRef: _checkpoint(checkpoint), nativeTaskState: 'running' };
      if (task.state !== 'succeeded') return _failed(request, checkpoint,
        'RESTORE_DRILL_START_FAILED', 'Proxmox start task failed');
      checkpoint.stage = 'assertions'; checkpoint.taskRef = undefined;
      return _assert(context, client, request, checkpoint);
    }
    if (checkpoint.stage === 'assertions') return _assert(context, client, request, checkpoint);
    if (checkpoint.stage === 'shutdown-submit' || checkpoint.stage === 'shutdown-native') {
      if (checkpoint.stage === 'shutdown-native') {
        const task = await _task(client, checkpoint);
        if (task.state === 'failed') return _unknown(request, checkpoint, 'RESTORE_DRILL_SHUTDOWN_TASK_FAILED');
      }
      const target = _findTarget(await client.listVMs(), checkpoint);
      if (target && _powerState(target) === 'stopped') return _afterStopped(context, client, request, checkpoint, false);
      if (Date.now() >= _stageDeadline(checkpoint, 'shutdownStartedAt', context.operation.startedAt,
        request.shutdownTimeoutSeconds)) return _beginForceStop(context, client, request, checkpoint);
      return { state: 'reconciling', phase: 'shutdown-wait', delayMs: 3000,
        nativeTaskRef: _checkpoint(checkpoint), nativeTaskState: 'shutdown-pending' };
    }
    if (checkpoint.stage === 'force-stop-submit') {
      const target = _findTarget(await client.listVMs(), checkpoint);
      if (target && _powerState(target) === 'stopped') return _afterStopped(context, client, request, checkpoint, true);
      return _unknown(request, checkpoint, 'RESTORE_DRILL_FORCE_STOP_AMBIGUOUS');
    }
    if (checkpoint.stage === 'force-stop-native') {
      const task = await _task(client, checkpoint);
      if (task.state === 'running') return { state: 'reconciling', phase: 'force-stop-native', delayMs: 2000,
        nativeTaskRef: _checkpoint(checkpoint), nativeTaskState: 'running' };
      if (task.state !== 'succeeded') return _unknown(request, checkpoint, 'RESTORE_DRILL_FORCE_STOP_FAILED');
      const target = _findTarget(await client.listVMs(), checkpoint);
      if (!target || _powerState(target) !== 'stopped') return _unknown(request, checkpoint,
        'RESTORE_DRILL_STOP_STATE_UNPROVEN');
      return _afterStopped(context, client, request, checkpoint, true);
    }
    if (checkpoint.stage === 'destroy-submit') {
      const target = _findTarget(await client.listVMs(), checkpoint);
      if (!target) {
        checkpoint.evidence.cleanup = { mode: request.cleanupMode, completed: true,
          completedAt: new Date().toISOString() };
        return { state: 'succeeded', phase: 'cleanup-verified', result: _result(request, checkpoint, {
          targetRetained: false, verifiedBy: 'restore_isolation_boot_assertions_stop_and_cleanup',
        }) };
      }
      if (Date.now() < _stageDeadline(checkpoint, 'cleanupStartedAt',
        context.operation.startedAt, CLEANUP_DISCOVERY_MS / 1000)) {
        return { state: 'reconciling', phase: 'destroy-discovery', delayMs: 3000,
          nativeTaskRef: _checkpoint(checkpoint), nativeTaskState: 'destroy-ambiguous' };
      }
      return _unknown(request, checkpoint, 'RESTORE_DRILL_DESTROY_AMBIGUOUS');
    }
    if (checkpoint.stage === 'destroy-native') {
      const task = await _task(client, checkpoint);
      if (task.state === 'running') return { state: 'reconciling', phase: 'destroy-native', delayMs: 2000,
        nativeTaskRef: _checkpoint(checkpoint), nativeTaskState: 'running' };
      if (task.state !== 'succeeded') return _failed(request, checkpoint,
        'RESTORE_DRILL_CLEANUP_FAILED', 'Proxmox destroy task failed');
      const target = _findTarget(await client.listVMs(), checkpoint);
      if (target) {
        if (Date.now() >= _stageDeadline(checkpoint, 'cleanupStartedAt',
          context.operation.startedAt, CLEANUP_DISCOVERY_MS / 1000)) {
          return _unknown(request, checkpoint, 'RESTORE_DRILL_DESTROY_NOT_OBSERVED');
        }
        return { state: 'reconciling', phase: 'destroy-verify', delayMs: 2000,
          nativeTaskRef: _checkpoint(checkpoint), nativeTaskState: 'destroy-verify' };
      }
      checkpoint.evidence.cleanup = { mode: request.cleanupMode, completed: true,
        completedAt: new Date().toISOString() };
      return { state: 'succeeded', phase: 'cleanup-verified', result: _result(request, checkpoint, {
        targetRetained: false, verifiedBy: 'restore_isolation_boot_assertions_stop_and_cleanup',
      }) };
    }
    return _unknown(request, checkpoint, 'RESTORE_DRILL_STAGE_UNKNOWN');
  } finally { client._agent?.destroy?.(); }
}

async function cancel(context, options = {}) {
  const request = _request(context);
  const checkpoint = _parseCheckpoint(context.nativeTaskRef);
  if (!checkpoint) return { confirmed: false, result: {
    runId: request.runId, targetRetained: true, manualInspectionRequired: true,
    automaticCleanupAuthorized: false,
  } };
  const database = options.database || getDb();
  let host;
  try { host = _host(context.operation, database); } catch { return { confirmed: false }; }
  const client = (options.clientFactory || fromHostRow)(host);
  try {
    if (checkpoint.taskRef) {
      try { await client.stopTask(checkpoint.node, checkpoint.taskRef); } catch { /* ambiguity is retained */ }
    }
    try {
      const target = _findTarget(await client.listVMs(), checkpoint);
      if (target && _powerState(target) === 'running') {
        const isolation = await client.verifyRestoreDrillIsolation(
          checkpoint.node, checkpoint.vmid, checkpoint.guestType, _marker(request));
        if (isolation.configured) await client.vmPowerAction(
          checkpoint.node, checkpoint.vmid, checkpoint.guestType, 'forceShutdown');
      }
    } catch { /* manual inspection remains mandatory */ }
    return { confirmed: false, result: _result(request, checkpoint, {
      targetRetained: true, cancellationRequested: true,
      manualInspectionRequired: true, automaticCleanupAuthorized: false,
    }) };
  } finally { client._agent?.destroy?.(); }
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
    _request, _marker, _checkpoint, _parseCheckpoint, _baseCheckpoint,
    _deadline, _stageDeadline, _findTarget, _powerState, _safeOsInfo,
    _result, _failed, _unknown,
  },
};
