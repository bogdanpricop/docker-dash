'use strict';

const config = require('../../config');
const { getDb } = require('../../db');
const { generateToken, sha256 } = require('../../utils/crypto');
const log = require('../../utils/logger')('provider-restore-drills');
const audit = require('../audit');
const registrySingleton = require('../provider-sdk/registry');
const identityStore = require('../provider-sdk/identity-store');
const operationsSingleton = require('./index');
const recoveryRestore = require('./recovery-restore');
const backupPolicies = require('./backup-policies');
const { fromHostRow } = require('../proxmox');
const { TYPE } = require('./handlers/recovery-drill');

const SCHEMA_VERSION = '1.0';
const SAFE_POLICY_ID = /^pdrp_[a-f0-9]{26}$/;
const SAFE_RUN_ID = /^pdrr_[a-f0-9]{26}$/;
const SAFE_POINT_ID = /^ddr_rp_[a-f0-9]{26}$/;
const SAFE_NODE_ID = /^ddr_host_[a-f0-9]{26}$/;
const SAFE_STORAGE_ID = /^ddr_storage_[a-f0-9]{26}$/;
const FREQUENCIES = new Set(['hourly', 'daily', 'weekly', 'monthly']);
const ACTIVE_OPERATION_STATES = new Set([
  'queued', 'running', 'waiting_retry', 'reconciling', 'cancel_requested',
]);
const MAX_POLICIES_PER_TICK = 10;

class RestoreDrillError extends Error {
  constructor(message, code = 'RESTORE_DRILL_ERROR', status = 400, details = null) {
    super(message); this.name = 'RestoreDrillError'; this.code = code;
    this.status = status; this.details = details;
  }
}

