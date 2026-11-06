'use strict';

// Privacy-first product feedback counters (B375).
// Counters are local, aggregated by day and disabled until each user opts in.
// There is deliberately no collector URL and no network transport here.

const crypto = require('crypto');
const log = require('../utils/logger')('telemetry');

const EVENTS = new Set([
  'catalog.view', 'request.preview', 'request.submit', 'request.failure',
  'incident.view', 'incident.acknowledge', 'help.view',
  'troubleshooting.complete', 'recommendation.view', 'recommendation.follow',
]);
const OUTCOMES = new Set(['success', 'failure', 'cancelled']);
const PROVIDERS = new Set(['proxmox', 'vsphere', 'xen', 'incus', 'kubernetes', 'nomad', 'docker', 'unknown']);

let _enabled = false;
let _installId = null;

function integer(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError(`${field} is invalid`);
  return parsed;
}

function _ensureInstallId(db) {
  if (_installId) return _installId;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='telemetry_install_id'").get();
    if (row?.value) return (_installId = row.value);
    _installId = crypto.randomUUID();
    db.prepare("INSERT INTO settings (key,value) VALUES ('telemetry_install_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(_installId);
    return _installId;
  } catch (error) {
    log.debug('Telemetry install ID unavailable', error.message);
    return null;
  }
}

function preference(db, userId) {
  const id = integer(userId, 'userId');
  try {
    const row = db.prepare('SELECT * FROM product_feedback_preferences WHERE user_id=?').get(id);
    return row ? { enabled: !!row.enabled, usageEnabled: !!row.usage_enabled, failureEnabled: !!row.failure_enabled,
      updatedAt: row.updated_at } : { enabled: false, usageEnabled: true, failureEnabled: true, updatedAt: null };
  } catch {
    return { enabled: false, usageEnabled: true, failureEnabled: true, updatedAt: null };
  }
}

function isEnabled(db, userId = null) {
  try {
    if (userId != null) return preference(db, userId).enabled;
    const row = db.prepare("SELECT value FROM settings WHERE key='telemetry_enabled'").get();
    _enabled = row?.value === 'true';
    return _enabled;
  } catch { return false; }
}

function setPreference(db, userId, input = {}) {
  const id = integer(userId, 'userId');
  const enabled = input.enabled === true ? 1 : 0;
  const usage = input.usageEnabled !== false ? 1 : 0;
  const failure = input.failureEnabled !== false ? 1 : 0;
  if (enabled && !usage && !failure) throw new TypeError('At least one feedback counter category must be enabled');
  db.prepare(`INSERT INTO product_feedback_preferences (user_id,enabled,usage_enabled,failure_enabled,updated_at)
    VALUES (?,?,?,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,
    usage_enabled=excluded.usage_enabled,failure_enabled=excluded.failure_enabled,updated_at=excluded.updated_at`)
    .run(id, enabled, usage, failure);
  return preference(db, id);
}

function record(db, userId, eventKey, input = {}) {
  const pref = preference(db, userId);
  if (!pref.enabled) return { recorded: false, reason: 'opt_in_required' };
  const event = String(eventKey || '').trim().toLowerCase();
  const outcome = String(input.outcome || 'success').trim().toLowerCase();
  const provider = String(input.providerType || 'unknown').trim().toLowerCase();
  if (!EVENTS.has(event)) throw new TypeError('Feedback event is not allowlisted');
  if (!OUTCOMES.has(outcome)) throw new TypeError('Feedback outcome is invalid');
  if (!PROVIDERS.has(provider)) throw new TypeError('Feedback provider is invalid');
  if (outcome === 'failure' && !pref.failureEnabled) return { recorded: false, reason: 'failure_counters_disabled' };
  if (outcome !== 'failure' && !pref.usageEnabled) return { recorded: false, reason: 'usage_counters_disabled' };
  const date = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO product_feedback_daily (event_date,event_key,outcome,provider_type,event_count)
    VALUES (?,?,?,?,1) ON CONFLICT(event_date,event_key,outcome,provider_type) DO UPDATE SET
    event_count=product_feedback_daily.event_count+1,last_recorded_at=datetime('now')`).run(date, event, outcome, provider);
  return { recorded: true, aggregate: { eventDate: date, eventKey: event, outcome, providerType: provider, increment: 1 } };
}

// Backward-compatible no-op for old call sites that do not pass an explicit
// database and user. New code must use record(), which enforces opt-in.
function emit() { return undefined; }

function describePayload(db, mode = 'standalone', userId = null) {
  return {
    destination: 'local SQLite aggregate only',
    networkTransmission: false,
    installId: _ensureInstallId(db) || '<unavailable>',
    version: require('../version'), mode, periodSeconds: 86400,
    preference: userId == null ? { enabled: false } : preference(db, userId),
    sampleCounter: { eventDate: 'YYYY-MM-DD', eventKey: 'catalog.view', outcome: 'success', providerType: 'unknown', increment: 1 },
    excluded: ['username', 'email', 'ip', 'hostname', 'resource name', 'request values', 'error text', 'stack trace'],
  };
}

function summary(db, actor, days = 30) {
  if (actor?.role !== 'admin') throw new TypeError('Administrator access required');
  const safeDays = Math.min(365, Math.max(1, Number(days) || 30));
  const rows = db.prepare(`SELECT event_date,event_key,outcome,provider_type,event_count FROM product_feedback_daily
    WHERE date(event_date)>=date('now',?) ORDER BY event_date DESC,event_key,outcome,provider_type`).all(`-${safeDays - 1} days`);
  return { days: safeDays, counters: rows.map(row => ({ eventDate: row.event_date, eventKey: row.event_key,
    outcome: row.outcome, providerType: row.provider_type, count: Number(row.event_count) })), payload: describePayload(db) };
}

module.exports = { EVENTS, OUTCOMES, PROVIDERS, isEnabled, preference, setPreference, record, emit, describePayload, summary, _ensureInstallId };
