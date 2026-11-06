'use strict';

const config = require('../../config');
const { getDb } = require('../../db');

const MODES = new Set(['active', 'read_only', 'emergency_stop', 'frozen']);
const SCOPE_TYPES = new Set(['global', 'provider', 'host']);

class OperationPolicyError extends Error {
  constructor(message, code, policy) {
    super(message);
    this.name = 'OperationPolicyError';
    this.code = code;
    this.status = 423;
    this.policy = policy || null;
  }
}

function _safeText(value, max = 240) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

function _iso(value, field) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${field} must be a valid timestamp`);
  return date.toISOString();
}

class OperationPolicyService {
  constructor(dbProvider = getDb) {
    this._dbProvider = dbProvider;
  }

  _db() { return this._dbProvider(); }

  _activePolicy(row, atMs) {
    if (!row || row.mode === 'active') return false;
    if (row.mode !== 'frozen') return true;
    const starts = row.freeze_starts_at ? Date.parse(row.freeze_starts_at) : Number.NEGATIVE_INFINITY;
    const ends = row.freeze_ends_at ? Date.parse(row.freeze_ends_at) : Number.POSITIVE_INFINITY;
    return atMs >= starts && atMs < ends;
  }

  evaluate({ providerType, hostId, at = new Date() } = {}) {
    if (config.features?.readOnly) {
      return { allowed: false, code: 'GLOBAL_READ_ONLY', mode: 'read_only', scopeType: 'environment', scopeKey: 'READ_ONLY_MODE', reason: 'System is in read-only mode' };
    }
    let rows;
    try {
      rows = this._db().prepare(`SELECT scope_type, scope_key, mode, reason, freeze_starts_at, freeze_ends_at
        FROM provider_operation_policies
        WHERE (scope_type = 'global' AND scope_key = '*')
           OR (scope_type = 'provider' AND scope_key = ?)
           OR (scope_type = 'host' AND scope_key = ?)`)
        .all(String(providerType || '').toLowerCase(), String(Number(hostId) || ''));
    } catch (err) {
      if (/no such table/i.test(String(err?.message || ''))) return { allowed: true };
      throw err;
    }
    const rank = { emergency_stop: 3, read_only: 2, frozen: 1, active: 0 };
    const blocked = rows.filter(row => this._activePolicy(row, new Date(at).getTime()))
      .sort((a, b) => rank[b.mode] - rank[a.mode])[0];
    if (!blocked) return { allowed: true };
    const codes = { emergency_stop: 'PROVIDER_EMERGENCY_STOP', read_only: 'OPERATION_READ_ONLY', frozen: 'OPERATION_FROZEN' };
    const messages = {
      emergency_stop: 'Provider operations are stopped by emergency policy',
      read_only: 'Provider operations are blocked by read-only policy',
      frozen: 'Provider operations are blocked by a maintenance freeze',
    };
    return {
      allowed: false, code: codes[blocked.mode], mode: blocked.mode,
      scopeType: blocked.scope_type, scopeKey: blocked.scope_key,
      reason: _safeText(blocked.reason) || messages[blocked.mode],
      freezeStartsAt: blocked.freeze_starts_at || null,
      freezeEndsAt: blocked.freeze_ends_at || null,
    };
  }

  assertAllowed(context) {
    const decision = this.evaluate(context);
    if (!decision.allowed) throw new OperationPolicyError(decision.reason, decision.code, decision);
    return decision;
  }

  globalHttpGate() {
    return this.evaluate({});
  }

  list() {
    return this._db().prepare(`SELECT id, scope_type, scope_key, mode, reason,
      freeze_starts_at, freeze_ends_at, updated_by, updated_at
      FROM provider_operation_policies ORDER BY scope_type, scope_key`).all();
  }

  set({ scopeType, scopeKey, mode, reason, freezeStartsAt, freezeEndsAt, updatedBy }) {
    scopeType = String(scopeType || '').toLowerCase();
    mode = String(mode || '').toLowerCase();
    if (!SCOPE_TYPES.has(scopeType)) throw new Error('Policy scopeType must be global, provider, or host');
    if (!MODES.has(mode)) throw new Error('Policy mode must be active, read_only, emergency_stop, or frozen');
    if (scopeType === 'global') scopeKey = '*';
    else if (scopeType === 'provider') {
      scopeKey = String(scopeKey || '').toLowerCase();
      if (!/^[a-z][a-z0-9_-]{1,39}$/.test(scopeKey)) throw new Error('Provider policy scope is invalid');
    } else {
      const hostId = Number(scopeKey);
      if (!Number.isInteger(hostId) || hostId <= 0) throw new Error('Host policy scope is invalid');
      if (!this._db().prepare('SELECT id FROM docker_hosts WHERE id = ?').get(hostId)) throw new Error('Provider host not found');
      scopeKey = String(hostId);
    }
    const safeReason = _safeText(reason);
    let starts = _iso(freezeStartsAt, 'freezeStartsAt');
    let ends = _iso(freezeEndsAt, 'freezeEndsAt');
    if (mode === 'frozen') {
      starts = starts || new Date().toISOString();
      if (!ends || Date.parse(ends) <= Date.parse(starts)) throw new Error('Frozen policy requires freezeEndsAt after freezeStartsAt');
    } else {
      starts = null; ends = null;
    }
    if (mode !== 'active' && !safeReason) throw new Error('Blocking policy requires a reason');
    this._db().prepare(`INSERT INTO provider_operation_policies
      (scope_type, scope_key, mode, reason, freeze_starts_at, freeze_ends_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(scope_type, scope_key) DO UPDATE SET
        mode = excluded.mode, reason = excluded.reason,
        freeze_starts_at = excluded.freeze_starts_at, freeze_ends_at = excluded.freeze_ends_at,
        updated_by = excluded.updated_by, updated_at = datetime('now')`)
      .run(scopeType, scopeKey, mode, safeReason, starts, ends, updatedBy || null);
    return this._db().prepare(`SELECT id, scope_type, scope_key, mode, reason,
      freeze_starts_at, freeze_ends_at, updated_by, updated_at
      FROM provider_operation_policies WHERE scope_type = ? AND scope_key = ?`).get(scopeType, scopeKey);
  }
}

const policyService = new OperationPolicyService();

module.exports = policyService;
module.exports.OperationPolicyService = OperationPolicyService;
module.exports.OperationPolicyError = OperationPolicyError;
module.exports._internals = { _safeText };