function _database(options = {}) { return options.database || getDb(); }
function _registry(options = {}) { return options.registry || registrySingleton; }
function _operations(options = {}) { return options.operations || operationsSingleton; }
function _now() { return new Date().toISOString(); }
function _parseJson(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function _canonical(value) {
  if (Array.isArray(value)) return `[${value.map(_canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${_canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function _text(value, max = 240) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}
function _integer(value, min, max, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new RestoreDrillError(`${label} must be an integer between ${min} and ${max}`,
      'INVALID_RESTORE_DRILL');
  }
  return number;
}
function _nullableInteger(value, min, max, fallback, label) {
  if (value === null || value === '') return null;
  return _integer(value, min, max, fallback, label);
}
function _timezone(value) {
  const zone = _text(value || 'UTC', 80);
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date()); }
  catch { throw new RestoreDrillError('Schedule timezone must be a valid IANA timezone', 'INVALID_RESTORE_DRILL_POLICY'); }
  return zone;
}
function _schedule(input = {}, previous = {}) {
  const frequency = String(input.frequency ?? previous.frequency ?? 'weekly');
  if (!FREQUENCIES.has(frequency)) throw new RestoreDrillError(
    'Schedule frequency must be hourly, daily, weekly or monthly', 'INVALID_RESTORE_DRILL_POLICY');
  const minute = _integer(input.minute, 0, 45, previous.minute ?? 15, 'Schedule minute');
  if (![0, 15, 30, 45].includes(minute)) throw new RestoreDrillError(
    'Schedule minute must be 0, 15, 30 or 45', 'INVALID_RESTORE_DRILL_POLICY');
  return {
    frequency, minute,
    hour: _integer(input.hour, 0, 23, previous.hour ?? 3, 'Schedule hour'),
    weekday: _integer(input.weekday, 0, 6, previous.weekday ?? 0, 'Schedule weekday'),
    dayOfMonth: _integer(input.dayOfMonth, 1, 28, previous.dayOfMonth ?? 1, 'Schedule day of month'),
    timezone: _timezone(input.timezone ?? previous.timezone ?? 'UTC'),
  };
}
function _assertions(input = {}, guestType = null, policy = false) {
  let guestAgent = String(input.guestAgent || (policy ? 'auto' : 'required'));
  if (policy && !['auto', 'required', 'optional', 'disabled'].includes(guestAgent)) {
    throw new RestoreDrillError('Guest-agent assertion must be auto, required, optional or disabled',
      'INVALID_RESTORE_DRILL_POLICY');
  }
  if (!policy && !['required', 'optional', 'disabled'].includes(guestAgent)) {
    throw new RestoreDrillError('Guest-agent assertion must be required, optional or disabled',
      'INVALID_RESTORE_DRILL');
  }
  if (guestType === 'lxc' && guestAgent !== 'disabled') {
    throw new RestoreDrillError('LXC drills require guest-agent assertion mode disabled',
      'INVALID_RESTORE_DRILL_ASSERTION');
  }
  if (guestType === 'qemu' && guestAgent === 'auto') guestAgent = 'required';
  if (guestType === 'lxc' && guestAgent === 'auto') guestAgent = 'disabled';
  return {
    boot: true, guestAgent,
    bootTimeoutSeconds: _integer(input.bootTimeoutSeconds, 30, 900,
      300, 'Boot assertion timeout'),
    osInfo: guestType === 'lxc' ? false : input.osInfo !== false,
  };
}
function _cleanup(input = {}, previous = {}) {
  const mode = String(input.cleanupMode ?? previous.cleanupMode ?? 'on_success');
  if (!['on_success', 'never'].includes(mode)) throw new RestoreDrillError(
    'Cleanup mode must be on_success or never', 'INVALID_RESTORE_DRILL');
  return {
    mode,
    shutdownTimeoutSeconds: _integer(input.shutdownTimeoutSeconds,
      30, 300, previous.shutdownTimeoutSeconds ?? 120, 'Shutdown timeout'),
    allowForceStop: true,
  };
}
function _durationSeconds(start, end) {
  const first = Date.parse(start || 0); const last = Date.parse(end || 0);
  return Number.isFinite(first) && Number.isFinite(last) && last >= first
    ? Math.round((last - first) / 1000) : null;
}
function _rpoAge(createdAt, nowInput = new Date()) {
  const created = Date.parse(createdAt || 0);
  const now = nowInput instanceof Date ? nowInput.getTime() : Date.parse(nowInput || 0);
  return Number.isFinite(created) && Number.isFinite(now) && now >= created
    ? Math.floor((now - created) / 1000) : null;
}
function _compliance(run) {
  if (run.state === 'blocked') return 'never_tested';
  if (!['succeeded'].includes(run.state)) return ['queued', 'running'].includes(run.state) ? 'unknown' : 'failed';
  if ((run.rpoTargetSeconds !== null && (run.rpoAgeSeconds === null
      || run.rpoAgeSeconds > run.rpoTargetSeconds))
    || (run.rtoTargetSeconds !== null && (run.rtoSeconds === null
      || run.rtoSeconds > run.rtoTargetSeconds))) return 'breached';
  return 'met';
}

function _publicPolicy(row) {
  if (!row) return null;
  const authorization = _parseJson(row.authorization_json, {});
  return {
    schemaVersion: SCHEMA_VERSION, id: row.id, hostId: Number(row.host_id),
    backupPolicyId: row.backup_policy_id, name: row.name, enabled: !!row.enabled,
    schedule: _parseJson(row.schedule_json, {}), target: {
      nodeId: row.target_node_id, storageId: row.target_storage_id,
    }, assertions: _parseJson(row.assertions_json, {}), cleanupMode: row.cleanup_mode,
    authorization: {
      scheduledExecution: authorization.scheduledExecution === true,
      automaticCleanup: authorization.automaticCleanup === true,
      authorizedAt: authorization.authorizedAt || null,
      authorizedBy: authorization.authorizedBy || null,
    },
    rpoTargetSeconds: row.rpo_target_seconds ?? null,
    rtoTargetSeconds: row.rto_target_seconds ?? null,
    lastSlotKey: row.last_slot_key || null, lastRunAt: row.last_run_at || null,
    createdBy: row.created_by || null, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function _publicRun(row, options = {}) {
  if (!row) return null;
  const run = {
    schemaVersion: SCHEMA_VERSION, id: row.id, policyId: row.policy_id || null,
    hostId: Number(row.host_id), recoveryPointId: row.recovery_point_id || null,
    operationId: row.operation_id || null, trigger: row.trigger_type, slotKey: row.slot_key,
    state: row.state, planHash: row.plan_hash, target: {
      nodeId: row.target_node_id, storageId: row.target_storage_id,
      vmid: row.target_vmid === null ? null : Number(row.target_vmid),
    }, assertions: _parseJson(row.assertions_json, {}), cleanupMode: row.cleanup_mode,
    rpoTargetSeconds: row.rpo_target_seconds ?? null,
    rtoTargetSeconds: row.rto_target_seconds ?? null,
    rpoAgeSeconds: row.rpo_age_seconds ?? null, rtoSeconds: row.rto_seconds ?? null,
    cleanupSeconds: row.cleanup_seconds ?? null,
    evidence: _parseJson(row.evidence_json, {}), evidenceHash: row.evidence_hash || null,
    error: row.error_code ? { code: row.error_code } : null,
    createdBy: row.created_by || null, createdAt: row.created_at,
    startedAt: row.started_at || null, completedAt: row.completed_at || null,
    updatedAt: row.updated_at,
  };
  run.compliance = _compliance(run);
  if (row.operation_id && options.operations) run.operation = options.operations.get(row.operation_id);
  return run;
}
function getPolicy(idInput, options = {}) {
  const id = String(idInput || '');
  if (!SAFE_POLICY_ID.test(id)) return null;
  return _publicPolicy(_database(options).prepare(`SELECT * FROM provider_restore_drill_policies
    WHERE id=? AND deleted_at IS NULL`).get(id));
}
function listPolicies(hostIdInput, options = {}) {
  const hostId = Number(hostIdInput); const limit = Math.min(200, Math.max(1, Number(options.limit) || 100));
  if (!Number.isInteger(hostId) || hostId <= 0) return [];
  return _database(options).prepare(`SELECT * FROM provider_restore_drill_policies
    WHERE host_id=? AND deleted_at IS NULL ORDER BY lower(name),id LIMIT ?`).all(hostId, limit).map(_publicPolicy);
}
function getRun(hostIdInput, idInput, options = {}) {
  const hostId = Number(hostIdInput); const id = String(idInput || '');
  if (!Number.isInteger(hostId) || !SAFE_RUN_ID.test(id)) return null;
  return _publicRun(_database(options).prepare(`SELECT * FROM provider_restore_drill_runs
    WHERE id=? AND host_id=?`).get(id, hostId), { operations: _operations(options) });
}
function listRuns(hostIdInput, options = {}) {
  const hostId = Number(hostIdInput); const limit = Math.min(200, Math.max(1, Number(options.limit) || 50));
  if (!Number.isInteger(hostId) || hostId <= 0) return [];
  const policyId = options.policyId ? String(options.policyId) : null;
  if (policyId && !SAFE_POLICY_ID.test(policyId)) return [];
  return _database(options).prepare(`SELECT * FROM provider_restore_drill_runs
    WHERE host_id=? AND (? IS NULL OR policy_id=?) ORDER BY created_at DESC,id DESC LIMIT ?`)
    .all(hostId, policyId, policyId, limit).map(row => _publicRun(row, { operations: _operations(options) }));
}

function _semanticPlan(plan) {
  return {
    schemaVersion: plan.schemaVersion, kind: plan.kind, hostId: plan.hostId,
    providerType: plan.providerType, restorePlanHash: plan.restorePlanHash,
    source: plan.source, target: plan.target, assertions: plan.assertions,
    cleanup: plan.cleanup, objectives: {
      rpoTargetSeconds: plan.objectives.rpoTargetSeconds,
      rtoTargetSeconds: plan.objectives.rtoTargetSeconds,
    }, capability: plan.capability,
    allowed: plan.allowed, blockers: plan.blockers, safety: plan.safety,
    confirmation: plan.confirmation,
  };
}
async function preflightForHost(host, pointIdInput, input = {}, options = {}) {
  const pointId = String(pointIdInput || '');
  if (!SAFE_POINT_ID.test(pointId)) throw new RestoreDrillError(
    'Recovery point was not found', 'RECOVERY_POINT_NOT_FOUND', 404);
  const base = await recoveryRestore.preflightForHost(host, pointId, {
    ...input, kind: 'vm', startAfterRestore: false, liveRestore: false, overwrite: false,
  }, {
    ...options, canOperate: options.canOperate === true,
    enabled: options.restoreEnabled === undefined
      ? config.features.providerRecoveryRestore : options.restoreEnabled === true,
  });
  const assertions = _assertions(input.assertions || {}, base.source.guestType, false);
  const cleanup = _cleanup(input);
  const rpoTargetSeconds = _nullableInteger(input.rpoTargetSeconds, 60, 31536000,
    null, 'RPO objective');
  const rtoTargetSeconds = _nullableInteger(input.rtoTargetSeconds, 30, 86400,
    null, 'RTO objective');
  const capabilities = await _registry(options).capabilitiesForHost(host);
  const capability = capabilities.features?.['backup.restore.drill']
    || { state: 'unknown', reason: 'Restore-drill capability evidence is unavailable', constraints: {} };
  const blockers = [...base.blockers]; const warnings = [...base.warnings];
  const enabled = options.enabled === undefined
    ? config.features.providerRestoreDrills : options.enabled === true;
  if (!enabled) blockers.push({ type: 'RELEASE_DISABLED',
    reason: 'Restore drills are disabled by release policy', code: 'DD_PROVIDER_RESTORE_DRILLS' });
  if (!['supported', 'conditional'].includes(capability.state)) blockers.push({
    type: capability.state === 'unknown' ? 'RESTORE_DRILL_CAPABILITY_UNKNOWN' : 'RESTORE_DRILL_CAPABILITY_UNSUPPORTED',
    reason: capability.reason || 'Restore drills are unavailable', capability: 'backup.restore.drill',
  });
  if (host.daemon_type !== 'proxmox') blockers.push({ type: 'RESTORE_DRILL_PROVIDER_UNSUPPORTED',
    reason: 'This release only executes conformance-tested Proxmox QEMU/LXC restore drills' });
  const cleanupAuthorized = cleanup.mode === 'on_success' && input.allowAutomaticCleanup === true;
  if (cleanup.mode === 'on_success' && !cleanupAuthorized) blockers.push({
    type: 'RESTORE_DRILL_CLEANUP_AUTHORIZATION_REQUIRED',
    reason: 'Automatic success cleanup requires explicit authorization' });
  const rpoAgeSeconds = _rpoAge(base.source.createdAt);
  if (rpoTargetSeconds !== null && rpoAgeSeconds === null) warnings.push({
    type: 'RESTORE_DRILL_RPO_AGE_UNKNOWN', reason: 'Recovery-point age cannot be proven' });
  if (rpoTargetSeconds !== null && rpoAgeSeconds !== null && rpoAgeSeconds > rpoTargetSeconds) {
    warnings.push({ type: 'RESTORE_DRILL_RPO_BREACHED_AT_START',
      reason: 'Selected recovery point already exceeds the requested RPO', rpoAgeSeconds, rpoTargetSeconds });
  }
  warnings.push({ type: 'RESTORE_DRILL_NETWORK_ISOLATION',
    reason: 'Every restored NIC is disconnected before the first boot' });
  warnings.push({ type: 'RESTORE_DRILL_FAILURE_RETENTION',
    reason: 'Failed, cancelled, or ambiguous drill targets are retained for manual inspection' });
  const expected = base.target ? `DRILL ${base.target.vmid}` : null;
  const cleanupExpected = base.target && cleanup.mode === 'on_success'
    ? `DRILL DELETE ${base.target.vmid}` : null;
  const plan = {
    schemaVersion: SCHEMA_VERSION, kind: 'providerRestoreDrillPlan',
    hostId: Number(host.id), providerType: host.daemon_type,
    restorePlanHash: base.planHash, source: base.source, target: base.target,
    assertions, cleanup: {
      mode: cleanup.mode, shutdownTimeoutSeconds: cleanup.shutdownTimeoutSeconds,
      allowForceStop: true, automaticCleanupAuthorized: cleanupAuthorized,
    }, objectives: { rpoTargetSeconds, rtoTargetSeconds, rpoAgeSeconds },
    capability: { key: 'backup.restore.drill', state: capability.state,
      reason: capability.reason || null, constraints: capability.constraints || {} },
    allowed: base.allowed && blockers.length === 0, blockers, warnings,
    safety: { createOnly: true, overwrite: false, startAfterRestore: false,
      liveRestore: false, allNicsDisconnectedBeforeBoot: true,
      arbitraryGuestCommandsAuthorized: false, cleanupOnSuccessOnly: cleanup.mode === 'on_success' },
    confirmation: { required: true, expected, cleanupExpected },
    validUntil: base.validUntil,
  };
  plan.planHash = sha256(_canonical(_semanticPlan(plan)));
  return plan;
}
function _assertSubmission(plan, input, options = {}) {
  if (!plan.allowed) throw new RestoreDrillError('Restore-drill preflight is blocked',
    'RESTORE_DRILL_PREFLIGHT_BLOCKED', 409, plan.blockers);
  if (!/^[a-f0-9]{64}$/.test(String(input.planHash || '')) || input.planHash !== plan.planHash) {
    throw new RestoreDrillError('Restore-drill preflight changed; review the new plan',
      'RESTORE_DRILL_PREFLIGHT_STALE', 409);
  }
  if (!options.scheduled && (input.confirm !== true
    || String(input.confirmText || '') !== plan.confirmation.expected)) {
    throw new RestoreDrillError(`Type ${plan.confirmation.expected} to confirm drill`,
      'RESTORE_DRILL_CONFIRMATION_REQUIRED', 409);
  }
  if (plan.cleanup.mode === 'on_success' && !options.scheduled
    && String(input.cleanupConfirmText || '') !== plan.confirmation.cleanupExpected) {
    throw new RestoreDrillError(`Type ${plan.confirmation.cleanupExpected} to authorize success cleanup`,
      'RESTORE_DRILL_CLEANUP_CONFIRMATION_REQUIRED', 409);
  }
  if (!/^[\x21-\x7e]{8,200}$/.test(String(input.idempotencyKey || ''))) {
    throw new RestoreDrillError('Idempotency-Key must contain 8-200 visible ASCII characters',
      'INVALID_IDEMPOTENCY_KEY');
  }
}
function _submissionHash(plan) {
  return sha256(_canonical({ planHash: plan.planHash, source: plan.source.recoveryPointId,
    target: plan.target, assertions: plan.assertions, cleanup: plan.cleanup,
    objectives: plan.objectives }));
}
async function submitForHost(host, pointId, input = {}, options = {}) {
  const database = _database(options);
  const plan = await preflightForHost(host, pointId, input, options);
  _assertSubmission(plan, input, { scheduled: options.trigger === 'scheduled' });
  const idempotencyHash = sha256(`${host.id}|${input.idempotencyKey}`);
  const requestHash = _submissionHash(plan);
  const existing = database.prepare(`SELECT * FROM provider_restore_drill_runs
    WHERE host_id=? AND idempotency_key_hash=?`).get(Number(host.id), idempotencyHash);
  if (existing) {
    if (existing.request_hash !== requestHash) throw new RestoreDrillError(
      'Idempotency key was already used for a different restore drill',
      'IDEMPOTENCY_KEY_CONFLICT', 409);
    return { plan, run: _publicRun(existing, { operations: _operations(options) }), deduplicated: true };
  }
  const runId = `pdrr_${generateToken(13)}`;
  const trigger = options.trigger === 'scheduled' ? 'scheduled' : 'manual';
  const slotKey = options.slotKey || `manual:${_now()}:${generateToken(5)}`;
  database.prepare(`INSERT INTO provider_restore_drill_runs
    (id,policy_id,host_id,recovery_point_id,trigger_type,slot_key,state,plan_hash,request_hash,
     idempotency_key_hash,target_node_id,target_storage_id,target_vmid,assertions_json,cleanup_mode,
     rpo_target_seconds,rto_target_seconds,rpo_age_seconds,evidence_json,created_by)
    VALUES (?,?,?,?,?,?,'queued',?,?,?,?,?,?,?,?,?,?,?,'{}',?)`).run(
    runId, options.policyId || null, Number(host.id), plan.source.recoveryPointId,
    trigger, slotKey, plan.planHash, requestHash, idempotencyHash,
    plan.target.nodeId, plan.target.storageId, plan.target.vmid,
    JSON.stringify(plan.assertions), plan.cleanup.mode,
    plan.objectives.rpoTargetSeconds, plan.objectives.rtoTargetSeconds,
    plan.objectives.rpoAgeSeconds, options.createdBy || null);
  try {
    const operation = _operations(options).create({
      type: TYPE, providerType: host.daemon_type, hostId: Number(host.id),
      resourceKind: 'recoveryPoint', resourceId: plan.source.recoveryPointId, action: 'drill',
      idempotencyKey: input.idempotencyKey,
      request: {
        runId, planHash: plan.planHash, recoveryPointId: plan.source.recoveryPointId,
        repositoryId: plan.source.repositoryId, guestType: plan.source.guestType,
        targetNodeId: plan.target.nodeId, targetStorageId: plan.target.storageId,
        targetVmid: plan.target.vmid, bandwidthLimitMbps: plan.target.bandwidthLimitMbps,
        verificationOverride: plan.source.verification?.state !== 'verified',
        overrideReason: input.allowUnverified ? _text(input.overrideReason, 240) : null,
        assertions: plan.assertions, cleanupMode: plan.cleanup.mode,
        automaticCleanupAuthorized: plan.cleanup.automaticCleanupAuthorized,
        shutdownTimeoutSeconds: plan.cleanup.shutdownTimeoutSeconds,
        allowForceStop: true, startAfterRestore: false, liveRestore: false, overwrite: false,
      },
      lockScopes: [`resource:${plan.source.recoveryPointId}`,
        `provider-vmid:${host.id}:${plan.target.vmid}`, `resource:${plan.target.nodeId}`,
        `resource:${plan.target.storageId}`],
      createdBy: options.createdBy,
    });
    database.prepare(`UPDATE provider_restore_drill_runs SET operation_id=?,updated_at=datetime('now')
      WHERE id=?`).run(operation.id, runId);
    return { plan, operation, run: getRun(host.id, runId, { ...options, database }), deduplicated: false };
  } catch (err) {
    database.prepare(`UPDATE provider_restore_drill_runs SET state='failed',error_code=?,
      completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(
      /^[A-Z][A-Z0-9_]{1,79}$/.test(String(err?.code || '')) ? err.code : 'RESTORE_DRILL_SUBMIT_FAILED', runId);
    throw err;
  }
}

