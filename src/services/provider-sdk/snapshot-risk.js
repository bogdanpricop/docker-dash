'use strict';

const { getDb } = require('../../db');
const { sha256 } = require('../../utils/crypto');
const registrySingleton = require('./registry');
const snapshotStoreSingleton = require('./vm-snapshot-store');
const bridgeSingleton = require('../provider-operations/snapshot-provider');

const SCHEMA_VERSION = '1.0';
const MAX_VMS = 200;
const MAX_SNAPSHOTS = 5000;
const MAX_RESPONSE_ITEMS = 500;
const MAX_OBSERVATION_ITEMS = 2000;
const MAX_HISTORY = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const SEVERITY_RANK = Object.freeze({ healthy: 0, unknown: 0, warning: 1, critical: 2 });
const DEFAULT_POLICIES = Object.freeze({
  vsphere: Object.freeze({ warningAgeDays: 3, criticalAgeDays: 14, warningChainDepth: 3, criticalChainDepth: 8, warningGrowthPercent: 20, criticalGrowthPercent: 50 }),
  proxmox: Object.freeze({ warningAgeDays: 7, criticalAgeDays: 30, warningChainDepth: 3, criticalChainDepth: 8, warningGrowthPercent: 20, criticalGrowthPercent: 50 }),
  xen: Object.freeze({ warningAgeDays: 7, criticalAgeDays: 30, warningChainDepth: 3, criticalChainDepth: 8, warningGrowthPercent: 20, criticalGrowthPercent: 50 }),
});

class SnapshotRiskError extends Error {
  constructor(message, code = 'SNAPSHOT_RISK_ERROR', status = 400) {
    super(message);
    this.name = 'SnapshotRiskError';
    this.code = code;
    this.status = status;
  }
}

function _fail(message, code, status) { throw new SnapshotRiskError(message, code, status); }
function _json(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function _text(value, max = 160) { return String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max); }
function _day(value) { return new Date(value).toISOString().slice(0, 10); }
function _round(value, precision = 1) { const factor = 10 ** precision; return Math.round(value * factor) / factor; }

function _exact(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) _fail('Policy must be an object', 'INVALID_SNAPSHOT_RISK_POLICY');
  const unexpected = Object.keys(body).filter(key => !allowed.includes(key));
  if (unexpected.length) _fail(`Unexpected policy fields: ${unexpected.join(', ')}`, 'UNEXPECTED_FIELD');
}

function _integer(value, field, min, max) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    _fail(`${field} must be an integer between ${min} and ${max}`, 'INVALID_SNAPSHOT_RISK_POLICY');
  }
  return result;
}

function _policyInput(body) {
  _exact(body, ['warningAgeDays', 'criticalAgeDays', 'warningChainDepth', 'criticalChainDepth', 'warningGrowthPercent', 'criticalGrowthPercent', 'version']);
  const policy = {
    warningAgeDays: _integer(body.warningAgeDays, 'warningAgeDays', 1, 3650),
    criticalAgeDays: _integer(body.criticalAgeDays, 'criticalAgeDays', 2, 3650),
    warningChainDepth: _integer(body.warningChainDepth, 'warningChainDepth', 1, 64),
    criticalChainDepth: _integer(body.criticalChainDepth, 'criticalChainDepth', 2, 64),
    warningGrowthPercent: _integer(body.warningGrowthPercent, 'warningGrowthPercent', 1, 10000),
    criticalGrowthPercent: _integer(body.criticalGrowthPercent, 'criticalGrowthPercent', 2, 10000),
    version: _integer(body.version, 'version', 0, Number.MAX_SAFE_INTEGER),
  };
  if (policy.criticalAgeDays <= policy.warningAgeDays
    || policy.criticalChainDepth <= policy.warningChainDepth
    || policy.criticalGrowthPercent <= policy.warningGrowthPercent) {
    _fail('Every critical threshold must be greater than its warning threshold', 'INVALID_SNAPSHOT_RISK_POLICY');
  }
  return policy;
}

