'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const dgram = require('dgram');
const net = require('net');
const { getDb } = require('../db');
const appMetrics = require('./metrics');

class VmObservabilityAdvancedError extends Error {
  constructor(message, status = 400, code, details) {
    super(message); this.name = 'VmObservabilityAdvancedError'; this.status = status; this.code = code; this.details = details;
  }
}

const fail = (message, status, code, details) => new VmObservabilityAdvancedError(message, status, code, details);
const clean = (value, key, max = 180) => {
  const result = String(value ?? '').trim();
  if (!result || result.length > max) throw fail(`${key} is required and must be at most ${max} characters`);
  return result;
};
const integer = (value, key, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw fail(`${key} must be an integer between ${min} and ${max}`);
  return result;
};
const number = (value, key, min, max) => {
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) throw fail(`${key} must be between ${min} and ${max}`);
  return result;
};
const json = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const timestamp = (value, key) => {
  const result = new Date(value);
  if (Number.isNaN(result.valueOf())) throw fail(`${key} must be a valid timestamp`);
  return result.toISOString();
};
const severityRank = { info: 0, warning: 1, high: 2, critical: 3 };

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * ratio; const base = Math.floor(position); const remainder = position - base;
  return sorted[base + 1] == null ? sorted[base] : sorted[base] + remainder * (sorted[base + 1] - sorted[base]);
}

function regression(points) {
  if (points.length < 2) return { slope: 0, intercept: points[0]?.y || 0, r2: 0 };
  const meanX = points.reduce((sum, item) => sum + item.x, 0) / points.length;
  const meanY = points.reduce((sum, item) => sum + item.y, 0) / points.length;
  const denominator = points.reduce((sum, item) => sum + (item.x - meanX) ** 2, 0);
  const slope = denominator ? points.reduce((sum, item) => sum + (item.x - meanX) * (item.y - meanY), 0) / denominator : 0;
  const intercept = meanY - slope * meanX;
  const total = points.reduce((sum, item) => sum + (item.y - meanY) ** 2, 0);
  const residual = points.reduce((sum, item) => sum + (item.y - (intercept + slope * item.x)) ** 2, 0);
  return { slope, intercept, r2: total ? Math.max(0, Math.min(1, 1 - residual / total)) : 0 };
}

function privateAddress(address) {
  if (!address) return true;
  if (address === '::1' || address === '::' || address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd')) return true;
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || a >= 224;
  }
  return false;
}

const transport = {
  async http(endpoint, body, contentType, allowPrivate) {
    const url = new URL(endpoint);
    const addresses = await dns.lookup(url.hostname, { all: true });
    if (!allowPrivate && addresses.some(item => privateAddress(item.address))) throw fail('Export target resolves to a private or special-use address', 409, 'EXPORT_PRIVATE_NETWORK_BLOCKED');
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, { method: 'POST', body, redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': contentType, 'User-Agent': 'Docker-Dash-Observability/1.0' } });
      const responseBody = (await response.text()).slice(0, 1000);
      if (!response.ok) throw Object.assign(new Error(`Export target returned HTTP ${response.status}`), { responseCode: response.status, responseBody });
      return { responseCode: response.status, responseBody };
    } finally { clearTimeout(timeout); }
  },
  async udp(endpoint, body, allowPrivate) {
    const url = new URL(endpoint); const port = integer(url.port || 514, 'syslog port', 1, 65535);
    const addresses = await dns.lookup(url.hostname, { all: true });
    if (!allowPrivate && addresses.some(item => privateAddress(item.address))) throw fail('Syslog target resolves to a private or special-use address', 409, 'EXPORT_PRIVATE_NETWORK_BLOCKED');
    const address = addresses[0]; const family = address.family === 6 ? 'udp6' : 'udp4'; const socket = dgram.createSocket(family);
    try { await new Promise((resolve, reject) => socket.send(Buffer.from(body), port, address.address, error => error ? reject(error) : resolve())); }
    finally { socket.close(); }
    return { responseCode: 0, responseBody: 'UDP datagram sent' };
  },
};

class VmObservabilityAdvancedService {
  constructor(dbProvider = getDb) { this._dbProvider = dbProvider; }
  _db() { return this._dbProvider(); }
  _admin(actor) {
    if (!actor?.id) throw fail('Authenticated user is required', 401);
    if (actor.role !== 'admin') throw fail('Administrator permission is required', 403, 'GOVERNANCE_FORBIDDEN');
  }

