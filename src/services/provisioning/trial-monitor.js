'use strict';

// v8.18.0 (Onboarding & Provisioning Wizard — Phase 4) — trial-expiry lifecycle.
//
// Mirrors the reconciler/posture drift monitors: a periodic `tick()` + an
// unref'd `start(intervalMs)` with a delayed first run, wired in server.js. Best
// effort — a thrown query never crashes the process.
//
// On each tick it looks at every `usage_mode='trial'` tenant with a
// `trial_expires_at`:
//   * PAST expiry and not already suspended → set `status='suspended'`, raise a
//     `warning` notification, and audit `tenant_trial_expired`.
//   * WITHIN the warning window (N days before expiry) → a one-shot `info`
//     notification, deduped via a `trial.warned_for` tenant_settings marker so a
//     restart never re-warns for the same expiry.
//
// Suspension is deliberately LIGHTWEIGHT (feature-spec §I Phase 4, "keep it
// lightweight"): it marks status + notifies + surfaces in the UI. It builds NO
// cross-cutting enforcement middleware — the tenant seam is a logical grouping,
// not a security boundary (SECURITY.md "Known Security Tradeoffs"), so
// `status='suspended'` is an operational signal, not an access-control gate. The
// existing instance-level auth/RBAC is unchanged; a suspended trial is a prompt
// to extend or promote, not a hard lockout.

function _db() { return require('../../db').getDb(); }
const auditService = require('../audit');
const log = require('../../utils/logger')('trial-monitor');

const WARN_MARKER_KEY = 'trial.warned_for';
const WARN_WINDOW_DAYS = 3;

/** Trial length in days (DD_TRIAL_DAYS, default 14). */
function trialDays() {
  const n = parseInt(process.env.DD_TRIAL_DAYS, 10);
  return Number.isFinite(n) && n > 0 ? n : 14;
}

// SQLite datetime('now') is UTC 'YYYY-MM-DD HH:MM:SS' with no zone marker —
// normalise to a parseable UTC timestamp (same idiom as reconciler/monitor.js).
function _parseTs(s) {
  if (!s) return NaN;
  return Date.parse(String(s).replace(' ', 'T') + 'Z');
}

function _notify(type, title, message) {
  try {
    const { notifications } = require('../misc');
    notifications.create({ userId: null, type, title, message, link: '#/onboarding' });
  } catch (e) { log.debug('notification skipped', { error: e.message }); }
}