async function reconcile(options = {}) {
  const database = _database(options); const operations = _operations(options);
  const where = options.hostId ? 'AND host_id=?' : '';
  const rows = database.prepare(`SELECT * FROM provider_restore_drill_runs
    WHERE operation_id IS NOT NULL AND state IN ('queued','running','unknown')
      ${where} ORDER BY updated_at LIMIT 200`)
    .all(...(options.hostId ? [Number(options.hostId)] : []));
  const updated = [];
  for (const row of rows) {
    const operation = operations.get(row.operation_id);
    if (!operation) continue;
    const state = ACTIVE_OPERATION_STATES.has(operation.state) ? (operation.state === 'queued' ? 'queued' : 'running')
      : operation.state;
    const evidence = operation.result || {};
    const evidenceJson = JSON.stringify(evidence);
    const timing = evidence.timing || {};
    const rto = _durationSeconds(timing.restoreStartedAt || operation.startedAt,
      timing.assertionCompletedAt);
    const cleanupSeconds = _durationSeconds(timing.cleanupStartedAt, timing.cleanupCompletedAt);
    const errorCode = operation.error?.code || evidence.evidenceCode || null;
    const evidenceHash = sha256(_canonical({
      runId: row.id, planHash: row.plan_hash, state,
      rpoAgeSeconds: row.rpo_age_seconds ?? null, rtoSeconds: rto,
      cleanupSeconds, evidence,
    }));
    if (row.state === state && row.started_at === (operation.startedAt || null)
      && row.completed_at === (operation.completedAt || null)
      && row.rto_seconds === rto && row.cleanup_seconds === cleanupSeconds
      && row.evidence_hash === evidenceHash && row.error_code === errorCode) continue;
    database.prepare(`UPDATE provider_restore_drill_runs SET state=?,started_at=?,completed_at=?,
      rto_seconds=?,cleanup_seconds=?,evidence_json=?,evidence_hash=?,error_code=?,updated_at=datetime('now')
      WHERE id=?`).run(state, operation.startedAt || null, operation.completedAt || null,
      rto, cleanupSeconds, evidenceJson, evidenceHash, errorCode, row.id);
    updated.push(row.id);
  }
  return { updated };
}