function _rowPolicy(row, providerType) {
  const defaults = DEFAULT_POLICIES[providerType] || DEFAULT_POLICIES.proxmox;
  if (!row) return { ...defaults, source: 'default', version: 0 };
  return {
    warningAgeDays: row.warning_age_days,
    criticalAgeDays: row.critical_age_days,
    warningChainDepth: row.warning_chain_depth,
    criticalChainDepth: row.critical_chain_depth,
    warningGrowthPercent: row.warning_growth_percent,
    criticalGrowthPercent: row.critical_growth_percent,
    source: 'custom', version: row.version,
  };
}

function _depths(rows) {
  const byId = new Map(rows.map(row => [row.canonical_id, row]));
  const memo = new Map();
  const visit = (row, path = new Set()) => {
    if (!row) return null;
    if (memo.has(row.canonical_id)) return memo.get(row.canonical_id);
    if (path.has(row.canonical_id) || ['cycle', 'orphan_parent'].includes(row.integrity_state)) {
      memo.set(row.canonical_id, null); return null;
    }
    if (!row.parent_id) { memo.set(row.canonical_id, 1); return 1; }
    if (!byId.has(row.parent_id)) { memo.set(row.canonical_id, null); return null; }
    const next = new Set(path); next.add(row.canonical_id);
    const parent = visit(byId.get(row.parent_id), next);
    const depth = parent === null ? null : parent + 1;
    memo.set(row.canonical_id, depth);
    return depth;
  };
  for (const row of rows) visit(row);
  return memo;
}

function _state(reasons, hasUnknown) {
  if (reasons.some(reason => reason.severity === 'critical')) return 'critical';
  if (reasons.some(reason => reason.severity === 'warning')) return 'warning';
  return hasUnknown ? 'unknown' : 'healthy';
}

function _riskItem(row, depth, previous, policy, nowMs) {
  const createdMs = row.created_at ? Date.parse(row.created_at) : NaN;
  const ageDays = Number.isFinite(createdMs) ? _round(Math.max(0, nowMs - createdMs) / DAY_MS) : null;
  const sizeBytes = row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes);
  const previousSize = previous?.sizeBytes === null || previous?.sizeBytes === undefined ? null : Number(previous.sizeBytes);
  const growthBytes = sizeBytes !== null && previousSize !== null ? sizeBytes - previousSize : null;
  const growthPercent = growthBytes !== null && previousSize > 0 ? _round(growthBytes / previousSize * 100) : null;
  const resource = _json(row.resource_json, {});
  const consolidationNeeded = resource?.extensions?.consolidationNeeded === true;
  const reasons = [];

  if (['cycle', 'orphan_parent'].includes(row.integrity_state)) reasons.push({ code: `INTEGRITY_${row.integrity_state.toUpperCase()}`, severity: 'critical' });
  if (consolidationNeeded) reasons.push({ code: 'CONSOLIDATION_NEEDED', severity: 'critical' });
  if (ageDays !== null && ageDays >= policy.criticalAgeDays) reasons.push({ code: 'AGE_CRITICAL', severity: 'critical' });
  else if (ageDays !== null && ageDays >= policy.warningAgeDays) reasons.push({ code: 'AGE_WARNING', severity: 'warning' });
  if (depth !== null && depth >= policy.criticalChainDepth) reasons.push({ code: 'CHAIN_CRITICAL', severity: 'critical' });
  else if (depth !== null && depth >= policy.warningChainDepth) reasons.push({ code: 'CHAIN_WARNING', severity: 'warning' });
  if (growthPercent !== null && growthPercent >= policy.criticalGrowthPercent) reasons.push({ code: 'GROWTH_CRITICAL', severity: 'critical' });
  else if (growthPercent !== null && growthPercent >= policy.warningGrowthPercent) reasons.push({ code: 'GROWTH_WARNING', severity: 'warning' });

  const hasUnknown = ageDays === null || depth === null;
  const state = _state(reasons, hasUnknown);
  return {
    snapshotId: row.canonical_id,
    vm: { id: row.vm_id, displayName: _text(row.display_name || row.vm_id) },
    name: _text(row.snapshot_name), createdAt: row.created_at || null,
    ageDays, chainDepth: depth, estimatedBytes: sizeBytes,
    growthBytes, growthPercent, integrityState: row.integrity_state,
    consolidationNeeded, state, reasons,
    observedAt: row.observed_at,
  };
}

