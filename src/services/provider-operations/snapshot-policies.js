'use strict';

const config = require('../../config');
const { getDb } = require('../../db');
const { sha256, generateToken } = require('../../utils/crypto');
const log = require('../../utils/logger')('provider-snapshot-policies');
const audit = require('../audit');
const registrySingleton = require('../provider-sdk/registry');
const operationsSingleton = require('./index');
const snapshotsSingleton = require('./vm-snapshots');

const SAFE_VM_ID = /^ddr_vm_[a-f0-9]{26}$/;
const SAFE_POLICY_ID = /^vmsp_[a-f0-9]{26}$/;
const SAFE_RUN_ID = /^vspr_[a-f0-9]{26}$/;
const SAFE_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const TERMINAL_RUN_STATES = new Set(['previewed', 'succeeded', 'blocked', 'failed', 'unknown']);
const TERMINAL_OPERATION_STATES = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);

class SnapshotPolicyError extends Error {
  constructor(message, code = 'VM_SNAPSHOT_POLICY_ERROR', status = 400, details = null) {
    super(message); this.name = 'SnapshotPolicyError'; this.code = code; this.status = status; this.details = details;
  }
}

function _text(value, max = 240) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function _integer(value, min, max, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new SnapshotPolicyError(`${label} must be an integer between ${min} and ${max}`, 'INVALID_SNAPSHOT_POLICY');
  }
  return parsed;
}

