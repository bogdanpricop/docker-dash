'use strict';

// v8.10.x — Per-host Connection Health & Circuit Breaker.
//
// Motivation: ssh-tunnel.js retries a failed host forever with exponential
// backoff (by design — transient network blips must not orphan a host). But
// when credentials actually changed (password rotated, key replaced), that
// same infinite retry just floods the log with
// "[ssh-tunnel] SSH error for host N: All configured authentication methods
// failed" every cycle and blocks on-demand callers like sandbox-ttl-sweep.
//
// This module is the decision layer: given a connection failure, classify
// it, persist a failure counter + last-error on the host row, and — ONLY
// when the failure is an auth/host-key rejection AND a plain TCP probe
// confirms the host is actually reachable AND we've seen enough consecutive
// failures — open the circuit ("pause"). Paused hosts stop being retried by
// ssh-tunnel.js and stop being attempted by on-demand callers via docker.js,
// until an admin updates credentials (PUT /hosts/:id) or clicks Retry
// (POST /hosts/:id/reconnect).
//
// Transient failures (refused/timeout/unreachable) are NEVER paused — the
// existing infinite backoff in ssh-tunnel.js keeps running for those,
// unchanged. This module only surfaces state + a reason for those cases.
//
// Every public function is best-effort: DB errors, missing rows, or a
// notification/audit failure must never throw into the caller — the whole
// point of this feature is to make connectivity MORE robust, never less.

const net = require('net');
const log = require('../utils/logger')('connection-health');

function _db() { return require('../db').getDb(); }

const THRESHOLD = parseInt(process.env.DD_CONN_FAIL_THRESHOLD, 10) || 4;

const MAX_ERROR_LEN = 300;

function _truncate(s) {
  const str = String(s == null ? '' : s);
  return str.length > MAX_ERROR_LEN ? str.slice(0, MAX_ERROR_LEN) + '…' : str;
}

/**
 * Classify a connection-failure message into a coarse kind + a short
 * human-readable reason. Used to decide whether a failure is a candidate
 * for the auth-failure circuit breaker (kind 'auth'/'hostkey') or a
 * transient network issue that must keep retrying forever (everything else).
 */
function classifyError(message) {
  const msg = String(message == null ? '' : message);
  if (/all configured authentication methods failed|authentication failed|permission denied|auth.*fail/i.test(msg)) {
    return { kind: 'auth', reason: 'Authentication rejected' };
  }
  if (/host key|handshake failed|key mismatch/i.test(msg)) {
    return { kind: 'hostkey', reason: 'Host key / handshake failed' };
  }
  if (/econnrefused|connection refused/i.test(msg)) {
    return { kind: 'refused', reason: 'Connection refused' };
  }
  if (/etimedout|timed out|timeout/i.test(msg)) {
    return { kind: 'timeout', reason: 'Connection timed out' };
  }
  if (/ehostunreach|enetunreach|host unreachable|enotfound|getaddrinfo|network unreachable/i.test(msg)) {
    return { kind: 'unreachable', reason: 'Host unreachable' };
  }
  return { kind: 'other', reason: 'Connection error' };
}

/**
 * Raw TCP reachability probe — connects to host:port and resolves true on
 * 'connect', false on 'error' or timeout. Never rejects. Used to confirm
 * that an auth-rejection genuinely came from a live host (not a network
 * blip that merely looks like an auth error).
 */
async function probeReachable(host, port, timeoutMs = 4000) {
  if (!host || !port) return false;
  return new Promise((resolve) => {
    let settled = false;
    let socket;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { socket && socket.destroy(); } catch { /* ignore */ }
      resolve(result);
    };
    try {
      socket = net.createConnection({ host, port, timeout: timeoutMs });
    } catch {
      finish(false);
      return;
    }
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
  });
}

/**
 * Record a connection failure for a host. Classifies the error, bumps the
 * consecutive-failure counter, and — for auth/host-key kinds at/above
 * THRESHOLD with a confirmed-reachable TCP probe — opens the circuit
 * (pauses auto-reconnect) exactly once, firing a notification + audit entry
 * on the 0→1 transition. Never pauses on refused/timeout/unreachable/other.
 *
 * Always wrapped so a bug here can never break the caller's reconnect flow.
 *
 * @returns {Promise<{ paused: boolean, state: string }>}
 */
