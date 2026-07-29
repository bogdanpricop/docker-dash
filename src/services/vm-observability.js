'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');

class VmObservabilityError extends Error {
  constructor(message, status = 400, code, details) {
    super(message); this.name = 'VmObservabilityError'; this.status = status; this.code = code; this.details = details;
  }
}

const fail = (message, status, code, details) => new VmObservabilityError(message, status, code, details);
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
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const json = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const asDate = (value, key) => {
  const result = new Date(value ?? Date.now());
  if (Number.isNaN(result.valueOf())) throw fail(`${key} must be a valid timestamp`);
  return result;
};
const safeList = (value, key, max, itemMax = 180) => {
  const list = Array.isArray(value) ? value : String(value || '').split(',').filter(Boolean);
  if (!list.length || list.length > max) throw fail(`${key} must contain between 1 and ${max} values`);
  return [...new Set(list.map(item => clean(item, key, itemMax)))];
};

const EVENT_ADAPTERS = Object.freeze([
  { key: 'vsphere-watch', provider: 'vsphere', transport: 'PropertyCollector/EventManager watch', cursorKind: 'sequence' },
  { key: 'xapi-events', provider: 'xen', transport: 'XAPI event.from cursor', cursorKind: 'opaque' },
  { key: 'pve-cluster-log', provider: 'proxmox', transport: 'PVE cluster log/task poll', cursorKind: 'timestamp' },
  { key: 'azure-event-grid', provider: 'azure', transport: 'Azure Event Grid webhook', cursorKind: 'opaque' },
  { key: 'webhook', provider: 'generic', transport: 'Authenticated normalized webhook', cursorKind: 'opaque' },
  { key: 'poll', provider: 'generic', transport: 'Bounded normalized polling batch', cursorKind: 'opaque' },
]);

const SEVERITIES = new Set(['info', 'warning', 'high', 'critical']);
const CATEGORIES = new Set(['state', 'task', 'config', 'alert', 'metric', 'lifecycle', 'security', 'fabric']);
const OPERATORS = Object.freeze({
  '>': (left, right) => left > right, '>=': (left, right) => left >= right,
  '<': (left, right) => left < right, '<=': (left, right) => left <= right,
  '=': (left, right) => left === right, '!=': (left, right) => left !== right,
});

function inferCategory(type) {
  const value = String(type || '').toLowerCase();
  if (/alarm|alert|warning|fault/.test(value)) return 'alert';
  if (/task|job|progress/.test(value)) return 'task';
  if (/config|reconfig|edit|change/.test(value)) return 'config';
  if (/security|auth|permission/.test(value)) return 'security';
  if (/network|storage|host|fabric/.test(value)) return 'fabric';
  if (/create|delete|remove|snapshot|backup|migrat|restart|power/.test(value)) return 'lifecycle';
  return 'state';
}