function _summary(items, coverage, hasCapture) {
  const states = { healthy: 0, unknown: 0, warning: 0, critical: 0 };
  for (const item of items) states[item.state] += 1;
  let state = states.critical ? 'critical' : states.warning ? 'warning'
    : states.unknown ? 'unknown' : hasCapture || items.length ? 'healthy' : 'unknown';
  if (coverage.evidenceFreshness === 'stale' && state === 'healthy') state = 'unknown';
  const knownSizes = items.filter(item => item.estimatedBytes !== null);
  const knownAges = items.filter(item => item.ageDays !== null);
  const knownDepths = items.filter(item => item.chainDepth !== null);
  return {
    state, snapshotCount: items.length, states,
    staleCount: items.filter(item => item.reasons.some(reason => reason.code.startsWith('AGE_'))).length,
    consolidationVmCount: new Set(items.filter(item => item.consolidationNeeded).map(item => item.vm.id)).size,
    integrityIssueCount: items.filter(item => ['cycle', 'orphan_parent'].includes(item.integrityState)).length,
    oldestAgeDays: knownAges.length ? Math.max(...knownAges.map(item => item.ageDays)) : null,
    maxChainDepth: knownDepths.length ? Math.max(...knownDepths.map(item => item.chainDepth)) : null,
    totalEstimatedBytes: knownSizes.length
      ? knownSizes.reduce((total, item) => total + item.estimatedBytes, 0) : null,
    estimatedBytesKnownCount: knownSizes.length,
  };
}

class SnapshotRiskService {
  constructor(options = {}) {
    this._dbProvider = options.dbProvider || getDb;
    this._registry = options.registry || registrySingleton;
    this._snapshotStore = options.snapshotStore || snapshotStoreSingleton;
    this._bridge = options.bridge || bridgeSingleton;
    this._notifications = options.notifications || null;
    this._audit = options.audit || null;
  }

  _db(database) { return database || this._dbProvider(); }

  _host(host) {
    if (!host || !Number.isSafeInteger(Number(host.id)) || !DEFAULT_POLICIES[host.daemon_type]) {
      _fail('Valid Proxmox, vSphere or Xen host required', 'INVALID_HOST');
    }
    return { ...host, id: Number(host.id) };
  }

  policy(hostInput, database) {
    const host = this._host(hostInput);
    const row = this._db(database).prepare('SELECT * FROM provider_snapshot_risk_policies WHERE host_id = ?').get(host.id);
    return _rowPolicy(row, host.daemon_type);
  }

  updatePolicy(hostInput, body, actor, database) {
    const host = this._host(hostInput);
    if (!actor?.id) _fail('Authentication required', 'AUTHENTICATION_REQUIRED', 401);
    const input = _policyInput(body);
    const db = this._db(database);
    const current = db.prepare('SELECT version FROM provider_snapshot_risk_policies WHERE host_id = ?').get(host.id);
    if ((current?.version || 0) !== input.version) _fail('Snapshot risk policy changed since it was loaded', 'STALE_POLICY', 409);
    db.prepare(`INSERT INTO provider_snapshot_risk_policies
      (host_id,warning_age_days,critical_age_days,warning_chain_depth,critical_chain_depth,warning_growth_percent,critical_growth_percent,version,updated_by)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(host_id) DO UPDATE SET warning_age_days=excluded.warning_age_days,
        critical_age_days=excluded.critical_age_days,warning_chain_depth=excluded.warning_chain_depth,
        critical_chain_depth=excluded.critical_chain_depth,warning_growth_percent=excluded.warning_growth_percent,
        critical_growth_percent=excluded.critical_growth_percent,version=provider_snapshot_risk_policies.version+1,
        updated_by=excluded.updated_by,updated_at=datetime('now')`)
      .run(host.id, input.warningAgeDays, input.criticalAgeDays, input.warningChainDepth,
        input.criticalChainDepth, input.warningGrowthPercent, input.criticalGrowthPercent,
        current ? current.version : 1, actor.id);
    return this.policy(host, db);
  }

