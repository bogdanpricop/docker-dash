'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');

const KEY = /^[A-Za-z][A-Za-z0-9_.:/@+-]{0,199}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,199}$/;
const SECRET = /password|credential|private.?key|authorization|cookie|secret.?value|access.?token/i;
const PURPOSES = new Set(['workload', 'overlay', 'storage', 'live_migration']);
const SEGMENT_KINDS = new Set(['interface', 'virtual_network', 'overlay', 'tunnel', 'underlay', 'switch', 'storage', 'migration']);
const DF_STATES = new Set(['preserved', 'cleared', 'unknown', 'not_applicable']);
const MAX_ENCODED_BYTES = 2 * 1024 * 1024;

class NetworkMtuDetectorError extends Error {
  constructor(message, code = 'NETWORK_MTU_DETECTOR_ERROR', status = 400, details = null) {
    super(message); this.name = 'NetworkMtuDetectorError'; this.code = code; this.status = status; this.details = details;
  }
}

function fail(message, code = 'INVALID_NETWORK_MTU_INPUT', status = 400, details = null) {
  throw new NetworkMtuDetectorError(message, code, status, details);
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
function text(value, field, max = 300) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) fail(`${field} is invalid`);
  return result;
}
function key(value, field) { const result = text(value, field, 200); if (!KEY.test(result)) fail(`${field} is invalid`); return result; }
function reference(value, field) { const result = text(value, field, 200); if (!REF.test(result)) fail(`${field} is invalid`); return result; }
function integer(value, field, min, max) {
  const result = Number(value); if (!Number.isSafeInteger(result) || result < min || result > max) fail(`${field} is invalid`);
  return result;
}
function instant(value, field) {
  const result = text(value, field, 40); const parsed = Date.parse(result);
  if (!Number.isFinite(parsed)) fail(`${field} is invalid`);
  return new Date(parsed).toISOString();
}
function bool(value, field) { if (typeof value !== 'boolean') fail(`${field} is invalid`); return value; }
function choice(value, field, values) { const result = String(value || ''); if (!values.has(result)) fail(`${field} is invalid`); return result; }
function array(value, field, min, max, mapper) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${field} is invalid`);
  return value.map((item, index) => mapper(item, index));
}
function canonical(value) { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical(value[name])])) : value; }
function stable(value) { return JSON.stringify(canonical(value)); }
function hash(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex'); }
function parse(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }

function normalize(body) {
  exact(body, 'mtuAssessment', ['source', 'providerHostId', 'observedAt', 'expiresAt', 'coverage', 'paths']);
  const source = key(body.source, 'source');
  const providerHostId = body.providerHostId == null ? null
    : integer(body.providerHostId, 'providerHostId', 1, Number.MAX_SAFE_INTEGER);
  const observedAt = instant(body.observedAt, 'observedAt'); const expiresAt = instant(body.expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(observedAt)) fail('expiresAt must be after observedAt');
  exact(body.coverage, 'coverage', ['complete', 'reason']);
  const coverage = { complete: bool(body.coverage.complete, 'coverage.complete'),
    reason: text(body.coverage.reason, 'coverage.reason', 500) };
  const paths = array(body.paths, 'paths', 1, 200, (item, index) => {
    exact(item, `paths[${index}]`, ['pathKey', 'purpose', 'sourceKey', 'targetKey', 'requiredPayloadMtu',
      'requiresDf', 'dfState', 'segments']);
    const path = { pathKey: key(item.pathKey, 'pathKey'), purpose: choice(item.purpose, 'purpose', PURPOSES),
      sourceKey: key(item.sourceKey, 'sourceKey'), targetKey: key(item.targetKey, 'targetKey'),
      requiredPayloadMtu: integer(item.requiredPayloadMtu, 'requiredPayloadMtu', 576, 65535),
      requiresDf: bool(item.requiresDf, 'requiresDf'), dfState: choice(item.dfState, 'dfState', DF_STATES) };
    path.segments = array(item.segments, `paths[${index}].segments`, 1, 64, (segment, segmentIndex) => {
      exact(segment, `paths[${index}].segments[${segmentIndex}]`, ['segmentKey', 'kind', 'mtu',
        'encapsulationOverheadBytes', 'evidenceRef']);
      return { segmentKey: key(segment.segmentKey, 'segmentKey'), kind: choice(segment.kind, 'segment.kind', SEGMENT_KINDS),
        mtu: segment.mtu == null ? null : integer(segment.mtu, 'segment.mtu', 576, 65535),
        encapsulationOverheadBytes: integer(segment.encapsulationOverheadBytes, 'encapsulationOverheadBytes', 0, 2048),
        evidenceRef: reference(segment.evidenceRef, 'segment.evidenceRef') };
    });
    if (new Set(path.segments.map(segment => segment.segmentKey)).size !== path.segments.length) {
      fail(`paths[${index}].segments contains duplicate keys`);
    }
    return path;
  });
  if (new Set(paths.map(path => path.pathKey)).size !== paths.length) fail('paths contains duplicate keys');
  return { source, providerHostId, observedAt, expiresAt, coverage, paths };
}

function evaluatePath(path, context) {
  const findings = []; let requiredMtu = path.requiredPayloadMtu; let maxDeficit = 0;
  const segments = path.segments.map((segment, index) => {
    requiredMtu += segment.encapsulationOverheadBytes;
    const deficitBytes = segment.mtu == null ? null : Math.max(0, requiredMtu - segment.mtu);
    if (segment.mtu == null) findings.push({ code: 'MTU_UNKNOWN', state: 'unknown', segmentKey: segment.segmentKey,
      message: 'Segment MTU is not present in the supplied evidence' });
    else if (deficitBytes > 0) {
      maxDeficit = Math.max(maxDeficit, deficitBytes);
      findings.push({ code: 'MTU_BOTTLENECK', state: 'fail', segmentKey: segment.segmentKey,
        message: `Segment MTU is ${deficitBytes} bytes below the calculated requirement` });
    }
    if (requiredMtu > 65535) findings.push({ code: 'CALCULATED_MTU_EXCEEDS_LIMIT', state: 'fail',
      segmentKey: segment.segmentKey, message: 'Cumulative encapsulation exceeds the supported MTU range' });
    return { ...segment, order: index + 1, requiredMtu, deficitBytes,
      state: segment.mtu == null ? 'unknown' : deficitBytes > 0 || requiredMtu > 65535 ? 'fail' : 'pass' };
  });
  if (!context.coverageComplete) findings.push({ code: 'EVIDENCE_INCOMPLETE', state: 'unknown', segmentKey: null,
    message: 'Source coverage is incomplete' });
  if (context.expired) findings.push({ code: 'EVIDENCE_EXPIRED', state: 'unknown', segmentKey: null,
    message: 'Source evidence expired before this assessment' });
  if (path.requiresDf && path.dfState === 'unknown') findings.push({ code: 'DF_POLICY_UNKNOWN', state: 'unknown',
    segmentKey: null, message: 'Required DF behavior is not present in the supplied evidence' });
  if (path.requiresDf && ['cleared', 'not_applicable'].includes(path.dfState)) findings.push({
    code: 'DF_REQUIRED_BUT_NOT_PRESERVED', state: 'fail', segmentKey: null,
    message: 'The path requires DF semantics but evidence does not show preservation' });
  const state = findings.some(item => item.state === 'fail') ? 'fail'
    : findings.some(item => item.state === 'unknown') ? 'unknown' : 'pass';
  return { ...path, state, calculatedWireMtu: requiredMtu, maxDeficitBytes: maxDeficit, segments, findings };
}

function publicAssessment(row) {
  if (!row) return null;
  return { schemaVersion: '1.0', id: Number(row.id), source: row.source,
    providerHostId: row.provider_host_id == null ? null : Number(row.provider_host_id), observedAt: row.observed_at,
    expiresAt: row.expires_at, assessedAt: row.assessed_at, coverage: parse(row.coverage_json, {}),
    paths: parse(row.paths_json, []), findings: parse(row.findings_json, []), summary: parse(row.summary_json, {}),
    assessmentHash: row.assessment_hash, providerMutationsStarted: 0, networkCallsStarted: 0,
    activeProbesStarted: 0, createdAt: row.created_at };
}

class NetworkMtuDetectorService {
  constructor(dbProvider = getDb) { this._dbProvider = dbProvider; }
  _db(options = {}) { return options.database || this._dbProvider(); }
  _admin(actor) {
    if (!actor?.id) fail('Authentication required', 'AUTH_REQUIRED', 401);
    if (actor.role !== 'admin') fail('Administrator required', 'ADMIN_REQUIRED', 403);
  }
  assess(body = {}, actor, options = {}) {
    this._admin(actor); const normalized = normalize(body);
    const nowInput = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    if (Number.isNaN(nowInput.getTime())) fail('now is invalid');
    const assessedAt = new Date(Math.floor(nowInput.getTime() / 60000) * 60000).toISOString();
    const expired = Date.parse(normalized.expiresAt) <= nowInput.getTime();
    const paths = normalized.paths.map(path => evaluatePath(path, {
      coverageComplete: normalized.coverage.complete, expired,
    }));
    const findings = paths.flatMap(path => path.findings.map(finding => ({ pathKey: path.pathKey,
      purpose: path.purpose, ...finding })));
    const purposeCounts = Object.fromEntries([...PURPOSES].map(purpose => [purpose,
      paths.filter(path => path.purpose === purpose).length]));
    const summary = { state: paths.some(path => path.state === 'fail') ? 'fail'
      : paths.some(path => path.state === 'unknown') ? 'unknown' : 'pass', paths: paths.length,
    pass: paths.filter(path => path.state === 'pass').length, fail: paths.filter(path => path.state === 'fail').length,
    unknown: paths.filter(path => path.state === 'unknown').length, bottlenecks: findings.filter(item => item.code === 'MTU_BOTTLENECK').length,
    maxDeficitBytes: Math.max(0, ...paths.map(path => path.maxDeficitBytes)), purposes: purposeCounts,
    evidenceExpired: expired, coverageComplete: normalized.coverage.complete };
    const assessmentHash = hash({ ...normalized, paths, findings, summary });
    if (Buffer.byteLength(stable({ paths, findings, summary })) > MAX_ENCODED_BYTES) {
      fail('MTU assessment exceeds the encoded size limit', 'NETWORK_MTU_ASSESSMENT_TOO_LARGE', 413);
    }
    const database = this._db(options);
    const found = database.prepare('SELECT * FROM network_mtu_assessments WHERE assessment_hash=?').get(assessmentHash);
    if (found) return { ...publicAssessment(found), duplicate: true };
    const saved = database.prepare(`INSERT INTO network_mtu_assessments
      (source,provider_host_id,observed_at,expires_at,assessed_at,coverage_json,paths_json,findings_json,summary_json,
       assessment_hash,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(normalized.source, normalized.providerHostId,
      normalized.observedAt, normalized.expiresAt, assessedAt, stable(normalized.coverage), stable(paths), stable(findings),
      stable(summary), assessmentHash, actor.id);
    return { ...publicAssessment(database.prepare('SELECT * FROM network_mtu_assessments WHERE id=?')
      .get(saved.lastInsertRowid)), duplicate: false };
  }
  overview(options = {}) {
    const database = this._db(options);
    const assessments = database.prepare('SELECT * FROM network_mtu_assessments ORDER BY assessed_at DESC,id DESC LIMIT 50')
      .all().map(publicAssessment);
    return { schemaVersion: '1.0', assessments, latest: assessments[0] || null,
      capabilities: { passiveMtuAnalysis: true, cumulativeEncapsulation: true, dfEvidence: true,
        activeProbes: false, providerMutations: false } };
  }
}

const service = new NetworkMtuDetectorService();
module.exports = service;
module.exports.NetworkMtuDetectorService = NetworkMtuDetectorService;
module.exports.NetworkMtuDetectorError = NetworkMtuDetectorError;
module.exports._internals = { normalize, evaluatePath, stable, hash, publicAssessment };
