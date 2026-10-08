'use strict';

const crypto = require('crypto');
const net = require('net');
const { getDb } = require('../db');

const KEY = /^[A-Za-z][A-Za-z0-9_.:/@+-]{0,199}$/;
const HASH = /^[a-f0-9]{64}$/;
const CURRENCY = /^[A-Z]{3}$/;
const SECRET = /password|credential|private.?key|authorization|cookie|secret.?value|access.?token|native.?ref|provider.?url/i;
const ACTIONS = new Set(['allocate', 'map', 'unmap', 'release']);
const FAMILIES = new Set(['ipv4', 'ipv6']);
const PROTOCOLS = new Set(['any', 'tcp', 'udp']);
const CONFLICTS = new Set(['clear', 'conflict', 'unknown']);
const ALLOCATION_STATES = new Set(['absent', 'allocated', 'mapped', 'released', 'unknown']);

class NetworkPublicIpPlanError extends Error {
  constructor(message, code = 'NETWORK_PUBLIC_IP_PLAN_ERROR', status = 400, details = null) {
    super(message); this.name = 'NetworkPublicIpPlanError'; this.code = code; this.status = status; this.details = details;
  }
}
function fail(message, code = 'INVALID_PUBLIC_IP_PLAN', status = 400, details = null) {
  throw new NetworkPublicIpPlanError(message, code, status, details);
}
function exact(value, field, allowed) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} is invalid`);
  const unexpected = Object.keys(value).filter(name => !allowed.includes(name)); if (unexpected.length) {
    const secret = unexpected.find(name => SECRET.test(name)); fail(secret ? `${field}.${secret} may not contain sensitive provider material`
      : `Unexpected ${field} fields: ${unexpected.join(', ')}`, secret ? 'SECRET_FIELD' : 'UNEXPECTED_FIELD'); } }
function text(value, field, max = 300) { const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) fail(`${field} is invalid`); return result; }
function key(value, field) { const result = text(value, field, 200); if (!KEY.test(result)) fail(`${field} is invalid`); return result; }
function integer(value, field, min, max) { const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) fail(`${field} is invalid`); return result; }
function instant(value, field) { const result = text(value, field, 40); const parsed = Date.parse(result);
  if (!Number.isFinite(parsed)) fail(`${field} is invalid`); return new Date(parsed).toISOString(); }
function bool(value, field) { if (typeof value !== 'boolean') fail(`${field} is invalid`); return value; }
function choice(value, field, values) { const result = String(value || ''); if (!values.has(result)) fail(`${field} is invalid`); return result; }
function ip(value, field) { const result = text(value, field, 80); if (!net.isIP(result)) fail(`${field} is invalid`); return result; }
function checksum(value, field) { const result = String(value || '').toLowerCase(); if (!HASH.test(result)) fail(`${field} is invalid`); return result; }
function array(value, field, min, max, mapper) { if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${field} is invalid`);
  return value.map((item, index) => mapper(item, index)); }
