'use strict';

const { getDb } = require('../../db');
const config = require('../../config');
const { generateToken, sha256 } = require('../../utils/crypto');
const metrics = require('../metrics');
const providerSdk = require('../provider-sdk/registry');
const { FEATURE_KEYS } = require('../provider-sdk/catalog');
const { completeFeatures, buildEnvelope, validateEnvelope } = require('../provider-sdk/schema');
const { RESOURCE_KINDS } = require('../provider-sdk/resource-catalog');
const { validateResource } = require('../provider-sdk/resource-schema');
const manifests = require('./manifests');
const fixtures = require('./fixtures');
const resilience = require('./resilience');

const RUN_SCHEMA_VERSION = '1.0';
const SAFE_RUN_ID = /^pcr_[a-f0-9]{26}$/;
const SENSITIVE_KEY = /pass(word)?|secret|token|credential|private.?key|authorization|cookie|native.?ref/i;
const activeRuns = new Map();

class ProviderConformanceError extends Error {
  constructor(message, code = 'PROVIDER_CONFORMANCE_ERROR', status = 400) {
    super(message);
    this.name = 'ProviderConformanceError';
    this.code = code;
    this.status = status;
  }
}

function _string(value, max = 240) {
  if (value === null || value === undefined || value === '') return null;
  return String(value)
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(token|apiKey|secret|password)\s*[:=]\s*[^\s;,]+/gi, '$1=[redacted]')
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

function _safeValue(value, depth = 0) {
  if (depth > 4 || value === undefined) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return _string(value, 1000);
  if (Array.isArray(value)) return value.slice(0, 128).map(item => _safeValue(item, depth + 1));
  if (typeof value !== 'object') return null;
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 128)) {
    if (SENSITIVE_KEY.test(key) || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(key)) continue;
    output[key] = _safeValue(item, depth + 1);
  }
  return output;
}

function _safeJson(value, maxBytes = 32 * 1024) {
  const safe = _safeValue(value);
  const json = JSON.stringify(safe ?? null);
  return Buffer.byteLength(json) <= maxBytes ? json : JSON.stringify({ truncated: true, summary: 'Conformance evidence exceeded the safe limit' });
}

function _parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function _canonical(value) {
  return manifests._internals._canonical(value);
}

