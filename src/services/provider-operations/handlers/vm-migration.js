'use strict';

const migrationPreflight = require('../../provider-sdk/vm-migration-preflight');
const provider = require('../migration-provider');

const TYPE = 'vm.migrate';
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

function _error(message, code) { return Object.assign(new Error(message), { code }); }

async function _revalidate(target, operation, request, options) {
  const envelope = await migrationPreflight.preflightForHost(target.host, operation.resource.id, {
    database: options.database, executionEnabled: true,
  });
  const candidate = envelope.candidates.find(item => item.target.id === request.targetId);
  const mode = candidate?.modes?.[request.mode];
  if (!candidate || mode?.state !== 'ready') {
    const reason = mode?.blockers?.[0]?.reason || 'Migration target is no longer ready';
    throw _error(reason, 'VM_MIGRATION_REVALIDATION_BLOCKED');
  }
  if (request.sourceTargetId && envelope.sourceTargetId !== request.sourceTargetId) {
    throw _error('VM source placement changed after approval', 'VM_MIGRATION_SOURCE_CHANGED');
  }
  return { envelope, candidate };
}

async function execute(context, options = {}) {
  const target = await provider.open(context.operation, context.request, options.database);
  try {
    const row = await provider.readVm(target);
    if (provider.isOnTarget(target, row)) {
      return { state: 'succeeded', phase: 'verified', result: {
        targetId: context.request.targetId, mode: context.request.mode,
        powerState: provider.powerState(row), verified: true, alreadyOnTarget: true,
      } };
    }
    await _revalidate(target, context.operation, context.request, options);
    await provider.revalidateTarget(target, row, context.request);
    context.reportProgress(15, 'pre-submit', 'Migration target and provider compatibility revalidated');
    const result = await provider.submit(target, row, context.request);
    const nativeTaskRef = provider.taskRef(target, result);
    if (!nativeTaskRef) throw _error('Provider migration returned no durable task', 'INVALID_PROVIDER_TASK_RESPONSE');
    return { state: 'reconciling', nativeTaskRef, nativeTaskState: 'pending', phase: 'native-task', delayMs: 1500 };
  } finally { await provider.close(target); }
}

async function reconcile(context, options = {}) {
  const target = await provider.open(context.operation, context.request, options.database);
  try {
    const task = provider.parseTask(context.nativeTaskRef, target.host.daemon_type);
    if (!task) {
      const row = await provider.readVm(target);
      if (provider.isOnTarget(target, row)) {
        return { state: 'succeeded', phase: 'verified', result: {
          targetId: context.request.targetId, mode: context.request.mode,
          powerState: provider.powerState(row), verified: true, recoveredByPlacement: true,
        } };
      }
      return { state: 'unknown', result: {
        targetId: context.request.targetId, mode: context.request.mode,
        observedOnTarget: false, reason: 'Native submission result was not captured; mutation was not replayed',
      } };
    }
    const outcome = provider.taskOutcome(target.host.daemon_type, await provider.taskStatus(target, task));
    if (outcome.failed) throw _error(outcome.message, 'PROVIDER_TASK_FAILED');
    if (outcome.pending) {
      context.reportProgress(outcome.progress, 'native-task', 'Waiting for provider migration task');
      return { state: 'reconciling', phase: 'native-task', delayMs: 2000 };
    }
    const row = await provider.readVm(target);
    const observedPowerState = provider.powerState(row);
    const expectedPowerState = context.request.expectedPowerState;
    if (provider.isOnTarget(target, row) && (!expectedPowerState || expectedPowerState === observedPowerState)) {
      return { state: 'succeeded', phase: 'verified', result: {
        targetId: context.request.targetId, mode: context.request.mode,
        powerState: observedPowerState, verified: true,
      } };
    }
    const startedAt = Date.parse(context.operation.startedAt || context.operation.createdAt || 0);
    if (Number.isFinite(startedAt) && Date.now() - startedAt < VERIFY_TIMEOUT_MS) {
      context.reportProgress(96, 'post-verify', 'Waiting for migrated VM placement verification', {
        observedOnTarget: provider.isOnTarget(target, row), observedPowerState, expectedPowerState,
      });
      return { state: 'reconciling', phase: 'post-verify', delayMs: 3000 };
    }
    return { state: 'unknown', result: {
      targetId: context.request.targetId, mode: context.request.mode,
      observedOnTarget: provider.isOnTarget(target, row), observedPowerState, expectedPowerState,
    } };
  } finally { await provider.close(target); }
}

async function cancel(context, options = {}) {
  const task = provider.parseTask(context.nativeTaskRef, context.operation.provider.type);
  if (!task) return { confirmed: false };
  const target = await provider.open(context.operation, context.request, options.database);
  try {
    const confirmed = await provider.cancel(target, task);
    return { confirmed, ...(confirmed ? { result: { providerTaskCancelled: true } } : {}) };
  } catch { return { confirmed: false }; }
  finally { await provider.close(target); }
}

function register(engine, options = {}) {
  engine.registerHandler({
    type: TYPE, idempotent: false, retryPolicy: 'none', timeoutSeconds: 86400,
    execute: context => execute(context, options),
    reconcile: context => reconcile(context, options),
    cancel: context => cancel(context, options),
  });
}

module.exports = { TYPE, register, execute, reconcile, cancel, _internals: { _revalidate } };
