'use strict';

const config = require('../../config');
const { getDb } = require('../../db');
const { generateToken, sha256 } = require('../../utils/crypto');
const log = require('../../utils/logger')('provider-backup-policies');
const audit = require('../audit');
const registrySingleton = require('../provider-sdk/registry');

const SCHEMA_VERSION = '1.0';
const SAFE_POLICY_ID = /^pbp_[a-f0-9]{26}$/;
const SAFE_RUN_ID = /^pbpr_[a-f0-9]{26}$/;
const SAFE_REPOSITORY_ID = /^ddr_repo_[a-f0-9]{26}$/;
const SAFE_WORKLOAD_ID = /^ddr_vm_[a-f0-9]{26}$/;
const SAFE_LABEL_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SAFE_KEY_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const FREQUENCIES = new Set(['hourly', 'daily', 'weekly', 'monthly']);
const POWER_STATES = new Set(['running', 'stopped', 'paused', 'suspended', 'unknown']);
const CONSISTENCY = new Set(['application', 'filesystem', 'crash']);
const REQUIREMENTS = new Set(['none', 'preferred', 'required']);
const MAX_POLICIES_PER_TICK = 20;

class BackupPolicyError extends Error {
  constructor(message, code = 'PROVIDER_BACKUP_POLICY_ERROR', status = 400, details = null) {
    super(message); this.name = 'BackupPolicyError'; this.code = code; this.status = status; this.details = details;
  }
}

function _database(options = {}) { return options.database || getDb(); }

function _text(value, max = 240) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function _parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function _integer(value, min, max, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new BackupPolicyError(`${label} must be an integer between ${min} and ${max}`, 'INVALID_BACKUP_POLICY');
  }
  return number;
}

function _nullableInteger(value, min, max, fallback, label) {
  if (value === null || value === '') return null;
  return _integer(value, min, max, fallback, label);
}

function _uniqueStrings(value, pattern, maxItems, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new BackupPolicyError(`${label} must contain at most ${maxItems} items`, 'INVALID_BACKUP_POLICY');
  }
  const output = [];
  for (const item of value) {
    const text = String(item || '');
    if (!pattern.test(text)) throw new BackupPolicyError(`${label} contains an invalid identifier`, 'INVALID_BACKUP_POLICY');
    if (!output.includes(text)) output.push(text);
  }
  return output.sort();
}

function _labels(value, label) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 16) {
    throw new BackupPolicyError(`${label} must contain at most 16 label predicates`, 'INVALID_BACKUP_POLICY');
  }
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!SAFE_LABEL_KEY.test(key)) throw new BackupPolicyError(`${label} contains an invalid label key`, 'INVALID_BACKUP_POLICY');
    const text = _text(raw, 240);
    if (!text) throw new BackupPolicyError(`${label} label values cannot be empty`, 'INVALID_BACKUP_POLICY');
    output[key] = text;
  }
  return Object.fromEntries(Object.entries(output).sort(([a], [b]) => a.localeCompare(b)));
}

function _timezone(value) {
  const zone = _text(value || 'UTC', 80);
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date()); }
  catch { throw new BackupPolicyError('Schedule timezone must be a valid IANA timezone', 'INVALID_BACKUP_POLICY'); }
  return zone;
}

function _schedule(input = {}, previous = {}) {
  const frequency = String(input.frequency ?? previous.frequency ?? 'daily');
  if (!FREQUENCIES.has(frequency)) throw new BackupPolicyError('Schedule frequency must be hourly, daily, weekly or monthly', 'INVALID_BACKUP_POLICY');
  const minute = _integer(input.minute, 0, 45, previous.minute ?? 15, 'Schedule minute');
  if (![0, 15, 30, 45].includes(minute)) throw new BackupPolicyError('Schedule minute must be 0, 15, 30 or 45', 'INVALID_BACKUP_POLICY');
  return {
    frequency, minute,
    hour: _integer(input.hour, 0, 23, previous.hour ?? 2, 'Schedule hour'),
    weekday: _integer(input.weekday, 0, 6, previous.weekday ?? 0, 'Schedule weekday'),
    dayOfMonth: _integer(input.dayOfMonth, 1, 28, previous.dayOfMonth ?? 1, 'Schedule day of month'),
    timezone: _timezone(input.timezone ?? previous.timezone ?? 'UTC'),
  };
}

