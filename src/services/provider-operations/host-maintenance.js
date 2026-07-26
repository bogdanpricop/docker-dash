'use strict';

const config = require('../../config');
const { getDb } = require('../../db');
const { encrypt, decrypt, sha256, generateToken } = require('../../utils/crypto');
const log = require('../../utils/logger')('provider-host-maintenance');
const registrySingleton = require('../provider-sdk/registry');
const migrationPreflightSingleton = require('../provider-sdk/vm-migration-preflight');
const operationsSingleton = require('./index');
const vmMigrationSingleton = require('./vm-migration');
const nativeSingleton = require('./maintenance-provider');

const PLAN_TTL_MS = 5 * 60 * 1000;
const MAX_VMS = 200;
const SAFE_RUN_ID = /^hmr_[a-f0-9]{26}$/;
const SAFE_HOST_ID = /^ddr_host_[a-f0-9]{26}$/;
const ACTIVE_STATES = Object.freeze([
  'queued', 'preparing', 'draining', 'paused', 'entering',
  'drained', 'maintenance', 'exiting', 'unknown',
]);
const DUE_STATES = Object.freeze(['queued', 'preparing', 'draining', 'entering', 'exiting']);
const CHILD_TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);
const WORKER_OWNER = `maintenance-${generateToken(8)}`;

class HostMaintenanceError extends Error {
  constructor(message, code = 'HOST_MAINTENANCE_ERROR', status = 400, details = null) {
    super(message); this.name = 'HostMaintenanceError'; this.code = code; this.status = status; this.details = details;
  }
}

function _text(value, max = 240) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function _json(value, fallback = null) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function _now() { return new Date().toISOString(); }
function _future(ms) { return new Date(Date.now() + ms).toISOString(); }
function _database(options) { return options.database || getDb(); }

function _input(value = {}) {
  const sourceHostId = String(value.sourceHostId || '');
  const goal = String(value.goal || 'drain');
  const waveSize = Number(value.waveSize ?? 2);
  const nonMigratablePolicy = String(value.nonMigratablePolicy || 'block');
  if (!SAFE_HOST_ID.test(sourceHostId)) throw new HostMaintenanceError('Canonical source host is required', 'INVALID_MAINTENANCE_HOST');
  if (!['drain', 'enter'].includes(goal)) throw new HostMaintenanceError('Maintenance goal must be drain or enter', 'INVALID_MAINTENANCE_GOAL');
  if (!Number.isInteger(waveSize) || waveSize < 1 || waveSize > 10) {
    throw new HostMaintenanceError('Wave size must be an integer between 1 and 10', 'INVALID_MAINTENANCE_WAVE');
  }
  if (!['block', 'defer'].includes(nonMigratablePolicy)) {
    throw new HostMaintenanceError('Non-migratable policy must be block or defer', 'INVALID_MAINTENANCE_POLICY');
  }
  return { sourceHostId, goal, waveSize, nonMigratablePolicy };
}

function _semanticPlan(plan) {
  return {
    schemaVersion: plan.schemaVersion, provider: plan.provider, sourceHost: plan.sourceHost,
    goal: plan.goal, waveSize: plan.waveSize, nonMigratablePolicy: plan.nonMigratablePolicy,
    capability: plan.capability, inventoryCount: plan.inventoryCount,
    items: plan.items.map(item => ({
      sequence: item.sequence, vm: item.vm, target: item.target, mode: item.mode,
      state: item.state, blockers: item.blockers,
    })),
    blockers: plan.blockers, warnings: plan.warnings, validUntil: plan.validUntil,
  };
}

