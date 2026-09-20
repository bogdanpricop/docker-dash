'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');

class HardwareAdvancedError extends Error {
  constructor(message, status = 400, code = 'HARDWARE_ADVANCED_ERROR', details) {
    super(message); this.name = 'HardwareAdvancedError'; this.status = status; this.code = code; this.details = details;
  }
}
const fail = (message, status, code, details) => new HardwareAdvancedError(message, status, code, details);
const SAFE = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+ -]{0,299}$/; const SECRET = /password|secret|token|credential|private.?key|authorization|cookie/i;
const PRESETS = Object.freeze({
  batch: Object.freeze({ maxCpuReadyPercent: 10, maxStorageLatencyMs: 50, maxMemoryPressurePercent: 95, maxNetworkLatencyMs: 100 }),
  database: Object.freeze({ maxCpuReadyPercent: 5, maxStorageLatencyMs: 15, maxMemoryPressurePercent: 90, maxNetworkLatencyMs: 20 }),
  vdi: Object.freeze({ maxCpuReadyPercent: 5, maxStorageLatencyMs: 20, maxMemoryPressurePercent: 85, maxNetworkLatencyMs: 50 }),
  latency: Object.freeze({ maxCpuReadyPercent: 2, maxStorageLatencyMs: 5, maxMemoryPressurePercent: 80, maxNetworkLatencyMs: 5 }),
  ai: Object.freeze({ maxCpuReadyPercent: 5, maxStorageLatencyMs: 25, maxMemoryPressurePercent: 95, maxNetworkLatencyMs: 20, minGpuSmPercent: 40 }),
});
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value)); const hash = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
const text = (value, key, max = 300) => { const result = String(value ?? '').trim(); if (!result || result.length > max || !SAFE.test(result)) throw fail(`${key} is invalid`); return result; };
const optional = (value, key, max = 300) => value == null || value === '' ? null : text(value, key, max);
const integer = (value, key, min = 0, max = Number.MAX_SAFE_INTEGER) => { const result = Number(value); if (!Number.isSafeInteger(result) || result < min || result > max) throw fail(`${key} is invalid`); return result; };
const number = (value, key, min = 0, max = 1e15) => { const result = Number(value); if (!Number.isFinite(result) || result < min || result > max) throw fail(`${key} is invalid`); return result; };
const time = (value, key) => { const result = new Date(value); if (Number.isNaN(result.getTime())) throw fail(`${key} is invalid`); return result.toISOString(); };
const array = (value, key, max, mapper) => { if (value == null) return []; if (!Array.isArray(value) || value.length > max) throw fail(`${key} is invalid`); return value.map((item, index) => mapper(item, `${key}[${index}]`)); };
function safeObject(value, field, maxBytes = 64 * 1024) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(`${field} is invalid`); if (Buffer.byteLength(stable(value)) > maxBytes) throw fail(`${field} is too large`, 413); const walk = (node, path) => { if (!node || typeof node !== 'object') return; for (const [key, child] of Object.entries(node)) { if (SECRET.test(key)) throw fail(`${path}.${key} may not contain secrets`, 400, 'SECRET_FIELD'); walk(child, `${path}.${key}`); } }; walk(value, field); return canonical(value); }
function versionParts(value) { const match = String(value || '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/); return match ? match.slice(1).map(item => Number(item || 0)) : null; }
function versionAtLeast(actual, required) { const left = versionParts(actual); const right = versionParts(required); if (!left || !right) return null; for (let index = 0; index < 3; index += 1) { if (left[index] > right[index]) return true; if (left[index] < right[index]) return false; } return true; }

class HardwareAdvancedService {
  constructor(dbProvider = getDb) { this._dbProvider = dbProvider; }
  _db() { return this._dbProvider(); }
  _admin(actor) { if (!actor?.id) throw fail('Authentication required', 401); if (actor.role !== 'admin') throw fail('Administrator required', 403); }
  _host(hostId) {
    const id = integer(hostId, 'hostId', 1); const row = this._db().prepare(`SELECT * FROM hardware_host_snapshots WHERE host_id=?
      ORDER BY datetime(observed_at) DESC,id DESC LIMIT 1`).get(id);
    if (!row) throw fail('Hardware snapshot not found', 404);
    return { id: row.id, hostId: row.host_id, providerType: row.provider_type, model: row.model, generation: row.generation,
      observedAt: row.observed_at, hardware: parse(row.hardware_json, {}), evidenceHash: row.evidence_hash };
  }
  _devices(hostId) {
    const row = this._db().prepare(`SELECT * FROM hardware_device_snapshots WHERE host_id=?
      ORDER BY datetime(observed_at) DESC,id DESC LIMIT 1`).get(hostId);
    return row ? { inventory: parse(row.inventory_json, {}), evidenceHash: row.evidence_hash } : { inventory: {}, evidenceHash: null };
  }
  _sourceVm(resourceKey) {
    const rows = this._db().prepare('SELECT host_id,hardware_json,evidence_hash FROM hardware_host_snapshots ORDER BY datetime(observed_at) DESC,id DESC').all();
    const seen = new Set();
    for (const row of rows) { if (seen.has(row.host_id)) continue; seen.add(row.host_id); const vm = (parse(row.hardware_json, {}).vms || []).find(item => item.resourceKey === resourceKey); if (vm) return { vm, hostId: row.host_id, evidenceHash: row.evidence_hash }; }
    throw fail('Workload hardware evidence not found', 404);
  }
  compatibilityScan(body, actor) {
    this._admin(actor); const resourceKey = text(body.resourceKey, 'resourceKey', 180); const source = this._sourceVm(resourceKey);
    const target = this._host(body.targetHostId); const devices = this._devices(target.hostId); const targetProviderVersion = text(body.targetProviderVersion, 'targetProviderVersion', 80);
    const requiredCpuFeatures = array(body.requiredCpuFeatures, 'requiredCpuFeatures', 256, (item, key) => text(item, key, 80).toLowerCase());
    const requiredDevices = array(body.requiredDevices ?? source.vm.deviceRefs, 'requiredDevices', 128, (item, key) => ({ kind: text(item.kind, `${key}.kind`, 40).toLowerCase(), model: optional(item.model, `${key}.model`, 180) }));
    const supportedProviders = array(body.supportedProviders ?? [target.providerType], 'supportedProviders', 16, (item, key) => text(item, key, 40).toLowerCase());
    const minimumProviderVersion = optional(body.minimumProviderVersion, 'minimumProviderVersion', 80); const targetFeatures = new Set((target.hardware.cpu?.features || []).map(item => String(item).toLowerCase()));
    const availableDevices = [...(target.hardware.gpus || []).map(item => ({ kind: 'gpu', model: item.model })), ...(devices.inventory.gpus || []).map(item => ({ kind: 'gpu', model: item.model })), ...(devices.inventory.pciDevices || []).map(item => ({ kind: item.kind, model: item.model })), ...(devices.inventory.usbDevices || []).map(item => ({ kind: 'usb', model: item.model }))];
    const checks = [];
    const add = (code, state, evidence) => checks.push({ code, state, evidence });
    add('PROVIDER_TYPE', supportedProviders.includes(target.providerType) ? 'pass' : 'fail', { actual: target.providerType, supported: supportedProviders });
    const providerVersionOk = minimumProviderVersion ? versionAtLeast(targetProviderVersion, minimumProviderVersion) : true;
    add('PROVIDER_VERSION', providerVersionOk === true ? 'pass' : providerVersionOk === false ? 'fail' : 'unknown', { actual: targetProviderVersion, minimum: minimumProviderVersion });
    add('VCPU_CAPACITY', source.vm.vcpus <= (target.hardware.cpu?.threads || target.hardware.cpu?.cores || 0) ? 'pass' : 'fail', { required: source.vm.vcpus, available: target.hardware.cpu?.threads || target.hardware.cpu?.cores || 0 });
    add('MEMORY_CAPACITY', source.vm.memoryBytes <= (target.hardware.memory?.totalBytes || 0) ? 'pass' : 'fail', { requiredBytes: source.vm.memoryBytes, availableBytes: target.hardware.memory?.totalBytes || 0 });
    const missingFeatures = requiredCpuFeatures.filter(item => !targetFeatures.has(item)); add('CPU_FEATURES', missingFeatures.length ? 'fail' : 'pass', { required: requiredCpuFeatures, missing: missingFeatures });
    const missingDevices = requiredDevices.filter(required => !availableDevices.some(available => available.kind === required.kind && (!required.model || String(available.model || '').toLowerCase() === required.model.toLowerCase()))); add('VIRTUAL_DEVICES', missingDevices.length ? 'fail' : requiredDevices.length && !devices.evidenceHash ? 'unknown' : 'pass', { required: requiredDevices, missingDevices, deviceEvidenceHash: devices.evidenceHash });
    const state = checks.some(item => item.state === 'fail') ? 'blocked' : checks.some(item => item.state === 'unknown') ? 'warning' : 'compatible';
    const requirements = { vcpus: source.vm.vcpus, memoryBytes: source.vm.memoryBytes, requiredCpuFeatures, requiredDevices, supportedProviders, minimumProviderVersion };
    const evidenceHash = hash({ resourceKey, sourceHostId: source.hostId, targetHostId: target.hostId, targetProviderVersion, requirements, checks, sourceEvidenceHash: source.evidenceHash, targetEvidenceHash: target.evidenceHash });
    const found = this._db().prepare('SELECT id FROM virtual_hardware_scans WHERE evidence_hash=?').get(evidenceHash);
    const id = found?.id || Number(this._db().prepare(`INSERT INTO virtual_hardware_scans (resource_key,source_host_id,target_host_id,target_provider_version,requirements_json,checks_json,state,evidence_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(resourceKey, source.hostId, target.hostId, targetProviderVersion, stable(requirements), stable(checks), state, evidenceHash, actor.id).lastInsertRowid);
    return { id, resourceKey, sourceHostId: source.hostId, targetHostId: target.hostId, targetProviderVersion, requirements, checks, state, evidenceHash, duplicate: Boolean(found), providerMutationsStarted: 0 };
  }
  recordBenchmark(body, actor) {
    this._admin(actor); const host = this._host(body.hostId); if (body.controlled !== true) throw fail('controlled must be true for registry baselines');
    const suite = text(body.suite, 'suite', 100); const suiteVersion = text(body.suiteVersion, 'suiteVersion', 80); const metric = text(body.metric, 'metric', 100); const unit = text(body.unit, 'unit', 40);
    const direction = String(body.direction || 'higher'); if (!['higher','lower'].includes(direction)) throw fail('direction is invalid'); const score = number(body.score, 'score', 0); const observedAt = time(body.observedAt || new Date(), 'observedAt'); const runConfig = safeObject(body.runConfig || {}, 'runConfig');
    const hardware = { model: host.model, generation: host.generation, cpu: host.hardware.cpu, memoryBytes: host.hardware.memory?.totalBytes, gpus: host.hardware.gpus, snapshotEvidenceHash: host.evidenceHash };
    const evidenceHash = hash({ hostId: host.hostId, suite, suiteVersion, metric, unit, score, direction, controlled: true, hardware, runConfig, observedAt }); const found = this._db().prepare('SELECT id FROM hardware_benchmarks WHERE evidence_hash=?').get(evidenceHash);
    const id = found?.id || Number(this._db().prepare(`INSERT INTO hardware_benchmarks (host_id,suite,suite_version,metric,unit,score,direction,controlled,hardware_json,run_config_json,observed_at,evidence_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(host.hostId, suite, suiteVersion, metric, unit, score, direction, 1, stable(hardware), stable(runConfig), observedAt, evidenceHash, actor.id).lastInsertRowid);
    return { id, hostId: host.hostId, suite, suiteVersion, metric, unit, score, direction, controlled: true, hardware, runConfig, observedAt, evidenceHash, duplicate: Boolean(found) };
  }
  recordSample(body, actor) {
    this._admin(actor); const hostId = integer(body.hostId, 'hostId', 1); if (!this._db().prepare('SELECT 1 FROM docker_hosts WHERE id=?').get(hostId)) throw fail('Host not found', 404);
    const resourceKey = text(body.resourceKey, 'resourceKey', 180); const observedAt = time(body.observedAt || new Date(), 'observedAt'); const metrics = {
      cpuUtilizationPercent: number(body.cpuUtilizationPercent ?? 0, 'cpuUtilizationPercent', 0, 100), cpuReadyPercent: number(body.cpuReadyPercent ?? 0, 'cpuReadyPercent', 0, 100),
      storageLatencyMs: number(body.storageLatencyMs ?? 0, 'storageLatencyMs', 0, 1e6), storageQueueDepth: number(body.storageQueueDepth ?? 0, 'storageQueueDepth', 0, 1e6),
      memoryPressurePercent: number(body.memoryPressurePercent ?? 0, 'memoryPressurePercent', 0, 100), networkLatencyMs: number(body.networkLatencyMs ?? 0, 'networkLatencyMs', 0, 1e6),
      gpuSmPercent: body.gpuSmPercent == null ? null : number(body.gpuSmPercent, 'gpuSmPercent', 0, 100),
    }; const evidenceHash = hash({ hostId, resourceKey, observedAt, metrics }); const found = this._db().prepare('SELECT id FROM workload_performance_samples WHERE evidence_hash=?').get(evidenceHash);
    const id = found?.id || Number(this._db().prepare('INSERT INTO workload_performance_samples (host_id,resource_key,observed_at,metrics_json,evidence_hash,created_by) VALUES (?,?,?,?,?,?)').run(hostId, resourceKey, observedAt, stable(metrics), evidenceHash, actor.id).lastInsertRowid);
    return { id, hostId, resourceKey, observedAt, metrics, evidenceHash, duplicate: Boolean(found) };
  }
  noisyNeighbors(resourceKeyValue, query, actor) {
    this._admin(actor); const resourceKey = text(resourceKeyValue, 'resourceKey', 180); const windowMinutes = integer(query?.windowMinutes ?? 5, 'windowMinutes', 1, 60);
    const targetRow = this._db().prepare('SELECT * FROM workload_performance_samples WHERE resource_key=? ORDER BY datetime(observed_at) DESC,id DESC LIMIT 1').get(resourceKey); if (!targetRow) throw fail('Performance sample not found', 404);
    const target = parse(targetRow.metrics_json, {}); const peers = this._db().prepare(`SELECT * FROM workload_performance_samples WHERE host_id=? AND resource_key!=?
      AND datetime(observed_at) BETWEEN datetime(?,?) AND datetime(?,?) ORDER BY datetime(observed_at) DESC,id DESC`).all(targetRow.host_id, resourceKey, targetRow.observed_at, `-${windowMinutes} minutes`, targetRow.observed_at, `+${windowMinutes} minutes`);
    const latest = new Map(); for (const row of peers) if (!latest.has(row.resource_key)) latest.set(row.resource_key, row);
    const targetSignals = [target.cpuReadyPercent >= 5 && 'cpu_ready', target.storageLatencyMs >= 20 && 'storage_latency', target.memoryPressurePercent >= 90 && 'memory_pressure'].filter(Boolean);
    const candidates = [...latest.values()].map(row => { const metrics = parse(row.metrics_json, {}); const signals = [metrics.cpuUtilizationPercent >= 80 && 'cpu_saturation', metrics.storageQueueDepth >= 8 && 'storage_queue', metrics.memoryPressurePercent >= 90 && 'memory_pressure'].filter(Boolean); return { resourceKey: row.resource_key, observedAt: row.observed_at, metrics, signals, score: signals.length }; }).filter(item => item.score).sort((left, right) => right.score - left.score);
    const confidence = candidates.length && targetSignals.length ? Number(Math.min(0.95, 0.35 + targetSignals.length * 0.15 + candidates[0].score * 0.15).toFixed(2)) : 0;
    return { resourceKey, hostId: targetRow.host_id, observedAt: targetRow.observed_at, windowMinutes, targetMetrics: target, targetSignals, candidates, state: candidates.length && targetSignals.length ? 'suspected' : targetSignals.length ? 'unattributed' : 'normal', confidence, caveat: 'Colocation and time correlation are evidence, not proof of causation.' };
  }
  compareBenchmarks(body, actor) {
    this._admin(actor); const baseline = this._db().prepare('SELECT * FROM hardware_benchmarks WHERE id=?').get(integer(body.baselineBenchmarkId, 'baselineBenchmarkId', 1)); const candidate = this._db().prepare('SELECT * FROM hardware_benchmarks WHERE id=?').get(integer(body.candidateBenchmarkId, 'candidateBenchmarkId', 1)); if (!baseline || !candidate) throw fail('Benchmark not found', 404);
    if (baseline.suite !== candidate.suite || baseline.metric !== candidate.metric || baseline.unit !== candidate.unit || baseline.direction !== candidate.direction) throw fail('Benchmarks are not comparable', 409, 'BENCHMARK_MISMATCH'); if (baseline.score === 0) throw fail('Zero baseline cannot produce a percentage comparison');
    const changeRef = text(body.changeRef, 'changeRef', 180); const thresholdPercent = number(body.thresholdPercent ?? 5, 'thresholdPercent', 0.1, 100); const deltaPercent = Number((((candidate.score - baseline.score) / Math.abs(baseline.score)) * 100).toFixed(4)); const regressionPercent = Number(Math.max(0, baseline.direction === 'higher' ? -deltaPercent : deltaPercent).toFixed(4)); const state = regressionPercent >= thresholdPercent ? 'regression' : regressionPercent > 0 ? 'warning' : 'pass';
    const assessmentHash = hash({ baselineBenchmarkId: baseline.id, candidateBenchmarkId: candidate.id, changeRef, thresholdPercent, deltaPercent, regressionPercent, state }); const found = this._db().prepare('SELECT id FROM performance_regression_assessments WHERE assessment_hash=?').get(assessmentHash); const id = found?.id || Number(this._db().prepare(`INSERT INTO performance_regression_assessments (baseline_benchmark_id,candidate_benchmark_id,change_ref,threshold_percent,delta_percent,regression_percent,state,assessment_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(baseline.id, candidate.id, changeRef, thresholdPercent, deltaPercent, regressionPercent, state, assessmentHash, actor.id).lastInsertRowid);
    return { id, baselineBenchmarkId: baseline.id, candidateBenchmarkId: candidate.id, changeRef, thresholdPercent, deltaPercent, regressionPercent, state, assessmentHash, duplicate: Boolean(found), providerMutationsStarted: 0 };
  }
  saveProfile(resourceKeyValue, body, actor) {
    this._admin(actor); const resourceKey = text(resourceKeyValue, 'resourceKey', 180); const preset = String(body.preset || 'database'); if (!PRESETS[preset]) throw fail('preset is invalid'); const overrides = body.overrides == null ? {} : safeObject(body.overrides, 'overrides', 8 * 1024); const thresholds = { ...PRESETS[preset] };
    for (const [key, value] of Object.entries(overrides)) { if (!Object.prototype.hasOwnProperty.call(thresholds, key)) throw fail(`override ${key} is unsupported`); thresholds[key] = number(value, `overrides.${key}`, 0, 1e6); }
    const profileHash = hash({ resourceKey, preset, thresholds }); this._db().prepare(`INSERT INTO workload_performance_profiles (resource_key,preset,thresholds_json,profile_hash,updated_by) VALUES (?,?,?,?,?)
      ON CONFLICT(resource_key) DO UPDATE SET preset=excluded.preset,thresholds_json=excluded.thresholds_json,profile_hash=excluded.profile_hash,updated_by=excluded.updated_by,updated_at=datetime('now')`).run(resourceKey, preset, stable(thresholds), profileHash, actor.id);
    return { resourceKey, preset, thresholds, profileHash, providerMutationsStarted: 0, applyEndpoint: null };
  }
  evaluateProfile(resourceKeyValue, actor) {
    this._admin(actor); const resourceKey = text(resourceKeyValue, 'resourceKey', 180); const profile = this._db().prepare('SELECT * FROM workload_performance_profiles WHERE resource_key=?').get(resourceKey); if (!profile) throw fail('Performance profile not found', 404); const sample = this._db().prepare('SELECT * FROM workload_performance_samples WHERE resource_key=? ORDER BY datetime(observed_at) DESC,id DESC LIMIT 1').get(resourceKey); if (!sample) throw fail('Performance sample not found', 404); const thresholds = parse(profile.thresholds_json, {}); const metrics = parse(sample.metrics_json, {}); const map = { maxCpuReadyPercent: 'cpuReadyPercent', maxStorageLatencyMs: 'storageLatencyMs', maxMemoryPressurePercent: 'memoryPressurePercent', maxNetworkLatencyMs: 'networkLatencyMs', minGpuSmPercent: 'gpuSmPercent' };
    const checks = Object.entries(thresholds).map(([threshold, expected]) => { const metric = map[threshold]; const actual = metrics[metric]; const minimum = threshold.startsWith('min'); return { threshold, metric, expected, actual, state: actual == null ? 'unknown' : minimum ? actual >= expected ? 'pass' : 'fail' : actual <= expected ? 'pass' : 'fail' }; }); const state = checks.some(item => item.state === 'fail') ? 'degraded' : checks.some(item => item.state === 'unknown') ? 'warning' : 'pass'; return { resourceKey, preset: profile.preset, thresholds, sample: { id: sample.id, observedAt: sample.observed_at, metrics }, checks, state, providerMutationsStarted: 0 };
  }
  overview(actor) {
    this._admin(actor); const db = this._db(); const scans = db.prepare('SELECT * FROM virtual_hardware_scans ORDER BY id DESC LIMIT 100').all().map(row => ({ id: row.id, resourceKey: row.resource_key, sourceHostId: row.source_host_id, targetHostId: row.target_host_id, targetProviderVersion: row.target_provider_version, checks: parse(row.checks_json, []), state: row.state, evidenceHash: row.evidence_hash })); const benchmarks = db.prepare('SELECT * FROM hardware_benchmarks ORDER BY datetime(observed_at) DESC,id DESC LIMIT 200').all().map(row => ({ id: row.id, hostId: row.host_id, suite: row.suite, suiteVersion: row.suite_version, metric: row.metric, unit: row.unit, score: row.score, direction: row.direction, controlled: Boolean(row.controlled), hardware: parse(row.hardware_json, {}), observedAt: row.observed_at, evidenceHash: row.evidence_hash })); const regressions = db.prepare('SELECT * FROM performance_regression_assessments ORDER BY id DESC LIMIT 100').all().map(row => ({ id: row.id, baselineBenchmarkId: row.baseline_benchmark_id, candidateBenchmarkId: row.candidate_benchmark_id, changeRef: row.change_ref, thresholdPercent: row.threshold_percent, deltaPercent: row.delta_percent, regressionPercent: row.regression_percent, state: row.state, assessmentHash: row.assessment_hash })); const profiles = db.prepare('SELECT * FROM workload_performance_profiles ORDER BY resource_key').all().map(row => ({ resourceKey: row.resource_key, preset: row.preset, thresholds: parse(row.thresholds_json, {}), profileHash: row.profile_hash, providerMutationsStarted: 0 })); return { capabilities: { virtualHardwareCompatibility: true, benchmarkRegistry: true, noisyNeighborCorrelation: true, performanceRegression: true, workloadPerformanceProfiles: true }, safety: { providerMutationsStarted: 0, applyEndpoint: false }, presets: PRESETS, scans, benchmarks, regressions, profiles };
  }
}

const service = new HardwareAdvancedService(); module.exports = service; module.exports.HardwareAdvancedService = HardwareAdvancedService; module.exports.HardwareAdvancedError = HardwareAdvancedError; module.exports.PRESETS = PRESETS;