function _scope(input = {}, previous = {}) {
  const selectorsInput = input.selectors || previous.selectors || {};
  const exclusionsInput = input.exclusions || previous.exclusions || {};
  const powerStates = _uniqueStrings(selectorsInput.powerStates || [], /^[a-z]+$/, 5, 'Power-state selectors');
  if (powerStates.some(state => !POWER_STATES.has(state))) throw new BackupPolicyError('Scope contains an invalid power state', 'INVALID_BACKUP_POLICY');
  const match = String(selectorsInput.match ?? 'all');
  if (!['all', 'any'].includes(match)) throw new BackupPolicyError('Selector match must be all or any', 'INVALID_BACKUP_POLICY');
  const diskSelectors = exclusionsInput.diskSelectors === undefined ? [] : exclusionsInput.diskSelectors;
  if (!Array.isArray(diskSelectors) || diskSelectors.length > 32) {
    throw new BackupPolicyError('Disk exclusions must contain at most 32 selectors', 'INVALID_BACKUP_POLICY');
  }
  return {
    includeAll: input.includeAll === undefined ? previous.includeAll === true : input.includeAll === true,
    workloadIds: _uniqueStrings(input.workloadIds ?? previous.workloadIds ?? [], SAFE_WORKLOAD_ID, 500, 'Workload scope'),
    selectors: { match, labels: _labels(selectorsInput.labels, 'Scope selectors'), powerStates },
    exclusions: {
      workloadIds: _uniqueStrings(exclusionsInput.workloadIds || [], SAFE_WORKLOAD_ID, 500, 'Workload exclusions'),
      labels: _labels(exclusionsInput.labels, 'Exclusion selectors'),
      diskSelectors: diskSelectors.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new BackupPolicyError('Disk exclusion is invalid', 'INVALID_BACKUP_POLICY');
        const workloadId = String(item.workloadId || ''); const selector = _text(item.selector, 160);
        if (!SAFE_WORKLOAD_ID.test(workloadId) || !selector) throw new BackupPolicyError(`Disk exclusion ${index + 1} is invalid`, 'INVALID_BACKUP_POLICY');
        return { workloadId, selector };
      }),
    },
  };
}

function _consistency(input = {}, previous = {}) {
  const requested = String(input.requested ?? previous.requested ?? 'crash');
  const fallback = String(input.fallback ?? previous.fallback ?? 'fail');
  if (!CONSISTENCY.has(requested) || !new Set(['fail', 'filesystem', 'crash']).has(fallback)) {
    throw new BackupPolicyError('Consistency or fallback mode is invalid', 'INVALID_BACKUP_POLICY');
  }
  return { requested, fallback, guestToolsRequired: input.guestToolsRequired === undefined
    ? previous.guestToolsRequired === true : input.guestToolsRequired === true };
}

function _retention(input = {}, previous = {}) {
  return {
    strategy: 'portable_newest',
    keepLast: _integer(input.keepLast, 0, 1000, previous.keepLast ?? 3, 'Keep-last retention'),
    hourly: _integer(input.hourly, 0, 744, previous.hourly ?? 0, 'Hourly retention'),
    daily: _integer(input.daily, 0, 3660, previous.daily ?? 7, 'Daily retention'),
    weekly: _integer(input.weekly, 0, 520, previous.weekly ?? 4, 'Weekly retention'),
    monthly: _integer(input.monthly, 0, 240, previous.monthly ?? 12, 'Monthly retention'),
    yearly: _integer(input.yearly, 0, 100, previous.yearly ?? 3, 'Yearly retention'),
    weekStartsOn: _integer(input.weekStartsOn, 0, 6, previous.weekStartsOn ?? 1, 'Retention week start'),
  };
}

function _requirement(input = {}, previous = {}, label) {
  const mode = String(input.mode ?? previous.mode ?? 'none');
  if (!REQUIREMENTS.has(mode)) throw new BackupPolicyError(`${label} requirement must be none, preferred or required`, 'INVALID_BACKUP_POLICY');
  return mode;
}

function _protection(input = {}, previous = {}) {
  const encryptionInput = input.encryption || previous.encryption || {};
  const immutableInput = input.immutability || previous.immutability || {};
  const encryption = {
    mode: _requirement(encryptionInput, previous.encryption, 'Encryption'),
    keyReference: _text(encryptionInput.keyReference ?? previous.encryption?.keyReference, 120),
  };
  if (encryption.keyReference && !SAFE_KEY_REFERENCE.test(encryption.keyReference)) {
    throw new BackupPolicyError('Encryption key reference must be an alias or vault path, never key material', 'INVALID_BACKUP_POLICY');
  }
  if (encryption.mode === 'required' && !encryption.keyReference) {
    throw new BackupPolicyError('Required encryption needs a key reference (never key material)', 'INVALID_BACKUP_POLICY');
  }
  return {
    encryption,
    immutability: {
      mode: _requirement(immutableInput, previous.immutability, 'Immutability'),
      minimumLockDays: _integer(immutableInput.minimumLockDays, 0, 36500,
        previous.immutability?.minimumLockDays ?? 0, 'Minimum immutable lock days'),
    },
  };
}

function _controls(input = {}, previous = {}) {
  const windowInput = input.window || previous.window || null;
  let window = null;
  if (windowInput) {
    const start = _text(windowInput.start, 5); const end = _text(windowInput.end, 5);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end || '')) {
      throw new BackupPolicyError('Backup window times must use HH:MM', 'INVALID_BACKUP_POLICY');
    }
    const days = _uniqueStrings((windowInput.days || []).map(String), /^[0-6]$/, 7, 'Backup-window weekdays').map(Number);
    window = { start, end, days, timezone: _timezone(windowInput.timezone || 'UTC') };
  }
  return {
    maxConcurrent: _integer(input.maxConcurrent, 1, 32, previous.maxConcurrent ?? 1, 'Maximum concurrency'),
    bandwidthLimitMbps: _nullableInteger(input.bandwidthLimitMbps, 1, 100000,
      previous.bandwidthLimitMbps ?? null, 'Bandwidth limit'),
    window,
  };
}