  overview(actor) {
    this._admin(actor); const db = this._db();
    return {
      baselinePolicies: db.prepare('SELECT * FROM vm_observability_baseline_policies ORDER BY id DESC').all(),
      baselineAssessments: db.prepare('SELECT * FROM vm_observability_baseline_assessments ORDER BY assessed_at DESC,id DESC LIMIT 500').all()
        .map(row => ({ ...row, explanation: json(row.explanation_json, {}) })),
      maintenanceWindows: db.prepare(`SELECT w.*,u.username owner_username FROM vm_observability_maintenance_windows w
        JOIN users u ON u.id=w.owner_user_id ORDER BY starts_at DESC LIMIT 500`).all(),
      suppressions: db.prepare(`SELECT s.*,a.resource_type,a.resource_key FROM vm_observability_alert_suppressions s
        JOIN vm_observability_signal_alerts a ON a.id=s.alert_id ORDER BY s.id DESC LIMIT 500`).all().map(row => ({ ...row, evidence: json(row.evidence_json, {}) })),
      exportTargets: db.prepare('SELECT * FROM vm_observability_export_targets ORDER BY id DESC').all().map(row => ({ ...row, filters: json(row.filters_json, {}) })),
      exportDeliveries: db.prepare('SELECT * FROM vm_observability_export_deliveries ORDER BY delivered_at DESC,id DESC LIMIT 500').all()
        .map(row => ({ ...row, evidence: json(row.evidence_json, {}) })),
      capacityForecasts: db.prepare('SELECT * FROM vm_observability_capacity_forecasts ORDER BY calculated_at DESC,id DESC LIMIT 500').all()
        .map(row => ({ ...row, evidence: json(row.evidence_json, {}) })),
      triageReports: db.prepare('SELECT * FROM vm_observability_triage_reports ORDER BY created_at DESC,id DESC LIMIT 500').all()
        .map(row => ({ ...row, evidence: json(row.evidence_json, {}), candidates: json(row.candidates_json, []), runbooks: json(row.runbooks_json, []) })),
      sloPolicies: db.prepare('SELECT * FROM vm_observability_slo_policies ORDER BY id DESC').all(),
      runbooks: db.prepare('SELECT * FROM vm_observability_runbook_mappings ORDER BY id DESC').all(),
      privacyPolicies: db.prepare('SELECT * FROM vm_observability_privacy_policies ORDER BY provider_host_id').all()
        .map(row => ({ ...row, redactedLabelKeys: json(row.redacted_label_keys_json, []) })),
    };
  }