function _parseJson(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function _cron(policy) {
  if (policy.frequency === 'hourly') return `${policy.minute} * * * *`;
  if (policy.frequency === 'daily') return `${policy.minute} ${policy.hour} * * *`;
  return `${policy.minute} ${policy.hour} * * ${policy.weekday}`;
}

function _publicPolicy(row) {
  if (!row) return null;
  return {
    schemaVersion: '1.0', id: row.id, hostId: Number(row.host_id), vmId: row.vm_id,
    enabled: !!row.enabled, mode: row.mode,
    schedule: {
      frequency: row.frequency, minute: Number(row.minute), hour: Number(row.hour),
      weekday: Number(row.weekday), timezone: 'UTC', cron: _cron({
        frequency: row.frequency, minute: Number(row.minute), hour: Number(row.hour), weekday: Number(row.weekday),
      }),
    },
    consistency: row.consistency, namePrefix: row.name_prefix,
    description: row.description || null, retainCount: Number(row.retain_count),
    maxAgeDays: row.max_age_days === null ? null : Number(row.max_age_days),
    maxDeletesPerRun: Number(row.max_deletes_per_run),
    lastSlotKey: row.last_slot_key || null, lastRunAt: row.last_run_at || null,
    lastRunStatus: row.last_run_status || null,
    lastRunSummary: _parseJson(row.last_run_summary_json, null),
    createdBy: row.created_by || null, createdAt: row.created_at, updatedAt: row.updated_at,
    protection: { isBackup: false, managedPrefixOnly: true },
  };
}

function _publicRun(row) {
  if (!row) return null;
  return {
    schemaVersion: '1.0', id: row.id, policyId: row.policy_id,
    trigger: row.trigger_type, slotKey: row.slot_key, state: row.state,
    currentOperationId: row.current_operation_id || null,
    deleteCount: Number(row.delete_count), plan: _parseJson(row.plan_json, {}),
    error: row.error_code ? { code: row.error_code, message: row.error_message || 'Snapshot policy run failed' } : null,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at || null,
  };
}

function _database(options = {}) { return options.database || getDb(); }

function _automationEnabled(options = {}) {
  if (options.automationEnabled !== undefined) return options.automationEnabled === true;
  return config.features.providerVmSnapshots === true
    && config.features.providerVmSnapshotAutomation === true;
}

function getForVm(hostIdInput, vmIdInput, options = {}) {
  const hostId = Number(hostIdInput); const vmId = String(vmIdInput || '');
  if (!Number.isInteger(hostId) || hostId <= 0 || !SAFE_VM_ID.test(vmId)) return null;
  return _publicPolicy(_database(options).prepare(
    'SELECT * FROM provider_vm_snapshot_policies WHERE host_id = ? AND vm_id = ? AND deleted_at IS NULL'
  ).get(hostId, vmId));
}

function get(policyIdInput, options = {}) {
  const policyId = String(policyIdInput || '');
  if (!SAFE_POLICY_ID.test(policyId)) return null;
  return _publicPolicy(_database(options).prepare(
    'SELECT * FROM provider_vm_snapshot_policies WHERE id = ? AND deleted_at IS NULL'
  ).get(policyId));
}

function listRuns(hostIdInput, vmIdInput, options = {}) {
  const hostId = Number(hostIdInput); const vmId = String(vmIdInput || '');
  const limit = Math.min(200, Math.max(1, Number(options.limit) || 50));
  if (!Number.isInteger(hostId) || !SAFE_VM_ID.test(vmId)) return [];
  return _database(options).prepare(`SELECT r.* FROM provider_vm_snapshot_policy_runs r
    JOIN provider_vm_snapshot_policies p ON p.id = r.policy_id
    WHERE p.host_id = ? AND p.vm_id = ? ORDER BY r.created_at DESC LIMIT ?`)
    .all(hostId, vmId, limit).map(_publicRun);
}

function _validate(input = {}, existing = null) {
  const previous = existing || {};
  const frequency = String(input.frequency ?? previous.schedule?.frequency ?? 'daily');
  if (!['hourly', 'daily', 'weekly'].includes(frequency)) {
    throw new SnapshotPolicyError('Frequency must be hourly, daily or weekly', 'INVALID_SNAPSHOT_POLICY');
  }
  const consistency = String(input.consistency ?? previous.consistency ?? 'crash');
  if (!['crash', 'quiesced'].includes(consistency)) {
    throw new SnapshotPolicyError('Consistency must be crash or quiesced', 'INVALID_SNAPSHOT_POLICY');
  }
  const mode = String(input.mode ?? previous.mode ?? 'dry_run');
  if (!['dry_run', 'execute'].includes(mode)) throw new SnapshotPolicyError('Mode must be dry_run or execute', 'INVALID_SNAPSHOT_POLICY');
  const prefix = _text(input.namePrefix ?? previous.namePrefix ?? 'dd-auto', 48);
  if (!prefix || !SAFE_PREFIX.test(prefix)) {
    throw new SnapshotPolicyError('Name prefix must use 1-48 portable letters, numbers, dot, underscore or hyphen', 'INVALID_SNAPSHOT_POLICY');
  }
  const minute = _integer(input.minute, 0, 45, previous.schedule?.minute ?? 15, 'Minute');
  if (![0, 15, 30, 45].includes(minute)) {
    throw new SnapshotPolicyError('Minute must be 0, 15, 30 or 45', 'INVALID_SNAPSHOT_POLICY');
  }
  const maxAgeInput = input.maxAgeDays === undefined
    ? (previous.maxAgeDays === undefined ? 3 : previous.maxAgeDays) : input.maxAgeDays;
  return {
    enabled: input.enabled === undefined ? !!previous.enabled : input.enabled === true,
    mode, frequency, minute,
    hour: _integer(input.hour, 0, 23, previous.schedule?.hour ?? 2, 'Hour'),
    weekday: _integer(input.weekday, 0, 6, previous.schedule?.weekday ?? 0, 'Weekday'),
    consistency, namePrefix: prefix,
    description: _text(input.description ?? previous.description, 500),
    retainCount: _integer(input.retainCount, 1, 32, previous.retainCount ?? 3, 'Retain count'),
    maxAgeDays: maxAgeInput === null || maxAgeInput === '' ? null
      : _integer(maxAgeInput, 1, 3650, 3, 'Maximum age days'),
    maxDeletesPerRun: _integer(input.maxDeletesPerRun, 1, 20, previous.maxDeletesPerRun ?? 2, 'Maximum deletes per run'),
  };
}

async function _vmForHost(host, vmId, options = {}) {
  if (!host || !Number.isInteger(Number(host.id)) || !SAFE_VM_ID.test(String(vmId || ''))) {
    throw new SnapshotPolicyError('Virtual machine was not found', 'PROVIDER_VM_NOT_FOUND', 404);
  }
  const registry = options.registry || registrySingleton;
  const inventory = await registry.resourcesForHost(host, 'virtual-machines', { limit: 500, database: _database(options) });
  const vm = inventory.items.find(item => item.id === vmId);
  if (!vm || vm.identity?.stability === 'transient') {
    throw new SnapshotPolicyError('Stable virtual machine identity is required', 'UNSTABLE_RESOURCE_IDENTITY', 409);
  }
  return vm;
}

async function upsertForHost(host, vmId, input = {}, options = {}) {
  const database = _database(options);
  const existing = getForVm(host.id, vmId, { database });
  const policy = _validate(input, existing);
  const vm = await _vmForHost(host, vmId, { ...options, database });
  const automationEnabled = _automationEnabled(options);
  if (policy.enabled && policy.mode === 'execute') {
    if (!automationEnabled) {
      throw new SnapshotPolicyError('Snapshot automation is disabled by release policy', 'SNAPSHOT_AUTOMATION_DISABLED', 409);
    }
    if (input.confirm !== true || input.confirmName !== vm.displayName) {
      throw new SnapshotPolicyError('Execute policy requires the exact VM name', 'VM_SNAPSHOT_POLICY_TYPED_CONFIRMATION_REQUIRED', 400);
    }
  }
  const id = existing?.id || `vmsp_${sha256(`${host.id}|${vmId}`).slice(0, 26)}`;
  database.prepare(`INSERT INTO provider_vm_snapshot_policies
    (id, host_id, vm_id, enabled, mode, frequency, minute, hour, weekday,
     consistency, name_prefix, description, retain_count, max_age_days,
     max_deletes_per_run, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(host_id, vm_id) DO UPDATE SET
      enabled=excluded.enabled, mode=excluded.mode, frequency=excluded.frequency,
      minute=excluded.minute, hour=excluded.hour, weekday=excluded.weekday,
      consistency=excluded.consistency, name_prefix=excluded.name_prefix,
      description=excluded.description, retain_count=excluded.retain_count,
      max_age_days=excluded.max_age_days, max_deletes_per_run=excluded.max_deletes_per_run,
      deleted_at=NULL, updated_at=datetime('now')`).run(
    id, Number(host.id), vmId, policy.enabled ? 1 : 0, policy.mode,
    policy.frequency, policy.minute, policy.hour, policy.weekday,
    policy.consistency, policy.namePrefix, policy.description,
    policy.retainCount, policy.maxAgeDays, policy.maxDeletesPerRun, options.createdBy || null
  );
  return { policy: getForVm(host.id, vmId, { database }), vm: { id: vm.id, displayName: vm.displayName }, created: !existing };
}

function removeForVm(hostId, vmId, options = {}) {
  const database = _database(options);
  const policy = getForVm(hostId, vmId, { database });
  if (!policy) throw new SnapshotPolicyError('Snapshot policy was not found', 'SNAPSHOT_POLICY_NOT_FOUND', 404);
  const active = database.prepare(`SELECT id FROM provider_vm_snapshot_policy_runs
    WHERE policy_id = ? AND state IN ('create_pending', 'retention_pending') LIMIT 1`).get(policy.id);
  if (active) throw new SnapshotPolicyError('Snapshot policy has an active run', 'SNAPSHOT_POLICY_RUN_ACTIVE', 409);
  database.prepare(`UPDATE provider_vm_snapshot_policies
    SET enabled = 0, deleted_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?`).run(policy.id);
  return policy;
}

function _slotKey(policy, dateInput = new Date()) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) return null;
  const minute = date.getUTCMinutes(); const hour = date.getUTCHours(); const weekday = date.getUTCDay();
  if (minute !== policy.schedule.minute) return null;
  if (policy.schedule.frequency !== 'hourly' && hour !== policy.schedule.hour) return null;
  if (policy.schedule.frequency === 'weekly' && weekday !== policy.schedule.weekday) return null;
  return date.toISOString().slice(0, 16) + 'Z';
}

