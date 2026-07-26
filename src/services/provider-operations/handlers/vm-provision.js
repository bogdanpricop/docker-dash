'use strict';

const { getDb } = require('../../../db');
const bridge = require('../provision-provider');
const guestCustomization = require('../guest-customization');

const TYPE = 'vm.provision';
const VERIFY_TIMEOUT_MS = 60 * 60 * 1000;
const PENDING = new Set(['pending', 'queued', 'running', 'created']);
const SUCCEEDED = new Set(['success', 'succeeded', 'completed', 'complete']);
const FAILED = new Set(['failure', 'failed', 'error', 'cancelled', 'canceled']);

function _taskRef(provider, result, stage = 'clone') {
  const ref = typeof result?.taskRef === 'string' ? result.taskRef : null;
  if (!ref || ref.length > 1600) return null;
  const task = { provider, ref, stage };
  if (provider === 'proxmox') task.node = result.node;
  return JSON.stringify(task);
}

function _parseTask(value, provider) {
  if (!value) return null;
  try {
    const task = JSON.parse(value);
    if (task?.provider !== provider || typeof task.ref !== 'string' || !task.ref || task.ref.length > 1600
      || !['clone', 'provision-ready', 'provision-submit', 'provision',
        'customize-ready', 'customize-submit', 'customize-verify'].includes(task.stage)) return null;
    if (task.node !== undefined && !/^[A-Za-z0-9._-]{1,160}$/.test(task.node)) return null;
    return task;
  } catch { return null; }
}

function _taskOutcome(provider, status) {
  const state = String(status?.status || status?.state || '').toLowerCase();
  if (provider === 'proxmox' && state === 'stopped') {
    return String(status?.exitstatus || '').toUpperCase() === 'OK'
      ? { done: true, progress: 100 }
      : { failed: true, message: status?.exitstatus || 'Proxmox clone task failed' };
  }
  if (SUCCEEDED.has(state)) return { done: true, progress: 100 };
  if (FAILED.has(state)) return { failed: true, message: status?.error || 'Provider provisioning task failed' };
  if (PENDING.has(state) || !state || state === 'unknown') {
    const raw = Number(status?.progress);
    const progress = Number.isFinite(raw) ? (raw <= 1 ? raw * 100 : raw) : 65;
    return { pending: true, progress: Math.max(5, Math.min(94, Math.round(progress))) };
  }
  return { pending: true, progress: 65 };
}

function _deadline(operation) {
  const started = Date.parse(operation.startedAt || operation.createdAt || 0);
  return Number.isFinite(started) ? started + VERIFY_TIMEOUT_MS : Date.now() + VERIFY_TIMEOUT_MS;
}

function _host(operation, database) {
  const host = database.prepare('SELECT * FROM docker_hosts WHERE id = ? AND is_active = 1')
    .get(operation.provider.endpointId);
  if (!host || host.daemon_type !== operation.provider.type) {
    throw Object.assign(new Error('Provider endpoint is unavailable'), { code: 'INVALID_OPERATION_HOST' });
  }
  return host;
}

async function _verify(context, target, database) {
  const found = await bridge.findByName(target, context.request.name, database, {
    targetVmid: context.request.targetVmid,
  });
  if (found) return { state: 'succeeded', phase: 'verified', result: {
    vm: {
      id: found.resource.id, displayName: found.resource.displayName,
      powerState: found.resource.status?.powerState || 'unknown',
    }, artifactId: context.operation.resource.id, mode: context.request.mode,
    guestCustomization: guestCustomization.summary(context.request.customization),
    verified: true, startAfterCreate: false,
  } };
  if (Date.now() < _deadline(context.operation)) {
    context.reportProgress(95, 'post-verify', 'Waiting for created VM inventory verification');
    return { state: 'reconciling', phase: 'post-verify', delayMs: 2000 };
  }
  return { state: 'unknown', result: { expectedName: context.request.name, artifactId: context.operation.resource.id } };
}

async function execute(context, options = {}) {
  const database = options.database || getDb();
  const target = await bridge.open(_host(context.operation, database), context.operation.resource.id, database);
  try {
    if (await bridge.findByName(target, context.request.name, database, { targetVmid: context.request.targetVmid })) {
      throw Object.assign(new Error('A VM with the requested target identity already exists'), { code: 'PROVIDER_TARGET_CONFLICT' });
    }
    context.reportProgress(20, 'pre-submit', 'Template identity, target name and placement revalidated');
    const result = await bridge.submit(target, context.request, database);
    const nativeTaskRef = _taskRef(target.host.daemon_type, result, 'clone');
    if (!nativeTaskRef) throw Object.assign(new Error('Provider clone operation returned no durable task'), { code: 'INVALID_PROVIDER_TASK_RESPONSE' });
    return { state: 'reconciling', nativeTaskRef, nativeTaskState: 'pending', phase: 'clone-task', delayMs: 1000 };
  } finally { await bridge.close(target); }
}

