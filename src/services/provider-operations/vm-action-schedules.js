'use strict';

const cron = require('node-cron');
const config = require('../../config');
const { getDb } = require('../../db');
const { generateToken, sha256 } = require('../../utils/crypto');
const registrySingleton = require('../provider-sdk/registry');
const powerSingleton = require('./vm-power');
const snapshotsSingleton = require('./vm-snapshots');
const audit = require('../audit');
const { globMatches } = require('../governance-approvals');
const { _internals: calendar } = require('../infrastructure-operations');

const SAFE_VM_ID = /^ddr_vm_[a-f0-9]{26}$/;
const SAFE_SCHEDULE_ID = /^vmas_[a-f0-9]{26}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;
const SAFE_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACTIONS = new Set(['start', 'stop', 'reboot', 'snapshot']);
const TERMINAL_OPERATION_STATES = new Set(['succeeded', 'failed', 'cancelled']);
const ACTIVE_RUN_STATES = new Set(['queued', 'running', 'unknown']);
const MAX_SCHEDULES_PER_VM = 25;
const ACTION_KEY_PREFIX = 'provider.vm.schedule.';

class VmActionScheduleError extends Error {
  constructor(message, code = 'VM_ACTION_SCHEDULE_ERROR', status = 400, details = null) {
    super(message); this.name = 'VmActionScheduleError'; this.code = code; this.status = status; this.details = details;
  }
}

function fail(message, code, status = 400, details = null) {
  throw new VmActionScheduleError(message, code, status, details);
}
function parse(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function text(value, label, max, pattern = null) {
  const result = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!result || result.length > max || (pattern && !pattern.test(result))) fail(`${label} is invalid`, 'INVALID_VM_ACTION_SCHEDULE');
  return result;
}
function integer(value, label, min, max, fallback) {
  const result = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    fail(`${label} must be an integer between ${min} and ${max}`, 'INVALID_VM_ACTION_SCHEDULE');
  }
  return result;
}
function bool(value, fallback = false) { return value === undefined ? fallback : value === true; }
function validDate(value) {
  if (!DATE.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function timezone(value) {
  const zone = text(value || 'UTC', 'timezone', 100);
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); }
  catch { fail('timezone must be a supported IANA timezone', 'INVALID_VM_ACTION_SCHEDULE'); }
  return zone;
}
function snapshotInput(value = {}, previous = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const consistency = String(input.consistency ?? previous.consistency ?? 'crash');
  if (!['crash', 'quiesced'].includes(consistency)) fail('Snapshot consistency must be crash or quiesced', 'INVALID_VM_ACTION_SCHEDULE');
  const namePrefix = text(input.namePrefix ?? previous.namePrefix ?? 'dd-scheduled', 'snapshot namePrefix', 48, SAFE_PREFIX);
  const descriptionValue = input.description ?? previous.description ?? '';
  const description = String(descriptionValue).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500);
  return { consistency, namePrefix, description: description || null };
}
function holidays(value, previous = []) {
  const input = value === undefined ? previous : value;
  if (!Array.isArray(input) || input.length > 366 || input.some(item => !validDate(item))) {
    fail('holidays must contain at most 366 valid YYYY-MM-DD dates', 'INVALID_VM_ACTION_SCHEDULE');
  }
  return [...new Set(input)].sort();
}
function blackouts(value, previous = []) {
  try { return calendar.normalizeBlackouts(value === undefined ? previous : value); }
  catch (error) { fail(error.message, 'INVALID_VM_ACTION_SCHEDULE'); }
}
function executeEnabled(options = {}) {
  if (options.executeEnabled !== undefined) return options.executeEnabled === true;
  return config.features?.providerVmActionSchedules === true;
}
function operationType(action) { return action === 'snapshot' ? 'vm.snapshot' : 'vm.power'; }
function operationAction(action) { return action === 'stop' ? 'shutdown' : action; }
function childKey(schedule, slotKey) { return `vm-action-schedule:${schedule.id}:${slotKey}`; }
function localKey(parts) { return `${parts.date}T${parts.time}`; }

