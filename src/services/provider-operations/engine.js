'use strict';

const { getDb } = require('../../db');
const { encrypt, decrypt, sha256, generateToken } = require('../../utils/crypto');
const log = require('../../utils/logger')('provider-operations');
const policySingleton = require('./policy');
const { resourceKind } = require('../provider-sdk/resource-catalog');

const STATES = Object.freeze([
  'queued', 'running', 'waiting_retry', 'reconciling', 'cancel_requested',
  'succeeded', 'failed', 'cancelled', 'unknown',
]);
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);
const RELEASING_STATES = new Set(['succeeded', 'failed', 'cancelled']);
const DUE_STATES = ['queued', 'waiting_retry', 'reconciling', 'cancel_requested'];
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_SAFE_JSON_BYTES = 16 * 1024;
const MAX_LOCK_SCOPES = 8;
const RETRY_POLICIES = Object.freeze({
  none: Object.freeze({ maxAttempts: 1, baseMs: 0, capMs: 0, jitter: 0 }),
  transient: Object.freeze({ maxAttempts: 3, baseMs: 1000, capMs: 30_000, jitter: 0.2 }),
  resilient: Object.freeze({ maxAttempts: 5, baseMs: 2000, capMs: 120_000, jitter: 0.2 }),
});
const TRANSIENT_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH',
  'PROVIDER_BUSY', 'RATE_LIMITED', 'TEMPORARY_UNAVAILABLE',
]);
const SENSITIVE_KEY = /pass(word)?|secret|token|credential|private.?key|authorization|cookie/i;
const SAFE_TYPE = /^[a-z][a-z0-9_.-]{2,79}$/;
const SAFE_ACTION = /^[a-z][a-zA-Z0-9_.-]{1,79}$/;
const SAFE_RESOURCE_ID = /^ddr_(vm|host|cluster|storage|network|task)_[a-f0-9]{26}$/;
const SAFE_OPERATION_ID = /^op_[a-f0-9]{26}$/;
const SAFE_LOCK = /^[a-z][a-z0-9_.:-]{1,199}$/;

class ProviderOperationError extends Error {
  constructor(message, code = 'PROVIDER_OPERATION_ERROR', status = 400) {
    super(message);
    this.name = 'ProviderOperationError';
    this.code = code;
    this.status = status;
  }
}

function _now() { return new Date().toISOString(); }
function _future(ms) { return new Date(Date.now() + Math.max(0, ms)).toISOString(); }

function _safeString(value, max = 240) {
  if (value === null || value === undefined || value === '') return null;
  return String(value)
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(token|apiKey|secret|password)\s*[:=]\s*[^\s;,]+/gi, '$1=[redacted]')
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

function _safeCode(value, fallback = 'PROVIDER_OPERATION_ERROR') {
  const code = String(value || '').toUpperCase();
  return /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : fallback;
}

function _safeValue(value, depth = 0) {
  if (depth > 3 || value === undefined) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return _safeString(value, 1000);
  if (Array.isArray(value)) return value.slice(0, 64).map(item => _safeValue(item, depth + 1));
  if (typeof value !== 'object') return null;
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 64)) {
    if (SENSITIVE_KEY.test(key) || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key)) continue;
    output[key] = _safeValue(item, depth + 1);
  }
  return output;
}

function _safeJson(value) {
  let safe = _safeValue(value);
  let json = JSON.stringify(safe ?? null);
  if (Buffer.byteLength(json) > MAX_SAFE_JSON_BYTES) {
    safe = { summary: 'Operation details exceeded the safe response limit', truncated: true };
    json = JSON.stringify(safe);
  }
  return json;
}

function _parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function _operationFromRow(row) {
  if (!row) return null;
  return {
    id: row.id, schemaVersion: row.schema_version, type: row.operation_type,
    provider: { type: row.provider_type, endpointId: row.host_id },
    resource: { kind: row.resource_kind, id: row.resource_id },
    action: row.action, state: row.state, phase: row.phase || null,
    progress: row.progress, attempt: row.attempt, maxAttempts: row.max_attempts,
    retryPolicy: row.retry_policy, timeoutSeconds: row.timeout_seconds,
    availableAt: row.available_at, hasNativeTask: !!row.native_task_ref_enc,
    nativeTaskState: row.native_task_state || null,
    result: _parseJson(row.result_json, null),
    error: row.error_code ? { code: row.error_code, message: row.error_message || null } : null,
    resolution: row.resolution ? {
      state: row.resolution, evidence: row.resolution_evidence,
      resolvedBy: row.resolved_by,
    } : null,
    cancelRequestedAt: row.cancel_requested_at || null,
    createdBy: row.created_by, createdAt: row.created_at, startedAt: row.started_at,
    completedAt: row.completed_at, updatedAt: row.updated_at,
  };
}