function _verification(input = {}, previous = {}) {
  return {
    afterBackup: input.afterBackup === undefined ? previous.afterBackup !== false : input.afterBackup === true,
    maximumUnverifiedHours: _integer(input.maximumUnverifiedHours, 1, 8760,
      previous.maximumUnverifiedHours ?? 24, 'Maximum unverified age'),
    restoreDrillRequired: input.restoreDrillRequired === undefined
      ? previous.restoreDrillRequired === true : input.restoreDrillRequired === true,
  };
}

function validatePolicy(input = {}, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BackupPolicyError('Backup policy body must be an object', 'INVALID_BACKUP_POLICY');
  const previous = existing || {};
  const name = _text(input.name ?? previous.name, 120);
  if (!name || name.length < 3) throw new BackupPolicyError('Backup policy name must contain 3-120 characters', 'INVALID_BACKUP_POLICY');
  const repositoryId = String(input.repositoryId ?? previous.repositoryId ?? '');
  if (!SAFE_REPOSITORY_ID.test(repositoryId)) throw new BackupPolicyError('A canonical backup repository is required', 'INVALID_BACKUP_POLICY');
  const mode = String(input.mode ?? previous.mode ?? 'plan_only');
  if (mode !== 'plan_only') throw new BackupPolicyError('Backup execution is not available until the execution batch is enabled', 'BACKUP_EXECUTION_DISABLED', 409);
  const policy = {
    schemaVersion: SCHEMA_VERSION, name, description: _text(input.description ?? previous.description, 500),
    enabled: input.enabled === undefined ? previous.enabled === true : input.enabled === true,
    mode, repositoryId,
    schedule: _schedule(input.schedule || {}, previous.schedule),
    scope: _scope(input.scope || {}, previous.scope),
    consistency: _consistency(input.consistency || {}, previous.consistency),
    retention: _retention(input.retention || {}, previous.retention),
    protection: _protection(input.protection || {}, previous.protection),
    controls: _controls(input.controls || {}, previous.controls),
    verification: _verification(input.verification || {}, previous.verification),
  };
  if (!policy.scope.includeAll && !policy.scope.workloadIds.length
    && !Object.keys(policy.scope.selectors.labels).length && !policy.scope.selectors.powerStates.length) {
    throw new BackupPolicyError('Backup scope must explicitly select at least one workload or selector', 'INVALID_BACKUP_POLICY');
  }
  return policy;
}