function publicSchedule(row) {
  if (!row) return null;
  return {
    schemaVersion: '1.0', id: row.id, hostId: Number(row.host_id), vmId: row.vm_id,
    vmDisplayName: row.vm_display_name, name: row.name, action: row.action,
    cron: row.cron_expression, timezone: row.timezone, dstPolicy: row.dst_policy,
    mode: row.mode, enabled: !!row.enabled, snapshot: parse(row.snapshot_json, {}),
    holidays: parse(row.holidays_json, []), blackoutWindows: parse(row.blackout_windows_json, []),
    environment: row.environment, scopeId: row.scope_id == null ? null : Number(row.scope_id),
    version: Number(row.version), failureThreshold: Number(row.failure_threshold),
    consecutiveFailures: Number(row.consecutive_failures),
    executeConfirmedAt: row.execute_confirmed_at || null,
    lastEvaluatedAt: row.last_evaluated_at || null, lastSlotKey: row.last_slot_key || null,
    lastRunAt: row.last_run_at || null, lastRunStatus: row.last_run_status || null,
    createdBy: row.created_by || null, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function publicRun(row) {
  if (!row) return null;
  return {
    schemaVersion: '1.0', id: row.id, scheduleId: row.schedule_id,
    trigger: row.trigger_type, slotKey: row.slot_key, scheduledFor: row.scheduled_for,
    localTime: row.local_time, dstOccurrence: row.dst_occurrence == null ? null : Number(row.dst_occurrence),
    state: row.state, decision: row.decision,
    reason: row.reason_code ? { code: row.reason_code, message: row.reason_message || '' } : null,
    operationId: row.operation_id || null, plan: parse(row.plan_json, {}),
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at || null,
  };
}

class VmActionSchedulesService {
  constructor(options = {}) {
    this._dbProvider = options.dbProvider || getDb;
    this._registry = options.registry || registrySingleton;
    this._power = options.power || powerSingleton;
    this._snapshots = options.snapshots || snapshotsSingleton;
  }
  _db(options = {}) { return options.database || this._dbProvider(); }
  _row(id, database) {
    if (!SAFE_SCHEDULE_ID.test(String(id || ''))) fail('VM action schedule was not found', 'VM_ACTION_SCHEDULE_NOT_FOUND', 404);
    const row = database.prepare('SELECT * FROM provider_vm_action_schedules WHERE id=? AND deleted_at IS NULL').get(id);
    if (!row) fail('VM action schedule was not found', 'VM_ACTION_SCHEDULE_NOT_FOUND', 404);
    return row;
  }
  _host(row, database) {
    const host = database.prepare('SELECT * FROM docker_hosts WHERE id=? AND is_active=1').get(row.host_id);
    if (!host) fail('Provider host is unavailable', 'PROVIDER_HOST_UNAVAILABLE', 424);
    return host;
  }
  async _vm(host, vmId, database) {
    if (!SAFE_VM_ID.test(String(vmId || ''))) fail('Virtual machine was not found', 'PROVIDER_VM_NOT_FOUND', 404);
    const inventory = await this._registry.resourcesForHost(host, 'virtual-machines', { limit: 500, database });
    const vm = inventory.items.find(item => item.id === vmId);
    if (!vm) fail('Virtual machine was not found', 'PROVIDER_VM_NOT_FOUND', 404);
    if (vm.identity?.stability === 'transient') fail('Stable VM identity is required', 'UNSTABLE_RESOURCE_IDENTITY', 409);
    return vm;
  }
  _validate(input = {}, previous = null) {
    const action = String(input.action ?? previous?.action ?? 'start');
    if (!ACTIONS.has(action)) fail('action must be start, stop, reboot or snapshot', 'INVALID_VM_ACTION_SCHEDULE');
    const expression = text(input.cron ?? previous?.cron ?? '0 7 * * 1-5', 'cron', 100);
    if (expression.trim().split(/\s+/).length !== 5 || !cron.validate(expression)) {
      fail('cron must be a valid five-field expression', 'INVALID_VM_ACTION_SCHEDULE');
    }
    const dstPolicy = String(input.dstPolicy ?? previous?.dstPolicy ?? 'first');
    if (!['first', 'second', 'skip'].includes(dstPolicy)) fail('dstPolicy must be first, second or skip', 'INVALID_VM_ACTION_SCHEDULE');
    const mode = String(input.mode ?? previous?.mode ?? 'dry_run');
    if (!['dry_run', 'execute'].includes(mode)) fail('mode must be dry_run or execute', 'INVALID_VM_ACTION_SCHEDULE');
    const environment = String(input.environment ?? previous?.environment ?? 'production');
    if (!['production', 'nonproduction'].includes(environment)) fail('environment is invalid', 'INVALID_VM_ACTION_SCHEDULE');
    const scopeInput = input.scopeId === undefined ? previous?.scopeId : input.scopeId;
    return {
      name: text(input.name ?? previous?.name ?? 'weekday-start', 'name', 80, SAFE_NAME), action,
      cron: expression.trim().replace(/\s+/g, ' '), timezone: timezone(input.timezone ?? previous?.timezone ?? 'UTC'),
      dstPolicy, mode, enabled: bool(input.enabled, previous?.enabled || false),
      snapshot: snapshotInput(input.snapshot, previous?.snapshot),
      holidays: holidays(input.holidays, previous?.holidays),
      blackoutWindows: blackouts(input.blackoutWindows, previous?.blackoutWindows),
      environment, scopeId: scopeInput == null || scopeInput === '' ? null
        : integer(scopeInput, 'scopeId', 1, Number.MAX_SAFE_INTEGER),
      failureThreshold: integer(input.failureThreshold, 'failureThreshold', 1, 20, previous?.failureThreshold ?? 3),
    };
  }
  listForVm(hostId, vmId, options = {}) {
    const database = this._db(options); const host = Number(hostId); const id = String(vmId || '');
    if (!Number.isSafeInteger(host) || host <= 0 || !SAFE_VM_ID.test(id)) return [];
    return database.prepare(`SELECT * FROM provider_vm_action_schedules
      WHERE host_id=? AND vm_id=? AND deleted_at IS NULL ORDER BY name,id`).all(host, id).map(publicSchedule);
  }
  listRuns(scheduleId, options = {}) {
    const database = this._db(options); this._row(scheduleId, database);
    const limit = integer(options.limit, 'limit', 1, 200, 50);
    return database.prepare(`SELECT * FROM provider_vm_action_schedule_runs
      WHERE schedule_id=? ORDER BY created_at DESC,id DESC LIMIT ?`).all(scheduleId, limit).map(publicRun);
  }
  async createForHost(host, vmId, input = {}, options = {}) {
    const database = this._db(options);
    if (database.prepare(`SELECT COUNT(*) AS count FROM provider_vm_action_schedules
      WHERE host_id=? AND vm_id=? AND deleted_at IS NULL`).get(host.id, vmId).count >= MAX_SCHEDULES_PER_VM) {
      fail(`A VM may have at most ${MAX_SCHEDULES_PER_VM} action schedules`, 'VM_ACTION_SCHEDULE_LIMIT', 409);
    }
    const value = this._validate(input); const vm = await this._vm(host, vmId, database);
    this._assertExecutionAuthorization(value, vm, input, options);
    if (value.scopeId && !database.prepare('SELECT 1 FROM governance_scopes WHERE id=?').get(value.scopeId)) {
      fail('Governance scope was not found', 'GOVERNANCE_SCOPE_NOT_FOUND', 404);
    }
    const id = `vmas_${generateToken(13)}`;
    try {
      database.prepare(`INSERT INTO provider_vm_action_schedules
        (id,host_id,vm_id,vm_display_name,name,action,cron_expression,timezone,dst_policy,mode,enabled,
         snapshot_json,holidays_json,blackout_windows_json,environment,scope_id,failure_threshold,
         execute_confirmed_by,execute_confirmed_at,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ? THEN datetime('now') ELSE NULL END,?)`).run(
        id, Number(host.id), vmId, vm.displayName, value.name, value.action, value.cron, value.timezone,
        value.dstPolicy, value.mode, value.enabled ? 1 : 0, JSON.stringify(value.snapshot), JSON.stringify(value.holidays),
        JSON.stringify(value.blackoutWindows), value.environment, value.scopeId, value.failureThreshold,
        value.enabled && value.mode === 'execute' ? options.createdBy || null : null,
        value.enabled && value.mode === 'execute' ? 1 : 0, options.createdBy || null
      );
    } catch (error) {
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) fail('Schedule name already exists for this VM', 'VM_ACTION_SCHEDULE_EXISTS', 409);
      throw error;
    }
    return publicSchedule(this._row(id, database));
  }
  async updateForHost(host, vmId, scheduleId, input = {}, options = {}) {
    const database = this._db(options); const row = this._row(scheduleId, database);
    if (Number(row.host_id) !== Number(host.id) || row.vm_id !== vmId) fail('VM action schedule was not found', 'VM_ACTION_SCHEDULE_NOT_FOUND', 404);
    const previous = publicSchedule(row); const expectedVersion = integer(input.version, 'version', 1, Number.MAX_SAFE_INTEGER);
    if (expectedVersion !== previous.version) fail('Schedule changed; reload before saving', 'VM_ACTION_SCHEDULE_VERSION_CONFLICT', 409,
      { expected: expectedVersion, current: previous.version });
    const value = this._validate(input, previous); const vm = await this._vm(host, vmId, database);
    this._assertExecutionAuthorization(value, vm, input, options);
    if (value.scopeId && !database.prepare('SELECT 1 FROM governance_scopes WHERE id=?').get(value.scopeId)) {
      fail('Governance scope was not found', 'GOVERNANCE_SCOPE_NOT_FOUND', 404);
    }
    const active = database.prepare(`SELECT id FROM provider_vm_action_schedule_runs
      WHERE schedule_id=? AND state IN ('queued','running','unknown')`).get(scheduleId);
    if (active && (value.action !== previous.action || value.mode !== previous.mode)) {
      fail('Action or mode cannot change while a run is active or unknown', 'VM_ACTION_SCHEDULE_RUN_ACTIVE', 409, { runId: active.id });
    }
    try {
      const result = database.prepare(`UPDATE provider_vm_action_schedules SET
        vm_display_name=?,name=?,action=?,cron_expression=?,timezone=?,dst_policy=?,mode=?,enabled=?,
        snapshot_json=?,holidays_json=?,blackout_windows_json=?,environment=?,scope_id=?,failure_threshold=?,
        execute_confirmed_by=?,execute_confirmed_at=CASE WHEN ? THEN datetime('now') ELSE NULL END,
        version=version+1,updated_at=datetime('now') WHERE id=? AND version=?`).run(
        vm.displayName, value.name, value.action, value.cron, value.timezone, value.dstPolicy, value.mode,
        value.enabled ? 1 : 0, JSON.stringify(value.snapshot), JSON.stringify(value.holidays),
        JSON.stringify(value.blackoutWindows), value.environment, value.scopeId, value.failureThreshold,
        value.enabled && value.mode === 'execute' ? options.createdBy || null : null,
        value.enabled && value.mode === 'execute' ? 1 : 0, scheduleId, expectedVersion
      );
      if (!result.changes) fail('Schedule changed; reload before saving', 'VM_ACTION_SCHEDULE_VERSION_CONFLICT', 409);
    } catch (error) {
      if (error instanceof VmActionScheduleError) throw error;
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) fail('Schedule name already exists for this VM', 'VM_ACTION_SCHEDULE_EXISTS', 409);
      throw error;
    }
    return publicSchedule(this._row(scheduleId, database));
  }
  _assertExecutionAuthorization(value, vm, input, options) {
    if (!(value.enabled && value.mode === 'execute')) return;
    if (!executeEnabled(options)) fail('Scheduled VM action execution is disabled by release policy', 'VM_ACTION_SCHEDULE_EXECUTION_DISABLED', 409);
    if (input.confirm !== true || input.confirmName !== vm.displayName) {
      fail('Execute schedule requires the exact VM name', 'VM_ACTION_SCHEDULE_TYPED_CONFIRMATION_REQUIRED');
    }
  }
  removeForVm(hostId, vmId, scheduleId, options = {}) {
    const database = this._db(options); const row = this._row(scheduleId, database);
    if (Number(row.host_id) !== Number(hostId) || row.vm_id !== vmId) fail('VM action schedule was not found', 'VM_ACTION_SCHEDULE_NOT_FOUND', 404);
    const active = database.prepare(`SELECT id FROM provider_vm_action_schedule_runs
      WHERE schedule_id=? AND state IN ('queued','running','unknown')`).get(scheduleId);
    if (active) fail('Schedule has an active or unknown run', 'VM_ACTION_SCHEDULE_RUN_ACTIVE', 409, { runId: active.id });
    database.prepare(`UPDATE provider_vm_action_schedules SET enabled=0,deleted_at=datetime('now'),
      version=version+1,updated_at=datetime('now') WHERE id=?`).run(scheduleId);
    return publicSchedule(row);
  }
  _scopeChain(scopeId, database) {
    const ids = new Set(); let current = scopeId
      ? database.prepare('SELECT id,parent_id FROM governance_scopes WHERE id=?').get(scopeId) : null;
    while (current && !ids.has(current.id)) {
      ids.add(current.id); current = current.parent_id == null ? null
        : database.prepare('SELECT id,parent_id FROM governance_scopes WHERE id=?').get(current.parent_id);
    }
    return ids;
  }
  _governanceBlackout(schedule, instant, database) {
    const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='governance_blackout_windows'").get();
    if (!table) return null;
    const chain = this._scopeChain(schedule.scopeId, database); const actionKey = `${ACTION_KEY_PREFIX}${schedule.action}`;
    return database.prepare(`SELECT * FROM governance_blackout_windows WHERE enabled=1
      AND datetime(starts_at)<=datetime(?) AND datetime(ends_at)>datetime(?)
      AND (environment='any' OR environment=?) ORDER BY id`).all(instant.toISOString(), instant.toISOString(), schedule.environment)
      .find(window => (window.scope_id == null || chain.has(window.scope_id)) && globMatches(window.action_pattern, actionKey)) || null;
  }
  _localBlackout(schedule, parts) {
    return schedule.blackoutWindows.find(window => (!window.weekdays.length || window.weekdays.includes(parts.weekday))
      && calendar.inWindow(parts.time, window)) || null;
  }
  _occurrence(instant, zone, parts) {
    const target = localKey(parts); const matches = [];
    const base = Math.floor(instant.getTime() / 60000) * 60000;
    for (let offset = -180; offset <= 180; offset += 1) {
      const candidate = new Date(base + offset * 60000);
      if (localKey(calendar.zonedParts(candidate, zone)) === target) matches.push(candidate.getTime());
    }
    const unique = [...new Set(matches)].sort((a, b) => a - b);
    return { ambiguous: unique.length > 1, occurrence: unique.indexOf(base) + 1, count: unique.length };
  }
  _decision(schedule, instant, database) {
    const parts = calendar.zonedParts(instant, schedule.timezone);
    const local = localKey(parts); const occurrence = this._occurrence(instant, schedule.timezone, parts);
    if (schedule.holidays.includes(parts.date)) return { ready: false, code: 'HOLIDAY', message: `Holiday ${parts.date}`, parts, local, occurrence };
    const localWindow = this._localBlackout(schedule, parts);
    if (localWindow) return { ready: false, code: 'LOCAL_BLACKOUT', message: `Blackout ${localWindow.name}`, parts, local, occurrence };
    const governanceWindow = this._governanceBlackout(schedule, instant, database);
    if (governanceWindow) return { ready: false, code: 'GOVERNANCE_BLACKOUT', message: governanceWindow.reason, parts, local, occurrence,
      blackout: { id: governanceWindow.id, name: governanceWindow.name, endsAt: governanceWindow.ends_at, emergencyOverrideUsed: false } };
    if (occurrence.ambiguous) {
      if (schedule.dstPolicy === 'skip') return { ready: false, code: 'DST_AMBIGUOUS_SKIPPED', message: 'Ambiguous local minute skipped by policy', parts, local, occurrence };
      const wanted = schedule.dstPolicy === 'second' ? 2 : 1;
      if (occurrence.occurrence !== wanted) return { ready: false, noRecord: true, code: 'DST_OCCURRENCE_NOT_SELECTED', parts, local, occurrence };
    }
    return { ready: true, code: 'READY', message: 'Schedule is eligible', parts, local, occurrence };
  }
  _insertRun(schedule, trigger, slotKey, instant, local, occurrence, state, decision, reason, plan, database) {
    const id = `vmar_${generateToken(13)}`;
    try {
      database.prepare(`INSERT INTO provider_vm_action_schedule_runs
        (id,schedule_id,trigger_type,slot_key,scheduled_for,local_time,dst_occurrence,state,decision,
         reason_code,reason_message,plan_json,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ? THEN datetime('now') ELSE NULL END)`).run(
        id, schedule.id, trigger, slotKey, instant.toISOString(), local, occurrence || null, state, decision,
        reason?.code || null, reason?.message || null, JSON.stringify(plan || {}), ACTIVE_RUN_STATES.has(state) ? 0 : 1
      );
      database.prepare(`UPDATE provider_vm_action_schedules SET last_slot_key=?,last_run_at=datetime('now'),
        last_run_status=?,updated_at=datetime('now') WHERE id=?`).run(slotKey, state, schedule.id);
      return publicRun(database.prepare('SELECT * FROM provider_vm_action_schedule_runs WHERE id=?').get(id));
    } catch (error) {
      if (!String(error.code || '').startsWith('SQLITE_CONSTRAINT')) throw error;
      return null;
    }
  }
  _updateRun(runId, values, database) {
    database.prepare(`UPDATE provider_vm_action_schedule_runs SET state=?,decision=?,reason_code=?,reason_message=?,
      operation_id=COALESCE(?,operation_id),plan_json=?,completed_at=CASE WHEN ? THEN datetime('now') ELSE NULL END,
      updated_at=datetime('now') WHERE id=?`).run(values.state, values.decision, values.code || null,
      values.message || null, values.operationId || null, JSON.stringify(values.plan || {}),
      ACTIVE_RUN_STATES.has(values.state) ? 0 : 1, runId);
    const row = database.prepare('SELECT * FROM provider_vm_action_schedule_runs WHERE id=?').get(runId);
    database.prepare(`UPDATE provider_vm_action_schedules SET last_run_at=datetime('now'),last_run_status=?,
      last_slot_key=?,updated_at=datetime('now') WHERE id=?`).run(row.state, row.slot_key, row.schedule_id);
    return publicRun(row);
  }
  _failure(scheduleId, state, database) {
    if (!['failed', 'blocked', 'unknown'].includes(state)) {
      if (state === 'succeeded') database.prepare(`UPDATE provider_vm_action_schedules SET consecutive_failures=0,
        updated_at=datetime('now') WHERE id=?`).run(scheduleId);
      return;
    }
    database.prepare(`UPDATE provider_vm_action_schedules SET consecutive_failures=consecutive_failures+1,
      enabled=CASE WHEN consecutive_failures+1>=failure_threshold THEN 0 ELSE enabled END,
      updated_at=datetime('now') WHERE id=?`).run(scheduleId);
  }
  async _preflight(schedule, host, instant, options) {
    if (schedule.action === 'snapshot') {
      const stamp = instant.toISOString().slice(0, 16).replace(/[-:T]/g, '');
      const input = { name: `${schedule.snapshot.namePrefix}-${stamp}`.slice(0, 80),
        consistency: schedule.snapshot.consistency, description: schedule.snapshot.description || `Scheduled by ${schedule.id}` };
      const plan = await this._snapshots.preflightForHost(host, schedule.vmId, 'create', input, null,
        { ...options, canOperate: true });
      return { plan, input };
    }
    const action = operationAction(schedule.action);
    const plan = await this._power.preflightForHost(host, schedule.vmId, action, { ...options, canOperate: true });
    return { plan, input: { action } };
  }
  async _dispatch(schedule, run, host, instant, options = {}) {
    const database = this._db(options);
    try {
      const prepared = await this._preflight(schedule, host, instant, { ...options, database });
      const currentName = prepared.plan.resource?.displayName || prepared.plan.vm?.displayName;
      if (schedule.mode === 'execute' && currentName !== schedule.vmDisplayName) {
        fail('VM display name changed after execute authorization', 'VM_ACTION_SCHEDULE_TARGET_CHANGED', 409,
          { confirmedName: schedule.vmDisplayName, currentName });
      }
      if (schedule.mode === 'dry_run' || options.dryRun === true) {
        return this._updateRun(run.id, { state: 'previewed', decision: prepared.plan.allowed ? 'preview_allowed' : 'preview_blocked',
          code: prepared.plan.allowed ? null : 'PREFLIGHT_BLOCKED', message: prepared.plan.allowed ? null : 'Provider preflight is blocked',
          plan: prepared.plan }, database);
      }
      if (!executeEnabled(options)) fail('Scheduled VM action execution is disabled by release policy', 'VM_ACTION_SCHEDULE_EXECUTION_DISABLED', 409);
      if (!prepared.plan.allowed) fail('Scheduled VM action preflight is blocked', 'VM_ACTION_SCHEDULE_PREFLIGHT_BLOCKED', 409, prepared.plan.blockers);
      let result;
      if (schedule.action === 'snapshot') {
        result = await this._snapshots.submitForHost(host, schedule.vmId, 'create', {
          ...prepared.input, planHash: prepared.plan.planHash, confirm: true,
          idempotencyKey: childKey(schedule, run.slotKey),
        }, null, { ...options, database, canOperate: true, createdBy: schedule.createdBy });
      } else {
        result = await this._power.submitForHost(host, schedule.vmId, {
          ...prepared.input, planHash: prepared.plan.planHash, confirm: true,
          idempotencyKey: childKey(schedule, run.slotKey),
        }, { ...options, database, canOperate: true, createdBy: schedule.createdBy });
      }
      return this._updateRun(run.id, { state: 'queued', decision: 'dispatched', operationId: result.operation.id,
        plan: prepared.plan }, database);
    } catch (error) {
      const blocked = error instanceof VmActionScheduleError || /BLOCKED|DISABLED|NOT_FOUND|UNAVAILABLE|CONFLICT/.test(String(error.code || ''));
      const state = blocked ? 'blocked' : 'failed';
      const result = this._updateRun(run.id, { state, decision: blocked ? 'blocked' : 'dispatch_failed',
        code: error.code || 'VM_ACTION_SCHEDULE_DISPATCH_FAILED', message: String(error.message || error).slice(0, 500),
        plan: error.details ? { blockers: error.details } : run.plan }, database);
      this._failure(schedule.id, state, database); return result;
    }
  }
  _findChild(schedule, run, database) {
    const type = operationType(schedule.action); const keyHash = sha256(`${schedule.hostId}|${type}|${childKey(schedule, run.slotKey)}`);
    return database.prepare(`SELECT * FROM provider_operations WHERE host_id=? AND operation_type=?
      AND idempotency_key_hash=?`).get(schedule.hostId, type, keyHash) || null;
  }
  _applyOperation(schedule, run, operation, database) {
    let state; let decision; let code = null; let message = null;
    if (operation.state === 'succeeded') { state = 'succeeded'; decision = 'operation_succeeded'; }
    else if (['failed', 'cancelled'].includes(operation.state)) {
      state = 'failed'; decision = `operation_${operation.state}`; code = operation.error_code || `OPERATION_${operation.state.toUpperCase()}`;
      message = operation.error_message || `Provider operation ${operation.state}`;
    } else if (operation.state === 'unknown') {
      state = 'unknown'; decision = 'operation_unknown'; code = 'OPERATION_OUTCOME_UNKNOWN'; message = 'Provider operation outcome requires resolution';
    } else { state = operation.state === 'running' || operation.state === 'reconciling' ? 'running' : 'queued'; decision = 'operation_pending'; }
    if (run.state === state && run.operationId === operation.id) return run;
    const result = this._updateRun(run.id, { state, decision, code, message,
      operationId: operation.id, plan: run.plan }, database);
    if (TERMINAL_OPERATION_STATES.has(operation.state) || operation.state === 'unknown') this._failure(schedule.id, state, database);
    return result;
  }
  async reconcilePending(options = {}) {
    const database = this._db(options); const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const rows = database.prepare(`SELECT r.*,s.host_id,s.vm_id,s.vm_display_name,s.name AS schedule_name,
      s.action,s.cron_expression,s.timezone,s.dst_policy,s.mode,s.enabled,s.snapshot_json,s.holidays_json,
      s.blackout_windows_json,s.environment,s.scope_id,s.version,s.failure_threshold,s.consecutive_failures,
      s.created_by,s.created_at AS schedule_created_at,s.updated_at AS schedule_updated_at
      FROM provider_vm_action_schedule_runs r JOIN provider_vm_action_schedules s ON s.id=r.schedule_id
      WHERE r.state IN ('queued','running','unknown') ORDER BY r.created_at LIMIT 200`).all();
    const results = [];
    for (const raw of rows) {
      const schedule = publicSchedule({ ...raw, id: raw.schedule_id, name: raw.schedule_name,
        created_at: raw.schedule_created_at, updated_at: raw.schedule_updated_at });
      let run = publicRun(raw); let operation = raw.operation_id
        ? database.prepare('SELECT * FROM provider_operations WHERE id=?').get(raw.operation_id) : null;
      operation ||= this._findChild(schedule, run, database);
      if (operation) run = this._applyOperation(schedule, run, operation, database);
      else if (run.state === 'running' && now.getTime() - Date.parse(run.createdAt) >= 120000) {
        run = this._updateRun(run.id, { state: 'unknown', decision: 'dispatch_outcome_unknown',
          code: 'DISPATCH_OUTCOME_UNKNOWN', message: 'No durable child operation was found after an interrupted dispatch', plan: run.plan }, database);
        this._failure(schedule.id, 'unknown', database);
      }
      results.push(run);
    }
    return results;
  }
  _recordSuppression(schedule, trigger, slotKey, instant, decision, database) {
    if (decision.noRecord) return null;
    return this._insertRun(schedule, trigger, slotKey, instant, decision.local,
      decision.occurrence?.occurrence || null, 'skipped', 'suppressed',
      { code: decision.code, message: decision.message }, { blackout: decision.blackout || null }, database);
  }
  _missingDstSlots(schedule, instant) {
    const previous = calendar.zonedParts(new Date(instant.getTime() - 60000), schedule.timezone);
    const current = calendar.zonedParts(instant, schedule.timezone);
    const naive = parts => Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const gap = Math.round((naive(current) - naive(previous)) / 60000);
    if (gap <= 1 || gap > 180) return [];
    const items = [];
    for (let index = 1; index < gap; index += 1) {
      const date = new Date(naive(previous) + index * 60000);
      const parts = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
        hour: date.getUTCHours(), minute: date.getUTCMinutes(), weekday: date.getUTCDay(),
        date: date.toISOString().slice(0, 10), time: date.toISOString().slice(11, 16) };
      if (calendar.cronMatches(schedule.cron, parts)) items.push(parts);
    }
    return items;
  }
  async _start(schedule, trigger, slotKey, instant, local, occurrence, options = {}) {
    const database = this._db(options);
    const active = database.prepare(`SELECT id FROM provider_vm_action_schedule_runs
      WHERE schedule_id=? AND state IN ('queued','running','unknown')`).get(schedule.id);
    if (active) return this._insertRun(schedule, trigger, slotKey, instant, local, occurrence, 'skipped', 'active_run',
      { code: 'ACTIVE_RUN', message: 'A previous run is still active or has an unknown outcome' }, { activeRunId: active.id }, database);
    const run = this._insertRun(schedule, trigger, slotKey, instant, local, occurrence, 'running', 'evaluating', null, {}, database);
    if (!run) return null;
    try { return await this._dispatch(schedule, run, this._host({ host_id: schedule.hostId }, database), instant, options); }
    catch (error) {
      const result = this._updateRun(run.id, { state: 'failed', decision: 'host_unavailable',
        code: error.code || 'PROVIDER_HOST_UNAVAILABLE', message: error.message, plan: {} }, database);
      this._failure(schedule.id, 'failed', database); return result;
    }
  }
  async runNow(scheduleId, input = {}, options = {}) {
    const database = this._db(options); const schedule = publicSchedule(this._row(scheduleId, database));
    const instant = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    if (Number.isNaN(instant.getTime())) fail('now is invalid', 'INVALID_VM_ACTION_SCHEDULE');
    if (schedule.mode === 'execute') {
      if (!schedule.enabled) fail('Execute schedule is disabled', 'VM_ACTION_SCHEDULE_DISABLED', 409);
      if (!executeEnabled(options)) fail('Scheduled VM action execution is disabled by release policy', 'VM_ACTION_SCHEDULE_EXECUTION_DISABLED', 409);
      if (input.confirm !== true || input.confirmName !== schedule.vmDisplayName) {
        fail('Execute run requires the exact VM name', 'VM_ACTION_SCHEDULE_TYPED_CONFIRMATION_REQUIRED');
      }
    }
    const parts = calendar.zonedParts(instant, schedule.timezone); const decision = this._decision(schedule, instant, database);
    const slot = `manual:${instant.toISOString()}:${generateToken(5)}`;
    if (!decision.ready) return this._recordSuppression(schedule, 'manual', slot, instant, decision, database);
    return this._start(schedule, 'manual', slot, instant, localKey(parts), decision.occurrence.occurrence, options);
  }
  async runDue(options = {}) {
    const database = this._db(options); const instant = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    if (Number.isNaN(instant.getTime())) fail('now is invalid', 'INVALID_VM_ACTION_SCHEDULE');
    const reconciled = await this.reconcilePending({ ...options, database, now: instant });
    const schedules = database.prepare(`SELECT * FROM provider_vm_action_schedules
      WHERE enabled=1 AND deleted_at IS NULL ORDER BY id`).all().map(publicSchedule);
    const started = [];
    for (const schedule of schedules) {
      for (const missing of this._missingDstSlots(schedule, instant)) {
        const local = localKey(missing); const slot = `${local}:${schedule.action}`;
        const run = this._insertRun(schedule, 'scheduled', slot, instant, local, null, 'skipped', 'suppressed',
          { code: 'DST_NONEXISTENT', message: 'Cron minute did not exist during the forward DST transition' }, {}, database);
        if (run) started.push(run);
      }
      const parts = calendar.zonedParts(instant, schedule.timezone);
      database.prepare(`UPDATE provider_vm_action_schedules SET last_evaluated_at=?,updated_at=datetime('now') WHERE id=?`)
        .run(instant.toISOString(), schedule.id);
      if (!calendar.cronMatches(schedule.cron, parts)) continue;
      const decision = this._decision(schedule, instant, database); const slot = `${decision.local}:${schedule.action}`;
      let run;
      if (!decision.ready) run = this._recordSuppression(schedule, 'scheduled', slot, instant, decision, database);
      else run = await this._start(schedule, 'scheduled', slot, instant, decision.local, decision.occurrence.occurrence, options);
      if (run) { started.push(run); this._audit(schedule, run); }
    }
    return { reconciled, started };
  }
  _audit(schedule, run) {
    try {
      audit.log({ username: 'system', action: 'provider_vm_action_schedule_tick',
        targetType: 'virtualMachine', targetId: schedule.vmId,
        details: { scheduleId: schedule.id, runId: run.id, hostId: schedule.hostId,
          action: schedule.action, mode: schedule.mode, state: run.state, decision: run.decision,
          operationId: run.operationId, emergencyOverrideUsed: false } });
    } catch { /* the run ledger remains authoritative */ }
  }
}

const service = new VmActionSchedulesService();
module.exports = service;
module.exports.VmActionSchedulesService = VmActionSchedulesService;
module.exports.VmActionScheduleError = VmActionScheduleError;
module.exports._internals = { publicSchedule, publicRun, executeEnabled, operationType, operationAction,
  childKey, localKey, validDate, snapshotInput };
