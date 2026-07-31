'use strict';

const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const { getDb } = require('../db');
const { decrypt } = require('../utils/crypto');

const MAX_REPOSITORIES = 200;
const MAX_HISTORY = 90;
const MAX_ADDRESSES = 8;
const DEFAULT_TIMEOUT_MS = 5000;
const STATE_RANK = { healthy: 0, unknown: 1, degraded: 2, unavailable: 3, critical: 4 };
const STAGE_STATES = new Set(['pass', 'fail', 'unknown', 'not_run']);

class StorageRepositoryHealthError extends Error {
  constructor(message, code = 'STORAGE_REPOSITORY_ERROR', status = 400) {
    super(message);
    this.name = 'StorageRepositoryHealthError';
    this.code = code;
    this.status = status;
  }
}

function fail(message, code, status) { throw new StorageRepositoryHealthError(message, code, status); }
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function exact(value, allowed, field = 'repository') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} is invalid`, 'INVALID_INPUT');
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
  if (unexpected.length) {
    const secret = unexpected.find(key => /password|credential|token|secret.?value|authorization|cookie|private.?key/i.test(key));
    fail(secret ? `${field}.${secret} may not contain secret material`
      : `Unexpected ${field} fields: ${unexpected.join(', ')}`, secret ? 'SECRET_FIELD' : 'UNEXPECTED_FIELD');
  }
  return value;
}
function text(value, field, max = 200) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) fail(`${field} is invalid`, 'INVALID_INPUT');
  return result;
}
function integer(value, field, min, max) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) fail(`${field} is invalid`, 'INVALID_INPUT');
  return result;
}
function boolean(value, field) {
  if (typeof value !== 'boolean') fail(`${field} is invalid`, 'INVALID_INPUT');
  return value;
}
function protocol(value) {
  const result = String(value || '').toLowerCase();
  if (!['nfs', 'smb'].includes(result)) fail('protocol is invalid', 'INVALID_PROTOCOL');
  return result;
}
function isSafeAddress(value) {
  const family = net.isIP(value);
  if (family === 4) {
    const first = Number(value.split('.')[0]);
    return value !== '0.0.0.0' && value !== '255.255.255.255' && !(first >= 224 && first <= 239);
  }
  if (family === 6) {
    const lower = value.toLowerCase();
    return lower !== '::' && lower !== '0:0:0:0:0:0:0:0' && !lower.startsWith('ff');
  }
  return false;
}
function hostname(value) {
  let result = text(value, 'hostname', 253).toLowerCase();
  if (/^[a-z]+:\/\//i.test(result) || /[\\/@?#\s\[\]]/.test(result) || result.includes('%')) {
    fail('hostname must not contain a scheme, credentials, path, query or zone identifier', 'INVALID_HOSTNAME');
  }
  if (result.endsWith('.')) result = result.slice(0, -1);
  if (net.isIP(result)) {
    if (!isSafeAddress(result)) fail('hostname must resolve to a unicast address', 'UNSAFE_ADDRESS');
    return result;
  }
  const labels = result.split('.');
  if (!labels.length || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    fail('hostname is invalid', 'INVALID_HOSTNAME');
  }
  return result;
}
function repositoryPath(value, kind) {
  const result = text(value, 'repositoryPath', 1024);
  if (/^[a-z]+:\/\//i.test(result) || result.startsWith('\\\\') || /[\u0000-\u001f\u007f]/.test(result)) {
    fail('repositoryPath must not contain a URL, UNC endpoint or control characters', 'INVALID_REPOSITORY_PATH');
  }
  if (kind === 'nfs') {
    if (!result.startsWith('/') || result.includes('\\') || result.includes('//')) fail('NFS repositoryPath must be one absolute export path', 'INVALID_REPOSITORY_PATH');
    if (result.split('/').some(segment => segment === '.' || segment === '..')) fail('repositoryPath traversal is not allowed', 'PATH_TRAVERSAL');
    return result;
  }
  if (result.includes('/') || result.includes('\\') || result === '.' || result === '..'
    || !/^[a-zA-Z0-9][a-zA-Z0-9 $._-]{0,79}$/.test(result)) {
    fail('SMB repositoryPath must be one share name without a server or subpath', 'INVALID_REPOSITORY_PATH');
  }
  return result;
}
function normalizeStage(value, fallbackCode) {
  if (!value || !STAGE_STATES.has(value.state)) return { state: 'unknown', code: fallbackCode };
  const code = String(value.code || fallbackCode).toUpperCase();
  return { state: value.state, code: /^[A-Z0-9_]{1,80}$/.test(code) ? code : fallbackCode,
    ...(Number.isFinite(value.latencyMs) ? { latencyMs: Math.max(0, Math.round(value.latencyMs)) } : {}) };
}
function publicRow(row, actor) {
  const admin = actor?.role === 'admin' || actor?.roles?.includes('admin');
  return {
    id: row.id, name: row.name, protocol: row.protocol, hostname: row.hostname, port: row.port,
    repositoryPath: row.repository_path, credentialConfigured: row.secret_id !== null,
    ...(admin ? { secretId: row.secret_id, secretName: row.secret_name || null } : {}),
    writeTestEnabled: Boolean(row.write_test_enabled), warningLatencyMs: row.warning_latency_ms,
    criticalLatencyMs: row.critical_latency_ms, intervalMinutes: row.interval_minutes,
    isEnabled: Boolean(row.is_enabled), version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

class StorageRepositoryHealthService {
  constructor(options = {}) {
    this._dbProvider = options.dbProvider || getDb;
    this._resolver = options.resolver || (host => dns.promises.lookup(host, { all: true, verbatim: true }));
    this._connector = options.connector || this._connect.bind(this);
    this._adapter = options.adapter || null;
    this._secretResolver = options.secretResolver || this._resolveSecret.bind(this);
    this._notifications = options.notifications || null;
    this._audit = options.audit || null;
  }

  _db(database) { return database || this._dbProvider(); }
  _actor(actor, admin = false) {
    if (!actor?.id) fail('Authentication required', 'AUTHENTICATION_REQUIRED', 401);
    if (admin && actor.role !== 'admin' && !actor.roles?.includes('admin')) fail('Administrator required', 'ADMIN_REQUIRED', 403);
  }
  _connect({ address, port, family, timeoutMs }) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const socket = net.createConnection({ host: address, port, family });
      const done = (error) => {
        socket.removeAllListeners();
        socket.destroy();
        if (error) reject(error); else resolve({ latencyMs: Date.now() - started });
      };
      socket.setTimeout(timeoutMs, () => done(new Error('timeout')));
      socket.once('connect', () => done());
      socket.once('error', done);
    });
  }
  _resolveSecret(secretId, database) {
    if (secretId === null) return null;
    const row = database.prepare('SELECT value_encrypted FROM secrets_vault WHERE id=?').get(secretId);
    if (!row) fail('Configured secret reference is unavailable', 'SECRET_UNAVAILABLE', 409);
    try { return decrypt(row.value_encrypted); } catch { fail('Configured secret reference cannot be decrypted', 'SECRET_UNAVAILABLE', 409); }
  }
  _row(id, database) {
    const value = this._db(database).prepare(`SELECT r.*,s.name secret_name FROM storage_repository_endpoints r
      LEFT JOIN secrets_vault s ON s.id=r.secret_id WHERE r.id=?`).get(integer(id, 'repositoryId', 1, Number.MAX_SAFE_INTEGER));
    if (!value) fail('Storage repository not found', 'REPOSITORY_NOT_FOUND', 404);
    return value;
  }
  _input(body, database, updating = false) {
    exact(body, ['name', 'protocol', 'hostname', 'port', 'repositoryPath', 'secretId', 'writeTestEnabled',
      'warningLatencyMs', 'criticalLatencyMs', 'intervalMinutes', 'isEnabled', ...(updating ? ['version'] : [])]);
    const kind = protocol(body.protocol);
    const warningLatencyMs = integer(body.warningLatencyMs ?? 500, 'warningLatencyMs', 1, 30000);
    const criticalLatencyMs = integer(body.criticalLatencyMs ?? 2000, 'criticalLatencyMs', 2, 30000);
    if (criticalLatencyMs <= warningLatencyMs) fail('criticalLatencyMs must be greater than warningLatencyMs', 'INVALID_THRESHOLDS');
    const secretId = body.secretId === null || body.secretId === undefined ? null : integer(body.secretId, 'secretId', 1, Number.MAX_SAFE_INTEGER);
    if (secretId !== null && !database.prepare('SELECT 1 FROM secrets_vault WHERE id=?').get(secretId)) fail('Secret reference not found', 'SECRET_NOT_FOUND', 404);
    return {
      name: text(body.name, 'name', 100), protocol: kind, hostname: hostname(body.hostname),
      port: integer(body.port ?? (kind === 'nfs' ? 2049 : 445), 'port', 1, 65535),
      repositoryPath: repositoryPath(body.repositoryPath, kind), secretId,
      writeTestEnabled: boolean(body.writeTestEnabled ?? false, 'writeTestEnabled'),
      warningLatencyMs, criticalLatencyMs,
      intervalMinutes: integer(body.intervalMinutes ?? 60, 'intervalMinutes', 15, 1440),
      isEnabled: boolean(body.isEnabled ?? true, 'isEnabled'),
      ...(updating ? { version: integer(body.version, 'version', 1, Number.MAX_SAFE_INTEGER) } : {}),
    };
  }

  list(actor, options = {}) {
    this._actor(actor);
    const db = this._db(options.database);
    const historyLimit = Math.min(MAX_HISTORY, Math.max(1, Number(options.historyLimit) || 30));
    const rows = db.prepare(`SELECT r.*,s.name secret_name FROM storage_repository_endpoints r
      LEFT JOIN secrets_vault s ON s.id=r.secret_id ORDER BY r.name COLLATE NOCASE LIMIT ?`).all(MAX_REPOSITORIES + 1);
    const now = options.now ? new Date(options.now) : new Date();
    const repositories = rows.slice(0, MAX_REPOSITORIES).map(row => {
      const history = db.prepare(`SELECT observed_at,state,latency_ms,stages_json,evidence_hash,write_test,cleanup_proven
        FROM storage_repository_observations WHERE repository_id=? ORDER BY observed_at DESC,id DESC LIMIT ?`).all(row.id, historyLimit)
        .map(item => ({ observedAt: item.observed_at, state: item.state, latencyMs: item.latency_ms,
          stages: JSON.parse(item.stages_json), evidenceHash: item.evidence_hash,
          writeTest: Boolean(item.write_test), cleanupProven: item.cleanup_proven === null ? null : Boolean(item.cleanup_proven) }));
      const latest = history[0] || null;
      const ageMs = latest ? now.getTime() - Date.parse(latest.observedAt) : null;
      return { ...publicRow(row, actor), latest, history,
        freshness: ageMs === null ? 'unknown' : ageMs > row.interval_minutes * 2 * 60000 ? 'stale' : 'fresh' };
    });
    const states = { healthy: 0, unknown: 0, degraded: 0, unavailable: 0, critical: 0 };
    for (const repository of repositories) states[repository.latest?.state || 'unknown'] += 1;
    return { schemaVersion: 1, repositories, summary: { total: repositories.length, states },
      coverage: { truncated: rows.length > MAX_REPOSITORIES, limit: MAX_REPOSITORIES,
        dataPlaneAdapterAvailable: Boolean(this._adapter) },
      limitations: this._adapter ? [] : ['Auth, list and write checks require an approved data-plane adapter; network reachability alone remains unknown.'] };
  }

  create(body, actor, database) {
    this._actor(actor, true);
    const db = this._db(database);
    const input = this._input(body, db);
    if (db.prepare('SELECT 1 FROM storage_repository_endpoints WHERE name=? COLLATE NOCASE').get(input.name)) fail('A storage repository with this name already exists', 'DUPLICATE_NAME', 409);
    const result = db.prepare(`INSERT INTO storage_repository_endpoints
      (name,protocol,hostname,port,repository_path,secret_id,write_test_enabled,warning_latency_ms,
       critical_latency_ms,interval_minutes,is_enabled,created_by,updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.name, input.protocol, input.hostname, input.port,
      input.repositoryPath, input.secretId, Number(input.writeTestEnabled), input.warningLatencyMs,
      input.criticalLatencyMs, input.intervalMinutes, Number(input.isEnabled), actor.id, actor.id);
    return publicRow(this._row(Number(result.lastInsertRowid), db), actor);
  }

  update(id, body, actor, database) {
    this._actor(actor, true);
    const db = this._db(database);
    const current = this._row(id, db);
    const input = this._input(body, db, true);
    if (current.version !== input.version) fail('Storage repository changed since it was loaded', 'STALE_REPOSITORY', 409);
    const duplicate = db.prepare('SELECT 1 FROM storage_repository_endpoints WHERE name=? COLLATE NOCASE AND id<>?').get(input.name, current.id);
    if (duplicate) fail('A storage repository with this name already exists', 'DUPLICATE_NAME', 409);
    db.prepare(`UPDATE storage_repository_endpoints SET name=?,protocol=?,hostname=?,port=?,repository_path=?,
      secret_id=?,write_test_enabled=?,warning_latency_ms=?,critical_latency_ms=?,interval_minutes=?,is_enabled=?,
      version=version+1,updated_by=?,updated_at=datetime('now') WHERE id=?`).run(input.name, input.protocol,
      input.hostname, input.port, input.repositoryPath, input.secretId, Number(input.writeTestEnabled),
      input.warningLatencyMs, input.criticalLatencyMs, input.intervalMinutes, Number(input.isEnabled), actor.id, current.id);
    return publicRow(this._row(current.id, db), actor);
  }

  remove(id, actor, database) {
    this._actor(actor, true);
    const db = this._db(database);
    const current = this._row(id, db);
    db.prepare('DELETE FROM storage_repository_endpoints WHERE id=?').run(current.id);
    return publicRow(current, actor);
  }

  async _resolve(repository, timeoutMs) {
    const literalFamily = net.isIP(repository.hostname);
    const lookup = literalFamily ? Promise.resolve([{ address: repository.hostname, family: literalFamily }]) : this._resolver(repository.hostname);
    let timer;
    try {
      const values = await Promise.race([lookup, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); })]);
      const safe = (Array.isArray(values) ? values : [values]).filter(item => item && isSafeAddress(item.address))
        .slice(0, MAX_ADDRESSES).map(item => ({ address: item.address, family: Number(item.family) || net.isIP(item.address) }));
      if (!safe.length) throw new Error('no-safe-address');
      return safe;
    } finally { clearTimeout(timer); }
  }

  _state(stages, repository, latencyMs, writeTest) {
    if (writeTest && stages.cleanup.state !== 'pass') return 'critical';
    if (stages.dns.state !== 'pass' || stages.tcp.state !== 'pass') return 'unavailable';
    if (latencyMs !== null && latencyMs >= repository.critical_latency_ms) return 'critical';
    if (stages.auth.state === 'fail' || stages.list.state === 'fail') return 'degraded';
    if (latencyMs !== null && latencyMs >= repository.warning_latency_ms) return 'degraded';
    if (stages.auth.state !== 'pass' || stages.list.state !== 'pass') return 'unknown';
    return 'healthy';
  }

  _notify(repository, previous, observation) {
    if (!previous || STATE_RANK[observation.state] <= STATE_RANK[previous.state] || STATE_RANK[observation.state] < STATE_RANK.degraded) return;
    try {
      const notifications = this._notifications || require('./misc').notifications;
      notifications.create({ userId: null, type: observation.state === 'critical' ? 'error' : 'warning',
        title: `Repository health worsened: ${repository.name}`,
        message: `${repository.protocol.toUpperCase()} repository changed from ${previous.state} to ${observation.state}. Review Storage Posture.`,
        link: '#/storage-posture' });
    } catch { /* best effort */ }
    try {
      const audit = this._audit || require('./audit');
      audit.log({ action: 'storage_repository_health_regression', targetType: 'storage_repository',
        targetId: String(repository.id), username: 'system', details: { from: previous.state, to: observation.state,
          evidenceHash: observation.evidenceHash } });
    } catch { /* best effort */ }
  }

  _record(repository, result, actor, database) {
    const db = this._db(database);
    const previous = db.prepare('SELECT state,fingerprint FROM storage_repository_states WHERE repository_id=?').get(repository.id);
    const fingerprint = sha256(JSON.stringify({ state: result.state,
      stages: Object.fromEntries(Object.entries(result.stages).map(([key, value]) => [key, value.code])) }));
    db.transaction(() => {
      db.prepare(`INSERT INTO storage_repository_observations
        (repository_id,observed_at,state,latency_ms,stages_json,addresses_json,evidence_hash,write_test,cleanup_proven,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(repository.id, result.observedAt, result.state, result.latencyMs,
        JSON.stringify(result.stages), JSON.stringify(result.addresses), result.evidenceHash, Number(result.writeTest),
        result.cleanupProven === null ? null : Number(result.cleanupProven), actor?.id || null);
      db.prepare(`INSERT INTO storage_repository_states (repository_id,state,fingerprint,observed_at) VALUES (?,?,?,?)
        ON CONFLICT(repository_id) DO UPDATE SET state=excluded.state,fingerprint=excluded.fingerprint,
        observed_at=excluded.observed_at,updated_at=datetime('now')`).run(repository.id, result.state, fingerprint, result.observedAt);
    })();
    this._notify(repository, previous, result);
    return result;
  }

  async probe(id, actor = null, options = {}) {
    if (actor) this._actor(actor, true);
    const db = this._db(options.database);
    const repository = this._row(id, db);
    const timeoutMs = integer(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs', 250, 30000);
    const observedAt = options.now ? new Date(options.now).toISOString() : new Date().toISOString();
    const stages = {
      dns: { state: 'unknown', code: 'DNS_NOT_RUN' }, tcp: { state: 'not_run', code: 'TCP_NOT_RUN' },
      auth: { state: 'not_run', code: 'AUTH_NOT_RUN' }, list: { state: 'not_run', code: 'LIST_NOT_RUN' },
      write: { state: 'not_run', code: 'WRITE_NOT_REQUESTED' }, cleanup: { state: 'not_run', code: 'CLEANUP_NOT_REQUESTED' },
    };
    let addresses = [];
    let latencyMs = null;
    try {
      const started = Date.now();
      addresses = await this._resolve(repository, timeoutMs);
      stages.dns = { state: 'pass', code: 'DNS_RESOLVED', latencyMs: Date.now() - started };
    } catch { stages.dns = { state: 'fail', code: 'DNS_FAILED' }; }
    if (stages.dns.state === 'pass') {
      try {
        const connected = await this._connector({ ...addresses[0], port: repository.port, timeoutMs });
        latencyMs = Number.isFinite(connected?.latencyMs) ? Math.max(0, Math.round(connected.latencyMs)) : null;
        stages.tcp = { state: 'pass', code: 'TCP_CONNECTED', ...(latencyMs === null ? {} : { latencyMs }) };
      } catch { stages.tcp = { state: 'fail', code: 'TCP_FAILED' }; }
    }
    if (stages.tcp.state === 'pass' && this._adapter?.probeRead) {
      try {
        const secret = await this._secretResolver(repository.secret_id, db);
        const adapter = await this._adapter.probeRead(publicRow(repository, { role: 'admin' }), { secret, timeoutMs, address: addresses[0] });
        stages.auth = normalizeStage(adapter?.auth, 'AUTH_UNKNOWN');
        stages.list = normalizeStage(adapter?.list, 'LIST_UNKNOWN');
        if (Number.isFinite(adapter?.latencyMs)) latencyMs = Math.max(latencyMs || 0, Math.round(adapter.latencyMs));
      } catch { stages.auth = { state: 'fail', code: 'ADAPTER_FAILED' }; stages.list = { state: 'not_run', code: 'LIST_NOT_RUN' }; }
    } else if (stages.tcp.state === 'pass') {
      stages.auth = { state: 'unknown', code: 'ADAPTER_UNAVAILABLE' };
      stages.list = { state: 'unknown', code: 'ADAPTER_UNAVAILABLE' };
    }
    const state = this._state(stages, repository, latencyMs, false);
    const evidenceHash = sha256(JSON.stringify({ repositoryId: repository.id, observedAt, state, latencyMs, stages, addresses }));
    return this._record(repository, { repositoryId: repository.id, observedAt, state, latencyMs, stages,
      addresses, evidenceHash, writeTest: false, cleanupProven: null }, actor, db);
  }

  async writeTest(id, body, actor, options = {}) {
    this._actor(actor, true);
    exact(body, ['confirmation'], 'writeTest');
    const db = this._db(options.database);
    const repository = this._row(id, db);
    if (!repository.write_test_enabled) fail('Write test is disabled for this repository', 'WRITE_TEST_DISABLED', 409);
    if (body.confirmation !== `WRITE ${repository.name}`) fail(`Type WRITE ${repository.name} to confirm`, 'CONFIRMATION_REQUIRED', 400);
    if (!this._adapter?.probeWrite) fail('No approved write-test adapter is available', 'ADAPTER_UNAVAILABLE', 501);
    const read = await this.probe(repository.id, actor, options);
    if (read.stages.auth.state !== 'pass' || read.stages.list.state !== 'pass') fail('Read-only repository checks must pass before a write test', 'READ_PREFLIGHT_FAILED', 409);
    const marker = `dd-health-${crypto.randomBytes(12).toString('hex')}.tmp`;
    let adapter;
    try {
      const secret = await this._secretResolver(repository.secret_id, db);
      adapter = await this._adapter.probeWrite(publicRow(repository, { role: 'admin' }),
        { secret, timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS, marker, maxBytes: 4096 });
    } catch { adapter = { write: { state: 'fail', code: 'WRITE_FAILED' }, cleanup: { state: 'fail', code: 'CLEANUP_UNPROVEN' } }; }
    const stages = { ...read.stages, write: normalizeStage(adapter?.write, 'WRITE_UNKNOWN'),
      cleanup: normalizeStage(adapter?.cleanup, 'CLEANUP_UNPROVEN') };
    const cleanupProven = stages.cleanup.state === 'pass';
    const state = this._state(stages, repository, read.latencyMs, true);
    const observedAt = options.now ? new Date(options.now).toISOString() : new Date().toISOString();
    const evidenceHash = sha256(JSON.stringify({ repositoryId: repository.id, observedAt, state,
      latencyMs: read.latencyMs, stages, addresses: read.addresses, markerHash: sha256(marker) }));
    return this._record(repository, { repositoryId: repository.id, observedAt, state, latencyMs: read.latencyMs,
      stages, addresses: read.addresses, evidenceHash, writeTest: true, cleanupProven }, actor, db);
  }

  async captureAll(options = {}) {
    const db = this._db(options.database);
    db.prepare("DELETE FROM storage_repository_observations WHERE observed_at < datetime('now','-180 days')").run();
    const now = options.now ? new Date(options.now) : new Date();
    const rows = db.prepare(`SELECT r.*,MAX(o.observed_at) last_observed_at FROM storage_repository_endpoints r
      LEFT JOIN storage_repository_observations o ON o.repository_id=r.id WHERE r.is_enabled=1
      GROUP BY r.id ORDER BY r.id LIMIT ?`).all(MAX_REPOSITORIES + 1);
    const results = [];
    for (const repository of rows.slice(0, MAX_REPOSITORIES)) {
      const last = Date.parse(repository.last_observed_at);
      if (Number.isFinite(last) && now.getTime() - last < repository.interval_minutes * 60000) continue;
      try {
        const result = await this.probe(repository.id, null, { database: db, now, timeoutMs: options.timeoutMs });
        results.push({ repositoryId: repository.id, ok: true, state: result.state });
      } catch (error) { results.push({ repositoryId: repository.id, ok: false,
        code: error instanceof StorageRepositoryHealthError ? error.code : 'REPOSITORY_PROBE_FAILED' }); }
    }
    return { results, truncated: rows.length > MAX_REPOSITORIES };
  }
}

const service = new StorageRepositoryHealthService();
module.exports = service;
module.exports.StorageRepositoryHealthService = StorageRepositoryHealthService;
module.exports.StorageRepositoryHealthError = StorageRepositoryHealthError;
module.exports._internals = { hostname, repositoryPath, isSafeAddress, normalizeStage,
  STATE_RANK, CONTROL_LIMITS: { MAX_REPOSITORIES, MAX_HISTORY, MAX_ADDRESSES, DEFAULT_TIMEOUT_MS } };
