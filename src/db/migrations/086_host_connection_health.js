'use strict';

// v8.10.x — Per-host Connection Health & Circuit Breaker.
//
// Motivation: when a managed host's SSH credentials change, ssh-tunnel.js
// retries forever with exponential backoff (by design — see the v8.7.27
// comment in _scheduleReconnect), flooding the log with auth-failure noise
// and blocking on-demand callers like the sandbox-ttl-sweep job. These new
// columns let src/services/connection-health.js track consecutive failures
// per host, classify the failure kind, and — ONLY for a confirmed-reachable
// auth/host-key rejection — open a circuit ("pause") so reconnect attempts
// stop until an admin updates credentials or clicks Retry. Transient network
// failures (unreachable/refused/timeout) are deliberately NOT paused; the
// existing infinite backoff keeps running for those, unchanged.
//
// ALTER TABLE ... ADD COLUMN is idempotent enough for SQLite as long as we
// don't try to add a column that already exists. Guard with PRAGMA
// table_info() to survive re-running the migration during dev — mirrors
// 069_docker_hosts_daemon_type.js.

exports.up = function (db) {
  const cols = db.prepare('PRAGMA table_info(docker_hosts)').all();
  const has = (name) => cols.some(c => c.name === name);

  if (!has('conn_state')) {
    db.exec(`
      ALTER TABLE docker_hosts ADD COLUMN conn_state TEXT DEFAULT 'unknown'
        CHECK(conn_state IN ('ok', 'unreachable', 'auth_failed', 'error', 'unknown'));
    `);
  }

  if (!has('conn_failures')) {
    db.exec(`ALTER TABLE docker_hosts ADD COLUMN conn_failures INTEGER NOT NULL DEFAULT 0;`);
  }

  if (!has('conn_last_error')) {
    db.exec(`ALTER TABLE docker_hosts ADD COLUMN conn_last_error TEXT;`);
  }

  if (!has('conn_last_error_at')) {
    db.exec(`ALTER TABLE docker_hosts ADD COLUMN conn_last_error_at TEXT;`);
  }

  if (!has('conn_reachable')) {
    // Nullable: last TCP-probe result. 1 = reachable, 0 = unreachable,
    // NULL = never probed.
    db.exec(`ALTER TABLE docker_hosts ADD COLUMN conn_reachable INTEGER;`);
  }

  if (!has('conn_paused')) {
    db.exec(`ALTER TABLE docker_hosts ADD COLUMN conn_paused INTEGER NOT NULL DEFAULT 0;`);
  }

  if (!has('conn_paused_reason')) {
    db.exec(`ALTER TABLE docker_hosts ADD COLUMN conn_paused_reason TEXT;`);
  }

  if (!has('conn_paused_at')) {
    db.exec(`ALTER TABLE docker_hosts ADD COLUMN conn_paused_at TEXT;`);
  }

  // No backfill needed — every existing row defaults to conn_state='unknown',
  // conn_failures=0, conn_paused=0, which matches "we haven't observed this
  // host through the new circuit-breaker logic yet". The first success or
  // failure through ssh-tunnel.js will populate these naturally.
};