function _canonical(value) {
  if (Array.isArray(value)) return `[${value.map(_canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${_canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function _policyHash(policy) {
  const source = { ...policy }; delete source.schemaVersion; delete source.enabled;
  return sha256(_canonical(source));
}

function _publicPolicy(row) {
  if (!row) return null;
  return {
    schemaVersion: SCHEMA_VERSION, id: row.id, hostId: Number(row.host_id), repositoryId: row.repository_id,
    name: row.name, description: row.description || null, enabled: !!row.enabled, mode: row.mode,
    schedule: _parseJson(row.schedule_json, {}), scope: _parseJson(row.scope_json, {}),
    consistency: _parseJson(row.consistency_json, {}), retention: _parseJson(row.retention_json, {}),
    protection: _parseJson(row.protection_json, {}), controls: _parseJson(row.controls_json, {}),
    verification: _parseJson(row.verification_json, {}), policyHash: row.policy_hash,
    execution: {
      mode: row.execution_mode || 'disabled',
      authorizedBy: row.execution_authorized_by || null,
      authorizedAt: row.execution_authorized_at || null,
    },
    lastSlotKey: row.last_slot_key || null, lastPlanAt: row.last_plan_at || null,
    lastPlanStatus: row.last_plan_status || null,
    lastPlanSummary: _parseJson(row.last_plan_summary_json, null),
    createdBy: row.created_by || null, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function _publicRun(row) {
  if (!row) return null;
  return {
    schemaVersion: SCHEMA_VERSION, id: row.id, policyId: row.policy_id,
    trigger: row.trigger_type, slotKey: row.slot_key, state: row.state,
    policyHash: row.policy_hash, planHash: row.plan_hash,
    plan: _parseJson(row.plan_json, {}), findings: _parseJson(row.findings_json, []),
    createdBy: row.created_by || null, createdAt: row.created_at, completedAt: row.completed_at,
  };
}

function get(idInput, options = {}) {
  const id = String(idInput || '');
  if (!SAFE_POLICY_ID.test(id)) return null;
  return _publicPolicy(_database(options).prepare('SELECT * FROM provider_backup_policies WHERE id = ? AND deleted_at IS NULL').get(id));
}

function listForHost(hostIdInput, options = {}) {
  const hostId = Number(hostIdInput); const limit = Math.min(200, Math.max(1, Number(options.limit) || 100));
  if (!Number.isInteger(hostId) || hostId <= 0) return [];
  return _database(options).prepare(`SELECT * FROM provider_backup_policies
    WHERE host_id = ? AND deleted_at IS NULL ORDER BY lower(name), id LIMIT ?`).all(hostId, limit).map(_publicPolicy);
}

function listRuns(hostIdInput, options = {}) {
  const hostId = Number(hostIdInput); const limit = Math.min(200, Math.max(1, Number(options.limit) || 50));
  if (!Number.isInteger(hostId) || hostId <= 0) return [];
  const policyId = options.policyId ? String(options.policyId) : null;
  if (policyId && !SAFE_POLICY_ID.test(policyId)) return [];
  return _database(options).prepare(`SELECT r.* FROM provider_backup_policy_runs r
    JOIN provider_backup_policies p ON p.id = r.policy_id
    WHERE p.host_id = ? AND (? IS NULL OR r.policy_id = ?)
    ORDER BY r.created_at DESC, r.id DESC LIMIT ?`).all(hostId, policyId, policyId, limit).map(_publicRun);
}

function _repository(hostId, repositoryId, database) {
  const row = database.prepare(`SELECT repository_json, observed_at FROM provider_backup_repositories
    WHERE host_id = ? AND canonical_id = ?`).get(hostId, repositoryId);
  if (!row) return null;
  const repository = _parseJson(row.repository_json, null);
  return repository ? { ...repository, observedAt: repository.observedAt || row.observed_at } : null;
}

function _matchesLabels(resource, predicates, mode = 'all') {
  const entries = Object.entries(predicates || {});
  if (!entries.length) return null;
  const labels = resource.labels || {};
  const outcomes = entries.map(([key, value]) => String(labels[key] ?? '').toLowerCase() === String(value).toLowerCase());
  return mode === 'any' ? outcomes.some(Boolean) : outcomes.every(Boolean);
}

function selectWorkloads(resources, scope) {
  const explicit = new Set(scope.workloadIds); const excluded = new Set(scope.exclusions.workloadIds);
  const selected = []; const transient = [];
  for (const resource of resources) {
    const state = String(resource.status?.powerState || 'unknown');
    const labelMatch = _matchesLabels(resource, scope.selectors.labels, scope.selectors.match);
    const stateMatch = scope.selectors.powerStates.length ? scope.selectors.powerStates.includes(state) : null;
    const predicates = [labelMatch, stateMatch].filter(value => value !== null);
    const selectorMatch = predicates.length
      ? (scope.selectors.match === 'any' ? predicates.some(Boolean) : predicates.every(Boolean)) : false;
    const included = scope.includeAll || explicit.has(resource.id) || selectorMatch;
    const labelExcluded = _matchesLabels(resource, scope.exclusions.labels, 'all') === true;
    if (!included || excluded.has(resource.id) || labelExcluded) continue;
    if (resource.identity?.stability === 'transient') { transient.push(resource.id); continue; }
    selected.push({ id: resource.id, displayName: resource.displayName, powerState: state,
      identityStability: resource.identity?.stability || 'unknown' });
  }
  return { selected: selected.sort((a, b) => a.id.localeCompare(b.id)), transient };
}

function _zonedParts(dateInput, timezone) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date);
  const object = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { year: Number(object.year), month: Number(object.month), day: Number(object.day),
    hour: Number(object.hour), minute: Number(object.minute), weekday: weekdays[object.weekday] };
}

function slotKey(schedule, dateInput = new Date()) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) return null;
  const part = _zonedParts(date, schedule.timezone);
  if (part.minute !== schedule.minute) return null;
  if (schedule.frequency !== 'hourly' && part.hour !== schedule.hour) return null;
  if (schedule.frequency === 'weekly' && part.weekday !== schedule.weekday) return null;
  if (schedule.frequency === 'monthly' && part.day !== schedule.dayOfMonth) return null;
  const local = `${part.year}-${String(part.month).padStart(2, '0')}-${String(part.day).padStart(2, '0')}T${String(part.hour).padStart(2, '0')}:${String(part.minute).padStart(2, '0')}`;
  return `${local}@${schedule.timezone}`;
}

function nextOccurrences(schedule, fromInput = new Date(), limitInput = 5) {
  const limit = Math.min(10, Math.max(1, Number(limitInput) || 5));
  const from = fromInput instanceof Date ? fromInput : new Date(fromInput);
  if (Number.isNaN(from.getTime())) throw new BackupPolicyError('Occurrence start time is invalid', 'INVALID_BACKUP_POLICY');
  const cursor = new Date(Math.floor(from.getTime() / 900000) * 900000 + 900000);
  const output = []; const seen = new Set(); const maximum = cursor.getTime() + 400 * 86400000;
  for (; cursor.getTime() <= maximum && output.length < limit; cursor.setTime(cursor.getTime() + 900000)) {
    const key = slotKey(schedule, cursor);
    if (key && !seen.has(key)) { seen.add(key); output.push({ slotKey: key, at: cursor.toISOString() }); }
  }
  return output;
}

function _weekBucket(part, weekStartsOn) {
  const utc = Date.UTC(part.year, part.month - 1, part.day);
  const delta = (part.weekday - weekStartsOn + 7) % 7;
  return new Date(utc - delta * 86400000).toISOString().slice(0, 10);
}

function evaluateGfs(pointsInput, retention, timezone = 'UTC', nowInput = new Date()) {
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const points = (Array.isArray(pointsInput) ? pointsInput : []).filter(point => point?.id)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || a.id.localeCompare(b.id));
  const protectedBy = new Map(); const protect = (id, reason) => {
    if (!protectedBy.has(id)) protectedBy.set(id, []);
    if (!protectedBy.get(id).includes(reason)) protectedBy.get(id).push(reason);
  };
  points.slice(0, retention.keepLast).forEach(point => protect(point.id, 'keep_last'));
  const tiers = [['hourly', retention.hourly], ['daily', retention.daily], ['weekly', retention.weekly],
    ['monthly', retention.monthly], ['yearly', retention.yearly]];
  for (const [tier, count] of tiers) {
    const buckets = new Set();
    for (const point of points) {
      if (buckets.size >= count) break;
      if (!point.createdAt || Number.isNaN(Date.parse(point.createdAt))) continue;
      const part = _zonedParts(point.createdAt, timezone);
      const bucket = tier === 'hourly' ? `${part.year}-${part.month}-${part.day}T${part.hour}`
        : tier === 'daily' ? `${part.year}-${part.month}-${part.day}`
          : tier === 'weekly' ? _weekBucket(part, retention.weekStartsOn)
            : tier === 'monthly' ? `${part.year}-${part.month}` : String(part.year);
      if (!buckets.has(bucket)) { buckets.add(bucket); protect(point.id, `gfs_${tier}`); }
    }
  }
  for (const point of points) {
    if (!point.createdAt || Number.isNaN(Date.parse(point.createdAt))) protect(point.id, 'missing_timestamp');
    if (point.backup?.protected === true) protect(point.id, 'provider_protected');
    if (point.retention?.immutableUntil && Date.parse(point.retention.immutableUntil) > now.getTime()) protect(point.id, 'immutable_lock');
  }
  const protectedItems = points.filter(point => protectedBy.has(point.id)).map(point => ({
    id: point.id, createdAt: point.createdAt || null, reasons: protectedBy.get(point.id).sort(),
  }));
  const candidates = points.filter(point => !protectedBy.has(point.id)).map(point => ({ id: point.id, createdAt: point.createdAt || null }));
  return { strategy: 'portable_newest', observedCount: points.length, protectedCount: protectedItems.length,
    candidateCount: candidates.length, protected: protectedItems, candidates,
    mutationAuthorized: false, evaluatedAt: now.toISOString() };
}

function _finding(severity, code, message, subject = null) { return { severity, code, message, ...(subject ? { subject } : {}) }; }

async function preflightForHost(host, input = {}, options = {}) {
  const database = _database(options); const registry = options.registry || registrySingleton;
  const existing = input.id ? get(input.id, { database }) : (options.existing || null);
  if (existing && existing.hostId !== Number(host.id)) throw new BackupPolicyError('Backup policy was not found on this endpoint', 'BACKUP_POLICY_NOT_FOUND', 404);
  const policy = validatePolicy(input, existing);
  let recovery = options.recoveryInventory;
  if (!recovery) {
    try {
      recovery = await registry.recoveryPointsForHost(host, {
        limit: 500, repositoryId: policy.repositoryId, database,
      });
    } catch (err) {
      if (err?.name === 'ProviderAdapterError' && /^[A-Z][A-Z0-9_]{1,79}$/.test(String(err.code || ''))) {
        throw new BackupPolicyError('Live provider backup evidence is unavailable', err.code,
          [400, 404, 409, 502, 503, 504].includes(err.status) ? err.status : 502);
      }
      throw err;
    }
  }
  let resources = options.resourceInventory;
  if (!resources) {
    try { resources = await registry.resourcesForHost(host, 'virtual-machines', { limit: 500, database }); }
    catch (err) {
      if (err?.name === 'ProviderAdapterError' && /^[A-Z][A-Z0-9_]{1,79}$/.test(String(err.code || ''))) {
        throw new BackupPolicyError('Live provider workload evidence is unavailable', err.code,
          [400, 404, 409, 502, 503, 504].includes(err.status) ? err.status : 502);
      }
      throw err;
    }
  }
  const repository = (recovery.repositories || []).find(item => item.id === policy.repositoryId
    && item.provider?.endpointId === Number(host.id));
  const findings = [];
  if (recovery.truncated) findings.push(_finding('warning', 'RECOVERY_POINT_INVENTORY_TRUNCATED', 'Retention preview covers only the bounded recovery-point inventory'));
  if (resources.truncated) findings.push(_finding('warning', 'WORKLOAD_INVENTORY_TRUNCATED', 'Scope evaluation covers only the bounded workload inventory'));
  if (!repository) findings.push(_finding('blocker', 'BACKUP_REPOSITORY_NOT_FOUND', 'Repository is not reported by this endpoint', policy.repositoryId));
  else {
    if (repository.status?.enabled === false) findings.push(_finding('blocker', 'BACKUP_REPOSITORY_DISABLED', 'Repository is disabled', repository.id));
    if (repository.status?.accessible === false) findings.push(_finding('blocker', 'BACKUP_REPOSITORY_UNREACHABLE', 'Repository is not accessible', repository.id));
    const checks = [['clientSideEncryption', policy.protection.encryption.mode, 'ENCRYPTION'],
      ['immutableRetention', policy.protection.immutability.mode, 'IMMUTABILITY']];
    for (const [capability, requirement, label] of checks) {
      if (requirement === 'none') continue;
      const evidence = repository.capabilities?.[capability];
      if (requirement === 'required' && evidence !== true) findings.push(_finding('blocker', `${label}_CAPABILITY_UNPROVEN`, `${label.toLowerCase()} is required but repository support is ${evidence === false ? 'unsupported' : 'unknown'}`, repository.id));
      if (requirement === 'preferred' && evidence !== true) findings.push(_finding('warning', `${label}_CAPABILITY_UNPROVEN`, `${label.toLowerCase()} is preferred but repository support is ${evidence === false ? 'unsupported' : 'unknown'}`, repository.id));
    }
    if (policy.verification.afterBackup && repository.capabilities?.verification !== true) {
      findings.push(_finding('warning', 'VERIFICATION_CAPABILITY_UNPROVEN', 'Post-backup verification is requested but repository support is not proven', repository.id));
    }
  }
  const selection = selectWorkloads(resources.items || [], policy.scope);
  if (!selection.selected.length) findings.push(_finding('blocker', 'BACKUP_SCOPE_EMPTY', 'Current inventory has no stable workload matching this scope'));
  if (selection.transient.length) findings.push(_finding('warning', 'TRANSIENT_WORKLOADS_EXCLUDED', `${selection.transient.length} transient workload identities were excluded`));
  const missingExplicit = policy.scope.workloadIds.filter(id => !(resources.items || []).some(item => item.id === id));
  if (missingExplicit.length) findings.push(_finding('warning', 'EXPLICIT_WORKLOADS_MISSING', `${missingExplicit.length} explicitly selected workloads are absent from current inventory`));
  if (policy.scope.exclusions.diskSelectors.length) findings.push(_finding('warning', 'DISK_EXCLUSIONS_EXECUTION_PENDING', 'Disk exclusions are recorded but require provider-native resolution during execution'));
  if (host.daemon_type === 'xen' && ['daily', 'weekly', 'monthly', 'yearly'].some(tier => policy.retention[tier] > 0)) {
    findings.push(_finding('warning', 'PROVIDER_GFS_SEMANTICS_DIFFER', 'Portable preview keeps the newest point per bucket; Xen Orchestra native GFS preserves the oldest point per period'));
  }
  if (policy.consistency.requested !== 'crash') findings.push(_finding('warning', 'CONSISTENCY_EXECUTION_EVIDENCE_PENDING', 'Guest-consistency support will be revalidated per workload before execution'));
  if (policy.controls.bandwidthLimitMbps !== null || policy.controls.window) findings.push(_finding('warning', 'EXECUTION_CONTROLS_PENDING', 'Bandwidth and window controls require provider-native translation during execution'));
  if (policy.protection.encryption.mode === 'preferred' && !policy.protection.encryption.keyReference) findings.push(_finding('warning', 'ENCRYPTION_KEY_REFERENCE_MISSING', 'Preferred encryption has no key reference'));
  if (policy.verification.restoreDrillRequired) findings.push(_finding('warning', 'RESTORE_DRILL_EXECUTION_PENDING', 'Restore-drill enforcement is planned for the restore orchestration batch'));
  const selectedIds = new Set(selection.selected.map(item => item.id));
  const points = (recovery.items || []).filter(point => point.repository?.id === policy.repositoryId
    && point.workload?.id && selectedIds.has(point.workload.id));
  const retention = evaluateGfs(points, policy.retention, policy.schedule.timezone, options.now || new Date());
  const blockers = findings.filter(item => item.severity === 'blocker');
  const warnings = findings.filter(item => item.severity === 'warning');
  const planCore = {
    schemaVersion: SCHEMA_VERSION, kind: 'providerBackupPolicyPlan', policyId: existing?.id || null,
    policyHash: _policyHash(policy), provider: { type: String(host.daemon_type), endpointId: Number(host.id) },
    mode: 'plan_only', repository: repository ? { id: repository.id, displayName: repository.displayName,
      repositoryType: repository.repositoryType, observedAt: repository.observedAt,
      status: repository.status || {}, capabilities: repository.capabilities || {} } : { id: policy.repositoryId, unavailable: true },
    scope: { selectedCount: selection.selected.length, workloads: selection.selected,
      missingExplicitIds: missingExplicit, transientExcludedIds: selection.transient },
    consistency: policy.consistency, retention, protection: policy.protection,
    controls: policy.controls, verification: policy.verification,
    nextOccurrences: nextOccurrences(policy.schedule, options.now || new Date(), 5),
    findings, allowed: blockers.length === 0,
    execution: { authorized: false, reason: 'V3.2 persists plans only; provider mutation belongs to V3.3' },
  };
  const planHash = sha256(_canonical({
    ...planCore,
    repository: planCore.repository ? { ...planCore.repository, observedAt: undefined } : planCore.repository,
    retention: { ...retention, evaluatedAt: undefined }, nextOccurrences: undefined,
  }));
  return { ...planCore, planHash, summary: { blockers: blockers.length, warnings: warnings.length,
    selectedWorkloads: selection.selected.length, observedRecoveryPoints: points.length,
    retentionCandidates: retention.candidateCount } };
}

async function upsertForHost(host, input = {}, options = {}) {
  if (!config.features.providerBackupPolicies && options.enabled !== true) {
    throw new BackupPolicyError('Provider backup policies are disabled by release policy', 'BACKUP_POLICIES_DISABLED', 404);
  }
  const database = _database(options); const existing = input.id ? get(input.id, { database }) : null;
  if (input.id && (!existing || existing.hostId !== Number(host.id))) throw new BackupPolicyError('Backup policy was not found', 'BACKUP_POLICY_NOT_FOUND', 404);
  if (existing) _assertNoActiveExecution(existing.id, database);
  const policy = validatePolicy(input, existing); const preflight = await preflightForHost(host, { ...policy, id: existing?.id }, { ...options, database, existing });
  if (policy.enabled && !preflight.allowed) {
    throw new BackupPolicyError('Enabled backup policy is blocked by preflight', 'BACKUP_POLICY_PREFLIGHT_BLOCKED', 409, { findings: preflight.findings });
  }
  const id = existing?.id || `pbp_${generateToken(13)}`; const policyHash = _policyHash(policy);
  try {
    database.prepare(`INSERT INTO provider_backup_policies
      (id, host_id, repository_id, name, description, enabled, mode, schedule_json, scope_json,
       consistency_json, retention_json, protection_json, controls_json, verification_json, policy_hash, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 'plan_only', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET repository_id=excluded.repository_id, name=excluded.name,
        description=excluded.description, enabled=excluded.enabled, mode='plan_only',
        schedule_json=excluded.schedule_json, scope_json=excluded.scope_json,
        consistency_json=excluded.consistency_json, retention_json=excluded.retention_json,
        protection_json=excluded.protection_json, controls_json=excluded.controls_json,
        verification_json=excluded.verification_json, policy_hash=excluded.policy_hash,
        deleted_at=NULL, updated_at=datetime('now')`).run(
      id, Number(host.id), policy.repositoryId, policy.name, policy.description, policy.enabled ? 1 : 0,
      JSON.stringify(policy.schedule), JSON.stringify(policy.scope), JSON.stringify(policy.consistency),
      JSON.stringify(policy.retention), JSON.stringify(policy.protection), JSON.stringify(policy.controls),
      JSON.stringify(policy.verification), policyHash, options.createdBy || null
    );
  } catch (err) {
    if (String(err?.code || '').startsWith('SQLITE_CONSTRAINT')) throw new BackupPolicyError('An active backup policy already uses this name or reference', 'BACKUP_POLICY_CONFLICT', 409);
    throw err;
  }
  return { policy: get(id, { database }), preflight, created: !existing };
}

function removeForHost(hostIdInput, idInput, options = {}) {
  if (!config.features.providerBackupPolicies && options.enabled !== true) {
    throw new BackupPolicyError('Provider backup policies are disabled by release policy', 'BACKUP_POLICIES_DISABLED', 404);
  }
  const hostId = Number(hostIdInput); const policy = get(idInput, options);
  if (!policy || policy.hostId !== hostId) throw new BackupPolicyError('Backup policy was not found', 'BACKUP_POLICY_NOT_FOUND', 404);
  const database = _database(options); _assertNoActiveExecution(policy.id, database);
  database.prepare(`UPDATE provider_backup_policies SET enabled=0, deleted_at=datetime('now'),
    updated_at=datetime('now') WHERE id=? AND host_id=?`).run(policy.id, hostId);
  return policy;
}

function _assertNoActiveExecution(policyId, database) {
  const table = database.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='provider_backup_executions'`).get();
  if (!table) return;
  const active = database.prepare(`SELECT id FROM provider_backup_executions
    WHERE policy_id=? AND state IN ('queued','running','verification_pending') LIMIT 1`).get(policyId);
  if (active) throw new BackupPolicyError('Backup policy cannot change while an execution is active', 'BACKUP_EXECUTION_ACTIVE', 409);
}

