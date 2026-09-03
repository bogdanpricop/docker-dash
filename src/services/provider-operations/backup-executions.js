'use strict';

const config = require('../../config');
const { getDb } = require('../../db');
const { generateToken, sha256 } = require('../../utils/crypto');
const log = require('../../utils/logger')('provider-backup-executions');
const audit = require('../audit');
const registry = require('../provider-sdk/registry');
const engineSingleton = require('./index');
const policies = require('./backup-policies');
const backupControl = require('./backup-control-plane');

const SCHEMA_VERSION = '1.1';
const SAFE_EXECUTION_ID = /^pbex_[a-f0-9]{26}$/;
const SAFE_ITEM_ID = /^pbei_[a-f0-9]{26}$/;
const SAFE_POLICY_ID = /^pbp_[a-f0-9]{26}$/;
const SAFE_RUN_ID = /^pbpr_[a-f0-9]{26}$/;
const ACTIVE_STATES = new Set(['queued', 'running', 'verification_pending']);
const TERMINAL_OPERATION_STATES = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);
const MAX_EXECUTIONS_PER_TICK = 20;

class BackupExecutionError extends Error {
  constructor(message, code = 'PROVIDER_BACKUP_EXECUTION_ERROR', status = 400, details = null) {
    super(message); this.name = 'BackupExecutionError'; this.code = code; this.status = status; this.details = details;
  }
}

