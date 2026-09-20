'use strict';

// v8.96.0 — Diagnostic Sessions, retrospective mode.
//
// "What was happening across my estate at 14:32?" — containers and VMs on one
// time axis, with events and audit entries marked on it. The session changes
// nothing: it is an investigation tool, not a collector and not a remediation
// path. See plans/feature-spec-diagnostic-sessions.md.
//
// Reads only. Sources are the tables that already exist; a session stores its
// definition and nothing else.

const crypto = require('crypto');
const { getDb } = require('../../db');
const { downsample, deltas, clockSkewMs } = require('./downsample');

const MAX_SUBJECTS = 25;
const MIN_WINDOW_MS = 60 * 1000;             // a minute
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // a month
const DEFAULT_BUCKETS = 600;

class DiagnosticsError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'DiagnosticsError'; this.status = status; }
}

// Which container stats tier answers a window of this length. Mirrors the tiers
// stats.js maintains; picking one tier per session keeps a single resolution on
// the axis, which the response then names rather than leaving the reader to guess.
const TIERS = [
  { maxMs: 6 * 60 * 60 * 1000, table: 'container_stats', timeCol: 'recorded_at', resolution: 'raw',
    cols: 'cpu_percent AS cpu, mem_usage AS mem, net_rx, net_tx, blk_read, blk_write' },
  { maxMs: 24 * 60 * 60 * 1000, table: 'container_stats_1m', timeCol: 'bucket', resolution: '1m',
    cols: 'cpu_avg AS cpu, mem_avg AS mem, net_rx_total AS net_rx, net_tx_total AS net_tx, blk_read_total AS blk_read, blk_write_total AS blk_write' },
  { maxMs: 7 * 24 * 60 * 60 * 1000, table: 'container_stats_1h', timeCol: 'bucket', resolution: '1h',
    cols: 'cpu_avg AS cpu, mem_avg AS mem, net_rx_total AS net_rx, net_tx_total AS net_tx, blk_read_total AS blk_read, blk_write_total AS blk_write' },
  { maxMs: Infinity, table: 'container_stats_1d', timeCol: 'bucket', resolution: '1d',
    cols: 'cpu_avg AS cpu, mem_avg AS mem, net_rx_total AS net_rx, net_tx_total AS net_tx, blk_read_total AS blk_read, blk_write_total AS blk_write' },
];

function pickTier(fromMs, toMs) {
  const span = toMs - fromMs;
  return TIERS.find(t => span <= t.maxMs) || TIERS[TIERS.length - 1];
}

function _iso(value, label) {
  const d = new Date(value);
  if (Number.isNaN(d.valueOf())) throw new DiagnosticsError(`${label} is not a valid time`);
  return d.toISOString();
}

function create({ name, from, to, subjects }, user) {
  const db = getDb();
  const start = _iso(from, 'from');
  const end = _iso(to, 'to');
  const span = new Date(end) - new Date(start);
  if (span <= 0) throw new DiagnosticsError('to must be after from');
  if (span < MIN_WINDOW_MS) throw new DiagnosticsError('Window must be at least one minute');
  if (span > MAX_WINDOW_MS) throw new DiagnosticsError('Window must be at most 30 days');

  const list = Array.isArray(subjects) ? subjects.filter(Boolean) : [];
  if (!list.length) throw new DiagnosticsError('At least one subject is required');
  // Above ~25 series the chart is unreadable anyway, so the cap is a UX truth
  // as much as a cost guard.
  if (list.length > MAX_SUBJECTS) throw new DiagnosticsError(`At most ${MAX_SUBJECTS} subjects per session`);
  for (const s of list) {
    if (!s.ref) throw new DiagnosticsError('Each subject needs a ref');
    if (s.type !== 'container' && s.type !== 'vm') throw new DiagnosticsError('Subject type must be container or vm');
  }

  const uuid = crypto.randomUUID();
  const insert = db.prepare(`INSERT INTO diagnostic_sessions
    (uuid, name, window_start, window_end, created_by, created_by_username)
    VALUES (?,?,?,?,?,?)`);
  const addSubject = db.prepare(`INSERT INTO diagnostic_session_subjects
    (session_id, subject_type, subject_ref, host_id, provider_host_id, display_name)
    VALUES (?,?,?,?,?,?)`);

  const id = db.transaction(() => {
    const r = insert.run(uuid, String(name || 'Session').slice(0, 160), start, end,
      user?.id ?? null, user?.username ?? null);
    for (const s of list) {
      addSubject.run(r.lastInsertRowid, s.type, String(s.ref),
        s.hostId ?? null, s.providerHostId ?? null, String(s.displayName || s.ref).slice(0, 200));
    }
    return r.lastInsertRowid;
  })();

  return get(id);
}

