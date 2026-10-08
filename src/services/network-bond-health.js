'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');

const KEY = /^[A-Za-z][A-Za-z0-9_.:/@+-]{0,199}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,199}$/;
const SECRET = /password|credential|private.?key|authorization|cookie|secret.?value|access.?token/i;
const MODES = new Set(['active_backup', 'lacp', 'static_lag', 'balance_xor', 'round_robin', 'adaptive', 'other']);
const STATES = new Set(['up', 'down', 'unknown']);
const ROLES = new Set(['active', 'standby', 'collecting_distributing', 'individual', 'inactive', 'unknown']);
const DUPLEX = new Set(['full', 'half', 'unknown']);
const MAX_ENCODED_BYTES = 2 * 1024 * 1024;

class NetworkBondHealthError extends Error {
  constructor(message, code = 'NETWORK_BOND_HEALTH_ERROR', status = 400, details = null) {
    super(message); this.name = 'NetworkBondHealthError'; this.code = code; this.status = status; this.details = details;
  }
}
function fail(message, code = 'INVALID_NETWORK_BOND_INPUT', status = 400, details = null) {
  throw new NetworkBondHealthError(message, code, status, details);
}
function exact(value, field, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} is invalid`);
  const unexpected = Object.keys(value).filter(name => !allowed.includes(name));
  if (unexpected.length) {
    const secret = unexpected.find(name => SECRET.test(name));
    fail(secret ? `${field}.${secret} may not contain secret material` : `Unexpected ${field} fields: ${unexpected.join(', ')}`,
      secret ? 'SECRET_FIELD' : 'UNEXPECTED_FIELD');
  }
}
function text(value, field, max = 300) { const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) fail(`${field} is invalid`); return result; }
function key(value, field) { const result = text(value, field, 200); if (!KEY.test(result)) fail(`${field} is invalid`); return result; }
function reference(value, field) { const result = text(value, field, 200); if (!REF.test(result)) fail(`${field} is invalid`); return result; }
function integer(value, field, min, max) { const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) fail(`${field} is invalid`); return result; }
function instant(value, field) { const result = text(value, field, 40); const parsed = Date.parse(result);
  if (!Number.isFinite(parsed)) fail(`${field} is invalid`); return new Date(parsed).toISOString(); }
function bool(value, field) { if (typeof value !== 'boolean') fail(`${field} is invalid`); return value; }
function choice(value, field, values) { const result = String(value || ''); if (!values.has(result)) fail(`${field} is invalid`); return result; }
function array(value, field, min, max, mapper) { if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${field} is invalid`);
  return value.map((item, index) => mapper(item, index)); }