function normalizeEvent(adapter, raw) {
  const source = object(raw);
  let nativeEventId = source.nativeEventId ?? source.native_event_id ?? source.eventId ?? source.id;
  let eventType = source.eventType ?? source.event_type ?? source.type ?? source.kind ?? source.operation;
  let resourceType = source.resourceType ?? source.resource_type ?? 'vm';
  let resourceKey = source.resourceKey ?? source.resource_key ?? source.resourceId ?? source.subject;
  let title = source.title ?? source.summary ?? source.message ?? eventType;
  let message = source.message ?? source.description ?? null;
  let occurredAt = source.occurredAt ?? source.occurred_at ?? source.time ?? source.timestamp ?? source.eventTime;

  if (adapter === 'vsphere-watch') {
    nativeEventId = source.key ?? source.chainId ?? nativeEventId;
    eventType = source.eventTypeId ?? source._type ?? eventType;
    resourceKey = source.vm?.value ?? source.managedEntity?.value ?? source.object?.value ?? resourceKey;
    resourceType = source.vm ? 'vm' : source.host ? 'host' : resourceType;
    title = source.fullFormattedMessage ?? title;
    occurredAt = source.createdTime ?? occurredAt;
  } else if (adapter === 'xapi-events') {
    nativeEventId = source.id ?? source.token ?? nativeEventId;
    eventType = `${source.class || resourceType}.${source.operation || eventType || 'update'}`;
    resourceType = source.class || resourceType;
    resourceKey = source.ref ?? source.snapshot?.uuid ?? source.snapshot?.name_label ?? resourceKey;
    occurredAt = source.timestamp ?? source.snapshot?.timestamp ?? occurredAt;
  } else if (adapter === 'pve-cluster-log') {
    nativeEventId = source.upid ?? source.id ?? nativeEventId;
    eventType = source.eventType ?? source.type ?? source.action ?? 'task';
    resourceKey = source.vmid ?? source.resource ?? source.node ?? resourceKey;
    resourceType = source.vmid != null ? 'vm' : source.node ? 'host' : resourceType;
    title = source.msg ?? source.status ?? title;
    occurredAt = source.time ?? source.starttime ?? occurredAt;
  } else if (adapter === 'azure-event-grid') {
    nativeEventId = source.id ?? nativeEventId;
    eventType = source.eventType ?? source.data?.operationName ?? eventType;
    resourceKey = source.subject ?? source.data?.resourceUri ?? resourceKey;
    title = source.data?.status ?? source.data?.operationName ?? title;
    message = source.data?.description ?? message;
    occurredAt = source.eventTime ?? occurredAt;
  }

  const at = asDate(typeof occurredAt === 'number' && occurredAt < 1e12 ? occurredAt * 1000 : occurredAt, 'occurredAt');
  if (at.valueOf() > Date.now() + 300000) throw fail('occurredAt cannot be more than five minutes in the future');
  const type = clean(eventType, 'eventType', 120);
  const normalizedTitle = clean(title, 'title', 300);
  const category = source.category ? clean(source.category, 'category', 30).toLowerCase() : inferCategory(type);
  const severity = String(source.severity || 'info').toLowerCase();
  if (!CATEGORIES.has(category)) throw fail('category is invalid');
  if (!SEVERITIES.has(severity)) throw fail('severity is invalid');
  const related = Array.isArray(source.relatedResources) ? source.relatedResources.slice(0, 50).map(item => ({
    type: clean(item.type, 'relatedResources.type', 60), key: clean(item.key, 'relatedResources.key', 180),
  })) : [];
  return {
    nativeEventId: nativeEventId == null ? null : clean(nativeEventId, 'nativeEventId', 300),
    eventType: type, category, severity,
    resourceType: clean(resourceType, 'resourceType', 60), resourceKey: clean(resourceKey, 'resourceKey', 300),
    title: normalizedTitle, message: message == null ? null : String(message).slice(0, 2000),
    related, occurredAt: at.toISOString(), raw: source,
  };
}

function rowEvent(row) {
  return { ...row, relatedResources: json(row.related_resources_json, []), payload: json(row.payload_json, {}),
    provenance: json(row.provenance_json, {}) };
}

class VmObservabilityService {
  constructor(dbProvider = getDb) { this._dbProvider = dbProvider; }
  _db() { return this._dbProvider(); }
  _admin(actor) {
    if (!actor?.id) throw fail('Authenticated user is required', 401);
    if (actor.role !== 'admin') throw fail('Administrator permission is required', 403, 'GOVERNANCE_FORBIDDEN');
  }

  catalog(actor) {
    this._admin(actor);
    return { eventAdapters: EVENT_ADAPTERS, dashboardKinds: ['contention', 'storage', 'network'],
      signalTypes: ['metric', 'event', 'state'], operators: Object.keys(OPERATORS) };
  }

  performance(query = {}, actor) {
    this._admin(actor);
    const db = this._db();
    const resourceKeys = safeList(query.resourceKeys || query.resourceKey, 'resourceKeys', 10, 300);
    const metricKeys = safeList(query.metricKeys || query.metricKey, 'metricKeys', 12, 120);
    const from = asDate(query.from || Date.now() - 86400000, 'from');
    const to = asDate(query.to || Date.now(), 'to');
    if (to <= from || to - from > 31 * 86400000) throw fail('Performance range must be positive and at most 31 days');
    const host = query.providerHostId == null ? null : integer(query.providerHostId, 'providerHostId');
    const where = [`sample_at BETWEEN ? AND ?`, `resource_key IN (${resourceKeys.map(() => '?').join(',')})`,
      `metric_key IN (${metricKeys.map(() => '?').join(',')})`];
    const args = [from.toISOString(), to.toISOString(), ...resourceKeys, ...metricKeys];
    if (host != null) { where.push('provider_host_id=?'); args.push(host); }
    const rows = db.prepare(`SELECT provider_host_id,resource_type,resource_key,metric_key,value,unit,sample_at,labels_json
      FROM vm_metric_samples WHERE ${where.join(' AND ')} ORDER BY sample_at LIMIT 20001`).all(...args);
    if (rows.length > 20000) throw fail('Performance query exceeded 20,000 points; reduce range or resources', 413, 'VM_CHART_QUERY_TOO_LARGE');
    const groups = new Map();
    for (const row of rows) {
      const key = `${row.provider_host_id}|${row.resource_type}|${row.resource_key}|${row.metric_key}`;
      if (!groups.has(key)) groups.set(key, { providerHostId: row.provider_host_id, resourceType: row.resource_type,
        resourceKey: row.resource_key, metricKey: row.metric_key, unit: row.unit, points: [] });
      groups.get(key).points.push({ at: row.sample_at, value: row.value, labels: json(row.labels_json, {}) });
    }
    for (const series of groups.values()) {
      if (series.points.length > 500) {
        const step = series.points.length / 500;
        series.points = Array.from({ length: 500 }, (_, index) => series.points[Math.floor(index * step)]);
      }
    }
    const eventArgs = [from.toISOString(), to.toISOString(), ...resourceKeys];
    const eventWhere = [`occurred_at BETWEEN ? AND ?`, `resource_key IN (${resourceKeys.map(() => '?').join(',')})`];
    if (host != null) { eventWhere.push('provider_host_id=?'); eventArgs.push(host); }
    const annotations = db.prepare(`SELECT id,event_type,category,severity,resource_type,resource_key,title,occurred_at,repeat_count
      FROM vm_observability_events WHERE ${eventWhere.join(' AND ')} ORDER BY occurred_at LIMIT 500`).all(...eventArgs);
    return { from: from.toISOString(), to: to.toISOString(), resources: resourceKeys, metrics: metricKeys,
      series: [...groups.values()], annotations, truncated: false };
  }