  assessHost(hostInput, options = {}) {
    const host = this._host(hostInput);
    const db = this._db(options.database);
    const now = options.now ? new Date(options.now) : new Date();
    if (Number.isNaN(now.getTime())) _fail('Assessment time is invalid', 'INVALID_ASSESSMENT_TIME');
    const today = _day(now);
    const policy = this.policy(host, db);
    const previousRow = db.prepare(`SELECT items_json, observation_day FROM provider_snapshot_risk_observations
      WHERE host_id = ? AND observation_day < ? ORDER BY observation_day DESC LIMIT 1`).get(host.id, today);
    const previousItems = new Map((_json(previousRow?.items_json, []) || []).map(item => [item.snapshotId, item]));
    const rows = db.prepare(`SELECT s.canonical_id,s.vm_id,s.snapshot_name,s.created_at,s.parent_id,
        s.integrity_state,s.observed_at,s.size_bytes,r.display_name,r.resource_json
      FROM provider_vm_snapshots s
      LEFT JOIN provider_resource_snapshots r ON r.canonical_id=s.vm_id AND r.host_id=s.host_id
      WHERE s.host_id=? AND s.is_present=1
      ORDER BY COALESCE(s.created_at,s.first_seen_at) DESC,s.canonical_id LIMIT ?`).all(host.id, MAX_SNAPSHOTS + 1);
    const truncated = rows.length > MAX_SNAPSHOTS;
    const boundedRows = rows.slice(0, MAX_SNAPSHOTS);
    const depths = _depths(boundedRows);
    const items = boundedRows.map(row => _riskItem(row, depths.get(row.canonical_id) ?? null,
      previousItems.get(row.canonical_id), policy, now.getTime()));
    const oldestObservedMs = items.reduce((oldest, item) => {
      const value = Date.parse(item.observedAt); return Number.isFinite(value) ? Math.min(oldest, value) : oldest;
    }, now.getTime());
    const lastObservation = db.prepare(`SELECT observation_day,observed_at FROM provider_snapshot_risk_observations
      WHERE host_id=? ORDER BY observation_day DESC LIMIT 1`).get(host.id);
    const lastCaptureMs = Date.parse(lastObservation?.observed_at);
    const evidenceMs = items.length ? oldestObservedMs : (Number.isFinite(lastCaptureMs) ? lastCaptureMs : null);
    const evidenceFreshness = evidenceMs !== null ? (now.getTime() - evidenceMs > DAY_MS ? 'stale' : 'fresh')
      : options.collection ? 'fresh' : 'unknown';
    const coverage = {
      truncated, processedSnapshots: items.length,
      responseItemLimit: MAX_RESPONSE_ITEMS,
      creationTimeKnown: items.filter(item => item.ageDays !== null).length,
      chainDepthKnown: items.filter(item => item.chainDepth !== null).length,
      estimatedBytesKnown: items.filter(item => item.estimatedBytes !== null).length,
      previousObservationDay: previousRow?.observation_day || null,
      lastCaptureAt: lastObservation?.observed_at || null,
      evidenceFreshness,
      collection: options.collection || null,
    };
    const summary = _summary(items, coverage, Boolean(lastObservation || options.collection));
    const severity = item => SEVERITY_RANK[item.state] || 0;
    const ordered = [...items].sort((left, right) => severity(right) - severity(left)
      || (right.ageDays ?? -1) - (left.ageDays ?? -1) || left.snapshotId.localeCompare(right.snapshotId));
    const historyLimit = Math.min(MAX_HISTORY, Math.max(1, Number(options.historyLimit) || 30));
    const history = db.prepare(`SELECT observation_day,observed_at,summary_json FROM provider_snapshot_risk_observations
      WHERE host_id=? ORDER BY observation_day DESC LIMIT ?`).all(host.id, historyLimit).map(row => ({
      day: row.observation_day, observedAt: row.observed_at, ..._json(row.summary_json, {}),
    }));
    return {
      schemaVersion: SCHEMA_VERSION,
      provider: { type: host.daemon_type, endpointId: host.id },
      observedAt: now.toISOString(), policy, summary, coverage,
      items: options.allItems === true ? ordered : ordered.slice(0, MAX_RESPONSE_ITEMS), history,
      limitations: [
        'Snapshot bytes and growth remain unknown unless the provider reports snapshot-specific bytes.',
        'This monitor never deletes or consolidates snapshots and does not change retention policy.',
        'A snapshot remains in the provider storage failure domain and is not an independent backup.',
      ],
    };
  }