function _database(options = {}) { return options.database || getDb(); }
function _engine(options = {}) { return options.engine || engineSingleton; }
function _parse(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function _now() { return new Date().toISOString(); }
function _canonical(value) {
  if (Array.isArray(value)) return `[${value.map(_canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${_canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function _publicItem(row) {
  if (!row) return null;
  return {
    schemaVersion: SCHEMA_VERSION, id: row.id, executionId: row.execution_id,
    workloadId: row.workload_id, operationId: row.operation_id || null,
    state: row.state, recoveryPointId: row.recovery_point_id || null,
    verificationState: row.verification_state, errorCode: row.error_code || null,
    admission: _parse(row.admission_json, {}), integrity: _parse(row.integrity_json, {}),
    createdAt: row.created_at, startedAt: row.started_at || null,
    completedAt: row.completed_at || null, updatedAt: row.updated_at,
  };
}

function _publicExecution(row, database, withItems = true) {
  if (!row) return null;
  const value = {
    schemaVersion: SCHEMA_VERSION, id: row.id, policyId: row.policy_id,
    planRunId: row.plan_run_id, trigger: row.trigger_type, state: row.state,
    planHash: row.plan_hash, summary: _parse(row.summary_json, {}),
    contract: _parse(row.contract_json, {}),
    createdBy: row.created_by || null, createdAt: row.created_at,
    startedAt: row.started_at || null, completedAt: row.completed_at || null,
    updatedAt: row.updated_at,
  };
  if (withItems) value.items = database.prepare(`SELECT * FROM provider_backup_execution_items
    WHERE execution_id = ? ORDER BY created_at, id`).all(row.id).map(_publicItem);
  return value;
}

function get(idInput, options = {}) {
  const id = String(idInput || ''); const database = _database(options);
  if (!SAFE_EXECUTION_ID.test(id)) return null;
  return _publicExecution(database.prepare('SELECT * FROM provider_backup_executions WHERE id = ?').get(id), database);
}

function listForHost(hostIdInput, options = {}) {
  const hostId = Number(hostIdInput); const database = _database(options);
  const limit = Math.min(200, Math.max(1, Number(options.limit) || 50));
  if (!Number.isInteger(hostId) || hostId <= 0) return [];
  const policyId = options.policyId ? String(options.policyId) : null;
  if (policyId && !SAFE_POLICY_ID.test(policyId)) return [];
  return database.prepare(`SELECT e.* FROM provider_backup_executions e
    JOIN provider_backup_policies p ON p.id=e.policy_id
    WHERE p.host_id=? AND (? IS NULL OR e.policy_id=?)
    ORDER BY e.created_at DESC, e.id DESC LIMIT ?`).all(hostId, policyId, policyId, limit)
    .map(row => _publicExecution(row, database));
}

function getForHost(hostIdInput, executionId, options = {}) {
  const hostId = Number(hostIdInput); const database = _database(options);
  if (!Number.isInteger(hostId) || hostId <= 0 || !SAFE_EXECUTION_ID.test(String(executionId || ''))) return null;
  const row = database.prepare(`SELECT e.* FROM provider_backup_executions e
    JOIN provider_backup_policies p ON p.id=e.policy_id WHERE e.id=? AND p.host_id=?`).get(executionId, hostId);
  return _publicExecution(row, database);
}

function authorizeForHost(host, policyIdInput, input = {}, options = {}) {
  if (!config.features.providerBackupExecution && options.enabled !== true) {
    throw new BackupExecutionError('Provider backup execution is disabled by release policy', 'BACKUP_EXECUTION_DISABLED', 404);
  }
  const database = _database(options); const policy = policies.get(policyIdInput, { database });
  if (!policy || policy.hostId !== Number(host.id)) throw new BackupExecutionError('Backup policy was not found', 'BACKUP_POLICY_NOT_FOUND', 404);
  const mode = String(input.mode || '');
  if (!['disabled', 'manual', 'scheduled'].includes(mode)) {
    throw new BackupExecutionError('Execution mode must be disabled, manual or scheduled', 'INVALID_BACKUP_EXECUTION_MODE');
  }
  if (mode !== 'disabled') {
    if (host.daemon_type !== 'proxmox') throw new BackupExecutionError('This provider has no conformance-tested backup mutation API', 'BACKUP_PROVIDER_UNSUPPORTED', 409);
    if (String(input.confirmName || '') !== policy.name) throw new BackupExecutionError('Typed policy-name confirmation is required', 'BACKUP_CONFIRMATION_REQUIRED', 409);
    if (mode === 'scheduled' && !policy.enabled) throw new BackupExecutionError('Scheduled execution requires an enabled policy', 'BACKUP_POLICY_DISABLED', 409);
  }
  database.prepare(`UPDATE provider_backup_policies SET execution_mode=?, execution_authorized_by=?,
    execution_authorized_at=?, updated_at=datetime('now') WHERE id=? AND host_id=?`).run(
    mode, mode === 'disabled' ? null : (options.createdBy || null), mode === 'disabled' ? null : _now(), policy.id, Number(host.id));
  return policies.get(policy.id, { database });
}

function _run(runId, policyId, database) {
  if (!SAFE_RUN_ID.test(String(runId || ''))) return null;
  return database.prepare(`SELECT * FROM provider_backup_policy_runs
    WHERE id=? AND policy_id=?`).get(runId, policyId);
}

function _windowAllows(window, nowInput = new Date()) {
  if (!window) return true;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: window.timezone, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
  }).formatToParts(nowInput).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  if (window.days?.length && !window.days.includes(day)) return false;
  const value = `${parts.hour}:${parts.minute}`;
  return window.start <= window.end ? value >= window.start && value <= window.end
    : value >= window.start || value <= window.end;
}

async function _executionPreflight(host, policy, plan, options = {}) {
  const blockers = [];
  const capabilities = await (options.registry || registry).capabilitiesForHost(host, { refresh: true });
  const evidence = capabilities.features?.['backup.run'];
  if (!['supported', 'conditional'].includes(evidence?.state)) blockers.push({ code: 'BACKUP_PROVIDER_UNSUPPORTED', message: evidence?.reason || 'Provider backup mutation is unavailable' });
  if (host.daemon_type !== 'proxmox') blockers.push({ code: 'BACKUP_PROVIDER_UNSUPPORTED', message: 'Only the conformance-tested Proxmox vzdump mutation path is enabled' });
  if (policy.backupMode === 'incremental' && plan.repository?.repositoryType !== 'proxmox-backup-server') {
    blockers.push({ code: 'BACKUP_MODE_UNSUPPORTED', message: 'Incremental execution requires a Proxmox Backup Server repository' });
  }
  if (policy.backupMode === 'full' && plan.repository?.repositoryType === 'proxmox-backup-server') {
    blockers.push({ code: 'BACKUP_MODE_UNSUPPORTED', message: 'PBS controls chunk reuse and cannot prove a forced-full execution through vzdump' });
  }
  if (policy.consistency.requested !== 'crash') blockers.push({ code: 'BACKUP_CONSISTENCY_UNSUPPORTED', message: 'Proxmox execution currently requires crash-consistent policy semantics' });
  if (policy.scope.exclusions.diskSelectors.length) blockers.push({ code: 'BACKUP_DISK_EXCLUSIONS_UNSUPPORTED', message: 'Disk exclusions cannot be translated safely to vzdump' });
  if (policy.scope.exclusions.pathSelectors?.length) blockers.push({ code: 'BACKUP_PATH_EXCLUSIONS_UNSUPPORTED', message: 'File-path exclusions require a file-aware provider backup adapter' });
  if (policy.consistency.preFreezeHookRef || policy.consistency.postThawHookRef) {
    blockers.push({ code: 'BACKUP_CONSISTENCY_HOOKS_UNSUPPORTED', message: 'Inline execution of consistency hooks is not supported by the vzdump adapter' });
  }
  if (!_windowAllows(policy.controls.window, options.now || new Date())) blockers.push({ code: 'BACKUP_WINDOW_CLOSED', message: 'Current time is outside the authorized backup window' });
  if (policy.verification.afterBackup && plan.repository?.capabilities?.verification !== true) {
    blockers.push({ code: 'BACKUP_VERIFICATION_UNPROVEN', message: 'Required post-backup verification is not supported by the selected repository' });
  }
  const verificationCapabilities = {
    provider: plan.repository?.capabilities?.verification,
    metadata: true,
    checksum: plan.repository?.capabilities?.checksumVerification,
    chain: plan.repository?.capabilities?.chainVerification,
  };
  if (policy.verification.afterBackup) {
    for (const method of policy.verification.requiredMethods || ['provider']) {
      if (verificationCapabilities[method] !== true) blockers.push({
        code: `BACKUP_${method.toUpperCase()}_VERIFICATION_UNPROVEN`,
        message: `${method} integrity verification is not proven by the selected repository`,
      });
    }
  }
  const contract = backupControl.buildContract(host, policy, plan, { capability: evidence || null });
  return { allowed: plan.allowed && blockers.length === 0, blockers, capability: evidence || null, contract };
}

function _existing(policyId, key, requestHash, database) {
  const keyHash = sha256(`${policyId}|${key}`);
  const row = database.prepare(`SELECT * FROM provider_backup_executions
    WHERE policy_id=? AND idempotency_key_hash=?`).get(policyId, keyHash);
  if (!row) return { keyHash, execution: null };
  if (row.request_hash !== requestHash) throw new BackupExecutionError('Idempotency key was already used for a different execution request', 'IDEMPOTENCY_KEY_CONFLICT', 409);
  return { keyHash, execution: _publicExecution(row, database) };
}

async function createForHost(host, policyIdInput, input = {}, options = {}) {
  if (!config.features.providerBackupExecution && options.enabled !== true) throw new BackupExecutionError('Provider backup execution is disabled by release policy', 'BACKUP_EXECUTION_DISABLED', 404);
  const database = _database(options); const policy = policies.get(policyIdInput, { database });
  if (!policy || policy.hostId !== Number(host.id)) throw new BackupExecutionError('Backup policy was not found', 'BACKUP_POLICY_NOT_FOUND', 404);
  const trigger = options.trigger === 'scheduled' ? 'scheduled' : 'manual';
  if (policy.execution.mode !== trigger && !(trigger === 'manual' && policy.execution.mode === 'scheduled')) {
    throw new BackupExecutionError('Backup execution is not authorized for this trigger', 'BACKUP_EXECUTION_NOT_AUTHORIZED', 409);
  }
  if (trigger === 'manual' && String(input.confirmName || '') !== policy.name) throw new BackupExecutionError('Typed policy-name confirmation is required', 'BACKUP_CONFIRMATION_REQUIRED', 409);
  const idempotencyKey = String(options.idempotencyKey || '');
  if (!/^[\x21-\x7e]{8,200}$/.test(idempotencyKey)) throw new BackupExecutionError('Idempotency-Key must contain 8-200 visible ASCII characters', 'INVALID_IDEMPOTENCY_KEY');
  const requestCore = { policyId: policy.id, planRunId: input.planRunId || null, planHash: input.planHash || null, trigger };
  const requestHash = sha256(_canonical(requestCore));
  const duplicate = _existing(policy.id, idempotencyKey, requestHash, database);
  if (duplicate.execution) return { execution: duplicate.execution, deduplicated: true };

  let run = input.planRunId ? _run(input.planRunId, policy.id, database) : null;
  if (input.planRunId && !run) throw new BackupExecutionError('Backup plan run was not found', 'BACKUP_PLAN_NOT_FOUND', 404);
  if (!run) {
    const planned = await policies.planForHost(host, policy.id, {
      database, createdBy: options.createdBy || policy.createdBy, trigger: trigger === 'scheduled' ? 'scheduled' : 'manual',
      ...(options.slotKey ? { slotKey: options.slotKey } : {}),
    });
    run = _run(planned.id, policy.id, database);
  }
  if (run.state !== 'planned') throw new BackupExecutionError('Blocked backup plan cannot be executed', 'BACKUP_PLAN_BLOCKED', 409);
  if (input.planHash && input.planHash !== run.plan_hash) throw new BackupExecutionError('Requested backup plan hash does not match the accepted run', 'BACKUP_PLAN_CHANGED', 409);
  const currentPlan = await policies.preflightForHost(host, { ...policy, id: policy.id }, { database, existing: policy });
  if (currentPlan.planHash !== run.plan_hash) throw new BackupExecutionError('Live backup evidence changed after planning; create a new plan', 'BACKUP_PLAN_CHANGED', 409);
  const executionPreflight = await _executionPreflight(host, policy, currentPlan, options);
  if (!executionPreflight.allowed) throw new BackupExecutionError('Backup execution is blocked by live safety checks', 'BACKUP_EXECUTION_PREFLIGHT_BLOCKED', 409, { blockers: executionPreflight.blockers });
  const recovery = await (options.registry || registry).recoveryPointsForHost(host, {
    repositoryId: policy.repositoryId, limit: 500, database,
  });
  if (recovery.truncated) throw new BackupExecutionError('Baseline recovery-point inventory is truncated', 'BACKUP_BASELINE_TRUNCATED', 409);

  const executionId = `pbex_${generateToken(13)}`;
  const summary = { total: currentPlan.scope.workloads.length, queued: currentPlan.scope.workloads.length,
    running: 0, verificationPending: 0, succeeded: 0, failed: 0, cancelled: 0, unknown: 0,
    recoveryPointsObserved: 0, retentionMutationAuthorized: false };
  database.transaction(() => {
    database.prepare(`INSERT INTO provider_backup_executions
      (id,policy_id,plan_run_id,trigger_type,state,plan_hash,idempotency_key_hash,request_hash,summary_json,contract_json,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(executionId, policy.id, run.id, trigger, 'queued', run.plan_hash,
      duplicate.keyHash, requestHash, JSON.stringify(summary), JSON.stringify(executionPreflight.contract), options.createdBy || null);
    const insert = database.prepare(`INSERT INTO provider_backup_execution_items
      (id,execution_id,workload_id,baseline_point_ids_json,baseline_hash) VALUES (?,?,?,?,?)`);
    for (const workload of currentPlan.scope.workloads) {
      const baseline = recovery.items.filter(point => point.workload?.id === workload.id).map(point => point.id).sort();
      insert.run(`pbei_${generateToken(13)}`, executionId, workload.id, JSON.stringify(baseline), sha256(JSON.stringify(baseline)));
    }
  })();
  await reconcile({ ...options, database, executionId });
  return { execution: get(executionId, { database }), deduplicated: false };
}