  _window(query, metricKeys) {
    const hours = integer(query.hours ?? 24, 'hours', 1, 744);
    const host = query.providerHostId == null ? null : integer(query.providerHostId, 'providerHostId');
    const where = [`sample_at>=?`, `metric_key IN (${metricKeys.map(() => '?').join(',')})`];
    const args = [new Date(Date.now() - hours * 3600000).toISOString(), ...metricKeys];
    if (host != null) { where.push('provider_host_id=?'); args.push(host); }
    const rows = this._db().prepare(`SELECT provider_host_id,resource_type,resource_key,metric_key,value,unit,sample_at,labels_json
      FROM vm_metric_samples WHERE ${where.join(' AND ')} ORDER BY resource_key,metric_key,sample_at LIMIT 50000`).all(...args);
    const resources = new Map();
    for (const row of rows) {
      const id = `${row.provider_host_id}|${row.resource_type}|${row.resource_key}`;
      if (!resources.has(id)) resources.set(id, { providerHostId: row.provider_host_id, resourceType: row.resource_type,
        resourceKey: row.resource_key, labels: json(row.labels_json, {}), metrics: {} });
      const item = resources.get(id);
      if (!item.metrics[row.metric_key]) item.metrics[row.metric_key] = [];
      item.metrics[row.metric_key].push({ value: row.value, at: row.sample_at });
    }
    return { hours, resources: [...resources.values()] };
  }

  _latest(item, key) { const values = item.metrics[key] || []; return values.length ? values[values.length - 1].value : null; }
  _rate(item, key) {
    const values = item.metrics[key] || [];
    if (values.length < 2) return null;
    const seconds = (Date.parse(values[values.length - 1].at) - Date.parse(values[0].at)) / 1000;
    return seconds > 0 ? Math.max(0, (values[values.length - 1].value - values[0].value) / seconds) : null;
  }