class ProviderOperationEngine {
  constructor(options = {}) {
    this._dbProvider = options.dbProvider || getDb;
    this._policy = options.policy || policySingleton;
    this._owner = options.owner || `worker-${generateToken(8)}`;
    this._concurrency = Math.min(32, Math.max(1, Number(options.concurrency) || 4));
    this._pollMs = Math.max(100, Number(options.pollMs) || 1000);
    this._leaseMs = Math.max(1000, Number(options.leaseMs) || 30_000);
    this._handlers = new Map();
    this._active = new Map();
    this._timer = null;
    this._broadcaster = null;
    this._ticking = false;
    this._lastUnknownLockRefresh = 0;
  }

  _db() { return this._dbProvider(); }

  setBroadcaster(fn) { this._broadcaster = typeof fn === 'function' ? fn : null; }

  registerHandler(definition) {
    const type = String(definition?.type || '');
    if (!SAFE_TYPE.test(type)) throw new Error('Provider operation handler type is invalid');
    if (typeof definition.execute !== 'function') throw new Error(`Provider operation handler ${type} requires execute()`);
    if (this._handlers.has(type)) throw new Error(`Provider operation handler already registered: ${type}`);
    const retryPolicy = String(definition.retryPolicy || (definition.idempotent ? 'transient' : 'none'));
    if (!RETRY_POLICIES[retryPolicy]) throw new Error(`Provider operation handler ${type} has an invalid retry policy`);
    const timeoutSeconds = Math.round(Number(definition.timeoutSeconds) || 300);
    if (timeoutSeconds < 1 || timeoutSeconds > 86400) throw new Error(`Provider operation handler ${type} timeout is invalid`);
    const handler = Object.freeze({
      type, execute: definition.execute, reconcile: definition.reconcile,
      cancel: definition.cancel, idempotent: definition.idempotent === true,
      retryPolicy, timeoutSeconds,
    });
    this._handlers.set(type, handler);
    return handler;
  }

  unregisterHandler(type) { this._handlers.delete(type); }