function _secretLeak(value) {
  const text = JSON.stringify(value);
  return /bearer\s+[a-z0-9]|https?:\/\/[^\s/@:]+:[^\s/@]+@|(?:password|secret|token|api[_-]?key)\s*[:=]\s*["']?(?!\[redacted\])[^\s,"'}]+/i.test(text);
}

function _check(key, category, weight, run) {
  const started = Date.now();
  return Promise.resolve().then(run).then(result => ({
    key, category, weight, state: result?.state || 'passed',
    durationMs: Date.now() - started, message: _string(result?.message || 'Contract check passed'),
    evidence: _safeValue(result?.evidence || {}),
  })).catch(err => ({
    key, category, weight, state: 'failed', durationMs: Date.now() - started,
    message: _string(err?.message || 'Contract check failed'),
    evidence: { code: _string(err?.code || 'CONTRACT_CHECK_FAILED', 80) },
  }));
}

async function certifyAdapter(adapter, options = {}) {
  const providerType = String(adapter?.type || '').toLowerCase();
  const manifest = options.manifest || manifests.getManifest(providerType);
  const host = options.host || { id: 1, name: `${providerType}-contract`, daemon_type: providerType };
  const corpus = options.fixtures || fixtures.fixturesFor(providerType);
  const checks = [];

  checks.push(await _check('adapter.contract', 'contract', 10, () => {
    if (!/^[a-z][a-z0-9_-]{1,39}$/.test(providerType)) throw new Error('Adapter type is invalid');
    if (typeof adapter.declared !== 'function' || typeof adapter.probe !== 'function') throw new Error('Adapter must implement declared() and probe()');
    return { evidence: { providerType, listResources: typeof adapter.listResources === 'function' } };
  }));
  checks.push(await _check('manifest.schema', 'governance', 10, () => {
    manifests.validateManifest(manifest);
    if (manifest.providerType !== providerType) throw new Error('Manifest and adapter provider types differ');
    return { evidence: { manifestHash: manifests.manifestHash(manifest), variants: manifest.variants.map(item => item.id) } };
  }));

  let featureEvidence = null;
  checks.push(await _check('capabilities.catalog', 'contract', 15, () => {
    const declared = options.declaredFeatures || adapter.declared(host);
    featureEvidence = completeFeatures(declared);
    const envelope = buildEnvelope({
      host, provider: { type: providerType }, probe: { status: 'unreachable' }, features: featureEvidence,
    });
    validateEnvelope(envelope);
    const unknown = Object.values(envelope.features).filter(item => item.state === 'unknown').length;
    if (unknown) return { state: 'warning', message: `${unknown} capabilities have unknown evidence`, evidence: { unknown, total: FEATURE_KEYS.length } };
    return { evidence: { unknown: 0, total: FEATURE_KEYS.length } };
  }));
  checks.push(await _check('inventory.mapping', 'contract', 10, () => {
    if (!featureEvidence) throw new Error('Capability evidence is unavailable');
    const advertised = Object.values(RESOURCE_KINDS).filter(kind => ['supported', 'conditional'].includes(featureEvidence[kind.capability]?.state));
    if (advertised.length && typeof adapter.listResources !== 'function') throw new Error('Inventory is advertised without listResources()');
    return { evidence: { advertisedKinds: advertised.map(item => item.kind) } };
  }));
  checks.push(await _check('fixtures.corpus', 'fixtures', 15, () => {
    fixtures.validateCorpus(corpus);
    if (!corpus.length) return { state: 'warning', message: 'No provider fixtures are registered', evidence: { fixtures: 0 } };
    return { evidence: { fixtures: corpus.length, variants: [...new Set(corpus.map(item => item.variant))] } };
  }));
  checks.push(await _check('fault.taxonomy', 'resilience', 10, async () => ({
    evidence: await _exerciseFaultScenarios(),
  })));
  checks.push(await _check('operation.safety', 'safety', 15, () => {
    const safety = manifest.mutationRequirements;
    const missing = Object.entries(safety).filter(([, enabled]) => enabled !== true).map(([key]) => key);
    if (missing.length) throw new Error(`Operation safety declarations missing: ${missing.join(', ')}`);
    return { evidence: safety };
  }));
  checks.push(await _check('release.lifecycle', 'governance', 10, () => ({
    evidence: {
      rings: Object.fromEntries(manifest.variants.map(item => [item.id, item.releaseRing])),
      deprecations: manifest.deprecations.length,
    },
  })));
  checks.push(await _check('evidence.secret_scan', 'security', 15, () => {
    const evidence = { manifest, corpus: corpus.map(item => ({ id: item.id, providerType: item.providerType, variant: item.variant })) };
    if (_secretLeak(evidence)) throw new Error('Secret-like data found in static conformance evidence');
    return { evidence: { clean: true } };
  }));
  return checks;
}

async function _exerciseFaultScenarios() {
  const outcomes = {};
  const isolated = new resilience.ProviderResilienceManager({
    concurrency: 1, maxQueue: 0, timeoutMs: 10, failureThreshold: 5, cooldownMs: 100,
  });
  try { await isolated.run('fault-timeout', () => fixtures.createFakeAdapter('timeout').probe()); }
  catch (err) { outcomes.timeout = err?.code === 'PROVIDER_REQUEST_TIMEOUT' ? 'bounded' : 'invalid'; }
  try { await fixtures.createFakeAdapter('auth_expiry').probe(); }
  catch (err) { outcomes.auth_expiry = err?.code === 'AUTH_EXPIRED' ? 'classified' : 'invalid'; }
  try {
    const partial = await fixtures.createFakeAdapter('partial_response').probe();
    buildEnvelope({ host: { id: 1, name: 'fake', daemon_type: 'fake_provider' }, provider: partial.provider, probe: { status: 'reachable' }, features: partial.features });
    outcomes.partial_response = 'accepted-invalid';
  } catch { outcomes.partial_response = 'rejected'; }
  const redirected = await fixtures.createFakeAdapter('redirect').probe();
  outcomes.redirect = redirected.redirect?.followed === true ? 'explicit' : 'invalid';
  const lost = await fixtures.createFakeAdapter('task_loss').probe();
  outcomes.task_loss = lost.task?.state === 'unknown' ? 'unknown-safe' : 'invalid';
  if (Object.values(outcomes).some(value => ['invalid', 'accepted-invalid'].includes(value))) {
    throw new Error('Provider fault injection behavior is unsafe');
  }
  return { scenarios: outcomes };
}

function _score(checks) {
  const eligible = checks.filter(check => check.state !== 'skipped');
  const maxScore = eligible.reduce((total, check) => total + check.weight, 0);
  const score = eligible.reduce((total, check) => total
    + (check.state === 'passed' ? check.weight : check.state === 'warning' ? Math.floor(check.weight / 2) : 0), 0);
  const failed = eligible.some(check => check.state === 'failed');
  const warning = eligible.some(check => check.state === 'warning');
  return {
    score, maxScore, state: failed ? 'failed' : warning ? 'warning' : 'passed',
    grade: failed ? 'failed' : warning ? 'conditional' : 'certified',
  };
}

function _rowToRun(row, checks = []) {
  if (!row) return null;
  return {
    schemaVersion: row.schema_version, id: row.id, hostId: row.host_id,
    providerType: row.provider_type, mode: row.mode, state: row.state,
    grade: row.grade, score: row.score, maxScore: row.max_score,
    scorePercent: row.max_score ? Math.round((row.score / row.max_score) * 100) : 0,
    manifestHash: row.manifest_hash, evidenceHash: row.evidence_hash,
    providerVersion: row.provider_version, apiVersion: row.api_version,
    createdBy: row.created_by, startedAt: row.started_at,
    completedAt: row.completed_at, createdAt: row.created_at,
    checks,
  };
}

function _checks(database, runId) {
  return database.prepare(`SELECT * FROM provider_conformance_checks WHERE run_id = ? ORDER BY id`).all(runId).map(row => ({
    key: row.check_key, category: row.category, state: row.state, weight: row.weight,
    durationMs: row.duration_ms, message: row.message, evidence: _parseJson(row.evidence_json, {}),
  }));
}

function get(runId, database) {
  if (!SAFE_RUN_ID.test(String(runId || ''))) return null;
  const db = database || getDb();
  const row = db.prepare('SELECT * FROM provider_conformance_runs WHERE id = ?').get(runId);
  return row ? _rowToRun(row, _checks(db, runId)) : null;
}

function listForHost(hostId, options = {}, database) {
  const db = database || getDb();
  const id = Number(hostId);
  const limit = Number(options.limit ?? 20);
  if (!Number.isInteger(id) || id <= 0) throw new ProviderConformanceError('Valid provider host required', 'INVALID_HOST');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProviderConformanceError('Conformance limit must be between 1 and 100', 'INVALID_CONFORMANCE_LIMIT');
  return db.prepare('SELECT * FROM provider_conformance_runs WHERE host_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(id, limit).map(row => _rowToRun(row));
}

function _persistChecks(database, runId, checks) {
  const insert = database.prepare(`INSERT INTO provider_conformance_checks
    (run_id, check_key, category, state, weight, duration_ms, message, evidence_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const check of checks) insert.run(runId, check.key, check.category, check.state,
    check.weight, check.durationMs, check.message, _safeJson(check.evidence));
}

async function _runForHost(host, options = {}) {
  if (!host || !Number.isInteger(Number(host.id)) || Number(host.id) <= 0) throw new ProviderConformanceError('Valid provider host required', 'INVALID_HOST');
  const providerType = String(host.daemon_type || '').toLowerCase();
  const manifest = manifests.getManifest(providerType);
  if (!manifest) throw new ProviderConformanceError('Provider has no conformance manifest', 'PROVIDER_MANIFEST_UNAVAILABLE', 400);
  const adapter = providerSdk.getAdapter(providerType);
  const database = options.database || getDb();
  const runId = `pcr_${generateToken(13)}`;
  const manifestHash = manifests.manifestHash(manifest);
  prune(database);
  database.prepare(`INSERT INTO provider_conformance_runs
    (id, host_id, provider_type, mode, manifest_hash, created_by) VALUES (?, ?, ?, 'live_readonly', ?, ?)`)
    .run(runId, Number(host.id), providerType, manifestHash, options.createdBy || null);

  const checks = await certifyAdapter(adapter, { host, manifest });
  let capabilityEnvelope = null;
  checks.push(await _check('live.capabilities', 'live', 20, async () => {
    capabilityEnvelope = await providerSdk.capabilitiesForHost(host, { refresh: true });
    validateEnvelope(capabilityEnvelope);
    if (capabilityEnvelope.probe.status !== 'reachable') throw Object.assign(new Error('Provider endpoint is unreachable'), { code: capabilityEnvelope.probe.error?.code });
    return { evidence: {
      provider: capabilityEnvelope.provider.type, variant: capabilityEnvelope.provider.variant,
      version: capabilityEnvelope.provider.version, apiVersion: capabilityEnvelope.provider.apiVersion,
      durationMs: capabilityEnvelope.probe.durationMs,
      featureStates: Object.fromEntries(Object.entries(capabilityEnvelope.features).map(([key, value]) => [key, value.state])),
    } };
  }));

  const identitySamples = [];
  if (capabilityEnvelope?.probe?.status === 'reachable') {
    for (const [slug, kind] of Object.entries(RESOURCE_KINDS)) {
      const state = capabilityEnvelope.features[kind.capability]?.state;
      if (!['supported', 'conditional'].includes(state)) continue;
      checks.push(await _check(`live.inventory.${kind.kind}`, 'live', 8, async () => {
        const inventory = await providerSdk.resourcesForHost(host, slug, { limit: 25, database });
        for (const item of inventory.items) validateResource(item);
        if (inventory.items[0]) identitySamples.push({ slug, kind: kind.kind, id: inventory.items[0].id });
        if (_secretLeak(inventory)) throw new Error('Secret-like data found in normalized inventory');
        return { evidence: { kind: kind.kind, count: inventory.count, totalObserved: inventory.totalObserved, truncated: inventory.truncated } };
      }));
    }
  } else {
    checks.push({ key: 'live.inventory', category: 'live', state: 'skipped', weight: 8, durationMs: 0, message: 'Inventory skipped because capability probe failed', evidence: {} });
  }

  checks.push(await _check('live.identity_stability', 'live', 10, async () => {
    if (!identitySamples.length) return { state: 'warning', message: 'No resource sample available for identity stability', evidence: { samples: 0 } };
    const sample = identitySamples[0];
    const repeat = await providerSdk.resourcesForHost(host, sample.slug, { limit: 25, database });
    if (!repeat.items.some(item => item.id === sample.id)) throw new Error('Canonical resource identity changed between reads');
    return { evidence: { kind: sample.kind, stable: true } };
  }));

  checks.push(await _check('live.secret_scan', 'security', 15, () => {
    if (_secretLeak(checks.map(check => check.evidence))) throw new Error('Secret-like data found in live evidence');
    return { evidence: { clean: true } };
  }));

  const result = _score(checks);
  const evidenceInput = {
    schemaVersion: RUN_SCHEMA_VERSION, hostId: Number(host.id), providerType,
    mode: 'live_readonly', manifestHash,
    checks: checks.map(check => ({ key: check.key, category: check.category, state: check.state, weight: check.weight, evidence: check.evidence })),
  };
  const evidenceHash = sha256(_canonical(evidenceInput));
  database.transaction(() => {
    _persistChecks(database, runId, checks);
    database.prepare(`UPDATE provider_conformance_runs SET state = ?, grade = ?, score = ?, max_score = ?,
      evidence_hash = ?, provider_version = ?, api_version = ?, completed_at = datetime('now') WHERE id = ?`)
      .run(result.state, result.grade, result.score, result.maxScore, evidenceHash,
        _string(capabilityEnvelope?.provider?.version, 120), _string(capabilityEnvelope?.provider?.apiVersion, 120), runId);
  })();
  metrics.recordProviderConformance?.(providerType, result.grade);
  return get(runId, database);
}

async function runForHost(host, options = {}) {
  const hostId = Number(host?.id);
  if (!Number.isInteger(hostId) || hostId <= 0) throw new ProviderConformanceError('Valid provider host required', 'INVALID_HOST');
  if (activeRuns.has(hostId)) throw new ProviderConformanceError('A conformance run is already active for this host', 'CONFORMANCE_ALREADY_RUNNING', 409);
  const pending = _runForHost(host, options);
  activeRuns.set(hostId, pending);
  try { return await pending; }
  finally { if (activeRuns.get(hostId) === pending) activeRuns.delete(hostId); }
}

function prune(database, retentionDays = config.providerConformance?.retentionDays) {
  const db = database || getDb();
  const days = Number(retentionDays);
  if (!Number.isInteger(days) || days < 1 || days > 3650) return 0;
  return db.prepare(`DELETE FROM provider_conformance_runs
    WHERE completed_at IS NOT NULL AND completed_at < datetime('now', ?)`)
    .run(`-${days} days`).changes;
}

function scorecard(database) {
  const db = database || getDb();
  return manifests.listManifests().map(manifest => {
    const latest = db.prepare(`SELECT * FROM provider_conformance_runs
      WHERE provider_type = ? AND state != 'running' ORDER BY created_at DESC, id DESC LIMIT 1`).get(manifest.providerType);
    let featureStates = null;
    if (latest) {
      const capabilityCheck = _checks(db, latest.id).find(check => check.key === 'live.capabilities');
      featureStates = capabilityCheck?.evidence?.featureStates || null;
    }
    if (!featureStates) {
      const fixtureSupported = new Set(fixtures.fixturesFor(manifest.providerType).flatMap(item => item.supportedCapabilities));
      featureStates = Object.fromEntries(FEATURE_KEYS.map(key => [key, fixtureSupported.has(key) ? 'supported' : 'unsupported']));
    }
    const capabilities = FEATURE_KEYS.map(key => ({
      key,
      delivery: featureStates[key] === 'supported' ? 'shipped' : featureStates[key] === 'conditional' ? 'partial' : 'planned',
      state: featureStates[key] || 'unknown', evidence: latest ? `conformance:${latest.id}` : `fixture:${manifest.providerType}`,
    }));
    const counts = capabilities.reduce((output, item) => { output[item.delivery] += 1; return output; }, { shipped: 0, partial: 0, planned: 0 });
    const history = db.prepare(`SELECT id, state FROM provider_conformance_runs
      WHERE provider_type = ? AND state != 'running' ORDER BY created_at DESC, id DESC LIMIT 30`).all(manifest.providerType);
    const durations = history.map(row => _checks(db, row.id).find(check => check.key === 'live.capabilities')?.evidence?.durationMs)
      .filter(value => Number.isFinite(value) && value >= 0);
    const successRate = history.length
      ? Math.round((history.filter(row => row.state !== 'failed').length / history.length) * 10000) / 100
      : null;
    const averageProbeLatencyMs = durations.length
      ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : null;
    const latestRun = latest ? {
      id: latest.id, state: latest.state, grade: latest.grade,
      score: latest.score, maxScore: latest.max_score, evidenceHash: latest.evidence_hash,
      providerVersion: latest.provider_version, apiVersion: latest.api_version,
      completedAt: latest.completed_at,
    } : null;
    return {
      providerType: manifest.providerType, displayName: manifest.displayName,
      releaseRings: Object.fromEntries(manifest.variants.map(item => [item.id, item.releaseRing])),
      counts, latestRun,
      conformanceSlo: {
        windowRuns: history.length, successRatePercent: successRate, averageProbeLatencyMs,
        objectives: { successRatePercent: 95, averageProbeLatencyMs: 5000 },
        status: !history.length ? 'no_evidence'
          : successRate >= 95 && (averageProbeLatencyMs === null || averageProbeLatencyMs <= 5000) ? 'met' : 'missed',
      },
      capabilities,
    };
  });
}

function exportEvidence(database, options = {}) {
  const db = database || getDb();
  const limit = Number(options.limit ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ProviderConformanceError('Export limit must be between 1 and 500', 'INVALID_CONFORMANCE_LIMIT');
  const rows = db.prepare(`SELECT id FROM provider_conformance_runs
    WHERE state != 'running' ORDER BY created_at DESC, id DESC LIMIT ?`).all(limit);
  const evidence = {
    schemaVersion: '1.0', format: 'docker-dash-provider-conformance',
    manifests: manifests.listManifests(), scorecard: scorecard(db),
    runs: rows.map(row => get(row.id, db)),
  };
  return {
    ...evidence, generatedAt: new Date().toISOString(),
    integrityHash: sha256(_canonical(evidence)),
  };
}

module.exports = {
  RUN_SCHEMA_VERSION, ProviderConformanceError, certifyAdapter, runForHost,
  get, listForHost, scorecard, exportEvidence, prune, manifests, fixtures, resilience,
  _internals: { _safeValue, _safeJson, _secretLeak, _score, _canonical, _exerciseFaultScenarios, activeRuns },
};