  dashboard(kind, query = {}, actor) {
    this._admin(actor);
    if (!['contention', 'storage', 'network'].includes(kind)) throw fail('dashboard kind is invalid');
    const keys = kind === 'contention'
      ? ['cpu.utilization_ratio', 'cpu.ready_ratio', 'cpu.steal_ratio', 'memory.balloon_bytes', 'memory.swap_bytes']
      : kind === 'storage'
        ? ['disk.read_bytes_total', 'disk.write_bytes_total', 'disk.read_operations_total', 'disk.write_operations_total',
          'disk.read_latency_seconds', 'disk.write_latency_seconds', 'disk.queue_depth', 'storage.resync_ratio']
        : ['network.receive_bytes_total', 'network.transmit_bytes_total', 'network.receive_errors_total',
          'network.transmit_errors_total', 'network.receive_drops_total', 'network.transmit_drops_total',
          'network.active_flows', 'network.mtu_incidents_total'];
    const window = this._window(query, keys);
    const rows = window.resources.map(item => {
      if (kind === 'contention') {
        const ready = this._latest(item, 'cpu.ready_ratio'); const steal = this._latest(item, 'cpu.steal_ratio');
        const balloon = this._latest(item, 'memory.balloon_bytes'); const swap = this._latest(item, 'memory.swap_bytes');
        const signals = [ready >= 0.05 && 'cpu-ready', steal >= 0.05 && 'cpu-steal', balloon > 0 && 'balloon', swap > 0 && 'swap'].filter(Boolean);
        return { ...item, cpuUtilizationRatio: this._latest(item, 'cpu.utilization_ratio'), cpuReadyRatio: ready,
          cpuStealRatio: steal, balloonBytes: balloon, swapBytes: swap, signals, status: signals.length ? 'contended' : 'normal' };
      }
      if (kind === 'storage') {
        const readLatency = this._latest(item, 'disk.read_latency_seconds'); const writeLatency = this._latest(item, 'disk.write_latency_seconds');
        const queueDepth = this._latest(item, 'disk.queue_depth'); const resync = this._latest(item, 'storage.resync_ratio');
        const signals = [readLatency >= 0.02 && 'read-latency', writeLatency >= 0.02 && 'write-latency', queueDepth >= 8 && 'queue',
          resync > 0 && resync < 1 && 'resync'].filter(Boolean);
        return { ...item, readBytesPerSecond: this._rate(item, 'disk.read_bytes_total'), writeBytesPerSecond: this._rate(item, 'disk.write_bytes_total'),
          readIops: this._rate(item, 'disk.read_operations_total'), writeIops: this._rate(item, 'disk.write_operations_total'),
          readLatencySeconds: readLatency, writeLatencySeconds: writeLatency, queueDepth, resyncRatio: resync,
          signals, status: signals.length ? 'degraded' : 'normal' };
      }
      const receiveDrops = this._rate(item, 'network.receive_drops_total'); const transmitDrops = this._rate(item, 'network.transmit_drops_total');
      const receiveErrors = this._rate(item, 'network.receive_errors_total'); const transmitErrors = this._rate(item, 'network.transmit_errors_total');
      const mtu = this._rate(item, 'network.mtu_incidents_total');
      const signals = [(receiveDrops > 0 || transmitDrops > 0) && 'drops', (receiveErrors > 0 || transmitErrors > 0) && 'errors', mtu > 0 && 'mtu'].filter(Boolean);
      return { ...item, receiveBytesPerSecond: this._rate(item, 'network.receive_bytes_total'),
        transmitBytesPerSecond: this._rate(item, 'network.transmit_bytes_total'), receiveDropsPerSecond: receiveDrops,
        transmitDropsPerSecond: transmitDrops, receiveErrorsPerSecond: receiveErrors, transmitErrorsPerSecond: transmitErrors,
        activeFlows: this._latest(item, 'network.active_flows'), mtuIncidentsPerSecond: mtu,
        signals, status: signals.length ? 'degraded' : 'normal' };
    });
    if (kind === 'contention') {
      const groups = new Map();
      for (const row of rows) {
        const host = row.labels.host || row.labels.node || row.labels.cluster;
        if (!host) continue;
        if (!groups.has(host)) groups.set(host, []);
        groups.get(host).push(row);
      }
      for (const peers of groups.values()) for (const row of peers) {
        const noisy = peers.filter(peer => peer.resourceKey !== row.resourceKey && peer.cpuUtilizationRatio >= 0.8)
          .sort((left, right) => right.cpuUtilizationRatio - left.cpuUtilizationRatio)[0];
        row.noisyNeighbor = noisy ? { resourceKey: noisy.resourceKey, cpuUtilizationRatio: noisy.cpuUtilizationRatio } : null;
        if (noisy && row.status === 'contended') row.signals.push('noisy-neighbor');
      }
    }
    return { kind, hours: window.hours, generatedAt: new Date().toISOString(), rows,
      summary: { total: rows.length, degraded: rows.filter(row => row.status !== 'normal').length } };
  }