function list() {
  const db = getDb();
  return db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM diagnostic_session_subjects x WHERE x.session_id = s.id) AS subject_count
    FROM diagnostic_sessions s ORDER BY s.created_at DESC LIMIT 200`).all();
}

function get(id) {
  const db = getDb();
  const session = db.prepare('SELECT * FROM diagnostic_sessions WHERE id = ?').get(id);
  if (!session) throw new DiagnosticsError('Session not found', 404);
  session.subjects = db.prepare('SELECT * FROM diagnostic_session_subjects WHERE session_id = ? ORDER BY id').all(id);
  return session;
}

function remove(id) {
  const db = getDb();
  const r = db.prepare('DELETE FROM diagnostic_sessions WHERE id = ?').run(id);
  if (!r.changes) throw new DiagnosticsError('Session not found', 404);
  return { ok: true, id };
}

function _containerSeries(db, subject, tier, start, end) {
  const rows = db.prepare(`SELECT ${tier.cols}, ${tier.timeCol} AS t FROM ${tier.table}
    WHERE container_id = ? AND ${tier.timeCol} >= ? AND ${tier.timeCol} <= ? ORDER BY ${tier.timeCol} ASC`)
    .all(subject.subject_ref, start, end);
  return rows;
}

function _vmSeries(db, subject, start, end) {
  return db.prepare(`SELECT metric_key, value, sample_at AS t FROM vm_metric_samples
    WHERE resource_key = ? AND sample_at >= ? AND sample_at <= ? ORDER BY sample_at ASC`)
    .all(subject.subject_ref, start, end);
}

/**
 * Build the correlated view. Every series is bucketed onto the SAME axis, which
 * is the entire point — and nothing is interpolated to get there.
 */
function timeline(id, { buckets = DEFAULT_BUCKETS } = {}) {
  const db = getDb();
  const session = get(id);
  const start = session.window_start;
  const end = session.window_end;
  const fromMs = new Date(start).getTime();
  const toMs = new Date(end).getTime();
  const tier = pickTier(fromMs, toMs);
  const bucketCount = Math.max(60, Math.min(2000, Number(buckets) || DEFAULT_BUCKETS));
  const opts = { from: start, to: end, buckets: bucketCount };

  const observations = [];
  const series = session.subjects.map(subject => {
    if (subject.subject_type === 'vm') {
      const rows = _vmSeries(db, subject, start, end);
      if (rows.length) observations.push({ source: `vm:${subject.subject_ref}`, latest: rows[rows.length - 1].t });
      // Group by metric so a VM contributes one line per metric it reported.
      const byMetric = new Map();
      for (const r of rows) {
        if (!byMetric.has(r.metric_key)) byMetric.set(r.metric_key, []);
        byMetric.get(r.metric_key).push({ t: r.t, v: r.value });
      }
      return {
        subjectId: subject.id, type: 'vm', ref: subject.subject_ref,
        name: subject.display_name || subject.subject_ref,
        // Honest empty state: an ingest-driven table is empty until something
        // pushes to it, and that is not the same as a VM sitting idle.
        hasData: rows.length > 0,
        metrics: [...byMetric.entries()].map(([key, points]) => ({
          key, points: downsample(points, opts), aggregate: 'avg', cumulative: false,
        })),
      };
    }

    const rows = _containerSeries(db, subject, tier, start, end);
    if (rows.length) observations.push({ source: `container:${subject.subject_ref}`, latest: rows[rows.length - 1].t });
    const pick = (col) => rows.map(r => ({ t: r.t, v: r[col] }));
    return {
      subjectId: subject.id, type: 'container', ref: subject.subject_ref,
      name: subject.display_name || subject.subject_ref,
      hasData: rows.length > 0,
      metrics: [
        { key: 'cpu', points: downsample(pick('cpu'), opts), aggregate: 'avg', cumulative: false },
        { key: 'mem', points: downsample(pick('mem'), opts), aggregate: 'avg', cumulative: false },
        // Cumulative counters: delta first so a restart breaks the line instead
        // of drawing a cliff, then bucket the deltas.
        { key: 'net_rx', points: downsample(deltas(pick('net_rx')), { ...opts, aggregate: 'sum' }), aggregate: 'sum', cumulative: true },
        { key: 'net_tx', points: downsample(deltas(pick('net_tx')), { ...opts, aggregate: 'sum' }), aggregate: 'sum', cumulative: true },
      ],
    };
  });

  const annotations = _annotations(db, session, start, end);
  const skewMs = clockSkewMs(observations);

  return {
    session: { id: session.id, uuid: session.uuid, name: session.name, from: start, to: end },
    resolution: tier.resolution,
    buckets: bucketCount,
    series,
    annotations,
    // Reported, never corrected. Two series share an axis only if their clocks
    // agree; hiding a 7-second offset would turn a correlation into a lie.
    clockSkewMs: skewMs,
    clockSkewWarning: skewMs > 2000,
  };
}

function _annotations(db, session, start, end) {
  const refs = session.subjects.map(s => s.subject_ref);
  const out = [];

  const events = db.prepare(`SELECT action, actor_name, event_type, event_time AS t FROM docker_events
    WHERE event_time >= ? AND event_time <= ? ORDER BY event_time ASC LIMIT 500`).all(start, end);
  for (const e of events) {
    if (refs.length && e.actor_name && !refs.some(r => r === e.actor_name || String(e.actor_name).startsWith(r))) continue;
    out.push({ t: e.t, source: 'docker_event', label: `${e.event_type} ${e.action}`, subject: e.actor_name || null });
  }

  const health = db.prepare(`SELECT container_name, status, recorded_at AS t FROM health_events
    WHERE recorded_at >= ? AND recorded_at <= ? ORDER BY recorded_at ASC LIMIT 200`).all(start, end);
  for (const h of health) out.push({ t: h.t, source: 'health', label: `health: ${h.status}`, subject: h.container_name });

  // Usernames stay; client IPs never enter an annotation. An investigation
  // artifact should not become a data-protection problem (deep-spec §3.1).
  const audit = db.prepare(`SELECT action, username, target_id, created_at AS t FROM audit_log
    WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC LIMIT 200`).all(start, end);
  for (const a of audit) out.push({ t: a.t, source: 'audit', label: `${a.action} by ${a.username || 'system'}`, subject: a.target_id });

  return out.sort((a, b) => new Date(a.t) - new Date(b.t)).slice(0, 800);
}

function exportSession(id) {
  const data = timeline(id, {});
  return { exportedAt: new Date().toISOString(), ...data };
}

module.exports = {
  create, list, get, remove, timeline, exportSession,
  DiagnosticsError,
  _internals: { pickTier, MAX_SUBJECTS, MIN_WINDOW_MS, MAX_WINDOW_MS, TIERS },
};