function _getSetting(db, tenantId, key) {
  try { const r = db.prepare('SELECT value FROM tenant_settings WHERE tenant_id = ? AND key = ?').get(tenantId, key); return r ? r.value : null; }
  catch { return null; }
}
function _setSetting(db, tenantId, key, value) {
  db.prepare(`
    INSERT INTO tenant_settings (tenant_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(tenantId, key, value);
}
function _clearSetting(db, tenantId, key) {
  try { db.prepare('DELETE FROM tenant_settings WHERE tenant_id = ? AND key = ?').run(tenantId, key); } catch { /* absent */ }
}

/**
 * One sweep. Returns a small tally so callers/tests can assert what happened.
 * @returns {{checked:number, suspended:number, warned:number}}
 */
function tick({ db: dbOverride } = {}) {
  const db = dbOverride || _db();
  let tenants;
  try {
    tenants = db.prepare(
      "SELECT id, slug, name, status, trial_expires_at FROM tenants WHERE usage_mode = 'trial' AND trial_expires_at IS NOT NULL",
    ).all();
  } catch { return { checked: 0, suspended: 0, warned: 0 }; }

  const now = Date.now();
  let suspended = 0; let warned = 0;
  for (const t of tenants) {
    const exp = _parseTs(t.trial_expires_at);
    if (!Number.isFinite(exp)) continue;

    if (exp <= now) {
      if (t.status === 'suspended') continue; // already handled — idempotent
      // ── THE SUSPEND GUARD ──────────────────────────────────────────────────
      // Only a trial tenant, only past expiry, only if not already suspended.
      // The WHERE clause makes a concurrent/repeat tick a structural no-op: a row
      // that is already suspended matches nothing, so it can never be re-suspended
      // or re-notified.
      const res = db.prepare(
        "UPDATE tenants SET status = 'suspended', updated_at = datetime('now') "
        + "WHERE id = ? AND usage_mode = 'trial' AND status != 'suspended' AND trial_expires_at IS NOT NULL",
      ).run(t.id);
      if (!res.changes) continue; // lost the race → someone else already suspended it
      suspended += 1;
      _notify('warning', `Trial expired: ${t.name || t.slug}`,
        `The trial for "${t.name || t.slug}" has expired and the tenant is now suspended. Extend the trial or promote it to production to reactivate.`);
      auditService.log({
        username: 'system', action: 'tenant_trial_expired', targetType: 'tenant', targetId: String(t.id),
        details: { slug: t.slug, expiredAt: t.trial_expires_at }, ip: null,
      });
    } else {
      const daysLeft = Math.ceil((exp - now) / 864e5);
      if (daysLeft > WARN_WINDOW_DAYS) continue;
      // Dedup: one warning per (tenant, expiry). Persisted so a restart never
      // re-fires for the same expiry; extend-trial clears it so a later approach
      // to a NEW expiry warns again.
      if (_getSetting(db, t.id, WARN_MARKER_KEY) === t.trial_expires_at) continue;
      _setSetting(db, t.id, WARN_MARKER_KEY, t.trial_expires_at);
      warned += 1;
      _notify('info', `Trial ending soon: ${t.name || t.slug}`,
        `The trial for "${t.name || t.slug}" ends in ${daysLeft} day(s). Extend it or promote to production before it expires.`);
    }
  }
  return { checked: tenants.length, suspended, warned };
}

/**
 * Push a tenant's trial expiry out by `days` (default DD_TRIAL_DAYS) from the
 * LATER of now / the current expiry, and REACTIVATE it if it was suspended.
 * Clears the warning marker so the next approach warns afresh. Audited.
 * @returns {{tenantId:number, trialExpiresAt:string, reactivated:boolean, days:number}}
 */
function extendTrial(tenantId, { days, user, ip, db: dbOverride } = {}) {
  const db = dbOverride || _db();
  const tenant = db.prepare('SELECT id, slug, usage_mode, status, trial_expires_at FROM tenants WHERE id = ?').get(tenantId);
  if (!tenant) { const e = new Error(`tenant ${tenantId} not found`); e.status = 404; throw e; }
  if (tenant.usage_mode !== 'trial') { const e = new Error(`tenant ${tenant.slug} is not a trial (usage_mode=${tenant.usage_mode})`); e.status = 409; throw e; }

  const n = Number.isFinite(Number(days)) && Number(days) > 0 ? Math.min(Math.floor(Number(days)), 3650) : trialDays();
  // Anchor from max(now, current expiry) so extending an already-lapsed trial
  // still yields a future date, and an early extension stacks onto what's left.
  const anchor = db.prepare(
    "SELECT CASE WHEN trial_expires_at IS NOT NULL AND trial_expires_at > datetime('now') THEN trial_expires_at ELSE datetime('now') END AS base FROM tenants WHERE id = ?",
  ).get(tenantId).base;
  const next = db.prepare("SELECT datetime(?, '+' || ? || ' days') AS t").get(anchor, n).t;

  const reactivated = tenant.status === 'suspended';
  db.prepare(
    "UPDATE tenants SET trial_expires_at = ?, status = CASE WHEN status = 'suspended' THEN 'active' ELSE status END, updated_at = datetime('now') WHERE id = ?",
  ).run(next, tenantId);
  _clearSetting(db, tenantId, WARN_MARKER_KEY);

  auditService.log({
    userId: user && user.id, username: (user && user.username) || 'system',
    action: 'tenant_trial_extend', targetType: 'tenant', targetId: String(tenantId),
    details: { slug: tenant.slug, days: n, from: tenant.trial_expires_at, to: next, reactivated }, ip: ip || null,
  });
  return { tenantId, trialExpiresAt: next, reactivated, days: n };
}

function start(intervalMs = 60 * 60 * 1000) {
  const t = setInterval(() => { try { tick(); } catch { /* best-effort */ } }, intervalMs);
  t.unref();
  setTimeout(() => { try { tick(); } catch { /* best-effort */ } }, 2 * 60 * 1000).unref();
  return t;
}

module.exports = { tick, start, extendTrial, trialDays, WARN_MARKER_KEY, WARN_WINDOW_DAYS };