  ingestEvents(body = {}, actor) {
    this._admin(actor);
    const db = this._db();
    const catalog = EVENT_ADAPTERS.find(item => item.key === body.adapter);
    if (!catalog) throw fail('event adapter is unsupported');
    const events = Array.isArray(body.events) ? body.events : [];
    if (!events.length || events.length > 5000) throw fail('events must contain between 1 and 5000 observations');
    const host = integer(body.providerHostId ?? 0, 'providerHostId');
    const provider = clean(body.provider || catalog.provider, 'provider', 60).toLowerCase();
    const source = clean(body.source || catalog.transport, 'source', 160);
    const dedupeWindow = integer(body.dedupeWindowSeconds ?? 300, 'dedupeWindowSeconds', 1, 86400);
    const insert = db.prepare(`INSERT INTO vm_observability_events
      (provider_host_id,provider,adapter,source,native_event_id,fingerprint,event_type,category,severity,resource_type,
       resource_key,title,message,related_resources_json,payload_json,provenance_json,occurred_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const byNative = db.prepare(`SELECT * FROM vm_observability_events
      WHERE provider_host_id=? AND adapter=? AND native_event_id=?`);
    const byFingerprint = db.prepare(`SELECT * FROM vm_observability_events
      WHERE provider_host_id=? AND fingerprint=? AND occurred_at>=? ORDER BY occurred_at DESC LIMIT 1`);
    const repeat = db.prepare(`UPDATE vm_observability_events SET repeat_count=repeat_count+1,last_seen_at=datetime('now'),
      payload_json=?,provenance_json=? WHERE id=?`);
    let inserted = 0; let duplicates = 0;
    const rows = [];
    db.transaction(() => {
      for (const raw of events) {
        const event = normalizeEvent(catalog.key, raw);
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify([host, event.resourceType, event.resourceKey,
          event.eventType, event.title.toLowerCase(), String(event.message || '').toLowerCase()])).digest('hex');
        const cutoff = new Date(Date.parse(event.occurredAt) - dedupeWindow * 1000).toISOString();
        const existing = event.nativeEventId ? byNative.get(host, catalog.key, event.nativeEventId)
          : byFingerprint.get(host, fingerprint, cutoff);
        const provenance = { transport: catalog.transport, cursorKind: catalog.cursorKind };
        if (existing) {
          repeat.run(JSON.stringify(event.raw), JSON.stringify(provenance), existing.id);
          rows.push(rowEvent(db.prepare('SELECT * FROM vm_observability_events WHERE id=?').get(existing.id)));
          duplicates += 1;
        } else {
          const id = Number(insert.run(host, provider, catalog.key, source, event.nativeEventId, fingerprint, event.eventType,
            event.category, event.severity, event.resourceType, event.resourceKey, event.title, event.message,
            JSON.stringify(event.related), JSON.stringify(event.raw), JSON.stringify(provenance), event.occurredAt).lastInsertRowid);
          rows.push(rowEvent(db.prepare('SELECT * FROM vm_observability_events WHERE id=?').get(id)));
          inserted += 1;
        }
      }
      if (body.cursor != null) {
        const cursor = typeof body.cursor === 'object' ? body.cursor : { value: body.cursor };
        const value = clean(cursor.value, 'cursor.value', 1000);
        const kind = cursor.kind || catalog.cursorKind;
        if (!['opaque', 'sequence', 'timestamp', 'resource_version'].includes(kind)) throw fail('cursor.kind is invalid');
        db.prepare(`INSERT INTO vm_observability_event_cursors (provider_host_id,adapter,cursor_value,cursor_kind)
          VALUES (?,?,?,?) ON CONFLICT(provider_host_id,adapter) DO UPDATE SET cursor_value=excluded.cursor_value,
          cursor_kind=excluded.cursor_kind,updated_at=datetime('now')`).run(host, catalog.key, value, kind);
      }
    })();
    return { providerHostId: host, adapter: catalog.key, accepted: events.length, inserted, duplicates, events: rows };
  }

  events(query = {}, actor) {
    this._admin(actor);
    const where = []; const args = [];
    if (query.providerHostId != null) { where.push('provider_host_id=?'); args.push(integer(query.providerHostId, 'providerHostId')); }
    if (query.resourceKey) { where.push('resource_key=?'); args.push(clean(query.resourceKey, 'resourceKey', 300)); }
    if (query.category) { where.push('category=?'); args.push(clean(query.category, 'category', 30)); }
    if (query.severity) { where.push('severity=?'); args.push(clean(query.severity, 'severity', 30)); }
    const hours = integer(query.hours ?? 24, 'hours', 1, 24 * 90);
    where.push('occurred_at>=?'); args.push(new Date(Date.now() - hours * 3600000).toISOString());
    const limit = integer(query.limit ?? 500, 'limit', 1, 5000);
    return this._db().prepare(`SELECT * FROM vm_observability_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY occurred_at DESC LIMIT ?`).all(...args, limit).map(rowEvent);
  }

  timeline(query = {}, actor) {
    this._admin(actor);
    const db = this._db(); const hours = integer(query.hours ?? 24, 'hours', 1, 24 * 31);
    const resourceKey = query.resourceKey ? clean(query.resourceKey, 'resourceKey', 300) : null;
    const from = new Date(Date.now() - hours * 3600000).toISOString(); const items = [];
    for (const event of this.events({ ...query, hours, limit: 1000 }, actor)) items.push({ kind: 'event', time: event.occurred_at,
      resourceType: event.resource_type, resourceKey: event.resource_key, category: event.category, severity: event.severity,
      title: event.title, repeatCount: event.repeat_count, evidenceId: `event:${event.id}` });
    try {
      const where = ['created_at>=?']; const args = [from];
      if (resourceKey) { where.push('target_id=?'); args.push(resourceKey); }
      for (const row of db.prepare(`SELECT id,action,target_type,target_id,username,created_at FROM audit_log
        WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 500`).all(...args)) items.push({ kind: 'config', time: row.created_at,
        resourceType: row.target_type, resourceKey: row.target_id, category: 'config', severity: 'info', title: row.action,
        actor: row.username, evidenceId: `audit:${row.id}` });
    } catch { /* optional legacy table */ }
    try {
      const where = ['triggered_at>=?']; const args = [from];
      if (resourceKey) { where.push('container_name=?'); args.push(resourceKey); }
      for (const row of db.prepare(`SELECT id,rule_name,container_name,severity,message,triggered_at,resolved_at FROM alert_events
        WHERE ${where.join(' AND ')} ORDER BY triggered_at DESC LIMIT 500`).all(...args)) items.push({ kind: 'alert', time: row.triggered_at,
        resourceType: 'workload', resourceKey: row.container_name, category: 'alert', severity: row.severity,
        title: row.rule_name, message: row.message, resolvedAt: row.resolved_at, evidenceId: `alert:${row.id}` });
    } catch { /* optional legacy table */ }
    const metricWhere = ['sample_at>=?']; const metricArgs = [from];
    if (resourceKey) { metricWhere.push('resource_key=?'); metricArgs.push(resourceKey); }
    for (const row of db.prepare(`SELECT id,resource_type,resource_key,metric_key,value,unit,sample_at FROM vm_metric_samples
      WHERE ${metricWhere.join(' AND ')} ORDER BY sample_at DESC LIMIT 500`).all(...metricArgs)) items.push({ kind: 'metric', time: row.sample_at,
      resourceType: row.resource_type, resourceKey: row.resource_key, category: 'metric', severity: 'info',
      title: row.metric_key, value: row.value, unit: row.unit, evidenceId: `metric:${row.id}` });
    items.sort((left, right) => String(right.time).localeCompare(String(left.time)));
    return { hours, resourceKey, items: items.slice(0, 1500), truncated: items.length > 1500 };
  }

  incidentTimeline(resourceKey, query, actor) {
    const timeline = this.timeline({ ...query, resourceKey }, actor);
    const incidentTypes = /restart|migrat|snapshot|backup|guest|alarm|alert|fault|power/i;
    const items = timeline.items.filter(item => item.kind !== 'event' || incidentTypes.test(item.title) || item.severity !== 'info');
    return { ...timeline, items, summary: { total: items.length,
      alerts: items.filter(item => item.category === 'alert').length,
      lifecycle: items.filter(item => item.category === 'lifecycle').length,
      metrics: items.filter(item => item.kind === 'metric').length } };
  }

  saveTopologyEdge(body = {}, actor) {
    this._admin(actor);
    const db = this._db(); const host = integer(body.providerHostId ?? 0, 'providerHostId');
    const values = [host, clean(body.fromType, 'fromType', 60), clean(body.fromKey, 'fromKey', 300),
      clean(body.toType, 'toType', 60), clean(body.toKey, 'toKey', 300), clean(body.relation, 'relation', 100),
      JSON.stringify(object(body.evidence)), body.active === false ? 0 : 1, actor.id];
    db.prepare(`INSERT INTO vm_observability_topology_edges
      (provider_host_id,from_type,from_key,to_type,to_key,relation,evidence_json,active,updated_by) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(provider_host_id,from_type,from_key,to_type,to_key,relation) DO UPDATE SET evidence_json=excluded.evidence_json,
      active=excluded.active,updated_by=excluded.updated_by,updated_at=datetime('now')`).run(...values);
    return this.topology({ providerHostId: host }, actor).edges.find(edge => edge.from_type === values[1]
      && edge.from_key === values[2] && edge.to_type === values[3] && edge.to_key === values[4] && edge.relation === values[5]);
  }

  topology(query = {}, actor) {
    this._admin(actor);
    const where = ['active=1']; const args = [];
    if (query.providerHostId != null) { where.push('provider_host_id=?'); args.push(integer(query.providerHostId, 'providerHostId')); }
    const edges = this._db().prepare(`SELECT * FROM vm_observability_topology_edges WHERE ${where.join(' AND ')}
      ORDER BY provider_host_id,from_type,from_key,to_type,to_key LIMIT 5000`).all(...args).map(row => ({ ...row, evidence: json(row.evidence_json, {}) }));
    const nodeMap = new Map();
    for (const edge of edges) for (const side of ['from', 'to']) {
      const type = edge[`${side}_type`]; const key = edge[`${side}_key`]; const id = `${edge.provider_host_id}|${type}|${key}`;
      if (!nodeMap.has(id)) nodeMap.set(id, { providerHostId: edge.provider_host_id, type, key });
    }
    return { nodes: [...nodeMap.values()], edges };
  }

  topologyImpact(eventId, actor) {
    this._admin(actor);
    const db = this._db(); const id = integer(eventId, 'eventId', 1);
    const event = db.prepare('SELECT * FROM vm_observability_events WHERE id=?').get(id);
    if (!event) throw fail('Event not found', 404);
    const edges = this.topology({ providerHostId: event.provider_host_id }, actor).edges;
    const queue = [{ type: event.resource_type, key: event.resource_key, depth: 0 }]; const visited = new Set(); const impacted = [];
    while (queue.length && impacted.length < 500) {
      const current = queue.shift(); const marker = `${current.type}|${current.key}`;
      if (visited.has(marker)) continue;
      visited.add(marker);
      for (const edge of edges.filter(item => item.from_type === current.type && item.from_key === current.key)) {
        const next = { type: edge.to_type, key: edge.to_key, depth: current.depth + 1, relation: edge.relation, edgeId: edge.id };
        impacted.push(next);
        if (next.depth < 4) queue.push(next);
      }
    }
    return { event: rowEvent(event), impacted, truncated: impacted.length >= 500 };
  }

  _condition(raw) {
    const condition = object(raw); const type = clean(condition.type, 'condition.type', 30);
    if (!['metric', 'event', 'state'].includes(type)) throw fail('condition.type is invalid');
    if (type === 'event') return { type, eventTypes: safeList(condition.eventTypes, 'condition.eventTypes', 20, 120),
      withinSeconds: integer(condition.withinSeconds ?? 300, 'condition.withinSeconds', 1, 604800) };
    const operator = condition.operator || '>';
    if (!OPERATORS[operator]) throw fail('condition.operator is invalid');
    const threshold = Number(condition.threshold);
    if (!Number.isFinite(threshold)) throw fail('condition.threshold must be numeric');
    if (type === 'state') {
      if (!['collection_error', 'freshness_lag_seconds'].includes(condition.field)) throw fail('condition.field is invalid');
      return { type, field: condition.field, operator, threshold };
    }
    const aggregate = condition.aggregate || 'latest';
    if (!['latest', 'average', 'minimum', 'maximum', 'rate'].includes(aggregate)) throw fail('condition.aggregate is invalid');
    const metricKey = clean(condition.metricKey, 'condition.metricKey', 120);
    if (!this._db().prepare('SELECT 1 FROM vm_metric_definitions WHERE metric_key=?').get(metricKey)) throw fail(`Unknown metric: ${metricKey}`);
    return { type, metricKey, aggregate, operator, threshold,
      windowSeconds: integer(condition.windowSeconds ?? 300, 'condition.windowSeconds', 1, 604800) };
  }

  createSignalRule(body = {}, actor) {
    this._admin(actor);
    const conditions = Array.isArray(body.conditions) ? body.conditions.map(item => this._condition(item)) : [];
    if (conditions.length < 2 || conditions.length > 8 || new Set(conditions.map(item => item.type)).size < 2) {
      throw fail('Multi-signal rules require 2-8 conditions spanning at least two signal types');
    }
    const severity = body.severity || 'warning'; if (!['warning', 'high', 'critical'].includes(severity)) throw fail('severity is invalid');
    const mode = body.matchMode || 'all'; if (!['all', 'any'].includes(mode)) throw fail('matchMode is invalid');
    const result = this._db().prepare(`INSERT INTO vm_observability_signal_rules
      (name,resource_type,severity,match_mode,duration_seconds,conditions_json,enabled,created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(clean(body.name, 'name', 160), clean(body.resourceType || 'vm', 'resourceType', 60),
      severity, mode, integer(body.durationSeconds ?? 0, 'durationSeconds', 0, 604800), JSON.stringify(conditions),
      body.enabled === false ? 0 : 1, actor.id);
    return this._db().prepare('SELECT * FROM vm_observability_signal_rules WHERE id=?').get(result.lastInsertRowid);
  }

  signalRules(actor) {
    this._admin(actor); const db = this._db();
    return { rules: db.prepare('SELECT * FROM vm_observability_signal_rules ORDER BY id DESC').all().map(row => ({ ...row,
      conditions: json(row.conditions_json, []) })), alerts: db.prepare(`SELECT a.*,r.name rule_name,r.severity
      FROM vm_observability_signal_alerts a JOIN vm_observability_signal_rules r ON r.id=a.rule_id
      ORDER BY a.last_evaluated_at DESC LIMIT 1000`).all().map(row => ({ ...row, evidence: json(row.evidence_json, {}) })) };
  }

  _evaluateCondition(condition, context, rule) {
    const db = this._db(); const op = OPERATORS[condition.operator];
    if (condition.type === 'event') {
      const cutoff = new Date(Date.now() - condition.withinSeconds * 1000).toISOString();
      const placeholders = condition.eventTypes.map(() => '?').join(',');
      const count = db.prepare(`SELECT COUNT(*) count FROM vm_observability_events WHERE provider_host_id=? AND resource_type=?
        AND resource_key=? AND occurred_at>=? AND event_type IN (${placeholders})`).get(context.providerHostId, rule.resource_type,
        context.resourceKey, cutoff, ...condition.eventTypes).count;
      return { matched: count > 0, value: count, condition };
    }
    if (condition.type === 'state') {
      const state = db.prepare(`SELECT *,CAST((julianday('now')-julianday(last_sample_at))*86400 AS INTEGER) lag
        FROM vm_metric_collection_state WHERE provider_host_id=? AND resource_type=? AND resource_key=?`).get(context.providerHostId,
        rule.resource_type, context.resourceKey);
      const value = condition.field === 'collection_error' ? Number(state?.consecutive_errors || 0) : Number(state?.lag || 0);
      return { matched: op(value, condition.threshold), value, condition };
    }
    const windowSeconds = Math.max(condition.windowSeconds, rule.duration_seconds || 0);
    const cutoff = new Date(Date.now() - windowSeconds * 1000).toISOString();
    const points = db.prepare(`SELECT value,sample_at FROM vm_metric_samples WHERE provider_host_id=? AND resource_type=?
      AND resource_key=? AND metric_key=? AND sample_at>=? ORDER BY sample_at`).all(context.providerHostId, rule.resource_type,
      context.resourceKey, condition.metricKey, cutoff);
    let value = null;
    if (points.length) {
      const values = points.map(item => item.value);
      if (condition.aggregate === 'latest') value = values[values.length - 1];
      else if (condition.aggregate === 'average') value = values.reduce((sum, item) => sum + item, 0) / values.length;
      else if (condition.aggregate === 'minimum') value = Math.min(...values);
      else if (condition.aggregate === 'maximum') value = Math.max(...values);
      else if (points.length > 1) {
        const seconds = (Date.parse(points[points.length - 1].sample_at) - Date.parse(points[0].sample_at)) / 1000;
        value = seconds > 0 ? Math.max(0, (values[values.length - 1] - values[0]) / seconds) : null;
      }
    }
    const durationSatisfied = !rule.duration_seconds || (points.length > 1
      && Date.parse(points[points.length - 1].sample_at) - Date.parse(points[0].sample_at) >= rule.duration_seconds * 1000);
    return { matched: value != null && op(value, condition.threshold) && durationSatisfied, value, durationSatisfied, condition };
  }

  evaluateSignals(query = {}, actor) {
    this._admin(actor); const db = this._db();
    const host = integer(query.providerHostId ?? 0, 'providerHostId'); const rules = db.prepare(`SELECT * FROM vm_observability_signal_rules
      WHERE enabled=1 ORDER BY id`).all();
    const candidates = db.prepare(`SELECT resource_type,resource_key FROM vm_metric_collection_state WHERE provider_host_id=?
      UNION SELECT resource_type,resource_key FROM vm_metric_samples WHERE provider_host_id=?
      UNION SELECT resource_type,resource_key FROM vm_observability_events WHERE provider_host_id=? LIMIT 5000`).all(host, host, host);
    let triggered = 0; let resolved = 0;
    db.transaction(() => {
      for (const rule of rules) for (const candidate of candidates.filter(item => item.resource_type === rule.resource_type)) {
        const conditions = json(rule.conditions_json, []); const evidence = conditions.map(condition => this._evaluateCondition(condition,
          { providerHostId: host, resourceKey: candidate.resource_key }, rule));
        const matched = rule.match_mode === 'all' ? evidence.every(item => item.matched) : evidence.some(item => item.matched);
        const active = db.prepare(`SELECT * FROM vm_observability_signal_alerts WHERE rule_id=? AND provider_host_id=?
          AND resource_type=? AND resource_key=? AND state='active'`).get(rule.id, host, rule.resource_type, candidate.resource_key);
        if (matched && active) db.prepare(`UPDATE vm_observability_signal_alerts SET evidence_json=?,last_evaluated_at=datetime('now'),
          occurrence_count=occurrence_count+1 WHERE id=?`).run(JSON.stringify(evidence), active.id);
        else if (matched) {
          db.prepare(`INSERT INTO vm_observability_signal_alerts
            (rule_id,provider_host_id,resource_type,resource_key,evidence_json) VALUES (?,?,?,?,?)`)
            .run(rule.id, host, rule.resource_type, candidate.resource_key, JSON.stringify(evidence)); triggered += 1;
        } else if (active) {
          db.prepare(`UPDATE vm_observability_signal_alerts SET state='resolved',resolved_at=datetime('now'),
            last_evaluated_at=datetime('now'),evidence_json=? WHERE id=?`).run(JSON.stringify(evidence), active.id); resolved += 1;
        }
      }
    })();
    const active = db.prepare("SELECT COUNT(*) count FROM vm_observability_signal_alerts WHERE state='active'").get().count;
    return { providerHostId: host, evaluatedRules: rules.length, evaluatedResources: candidates.length, triggered, resolved, active };
  }
}

const service = new VmObservabilityService();
module.exports = service;
module.exports.VmObservabilityService = VmObservabilityService;
module.exports.VmObservabilityError = VmObservabilityError;
module.exports.EVENT_ADAPTERS = EVENT_ADAPTERS;
module.exports.normalizeEvent = normalizeEvent;