  _event(operationId, eventType, fields = {}) {
    const state = STATES.includes(fields.state) ? fields.state : null;
    const phase = _safeString(fields.phase, 120);
    const progress = Number.isFinite(fields.progress) ? Math.min(100, Math.max(0, Math.round(fields.progress))) : null;
    const message = _safeString(fields.message, 240);
    const detailsJson = fields.details === undefined ? null : _safeJson(fields.details);
    this._db().prepare(`INSERT INTO provider_operation_events
      (operation_id, event_type, state, phase, progress, message, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(operationId, _safeString(eventType, 80), state, phase, progress, message, detailsJson);
    this._publish(operationId);
  }

  _publish(operationId) {
    if (!this._broadcaster) return;
    try { this._broadcaster(this.get(operationId)); } catch { /* live delivery is best-effort */ }
  }

  create(input = {}) {
    const handler = this._handlers.get(String(input.type || ''));
    if (!handler) throw new ProviderOperationError('Provider operation type is not registered', 'OPERATION_HANDLER_UNAVAILABLE', 400);
    const hostId = Number(input.hostId);
    if (!Number.isInteger(hostId) || hostId <= 0) throw new ProviderOperationError('Valid provider host is required', 'INVALID_OPERATION_HOST');
    const host = this._db().prepare('SELECT id, daemon_type, is_active FROM docker_hosts WHERE id = ?').get(hostId);
    if (!host || !host.is_active) throw new ProviderOperationError('Active provider host was not found', 'INVALID_OPERATION_HOST');
    const providerType = String(input.providerType || host.daemon_type || '').toLowerCase();
    if (providerType !== host.daemon_type || !/^[a-z][a-z0-9_-]{1,39}$/.test(providerType)) {
      throw new ProviderOperationError('Provider type does not match the endpoint', 'INVALID_OPERATION_PROVIDER');
    }
    const resourceId = String(input.resourceId || '');
    const resourceKindName = String(input.resourceKind || '');
    const kindInfo = resourceKind(resourceKindName);
    if (!SAFE_RESOURCE_ID.test(resourceId) || !kindInfo || !resourceId.startsWith(`ddr_${kindInfo.prefix}_`)) {
      throw new ProviderOperationError('Canonical provider resource is required', 'INVALID_OPERATION_RESOURCE');
    }
    const action = String(input.action || '');
    if (!SAFE_ACTION.test(action)) throw new ProviderOperationError('Provider operation action is invalid', 'INVALID_OPERATION_ACTION');
    const idempotencyKey = String(input.idempotencyKey || '');
    if (!/^[\x21-\x7e]{8,200}$/.test(idempotencyKey)) {
      throw new ProviderOperationError('Idempotency key must contain 8-200 visible ASCII characters', 'INVALID_IDEMPOTENCY_KEY');
    }
    const request = input.request === undefined ? {} : input.request;
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new ProviderOperationError('Provider operation request must be an object', 'INVALID_OPERATION_REQUEST');
    }
    const requestJson = JSON.stringify(request);
    if (Buffer.byteLength(requestJson) > MAX_REQUEST_BYTES) {
      throw new ProviderOperationError(`Provider operation request exceeds ${MAX_REQUEST_BYTES} bytes`, 'OPERATION_REQUEST_TOO_LARGE');
    }
    const scopes = input.lockScopes === undefined ? [`resource:${resourceId}`] : input.lockScopes;
    if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > MAX_LOCK_SCOPES) {
      throw new ProviderOperationError(`Provider operation requires 1-${MAX_LOCK_SCOPES} lock scopes`, 'INVALID_OPERATION_LOCKS');
    }
    const lockScopes = [...new Set(scopes.map(value => String(value).toLowerCase()))].sort();
    if (lockScopes.some(scope => !SAFE_LOCK.test(scope))) {
      throw new ProviderOperationError('Provider operation lock scope is invalid', 'INVALID_OPERATION_LOCKS');
    }
    this._policy.assertAllowed({ providerType, hostId });

    const requestHash = sha256(requestJson);
    const idempotencyHash = sha256(`${hostId}|${handler.type}|${idempotencyKey}`);
    const retry = RETRY_POLICIES[handler.retryPolicy];
    const operationId = `op_${generateToken(16).slice(0, 26)}`;
    let deduplicated = false;
    const storedId = this._db().transaction(() => {
      const existing = this._db().prepare(`SELECT id, request_hash FROM provider_operations
        WHERE host_id = ? AND operation_type = ? AND idempotency_key_hash = ?`)
        .get(hostId, handler.type, idempotencyHash);
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new ProviderOperationError('Idempotency key was already used for a different request', 'IDEMPOTENCY_KEY_CONFLICT', 409);
        }
        deduplicated = true; return existing.id;
      }
      this._db().prepare(`INSERT INTO provider_operations
        (id, operation_type, provider_type, host_id, resource_kind, resource_id, action,
         request_hash, request_enc, idempotency_key_hash, lock_scopes_json,
         retry_policy, max_attempts, timeout_seconds, available_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(operationId, handler.type, providerType, hostId, resourceKindName, resourceId, action,
          requestHash, encrypt(requestJson), idempotencyHash, JSON.stringify(lockScopes),
          handler.retryPolicy, retry.maxAttempts, handler.timeoutSeconds, _now(), input.createdBy || null);
      this._event(operationId, 'created', {
        state: 'queued', progress: 0, message: 'Provider operation queued',
        details: { providerType, hostId, resourceKind: resourceKindName, action },
      });
      return operationId;
    })();
    return { ...this.get(storedId), deduplicated };
  }

  get(id) {
    if (!SAFE_OPERATION_ID.test(String(id || ''))) return null;
    return _operationFromRow(this._db().prepare('SELECT * FROM provider_operations WHERE id = ?').get(id));
  }