async function reconcile(context, options = {}) {
  const database = options.database || getDb();
  const target = await bridge.open(_host(context.operation, database), context.operation.resource.id, database);
  try {
    const task = _parseTask(context.nativeTaskRef, target.host.daemon_type);
    if (!task) {
      const found = await bridge.findByName(target, context.request.name, database, { targetVmid: context.request.targetVmid });
      if (found && target.client.provider === 'xapi') {
        const nativeTaskRef = _taskRef(target.host.daemon_type, { taskRef: found.nativeRef }, 'provision-ready');
        context.bindNativeTask(nativeTaskRef, 'ready');
        return { state: 'reconciling', phase: 'provision-ready', delayMs: 500 };
      }
      if (found && target.host.daemon_type === 'proxmox' && context.request.customization) {
        const nativeTaskRef = _taskRef(target.host.daemon_type, { taskRef: found.nativeRef }, 'customize-ready');
        context.bindNativeTask(nativeTaskRef, 'ready');
        return { state: 'reconciling', phase: 'customize-ready', delayMs: 500 };
      }
      if (found) return _verify(context, target, database);
      if (Date.now() < _deadline(context.operation)) {
        context.reportProgress(40, 'submit-recovery', 'Looking for a provider-side clone after an interrupted response');
        return { state: 'reconciling', phase: 'submit-recovery', delayMs: 3000 };
      }
      return { state: 'unknown', result: { submitOutcomeUnconfirmed: true } };
    }
    if (target.client.provider === 'xapi' && task.stage === 'provision-ready') {
      const submitCheckpoint = _taskRef(target.host.daemon_type, { taskRef: task.ref }, 'provision-submit');
      context.bindNativeTask(submitCheckpoint, 'submitting');
      const result = await bridge.provision(target, task.ref);
      const nativeTaskRef = _taskRef(target.host.daemon_type, result, 'provision');
      context.bindNativeTask(nativeTaskRef, 'pending');
      return { state: 'reconciling', phase: 'provision-task', delayMs: 1000 };
    }
    if (target.client.provider === 'xapi' && task.stage === 'provision-submit') {
      const state = await bridge.provisionState(target, task.ref);
      if (state.taskRef) {
        const nativeTaskRef = _taskRef(target.host.daemon_type, { taskRef: state.taskRef }, 'provision');
        context.bindNativeTask(nativeTaskRef, 'pending');
        return { state: 'reconciling', phase: 'provision-task', delayMs: 1000 };
      }
      if (state.state === 'complete') return _verify(context, target, database);
      if (Date.now() < _deadline(context.operation)) {
        context.reportProgress(72, 'provision-submit-recovery', 'Checking an interrupted XAPI provision submission without replay');
        return { state: 'reconciling', phase: 'provision-submit-recovery', delayMs: 3000 };
      }
      return { state: 'unknown', result: { provisionSubmitOutcomeUnconfirmed: true } };
    }
    if (target.host.daemon_type === 'proxmox' && task.stage === 'customize-ready') {
      const found = await bridge.findByName(target, context.request.name, database, { targetVmid: context.request.targetVmid });
      if (!found) return Date.now() < _deadline(context.operation)
        ? { state: 'reconciling', phase: 'customize-target', delayMs: 1500 }
        : { state: 'unknown', result: { customizationTargetUnconfirmed: true } };
      const checkpoint = _taskRef(target.host.daemon_type, { taskRef: found.nativeRef }, 'customize-submit');
      context.bindNativeTask(checkpoint, 'submitting');
      await bridge.customize(target, found, context.request.customization);
      const verifyRef = _taskRef(target.host.daemon_type, { taskRef: found.nativeRef }, 'customize-verify');
      context.bindNativeTask(verifyRef, 'verifying');
      return { state: 'reconciling', phase: 'customize-verify', delayMs: 500 };
    }
    if (target.host.daemon_type === 'proxmox' && task.stage === 'customize-submit') {
      const found = await bridge.findByName(target, context.request.name, database, { targetVmid: context.request.targetVmid });
      if (!found) return Date.now() < _deadline(context.operation)
        ? { state: 'reconciling', phase: 'customize-submit-recovery', delayMs: 1500 }
        : { state: 'unknown', result: { customizationSubmitOutcomeUnconfirmed: true } };
      const state = await bridge.customizationStatus(target, found, context.request.customization);
      if (!state.configured) await bridge.customize(target, found, context.request.customization);
      const verifyRef = _taskRef(target.host.daemon_type, { taskRef: found.nativeRef }, 'customize-verify');
      context.bindNativeTask(verifyRef, 'verifying');
      return { state: 'reconciling', phase: 'customize-verify', delayMs: 500 };
    }
    if (target.host.daemon_type === 'proxmox' && task.stage === 'customize-verify') {
      const found = await bridge.findByName(target, context.request.name, database, { targetVmid: context.request.targetVmid });
      if (!found) return Date.now() < _deadline(context.operation)
        ? { state: 'reconciling', phase: 'customize-verify', delayMs: 1500 }
        : { state: 'unknown', result: { customizationVerificationTargetUnconfirmed: true } };
      const state = await bridge.customizationStatus(target, found, context.request.customization);
      if (state.configured) return _verify(context, target, database);
      if (Date.now() >= _deadline(context.operation)) {
        return { state: 'unknown', result: { customizationOutcomeUnconfirmed: true } };
      }
      context.reportProgress(92, 'customize-verify', 'Waiting for Proxmox Cloud-Init configuration verification');
      return { state: 'reconciling', phase: 'customize-verify', delayMs: 1500 };
    }
    const status = await bridge.taskStatus(target, task);
    const outcome = _taskOutcome(target.host.daemon_type, status);
    if (outcome.failed) throw Object.assign(new Error(outcome.message), { code: 'PROVIDER_TASK_FAILED' });
    if (outcome.pending) {
      if (Date.now() >= _deadline(context.operation)) return { state: 'unknown', result: { nativeTaskTimedOut: true, stage: task.stage } };
      context.reportProgress(task.stage === 'clone' ? outcome.progress * 0.7 : 70 + outcome.progress * 0.25,
        `${task.stage}-task`, `Waiting for provider ${task.stage} task`);
      return { state: 'reconciling', phase: `${task.stage}-task`, delayMs: 1500 };
    }
    if (target.client.provider === 'xapi' && task.stage === 'clone') {
      let vmRef = bridge.taskResultRef(target, status);
      if (!vmRef) vmRef = (await bridge.findByName(target, context.request.name, database))?.nativeRef;
      if (!vmRef) return { state: 'reconciling', phase: 'clone-result', delayMs: 1500 };
      const nativeTaskRef = _taskRef(target.host.daemon_type, { taskRef: vmRef }, 'provision-ready');
      context.bindNativeTask(nativeTaskRef, 'ready');
      return { state: 'reconciling', phase: 'provision-ready', delayMs: 500 };
    }
    if (target.host.daemon_type === 'proxmox' && task.stage === 'clone' && context.request.customization) {
      const found = await bridge.findByName(target, context.request.name, database, { targetVmid: context.request.targetVmid });
      if (!found) return { state: 'reconciling', phase: 'clone-result', delayMs: 1500 };
      const nativeTaskRef = _taskRef(target.host.daemon_type, { taskRef: found.nativeRef }, 'customize-ready');
      context.bindNativeTask(nativeTaskRef, 'ready');
      return { state: 'reconciling', phase: 'customize-ready', delayMs: 500 };
    }
    return _verify(context, target, database);
  } finally { await bridge.close(target); }
}

async function cancel(context, options = {}) {
  const task = _parseTask(context.nativeTaskRef, context.operation.provider.type);
  if (!task?.ref || task.stage !== 'clone' || context.operation.provider.type !== 'proxmox') return { confirmed: false };
  const database = options.database || getDb();
  let target;
  try {
    target = await bridge.open(_host(context.operation, database), context.operation.resource.id, database);
    return { confirmed: await bridge.cancelTask(target, task), result: { providerTaskCancelled: true } };
  } catch { return { confirmed: false }; }
  finally { await bridge.close(target); }
}

function register(engine, options = {}) {
  engine.registerHandler({
    type: TYPE, idempotent: false, retryPolicy: 'none', timeoutSeconds: 300,
    execute: context => execute(context, options), reconcile: context => reconcile(context, options),
    cancel: context => cancel(context, options),
  });
}

module.exports = {
  TYPE, register, execute, reconcile, cancel,
  _internals: { _taskRef, _parseTask, _taskOutcome, _deadline, _host, _verify },
};