function _dispatch(execution, policy, database, engine) {
  for (const item of execution.items.filter(value => value.state === 'queued')) {
    const host = database.prepare('SELECT daemon_type FROM docker_hosts WHERE id=?').get(policy.hostId);
    const admission = backupControl.admission(database, { ...policy, providerType: host?.daemon_type });
    if (!admission.allowed) break;
    const row = database.prepare('SELECT baseline_point_ids_json FROM provider_backup_execution_items WHERE id=?').get(item.id);
    const workload = execution.contract?.selection?.selected?.find(value => value.id === item.workloadId) || {};
    const bandwidth = backupControl.bandwidth(policy, workload);
    const operation = engine.create({
      type: 'vm.backup', providerType: 'proxmox', hostId: policy.hostId,
      resourceKind: 'virtualMachine', resourceId: item.workloadId, action: 'create',
      idempotencyKey: `backup:${execution.id}:${item.workloadId}`,
      request: {
        executionId: execution.id, policyId: policy.id, repositoryId: policy.repositoryId,
        planHash: execution.planHash, baselinePointIds: _parse(row.baseline_point_ids_json, []),
        backupMode: policy.backupMode || 'provider',
        consistency: policy.consistency.requested,
        exclusions: policy.scope.exclusions,
        protection: policy.protection,
        verification: policy.verification,
        bandwidthLimitMbps: bandwidth.limitMbps,
        bandwidthEvidence: bandwidth,
        verificationRequired: policy.verification.afterBackup,
      },
      lockScopes: [`resource:${item.workloadId}`, `repository:${policy.repositoryId}`],
      createdBy: execution.createdBy,
    });
    database.prepare(`UPDATE provider_backup_execution_items SET operation_id=?, state='running',admission_json=?,
      started_at=COALESCE(started_at,datetime('now')),updated_at=datetime('now') WHERE id=? AND state='queued'`)
      .run(operation.id, JSON.stringify(admission), item.id);
  }
}