function _snapshotName(policy, dateInput = new Date()) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const stamp = date.toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return `${policy.namePrefix}-${stamp}`;
}

function _childKey(policy, run, action, sequence = null) {
  const suffix = action === 'delete' ? `delete:${sequence}` : 'create';
  return `snapshot-policy:${policy.id}:${run.slotKey}:${suffix}`;
}

function _recordedChild(policy, run, database) {
  const find = key => database.prepare(`SELECT id FROM provider_operations
    WHERE host_id = ? AND operation_type = 'vm.snapshot' AND idempotency_key_hash = ?`)
    .get(policy.hostId, sha256(`${policy.hostId}|vm.snapshot|${key}`));
  const deletion = find(_childKey(policy, run, 'delete', run.deleteCount + 1));
  if (deletion) return { id: deletion.id, state: 'retention_pending' };
  const creation = find(_childKey(policy, run, 'create'));
  return creation ? { id: creation.id, state: 'create_pending' } : null;
}

function evaluate(policy, inventory, dateInput = new Date()) {
  if (!policy?.id || !inventory?.vm || !Array.isArray(inventory.items)) {
    throw new SnapshotPolicyError('Snapshot policy evaluation context is invalid', 'INVALID_SNAPSHOT_POLICY');
  }
  const now = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const prefix = `${policy.namePrefix}-`;
  const managed = inventory.items.filter(item => String(item.name || '').startsWith(prefix));
  const sortable = managed.map(item => ({ item, timestamp: Date.parse(item.createdAt || '') }))
    .sort((a, b) => (Number.isFinite(b.timestamp) ? b.timestamp : -1) - (Number.isFinite(a.timestamp) ? a.timestamp : -1));
  const protectedIds = new Set(sortable.slice(0, policy.retainCount).map(entry => entry.item.id));
  const cutoff = policy.maxAgeDays === null ? null : now.getTime() - policy.maxAgeDays * 86400000;
  const candidates = []; const protectedReasons = {};
  for (const entry of sortable) {
    const item = entry.item; let reason = null;
    if (protectedIds.has(item.id)) reason = 'retain_count';
    else if (!Number.isFinite(entry.timestamp)) reason = 'missing_timestamp';
    else if (cutoff !== null && entry.timestamp >= cutoff) reason = 'within_max_age';
    else if (item.isCurrent) reason = 'current_snapshot';
    else if (item.childCount > 0) reason = 'has_children';
    else if (item.integrity?.state !== 'valid') reason = 'integrity_not_valid';
    if (reason) { protectedReasons[reason] = (protectedReasons[reason] || 0) + 1; continue; }
    candidates.push({ id: item.id, name: item.name, createdAt: item.createdAt, childCount: item.childCount });
  }
  candidates.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return {
    schemaVersion: '1.0', policyId: policy.id,
    vm: { id: inventory.vm.id, displayName: inventory.vm.displayName, powerState: inventory.vm.powerState },
    create: { name: _snapshotName(policy, now), consistency: policy.consistency },
    retention: {
      inventoryCount: inventory.count, managedCount: managed.length,
      retainCount: policy.retainCount, maxAgeDays: policy.maxAgeDays,
      maxDeletesPerRun: policy.maxDeletesPerRun,
      candidates: candidates.slice(0, policy.maxDeletesPerRun),
      additionalCandidateCount: Math.max(0, candidates.length - policy.maxDeletesPerRun),
      protectedReasons,
    },
    protection: {
      isBackup: false, managedPrefixOnly: true,
      warning: 'Snapshot retention does not create an independent backup or recovery guarantee',
    },
    evaluatedAt: now.toISOString(),
  };
}