function _policyInput(host, input = {}, existing = null, options = {}) {
  const previous = existing || {};
  const name = _text(input.name ?? previous.name, 120);
  if (!name || name.length < 3) throw new RestoreDrillError(
    'Restore-drill policy name must contain 3-120 characters', 'INVALID_RESTORE_DRILL_POLICY');
  const backupPolicyId = String(input.backupPolicyId ?? previous.backupPolicyId ?? '');
  if (!backupPolicies._internals.SAFE_POLICY_ID.test(backupPolicyId)) throw new RestoreDrillError(
    'A linked backup policy is required', 'INVALID_RESTORE_DRILL_POLICY');
  const targetInput = input.target || previous.target || {};
  const targetNodeId = String(targetInput.nodeId || '');
  const targetStorageId = String(targetInput.storageId || '');
  if (!SAFE_NODE_ID.test(targetNodeId) || !SAFE_STORAGE_ID.test(targetStorageId)) {
    throw new RestoreDrillError('Canonical target node and storage are required',
      'INVALID_RESTORE_DRILL_POLICY');
  }
  const assertions = _assertions(input.assertions || previous.assertions || {}, null, true);
  const cleanup = _cleanup(input, previous);
  const enabled = input.enabled === undefined ? previous.enabled === true : input.enabled === true;
  const authorization = {
    scheduledExecution: enabled,
    automaticCleanup: enabled && cleanup.mode === 'on_success',
    authorizedAt: enabled ? _now() : null,
    authorizedBy: enabled ? (options.createdBy || null) : null,
  };
  if (enabled && String(input.authorizationText || '') !== `AUTHORIZE DRILL ${name}`) {
    throw new RestoreDrillError(`Type AUTHORIZE DRILL ${name} to enable scheduled execution`,
      'RESTORE_DRILL_POLICY_AUTHORIZATION_REQUIRED', 409);
  }
  if (enabled && cleanup.mode === 'on_success'
    && String(input.cleanupAuthorizationText || '') !== `ALLOW AUTOMATIC CLEANUP ${name}`) {
    throw new RestoreDrillError(`Type ALLOW AUTOMATIC CLEANUP ${name} to authorize success cleanup`,
      'RESTORE_DRILL_POLICY_CLEANUP_AUTHORIZATION_REQUIRED', 409);
  }
  return {
    name, backupPolicyId, enabled, schedule: _schedule(input.schedule || {}, previous.schedule || {}),
    targetNodeId, targetStorageId, assertions, cleanupMode: cleanup.mode,
    shutdownTimeoutSeconds: cleanup.shutdownTimeoutSeconds, authorization,
    rpoTargetSeconds: _nullableInteger(input.rpoTargetSeconds,
      60, 31536000, previous.rpoTargetSeconds ?? null, 'RPO objective'),
    rtoTargetSeconds: _nullableInteger(input.rtoTargetSeconds,
      30, 86400, previous.rtoTargetSeconds ?? null, 'RTO objective'),
  };
}
async function upsertPolicyForHost(host, input = {}, options = {}) {
  if (!config.features.providerRestoreDrills && options.enabled !== true) throw new RestoreDrillError(
    'Restore drills are disabled by release policy', 'RESTORE_DRILLS_DISABLED', 404);
  const database = _database(options);
  const existing = input.id ? getPolicy(input.id, { database }) : null;
  if (input.id && (!existing || existing.hostId !== Number(host.id))) throw new RestoreDrillError(
    'Restore-drill policy was not found', 'RESTORE_DRILL_POLICY_NOT_FOUND', 404);
  const policy = _policyInput(host, input, existing, options);
  const backup = backupPolicies.get(policy.backupPolicyId, { database });
  if (!backup || backup.hostId !== Number(host.id)) throw new RestoreDrillError(
    'Linked backup policy was not found on this endpoint', 'BACKUP_POLICY_NOT_FOUND', 404);
  if (policy.enabled && (!backup.enabled || backup.verification?.restoreDrillRequired !== true)) {
    throw new RestoreDrillError(
      'Enabled drill policy requires an enabled backup policy with restoreDrillRequired',
      'RESTORE_DRILL_BACKUP_POLICY_NOT_READY', 409);
  }
  if (host.daemon_type !== 'proxmox') throw new RestoreDrillError(
    'Scheduled restore drills are executable only on conformance-tested Proxmox endpoints',
    'RESTORE_DRILL_PROVIDER_UNSUPPORTED', 409);
  const node = identityStore.resolveCanonical(policy.targetNodeId,
    { hostId: Number(host.id), kind: 'host' }, database);
  const storage = identityStore.resolveCanonical(policy.targetStorageId,
    { hostId: Number(host.id), kind: 'storage' }, database);
  if (!node || !storage || node.providerType !== 'proxmox' || storage.providerType !== 'proxmox') {
    throw new RestoreDrillError('Restore-drill target identities are unavailable',
      'RESTORE_DRILL_TARGET_UNAVAILABLE', 409);
  }
  const storageLocation = recoveryRestore._internals?._storageIdentity?.(storage.nativeRef);
  if (!storageLocation || (storageLocation.node && storageLocation.node !== node.nativeRef)) {
    throw new RestoreDrillError('Restore-drill target storage belongs to a different node',
      'RESTORE_DRILL_TARGET_NODE_MISMATCH', 409);
  }
  const capabilities = await _registry(options).capabilitiesForHost(host);
  const capability = capabilities.features?.['backup.restore.drill'];
  if (policy.enabled && !['supported', 'conditional'].includes(capability?.state)) {
    throw new RestoreDrillError(capability?.reason || 'Restore-drill capability is unavailable',
      'RESTORE_DRILL_CAPABILITY_UNSUPPORTED', 409);
  }
  const id = existing?.id || `pdrp_${generateToken(13)}`;
  try {
    database.prepare(`INSERT INTO provider_restore_drill_policies
      (id,host_id,backup_policy_id,name,enabled,schedule_json,target_node_id,target_storage_id,
       assertions_json,cleanup_mode,authorization_json,rpo_target_seconds,rto_target_seconds,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET backup_policy_id=excluded.backup_policy_id,name=excluded.name,
       enabled=excluded.enabled,schedule_json=excluded.schedule_json,target_node_id=excluded.target_node_id,
       target_storage_id=excluded.target_storage_id,assertions_json=excluded.assertions_json,
       cleanup_mode=excluded.cleanup_mode,authorization_json=excluded.authorization_json,
       rpo_target_seconds=excluded.rpo_target_seconds,rto_target_seconds=excluded.rto_target_seconds,
       deleted_at=NULL,updated_at=datetime('now')`).run(
      id, Number(host.id), policy.backupPolicyId, policy.name, policy.enabled ? 1 : 0,
      JSON.stringify(policy.schedule), policy.targetNodeId, policy.targetStorageId,
      JSON.stringify({ ...policy.assertions, shutdownTimeoutSeconds: policy.shutdownTimeoutSeconds }),
      policy.cleanupMode, JSON.stringify(policy.authorization),
      policy.rpoTargetSeconds, policy.rtoTargetSeconds, options.createdBy || null);
  } catch (err) {
    if (String(err?.code || '').startsWith('SQLITE_CONSTRAINT')) throw new RestoreDrillError(
      'An active restore-drill policy already uses this name or reference',
      'RESTORE_DRILL_POLICY_CONFLICT', 409);
    throw err;
  }
  return { policy: getPolicy(id, { database }), created: !existing };
}
function removePolicyForHost(hostIdInput, idInput, options = {}) {
  const hostId = Number(hostIdInput); const policy = getPolicy(idInput, options);
  if (!policy || policy.hostId !== hostId) throw new RestoreDrillError(
    'Restore-drill policy was not found', 'RESTORE_DRILL_POLICY_NOT_FOUND', 404);
  const database = _database(options);
  const active = database.prepare(`SELECT id FROM provider_restore_drill_runs
    WHERE policy_id=? AND state IN ('queued','running','unknown') LIMIT 1`).get(policy.id);
  if (active) throw new RestoreDrillError(
    'Restore-drill policy has an active or ambiguous run', 'RESTORE_DRILL_POLICY_ACTIVE', 409);
  database.prepare(`UPDATE provider_restore_drill_policies SET enabled=0,deleted_at=datetime('now'),
    updated_at=datetime('now') WHERE id=? AND host_id=?`).run(policy.id, hostId);
  return policy;
}