  list(options = {}) {
    const limit = Math.min(500, Math.max(1, Number(options.limit) || 100));
    const where = [];
    const params = [];
    if (options.state) {
      if (!STATES.includes(options.state)) throw new ProviderOperationError('Unknown operation state', 'INVALID_OPERATION_STATE');
      where.push('state = ?'); params.push(options.state);
    }
    if (options.hostId !== undefined && options.hostId !== null) {
      const hostId = Number(options.hostId);
      if (!Number.isInteger(hostId) || hostId <= 0) throw new ProviderOperationError('Invalid operation host filter', 'INVALID_OPERATION_HOST');
      where.push('host_id = ?'); params.push(hostId);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this._db().prepare(`SELECT * FROM provider_operations ${clause}
      ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params, limit).map(_operationFromRow);
  }

  events(id, limit = 200) {
    if (!this.get(id)) throw new ProviderOperationError('Provider operation not found', 'OPERATION_NOT_FOUND', 404);
    limit = Math.min(500, Math.max(1, Number(limit) || 200));
    return this._db().prepare(`SELECT id, event_type, state, phase, progress, message, details_json, created_at
      FROM provider_operation_events WHERE operation_id = ? ORDER BY id DESC LIMIT ?`).all(id, limit)
      .map(row => ({
        id: row.id, type: row.event_type, state: row.state, phase: row.phase,
        progress: row.progress, message: row.message,
        details: _parseJson(row.details_json, null), createdAt: row.created_at,
      })).reverse();
  }

  _acquireLocks(row) {
    const scopes = _parseJson(row.lock_scopes_json, []);
    const expiry = _future(this._leaseMs);
    return this._db().transaction(() => {
      this._db().prepare('DELETE FROM provider_operation_locks WHERE lease_expires_at <= ?').run(_now());
      const find = this._db().prepare('SELECT operation_id, lease_owner FROM provider_operation_locks WHERE scope_key = ?');
      for (const scope of scopes) {
        const lock = find.get(scope);
        if (lock && (lock.operation_id !== row.id || lock.lease_owner !== this._owner)) return false;
      }
      const upsert = this._db().prepare(`INSERT INTO provider_operation_locks
        (scope_key, operation_id, lease_owner, lease_expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(scope_key) DO UPDATE SET operation_id = excluded.operation_id,
          lease_owner = excluded.lease_owner, lease_expires_at = excluded.lease_expires_at,
          updated_at = excluded.updated_at`);
      for (const scope of scopes) upsert.run(scope, row.id, this._owner, expiry, _now());
      return true;
    })();
  }

  _renewLease(operationId, durationMs = this._leaseMs) {
    const expiry = _future(durationMs);
    this._db().prepare(`UPDATE provider_operations SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND lease_owner = ?`).run(expiry, _now(), operationId, this._owner);
    this._db().prepare(`UPDATE provider_operation_locks SET lease_expires_at = ?, updated_at = ?
      WHERE operation_id = ? AND lease_owner = ?`).run(expiry, _now(), operationId, this._owner);
  }

  _releaseLocks(operationId) {
    this._db().prepare('DELETE FROM provider_operation_locks WHERE operation_id = ?').run(operationId);
  }

  _claim(row) {
    const nextState = ['reconciling', 'cancel_requested'].includes(row.state) ? row.state : 'running';
    const attemptIncrement = ['queued', 'waiting_retry'].includes(row.state) ? 1 : 0;
    const result = this._db().prepare(`UPDATE provider_operations SET
      state = ?, attempt = attempt + ?, lease_owner = ?, lease_expires_at = ?,
      started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ? AND state = ?`)
      .run(nextState, attemptIncrement, this._owner, _future(this._leaseMs), _now(), _now(), row.id, row.state);
    if (!result.changes) return null;
    const claimed = this._db().prepare('SELECT * FROM provider_operations WHERE id = ?').get(row.id);
    this._event(row.id, nextState === 'reconciling' ? 'reconcile_started' : 'started', {
      state: nextState, phase: claimed.phase, progress: claimed.progress,
      message: nextState === 'reconciling' ? 'Provider operation reconciliation started' : 'Provider operation started',
      details: { attempt: claimed.attempt },
    });
    return claimed;
  }

  _executionContext(row, signal) {
    const requestJson = decrypt(row.request_enc);
    if (sha256(requestJson) !== row.request_hash) throw new Error('Provider operation request integrity check failed');
    return {
      operation: _operationFromRow(row),
      request: JSON.parse(requestJson), signal,
      nativeTaskRef: row.native_task_ref_enc ? decrypt(row.native_task_ref_enc) : null,
      reportProgress: (progress, phase, message, details) => {
        const bounded = Math.min(99, Math.max(0, Math.round(Number(progress) || 0)));
        const safePhase = _safeString(phase, 120);
        const updated = this._db().prepare(`UPDATE provider_operations SET progress = ?, phase = ?, updated_at = ?
          WHERE id = ? AND lease_owner = ? AND state IN ('running', 'reconciling', 'cancel_requested')`)
          .run(bounded, safePhase, _now(), row.id, this._owner);
        if (!updated.changes) return false;
        this._renewLease(row.id);
        this._event(row.id, 'progress', { state: 'running', progress: bounded, phase: safePhase, message, details });
        return true;
      },
      bindNativeTask: (nativeRef, state) => {
        const ref = String(nativeRef || '');
        if (!ref || ref.length > 2048) throw new Error('Native provider task reference is invalid');
        const updated = this._db().prepare(`UPDATE provider_operations SET native_task_ref_hash = ?,
          native_task_ref_enc = ?, native_task_state = ?, updated_at = ?
          WHERE id = ? AND lease_owner = ? AND state IN ('running', 'reconciling', 'cancel_requested')`)
          .run(sha256(ref), encrypt(ref), _safeString(state, 80), _now(), row.id, this._owner);
        if (!updated.changes) return false;
        this._renewLease(row.id);
        this._event(row.id, 'native_task_bound', {
          state: 'running', phase: row.phase, progress: row.progress,
          message: 'Native provider task attached', details: { nativeTaskState: _safeString(state, 80) },
        });
        return true;
      },
    };
  }

  _finish(operationId, state, options = {}) {
    if (!TERMINAL_STATES.has(state)) throw new Error(`Invalid terminal provider operation state: ${state}`);
    const code = options.errorCode ? _safeCode(options.errorCode) : null;
    const message = _safeString(options.errorMessage, 240);
    const resultJson = options.result === undefined ? null : _safeJson(options.result);
    this._db().prepare(`UPDATE provider_operations SET state = ?, progress = ?, phase = ?,
      result_json = ?, error_code = ?, error_message = ?, lease_owner = NULL,
      lease_expires_at = NULL, completed_at = ?, updated_at = ? WHERE id = ?`)
      .run(state, state === 'succeeded' ? 100 : Math.min(99, Math.max(0, options.progress ?? this.get(operationId)?.progress ?? 0)),
        _safeString(options.phase, 120), resultJson, code, message, _now(), _now(), operationId);
    if (RELEASING_STATES.has(state)) this._releaseLocks(operationId);
    else this._renewUnknownLocks(operationId);
    this._event(operationId, state, {
      state, progress: state === 'succeeded' ? 100 : this.get(operationId)?.progress,
      phase: options.phase, message: message || `Provider operation ${state}`,
      details: options.eventDetails,
    });
    return this.get(operationId);
  }

  _renewUnknownLocks(operationId) {
    const expiry = _future(24 * 60 * 60 * 1000);
    this._db().prepare(`UPDATE provider_operation_locks SET lease_expires_at = ?, updated_at = ?
      WHERE operation_id = ?`).run(expiry, _now(), operationId);
  }

  _refreshUnknownLocks() {
    const rows = this._db().prepare(`SELECT id, lock_scopes_json FROM provider_operations WHERE state = 'unknown'`).all();
    const expiry = _future(24 * 60 * 60 * 1000);
    const find = this._db().prepare('SELECT operation_id FROM provider_operation_locks WHERE scope_key = ?');
    const insert = this._db().prepare(`INSERT INTO provider_operation_locks
      (scope_key, operation_id, lease_owner, lease_expires_at, updated_at)
      VALUES (?, ?, 'unknown-state', ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET lease_expires_at = excluded.lease_expires_at,
        updated_at = excluded.updated_at
      WHERE provider_operation_locks.operation_id = excluded.operation_id`);
    this._db().transaction(() => {
      for (const row of rows) {
        for (const scope of _parseJson(row.lock_scopes_json, [])) {
          const existing = find.get(scope);
          if (!existing || existing.operation_id === row.id) insert.run(scope, row.id, expiry, _now());
        }
      }
    })();
    this._lastUnknownLockRefresh = Date.now();
    return rows.length;
  }

  _schedule(operationId, state, delayMs, options = {}) {
    const availableAt = _future(delayMs);
    this._db().prepare(`UPDATE provider_operations SET state = ?, available_at = ?,
      phase = COALESCE(?, phase), error_code = ?, error_message = ?,
      lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
      .run(state, availableAt, _safeString(options.phase, 120), options.errorCode ? _safeCode(options.errorCode) : null,
        _safeString(options.errorMessage, 240), _now(), operationId);
    this._renewLeaseForWait(operationId, delayMs + this._leaseMs);
    this._event(operationId, state, {
      state, phase: options.phase, progress: this.get(operationId)?.progress,
      message: options.message || `Provider operation entered ${state}`,
      details: { availableAt, attempt: this.get(operationId)?.attempt },
    });
  }

  _renewLeaseForWait(operationId, durationMs) {
    const expiry = _future(durationMs);
    this._db().prepare(`UPDATE provider_operation_locks SET lease_expires_at = ?, updated_at = ?
      WHERE operation_id = ?`).run(expiry, _now(), operationId);
  }

  _retryDelay(policyName, attempt) {
    const policy = RETRY_POLICIES[policyName];
    const base = Math.min(policy.capMs, policy.baseMs * (2 ** Math.max(0, attempt - 1)));
    const spread = base * policy.jitter;
    return Math.max(0, Math.round(base - spread + (Math.random() * spread * 2)));
  }

  _isTransient(err) {
    return err?.transient === true || TRANSIENT_CODES.has(String(err?.code || '').toUpperCase());
  }

  async _runCancel(row, handler, context) {
    if (row.attempt === 0 && !row.native_task_ref_enc) {
      return this._finish(row.id, 'cancelled', { errorCode: 'CANCELLED_BEFORE_START', errorMessage: 'Operation cancelled before execution' });
    }
    if (typeof handler?.cancel !== 'function') {
      return this._finish(row.id, 'unknown', { errorCode: 'CANCEL_UNCONFIRMED', errorMessage: 'Provider cancellation could not be confirmed' });
    }
    try {
      const result = await handler.cancel(context);
      if (result?.confirmed === true) {
        return this._finish(row.id, 'cancelled', { result: result.result, errorCode: 'CANCELLED', errorMessage: 'Provider cancellation confirmed' });
      }
      return this._finish(row.id, 'unknown', { result, errorCode: 'CANCEL_UNCONFIRMED', errorMessage: 'Provider cancellation could not be confirmed' });
    } catch (err) {
      return this._finish(row.id, 'unknown', { errorCode: 'CANCEL_FAILED', errorMessage: _safeString(err?.message) || 'Provider cancellation failed' });
    }
  }

  async _invokeWithGuards(fn, context, timeoutSeconds) {
    let timeoutId;
    let abortListener;
    const handlerPromise = Promise.resolve().then(() => fn(context));
    handlerPromise.catch(() => {});
    const timeoutPromise = new Promise(resolve => {
      timeoutId = setTimeout(() => resolve({ __guard: 'timeout' }), timeoutSeconds * 1000);
    });
    const abortPromise = new Promise(resolve => {
      if (context.signal.aborted) resolve({ __guard: 'cancel' });
      else {
        abortListener = () => resolve({ __guard: 'cancel' });
        context.signal.addEventListener('abort', abortListener, { once: true });
      }
    });
    try { return await Promise.race([handlerPromise, timeoutPromise, abortPromise]); }
    finally {
      clearTimeout(timeoutId);
      if (abortListener) context.signal.removeEventListener('abort', abortListener);
    }
  }

  async _dispatch(operationId, controller) {
    let row = this._db().prepare('SELECT * FROM provider_operations WHERE id = ?').get(operationId);
    if (!row || TERMINAL_STATES.has(row.state)) return;
    const handler = this._handlers.get(row.operation_type);
    if (!handler) {
      this._schedule(row.id, row.state === 'cancel_requested' ? 'cancel_requested' : 'reconciling', 30_000, {
        errorCode: 'OPERATION_HANDLER_UNAVAILABLE', errorMessage: 'Operation handler is not loaded',
      });
      return;
    }
    let decision;
    try { decision = this._policy.evaluate({ providerType: row.provider_type, hostId: row.host_id }); }
    catch (err) {
      log.error('Provider operation policy evaluation failed', { operationId, error: err.name });
      this._schedule(row.id, row.state, 30_000, { errorCode: 'OPERATION_POLICY_UNAVAILABLE', errorMessage: 'Operation policy could not be evaluated' });
      return;
    }
    if (!decision.allowed && row.state !== 'cancel_requested') {
      if (decision.mode === 'emergency_stop') {
        this._finish(row.id, 'cancelled', { errorCode: decision.code, errorMessage: decision.reason });
      } else {
        const delay = decision.freezeEndsAt ? Math.max(1000, Date.parse(decision.freezeEndsAt) - Date.now()) : 60_000;
        this._schedule(row.id, row.state, delay, { errorCode: decision.code, errorMessage: decision.reason });
      }
      return;
    }
    if (!this._acquireLocks(row)) {
      this._schedule(row.id, row.state, 1000, { errorCode: 'RESOURCE_LOCKED', errorMessage: 'Required resource lock is busy' });
      return;
    }
    row = this._claim(row);
    if (!row) return;
    const heartbeat = setInterval(() => {
      try { this._renewLease(row.id); } catch { /* next worker pass will reconcile */ }
    }, Math.max(500, Math.floor(this._leaseMs / 3)));
    heartbeat.unref?.();
    let context;
    try {
      context = this._executionContext(row, controller.signal);
      if (row.state === 'cancel_requested') {
        await this._runCancel(row, handler, context); return;
      }
      const method = row.state === 'reconciling' ? handler.reconcile : handler.execute;
      if (typeof method !== 'function') {
        this._finish(row.id, 'unknown', {
          errorCode: 'RECONCILIATION_UNAVAILABLE', errorMessage: 'Operation result requires manual verification',
        });
        return;
      }
      const result = await this._invokeWithGuards(method, context, row.timeout_seconds);
      if (result?.__guard === 'cancel') {
        if (controller._shutdown === true) {
          this._schedule(row.id, 'reconciling', 1000, {
            errorCode: 'WORKER_SHUTDOWN', errorMessage: 'Worker stopped; operation reconciliation is scheduled',
          });
          return;
        }
        await this._runCancel(this._db().prepare('SELECT * FROM provider_operations WHERE id = ?').get(row.id), handler, context);
        return;
      }
      if (result?.__guard === 'timeout') {
        if (typeof handler.reconcile === 'function') {
          this._schedule(row.id, 'reconciling', 1000, {
            errorCode: 'OPERATION_TIMEOUT', errorMessage: 'Provider response timed out; reconciliation is scheduled',
          });
        } else {
          this._finish(row.id, 'unknown', {
            errorCode: 'OPERATION_TIMEOUT', errorMessage: 'Provider response timed out and cannot be reconciled automatically',
          });
        }
        return;
      }
      const outcome = result && typeof result === 'object' && result.state ? result.state : 'succeeded';
      if (result?.nativeTaskRef) context.bindNativeTask(result.nativeTaskRef, result.nativeTaskState || 'pending');
      if (outcome === 'reconciling') {
        this._schedule(row.id, 'reconciling', Math.min(300_000, Math.max(500, Number(result.delayMs) || 2000)), {
          phase: result.phase, message: 'Waiting for native provider task reconciliation',
        });
      } else if (outcome === 'unknown') {
        this._finish(row.id, 'unknown', { result: result.result, errorCode: 'OPERATION_RESULT_UNKNOWN', errorMessage: 'Provider result requires manual verification' });
      } else if (outcome === 'succeeded') {
        this._finish(row.id, 'succeeded', { result: result?.result ?? result, phase: result?.phase });
      } else {
        throw Object.assign(new Error('Provider operation handler returned an invalid state'), { code: 'INVALID_HANDLER_RESULT' });
      }
    } catch (err) {
      const current = this._db().prepare('SELECT * FROM provider_operations WHERE id = ?').get(row.id);
      if (current && !handler.idempotent && typeof handler.reconcile === 'function' && this._isTransient(err)) {
        this._schedule(row.id, 'reconciling', 1000, {
          errorCode: String(err.code || 'TRANSIENT_PROVIDER_ERROR').toUpperCase(),
          errorMessage: 'Provider response was interrupted; reconciliation is scheduled without retrying the mutation',
        });
      } else if (current && handler.idempotent && this._isTransient(err) && current.attempt < current.max_attempts) {
        this._schedule(row.id, 'waiting_retry', this._retryDelay(current.retry_policy, current.attempt), {
          errorCode: String(err.code || 'TRANSIENT_PROVIDER_ERROR').toUpperCase(),
          errorMessage: 'Transient provider error; retry is scheduled',
        });
      } else {
        this._finish(row.id, 'failed', {
          errorCode: String(err?.code || 'PROVIDER_OPERATION_FAILED').toUpperCase(),
          errorMessage: _safeString(err?.message) || 'Provider operation failed',
        });
      }
    } finally { clearInterval(heartbeat); }
  }

  async tick() {
    if (this._ticking) return [];
    this._ticking = true;
    try {
      if (Date.now() - this._lastUnknownLockRefresh >= 60_000) this._refreshUnknownLocks();
      const capacity = this._concurrency - this._active.size;
      if (capacity <= 0) return [];
      const placeholders = DUE_STATES.map(() => '?').join(',');
      const rows = this._db().prepare(`SELECT * FROM provider_operations
        WHERE state IN (${placeholders}) AND available_at <= ?
        ORDER BY created_at, id LIMIT ?`).all(...DUE_STATES, _now(), capacity * 2);
      const launched = [];
      for (const row of rows) {
        if (launched.length >= capacity || this._active.has(row.id)) continue;
        const controller = new AbortController();
        const promise = this._dispatch(row.id, controller)
          .catch(err => log.error('Provider operation worker failure', { operationId: row.id, error: err.name }))
          .finally(() => this._active.delete(row.id));
        this._active.set(row.id, { promise, controller });
        launched.push(promise);
      }
      await Promise.allSettled(launched);
      return launched;
    } finally { this._ticking = false; }
  }

  recoverExpired() {
    const expired = this._db().prepare(`SELECT id, state FROM provider_operations
      WHERE state IN ('running', 'cancel_requested')
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`)
      .all(_now());
    for (const row of expired) {
      const state = row.state === 'cancel_requested' ? 'cancel_requested' : 'reconciling';
      this._db().prepare(`UPDATE provider_operations SET state = ?, available_at = ?,
        lease_owner = NULL, lease_expires_at = NULL, error_code = 'WORKER_LEASE_EXPIRED',
        error_message = 'Worker lease expired; result reconciliation is required', updated_at = ? WHERE id = ?`)
        .run(state, _now(), _now(), row.id);
      this._event(row.id, 'recovered', { state, message: 'Operation recovered after an expired worker lease' });
    }
    this._refreshUnknownLocks();
    return expired.length;
  }

  start() {
    if (this._timer) return false;
    const recovered = this.recoverExpired();
    this._timer = setInterval(() => { this.tick().catch(() => {}); }, this._pollMs);
    this._timer.unref?.();
    this.tick().catch(() => {});
    log.info('Provider operation worker started', { owner: this._owner, concurrency: this._concurrency, recovered });
    return true;
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    for (const active of this._active.values()) {
      active.controller._shutdown = true;
      active.controller.abort();
    }
    return true;
  }

  requestCancel(id) {
    const row = this._db().prepare('SELECT * FROM provider_operations WHERE id = ?').get(id);
    if (!row) throw new ProviderOperationError('Provider operation not found', 'OPERATION_NOT_FOUND', 404);
    if (TERMINAL_STATES.has(row.state)) throw new ProviderOperationError(`Operation is already ${row.state}`, 'OPERATION_ALREADY_TERMINAL', 409);
    this._db().prepare(`UPDATE provider_operations SET state = 'cancel_requested',
      cancel_requested_at = ?, available_at = ?, updated_at = ? WHERE id = ?`)
      .run(_now(), _now(), _now(), id);
    this._event(id, 'cancel_requested', { state: 'cancel_requested', progress: row.progress, message: 'Provider operation cancellation requested' });
    this._active.get(id)?.controller.abort();
    return this.get(id);
  }

  resolveUnknown(id, resolution, evidence, resolvedBy) {
    if (!['succeeded', 'failed', 'cancelled'].includes(resolution)) {
      throw new ProviderOperationError('Resolution must be succeeded, failed, or cancelled', 'INVALID_OPERATION_RESOLUTION');
    }
    const safeEvidence = _safeString(evidence, 1000);
    if (!safeEvidence || safeEvidence.length < 8) {
      throw new ProviderOperationError('Manual resolution requires evidence', 'RESOLUTION_EVIDENCE_REQUIRED');
    }
    const result = this._db().prepare(`UPDATE provider_operations SET state = ?, resolution = ?,
      resolution_evidence = ?, resolved_by = ?, completed_at = COALESCE(completed_at, ?),
      error_code = CASE WHEN ? = 'succeeded' THEN NULL ELSE error_code END,
      error_message = CASE WHEN ? = 'succeeded' THEN NULL ELSE error_message END,
      updated_at = ? WHERE id = ? AND state = 'unknown'`)
      .run(resolution, resolution, safeEvidence, resolvedBy || null, _now(), resolution, resolution, _now(), id);
    if (!result.changes) {
      if (!this.get(id)) throw new ProviderOperationError('Provider operation not found', 'OPERATION_NOT_FOUND', 404);
      throw new ProviderOperationError('Only an unknown operation can be resolved manually', 'OPERATION_NOT_UNKNOWN', 409);
    }
    this._releaseLocks(id);
    this._event(id, 'manually_resolved', {
      state: resolution, progress: this.get(id).progress,
      message: `Unknown operation resolved as ${resolution}`,
      details: { evidence: safeEvidence, resolvedBy: resolvedBy || null },
    });
    return this.get(id);
  }

  applyEmergencyStop(policy) {
    if (policy?.mode !== 'emergency_stop') return { cancelled: 0, cancelRequested: 0 };
    const where = [];
    const params = [];
    if (policy.scope_type === 'provider') { where.push('provider_type = ?'); params.push(policy.scope_key); }
    if (policy.scope_type === 'host') { where.push('host_id = ?'); params.push(Number(policy.scope_key)); }
    const clause = where.length ? `AND ${where.join(' AND ')}` : '';
    const rows = this._db().prepare(`SELECT * FROM provider_operations
      WHERE state NOT IN ('succeeded','failed','cancelled','unknown') ${clause}`).all(...params);
    let cancelled = 0; let cancelRequested = 0;
    for (const row of rows) {
      if (row.attempt > 0 || row.native_task_ref_enc) {
        if (row.state !== 'cancel_requested') this.requestCancel(row.id);
        else this._active.get(row.id)?.controller.abort();
        cancelRequested += 1;
      } else {
        this._finish(row.id, 'cancelled', {
          errorCode: 'PROVIDER_EMERGENCY_STOP', errorMessage: 'Operation cancelled by provider emergency stop',
        });
        cancelled += 1;
      }
    }
    return { cancelled, cancelRequested };
  }
}

module.exports = {
  ProviderOperationEngine, ProviderOperationError, STATES, TERMINAL_STATES, RETRY_POLICIES,
  _internals: {
    _safeString, _safeCode, _safeValue, _safeJson, _operationFromRow,
    SAFE_OPERATION_ID, SAFE_RESOURCE_ID, MAX_REQUEST_BYTES, MAX_SAFE_JSON_BYTES,
  },
};