async function recordFailure(hostId, message) {
  try {
    const db = _db();
    const row = db.prepare('SELECT * FROM docker_hosts WHERE id = ?').get(hostId);
    if (!row) return { paused: false, state: 'unknown' };

    const { kind, reason } = classifyError(message);
    const failures = (row.conn_failures || 0) + 1;
    const lastError = _truncate(`${reason}: ${message}`);
    const nowIso = new Date().toISOString();

    if (kind === 'auth' || kind === 'hostkey') {
      if (failures >= connectionHealth.THRESHOLD) {
        // Resolve the host/port to probe: prefer the SSH endpoint (that's
        // the connection that's actually failing) over the generic
        // host/port columns, which may be unset for SSH-type hosts.
        let probeHost = row.host;
        let probePort = row.port;
        if (row.connection_type === 'ssh' && row.ssh_config) {
          try {
            const { decryptSshConfig } = require('./host-config-crypto');
            const ssh = decryptSshConfig(row.ssh_config);
            if (ssh) {
              probeHost = ssh.host || probeHost;
              probePort = ssh.port || 22;
            }
          } catch { /* fall back to row.host/row.port */ }
        }

        const reachable = await connectionHealth.probeReachable(probeHost, probePort);

        if (reachable) {
          const wasPaused = !!row.conn_paused;

          db.prepare(`
            UPDATE docker_hosts SET conn_failures = ?, conn_last_error = ?, conn_last_error_at = ?,
              conn_state = 'auth_failed', conn_reachable = 1
            WHERE id = ?
          `).run(failures, lastError, nowIso, hostId);

          if (!wasPaused) {
            const pausedReason = 'Reachable but authentication is failing — credentials may have changed. Update credentials to resume.';
            db.prepare(`
              UPDATE docker_hosts SET conn_paused = 1, conn_paused_reason = ?, conn_paused_at = ?
              WHERE id = ?
            `).run(pausedReason, nowIso, hostId);

            try {
              const { notifications } = require('./misc');
              notifications.create({
                userId: null,
                type: 'warning',
                title: `Host needs attention: ${row.name}`,
                message: reason,
                link: '#/hosts',
              });
            } catch { /* best-effort */ }

            try {
              require('./audit').log({
                username: 'system',
                action: 'host_conn_paused',
                targetType: 'host',
                targetId: String(hostId),
                details: { reason, failures },
              });
            } catch { /* best-effort */ }
          }

          return { paused: true, state: 'auth_failed' };
        }

        // Auth-shaped error, but the TCP probe itself couldn't connect —
        // this looks like a network blip, not a real credential problem.
        // Do NOT pause; leave the existing infinite backoff running.
        db.prepare(`
          UPDATE docker_hosts SET conn_failures = ?, conn_last_error = ?, conn_last_error_at = ?,
            conn_state = 'unreachable', conn_reachable = 0
          WHERE id = ?
        `).run(failures, lastError, nowIso, hostId);
        return { paused: false, state: 'unreachable' };
      }

      // Below threshold — record the failure but don't jump to
      // 'auth_failed' yet; a single blip shouldn't flap the badge.
      db.prepare(`
        UPDATE docker_hosts SET conn_failures = ?, conn_last_error = ?, conn_last_error_at = ?,
          conn_state = 'error'
        WHERE id = ?
      `).run(failures, lastError, nowIso, hostId);
      return { paused: false, state: 'error' };
    }

    if (kind === 'refused' || kind === 'timeout' || kind === 'unreachable') {
      // Transient network failure — never pause. Keep the existing
      // infinite backoff in ssh-tunnel.js completely untouched.
      db.prepare(`
        UPDATE docker_hosts SET conn_failures = ?, conn_last_error = ?, conn_last_error_at = ?,
          conn_state = 'unreachable'
        WHERE id = ?
      `).run(failures, lastError, nowIso, hostId);
      return { paused: false, state: 'unreachable' };
    }

    // kind === 'other'
    db.prepare(`
      UPDATE docker_hosts SET conn_failures = ?, conn_last_error = ?, conn_last_error_at = ?,
        conn_state = 'error'
      WHERE id = ?
    `).run(failures, lastError, nowIso, hostId);
    return { paused: false, state: 'error' };
  } catch (err) {
    try { log.error(`recordFailure failed for host ${hostId}`, { error: err.message }); } catch { /* ignore */ }
    return { paused: false, state: 'unknown' };
  }
}