function _blockedRun(policy, code, options = {}) {
  const database = _database(options); const id = `pdrr_${generateToken(13)}`;
  const core = { policyId: policy.id, slotKey: options.slotKey,
    code: /^[A-Z][A-Z0-9_]{1,79}$/.test(String(code || '')) ? code : 'RESTORE_DRILL_SCHEDULE_BLOCKED' };
  const hash = sha256(_canonical(core));
  try {
    database.prepare(`INSERT INTO provider_restore_drill_runs
      (id,policy_id,host_id,recovery_point_id,trigger_type,slot_key,state,plan_hash,request_hash,
       idempotency_key_hash,target_node_id,target_storage_id,target_vmid,assertions_json,cleanup_mode,
       rpo_target_seconds,rto_target_seconds,evidence_json,evidence_hash,error_code,created_by,completed_at)
      VALUES (?,?,?,NULL,'scheduled',?,'blocked',?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,datetime('now'))`).run(
      id, policy.id, policy.hostId, options.slotKey, hash, hash,
      sha256(`${policy.hostId}|scheduled:${policy.id}:${options.slotKey}`),
      policy.target.nodeId, policy.target.storageId, JSON.stringify(policy.assertions),
      policy.cleanupMode, policy.rpoTargetSeconds, policy.rtoTargetSeconds,
      JSON.stringify(core), hash, core.code, policy.createdBy);
  } catch (err) {
    if (String(err?.code || '').startsWith('SQLITE_CONSTRAINT')) return null;
    throw err;
  }
  return getRun(policy.hostId, id, { ...options, database });
}
async function _scheduledPoint(host, policy, options = {}) {
  const database = _database(options);
  const backup = backupPolicies.get(policy.backupPolicyId, { database });
  if (!backup || !backup.enabled || backup.verification?.restoreDrillRequired !== true) {
    throw new RestoreDrillError('Linked backup policy is not ready',
      'RESTORE_DRILL_BACKUP_POLICY_NOT_READY', 409);
  }
  const preview = await backupPolicies.preflightForHost(host, { ...backup, id: backup.id }, {
    ...options, database, existing: backup,
  });
  if (!preview.allowed) throw new RestoreDrillError('Linked backup policy preflight is blocked',
    'RESTORE_DRILL_BACKUP_PREFLIGHT_BLOCKED', 409);
  const eligibleWorkloads = new Set((preview.scope?.workloads || []).map(item => item.id));
  const inventory = await _registry(options).recoveryPointsForHost(host, {
    limit: 500, repositoryId: backup.repositoryId, verification: 'verified', database,
  });
  const lastByWorkload = new Map(database.prepare(`SELECT p.workload_id,MAX(r.completed_at) AS last_at
    FROM provider_restore_drill_runs r JOIN provider_recovery_points p
      ON p.canonical_id=r.recovery_point_id
    WHERE r.host_id=? AND r.state='succeeded' GROUP BY p.workload_id`).all(Number(host.id))
    .map(row => [row.workload_id, row.last_at]));
  const points = (inventory.items || []).filter(point => point.verification?.state === 'verified'
    && point.workload?.id && eligibleWorkloads.has(point.workload.id))
    .sort((a, b) => String(lastByWorkload.get(a.workload.id) || '').localeCompare(
      String(lastByWorkload.get(b.workload.id) || ''))
      || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  if (!points.length) throw new RestoreDrillError(
    'No verified recovery point currently matches the linked backup scope',
    'RESTORE_DRILL_NO_ELIGIBLE_RECOVERY_POINT', 409);
  return points[0];
}
async function runDue(options = {}) {
  if (!config.features.providerRestoreDrills && options.enabled !== true) return { started: [], skipped: 'disabled' };
  const database = _database(options); const now = options.now || new Date();
  await reconcile({ ...options, database });
  const policies = database.prepare(`SELECT * FROM provider_restore_drill_policies
    WHERE enabled=1 AND deleted_at IS NULL ORDER BY id LIMIT ?`).all(MAX_POLICIES_PER_TICK).map(_publicPolicy);
  const started = []; const errors = [];
  for (const policy of policies) {
    const slotKey = backupPolicies.slotKey(policy.schedule, now);
    if (!slotKey || policy.lastSlotKey === slotKey) continue;
    let client;
    try {
      const host = database.prepare('SELECT * FROM docker_hosts WHERE id=? AND is_active=1').get(policy.hostId);
      if (!host) throw new RestoreDrillError('Restore-drill endpoint is unavailable', 'INVALID_OPERATION_HOST', 409);
      const active = database.prepare(`SELECT id FROM provider_restore_drill_runs
        WHERE policy_id=? AND state IN ('queued','running','unknown') LIMIT 1`).get(policy.id);
      if (active) throw new RestoreDrillError('A prior restore-drill run is still active or ambiguous',
        'RESTORE_DRILL_POLICY_RUN_ACTIVE', 409);
      const point = await _scheduledPoint(host, policy, { ...options, database });
      client = (options.clientFactory || fromHostRow)(host);
      const targetVmid = Number(await client.nextVmId());
      const guestType = point.workload?.guestType === 'lxc' ? 'lxc' : 'qemu';
      const assertions = _assertions({ ...policy.assertions,
        guestAgent: policy.assertions.guestAgent === 'auto'
          ? (guestType === 'lxc' ? 'disabled' : 'required') : policy.assertions.guestAgent,
      }, guestType);
      const input = {
        kind: 'vm', targetNodeId: policy.target.nodeId, targetStorageId: policy.target.storageId,
        targetVmid, assertions, cleanupMode: policy.cleanupMode,
        shutdownTimeoutSeconds: policy.assertions.shutdownTimeoutSeconds || 120,
        allowAutomaticCleanup: policy.authorization.automaticCleanup,
        rpoTargetSeconds: policy.rpoTargetSeconds, rtoTargetSeconds: policy.rtoTargetSeconds,
        idempotencyKey: `scheduled:${policy.id}:${sha256(slotKey).slice(0, 24)}`,
      };
      const plan = await preflightForHost(host, point.id, input, {
        ...options, database, canOperate: true,
      });
      const result = await submitForHost(host, point.id, { ...input, planHash: plan.planHash }, {
        ...options, database, canOperate: true, trigger: 'scheduled', slotKey,
        policyId: policy.id, createdBy: policy.createdBy,
      });
      started.push(result.run);
      try { audit.log({ username: 'system', action: 'provider_restore_drill_scheduled_submit',
        targetType: 'provider_host', targetId: String(policy.hostId), details: {
          policyId: policy.id, runId: result.run.id, recoveryPointId: point.id,
          operationId: result.operation?.id || result.run.operationId,
          automaticCleanupAuthorized: policy.authorization.automaticCleanup,
        } }); } catch { /* run table is authoritative */ }
    } catch (err) {
      const code = err?.code || 'RESTORE_DRILL_SCHEDULE_FAILED';
      const run = _blockedRun(policy, code, { ...options, database, slotKey });
      if (run) started.push(run);
      errors.push({ policyId: policy.id, code });
      log.error('Scheduled restore drill failed closed', { policyId: policy.id, code });
    } finally { client?._agent?.destroy?.(); }
    database.prepare(`UPDATE provider_restore_drill_policies SET last_slot_key=?,last_run_at=datetime('now'),
      updated_at=datetime('now') WHERE id=?`).run(slotKey, policy.id);
  }
  return { started, errors };
}

module.exports = {
  SCHEMA_VERSION, RestoreDrillError, preflightForHost, submitForHost, reconcile,
  getPolicy, listPolicies, upsertPolicyForHost, removePolicyForHost,
  getRun, listRuns, runDue,
  _internals: {
    SAFE_POLICY_ID, SAFE_RUN_ID, _canonical, _schedule, _assertions, _cleanup,
    _rpoAge, _compliance, _publicPolicy, _publicRun, _semanticPlan,
    _assertSubmission, _submissionHash, _policyInput, _blockedRun, _scheduledPoint,
  },
};