  createBaseline(body = {}, actor) {
    this._admin(actor); const db = this._db(); const metricKey = clean(body.metricKey, 'metricKey', 120);
    if (!db.prepare('SELECT 1 FROM vm_metric_definitions WHERE metric_key=?').get(metricKey)) throw fail('Unknown metricKey');
    const seasonality = body.seasonality || 'hour_of_day';
    if (!['none', 'hour_of_day', 'day_of_week'].includes(seasonality)) throw fail('seasonality is invalid');
    const result = db.prepare(`INSERT INTO vm_observability_baseline_policies
      (name,provider_host_id,resource_type,resource_key,metric_key,window_days,seasonality,percentile,deviation_multiplier,minimum_samples,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(clean(body.name, 'name', 160), integer(body.providerHostId ?? 0, 'providerHostId'),
      clean(body.resourceType || 'vm', 'resourceType', 60), body.resourceKey ? clean(body.resourceKey, 'resourceKey', 300) : null,
      metricKey, integer(body.windowDays ?? 14, 'windowDays', 2, 90), seasonality, number(body.percentile ?? 0.95, 'percentile', 0.5, 0.999),
      number(body.deviationMultiplier ?? 1.5, 'deviationMultiplier', 1, 100), integer(body.minimumSamples ?? 20, 'minimumSamples', 4, 100000), actor.id);
    return db.prepare('SELECT * FROM vm_observability_baseline_policies WHERE id=?').get(result.lastInsertRowid);
  }

  evaluateBaselines(query = {}, actor) {
    this._admin(actor); const db = this._db(); const policyId = query.policyId == null ? null : integer(query.policyId, 'policyId', 1);
    const policies = policyId ? db.prepare('SELECT * FROM vm_observability_baseline_policies WHERE id=? AND enabled=1').all(policyId)
      : db.prepare('SELECT * FROM vm_observability_baseline_policies WHERE enabled=1 ORDER BY id').all();
    const assessments = [];
    db.transaction(() => {
      for (const policy of policies) {
        const where = ['provider_host_id=?', 'resource_type=?', 'metric_key=?', 'sample_at>=?'];
        const args = [policy.provider_host_id, policy.resource_type, policy.metric_key,
          new Date(Date.now() - policy.window_days * 86400000).toISOString()];
        if (policy.resource_key) { where.push('resource_key=?'); args.push(policy.resource_key); }
        const rows = db.prepare(`SELECT resource_key,value,sample_at FROM vm_metric_samples WHERE ${where.join(' AND ')}
          ORDER BY resource_key,sample_at`).all(...args);
        const byResource = new Map();
        for (const row of rows) { if (!byResource.has(row.resource_key)) byResource.set(row.resource_key, []); byResource.get(row.resource_key).push(row); }
        for (const [resourceKey, points] of byResource) {
          const current = points[points.length - 1]; const currentDate = new Date(current.sample_at);
          let historical = points.slice(0, -1);
          if (policy.seasonality === 'hour_of_day') historical = historical.filter(item => new Date(item.sample_at).getUTCHours() === currentDate.getUTCHours());
          if (policy.seasonality === 'day_of_week') historical = historical.filter(item => new Date(item.sample_at).getUTCDay() === currentDate.getUTCDay());
          const baseline = percentile(historical.map(item => item.value), policy.percentile);
          const threshold = baseline == null ? null : baseline * policy.deviation_multiplier;
          const status = historical.length < policy.minimum_samples ? 'insufficient_evidence'
            : current.value > threshold ? 'above_baseline' : 'normal';
          const explanation = { metricKey: policy.metric_key, windowDays: policy.window_days, seasonality: policy.seasonality,
            percentile: policy.percentile, deviationMultiplier: policy.deviation_multiplier, minimumSamples: policy.minimum_samples,
            observedSamples: historical.length, comparison: threshold == null ? null : `${current.value} > ${threshold}` };
          const id = Number(db.prepare(`INSERT INTO vm_observability_baseline_assessments
            (policy_id,resource_key,status,current_value,baseline_value,threshold_value,sample_count,explanation_json)
            VALUES (?,?,?,?,?,?,?,?)`).run(policy.id, resourceKey, status, current.value, baseline, threshold, historical.length,
            JSON.stringify(explanation)).lastInsertRowid);
          assessments.push({ id, policyId: policy.id, resourceKey, status, currentValue: current.value, baselineValue: baseline,
            thresholdValue: threshold, sampleCount: historical.length, explanation });
        }
      }
    })();
    return { evaluatedPolicies: policies.length, assessments };
  }

  createMaintenance(body = {}, actor) {
    this._admin(actor); const startsAt = timestamp(body.startsAt, 'startsAt'); const endsAt = timestamp(body.endsAt, 'endsAt');
    if (endsAt <= startsAt) throw fail('endsAt must be after startsAt');
    if (Date.parse(endsAt) - Date.parse(startsAt) > 31 * 86400000) throw fail('Maintenance window cannot exceed 31 days');
    const owner = integer(body.ownerUserId ?? actor.id, 'ownerUserId', 1);
    if (!this._db().prepare('SELECT 1 FROM users WHERE id=? AND is_active=1').get(owner)) throw fail('ownerUserId must identify an active user');
    const result = this._db().prepare(`INSERT INTO vm_observability_maintenance_windows
      (name,provider_host_id,scope_type,scope_key,starts_at,ends_at,owner_user_id,reason,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(clean(body.name, 'name', 160), integer(body.providerHostId ?? 0, 'providerHostId'),
      clean(body.scopeType || 'vm', 'scopeType', 60), clean(body.scopeKey || '*', 'scopeKey', 300), startsAt, endsAt,
      owner, clean(body.reason, 'reason', 1000), actor.id);
    return this._db().prepare('SELECT * FROM vm_observability_maintenance_windows WHERE id=?').get(result.lastInsertRowid);
  }

  reconcileSuppressions(actor) {
    this._admin(actor); const db = this._db(); const now = new Date().toISOString(); let created = 0; let cleared = 0;
    db.transaction(() => {
      const desired = new Map();
      const alerts = db.prepare("SELECT * FROM vm_observability_signal_alerts WHERE state='active'").all();
      const alertByResource = new Map(alerts.map(item => [`${item.provider_host_id}|${item.resource_type}|${item.resource_key}`, item]));
      const edges = db.prepare('SELECT * FROM vm_observability_topology_edges WHERE active=1').all();
      const windows = db.prepare('SELECT * FROM vm_observability_maintenance_windows WHERE enabled=1 AND starts_at<=? AND ends_at>?').all(now, now);
      for (const alert of alerts) {
        const maintenance = windows.find(item => item.provider_host_id === alert.provider_host_id
          && (item.scope_type === '*' || item.scope_type === alert.resource_type)
          && (item.scope_key === '*' || item.scope_key === alert.resource_key));
        if (maintenance) desired.set(`${alert.id}|maintenance`, { alertId: alert.id, kind: 'maintenance', upstreamId: null,
          windowId: maintenance.id, reason: `Maintenance: ${maintenance.name}`, evidence: { ownerUserId: maintenance.owner_user_id,
            startsAt: maintenance.starts_at, endsAt: maintenance.ends_at } });
        const dependency = edges.find(edge => edge.provider_host_id === alert.provider_host_id && edge.to_type === alert.resource_type
          && edge.to_key === alert.resource_key && alertByResource.has(`${alert.provider_host_id}|${edge.from_type}|${edge.from_key}`));
        if (dependency) {
          const upstream = alertByResource.get(`${alert.provider_host_id}|${dependency.from_type}|${dependency.from_key}`);
          desired.set(`${alert.id}|dependency`, { alertId: alert.id, kind: 'dependency', upstreamId: upstream.id, windowId: null,
            reason: `Upstream ${dependency.from_type}:${dependency.from_key} alert is active`, evidence: { edgeId: dependency.id,
              relation: dependency.relation } });
        }
      }
      const active = db.prepare('SELECT * FROM vm_observability_alert_suppressions WHERE active=1').all();
      for (const row of active) if (!desired.has(`${row.alert_id}|${row.suppression_kind}`)) {
        db.prepare("UPDATE vm_observability_alert_suppressions SET active=0,cleared_at=datetime('now') WHERE id=?").run(row.id); cleared += 1;
      }
      for (const item of desired.values()) {
        const existing = active.find(row => row.alert_id === item.alertId && row.suppression_kind === item.kind);
        if (!existing) {
          db.prepare(`INSERT INTO vm_observability_alert_suppressions
            (alert_id,suppression_kind,upstream_alert_id,maintenance_window_id,reason,evidence_json)
            VALUES (?,?,?,?,?,?)`).run(item.alertId, item.kind, item.upstreamId, item.windowId, item.reason, JSON.stringify(item.evidence)); created += 1;
        }
      }
    })();
    const active = db.prepare('SELECT COUNT(*) count FROM vm_observability_alert_suppressions WHERE active=1').get().count;
    return { created, cleared, active };
  }

  capacityForecast(body = {}, actor) {
    this._admin(actor); const db = this._db(); const host = integer(body.providerHostId ?? 0, 'providerHostId');
    const resourceType = clean(body.resourceType, 'resourceType', 60); const resourceKey = clean(body.resourceKey, 'resourceKey', 300);
    const metricKey = clean(body.metricKey || 'disk.used_bytes', 'metricKey', 120); const windowDays = integer(body.windowDays ?? 30, 'windowDays', 2, 90);
    const rows = db.prepare(`SELECT day,sample_at,value FROM (
      SELECT substr(sample_at,1,10) day,sample_at,value,
        ROW_NUMBER() OVER (PARTITION BY substr(sample_at,1,10) ORDER BY sample_at DESC,id DESC) daily_rank
      FROM vm_metric_samples WHERE provider_host_id=? AND resource_type=? AND resource_key=? AND metric_key=? AND sample_at>=?
    ) WHERE daily_rank=1 ORDER BY sample_at`).all(host, resourceType, resourceKey, metricKey,
      new Date(Date.now() - windowDays * 86400000).toISOString());
    let capacity = body.capacityValue == null ? null : number(body.capacityValue, 'capacityValue', 0, Number.MAX_VALUE);
    if (capacity == null) {
      const capacityMetric = { 'disk.used_bytes': 'disk.provisioned_bytes', 'memory.used_bytes': 'memory.total_bytes' }[metricKey];
      if (capacityMetric) capacity = db.prepare(`SELECT value FROM vm_metric_samples WHERE provider_host_id=? AND resource_type=?
        AND resource_key=? AND metric_key=? ORDER BY sample_at DESC LIMIT 1`).get(host, resourceType, resourceKey, capacityMetric)?.value ?? null;
    }
    const origin = rows.length ? Date.parse(rows[0].sample_at) : Date.now();
    const points = rows.map(row => ({ x: (Date.parse(row.sample_at) - origin) / 86400000, y: row.value }));
    const model = regression(points); let projectedFullAt = null; let status = 'insufficient_evidence';
    if (points.length >= 4 && capacity != null && model.slope > 0 && points[points.length - 1].y < capacity) {
      const fullDay = (capacity - model.intercept) / model.slope;
      if (fullDay >= points[points.length - 1].x) { projectedFullAt = new Date(origin + fullDay * 86400000).toISOString(); status = 'forecast'; }
    } else if (points.length >= 4 && model.slope <= 0) status = 'stable_or_decreasing';
    const evidence = { windowDays, firstSampleAt: rows[0]?.sample_at || null, lastSampleAt: rows[rows.length - 1]?.sample_at || null,
      currentValue: points[points.length - 1]?.y ?? null, slopePerDay: model.slope, r2: model.r2,
      confidenceBand: model.r2 >= 0.8 ? 'high' : model.r2 >= 0.5 ? 'medium' : 'low', capacitySource: body.capacityValue == null ? 'canonical_metric' : 'operator' };
    const result = db.prepare(`INSERT INTO vm_observability_capacity_forecasts
      (provider_host_id,resource_type,resource_key,metric_key,capacity_value,slope_per_day,projected_full_at,confidence,sample_count,evidence_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(host, resourceType, resourceKey, metricKey, capacity, model.slope, projectedFullAt,
      model.r2, points.length, JSON.stringify(evidence));
    return { id: Number(result.lastInsertRowid), status, providerHostId: host, resourceType, resourceKey, metricKey,
      capacityValue: capacity, projectedFullAt, sampleCount: points.length, evidence };
  }

  createRunbook(body = {}, actor) {
    this._admin(actor); const severity = body.minimumSeverity || 'warning';
    if (!(severity in severityRank)) throw fail('minimumSeverity is invalid');
    const url = clean(body.url, 'url', 500); if (!url.startsWith('/') && !/^https:\/\//i.test(url)) throw fail('url must be an internal path or HTTPS URL');
    try { new RegExp(clean(body.eventPattern, 'eventPattern', 200), 'i'); } catch { throw fail('eventPattern must be a valid regular expression'); }
    const result = this._db().prepare(`INSERT INTO vm_observability_runbook_mappings
      (name,event_pattern,resource_type,minimum_severity,title,url,version,created_by) VALUES (?,?,?,?,?,?,?,?)`)
      .run(clean(body.name, 'name', 160), body.eventPattern, body.resourceType ? clean(body.resourceType, 'resourceType', 60) : null,
        severity, clean(body.title, 'title', 240), url, clean(body.version, 'version', 40), actor.id);
    return this._db().prepare('SELECT * FROM vm_observability_runbook_mappings WHERE id=?').get(result.lastInsertRowid);
  }

  _matchingRunbooks(text, resourceType, severity) {
    return this._db().prepare('SELECT * FROM vm_observability_runbook_mappings WHERE enabled=1 ORDER BY id').all().filter(item => {
      try { return (!item.resource_type || item.resource_type === resourceType) && severityRank[severity] >= severityRank[item.minimum_severity]
        && new RegExp(item.event_pattern, 'i').test(text); } catch { return false; }
    }).map(item => ({ id: item.id, title: item.title, url: item.url, version: item.version }));
  }

  triage(body = {}, actor) {
    this._admin(actor); const db = this._db(); let resourceType; let resourceKey; let anchor; let alertId = null; let eventId = null; let severity = 'warning'; let title;
    if (body.signalAlertId != null) {
      alertId = integer(body.signalAlertId, 'signalAlertId', 1);
      const alert = db.prepare(`SELECT a.*,r.name rule_name,r.severity FROM vm_observability_signal_alerts a
        JOIN vm_observability_signal_rules r ON r.id=a.rule_id WHERE a.id=?`).get(alertId);
      if (!alert) throw fail('Signal alert not found', 404);
      ({ resource_type: resourceType, resource_key: resourceKey, severity } = alert); anchor = alert.last_evaluated_at; title = alert.rule_name;
    } else {
      eventId = integer(body.eventId, 'eventId', 1); const event = db.prepare('SELECT * FROM vm_observability_events WHERE id=?').get(eventId);
      if (!event) throw fail('Event not found', 404);
      ({ resource_type: resourceType, resource_key: resourceKey, severity } = event); anchor = event.occurred_at; title = event.title;
    }
    const start = new Date(Date.parse(anchor) - 1800000).toISOString(); const end = new Date(Date.parse(anchor) + 300000).toISOString();
    const candidates = [{ kind: 'primary', resourceType, resourceKey, title, occurredAt: anchor, score: 0.55,
      reasons: ['same resource', 'selected incident evidence'] }];
    const localEvents = db.prepare(`SELECT * FROM vm_observability_events WHERE resource_type=? AND resource_key=?
      AND occurred_at BETWEEN ? AND ? ORDER BY occurred_at DESC LIMIT 30`).all(resourceType, resourceKey, start, end);
    for (const event of localEvents) {
      const temporal = Math.max(0, 1 - Math.abs(Date.parse(anchor) - Date.parse(event.occurred_at)) / 1800000);
      candidates.push({ kind: 'temporal_event', resourceType, resourceKey, title: event.title, eventId: event.id,
        occurredAt: event.occurred_at, score: Math.min(0.9, 0.3 + temporal * 0.25 + severityRank[event.severity] * 0.08),
        reasons: ['same resource', 'temporal proximity', `severity ${event.severity}`] });
    }
    const upstreamEdges = db.prepare(`SELECT * FROM vm_observability_topology_edges WHERE active=1 AND to_type=? AND to_key=?`).all(resourceType, resourceKey);
    for (const edge of upstreamEdges) {
      const event = db.prepare(`SELECT * FROM vm_observability_events WHERE provider_host_id=? AND resource_type=? AND resource_key=?
        AND occurred_at BETWEEN ? AND ? ORDER BY occurred_at DESC LIMIT 1`).get(edge.provider_host_id, edge.from_type, edge.from_key, start, end);
      if (event) candidates.push({ kind: 'upstream_dependency', resourceType: edge.from_type, resourceKey: edge.from_key,
        title: event.title, eventId: event.id, occurredAt: event.occurred_at, score: Math.min(0.95, 0.5 + severityRank[event.severity] * 0.1),
        reasons: [`upstream relation ${edge.relation}`, `severity ${event.severity}`, 'within incident window'] });
    }
    const ranked = candidates.sort((left, right) => right.score - left.score).slice(0, 10).map((item, index) => ({ ...item, rank: index + 1,
      score: Number(item.score.toFixed(3)) }));
    const runbooks = this._matchingRunbooks(ranked.map(item => item.title).join(' '), resourceType, severity);
    const summary = `${ranked.length} evidence-backed candidates ranked for ${resourceType}:${resourceKey}; top candidate is ${ranked[0].title}. This is advisory, not a root-cause claim.`;
    const evidence = { anchor, analysisWindow: { start, end }, localEventCount: localEvents.length,
      upstreamEdgesConsidered: upstreamEdges.length, algorithm: 'temporal-topology-severity-v1' };
    const result = db.prepare(`INSERT INTO vm_observability_triage_reports
      (signal_alert_id,event_id,resource_type,resource_key,summary,evidence_json,candidates_json,runbooks_json,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(alertId, eventId, resourceType, resourceKey, summary, JSON.stringify(evidence),
      JSON.stringify(ranked), JSON.stringify(runbooks), actor.id);
    return { id: Number(result.lastInsertRowid), resourceType, resourceKey, summary, evidence, candidates: ranked, runbooks };
  }

  privacyPolicy(hostId, body, actor) {
    this._admin(actor); const id = integer(hostId, 'providerHostId');
    if (body == null) {
      const row = this._db().prepare('SELECT * FROM vm_observability_privacy_policies WHERE provider_host_id=?').get(id)
        || this._db().prepare('SELECT * FROM vm_observability_privacy_policies WHERE provider_host_id=0').get();
      return { ...row, redactedLabelKeys: json(row.redacted_label_keys_json, []) };
    }
    const keys = Array.isArray(body.redactedLabelKeys) ? [...new Set(body.redactedLabelKeys.map(item => clean(item, 'redactedLabelKeys', 64)))] : [];
    if (keys.length > 32 || keys.some(key => !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(key))) throw fail('redactedLabelKeys is invalid');
    this._db().prepare(`INSERT INTO vm_observability_privacy_policies
      (provider_host_id,redacted_label_keys_json,redact_event_message,redact_raw_payload,sampling_ratio,metric_retention_days,event_retention_days,residency_region,updated_by)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(provider_host_id) DO UPDATE SET redacted_label_keys_json=excluded.redacted_label_keys_json,
      redact_event_message=excluded.redact_event_message,redact_raw_payload=excluded.redact_raw_payload,sampling_ratio=excluded.sampling_ratio,
      metric_retention_days=excluded.metric_retention_days,event_retention_days=excluded.event_retention_days,
      residency_region=excluded.residency_region,updated_by=excluded.updated_by,updated_at=datetime('now')`)
      .run(id, JSON.stringify(keys), body.redactEventMessage ? 1 : 0, body.redactRawPayload === false ? 0 : 1,
        number(body.samplingRatio ?? 1, 'samplingRatio', 0.01, 1), integer(body.metricRetentionDays ?? 30, 'metricRetentionDays', 1, 3650),
        integer(body.eventRetentionDays ?? 90, 'eventRetentionDays', 1, 3650), clean(body.residencyRegion || 'local', 'residencyRegion', 80), actor.id);
    return this.privacyPolicy(id, null, actor);
  }

  retentionPlan(hostId, actor) {
    this._admin(actor); const id = integer(hostId, 'providerHostId'); const db = this._db(); const policy = this.privacyPolicy(id, null, actor);
    const metricBefore = new Date(Date.now() - policy.metric_retention_days * 86400000).toISOString();
    const eventBefore = new Date(Date.now() - policy.event_retention_days * 86400000).toISOString();
    return { providerHostId: id, metricBefore, eventBefore,
      metricSamples: db.prepare('SELECT COUNT(*) count FROM vm_metric_samples WHERE provider_host_id=? AND sample_at<?').get(id, metricBefore).count,
      events: db.prepare('SELECT COUNT(*) count FROM vm_observability_events WHERE provider_host_id=? AND occurred_at<?').get(id, eventBefore).count,
      confirmation: 'PURGE TELEMETRY' };
  }

  applyRetention(hostId, body, actor) {
    this._admin(actor); if (body?.confirmation !== 'PURGE TELEMETRY') throw fail('Exact confirmation PURGE TELEMETRY is required', 409, 'RETENTION_CONFIRMATION_REQUIRED');
    const plan = this.retentionPlan(hostId, actor); const db = this._db(); let metrics; let events;
    db.transaction(() => {
      metrics = db.prepare('DELETE FROM vm_metric_samples WHERE provider_host_id=? AND sample_at<?').run(plan.providerHostId, plan.metricBefore).changes;
      events = db.prepare('DELETE FROM vm_observability_events WHERE provider_host_id=? AND occurred_at<?').run(plan.providerHostId, plan.eventBefore).changes;
    })();
    return { providerHostId: plan.providerHostId, deletedMetricSamples: metrics, deletedEvents: events };
  }

  createExportTarget(body = {}, actor) {
    this._admin(actor); const kind = body.exportKind || 'webhook';
    if (!['prometheus', 'otlp_http', 'webhook', 'syslog_udp'].includes(kind)) throw fail('exportKind is invalid');
    let endpoint = null;
    if (kind !== 'prometheus') {
      endpoint = clean(body.endpoint, 'endpoint', 1000); let url;
      try { url = new URL(endpoint); } catch { throw fail('endpoint must be a valid URL'); }
      const allowed = kind === 'syslog_udp' ? ['udp:'] : ['http:', 'https:'];
      if (!allowed.includes(url.protocol)) throw fail(`${kind} endpoint protocol is invalid`);
      endpoint = url.toString();
    }
    const filters = object(body.filters); for (const key of ['providerHostIds', 'categories', 'severities', 'resourceTypes', 'metricKeys']) {
      if (filters[key] != null && (!Array.isArray(filters[key]) || filters[key].length > 50)) throw fail(`filters.${key} is invalid`);
    }
    if (filters.providerHostIds?.some(id => !Number.isSafeInteger(Number(id)) || Number(id) < 0)) throw fail('filters.providerHostIds is invalid');
    const result = this._db().prepare(`INSERT INTO vm_observability_export_targets
      (name,export_kind,endpoint,region,filters_json,allow_private_network,enabled,created_by) VALUES (?,?,?,?,?,?,?,?)`)
      .run(clean(body.name, 'name', 160), kind, endpoint, clean(body.region || 'local', 'region', 80), JSON.stringify(filters),
        body.allowPrivateNetwork ? 1 : 0, body.enabled === false ? 0 : 1, actor.id);
    return this._db().prepare('SELECT * FROM vm_observability_export_targets WHERE id=?').get(result.lastInsertRowid);
  }

  _exportPayload(target, hours, _actor) {
    const db = this._db(); const filters = json(target.filters_json, {}); const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
    const policyRows = db.prepare('SELECT * FROM vm_observability_privacy_policies').all();
    const defaultPolicy = policyRows.find(item => item.provider_host_id === 0);
    const policyFor = hostId => policyRows.find(item => item.provider_host_id === hostId) || defaultPolicy;
    let events = db.prepare('SELECT * FROM vm_observability_events WHERE occurred_at>=? ORDER BY occurred_at DESC LIMIT 2000').all(cutoff);
    if (filters.providerHostIds?.length) events = events.filter(item => filters.providerHostIds.map(Number).includes(item.provider_host_id));
    if (filters.categories?.length) events = events.filter(item => filters.categories.includes(item.category));
    if (filters.severities?.length) events = events.filter(item => filters.severities.includes(item.severity));
    if (filters.resourceTypes?.length) events = events.filter(item => filters.resourceTypes.includes(item.resource_type));
    events = events.map(item => { const policy = policyFor(item.provider_host_id); return ({ id: item.id, providerHostId: item.provider_host_id, eventType: item.event_type,
      category: item.category, severity: item.severity, resourceType: item.resource_type, resourceKey: item.resource_key,
      title: item.title, message: policy.redact_event_message ? '[REDACTED]' : item.message, occurredAt: item.occurred_at,
      repeatCount: item.repeat_count }); });
    let samples = db.prepare(`SELECT provider_host_id,resource_type,resource_key,metric_key,value,unit,sample_at,labels_json
      FROM vm_metric_samples WHERE sample_at>=? ORDER BY sample_at DESC LIMIT 2000`).all(cutoff);
    if (filters.providerHostIds?.length) samples = samples.filter(item => filters.providerHostIds.map(Number).includes(item.provider_host_id));
    if (filters.resourceTypes?.length) samples = samples.filter(item => filters.resourceTypes.includes(item.resource_type));
    if (filters.metricKeys?.length) samples = samples.filter(item => filters.metricKeys.includes(item.metric_key));
    samples = samples.map(item => { const redact = new Set(json(policyFor(item.provider_host_id).redacted_label_keys_json, []));
      return { ...item, labels: Object.fromEntries(Object.entries(json(item.labels_json, {})).filter(([key]) => !redact.has(key))), labels_json: undefined }; });
    const residencyRegions = [...new Set([...events, ...samples].map(item => policyFor(item.providerHostId ?? item.provider_host_id).residency_region))];
    const envelope = { schema: 'docker-dash.observability/v1', generatedAt: new Date().toISOString(), hours, events, samples };
    if (target.export_kind === 'prometheus') {
      const escape = value => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
      const lines = [appMetrics.renderPrometheus().trimEnd(), '# HELP docker_dash_vm_observation Latest exported canonical VM observations',
        '# TYPE docker_dash_vm_observation gauge'];
      for (const item of samples) lines.push(`docker_dash_vm_observation{provider_host_id="${item.provider_host_id}",resource_type="${escape(item.resource_type)}",resource_key="${escape(item.resource_key)}",metric_key="${escape(item.metric_key)}",unit="${escape(item.unit)}"} ${item.value}`);
      return { body: lines.join('\n') + '\n', contentType: 'text/plain; version=0.0.4', eventCount: events.length, sampleCount: samples.length, residencyRegions };
    }
    if (target.export_kind === 'syslog_udp') {
      return { body: events.map(item => `<134>1 ${item.occurredAt} docker-dash - observability - ${JSON.stringify(item)}`).join('\n'),
        contentType: 'text/plain', eventCount: events.length, sampleCount: 0, residencyRegions };
    }
    if (target.export_kind === 'otlp_http') {
      const body = { resourceMetrics: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'docker-dash' } }] },
        scopeMetrics: [{ scope: { name: 'docker-dash.vm-observability' }, metrics: samples.map(item => ({ name: item.metric_key,
          unit: item.unit, gauge: { dataPoints: [{ asDouble: item.value, timeUnixNano: String(BigInt(Date.parse(item.sample_at)) * 1000000n),
            attributes: [{ key: 'resource.type', value: { stringValue: item.resource_type } },
              { key: 'resource.key', value: { stringValue: item.resource_key } }] }] } })) }] }] };
      return { body: JSON.stringify(body), contentType: 'application/json', eventCount: events.length, sampleCount: samples.length, residencyRegions };
    }
    return { body: JSON.stringify(envelope), contentType: 'application/json', eventCount: events.length, sampleCount: samples.length, residencyRegions };
  }

  exportPreview(targetId, query = {}, actor) {
    this._admin(actor); const id = integer(targetId, 'targetId', 1); const target = this._db().prepare('SELECT * FROM vm_observability_export_targets WHERE id=?').get(id);
    if (!target) throw fail('Export target not found', 404);
    const payload = this._exportPayload(target, integer(query.hours ?? 1, 'hours', 1, 168), actor);
    const bytes = Buffer.byteLength(payload.body); if (bytes > 1024 * 1024) throw fail('Export payload exceeds 1 MiB; narrow filters or range', 413, 'EXPORT_TOO_LARGE');
    return { target: { id: target.id, name: target.name, exportKind: target.export_kind, endpoint: target.endpoint, region: target.region },
      contentType: payload.contentType, byteSize: bytes, eventCount: payload.eventCount, sampleCount: payload.sampleCount,
      checksumSha256: crypto.createHash('sha256').update(payload.body).digest('hex'), preview: payload.body.slice(0, 10000), truncatedPreview: payload.body.length > 10000 };
  }

  async deliverExport(targetId, body = {}, actor) {
    this._admin(actor); const id = integer(targetId, 'targetId', 1); const db = this._db(); const target = db.prepare('SELECT * FROM vm_observability_export_targets WHERE id=? AND enabled=1').get(id);
    if (!target) throw fail('Enabled export target not found', 404);
    const payload = this._exportPayload(target, integer(body.hours ?? 1, 'hours', 1, 168), actor); const bytes = Buffer.byteLength(payload.body);
    const mismatchedRegions = payload.residencyRegions.filter(region => region !== target.region);
    if (mismatchedRegions.length) throw fail(`Export region ${target.region} violates telemetry residency ${mismatchedRegions.join(', ')}`, 409, 'TELEMETRY_RESIDENCY_MISMATCH');
    if (bytes > 1024 * 1024) throw fail('Export payload exceeds 1 MiB; narrow filters or range', 413, 'EXPORT_TOO_LARGE');
    const checksum = crypto.createHash('sha256').update(payload.body).digest('hex'); let status = 'delivered'; let responseCode = null; let error = null; let response = null;
    try {
      if (target.export_kind === 'prometheus') { status = 'pull_only'; response = { pullPath: '/metrics' }; }
      else if (target.export_kind === 'syslog_udp') response = await transport.udp(target.endpoint, payload.body, !!target.allow_private_network);
      else response = await transport.http(target.endpoint, payload.body, payload.contentType, !!target.allow_private_network);
      responseCode = response.responseCode ?? null;
    } catch (deliveryError) { status = 'failed'; responseCode = deliveryError.responseCode ?? null; error = String(deliveryError.message).slice(0, 1000); }
    const result = db.prepare(`INSERT INTO vm_observability_export_deliveries
      (target_id,status,event_count,byte_size,payload_sha256,response_code,error,evidence_json) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, status, payload.eventCount, bytes, checksum, responseCode, error, JSON.stringify({ sampleCount: payload.sampleCount,
        contentType: payload.contentType, response: response?.responseBody || response?.pullPath || null }));
    const delivery = { id: Number(result.lastInsertRowid), targetId: id, status, eventCount: payload.eventCount,
      sampleCount: payload.sampleCount, byteSize: bytes, checksumSha256: checksum, responseCode, error };
    if (status === 'failed') throw fail('Export delivery failed', 502, 'EXPORT_DELIVERY_FAILED', delivery);
    return delivery;
  }

  saveSlo(body = {}, actor) {
    this._admin(actor); const db = this._db(); const host = integer(body.providerHostId ?? 0, 'providerHostId');
    const resourceType = clean(body.resourceType, 'resourceType', 60); const resourceKey = clean(body.resourceKey, 'resourceKey', 300);
    db.prepare(`INSERT INTO vm_observability_slo_policies
      (name,provider_host_id,resource_type,resource_key,target_ratio,window_days,exclude_maintenance,created_by)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(provider_host_id,resource_type,resource_key) DO UPDATE SET name=excluded.name,
      target_ratio=excluded.target_ratio,window_days=excluded.window_days,exclude_maintenance=excluded.exclude_maintenance,
      updated_at=datetime('now')`).run(clean(body.name, 'name', 160), host, resourceType, resourceKey,
      number(body.targetRatio ?? 0.999, 'targetRatio', 0.5, 0.99999), integer(body.windowDays ?? 30, 'windowDays', 1, 365),
      body.excludeMaintenance === false ? 0 : 1, actor.id);
    return db.prepare('SELECT * FROM vm_observability_slo_policies WHERE provider_host_id=? AND resource_type=? AND resource_key=?')
      .get(host, resourceType, resourceKey);
  }

  sloReports(actor) {
    this._admin(actor); const db = this._db(); const reports = [];
    for (const policy of db.prepare('SELECT * FROM vm_observability_slo_policies WHERE enabled=1 ORDER BY id').all()) {
      const windowStart = new Date(Date.now() - policy.window_days * 86400000).toISOString();
      const events = db.prepare(`SELECT * FROM vm_observability_events WHERE provider_host_id=? AND resource_type=? AND resource_key=?
        AND occurred_at>=? AND (event_type LIKE '%Power%' OR event_type LIKE '%Up%' OR event_type LIKE '%Down%'
        OR event_type LIKE '%Restart%') ORDER BY occurred_at`).all(policy.provider_host_id, policy.resource_type, policy.resource_key, windowStart);
      if (!events.length) { reports.push({ policyId: policy.id, name: policy.name, resourceKey: policy.resource_key,
        status: 'insufficient_evidence', reason: 'No normalized availability state event in the SLO window' }); continue; }
      // The SLO window, rather than the first observation, is the denominator.
      // The earliest normalized state is carried back to the window boundary;
      // otherwise a recent first event would artificially inflate downtime.
      const coverageStart = Date.parse(windowStart); const now = Date.now(); let state = /down|off|stop|fail/i.test(events[0].event_type) ? 'down' : 'up';
      let cursor = coverageStart; const intervals = [];
      for (const event of events) { const at = Date.parse(event.occurred_at); intervals.push({ start: cursor, end: at, state });
        state = /down|off|stop|fail/i.test(event.event_type) ? 'down' : 'up'; cursor = at; }
      intervals.push({ start: cursor, end: now, state });
      const maintenance = policy.exclude_maintenance ? db.prepare(`SELECT * FROM vm_observability_maintenance_windows
        WHERE enabled=1 AND provider_host_id=? AND (scope_type='*' OR scope_type=?) AND (scope_key='*' OR scope_key=?)
        AND ends_at>? AND starts_at<?`).all(policy.provider_host_id, policy.resource_type, policy.resource_key,
        new Date(coverageStart).toISOString(), new Date(now).toISOString()) : [];
      const mergedMaintenance = maintenance.map(item => ({ start: Math.max(coverageStart, Date.parse(item.starts_at)),
        end: Math.min(now, Date.parse(item.ends_at)) })).filter(item => item.end > item.start).sort((left, right) => left.start - right.start)
        .reduce((merged, item) => { const previous = merged[merged.length - 1];
          if (previous && item.start <= previous.end) previous.end = Math.max(previous.end, item.end); else merged.push(item); return merged; }, []);
      const overlap = (start, end) => mergedMaintenance.reduce((sum, item) => sum + Math.max(0,
        Math.min(end, item.end) - Math.max(start, item.start)), 0);
      const coveredMs = intervals.reduce((sum, item) => sum + (item.end - item.start) - overlap(item.start, item.end), 0);
      const downMs = intervals.filter(item => item.state === 'down').reduce((sum, item) => sum + (item.end - item.start) - overlap(item.start, item.end), 0);
      const availability = coveredMs > 0 ? Math.max(0, 1 - downMs / coveredMs) : null;
      const budgetMs = coveredMs * (1 - policy.target_ratio); const remainingMs = budgetMs - downMs;
      reports.push({ policyId: policy.id, name: policy.name, resourceType: policy.resource_type, resourceKey: policy.resource_key,
        status: availability == null ? 'insufficient_evidence' : availability >= policy.target_ratio ? 'met' : 'breached',
        targetRatio: policy.target_ratio, availabilityRatio: availability, coveredSeconds: Math.floor(coveredMs / 1000),
        downtimeSeconds: Math.floor(downMs / 1000), errorBudgetSeconds: Math.floor(budgetMs / 1000),
        remainingErrorBudgetSeconds: Math.floor(remainingMs / 1000), maintenanceExcludedSeconds: Math.floor(overlap(coverageStart, now) / 1000),
        coverageStartsAt: new Date(coverageStart).toISOString(), evidenceEvents: events.length });
    }
    return { generatedAt: new Date().toISOString(), reports };
  }
}

const service = new VmObservabilityAdvancedService();
module.exports = service;
module.exports.VmObservabilityAdvancedService = VmObservabilityAdvancedService;
module.exports.VmObservabilityAdvancedError = VmObservabilityAdvancedError;
module.exports._transport = transport;
module.exports._internals = { percentile, regression, privateAddress };
