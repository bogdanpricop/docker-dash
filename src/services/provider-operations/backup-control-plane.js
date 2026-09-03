'use strict';

const { sha256 } = require('../../utils/crypto');

const SCHEMA_VERSION = '1.0';
const INTEGRITY_METHODS = Object.freeze(['provider', 'metadata', 'checksum', 'chain']);

function _canonical(value) {
  if (Array.isArray(value)) return `[${value.map(_canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${_canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function _state(value) {
  const state = String(value || '').toLowerCase();
  if (['verified', 'failed', 'pending', 'unknown'].includes(state)) return state;
  if (['unverified', 'stale'].includes(state)) return 'pending';
  return 'unknown';
}

function buildContract(host, policy, plan, options = {}) {
  const selected = (plan.scope?.workloads || []).map(workload => ({
    id: workload.id,
    site: workload.site || null,
    owner: workload.owner || null,
    classification: workload.classification || null,
  }));
  const contract = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'providerBackupExecutionContract',
    provider: { type: String(host.daemon_type), endpointId: Number(host.id) },
    policyId: policy.id,
    planHash: plan.planHash,
    backupMode: policy.backupMode,
    selection: {
      evaluatedAtExecution: true,
      selected,
      selectorCount: Object.keys(policy.scope?.selectors?.labels || {}).length
        + (policy.scope?.selectors?.sites || []).length
        + (policy.scope?.selectors?.owners || []).length
        + (policy.scope?.selectors?.classifications || []).length,
    },
    exclusions: {
      workloads: policy.scope?.exclusions?.workloadIds || [],
      labels: policy.scope?.exclusions?.labels || {},
      disks: policy.scope?.exclusions?.diskSelectors || [],
      paths: policy.scope?.exclusions?.pathSelectors || [],
      translatedByProvider: false,
    },
    consistency: policy.consistency,
    concurrency: policy.controls?.limits || {},
    bandwidth: {
      defaultLimitMbps: policy.controls?.bandwidthLimitMbps ?? null,
      windows: policy.controls?.bandwidthWindows || [],
    },
    retention: {
      strategy: policy.retention?.strategy || 'portable_newest',
      policy: policy.retention,
      preview: plan.retention || {},
      mutationAuthorized: false,
    },
    protection: policy.protection,
    verification: policy.verification,
    providerEvidence: options.capability || null,
  };
  return { ...contract, contractHash: sha256(_canonical(contract)) };
}

function _activeCounts(database, policy) {
  const row = database.prepare(`SELECT
      COUNT(*) AS global_count,
      SUM(CASE WHEN h.daemon_type = ? THEN 1 ELSE 0 END) AS provider_count,
      SUM(CASE WHEN p.host_id = ? THEN 1 ELSE 0 END) AS host_count,
      SUM(CASE WHEN p.repository_id = ? THEN 1 ELSE 0 END) AS repository_count,
      SUM(CASE WHEN p.id = ? THEN 1 ELSE 0 END) AS policy_count
    FROM provider_backup_execution_items i
    JOIN provider_backup_executions e ON e.id = i.execution_id
    JOIN provider_backup_policies p ON p.id = e.policy_id
    JOIN docker_hosts h ON h.id = p.host_id
    WHERE i.state = 'running'`).get(
    policy.providerType, policy.hostId, policy.repositoryId, policy.id
  );
  return {
    global: Number(row?.global_count || 0),
    provider: Number(row?.provider_count || 0),
    host: Number(row?.host_count || 0),
    repository: Number(row?.repository_count || 0),
    policy: Number(row?.policy_count || 0),
  };
}

function admission(database, policy) {
  const limits = {
    global: Number(policy.controls?.limits?.global || 16),
    provider: Number(policy.controls?.limits?.provider || 8),
    host: Number(policy.controls?.limits?.host || 4),
    repository: Number(policy.controls?.limits?.repository || 2),
    policy: Number(policy.controls?.maxConcurrent || 1),
  };
  const active = _activeCounts(database, {
    ...policy, providerType: policy.providerType || policy.daemonType || policy.provider?.type,
  });
  const remaining = Object.fromEntries(Object.keys(limits).map(key => [key, Math.max(0, limits[key] - active[key])]));
  const capacity = Math.min(...Object.values(remaining));
  const constrainedBy = Object.keys(remaining).filter(key => remaining[key] === capacity);
  return {
    schemaVersion: SCHEMA_VERSION,
    allowed: capacity > 0,
    capacity,
    limits,
    active,
    remaining,
    constrainedBy,
    evaluatedAt: new Date().toISOString(),
  };
}

function bandwidth(policy, workload, nowInput = new Date()) {
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const matches = (policy.controls?.bandwidthWindows || []).filter(window => {
    if (window.site && window.site !== workload?.site) return false;
    if (window.link && window.link !== workload?.link) return false;
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: window.timezone, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).formatToParts(now).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
    if (window.days?.length && !window.days.includes(day)) return false;
    const time = `${parts.hour}:${parts.minute}`;
    return window.start <= window.end ? time >= window.start && time <= window.end
      : time >= window.start || time <= window.end;
  });
  const selected = matches.sort((a, b) => a.limitMbps - b.limitMbps)[0] || null;
  return {
    limitMbps: selected?.limitMbps ?? policy.controls?.bandwidthLimitMbps ?? null,
    source: selected ? 'window' : policy.controls?.bandwidthLimitMbps ? 'policy' : 'unlimited',
    window: selected ? { site: selected.site || null, link: selected.link || null,
      start: selected.start, end: selected.end, timezone: selected.timezone } : null,
  };
}

function evaluateIntegrity(point, policy, nowInput = new Date()) {
  const required = policy.verification?.requiredMethods || ['provider'];
  const providerMethods = point?.verification?.methods || {};
  const methods = {};
  for (const method of required) {
    if (!INTEGRITY_METHODS.includes(method)) continue;
    if (method === 'provider') methods.provider = _state(point?.verification?.state);
    else if (method === 'metadata') {
      methods.metadata = point?.id && point?.repository?.id && point?.workload?.id && point?.createdAt
        ? 'verified' : 'failed';
    } else methods[method] = _state(providerMethods[method]);
  }
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const encryptionPolicy = policy.protection?.encryption || {};
  let encryption = 'not_required';
  if (encryptionPolicy.mode === 'required') {
    encryption = point?.backup?.encrypted === false ? 'failed' : point?.backup?.encrypted === true ? 'verified' : 'unknown';
    if (encryption === 'verified' && encryptionPolicy.algorithm !== 'provider-native') {
      encryption = String(point?.backup?.encryptionAlgorithm || '').toLowerCase() === encryptionPolicy.algorithm
        ? 'verified' : point?.backup?.encryptionAlgorithm ? 'failed' : 'unknown';
    }
    if (encryption === 'verified' && Number(encryptionPolicy.maximumKeyAgeDays || 0) > 0) {
      const rotatedAt = Date.parse(point?.backup?.encryptionKeyRotatedAt || '');
      encryption = Number.isFinite(rotatedAt)
        ? (now.getTime() - rotatedAt <= Number(encryptionPolicy.maximumKeyAgeDays) * 86400_000 ? 'verified' : 'failed')
        : 'unknown';
    }
  }
  const immutabilityPolicy = policy.protection?.immutability || {};
  let immutability = 'not_required';
  if (immutabilityPolicy.mode === 'required') {
    const immutableUntil = Date.parse(point?.retention?.immutableUntil || '');
    const createdAt = Date.parse(point?.createdAt || '');
    if (!Number.isFinite(immutableUntil)) immutability = 'unknown';
    else {
      const requiredUntil = Number.isFinite(createdAt)
        ? createdAt + Number(immutabilityPolicy.minimumLockDays || 0) * 86400_000 : now.getTime();
      immutability = immutableUntil >= Math.max(now.getTime(), requiredUntil) ? 'verified' : 'failed';
    }
  }
  const protection = { encryption, immutability };
  const states = [...Object.values(methods), ...Object.values(protection).filter(value => value !== 'not_required')];
  const state = states.includes('failed') ? 'failed'
    : states.length && states.every(value => value === 'verified') ? 'verified'
      : states.includes('pending') ? 'pending' : 'unknown';
  const evidence = {
    schemaVersion: SCHEMA_VERSION,
    state,
    methods,
    protection,
    recoveryPointId: point?.id || null,
    observedAt: point?.observedAt || new Date(nowInput).toISOString(),
  };
  return { ...evidence, evidenceHash: sha256(_canonical(evidence)) };
}

function rememberIntegrity(database, itemId, evidence) {
  database.prepare(`INSERT OR IGNORE INTO provider_backup_integrity_evidence
    (execution_item_id,recovery_point_id,state,methods_json,protection_json,evidence_hash,observed_at)
    VALUES (?,?,?,?,?,?,?)`).run(itemId, evidence.recoveryPointId, evidence.state,
    JSON.stringify(evidence.methods), JSON.stringify(evidence.protection), evidence.evidenceHash, evidence.observedAt);
  database.prepare(`UPDATE provider_backup_execution_items SET integrity_json=?,updated_at=datetime('now')
    WHERE id=?`).run(JSON.stringify(evidence), itemId);
  return evidence;
}

module.exports = {
  SCHEMA_VERSION, INTEGRITY_METHODS, buildContract, admission, bandwidth,
  evaluateIntegrity, rememberIntegrity,
  _internals: { _canonical, _state, _activeCounts },
};
