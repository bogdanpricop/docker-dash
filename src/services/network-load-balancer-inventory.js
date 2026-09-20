'use strict';

const crypto = require('crypto');
const net = require('net');
const { getDb } = require('../db');

const KEY = /^[A-Za-z][A-Za-z0-9_.:/@+-]{0,199}$/;
const SECRET = /password|credential|private.?key|authorization|cookie|secret.?value|access.?token|native.?ref|provider.?url/i;
const PROVIDER_STATES = new Set(['active', 'degraded', 'error', 'disabled', 'unknown']);
const PROTOCOLS = new Set(['tcp', 'udp', 'http', 'https', 'tls']);
const ALGORITHMS = new Set(['round_robin', 'least_connections', 'source_ip', 'weighted', 'hash', 'other', 'unknown']);
const ADMIN_STATES = new Set(['enabled', 'disabled', 'unknown']);
const HEALTH_STATES = new Set(['healthy', 'unhealthy', 'draining', 'unknown']);
const TLS_STATES = new Set(['not_applicable', 'valid', 'expiring', 'expired', 'unknown']);
const MAX_ENCODED_BYTES = 2 * 1024 * 1024;

class NetworkLoadBalancerInventoryError extends Error {
  constructor(message, code = 'NETWORK_LOAD_BALANCER_INVENTORY_ERROR', status = 400, details = null) {
    super(message); this.name = 'NetworkLoadBalancerInventoryError'; this.code = code; this.status = status; this.details = details;
  }
}
function fail(message, code = 'INVALID_LOAD_BALANCER_INVENTORY', status = 400, details = null) {
  throw new NetworkLoadBalancerInventoryError(message, code, status, details);
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
function choice(value, field, values) { const result = String(value || ''); if (!values.has(result)) fail(`${field} is invalid`); return result; }
function ip(value, field) { const result = text(value, field, 80); if (!net.isIP(result)) fail(`${field} is invalid`); return result; }
function array(value, field, min, max, mapper) { if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${field} is invalid`);
  return value.map((item, index) => mapper(item, index)); }
function unique(values, field) { if (new Set(values).size !== values.length) fail(`${field} contains duplicates`); return values; }
function canonical(value) { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical(value[name])])) : value; }
function stable(value) { return JSON.stringify(canonical(value)); }
function hash(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex'); }
function parse(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }

function normalize(body) {
  exact(body, 'loadBalancerObservation', ['source', 'providerHostId', 'providerType', 'observedAt', 'expiresAt',
    'coverage', 'loadBalancers']);
  const source = key(body.source, 'source'); const providerHostId = body.providerHostId == null ? null
    : integer(body.providerHostId, 'providerHostId', 1, Number.MAX_SAFE_INTEGER);
  const providerType = key(body.providerType, 'providerType'); const observedAt = instant(body.observedAt, 'observedAt');
  const expiresAt = instant(body.expiresAt, 'expiresAt'); if (Date.parse(expiresAt) <= Date.parse(observedAt)) {
    fail('expiresAt must be after observedAt');
  }
  exact(body.coverage, 'coverage', ['complete', 'reason']); if (typeof body.coverage.complete !== 'boolean') fail('coverage.complete is invalid');
  const coverage = { complete: body.coverage.complete, reason: text(body.coverage.reason, 'coverage.reason', 500) };
  const loadBalancers = array(body.loadBalancers, 'loadBalancers', 1, 500, (item, index) => {
    exact(item, `loadBalancers[${index}]`, ['loadBalancerKey', 'name', 'scopeKey', 'providerState', 'vipAddresses',
      'networkKeys', 'resourceKeys', 'listeners', 'pools']);
    const loadBalancer = { loadBalancerKey: key(item.loadBalancerKey, 'loadBalancerKey'), name: text(item.name, 'name', 300),
      scopeKey: key(item.scopeKey, 'scopeKey'), providerState: choice(item.providerState, 'providerState', PROVIDER_STATES),
      vipAddresses: unique(array(item.vipAddresses, 'vipAddresses', 1, 32, value => ip(value, 'vipAddress')).sort(), 'vipAddresses'),
      networkKeys: unique(array(item.networkKeys || [], 'networkKeys', 0, 100, value => key(value, 'networkKey')).sort(), 'networkKeys'),
      resourceKeys: unique(array(item.resourceKeys || [], 'resourceKeys', 0, 5000, value => key(value, 'resourceKey')).sort(), 'resourceKeys') };
    loadBalancer.listeners = array(item.listeners || [], 'listeners', 0, 200, listener => {
      exact(listener, 'listener', ['listenerKey', 'protocol', 'port', 'defaultPoolKey', 'tlsState']);
      return { listenerKey: key(listener.listenerKey, 'listenerKey'), protocol: choice(listener.protocol, 'protocol', PROTOCOLS),
        port: integer(listener.port, 'port', 1, 65535), defaultPoolKey: listener.defaultPoolKey == null ? null
          : key(listener.defaultPoolKey, 'defaultPoolKey'), tlsState: choice(listener.tlsState, 'tlsState', TLS_STATES) };
    });
    unique(loadBalancer.listeners.map(listener => listener.listenerKey), 'listenerKey');
    loadBalancer.pools = array(item.pools || [], 'pools', 0, 200, pool => {
      exact(pool, 'pool', ['poolKey', 'protocol', 'algorithm', 'members']);
      const normalizedPool = { poolKey: key(pool.poolKey, 'poolKey'), protocol: choice(pool.protocol, 'protocol', PROTOCOLS),
        algorithm: choice(pool.algorithm, 'algorithm', ALGORITHMS) };
      normalizedPool.members = array(pool.members || [], 'members', 0, 5000, member => {
        exact(member, 'member', ['memberKey', 'resourceKey', 'address', 'port', 'adminState', 'health', 'weight']);
        return { memberKey: key(member.memberKey, 'memberKey'), resourceKey: member.resourceKey == null ? null
          : key(member.resourceKey, 'resourceKey'), address: ip(member.address, 'member.address'),
        port: integer(member.port, 'member.port', 1, 65535), adminState: choice(member.adminState, 'member.adminState', ADMIN_STATES),
        health: choice(member.health, 'member.health', HEALTH_STATES), weight: integer(member.weight, 'member.weight', 0, 1000) };
      });
      unique(normalizedPool.members.map(member => member.memberKey), 'memberKey'); return normalizedPool;
    });
    unique(loadBalancer.pools.map(pool => pool.poolKey), 'poolKey'); const poolKeys = new Set(loadBalancer.pools.map(pool => pool.poolKey));
    const dangling = loadBalancer.listeners.find(listener => listener.defaultPoolKey && !poolKeys.has(listener.defaultPoolKey));
    if (dangling) fail(`Listener ${dangling.listenerKey} references an unknown default pool`);
    return loadBalancer;
  });
  unique(loadBalancers.map(item => item.loadBalancerKey), 'loadBalancerKey');
  return { source, providerHostId, providerType, observedAt, expiresAt, coverage, loadBalancers };
}

function classify(loadBalancer, context) {
  const members = loadBalancer.pools.flatMap(pool => pool.members); const enabled = members.filter(member => member.adminState === 'enabled');
  const unknown = enabled.filter(member => member.health === 'unknown').length; const unhealthy = enabled.filter(member => member.health === 'unhealthy').length;
  const expiredTls = loadBalancer.listeners.filter(listener => listener.tlsState === 'expired').length;
  const state = loadBalancer.providerState === 'error' ? 'fail' : !context.coverageComplete || context.expired
    || loadBalancer.providerState === 'unknown' || unknown > 0 ? 'unknown'
      : loadBalancer.providerState === 'degraded' || unhealthy > 0 || expiredTls > 0 ? 'warning' : 'pass';
  return { ...loadBalancer, state, summary: { vips: loadBalancer.vipAddresses.length,
    listeners: loadBalancer.listeners.length, pools: loadBalancer.pools.length, members: members.length,
    healthyMembers: members.filter(member => member.health === 'healthy').length,
    unhealthyMembers: members.filter(member => member.health === 'unhealthy').length,
    drainingMembers: members.filter(member => member.health === 'draining').length,
    unknownMembers: members.filter(member => member.health === 'unknown').length, expiredTls } };
}

function publicObservation(row) {
  if (!row) return null; return { schemaVersion: '1.0', id: Number(row.id), source: row.source,
    providerHostId: row.provider_host_id == null ? null : Number(row.provider_host_id), providerType: row.provider_type,
    observedAt: row.observed_at, expiresAt: row.expires_at, coverage: parse(row.coverage_json, {}),
    loadBalancers: parse(row.load_balancers_json, []), summary: parse(row.summary_json, {}),
    observationHash: row.observation_hash, providerMutationsStarted: 0, networkCallsStarted: 0,
    activeHealthProbesStarted: 0, createdAt: row.created_at };
}

class NetworkLoadBalancerInventoryService {
  constructor(dbProvider = getDb) { this._dbProvider = dbProvider; }
  _db(options = {}) { return options.database || this._dbProvider(); }
  _admin(actor) { if (!actor?.id) fail('Authentication required', 'AUTH_REQUIRED', 401);
    if (actor.role !== 'admin') fail('Administrator required', 'ADMIN_REQUIRED', 403); }
  record(body = {}, actor, options = {}) {
    this._admin(actor); const normalized = normalize(body); const nowInput = options.now instanceof Date
      ? options.now : new Date(options.now || Date.now()); if (Number.isNaN(nowInput.getTime())) fail('now is invalid');
    const expired = Date.parse(normalized.expiresAt) <= nowInput.getTime(); const loadBalancers = normalized.loadBalancers
      .map(item => classify(item, { coverageComplete: normalized.coverage.complete, expired }));
    const totals = loadBalancers.reduce((sum, item) => { for (const key of Object.keys(item.summary)) sum[key] += item.summary[key]; return sum; },
      { vips: 0, listeners: 0, pools: 0, members: 0, healthyMembers: 0, unhealthyMembers: 0,
        drainingMembers: 0, unknownMembers: 0, expiredTls: 0 });
    const summary = { state: loadBalancers.some(item => item.state === 'fail') ? 'fail'
      : loadBalancers.some(item => item.state === 'unknown') ? 'unknown'
        : loadBalancers.some(item => item.state === 'warning') ? 'warning' : 'pass',
    loadBalancers: loadBalancers.length, ...totals, coverageComplete: normalized.coverage.complete, evidenceExpired: expired };
    const observationHash = hash({ ...normalized, loadBalancers, summary });
    if (Buffer.byteLength(stable({ loadBalancers, summary })) > MAX_ENCODED_BYTES) {
      fail('Load balancer observation exceeds the encoded size limit', 'LOAD_BALANCER_OBSERVATION_TOO_LARGE', 413);
    }
    const database = this._db(options); const found = database.prepare(
      'SELECT * FROM network_load_balancer_observations WHERE observation_hash=?').get(observationHash);
    if (found) return { ...publicObservation(found), duplicate: true };
    const saved = database.prepare(`INSERT INTO network_load_balancer_observations
      (source,provider_host_id,provider_type,observed_at,expires_at,coverage_json,load_balancers_json,summary_json,
       observation_hash,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(normalized.source, normalized.providerHostId,
      normalized.providerType, normalized.observedAt, normalized.expiresAt, stable(normalized.coverage), stable(loadBalancers),
      stable(summary), observationHash, actor.id);
    return { ...publicObservation(database.prepare('SELECT * FROM network_load_balancer_observations WHERE id=?')
      .get(saved.lastInsertRowid)), duplicate: false };
  }
  overview(options = {}) {
    const observations = this._db(options).prepare(
      'SELECT * FROM network_load_balancer_observations ORDER BY observed_at DESC,id DESC LIMIT 50').all().map(publicObservation);
    return { schemaVersion: '1.0', observations, latest: observations[0] || null,
      capabilities: { normalizedVipInventory: true, listenerPoolMemberTopology: true,
        activeHealthProbes: false, providerMutations: false } };
  }
}

const service = new NetworkLoadBalancerInventoryService();
module.exports = service;
module.exports.NetworkLoadBalancerInventoryService = NetworkLoadBalancerInventoryService;
module.exports.NetworkLoadBalancerInventoryError = NetworkLoadBalancerInventoryError;
module.exports._internals = { normalize, classify, stable, hash, publicObservation };