function unique(values, field) { if (new Set(values).size !== values.length) fail(`${field} contains duplicates`); return values; }
function canonical(value) { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical(value[name])])) : value; }
function stable(value) { return JSON.stringify(canonical(value)); }
function hash(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex'); }
function parse(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }

function normalize(body) {
  exact(body, 'publicIpPlan', ['scopeKey', 'providerType', 'action', 'addressFamily', 'publicAddress', 'target',
    'ownership', 'quota', 'cost', 'conflictState', 'allocationState', 'expectedVersion', 'mappingCount',
    'dependentResourceKeys', 'capability', 'checks']);
  const scopeKey = key(body.scopeKey, 'scopeKey'); const providerType = key(body.providerType, 'providerType');
  const action = choice(body.action, 'action', ACTIONS); const addressFamily = choice(body.addressFamily, 'addressFamily', FAMILIES);
  const publicAddress = body.publicAddress == null ? null : ip(body.publicAddress, 'publicAddress');
  if (publicAddress && ((addressFamily === 'ipv4' && net.isIP(publicAddress) !== 4)
    || (addressFamily === 'ipv6' && net.isIP(publicAddress) !== 6))) fail('publicAddress does not match addressFamily');
  let target = null;
  if (body.target != null) {
    exact(body.target, 'target', ['resourceKey', 'privateAddress', 'privatePort', 'publicPort', 'protocol']);
    target = { resourceKey: key(body.target.resourceKey, 'target.resourceKey'), privateAddress: ip(body.target.privateAddress, 'target.privateAddress'),
      privatePort: body.target.privatePort == null ? null : integer(body.target.privatePort, 'target.privatePort', 1, 65535),
      publicPort: body.target.publicPort == null ? null : integer(body.target.publicPort, 'target.publicPort', 1, 65535),
      protocol: choice(body.target.protocol, 'target.protocol', PROTOCOLS) };
    if (net.isIP(target.privateAddress) !== (addressFamily === 'ipv4' ? 4 : 6)) fail('target.privateAddress does not match addressFamily');
    if ((target.privatePort == null) !== (target.publicPort == null)) fail('privatePort and publicPort must be supplied together');
    if (target.privatePort != null && target.protocol === 'any') fail('Port mapping requires tcp or udp protocol');
    if (target.privatePort == null && target.protocol !== 'any') fail('Address-only mapping must use any protocol');
  }
  exact(body.ownership, 'ownership', ['tenantKey', 'ownerKey', 'ownershipToken', 'managed']); const ownership = {
    tenantKey: key(body.ownership.tenantKey, 'tenantKey'), ownerKey: key(body.ownership.ownerKey, 'ownerKey'),
    ownershipToken: key(body.ownership.ownershipToken, 'ownershipToken'), managed: bool(body.ownership.managed, 'ownership.managed'),
  };
  exact(body.quota, 'quota', ['limit', 'used', 'requested']); const quota = {
    limit: integer(body.quota.limit, 'quota.limit', 0, 1000000), used: integer(body.quota.used, 'quota.used', 0, 1000000),
    requested: integer(body.quota.requested, 'quota.requested', 0, 1000),
  };
  exact(body.cost, 'cost', ['currency', 'hourlyMicros', 'source', 'observedAt']); const currency = text(body.cost.currency, 'cost.currency', 3).toUpperCase();
  if (!CURRENCY.test(currency)) fail('cost.currency is invalid'); const cost = { currency,
    hourlyMicros: integer(body.cost.hourlyMicros, 'cost.hourlyMicros', 0, Number.MAX_SAFE_INTEGER),
    source: key(body.cost.source, 'cost.source'), observedAt: instant(body.cost.observedAt, 'cost.observedAt') };
  const conflictState = choice(body.conflictState, 'conflictState', CONFLICTS);
  const allocationState = choice(body.allocationState, 'allocationState', ALLOCATION_STATES);
  const expectedVersion = body.expectedVersion == null ? null : text(body.expectedVersion, 'expectedVersion', 120);
  const mappingCount = integer(body.mappingCount, 'mappingCount', 0, 1000000);
  const dependentResourceKeys = unique(array(body.dependentResourceKeys || [], 'dependentResourceKeys', 0, 5000,
    value => key(value, 'dependentResourceKey')).sort(), 'dependentResourceKeys');
  exact(body.capability, 'capability', ['supported', 'reason']); const capability = {
    supported: bool(body.capability.supported, 'capability.supported'), reason: text(body.capability.reason, 'capability.reason', 500),
  };
  const checks = array(body.checks || [], 'checks', 1, 100, check => { exact(check, 'check', ['name', 'state', 'evidenceHash']);
    const state = String(check.state || ''); if (!['pass', 'fail', 'unknown'].includes(state)) fail('check.state is invalid');
    return { name: key(check.name, 'check.name'), state, evidenceHash: checksum(check.evidenceHash, 'check.evidenceHash') }; });
  unique(checks.map(check => check.name), 'check.name');
  return { scopeKey, providerType, action, addressFamily, publicAddress, target, ownership, quota, cost,
    conflictState, allocationState, expectedVersion, mappingCount, dependentResourceKeys, capability, checks };
}

function plan(input) {
  const blockers = [];
  if (!input.capability.supported) blockers.push('provider_capability_unsupported');
  if (input.conflictState !== 'clear') blockers.push(`conflict_${input.conflictState}`);
  if (input.checks.some(check => check.state !== 'pass')) blockers.push('checks_incomplete');
  if (input.action === 'allocate') {
    if (input.target) blockers.push('allocate_target_not_allowed');
    if (!['absent', 'released'].includes(input.allocationState)) blockers.push('allocation_state_invalid');
    if (input.quota.requested !== 1) blockers.push('quota_request_must_equal_one');
    if (input.quota.used + input.quota.requested > input.quota.limit) blockers.push('quota_exceeded');
  }
  if (input.action === 'map') {
    if (!input.publicAddress) blockers.push('public_address_required'); if (!input.target) blockers.push('target_required');
    if (input.allocationState !== 'allocated') blockers.push('allocation_state_invalid');
    if (!input.expectedVersion) blockers.push('expected_version_required');
  }
  if (input.action === 'unmap') {
    if (!input.publicAddress) blockers.push('public_address_required'); if (!input.target) blockers.push('target_required');
    if (input.allocationState !== 'mapped') blockers.push('allocation_state_invalid');
    if (!input.expectedVersion) blockers.push('expected_version_required'); if (input.mappingCount < 1) blockers.push('mapping_missing');
  }
  if (input.action === 'release') {
    if (!input.publicAddress) blockers.push('public_address_required'); if (input.target) blockers.push('release_target_not_allowed');
    if (input.allocationState !== 'allocated') blockers.push('allocation_state_invalid');
    if (!input.expectedVersion) blockers.push('expected_version_required'); if (!input.ownership.managed) blockers.push('managed_ownership_required');
    if (input.mappingCount > 0) blockers.push('active_mappings'); if (input.dependentResourceKeys.length) blockers.push('dependent_resources');
  }
  return { blockers: [...new Set(blockers)], state: blockers.length ? 'blocked' : 'ready' };
}

function publicPlan(row) {
  if (!row) return null; const value = parse(row.plan_json, {}); return { schemaVersion: '1.0', id: Number(row.id),
    ...value, blockers: parse(row.blockers_json, []), state: row.state, planHash: row.plan_hash,
    providerMutationsStarted: 0, externalMutationsStarted: 0, executeEndpoint: null, createdAt: row.created_at };
}

class NetworkPublicIpPlanService {
  constructor(dbProvider = getDb) { this._dbProvider = dbProvider; }
  _db(options = {}) { return options.database || this._dbProvider(); }
  _admin(actor) { if (!actor?.id) fail('Authentication required', 'AUTH_REQUIRED', 401);
    if (actor.role !== 'admin') fail('Administrator required', 'ADMIN_REQUIRED', 403); }
  create(body = {}, actor, options = {}) {
    this._admin(actor); const normalized = normalize(body); const outcome = plan(normalized);
    const planHash = hash({ ...normalized, ...outcome }); const database = this._db(options);
    const found = database.prepare('SELECT * FROM network_public_ip_lifecycle_plans WHERE plan_hash=?').get(planHash);
    if (found) return { ...publicPlan(found), duplicate: true };
    const saved = database.prepare(`INSERT INTO network_public_ip_lifecycle_plans
      (scope_key,provider_type,action,public_address,plan_json,blockers_json,state,plan_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(normalized.scopeKey, normalized.providerType, normalized.action,
      normalized.publicAddress, stable(normalized), stable(outcome.blockers), outcome.state, planHash, actor.id);
    return { ...publicPlan(database.prepare('SELECT * FROM network_public_ip_lifecycle_plans WHERE id=?')
      .get(saved.lastInsertRowid)), duplicate: false };
  }
  overview(options = {}) {
    const plans = this._db(options).prepare(
      'SELECT * FROM network_public_ip_lifecycle_plans ORDER BY created_at DESC,id DESC LIMIT 50').all().map(publicPlan);
    return { schemaVersion: '1.0', plans, latest: plans[0] || null,
      capabilities: { allocationPlans: true, mappingPlans: true, releaseGuards: true,
        providerMutations: false, externalMutations: false } };
  }
}

const service = new NetworkPublicIpPlanService();
module.exports = service;
module.exports.NetworkPublicIpPlanService = NetworkPublicIpPlanService;
module.exports.NetworkPublicIpPlanError = NetworkPublicIpPlanError;
module.exports._internals = { normalize, plan, stable, hash, publicPlan };
