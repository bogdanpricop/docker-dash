'use strict';

// Remediation Scheduler — v6.9.0
//
// Polls the `remediation_jobs` table every minute for rows in status='scheduled'
// whose scheduled_at <= now(). For each, promotes status to 'pending' + kicks
// off runJob. Failures bubble into the standard apply-job error path (status
// flips to 'failed' with error_class).
//
// Why separate from src/jobs/index.js's generic tick: keeps the remediation
// module self-contained. server.js wires this once at startup (same pattern as
// acme-watcher).

const log = require('../utils/logger')('remediation-scheduler');
const { getDb } = require('../db');

const POLL_INTERVAL_MS = Number(process.env.DD_REMEDIATION_SCHEDULER_POLL_MS) || 60_000;

let _timer = null;
let _runJob = null;  // injected to avoid circular require

/**
 * Inject the runner function. Server.js calls this once with `remediate.runJob`.
 */
function setRunner(fn) { _runJob = fn; }

async function _tick() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, scope_type, scope_id, scheduled_at
    FROM remediation_jobs
    WHERE status = 'scheduled'
      AND scheduled_at <= datetime('now')
    ORDER BY scheduled_at ASC
    LIMIT 50
  `).all();

  if (rows.length === 0) return { promoted: 0 };

  let promoted = 0;
  for (const r of rows) {
    // Promote to pending. Concurrency-safe: only proceed if the UPDATE
    // actually changed this row from 'scheduled' to 'pending' (in case two
    // schedulers race — unlikely but the guard is cheap).
    const upd = db.prepare(`
      UPDATE remediation_jobs
      SET status = 'pending', started_at = NULL
      WHERE id = ? AND status = 'scheduled'
    `).run(r.id);
    if (upd.changes !== 1) continue;  // another tick grabbed it

    promoted++;
    log.info('Promoting scheduled job', { jobId: r.id, scheduledAt: r.scheduled_at, scope: `${r.scope_type}:${r.scope_id}` });

    if (!_runJob) {
      log.error('Scheduled job ready but no runner injected — job stuck in pending', { jobId: r.id });
      continue;
    }
    // Fire-and-forget: runJob writes progress to DB
    _runJob(r.id).catch((err) => {
      log.error('Scheduled job runner threw', { jobId: r.id, error: err.message });
    });
  }
  return { promoted };
}

function start() {
  if (_timer) return;
  _timer = setInterval(() => {
    _tick().catch((err) => log.error('scheduler tick failed', { error: err.message }));
  }, POLL_INTERVAL_MS);
  // v8.7.38 — .unref() so the timer does not keep the Node event loop
  // alive on its own. Without this, even if all other timers are cleared
  // during graceful shutdown, this interval would block process exit
  // until the next tick fires (up to POLL_INTERVAL_MS = 60s) and then
  // the cleared timer drops out. Defensive — pairs with the new
  // shutdown() call in server.js that explicitly invokes stop().
  if (typeof _timer.unref === 'function') _timer.unref();
  log.info('Remediation scheduler started', { pollMs: POLL_INTERVAL_MS });
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
  start,
  stop,
  setRunner,
  _internals: { _tick, POLL_INTERVAL_MS },
};