  _notifyTransitions(host, transitions) {
    if (!transitions.length) return;
    try {
      const notifications = this._notifications || require('../misc').notifications;
      const critical = transitions.filter(item => item.to === 'critical').length;
      notifications.create({
        userId: null, type: critical ? 'error' : 'warning',
        title: `Snapshot risk worsened on ${_text(host.name || `host ${host.id}`)}`,
        message: `${transitions.length} snapshot risk transition(s) detected${critical ? `; ${critical} critical` : ''}. Review Storage Posture.`,
        link: '#/storage-posture',
      });
    } catch { /* best-effort notification */ }
    try {
      const audit = this._audit || require('../audit');
      audit.log({
        action: 'provider_snapshot_risk_regression', targetType: 'providerHost', targetId: String(host.id),
        username: 'system', details: { transitionCount: transitions.length,
          criticalCount: transitions.filter(item => item.to === 'critical').length,
          snapshots: transitions.slice(0, 20).map(item => ({ id: item.snapshotId, from: item.from, to: item.to })) },
      });
    } catch { /* best-effort audit */ }
  }

  recordObservation(hostInput, assessment, actor = null, database) {
    const host = this._host(hostInput);
    const db = this._db(database);
    const observationDay = _day(assessment.observedAt);
    const storedItems = assessment.items.slice(0, MAX_OBSERVATION_ITEMS).map(item => ({
      snapshotId: item.snapshotId, sizeBytes: item.estimatedBytes, state: item.state,
    }));
    const evidenceHash = sha256(JSON.stringify({ hostId: host.id, observationDay, summary: assessment.summary, items: storedItems }));
    const previousStates = new Map(db.prepare('SELECT snapshot_id,severity FROM provider_snapshot_risk_states WHERE host_id=?').all(host.id)
      .map(row => [row.snapshot_id, row.severity]));
    const transitions = [];
    const upsertState = db.prepare(`INSERT INTO provider_snapshot_risk_states
      (host_id,snapshot_id,severity,fingerprint,last_observed_at) VALUES (?,?,?,?,?)
      ON CONFLICT(host_id,snapshot_id) DO UPDATE SET severity=excluded.severity,
        fingerprint=excluded.fingerprint,last_observed_at=excluded.last_observed_at,updated_at=datetime('now')`);
    const deleteState = db.prepare('DELETE FROM provider_snapshot_risk_states WHERE host_id=? AND snapshot_id=?');
    db.transaction(() => {
      db.prepare(`INSERT INTO provider_snapshot_risk_observations
        (host_id,observation_day,observed_at,summary_json,items_json,evidence_hash,created_by)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(host_id,observation_day) DO UPDATE SET
        observed_at=excluded.observed_at,summary_json=excluded.summary_json,items_json=excluded.items_json,
        evidence_hash=excluded.evidence_hash,created_by=excluded.created_by,updated_at=datetime('now')`)
        .run(host.id, observationDay, assessment.observedAt, JSON.stringify(assessment.summary),
          JSON.stringify(storedItems), evidenceHash, actor?.id || null);
      const currentIds = new Set();
      for (const item of assessment.items) {
        currentIds.add(item.snapshotId);
        const previous = previousStates.get(item.snapshotId);
        if (previous && SEVERITY_RANK[item.state] > SEVERITY_RANK[previous]
          && SEVERITY_RANK[item.state] >= SEVERITY_RANK.warning) {
          transitions.push({ snapshotId: item.snapshotId, from: previous, to: item.state });
        }
        const fingerprint = sha256(JSON.stringify({ state: item.state, reasons: item.reasons.map(reason => reason.code).sort() }));
        upsertState.run(host.id, item.snapshotId, item.state, fingerprint, assessment.observedAt);
      }
      for (const snapshotId of previousStates.keys()) if (!currentIds.has(snapshotId)) deleteState.run(host.id, snapshotId);
    })();
    this._notifyTransitions(host, transitions);
    return { evidenceHash, transitions };
  }