/**
 * Record a successful connection. Resets the failure counter and — if the
 * host was previously paused or unhealthy — clears the pause, logs a
 * recovery audit entry, and fires an info notification. Best-effort.
 */
function recordSuccess(hostId) {
  try {
    const db = _db();
    const row = db.prepare('SELECT id, name, conn_paused, conn_failures, conn_state FROM docker_hosts WHERE id = ?').get(hostId);
    if (!row) return;

    // Note: a fresh host's conn_state defaults to 'unknown' (never observed
    // yet) — that must NOT count as "unhealthy", or every host's very first
    // successful connection would fire a spurious "recovered" audit entry
    // and notification. Only real negative signals count.
    const badStates = new Set(['auth_failed', 'unreachable', 'error']);
    const wasUnhealthy = !!row.conn_paused
      || (row.conn_failures || 0) > 0
      || badStates.has(row.conn_state);

    db.prepare(`
      UPDATE docker_hosts SET conn_failures = 0, conn_state = 'ok', conn_paused = 0,
        conn_paused_reason = NULL, conn_paused_at = NULL, conn_last_error = NULL, conn_reachable = 1
      WHERE id = ?
    `).run(hostId);

    if (wasUnhealthy) {
      try {
        require('./audit').log({
          username: 'system',
          action: 'host_conn_recovered',
          targetType: 'host',
          targetId: String(hostId),
        });
      } catch { /* best-effort */ }

      try {
        const { notifications } = require('./misc');
        notifications.create({
          userId: null,
          type: 'info',
          title: `Host recovered: ${row.name}`,
          message: 'Connection restored.',
          link: '#/hosts',
        });
      } catch { /* best-effort */ }
    }
  } catch (err) {
    try { log.error(`recordSuccess failed for host ${hostId}`, { error: err.message }); } catch { /* ignore */ }
  }
}

/** Fast, synchronous check: is this host's circuit currently open (paused)? */
function isPaused(hostId) {
  try {
    const row = _db().prepare('SELECT conn_paused FROM docker_hosts WHERE id = ?').get(hostId);
    return !!(row && row.conn_paused);
  } catch {
    return false;
  }
}

/**
 * Clear a host's paused state and reset its failure counter. Used both when
 * an admin updates credentials (PUT /hosts/:id) and on manual Retry
 * (POST /hosts/:id/reconnect).
 */
function resume(hostId, { username } = {}) {
  try {
    const db = _db();
    db.prepare(`
      UPDATE docker_hosts SET conn_paused = 0, conn_paused_reason = NULL, conn_paused_at = NULL,
        conn_failures = 0, conn_state = 'unknown'
      WHERE id = ?
    `).run(hostId);

    try {
      require('./audit').log({
        username: username || 'system',
        action: 'host_conn_resume',
        targetType: 'host',
        targetId: String(hostId),
      });
    } catch { /* best-effort */ }
  } catch (err) {
    try { log.error(`resume failed for host ${hostId}`, { error: err.message }); } catch { /* ignore */ }
  }
}

/** Read the persisted conn_* fields for a host, camelCased for the API. */
function getHealth(hostId) {
  try {
    const row = _db().prepare(`
      SELECT conn_state, conn_failures, conn_last_error, conn_last_error_at,
             conn_reachable, conn_paused, conn_paused_reason, conn_paused_at
      FROM docker_hosts WHERE id = ?
    `).get(hostId);
    if (!row) return null;
    return {
      state: row.conn_state,
      failures: row.conn_failures,
      lastError: row.conn_last_error,
      lastErrorAt: row.conn_last_error_at,
      reachable: row.conn_reachable === null || row.conn_reachable === undefined ? null : !!row.conn_reachable,
      paused: !!row.conn_paused,
      pausedReason: row.conn_paused_reason,
      pausedAt: row.conn_paused_at,
    };
  } catch {
    return null;
  }
}

// Exported as a single object (not destructured functions) so that tests can
// jest.spyOn(connectionHealth, 'probeReachable') and have recordFailure's
// internal `connectionHealth.probeReachable(...)` call pick up the mock.
const connectionHealth = {
  classifyError,
  probeReachable,
  recordFailure,
  recordSuccess,
  isPaused,
  resume,
  getHealth,
  THRESHOLD,
};

module.exports = connectionHealth;