async function previewForHost(host, vmId, draft = null, options = {}) {
  const database = _database(options);
  let policy = getForVm(host.id, vmId, { database });
  if (draft) {
    const value = _validate(draft, policy);
    policy = {
      ...(policy || { id: `vmsp_${sha256(`${host.id}|${vmId}`).slice(0, 26)}`, hostId: Number(host.id), vmId }),
      ...value, schedule: { frequency: value.frequency, minute: value.minute, hour: value.hour, weekday: value.weekday, timezone: 'UTC' },
    };
  }
  if (!policy) throw new SnapshotPolicyError('Snapshot policy was not found', 'SNAPSHOT_POLICY_NOT_FOUND', 404);
  const snapshots = options.snapshots || snapshotsSingleton;
  const inventory = await snapshots.inventoryForHost(host, vmId, { ...options, database });
  return evaluate(policy, inventory, options.now || new Date());
}

function _insertRun(policy, trigger, slotKey, state, plan, database) {
  const id = `vspr_${generateToken(16).slice(0, 26)}`;
  try {
    database.prepare(`INSERT INTO provider_vm_snapshot_policy_runs
      (id, policy_id, trigger_type, slot_key, state, plan_json)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, policy.id, trigger, slotKey, state, JSON.stringify(plan));
  } catch (err) {
    if (String(err?.code || '').startsWith('SQLITE_CONSTRAINT')) {
      throw new SnapshotPolicyError('Snapshot policy already has a run for this slot or an active run', 'SNAPSHOT_POLICY_RUN_ACTIVE', 409);
    }
    throw err;
  }
  return _publicRun(database.prepare('SELECT * FROM provider_vm_snapshot_policy_runs WHERE id = ?').get(id));
}

function _updatePolicyRun(policyId, state, summary, slotKey, database) {
  database.prepare(`UPDATE provider_vm_snapshot_policies SET last_slot_key = ?, last_run_at = datetime('now'),
    last_run_status = ?, last_run_summary_json = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(slotKey, state, JSON.stringify(summary || {}), policyId);
}

function _finishRun(runId, state, options, database) {
  const code = _text(options?.code, 80); const message = _text(options?.message, 240);
  database.prepare(`UPDATE provider_vm_snapshot_policy_runs SET state = ?, error_code = ?, error_message = ?,
    completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .run(state, code, message, runId);
  const row = database.prepare('SELECT * FROM provider_vm_snapshot_policy_runs WHERE id = ?').get(runId);
  _updatePolicyRun(row.policy_id, state, { runId, deleteCount: row.delete_count, code }, row.slot_key, database);
  return _publicRun(row);
}

async function _dispatchCreate(host, policy, run, plan, options = {}) {
  const database = _database(options); const snapshots = options.snapshots || snapshotsSingleton;
  try {
    const preflight = await snapshots.preflightForHost(host, policy.vmId, 'create', {
      name: plan.create.name, consistency: plan.create.consistency,
      description: policy.description || `Managed by snapshot policy ${policy.id}`,
    }, null, { ...options, database, canOperate: true, enabled: true });
    const result = await snapshots.submitForHost(host, policy.vmId, 'create', {
      name: plan.create.name, consistency: plan.create.consistency,
      description: policy.description || `Managed by snapshot policy ${policy.id}`,
      planHash: preflight.planHash, confirm: true,
      idempotencyKey: _childKey(policy, run, 'create'),
    }, null, { ...options, database, canOperate: true, enabled: true, createdBy: options.createdBy });
    database.prepare(`UPDATE provider_vm_snapshot_policy_runs SET current_operation_id = ?,
      state = 'create_pending', updated_at = datetime('now') WHERE id = ?`)
      .run(result.operation.id, run.id);
    _updatePolicyRun(policy.id, 'create_pending', { runId: run.id, operationId: result.operation.id }, run.slotKey, database);
    return _publicRun(database.prepare('SELECT * FROM provider_vm_snapshot_policy_runs WHERE id = ?').get(run.id));
  } catch (err) {
    const state = ['VM_SNAPSHOT_PREFLIGHT_BLOCKED', 'SNAPSHOT_AUTOMATION_DISABLED'].includes(err.code) ? 'blocked' : 'failed';
    return _finishRun(run.id, state, { code: err.code || 'SNAPSHOT_POLICY_CREATE_FAILED', message: err.message }, database);
  }
}

async function runForHost(host, vmId, options = {}) {
  const database = _database(options);
  const policy = getForVm(host.id, vmId, { database });
  if (!policy) throw new SnapshotPolicyError('Snapshot policy was not found', 'SNAPSHOT_POLICY_NOT_FOUND', 404);
  if (!policy.enabled && options.allowDisabled !== true) throw new SnapshotPolicyError('Snapshot policy is disabled', 'SNAPSHOT_POLICY_DISABLED', 409);
  const active = database.prepare(`SELECT id FROM provider_vm_snapshot_policy_runs
    WHERE policy_id = ? AND state IN ('create_pending', 'retention_pending') LIMIT 1`).get(policy.id);
  if (active) throw new SnapshotPolicyError('Snapshot policy already has an active run', 'SNAPSHOT_POLICY_RUN_ACTIVE', 409);
  const trigger = options.trigger === 'scheduled' ? 'scheduled' : 'manual';
  const slotKey = options.slotKey || `manual:${new Date().toISOString()}:${generateToken(5)}`;
  const plan = await previewForHost(host, vmId, null, { ...options, database });
  if (policy.mode === 'dry_run' || options.dryRun === true) {
    const run = _insertRun(policy, trigger === 'scheduled' ? 'scheduled' : 'preview', slotKey, 'previewed', plan, database);
    _updatePolicyRun(policy.id, 'previewed', { runId: run.id, candidates: plan.retention.candidates.length }, slotKey, database);
    return run;
  }
  const automationEnabled = _automationEnabled(options);
  if (!automationEnabled) {
    const run = _insertRun(policy, trigger, slotKey, 'blocked', plan, database);
    return _finishRun(run.id, 'blocked', { code: 'SNAPSHOT_AUTOMATION_DISABLED', message: 'Snapshot automation is disabled by release policy' }, database);
  }
  if (trigger === 'manual' && (options.confirm !== true || options.confirmName !== plan.vm.displayName)) {
    throw new SnapshotPolicyError('Manual run requires the exact VM name', 'VM_SNAPSHOT_POLICY_TYPED_CONFIRMATION_REQUIRED');
  }
  const run = _insertRun(policy, trigger, slotKey, 'create_pending', plan, database);
  return _dispatchCreate(host, policy, run, plan, { ...options, database });
}

function _hostForPolicy(policy, database) {
  const host = database.prepare('SELECT * FROM docker_hosts WHERE id = ? AND is_active = 1').get(policy.hostId);
  if (!host) throw new SnapshotPolicyError('Snapshot policy endpoint is unavailable', 'INVALID_OPERATION_HOST', 409);
  return host;
}

async function _dispatchNextDelete(host, policy, run, options = {}) {
  const database = _database(options); const snapshots = options.snapshots || snapshotsSingleton;
  if (run.deleteCount >= policy.maxDeletesPerRun) return _finishRun(run.id, 'succeeded', {}, database);
  if (!_automationEnabled(options)) {
    return _finishRun(run.id, 'blocked', { code: 'SNAPSHOT_AUTOMATION_DISABLED', message: 'Snapshot automation was disabled before retention dispatch' }, database);
  }
  let plan;
  try { plan = await previewForHost(host, policy.vmId, null, { ...options, database }); }
  catch (err) { return _finishRun(run.id, 'failed', { code: err.code || 'SNAPSHOT_POLICY_REFRESH_FAILED', message: err.message }, database); }
  const candidate = plan.retention.candidates[0];
  if (!candidate) return _finishRun(run.id, 'succeeded', {}, database);
  try {
    const preflight = await snapshots.preflightForHost(host, policy.vmId, 'delete', {}, candidate.id,
      { ...options, database, canOperate: true, enabled: true });
    const result = await snapshots.submitForHost(host, policy.vmId, 'delete', {
      planHash: preflight.planHash, confirm: true, confirmName: candidate.name,
      idempotencyKey: _childKey(policy, run, 'delete', run.deleteCount + 1),
    }, candidate.id, { ...options, database, canOperate: true, enabled: true, createdBy: options.createdBy });
    database.prepare(`UPDATE provider_vm_snapshot_policy_runs SET current_operation_id = ?,
      state = 'retention_pending', plan_json = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(result.operation.id, JSON.stringify(plan), run.id);
    _updatePolicyRun(policy.id, 'retention_pending', {
      runId: run.id, operationId: result.operation.id, deleteCount: run.deleteCount,
    }, run.slotKey, database);
    return _publicRun(database.prepare('SELECT * FROM provider_vm_snapshot_policy_runs WHERE id = ?').get(run.id));
  } catch (err) {
    const state = err.code === 'VM_SNAPSHOT_PREFLIGHT_BLOCKED' ? 'blocked' : 'failed';
    return _finishRun(run.id, state, { code: err.code || 'SNAPSHOT_POLICY_DELETE_FAILED', message: err.message }, database);
  }
}

async function reconcileRun(runIdInput, options = {}) {
  const runId = String(runIdInput || ''); const database = _database(options);
  if (!SAFE_RUN_ID.test(runId)) throw new SnapshotPolicyError('Snapshot policy run was not found', 'SNAPSHOT_POLICY_RUN_NOT_FOUND', 404);
  const row = database.prepare('SELECT * FROM provider_vm_snapshot_policy_runs WHERE id = ?').get(runId);
  if (!row) throw new SnapshotPolicyError('Snapshot policy run was not found', 'SNAPSHOT_POLICY_RUN_NOT_FOUND', 404);
  let run = _publicRun(row);
  if (TERMINAL_RUN_STATES.has(run.state)) return run;
  const policy = get(row.policy_id, { database });
  if (!policy) return _finishRun(run.id, 'failed', { code: 'SNAPSHOT_POLICY_NOT_FOUND', message: 'Snapshot policy was removed' }, database);
  let host;
  if (!run.currentOperationId) {
    const recorded = _recordedChild(policy, run, database);
    if (recorded) {
      database.prepare(`UPDATE provider_vm_snapshot_policy_runs
        SET current_operation_id = ?, state = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(recorded.id, recorded.state, run.id);
      run = _publicRun(database.prepare('SELECT * FROM provider_vm_snapshot_policy_runs WHERE id = ?').get(run.id));
    } else {
      try { host = _hostForPolicy(policy, database); }
      catch (err) { return _finishRun(run.id, 'failed', { code: err.code, message: err.message }, database); }
      if (run.state === 'create_pending') {
        return _dispatchCreate(host, policy, run, run.plan, { ...options, database, createdBy: policy.createdBy });
      }
      return _dispatchNextDelete(host, policy, run, { ...options, database, createdBy: policy.createdBy });
    }
  }
  const operations = options.operations || operationsSingleton;
  const operation = operations.get(run.currentOperationId);
  if (!operation || !TERMINAL_OPERATION_STATES.has(operation.state)) return run;
  if (operation.state === 'unknown') return _finishRun(run.id, 'unknown', { code: 'SNAPSHOT_POLICY_CHILD_UNKNOWN', message: 'Child snapshot operation requires manual reconciliation' }, database);
  if (operation.state !== 'succeeded') {
    return _finishRun(run.id, 'failed', { code: operation.error?.code || 'SNAPSHOT_POLICY_CHILD_FAILED', message: operation.error?.message || `Child operation ${operation.state}` }, database);
  }
  if (run.state === 'retention_pending') {
    database.prepare(`UPDATE provider_vm_snapshot_policy_runs SET delete_count = delete_count + 1,
      current_operation_id = NULL, updated_at = datetime('now') WHERE id = ?`).run(run.id);
    run = _publicRun(database.prepare('SELECT * FROM provider_vm_snapshot_policy_runs WHERE id = ?').get(run.id));
  } else {
    database.prepare(`UPDATE provider_vm_snapshot_policy_runs SET current_operation_id = NULL,
      updated_at = datetime('now') WHERE id = ?`).run(run.id);
    run = _publicRun(database.prepare('SELECT * FROM provider_vm_snapshot_policy_runs WHERE id = ?').get(run.id));
  }
  try { host = host || _hostForPolicy(policy, database); }
  catch (err) { return _finishRun(run.id, 'failed', { code: err.code, message: err.message }, database); }
  return _dispatchNextDelete(host, policy, run, { ...options, database, createdBy: policy.createdBy });
}

async function reconcilePending(options = {}) {
  const database = _database(options);
  const rows = database.prepare(`SELECT id FROM provider_vm_snapshot_policy_runs
    WHERE state IN ('create_pending', 'retention_pending') ORDER BY created_at LIMIT 100`).all();
  const results = [];
  for (const row of rows) {
    try { results.push(await reconcileRun(row.id, { ...options, database })); }
    catch (err) { log.error('Snapshot policy reconciliation failed', { runId: row.id, error: err.message }); }
  }
  return results;
}

function _systemAudit(policy, run) {
  try {
    audit.log({
      username: 'system', action: 'provider_vm_snapshot_policy_scheduled',
      targetType: 'virtualMachine', targetId: policy.vmId,
      details: { policyId: policy.id, runId: run.id, state: run.state, hostId: policy.hostId },
    });
  } catch { /* policy execution remains authoritative in its run table */ }
}

async function runDue(options = {}) {
  const database = _database(options); const now = options.now || new Date();
  const reconciled = await reconcilePending({ ...options, database });
  const policies = database.prepare(`SELECT * FROM provider_vm_snapshot_policies
    WHERE enabled = 1 AND deleted_at IS NULL ORDER BY id`).all().map(_publicPolicy);
  const started = [];
  for (const policy of policies) {
    const slotKey = _slotKey(policy, now);
    if (!slotKey || policy.lastSlotKey === slotKey) continue;
    const active = database.prepare(`SELECT id FROM provider_vm_snapshot_policy_runs
      WHERE policy_id = ? AND state IN ('create_pending', 'retention_pending') LIMIT 1`).get(policy.id);
    if (active) continue;
    let run;
    try {
      const host = _hostForPolicy(policy, database);
      run = await runForHost(host, policy.vmId, {
        ...options, database, trigger: 'scheduled', slotKey,
        dryRun: policy.mode === 'dry_run', allowDisabled: true, createdBy: policy.createdBy,
      });
    } catch (err) {
      log.error('Scheduled snapshot policy failed to start', { policyId: policy.id, error: err.message });
      continue;
    }
    started.push(run); _systemAudit(policy, run);
  }
  return { reconciled, started };
}

module.exports = {
  SnapshotPolicyError, getForVm, get, listRuns, upsertForHost, removeForVm,
  evaluate, previewForHost, runForHost, reconcileRun, reconcilePending, runDue,
  _internals: {
    _text, _integer, _cron, _publicPolicy, _publicRun, _validate,
    _slotKey, _snapshotName, _childKey, _recordedChild,
    _automationEnabled, _finishRun, _dispatchNextDelete,
  },
};