  async refreshHost(hostInput, options = {}) {
    const host = this._host(hostInput);
    const db = this._db(options.database);
    const inventory = await this._registry.resourcesForHost(host, 'virtual-machines', { limit: MAX_VMS + 1, database: db });
    const candidates = (inventory.items || []).filter(vm => vm.identity?.stability !== 'transient');
    const selected = candidates.slice(0, MAX_VMS);
    if (inventory.truncated !== true && (inventory.items || []).length <= MAX_VMS) {
      if (candidates.length) {
        const placeholders = candidates.map(() => '?').join(',');
        db.prepare(`UPDATE provider_vm_snapshots SET is_present=0,is_current=0,updated_at=datetime('now')
          WHERE host_id=? AND vm_id NOT IN (${placeholders})`).run(host.id, ...candidates.map(vm => vm.id));
      } else {
        db.prepare(`UPDATE provider_vm_snapshots SET is_present=0,is_current=0,updated_at=datetime('now')
          WHERE host_id=?`).run(host.id);
      }
    }
    const failures = [];
    let succeeded = 0;
    let session;
    try {
      session = await this._bridge.openHost(host);
      for (const vm of selected) {
        try {
          const target = this._bridge.targetFromSession(session, vm.id, db);
          const snapshots = await this._bridge.list(target);
          this._snapshotStore.rememberMany({ hostId: host.id, vmId: vm.id, providerType: host.daemon_type }, snapshots, db);
          succeeded += 1;
        } catch (error) {
          failures.push({ vmId: vm.id, code: _text(error.code || 'SNAPSHOT_INVENTORY_FAILED', 80) });
        }
      }
    } finally { await this._bridge.close(session); }
    const collection = {
      attemptedVms: selected.length, succeededVms: succeeded, failedVms: failures.length,
      truncatedVms: candidates.length > MAX_VMS || inventory.items?.length > MAX_VMS,
      failures: failures.slice(0, 50),
    };
    const assessment = this.assessHost(host, { database: db, now: options.now, collection, allItems: true });
    const recorded = this.recordObservation(host, assessment, options.actor, db);
    return { ...assessment, items: assessment.items.slice(0, MAX_RESPONSE_ITEMS), transitions: recorded.transitions };
  }

  async captureAll(options = {}) {
    const db = this._db(options.database);
    db.prepare("DELETE FROM provider_snapshot_risk_observations WHERE observation_day < date('now','-180 days')").run();
    const hosts = db.prepare(`SELECT * FROM docker_hosts WHERE is_active=1
      AND daemon_type IN ('proxmox','vsphere','xen') ORDER BY id`).all();
    const results = [];
    for (const host of hosts) {
      try {
        const assessment = await this.refreshHost(host, { database: db, now: options.now });
        results.push({ hostId: host.id, ok: true, state: assessment.summary.state });
      } catch (error) {
        results.push({ hostId: host.id, ok: false, code: _text(error.code || 'SNAPSHOT_RISK_REFRESH_FAILED', 80) });
      }
    }
    return results;
  }
}

const service = new SnapshotRiskService();
module.exports = service;
module.exports.SnapshotRiskService = SnapshotRiskService;
module.exports.SnapshotRiskError = SnapshotRiskError;
module.exports._internals = {
  DEFAULT_POLICIES, CONTROL_LIMITS: { MAX_VMS, MAX_SNAPSHOTS, MAX_RESPONSE_ITEMS, MAX_OBSERVATION_ITEMS, MAX_HISTORY },
  _policyInput, _rowPolicy, _depths, _riskItem, _summary, SEVERITY_RANK,
};