function canonical(value) { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical(value[name])])) : value; }
function stable(value) { return JSON.stringify(canonical(value)); }
function hash(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex'); }
function parse(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }

function normalize(body) {
  exact(body, 'bondObservation', ['source', 'providerHostId', 'observedAt', 'expiresAt', 'coverage', 'bonds']);
  const source = key(body.source, 'source'); const providerHostId = body.providerHostId == null ? null
    : integer(body.providerHostId, 'providerHostId', 1, Number.MAX_SAFE_INTEGER);
  const observedAt = instant(body.observedAt, 'observedAt'); const expiresAt = instant(body.expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(observedAt)) fail('expiresAt must be after observedAt');
  exact(body.coverage, 'coverage', ['complete', 'reason']); const coverage = {
    complete: bool(body.coverage.complete, 'coverage.complete'), reason: text(body.coverage.reason, 'coverage.reason', 500),
  };
  const bonds = array(body.bonds, 'bonds', 1, 500, (item, index) => {
    exact(item, `bonds[${index}]`, ['bondKey', 'hostKey', 'mode', 'minActiveMembers', 'intervalSeconds',
      'imbalanceThresholdPercent', 'failover', 'members']);
    exact(item.failover, `bonds[${index}].failover`, ['count', 'lastAt', 'lastReason']);
    const bond = { bondKey: key(item.bondKey, 'bondKey'), hostKey: key(item.hostKey, 'hostKey'),
      mode: choice(item.mode, 'mode', MODES), minActiveMembers: integer(item.minActiveMembers, 'minActiveMembers', 1, 32),
      intervalSeconds: integer(item.intervalSeconds, 'intervalSeconds', 1, 86400),
      imbalanceThresholdPercent: integer(item.imbalanceThresholdPercent, 'imbalanceThresholdPercent', 1, 100),
      failover: { count: integer(item.failover.count, 'failover.count', 0, Number.MAX_SAFE_INTEGER),
        lastAt: item.failover.lastAt == null ? null : instant(item.failover.lastAt, 'failover.lastAt'),
        lastReason: item.failover.lastReason == null ? null : text(item.failover.lastReason, 'failover.lastReason', 500) } };
    bond.members = array(item.members, `bonds[${index}].members`, 1, 32, (member, memberIndex) => {
      exact(member, `bonds[${index}].members[${memberIndex}]`, ['memberKey', 'adminState', 'linkState', 'role',
        'speedMbps', 'duplex', 'lacpPartnerKey', 'rxBytesDelta', 'txBytesDelta', 'errorDelta', 'dropDelta', 'flapCount']);
      return { memberKey: key(member.memberKey, 'memberKey'), adminState: choice(member.adminState, 'adminState', STATES),
        linkState: choice(member.linkState, 'linkState', STATES), role: choice(member.role, 'role', ROLES),
        speedMbps: member.speedMbps == null ? null : integer(member.speedMbps, 'speedMbps', 1, 10000000),
        duplex: choice(member.duplex, 'duplex', DUPLEX), lacpPartnerKey: member.lacpPartnerKey == null ? null
          : reference(member.lacpPartnerKey, 'lacpPartnerKey'), rxBytesDelta: integer(member.rxBytesDelta, 'rxBytesDelta', 0, Number.MAX_SAFE_INTEGER),
        txBytesDelta: integer(member.txBytesDelta, 'txBytesDelta', 0, Number.MAX_SAFE_INTEGER),
        errorDelta: integer(member.errorDelta, 'errorDelta', 0, Number.MAX_SAFE_INTEGER),
        dropDelta: integer(member.dropDelta, 'dropDelta', 0, Number.MAX_SAFE_INTEGER),
        flapCount: integer(member.flapCount, 'flapCount', 0, 1000000) };
    });
    if (new Set(bond.members.map(member => member.memberKey)).size !== bond.members.length) {
      fail(`bonds[${index}].members contains duplicate keys`);
    }
    return bond;
  });
  if (new Set(bonds.map(bond => bond.bondKey)).size !== bonds.length) fail('bonds contains duplicate keys');
  return { source, providerHostId, observedAt, expiresAt, coverage, bonds };
}

function evaluateBond(bond, context) {
  const findings = []; const activeRole = member => bond.mode === 'active_backup' ? member.role === 'active'
    : bond.mode === 'lacp' ? member.role === 'collecting_distributing'
      : ['active', 'collecting_distributing'].includes(member.role);
  const active = bond.members.filter(member => member.adminState === 'up' && member.linkState === 'up' && activeRole(member));
  for (const member of bond.members) {
    if (member.adminState === 'unknown' || member.linkState === 'unknown' || member.role === 'unknown') findings.push({
      code: 'MEMBER_STATE_UNKNOWN', state: 'unknown', memberKey: member.memberKey, message: 'Member state or role is unknown' });
    if (member.adminState === 'down' || member.linkState === 'down') findings.push({ code: 'MEMBER_DOWN', state: 'warning',
      memberKey: member.memberKey, message: 'Member is administratively or operationally down' });
    if (member.duplex === 'half') findings.push({ code: 'HALF_DUPLEX_MEMBER', state: 'warning', memberKey: member.memberKey,
      message: 'Member reports half duplex' });
    if (member.errorDelta > 0 || member.dropDelta > 0) findings.push({ code: 'MEMBER_ERROR_DELTA', state: 'warning',
      memberKey: member.memberKey, message: 'Member reported errors or drops during the observation interval' });
    if (member.flapCount > 0) findings.push({ code: 'LINK_FLAPS', state: 'warning', memberKey: member.memberKey,
      message: 'Member link flapped during the observation interval' });
    if (bond.mode === 'lacp' && member.adminState === 'up' && member.linkState === 'up'
      && member.role !== 'collecting_distributing') findings.push({ code: 'LACP_MEMBER_NOT_DISTRIBUTING', state: 'warning',
      memberKey: member.memberKey, message: 'Link-up LACP member is not collecting and distributing' });
  }
  if (active.length < bond.minActiveMembers) findings.push({ code: 'ACTIVE_MEMBER_QUORUM_FAIL', state: 'fail', memberKey: null,
    message: `${active.length} active members observed; ${bond.minActiveMembers} required` });
  if (bond.mode === 'active_backup' && active.length > 1) findings.push({ code: 'ACTIVE_BACKUP_MULTIPLE_ACTIVE', state: 'warning',
    memberKey: null, message: 'Active-backup bond reports more than one active member' });
  const activeSpeeds = new Set(active.map(member => member.speedMbps).filter(value => value != null));
  if (activeSpeeds.size > 1) findings.push({ code: 'ACTIVE_MEMBER_SPEED_MISMATCH', state: 'warning', memberKey: null,
    message: 'Active members report different link speeds' });
  let lacpPartner = { state: 'not_applicable', keys: [] };
  if (bond.mode === 'lacp') {
    const keys = active.map(member => member.lacpPartnerKey).filter(Boolean); const unique = [...new Set(keys)].sort();
    lacpPartner = { state: keys.length < active.length ? 'unknown' : unique.length > 1 ? 'mismatch' : 'consistent', keys: unique };
    if (lacpPartner.state === 'unknown') findings.push({ code: 'LACP_PARTNER_UNKNOWN', state: 'unknown', memberKey: null,
      message: 'At least one active LACP member has no partner evidence' });
    if (lacpPartner.state === 'mismatch') findings.push({ code: 'LACP_PARTNER_MISMATCH', state: 'fail', memberKey: null,
      message: 'Active LACP members report different partner keys' });
  }
  const traffic = active.map(member => ({ memberKey: member.memberKey, bytes: member.rxBytesDelta + member.txBytesDelta }));
  const totalBytes = traffic.reduce((sum, item) => sum + item.bytes, 0); let imbalance;
  if (active.length < 2) imbalance = { state: 'not_applicable', spreadPercent: null, totalBytes, shares: [] };
  else if (totalBytes === 0) imbalance = { state: 'not_observed', spreadPercent: null, totalBytes, shares: [] };
  else {
    const shares = traffic.map(item => ({ memberKey: item.memberKey, bytes: item.bytes,
      percent: Number((item.bytes * 100 / totalBytes).toFixed(2)) }));
    const percentages = shares.map(item => item.percent); const spreadPercent = Number((Math.max(...percentages) - Math.min(...percentages)).toFixed(2));
    imbalance = { state: spreadPercent > bond.imbalanceThresholdPercent ? 'warning' : 'balanced',
      spreadPercent, totalBytes, shares };
    if (imbalance.state === 'warning') findings.push({ code: 'TRAFFIC_IMBALANCE', state: 'warning', memberKey: null,
      message: `Active-member traffic spread is ${spreadPercent}%` });
  }
  if (bond.failover.lastAt && Date.parse(context.observedAt) - Date.parse(bond.failover.lastAt) <= bond.intervalSeconds * 1000
    && Date.parse(bond.failover.lastAt) <= Date.parse(context.observedAt)) findings.push({ code: 'RECENT_FAILOVER', state: 'warning',
    memberKey: null, message: 'A failover occurred during the observation interval' });
  if (!context.coverageComplete) findings.push({ code: 'EVIDENCE_INCOMPLETE', state: 'unknown', memberKey: null,
    message: 'Source coverage is incomplete' });
  if (context.expired) findings.push({ code: 'EVIDENCE_EXPIRED', state: 'unknown', memberKey: null,
    message: 'Source evidence is expired' });
  const state = findings.some(item => item.state === 'fail') ? 'fail' : findings.some(item => item.state === 'unknown')
    ? 'unknown' : findings.some(item => item.state === 'warning') ? 'warning' : 'pass';
  return { ...bond, state, activeMembers: active.length, lacpPartner, imbalance, findings };
}

function publicObservation(row) {
  if (!row) return null;
  return { schemaVersion: '1.0', id: Number(row.id), source: row.source,
    providerHostId: row.provider_host_id == null ? null : Number(row.provider_host_id), observedAt: row.observed_at,
    expiresAt: row.expires_at, coverage: parse(row.coverage_json, {}), bonds: parse(row.bonds_json, []),
    findings: parse(row.findings_json, []), summary: parse(row.summary_json, {}), observationHash: row.observation_hash,
    providerMutationsStarted: 0, networkCallsStarted: 0, activeFailoversStarted: 0, createdAt: row.created_at };
}

class NetworkBondHealthService {
  constructor(dbProvider = getDb) { this._dbProvider = dbProvider; }
  _db(options = {}) { return options.database || this._dbProvider(); }
  _admin(actor) { if (!actor?.id) fail('Authentication required', 'AUTH_REQUIRED', 401);
    if (actor.role !== 'admin') fail('Administrator required', 'ADMIN_REQUIRED', 403); }
  record(body = {}, actor, options = {}) {
    this._admin(actor); const normalized = normalize(body); const nowInput = options.now instanceof Date
      ? options.now : new Date(options.now || Date.now()); if (Number.isNaN(nowInput.getTime())) fail('now is invalid');
    const expired = Date.parse(normalized.expiresAt) <= nowInput.getTime();
    const bonds = normalized.bonds.map(bond => evaluateBond(bond, { observedAt: normalized.observedAt,
      coverageComplete: normalized.coverage.complete, expired }));
    const findings = bonds.flatMap(bond => bond.findings.map(finding => ({ bondKey: bond.bondKey, ...finding })));
    const summary = { state: bonds.some(bond => bond.state === 'fail') ? 'fail' : bonds.some(bond => bond.state === 'unknown')
      ? 'unknown' : bonds.some(bond => bond.state === 'warning') ? 'warning' : 'pass', bonds: bonds.length,
    pass: bonds.filter(bond => bond.state === 'pass').length, warning: bonds.filter(bond => bond.state === 'warning').length,
    fail: bonds.filter(bond => bond.state === 'fail').length, unknown: bonds.filter(bond => bond.state === 'unknown').length,
    members: bonds.reduce((sum, bond) => sum + bond.members.length, 0), activeMembers: bonds.reduce((sum, bond) => sum + bond.activeMembers, 0),
    imbalanced: bonds.filter(bond => bond.imbalance.state === 'warning').length,
    lacpPartnerMismatch: bonds.filter(bond => bond.lacpPartner.state === 'mismatch').length,
    recentFailovers: findings.filter(finding => finding.code === 'RECENT_FAILOVER').length,
    evidenceExpired: expired, coverageComplete: normalized.coverage.complete };
    const observationHash = hash({ ...normalized, bonds, findings, summary });
    if (Buffer.byteLength(stable({ bonds, findings, summary })) > MAX_ENCODED_BYTES) {
      fail('Bond health observation exceeds the encoded size limit', 'NETWORK_BOND_OBSERVATION_TOO_LARGE', 413);
    }
    const database = this._db(options); const found = database.prepare(
      'SELECT * FROM network_bond_health_observations WHERE observation_hash=?').get(observationHash);
    if (found) return { ...publicObservation(found), duplicate: true };
    const saved = database.prepare(`INSERT INTO network_bond_health_observations
      (source,provider_host_id,observed_at,expires_at,coverage_json,bonds_json,findings_json,summary_json,observation_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(normalized.source, normalized.providerHostId, normalized.observedAt,
      normalized.expiresAt, stable(normalized.coverage), stable(bonds), stable(findings), stable(summary), observationHash, actor.id);
    return { ...publicObservation(database.prepare('SELECT * FROM network_bond_health_observations WHERE id=?')
      .get(saved.lastInsertRowid)), duplicate: false };
  }
  overview(options = {}) {
    const observations = this._db(options).prepare(
      'SELECT * FROM network_bond_health_observations ORDER BY observed_at DESC,id DESC LIMIT 50').all().map(publicObservation);
    return { schemaVersion: '1.0', observations, latest: observations[0] || null,
      capabilities: { normalizedBondHealth: true, lacpPartnerConsistency: true, trafficImbalance: true,
        activeFailover: false, providerMutations: false } };
  }
}

const service = new NetworkBondHealthService();
module.exports = service;
module.exports.NetworkBondHealthService = NetworkBondHealthService;
module.exports.NetworkBondHealthError = NetworkBondHealthError;
module.exports._internals = { normalize, evaluateBond, stable, hash, publicObservation };