function _insertRun(policy, plan, trigger, slot, options = {}) {
  const database = _database(options); const id = `pbpr_${generateToken(13)}`;
  const state = plan.allowed ? 'planned' : 'blocked';
  try {
    database.transaction(() => {
      database.prepare(`INSERT INTO provider_backup_policy_runs
        (id, policy_id, trigger_type, slot_key, state, policy_hash, plan_hash, plan_json, findings_json, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, policy.id, trigger, slot, state,
        policy.policyHash, plan.planHash, JSON.stringify(plan), JSON.stringify(plan.findings), options.createdBy || null);
      database.prepare(`UPDATE provider_backup_policies SET last_slot_key=?, last_plan_at=datetime('now'),
        last_plan_status=?, last_plan_summary_json=?, updated_at=datetime('now') WHERE id=?`).run(
        slot, state, JSON.stringify({ runId: id, planHash: plan.planHash, ...plan.summary }), policy.id);
    })();
  } catch (err) {
    if (String(err?.code || '').startsWith('SQLITE_CONSTRAINT')) throw new BackupPolicyError('A backup-policy plan already exists for this slot', 'BACKUP_POLICY_SLOT_EXISTS', 409);
    throw err;
  }
  return _publicRun(database.prepare('SELECT * FROM provider_backup_policy_runs WHERE id=?').get(id));
}

function _blockedPlan(policy, host, err, nowInput = new Date()) {
  const code = /^[A-Z][A-Z0-9_]{1,79}$/.test(String(err?.code || ''))
    ? String(err.code) : 'BACKUP_POLICY_EVIDENCE_UNAVAILABLE';
  const finding = _finding('blocker', code, 'Live provider evidence was unavailable for this scheduled plan');
  const evaluatedAt = (nowInput instanceof Date ? nowInput : new Date(nowInput)).toISOString();
  const core = {
    schemaVersion: SCHEMA_VERSION, kind: 'providerBackupPolicyPlan', policyId: policy.id,
    policyHash: policy.policyHash, provider: { type: String(host.daemon_type), endpointId: Number(host.id) },
    mode: 'plan_only', repository: { id: policy.repositoryId, unavailable: true },
    scope: { selectedCount: 0, workloads: [], missingExplicitIds: [], transientExcludedIds: [] },
    findings: [finding], allowed: false,
    execution: { authorized: false, reason: 'V3.2 persists plans only; provider mutation belongs to V3.3' },
    summary: { blockers: 1, warnings: 0, selectedWorkloads: 0, observedRecoveryPoints: 0, retentionCandidates: 0 },
    evaluatedAt,
  };
  return { ...core, planHash: sha256(_canonical({ ...core, evaluatedAt: undefined })) };
}

async function planForHost(host, policyId, options = {}) {
  if (!config.features.providerBackupPolicies && options.enabled !== true) {
    throw new BackupPolicyError('Provider backup policies are disabled by release policy', 'BACKUP_POLICIES_DISABLED', 404);
  }
  const database = _database(options); const policy = get(policyId, { database });
  if (!policy || policy.hostId !== Number(host.id)) throw new BackupPolicyError('Backup policy was not found', 'BACKUP_POLICY_NOT_FOUND', 404);
  const trigger = options.trigger === 'scheduled' ? 'scheduled' : (options.trigger === 'preview' ? 'preview' : 'manual');
  const slot = options.slotKey || `manual:${new Date().toISOString()}:${generateToken(5)}`;
  const plan = await preflightForHost(host, { ...policy, id: policy.id }, { ...options, database, existing: policy });
  return _insertRun(policy, plan, trigger, slot, { ...options, database });
}

function _hostForPolicy(policy, database) {
  const host = database.prepare('SELECT * FROM docker_hosts WHERE id=? AND is_active=1').get(policy.hostId);
  if (!host) throw new BackupPolicyError('Backup policy endpoint is unavailable', 'INVALID_OPERATION_HOST', 409);
  return host;
}

function _systemAudit(policy, run) {
  try { audit.log({ username: 'system', action: 'provider_backup_policy_scheduled_plan', targetType: 'provider_host',
    targetId: String(policy.hostId), details: { policyId: policy.id, runId: run.id, state: run.state,
      planHash: run.planHash, executionAuthorized: false } }); } catch { /* run table is authoritative */ }
}

async function runDue(options = {}) {
  if (!config.features.providerBackupPolicies && options.enabled !== true) return { started: [], skipped: 'disabled' };
  const database = _database(options); const now = options.now || new Date();
  const policies = database.prepare(`SELECT * FROM provider_backup_policies
    WHERE enabled=1 AND deleted_at IS NULL ORDER BY id LIMIT ?`).all(MAX_POLICIES_PER_TICK).map(_publicPolicy);
  const started = []; const errors = [];
  for (const policy of policies) {
    const slot = slotKey(policy.schedule, now);
    if (!slot || policy.lastSlotKey === slot) continue;
    try {
      const host = _hostForPolicy(policy, database);
      let run;
      try {
        run = await planForHost(host, policy.id, { ...options, database, trigger: 'scheduled', slotKey: slot,
          createdBy: policy.createdBy });
      } catch (err) {
        if (err.code === 'BACKUP_POLICY_SLOT_EXISTS') continue;
        run = _insertRun(policy, _blockedPlan(policy, host, err, now), 'scheduled', slot,
          { database, createdBy: policy.createdBy });
      }
      started.push(run); _systemAudit(policy, run);
    } catch (err) {
      if (err.code === 'BACKUP_POLICY_SLOT_EXISTS') continue;
      errors.push({ policyId: policy.id, code: err.code || 'BACKUP_POLICY_PLAN_FAILED' });
      log.error('Scheduled backup-policy plan failed', { policyId: policy.id, code: err.code || 'BACKUP_POLICY_PLAN_FAILED' });
    }
  }
  return { started, errors };
}

module.exports = {
  SCHEMA_VERSION, BackupPolicyError, validatePolicy, get, listForHost, listRuns,
  selectWorkloads, slotKey, nextOccurrences, evaluateGfs, preflightForHost,
  upsertForHost, removeForHost, planForHost, runDue,
  _internals: { SAFE_POLICY_ID, SAFE_RUN_ID, _canonical, _policyHash, _publicPolicy, _publicRun,
    _zonedParts, _weekBucket, _repository, _blockedPlan, _assertNoActiveExecution },
};