function _event(database, runId, type, fields = {}) {
  const safeDetails = fields.details && typeof fields.details === 'object'
    ? JSON.stringify(Object.fromEntries(Object.entries(fields.details).slice(0, 32)
      .filter(([key]) => /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key)))) : null;
  database.prepare(`INSERT INTO provider_host_maintenance_events
    (run_id, event_type, state, phase, message, details_json) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(runId, _text(type, 80), _text(fields.state, 40), _text(fields.phase, 80), _text(fields.message, 240), safeDetails);
}

async function _mapLimit(values, limit, fn) {
  const output = new Array(values.length); let next = 0;
  async function worker() {
    while (next < values.length) { const index = next++; output[index] = await fn(values[index], index); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return output;
}

function reservedHostIds(database, options = {}) {
  try {
    const exceptRunId = options.exceptRunId || null;
    return new Set(database.prepare(`SELECT source_host_id FROM provider_host_maintenance_runs
      WHERE state IN (${ACTIVE_STATES.map(() => '?').join(',')}) AND (? IS NULL OR id != ?)`)
      .all(...ACTIVE_STATES, exceptRunId, exceptRunId).map(row => row.source_host_id));
  } catch { return new Set(); }
}

function _modeFor(vm, candidate) {
  const preferred = vm.status?.powerState === 'running' ? 'live'
    : (vm.status?.powerState === 'stopped' ? 'cold' : null);
  if (!preferred || candidate?.modes?.[preferred]?.state !== 'ready') return null;
  return preferred;
}

async function preflightForHost(host, value = {}, options = {}) {
  if (!host || !Number.isInteger(Number(host.id))) throw new HostMaintenanceError('Provider endpoint was not found', 'INVALID_OPERATION_HOST', 404);
  const input = _input(value); const database = _database(options);
  const registry = options.registry || registrySingleton;
  const migrationPreflight = options.migrationPreflight || migrationPreflightSingleton;
  const enabled = options.enabled === undefined
    ? (config.features.providerHostMaintenance && config.features.providerVmMigration)
    : options.enabled === true;
  const [capabilities, hostEnvelope, vmEnvelope] = await Promise.all([
    registry.capabilitiesForHost(host),
    registry.resourcesForHost(host, 'hosts', { limit: 64, database }),
    registry.resourcesForHost(host, 'virtual-machines', { limit: 500, database }),
  ]);
  const source = hostEnvelope.items.find(item => item.id === input.sourceHostId);
  if (!source || source.identity?.stability === 'transient') {
    throw new HostMaintenanceError('Stable source host was not found in this endpoint', 'PROVIDER_HOST_NOT_FOUND', 404);
  }
  const capability = capabilities.features?.['host.maintenance'] || { state: 'unknown', reason: 'No capability evidence' };
  const blockers = []; const warnings = [];
  if (!['supported', 'conditional'].includes(capability.state)) {
    blockers.push({ type: 'MAINTENANCE_UNSUPPORTED', reason: capability.reason || 'Host maintenance is unavailable', source: 'provider' });
  }
  const goals = capability.constraints?.goals || [];
  if (input.goal === 'enter' && !goals.includes('enter')) {
    blockers.push({ type: 'NATIVE_MAINTENANCE_UNAVAILABLE', reason: 'This provider supports controlled drain but not native maintenance activation', source: 'provider' });
  }
  if (host.daemon_type === 'proxmox' && input.goal === 'drain') warnings.push({
    type: 'LOCAL_RESERVATION_ONLY',
    reason: 'The drained host is excluded from Docker Dash placement; external Proxmox schedulers are outside this reservation', source: 'provider',
  });
  if (!enabled) blockers.push({ type: 'RELEASE_DISABLED', reason: 'Host maintenance and VM migration release flags must both be enabled', source: 'release' });
  if (options.canOperate !== true) blockers.push({ type: 'PERMISSION_DENIED', reason: 'Administrator authorization is required', source: 'rbac' });
  if (source.status?.powerState !== 'running' || source.status?.enabled === false) {
    blockers.push({ type: 'SOURCE_HOST_UNAVAILABLE', reason: 'Source host must be online and enabled before a new drain', source: 'common' });
  }
  if (vmEnvelope.totalObserved > MAX_VMS) {
    blockers.push({ type: 'BLAST_RADIUS_LIMIT', reason: `Host maintenance is limited to ${MAX_VMS} managed VMs per endpoint`, source: 'common' });
  }
  const reserved = reservedHostIds(database);
  if (reserved.has(input.sourceHostId)) blockers.push({ type: 'ACTIVE_MAINTENANCE_RUN', reason: 'This host already has an active maintenance reservation', source: 'common' });

  const budgets = new Map();
  const placementUnknown = [];
  const orderedVms = vmEnvelope.items.slice(0, MAX_VMS)
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));
  // Provider evidence collection is bounded but independent. Placement remains
  // a deterministic ordered pass because it mutates aggregate target budgets.
  const evidenceRows = await _mapLimit(orderedVms, 2, async vm => {
    let evidence;
    try {
      evidence = await migrationPreflight.preflightForHost(host, vm.id, {
        database, registry, executionEnabled: enabled,
      });
    } catch (err) {
      return { vm, evidence: null };
    }
    return { vm, evidence };
  });
  const evaluated = evidenceRows.map(({ vm, evidence }) => {
    if (!evidence) { placementUnknown.push(vm.displayName); return null; }
    if (!evidence.sourceTargetId) { placementUnknown.push(vm.displayName); return null; }
    if (evidence.sourceTargetId !== input.sourceHostId) return null;
    const candidates = evidence.candidates.filter(candidate => candidate.target.id !== input.sourceHostId
      && !reserved.has(candidate.target.id)).map(candidate => ({ candidate, mode: _modeFor(vm, candidate) }))
      .filter(item => item.mode);
    const reserve = Math.ceil(Number(vm.spec?.memoryBytes || 0) * 1.1);
    for (const { candidate } of candidates) {
      const targetId = candidate.target.id;
      if (!budgets.has(targetId)) budgets.set(targetId, candidate.target.capacity?.targetFreeMemoryBytes ?? null);
    }
    const eligible = candidates.filter(({ candidate }) => {
      const remaining = budgets.get(candidate.target.id);
      return remaining === null || !reserve || remaining >= reserve;
    }).sort((a, b) => {
      const score = b.candidate.score - a.candidate.score;
      if (score) return score;
      return Number(budgets.get(b.candidate.target.id) || 0) - Number(budgets.get(a.candidate.target.id) || 0);
    });
    const chosen = eligible[0] || null;
    if (chosen && reserve && budgets.get(chosen.candidate.target.id) !== null) {
      budgets.set(chosen.candidate.target.id, Math.max(0, budgets.get(chosen.candidate.target.id) - reserve));
    }
    const reasons = chosen ? [] : evidence.candidates.flatMap(candidate => {
      const preferred = vm.status?.powerState === 'running' ? 'live' : 'cold';
      return (candidate.modes?.[preferred]?.blockers || []).map(item => item.reason);
    }).filter(Boolean).slice(0, 4);
    return {
      vm: { id: vm.id, displayName: vm.displayName, powerState: vm.status?.powerState || 'unknown', memoryBytes: vm.spec?.memoryBytes || null },
      target: chosen ? { id: chosen.candidate.target.id, displayName: chosen.candidate.target.displayName } : null,
      mode: chosen?.mode || null, state: chosen ? 'ready' : 'deferred',
      blockers: chosen ? [] : [{
        type: 'NON_MIGRATABLE_WORKLOAD',
        reason: reasons[0] || 'No target has a ready migration mode and remaining planned capacity', source: 'migration-preflight',
      }],
    };
  });
  const items = evaluated.filter(Boolean).sort((a, b) => a.vm.displayName.localeCompare(b.vm.displayName) || a.vm.id.localeCompare(b.vm.id))
    .map((item, sequence) => ({ ...item, sequence, wave: Math.floor(sequence / input.waveSize) + 1 }));
  const deferred = items.filter(item => item.state === 'deferred');
  if (placementUnknown.length) blockers.push({
    type: 'SOURCE_PLACEMENT_UNKNOWN',
    reason: `Placement could not be proven for ${placementUnknown.length} VM(s); the host cannot be declared empty`, source: 'provider',
  });
  if (deferred.length && input.nonMigratablePolicy === 'block') blockers.push({
    type: 'NON_MIGRATABLE_WORKLOADS', reason: `${deferred.length} workload(s) have no safe destination`, source: 'common',
  });
  if (deferred.length && input.nonMigratablePolicy === 'defer') warnings.push({
    type: 'DEFERRED_WORKLOADS', reason: `${deferred.length} workload(s) will remain and automatically pause the run`, source: 'common',
  });
  if (!items.length) warnings.push({ type: 'HOST_ALREADY_EMPTY', reason: 'No managed VM is currently assigned to the source host', source: 'common' });
  const validUntil = new Date((Math.floor(Date.now() / PLAN_TTL_MS) + 1) * PLAN_TTL_MS).toISOString();
  const plan = {
    schemaVersion: '1.0', generatedAt: _now(), validUntil,
    provider: { type: host.daemon_type, endpointId: Number(host.id), endpointName: _text(host.name, 160) },
    sourceHost: { id: source.id, displayName: source.displayName, status: source.status },
    goal: input.goal, waveSize: input.waveSize, nonMigratablePolicy: input.nonMigratablePolicy,
    capability, inventoryCount: vmEnvelope.totalObserved,
    itemCount: items.length, readyCount: items.length - deferred.length, deferredCount: deferred.length,
    items, blockers, warnings, allowed: blockers.length === 0,
    confirmation: { required: true, mode: 'typed_name', expected: source.displayName },
    execution: { enabled, durable: true, pauseResume: true, childType: 'vm.migrate' },
  };
  plan.planHash = sha256(JSON.stringify(_semanticPlan(plan)));
  return plan;
}

function _assertSubmission(plan, input) {
  if (!plan.allowed) throw new HostMaintenanceError('Host maintenance preflight is blocked', 'HOST_MAINTENANCE_PREFLIGHT_BLOCKED', 409, plan.blockers);
  if (String(input.planHash || '') !== plan.planHash) {
    throw new HostMaintenanceError('Host maintenance plan changed; review the new plan', 'HOST_MAINTENANCE_PREFLIGHT_STALE', 409);
  }
  if (Date.parse(plan.validUntil) <= Date.now()) {
    throw new HostMaintenanceError('Host maintenance plan expired', 'HOST_MAINTENANCE_PREFLIGHT_STALE', 409);
  }
  if (input.confirm !== true || input.confirmName !== plan.sourceHost.displayName) {
    throw new HostMaintenanceError('Host maintenance requires the exact source host name', 'HOST_MAINTENANCE_TYPED_CONFIRMATION_REQUIRED');
  }
  const key = String(input.idempotencyKey || '');
  if (!/^[\x21-\x7e]{8,200}$/.test(key)) {
    throw new HostMaintenanceError('Idempotency key must contain 8-200 visible ASCII characters', 'INVALID_IDEMPOTENCY_KEY');
  }
}

async function submitForHost(host, value = {}, options = {}) {
  const input = _input(value); const database = _database(options);
  const key = String(value.idempotencyKey || '');
  if (!/^[\x21-\x7e]{8,200}$/.test(key)) {
    throw new HostMaintenanceError('Idempotency key must contain 8-200 visible ASCII characters', 'INVALID_IDEMPOTENCY_KEY');
  }
  const requestHash = sha256(`${Number(host.id)}|host.maintenance|${value.idempotencyKey}`);
  const existing = database.prepare(`SELECT id, plan_hash FROM provider_host_maintenance_runs
    WHERE host_id = ? AND idempotency_key_hash = ?`).get(Number(host.id), requestHash);
  if (existing) {
    if (existing.plan_hash !== String(value.planHash || '')) throw new HostMaintenanceError('Idempotency key was used for a different maintenance plan', 'IDEMPOTENCY_KEY_CONFLICT', 409);
    const stored = database.prepare('SELECT plan_enc FROM provider_host_maintenance_runs WHERE id = ?').get(existing.id);
    const plan = JSON.parse(decrypt(stored.plan_enc));
    if (value.confirm !== true || value.confirmName !== plan.sourceHost.displayName) {
      throw new HostMaintenanceError('Host maintenance requires the exact source host name', 'HOST_MAINTENANCE_TYPED_CONFIRMATION_REQUIRED');
    }
    return { plan, run: get(existing.id, { database }), deduplicated: true };
  }
  const plan = await preflightForHost(host, input, { ...options, database });
  _assertSubmission(plan, value);
  const runId = `hmr_${generateToken(16).slice(0, 26)}`;
  try {
    database.transaction(() => {
      database.prepare(`INSERT INTO provider_host_maintenance_runs
        (id, host_id, provider_type, source_host_id, source_host_name, goal, wave_size,
         non_migratable_policy, plan_hash, plan_enc, idempotency_key_hash, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(runId, Number(host.id), host.daemon_type, plan.sourceHost.id, plan.sourceHost.displayName,
          plan.goal, plan.waveSize, plan.nonMigratablePolicy, plan.planHash,
          encrypt(JSON.stringify(plan)), requestHash, options.createdBy || null);
      const insert = database.prepare(`INSERT INTO provider_host_maintenance_items
        (run_id, sequence, wave_number, vm_id, vm_name, source_host_id,
         target_host_id, target_host_name, mode, state, error_code, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const item of plan.items) insert.run(
        runId, item.sequence, item.wave, item.vm.id, item.vm.displayName, plan.sourceHost.id,
        item.target?.id || null, item.target?.displayName || null, item.mode,
        item.state === 'ready' ? 'pending' : 'deferred',
        item.state === 'ready' ? null : item.blockers?.[0]?.type,
        item.state === 'ready' ? null : item.blockers?.[0]?.reason
      );
      _event(database, runId, 'created', { state: 'queued', phase: 'approved', message: 'Host maintenance run queued', details: {
        goal: plan.goal, waveSize: plan.waveSize, itemCount: plan.itemCount, deferredCount: plan.deferredCount,
      } });
    })();
  } catch (err) {
    if (String(err?.code || '').startsWith('SQLITE_CONSTRAINT')) {
      throw new HostMaintenanceError('The source host already has an active maintenance run', 'ACTIVE_MAINTENANCE_RUN', 409);
    }
    throw err;
  }
  try { await reconcileRun(runId, { ...options, database }); }
  catch (err) { log.warn('Initial host maintenance dispatch was deferred', { runId, code: err.code || 'ERROR' }); }
  return { plan, run: get(runId, { database }), deduplicated: false };
}

function _item(row) {
  return {
    sequence: Number(row.sequence), wave: Number(row.wave_number),
    vm: { id: row.vm_id, displayName: row.vm_name },
    sourceHostId: row.source_host_id,
    target: row.target_host_id ? { id: row.target_host_id, displayName: row.target_host_name } : null,
    mode: row.mode || null, state: row.state, operationId: row.operation_id || null,
    error: row.error_code ? { code: row.error_code, message: row.error_message || null } : null,
    startedAt: row.started_at || null, completedAt: row.completed_at || null, updatedAt: row.updated_at,
  };
}

function _publicRun(row, database, includeEvents = true) {
  if (!row) return null;
  const items = database.prepare(`SELECT * FROM provider_host_maintenance_items
    WHERE run_id = ? ORDER BY sequence`).all(row.id).map(_item);
  const counts = Object.fromEntries(['pending', 'submitted', 'succeeded', 'deferred', 'failed', 'cancelled', 'unknown']
    .map(state => [state, items.filter(item => item.state === state).length]));
  const events = includeEvents ? database.prepare(`SELECT id, event_type, state, phase, message, details_json, created_at
    FROM provider_host_maintenance_events WHERE run_id = ? ORDER BY id DESC LIMIT 200`).all(row.id).reverse().map(event => ({
    id: event.id, type: event.event_type, state: event.state, phase: event.phase,
    message: event.message, details: _json(event.details_json, null), createdAt: event.created_at,
  })) : undefined;
  return {
    schemaVersion: row.schema_version, id: row.id,
    provider: { type: row.provider_type, endpointId: Number(row.host_id) },
    sourceHost: { id: row.source_host_id, displayName: row.source_host_name },
    goal: row.goal, state: row.state, phase: row.phase || null,
    waveSize: Number(row.wave_size), nonMigratablePolicy: row.non_migratable_policy,
    planHash: row.plan_hash, hasNativeTask: !!row.native_task_ref_enc,
    nativeTaskState: row.native_task_state || null, counts, items,
    error: row.error_code ? { code: row.error_code, message: row.error_message || null } : null,
    permissions: {
      canPause: ['queued', 'preparing', 'draining'].includes(row.state),
      canResume: row.state === 'paused',
      canCancel: ['queued', 'preparing', 'draining', 'paused'].includes(row.state),
      canExit: ['drained', 'maintenance'].includes(row.state),
      canReconcile: row.state === 'unknown',
    },
    createdBy: row.created_by || null, createdAt: row.created_at,
    startedAt: row.started_at || null, completedAt: row.completed_at || null, updatedAt: row.updated_at,
    ...(includeEvents ? { events } : {}),
  };
}

function get(runIdInput, options = {}) {
  const runId = String(runIdInput || ''); const database = _database(options);
  if (!SAFE_RUN_ID.test(runId)) return null;
  return _publicRun(database.prepare('SELECT * FROM provider_host_maintenance_runs WHERE id = ?').get(runId), database, options.includeEvents !== false);
}

function listForHost(hostIdInput, options = {}) {
  const hostId = Number(hostIdInput); const database = _database(options);
  const limit = Math.min(200, Math.max(1, Number(options.limit) || 50));
  if (!Number.isInteger(hostId) || hostId <= 0) return [];
  return database.prepare(`SELECT * FROM provider_host_maintenance_runs
    WHERE host_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(hostId, limit)
    .map(row => _publicRun(row, database, false));
}

function _row(runId, database) {
  const row = database.prepare('SELECT * FROM provider_host_maintenance_runs WHERE id = ?').get(runId);
  if (!row) throw new HostMaintenanceError('Host maintenance run was not found', 'HOST_MAINTENANCE_RUN_NOT_FOUND', 404);
  return row;
}

function pause(runIdInput, options = {}) {
  const database = _database(options); const row = _row(String(runIdInput), database);
  if (!['queued', 'preparing', 'draining'].includes(row.state)) throw new HostMaintenanceError('This run cannot be paused in its current state', 'INVALID_MAINTENANCE_STATE', 409);
  database.prepare(`UPDATE provider_host_maintenance_runs SET state = 'paused', phase = 'operator-paused',
    pause_requested_at = datetime('now'), lease_owner = NULL, lease_expires_at = NULL, updated_at = datetime('now') WHERE id = ?`).run(row.id);
  _event(database, row.id, 'paused', { state: 'paused', phase: 'operator-paused', message: 'Run paused by administrator' });
  return get(row.id, { database });
}

function resume(runIdInput, options = {}) {
  const database = _database(options); const row = _row(String(runIdInput), database);
  if (row.state !== 'paused') throw new HostMaintenanceError('Only a paused run can be resumed', 'INVALID_MAINTENANCE_STATE', 409);
  const operations = options.operations || operationsSingleton;
  const attention = database.prepare(`SELECT * FROM provider_host_maintenance_items
    WHERE run_id = ? AND state IN ('failed', 'cancelled', 'unknown') ORDER BY sequence`).all(row.id);
  for (const item of attention) {
    const operation = item.operation_id ? operations.get(item.operation_id) : null;
    if (item.state === 'unknown' && operation?.state === 'succeeded') {
      database.prepare(`UPDATE provider_host_maintenance_items SET state = 'succeeded', error_code = NULL,
        error_message = NULL, completed_at = COALESCE(completed_at, datetime('now')),
        updated_at = datetime('now') WHERE id = ?`).run(item.id);
      continue;
    }
    throw new HostMaintenanceError(`Child migration for ${item.vm_name} still requires resolution`,
      'CHILD_OPERATION_UNRESOLVED', 409, { operationId: item.operation_id, state: item.state });
  }
  const nativePreparing = !!row.native_task_ref_enc;
  database.prepare(`UPDATE provider_host_maintenance_runs SET state = ?, phase = ?, pause_requested_at = NULL,
    error_code = NULL, error_message = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = datetime('now') WHERE id = ?`)
    .run(nativePreparing ? 'preparing' : 'draining', nativePreparing ? 'preparing' : 'draining', row.id);
  database.prepare(`UPDATE provider_host_maintenance_items SET state = 'pending', error_code = NULL,
    error_message = NULL, updated_at = datetime('now') WHERE run_id = ? AND state = 'deferred' AND target_host_id IS NOT NULL`).run(row.id);
  _event(database, row.id, 'resumed', { state: nativePreparing ? 'preparing' : 'draining', phase: 'operator-resumed', message: 'Run resumed by administrator' });
  return get(row.id, { database });
}

async function reconcileUnknown(runIdInput, options = {}) {
  const database = _database(options); const row = _row(String(runIdInput), database);
  if (row.state !== 'unknown') throw new HostMaintenanceError('Only an unknown run can be explicitly reconciled', 'INVALID_MAINTENANCE_STATE', 409);
  if (!row.native_task_ref_enc) {
    database.prepare(`UPDATE provider_host_maintenance_runs SET state = 'paused', phase = 'manual-reconcile',
      error_code = NULL, error_message = NULL, lease_owner = NULL, lease_expires_at = NULL,
      updated_at = datetime('now') WHERE id = ?`).run(row.id);
    _event(database, row.id, 'reconcile_requested', { state: 'paused', phase: 'manual-reconcile', message: 'Run moved to paused for child evidence resolution' });
    return get(row.id, { database });
  }
  let action;
  try { action = JSON.parse(decrypt(row.native_task_ref_enc)).action; } catch { action = null; }
  const next = { disable: 'preparing', enter: 'entering', exit: 'exiting' }[action];
  if (!next) throw new HostMaintenanceError('Native task evidence is invalid', 'PROVIDER_TASK_UNAVAILABLE', 502);
  database.prepare(`UPDATE provider_host_maintenance_runs SET state = ?, phase = ?, error_code = NULL,
    error_message = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = datetime('now') WHERE id = ?`)
    .run(next, `manual-${action}-reconcile`, row.id);
  _event(database, row.id, 'reconcile_requested', { state: next, phase: `manual-${action}-reconcile`, message: 'Existing native task reconciliation requested; no mutation was replayed' });
  return reconcileRun(row.id, { ...options, database });
}

async function cancel(runIdInput, options = {}) {
  const database = _database(options); const row = _row(String(runIdInput), database);
  if (!['queued', 'preparing', 'draining', 'paused'].includes(row.state)) {
    throw new HostMaintenanceError('This run requires explicit exit and cannot be cancelled', 'INVALID_MAINTENANCE_STATE', 409);
  }
  database.prepare(`UPDATE provider_host_maintenance_runs SET cancel_requested_at = datetime('now'),
    state = CASE WHEN state = 'paused' THEN 'draining' ELSE state END,
    updated_at = datetime('now') WHERE id = ?`).run(row.id);
  _event(database, row.id, 'cancel_requested', { state: row.state, phase: 'cancel', message: 'Cancellation requested; completed migrations are not rolled back' });
  try { await reconcileRun(row.id, { ...options, database }); } catch { /* durable state remains queued */ }
  return get(row.id, { database });
}

async function exit(runIdInput, options = {}) {
  const database = _database(options); const row = _row(String(runIdInput), database);
  if (!['drained', 'maintenance'].includes(row.state)) throw new HostMaintenanceError('Only a drained or maintenance host can exit', 'INVALID_MAINTENANCE_STATE', 409);
  database.prepare(`UPDATE provider_host_maintenance_runs SET state = 'exiting', phase = 'native-exit',
    native_task_ref_hash = NULL, native_task_ref_enc = NULL, native_task_state = NULL,
    lease_owner = NULL, lease_expires_at = NULL, updated_at = datetime('now') WHERE id = ?`).run(row.id);
  _event(database, row.id, 'exit_requested', { state: 'exiting', phase: 'native-exit', message: 'Maintenance exit requested' });
  try { await reconcileRun(row.id, { ...options, database }); } catch { /* next worker pass retries only pre-submission */ }
  return get(row.id, { database });
}

function _claim(runId, database, options) {
  const leaseMs = Number(options.leaseMs || config.providerHostMaintenance.leaseMs);
  const result = database.prepare(`UPDATE provider_host_maintenance_runs SET lease_owner = ?, lease_expires_at = ?,
    started_at = COALESCE(started_at, datetime('now')), updated_at = datetime('now')
    WHERE id = ? AND (lease_owner IS NULL OR lease_expires_at <= ? OR lease_owner = ?)`)
    .run(WORKER_OWNER, _future(leaseMs), runId, _now(), WORKER_OWNER);
  return result.changes === 1;
}

function _release(runId, database) {
  database.prepare(`UPDATE provider_host_maintenance_runs SET lease_owner = NULL, lease_expires_at = NULL,
    updated_at = datetime('now') WHERE id = ? AND lease_owner = ?`).run(runId, WORKER_OWNER);
}

function _transition(database, runId, state, phase, message, error = null) {
  const terminal = ['completed', 'failed', 'cancelled'].includes(state);
  database.prepare(`UPDATE provider_host_maintenance_runs SET state = ?, phase = ?, error_code = ?, error_message = ?,
    completed_at = CASE WHEN ? THEN datetime('now') ELSE completed_at END, updated_at = datetime('now') WHERE id = ?`)
    .run(state, phase, error?.code || null, _text(error?.message, 240), terminal ? 1 : 0, runId);
  _event(database, runId, 'state', { state, phase, message, details: error ? { code: error.code } : null });
}

function _bindNative(database, runId, taskValue, state, phase) {
  database.prepare(`UPDATE provider_host_maintenance_runs SET state = ?, phase = ?, native_task_ref_hash = ?,
    native_task_ref_enc = ?, native_task_state = 'pending', updated_at = datetime('now') WHERE id = ?`)
    .run(state, phase, sha256(taskValue), encrypt(taskValue), runId);
  _event(database, runId, 'native_task', { state, phase, message: 'Native provider task bound to maintenance run' });
}

async function _reconcileNative(row, target, native, database) {
  const raw = row.native_task_ref_enc ? decrypt(row.native_task_ref_enc) : null;
  const task = native.parseTask(raw, row.provider_type);
  if (!task) throw new HostMaintenanceError('Native maintenance task reference is missing', 'PROVIDER_TASK_UNAVAILABLE', 502);
  const outcome = native.taskOutcome(await native.taskStatus(target, task));
  if (outcome.failed) throw new HostMaintenanceError(outcome.message, 'PROVIDER_TASK_FAILED', 502);
  if (outcome.pending) {
    database.prepare(`UPDATE provider_host_maintenance_runs SET native_task_state = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(_text(outcome.state, 80), row.id);
    return false;
  }
  database.prepare(`UPDATE provider_host_maintenance_runs SET native_task_state = 'succeeded',
    native_task_ref_hash = NULL, native_task_ref_enc = NULL, updated_at = datetime('now') WHERE id = ?`).run(row.id);
  return true;
}

async function _prepare(row, target, native, database) {
  const result = await native.prepare(target, row.goal, config.providerHostMaintenance.nativeTimeoutSeconds);
  if (!result || result.completed) {
    _transition(database, row.id, 'draining', 'draining', 'Source host preparation verified'); return;
  }
  const task = native.taskRef(target, result, 'disable');
  _bindNative(database, row.id, task, 'preparing', 'preparing');
}

function _reconcileChildren(row, database, operations) {
  const submitted = database.prepare(`SELECT * FROM provider_host_maintenance_items
    WHERE run_id = ? AND state = 'submitted' ORDER BY sequence`).all(row.id);
  let stop = null;
  for (const item of submitted) {
    const operation = operations.get(item.operation_id);
    if (!operation || !CHILD_TERMINAL.has(operation.state)) continue;
    const next = operation.state === 'succeeded' ? 'succeeded'
      : (operation.state === 'cancelled' ? 'cancelled' : operation.state);
    database.prepare(`UPDATE provider_host_maintenance_items SET state = ?, error_code = ?, error_message = ?,
      completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
      .run(next, operation.error?.code || (next === 'unknown' ? 'CHILD_OPERATION_UNKNOWN' : null),
        _text(operation.error?.message || (next === 'unknown' ? 'Child migration requires manual resolution' : null), 240), item.id);
    _event(database, row.id, 'child_terminal', { state: row.state, phase: 'draining', message: `Migration for ${item.vm_name} is ${next}`, details: { vmId: item.vm_id, operationId: item.operation_id, childState: next } });
    if (next !== 'succeeded') stop = { code: `CHILD_MIGRATION_${next.toUpperCase()}`, message: `Migration for ${item.vm_name} is ${next}` };
  }
  return stop;
}

async function _dispatch(row, host, database, options) {
  const operations = options.operations || operationsSingleton;
  const migration = options.vmMigration || vmMigrationSingleton;
  const stop = _reconcileChildren(row, database, operations);
  if (stop) { _transition(database, row.id, 'paused', 'child-attention', 'Run auto-paused for child operation attention', stop); return; }
  const active = database.prepare(`SELECT COUNT(*) AS count FROM provider_host_maintenance_items
    WHERE run_id = ? AND state = 'submitted'`).get(row.id).count;
  if (row.cancel_requested_at) {
    const children = database.prepare(`SELECT operation_id FROM provider_host_maintenance_items
      WHERE run_id = ? AND state = 'submitted' AND operation_id IS NOT NULL`).all(row.id);
    for (const child of children) { try { operations.requestCancel(child.operation_id); } catch { /* already terminal */ } }
    if (active > 0) return;
    database.prepare(`UPDATE provider_host_maintenance_items SET state = 'cancelled', completed_at = datetime('now'),
      updated_at = datetime('now') WHERE run_id = ? AND state IN ('pending', 'deferred')`).run(row.id);
    if (row.provider_type === 'xen') {
      database.prepare(`UPDATE provider_host_maintenance_runs SET state = 'exiting', phase = 'cancel-exit',
        native_task_ref_hash = NULL, native_task_ref_enc = NULL, native_task_state = NULL,
        updated_at = datetime('now') WHERE id = ?`).run(row.id);
    } else _transition(database, row.id, 'cancelled', 'cancelled', 'Run cancelled; completed migrations were not rolled back');
    return;
  }
  const available = Math.max(0, Number(row.wave_size) - Number(active));
  if (available > 0) {
    const pending = database.prepare(`SELECT * FROM provider_host_maintenance_items
      WHERE run_id = ? AND state = 'pending' ORDER BY sequence LIMIT ?`).all(row.id, available);
    for (const item of pending) {
      const current = database.prepare(`SELECT state, pause_requested_at, cancel_requested_at
        FROM provider_host_maintenance_runs WHERE id = ?`).get(row.id);
      if (!current || current.state !== 'draining' || current.pause_requested_at || current.cancel_requested_at) return;
      try {
        const plan = await migration.preflightForHost(host, item.vm_id, {
          targetId: item.target_host_id, mode: item.mode,
        }, { database, canOperate: true, enabled: true, operations });
        if (plan.sourceTargetId !== row.source_host_id) {
          database.prepare(`UPDATE provider_host_maintenance_items SET state = 'succeeded',
            completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(item.id);
          _event(database, row.id, 'child_reconciled', { state: 'draining', phase: 'draining', message: `${item.vm_name} is already off the source host`, details: { vmId: item.vm_id } });
          continue;
        }
        const approved = database.prepare(`SELECT state, pause_requested_at, cancel_requested_at
          FROM provider_host_maintenance_runs WHERE id = ?`).get(row.id);
        if (!approved || approved.state !== 'draining' || approved.pause_requested_at || approved.cancel_requested_at) return;
        const result = await migration.submitForHost(host, item.vm_id, {
          targetId: item.target_host_id, mode: item.mode,
          planHash: plan.planHash, confirm: true, confirmName: plan.vm.displayName,
          idempotencyKey: `maintenance:${row.id}:${item.vm_id}`,
        }, { database, canOperate: true, enabled: true, createdBy: row.created_by, operations });
        database.prepare(`UPDATE provider_host_maintenance_items SET state = 'submitted', operation_id = ?,
          started_at = COALESCE(started_at, datetime('now')), updated_at = datetime('now') WHERE id = ?`)
          .run(result.operation.id, item.id);
        _event(database, row.id, 'child_submitted', { state: 'draining', phase: 'draining', message: `Migration queued for ${item.vm_name}`, details: { vmId: item.vm_id, operationId: result.operation.id, wave: item.wave_number } });
      } catch (err) {
        database.prepare(`UPDATE provider_host_maintenance_items SET state = 'deferred', error_code = ?,
          error_message = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(_text(err.code || 'CHILD_PREFLIGHT_BLOCKED', 80), _text(err.message, 240), item.id);
        _transition(database, row.id, 'paused', 'revalidation-blocked', 'Run auto-paused because a child preflight changed', {
          code: err.code || 'CHILD_PREFLIGHT_BLOCKED', message: err.message,
        });
        return;
      }
    }
  }
  const remaining = database.prepare(`SELECT state, COUNT(*) AS count FROM provider_host_maintenance_items
    WHERE run_id = ? AND state != 'succeeded' GROUP BY state`).all(row.id);
  if (remaining.some(item => item.state === 'submitted' || item.state === 'pending')) return;
  if (remaining.length) {
    _transition(database, row.id, 'paused', 'deferred-workloads', 'Run paused with non-migratable workloads', {
      code: 'NON_MIGRATABLE_WORKLOADS', message: 'One or more workloads still require an operator decision',
    });
    return;
  }
  const native = options.native || nativeSingleton;
  const target = await native.open(host, row.source_host_id, database);
  try {
    const remainingWorkloads = await native.workloads(target);
    if (remainingWorkloads.length) {
      _transition(database, row.id, 'paused', 'post-check', 'Source host is not empty after planned migrations', {
        code: 'HOST_NOT_EMPTY', message: `${remainingWorkloads.length} workload(s) remain on the source host`,
      });
      return;
    }
    if (row.goal === 'drain') {
      _transition(database, row.id, 'drained', 'post-check', 'Source host is empty and remains reserved'); return;
    }
    const result = await native.enter(target, config.providerHostMaintenance.nativeTimeoutSeconds);
    if (result.completed) {
      const state = await native.hostState(target);
      if (!state.maintenance) throw new HostMaintenanceError('Provider did not report maintenance state', 'HOST_MAINTENANCE_POSTCHECK_FAILED', 502);
      _transition(database, row.id, 'maintenance', 'post-check', 'Source host entered native maintenance mode');
    } else _bindNative(database, row.id, native.taskRef(target, result, 'enter'), 'entering', 'native-enter');
  } finally { await native.close(target); }
}

async function _entering(row, host, target, native, database) {
  if (!await _reconcileNative(row, target, native, database)) return;
  const [state, remaining] = await Promise.all([native.hostState(target), native.workloads(target)]);
  if (!state.maintenance || remaining.length) {
    _transition(database, row.id, 'unknown', 'post-check', 'Native task completed but maintenance state could not be proven', {
      code: 'HOST_MAINTENANCE_POSTCHECK_FAILED', message: 'Provider state or source placement contradicts the completed task',
    });
    return;
  }
  _transition(database, row.id, 'maintenance', 'post-check', 'Source host entered native maintenance mode');
}

async function _exiting(row, target, native, database) {
  if (row.native_task_ref_enc) {
    if (!await _reconcileNative(row, target, native, database)) return;
  } else {
    const result = await native.exit(target, config.providerHostMaintenance.nativeTimeoutSeconds);
    if (!result.completed) {
      _bindNative(database, row.id, native.taskRef(target, result, 'exit'), 'exiting', row.phase || 'native-exit'); return;
    }
  }
  const state = await native.hostState(target);
  if (row.provider_type !== 'proxmox' && state.maintenance) {
    _transition(database, row.id, 'unknown', 'exit-post-check', 'Native exit task completed but host still reports maintenance', {
      code: 'HOST_MAINTENANCE_EXIT_POSTCHECK_FAILED', message: 'Host still reports maintenance state',
    });
    return;
  }
  _transition(database, row.id, row.cancel_requested_at ? 'cancelled' : 'completed', 'exit-post-check',
    row.cancel_requested_at ? 'Run cancelled and native placement exclusion removed' : 'Host exited maintenance and local reservation was released');
}

async function reconcileRun(runIdInput, options = {}) {
  const runId = String(runIdInput || ''); const database = _database(options);
  if (!SAFE_RUN_ID.test(runId)) throw new HostMaintenanceError('Host maintenance run was not found', 'HOST_MAINTENANCE_RUN_NOT_FOUND', 404);
  let row = _row(runId, database);
  if (!DUE_STATES.includes(row.state)) return get(runId, { database });
  if (!_claim(runId, database, options)) return get(runId, { database });
  const native = options.native || nativeSingleton;
  let target = null;
  try {
    row = _row(runId, database);
    const host = database.prepare('SELECT * FROM docker_hosts WHERE id = ? AND is_active = 1').get(row.host_id);
    if (!host) throw new HostMaintenanceError('Provider endpoint is unavailable', 'INVALID_OPERATION_HOST', 404);
    if (row.state === 'queued') {
      target = await native.open(host, row.source_host_id, database);
      await _prepare(row, target, native, database);
    } else if (row.state === 'preparing') {
      target = await native.open(host, row.source_host_id, database);
      if (await _reconcileNative(row, target, native, database)) {
        _transition(database, row.id, 'draining', 'draining', 'Source host placement was disabled');
      }
    } else if (row.state === 'draining') await _dispatch(row, host, database, options);
    else if (row.state === 'entering') {
      target = await native.open(host, row.source_host_id, database);
      await _entering(row, host, target, native, database);
    } else if (row.state === 'exiting') {
      target = await native.open(host, row.source_host_id, database);
      await _exiting(row, target, native, database);
    }
  } catch (err) {
    const current = _row(runId, database);
    const uncertain = current.native_task_ref_enc && /TIMEOUT|CONNECTION|UNREACHABLE|TASK_UNAVAILABLE/i.test(String(err.code || err.message));
    _transition(database, runId, uncertain ? 'unknown' : 'failed', current.phase || 'worker',
      uncertain ? 'Maintenance outcome requires manual reconciliation' : 'Maintenance run failed', {
        code: err.code || 'HOST_MAINTENANCE_WORKER_FAILED', message: err.message,
      });
  } finally {
    if (target) await native.close(target);
    _release(runId, database);
  }
  return get(runId, { database });
}

async function runDue(options = {}) {
  const database = _database(options);
  const limit = Math.min(100, Math.max(1, Number(options.limit) || config.providerHostMaintenance.pollLimit));
  const rows = database.prepare(`SELECT id FROM provider_host_maintenance_runs
    WHERE state IN (${DUE_STATES.map(() => '?').join(',')})
      AND (lease_owner IS NULL OR lease_expires_at <= ?)
    ORDER BY created_at LIMIT ?`).all(...DUE_STATES, _now(), limit);
  const results = [];
  for (const row of rows) {
    try { results.push(await reconcileRun(row.id, { ...options, database })); }
    catch (err) { log.error('Host maintenance reconciliation failed', { runId: row.id, code: err.code || 'ERROR' }); }
  }
  return results;
}

module.exports = {
  HostMaintenanceError, preflightForHost, submitForHost, get, listForHost,
  pause, resume, cancel, exit, reconcileUnknown, reconcileRun, runDue, reservedHostIds,
  _internals: {
    _input, _semanticPlan, _assertSubmission, _modeFor, _mapLimit,
    _publicRun, _reconcileChildren, _claim, _transition,
  },
};