async function _refreshVerification(host, execution, policy, database, registryService) {
  const pending = execution.items.filter(item => item.state === 'verification_pending' && item.recoveryPointId);
  if (!pending.length) return;
  let inventory;
  try { inventory = await registryService.recoveryPointsForHost(host, { repositoryId: policy.repositoryId, limit: 500, database }); }
  catch (err) {
    log.warn('Backup verification inventory refresh failed', { executionId: execution.id, code: err.code || 'RECOVERY_READ_FAILED' });
    return;
  }
  if (inventory.truncated) {
    log.warn('Backup verification inventory is truncated', { executionId: execution.id });
    return;
  }
  const points = new Map(inventory.items.map(point => [point.id, point]));
  const deadline = Date.parse(execution.createdAt) + policy.verification.maximumUnverifiedHours * 3600_000;
  for (const item of pending) {
    const point = points.get(item.recoveryPointId);
    const evidence = backupControl.evaluateIntegrity(point, policy);
    backupControl.rememberIntegrity(database, item.id, evidence);
    const reportedState = point?.verification?.state || 'unknown';
    if (evidence.state === 'verified') database.prepare(`UPDATE provider_backup_execution_items SET state='succeeded',verification_state='verified',completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(item.id);
    else if (evidence.state === 'failed') database.prepare(`UPDATE provider_backup_execution_items SET state='failed',verification_state='failed',error_code='BACKUP_INTEGRITY_FAILED',completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(item.id);
    else if (Date.now() >= deadline) database.prepare(`UPDATE provider_backup_execution_items SET state='unknown',verification_state=?,error_code='BACKUP_VERIFICATION_TIMEOUT',completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(reportedState, item.id);
    else database.prepare(`UPDATE provider_backup_execution_items SET verification_state=?,updated_at=datetime('now') WHERE id=?`).run(reportedState, item.id);
  }
}

function _syncOperations(execution, policy, database, engine) {
  for (const item of execution.items.filter(value => value.operationId && ['running'].includes(value.state))) {
    const operation = engine.get(item.operationId);
    if (!operation || !TERMINAL_OPERATION_STATES.has(operation.state)) continue;
    if (operation.state === 'succeeded') {
      const result = operation.result || {}; const verification = result.verificationState || 'unknown';
      const recoveryPointProven = /^ddr_rp_[a-f0-9]{26}$/.test(String(result.recoveryPointId || ''));
      const requiresEvidence = policy.verification.afterBackup
        || policy.protection?.encryption?.mode === 'required'
        || policy.protection?.immutability?.mode === 'required';
      const state = !recoveryPointProven ? 'unknown'
        : requiresEvidence ? 'verification_pending' : 'succeeded';
      database.prepare(`UPDATE provider_backup_execution_items SET state=?,recovery_point_id=?,verification_state=?,
        error_code=?,completed_at=CASE WHEN ?='verification_pending' THEN NULL ELSE datetime('now') END,updated_at=datetime('now') WHERE id=?`)
        .run(state, recoveryPointProven ? result.recoveryPointId : null, verification,
          !recoveryPointProven ? 'BACKUP_RECOVERY_POINT_UNPROVEN'
            : null, state, item.id);
    } else {
      database.prepare(`UPDATE provider_backup_execution_items SET state=?,error_code=?,completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`)
        .run(operation.state, operation.error?.code || `BACKUP_OPERATION_${operation.state.toUpperCase()}`, item.id);
    }
  }
}

function _summarize(executionId, database) {
  const items = database.prepare('SELECT state,recovery_point_id FROM provider_backup_execution_items WHERE execution_id=?').all(executionId);
  const count = state => items.filter(item => item.state === state).length;
  const summary = { total: items.length, queued: count('queued'), running: count('running'),
    verificationPending: count('verification_pending'), succeeded: count('succeeded'), failed: count('failed'),
    cancelled: count('cancelled'), unknown: count('unknown'),
    recoveryPointsObserved: items.filter(item => item.recovery_point_id).length,
    retentionMutationAuthorized: false };
  let state = 'running';
  if (summary.queued || summary.running) state = 'running';
  else if (summary.verificationPending) state = 'verification_pending';
  else if (summary.succeeded === summary.total) state = 'succeeded';
  else if (summary.succeeded > 0) state = 'partial';
  else if (summary.failed > 0) state = 'failed';
  else if (summary.unknown > 0) state = 'unknown';
  else if (summary.cancelled === summary.total) state = 'cancelled';
  const terminal = !ACTIVE_STATES.has(state);
  database.prepare(`UPDATE provider_backup_executions SET state=?,summary_json=?,started_at=COALESCE(started_at,datetime('now')),
    completed_at=CASE WHEN ? THEN COALESCE(completed_at,datetime('now')) ELSE NULL END,updated_at=datetime('now') WHERE id=?`)
    .run(state, JSON.stringify(summary), terminal ? 1 : 0, executionId);
  return { state, summary };
}

async function reconcile(options = {}) {
  if (!config.features.providerBackupExecution && options.enabled !== true) return { updated: [], skipped: 'disabled' };
  const database = _database(options); const engine = _engine(options); const registryService = options.registry || registry;
  const rows = options.executionId
    ? database.prepare('SELECT * FROM provider_backup_executions WHERE id=?').all(options.executionId)
    : database.prepare(`SELECT * FROM provider_backup_executions WHERE state IN ('queued','running','verification_pending') ORDER BY created_at LIMIT ?`).all(MAX_EXECUTIONS_PER_TICK);
  const updated = [];
  for (const row of rows) {
    const execution = _publicExecution(row, database); const policy = policies.get(execution.policyId, { database });
    if (!policy) continue;
    const host = database.prepare('SELECT * FROM docker_hosts WHERE id=? AND is_active=1').get(policy.hostId);
    if (!host) continue;
    _syncOperations(execution, policy, database, engine);
    await _refreshVerification(host, _publicExecution(row, database), policy, database, registryService);
    _dispatch(_publicExecution(row, database), policy, database, engine);
    const outcome = _summarize(execution.id, database); updated.push({ executionId: execution.id, ...outcome });
    if (!ACTIVE_STATES.has(outcome.state)) {
      try { audit.log({ username: 'system', action: 'provider_backup_execution_completed', targetType: 'provider_host',
        targetId: String(policy.hostId), details: { policyId: policy.id, executionId: execution.id,
          state: outcome.state, summary: outcome.summary } }); } catch { /* execution tables are authoritative */ }
    }
  }
  return { updated };
}

async function cancelForHost(host, executionId, input = {}, options = {}) {
  if (!config.features.providerBackupExecution && options.enabled !== true) throw new BackupExecutionError('Provider backup execution is disabled by release policy', 'BACKUP_EXECUTION_DISABLED', 404);
  const database = _database(options); const engine = _engine(options);
  const execution = getForHost(host.id, executionId, { database });
  if (!execution) throw new BackupExecutionError('Backup execution was not found', 'BACKUP_EXECUTION_NOT_FOUND', 404);
  if (!ACTIVE_STATES.has(execution.state)) throw new BackupExecutionError(`Backup execution is already ${execution.state}`, 'BACKUP_EXECUTION_ALREADY_TERMINAL', 409);
  const policy = policies.get(execution.policyId, { database });
  if (!policy) throw new BackupExecutionError('Backup policy was not found', 'BACKUP_POLICY_NOT_FOUND', 404);
  if (String(input.confirmName || '') !== policy.name) throw new BackupExecutionError('Typed policy-name confirmation is required', 'BACKUP_CONFIRMATION_REQUIRED', 409);
  database.prepare(`UPDATE provider_backup_execution_items SET state='cancelled',
    error_code='BACKUP_EXECUTION_CANCELLED',completed_at=datetime('now'),updated_at=datetime('now')
    WHERE execution_id=? AND state='queued'`).run(execution.id);
  database.prepare(`UPDATE provider_backup_execution_items SET state='unknown',
    error_code='BACKUP_VERIFICATION_CANCELLED',completed_at=datetime('now'),updated_at=datetime('now')
    WHERE execution_id=? AND state='verification_pending'`).run(execution.id);
  for (const item of execution.items.filter(value => value.state === 'running' && value.operationId)) {
    try { engine.requestCancel(item.operationId); }
    catch (err) {
      if (err?.code !== 'OPERATION_ALREADY_TERMINAL') throw err;
    }
  }
  await reconcile({ ...options, database, engine, executionId: execution.id });
  return getForHost(host.id, execution.id, { database });
}

async function runScheduled(options = {}) {
  if (!config.features.providerBackupExecution && options.enabled !== true) return { started: [], skipped: 'disabled' };
  const database = _database(options);
  const rows = database.prepare(`SELECT r.id AS run_id,r.plan_hash,p.id AS policy_id,p.host_id,p.created_by
    FROM provider_backup_policy_runs r JOIN provider_backup_policies p ON p.id=r.policy_id
    LEFT JOIN provider_backup_executions e ON e.plan_run_id=r.id
    WHERE r.trigger_type='scheduled' AND r.state='planned' AND p.execution_mode='scheduled'
      AND p.enabled=1 AND p.deleted_at IS NULL AND e.id IS NULL ORDER BY r.created_at LIMIT ?`).all(MAX_EXECUTIONS_PER_TICK);
  const started = []; const errors = [];
  for (const row of rows) {
    const host = database.prepare('SELECT * FROM docker_hosts WHERE id=? AND is_active=1').get(row.host_id);
    if (!host) continue;
    try {
      const result = await createForHost(host, row.policy_id, { planRunId: row.run_id, planHash: row.plan_hash }, {
        ...options, database, trigger: 'scheduled', createdBy: row.created_by,
        idempotencyKey: `scheduled:${row.run_id}`,
      });
      started.push(result.execution);
    } catch (err) {
      errors.push({ policyId: row.policy_id, runId: row.run_id, code: err.code || 'BACKUP_EXECUTION_FAILED' });
      log.error('Scheduled backup execution failed closed', { policyId: row.policy_id, runId: row.run_id, code: err.code || 'BACKUP_EXECUTION_FAILED' });
    }
  }
  return { started, errors };
}

module.exports = {
  SCHEMA_VERSION, BackupExecutionError, get, getForHost, listForHost, authorizeForHost,
  createForHost, cancelForHost, reconcile, runScheduled,
  _internals: { SAFE_EXECUTION_ID, SAFE_ITEM_ID, _publicItem, _publicExecution, _windowAllows,
    _executionPreflight, _summarize, _syncOperations, _refreshVerification, _dispatch },
};
