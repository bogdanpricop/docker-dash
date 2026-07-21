'use strict';

// Tests for src/services/connection-health.js — the Per-Host Connection
// Health & Circuit Breaker (v8.10.x). Covers:
//   - classifyError mapping (auth/hostkey/refused/timeout/unreachable/other)
//   - recordFailure: below-threshold never pauses; at-threshold auth/hostkey
//     WITH a confirmed-reachable probe pauses (+ notifies + audits exactly
//     once); at-threshold auth/hostkey whose probe fails does NOT pause;
//     transient kinds (unreachable/refused/timeout) NEVER pause regardless
//     of failure count and never even call the probe
//   - recordSuccess: resets + clears a paused host, is silent for an
//     already-healthy (never-observed) host
//   - resume / isPaused / getHealth
//
// probeReachable is mocked via jest.spyOn on the exported singleton object
// (recordFailure calls `connectionHealth.probeReachable(...)`, not the bare
// local function, specifically so this works) — no real network I/O in the
// mocked tests. The DB is real (:memory:, migrated) via the same test
// harness pattern as docker-service.test.js / ssh-tunnel-service.test.js.

process.env.APP_SECRET = 'test-secret-key-for-jest-tests-only';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';
process.env.DD_CONN_FAIL_THRESHOLD = '4';

const connectionHealth = require('../services/connection-health');

describe('connection-health', () => {
  let db;
  let hostSeq = 0;

  beforeAll(() => {
    const { getDb } = require('../db');
    db = getDb();
  });

  afterAll(() => {
    const { closeDb } = require('../db');
    try { closeDb(); } catch { /* ignore */ }
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeHost(namePrefix) {
    hostSeq += 1;
    const result = db.prepare(`
      INSERT INTO docker_hosts (name, connection_type, host, port, is_active, is_default)
      VALUES (?, 'ssh', '10.0.0.1', 22, 1, 0)
    `).run(`${namePrefix}-${hostSeq}`);
    return result.lastInsertRowid;
  }

  function getRow(id) {
    return db.prepare('SELECT * FROM docker_hosts WHERE id = ?').get(id);
  }

  // ─── classifyError ──────────────────────────────────────────────────

  describe('classifyError', () => {
    it.each([
      ['All configured authentication methods failed', 'auth'],
      ['Authentication failed for user root', 'auth'],
      ['Permission denied (publickey)', 'auth'],
      ['auth handshake fail', 'auth'],
      ['Host key verification failed', 'hostkey'],
      ['Handshake failed: no matching key exchange', 'hostkey'],
      ['Host key mismatch for 10.0.0.1', 'hostkey'],
      ['connect ECONNREFUSED 10.0.0.1:22', 'refused'],
      ['Connection refused', 'refused'],
      ['connect ETIMEDOUT 10.0.0.1:22', 'timeout'],
      ['Timed out while connecting', 'timeout'],
      ['SSH connection timeout to 10.0.0.1:22', 'timeout'],
      ['connect EHOSTUNREACH 10.0.0.1', 'unreachable'],
      ['getaddrinfo ENOTFOUND badhost.local', 'unreachable'],
      ['connect ENETUNREACH 10.0.0.1', 'unreachable'],
      ['Something completely unexpected happened', 'other'],
    ])('classifies %j as kind=%s', (message, expectedKind) => {
      expect(connectionHealth.classifyError(message).kind).toBe(expectedKind);
    });

    it('never throws on null/undefined/non-string input', () => {
      expect(connectionHealth.classifyError(undefined).kind).toBe('other');
      expect(connectionHealth.classifyError(null).kind).toBe('other');
    });
  });

  // ─── recordFailure ──────────────────────────────────────────────────

  describe('recordFailure', () => {
    it('below threshold does not pause and does not classify as auth_failed', async () => {
      const id = makeHost('below-threshold');
      let result;
      for (let i = 0; i < connectionHealth.THRESHOLD - 1; i++) {
        result = await connectionHealth.recordFailure(id, 'Permission denied (publickey)');
        expect(result.paused).toBe(false);
      }
      const row = getRow(id);
      expect(row.conn_paused).toBe(0);
      expect(row.conn_failures).toBe(connectionHealth.THRESHOLD - 1);
      expect(row.conn_state).not.toBe('auth_failed');
    });

    it('at threshold with a reachable auth failure pauses, notifies, and audits', async () => {
      const id = makeHost('auth-pause');
      jest.spyOn(connectionHealth, 'probeReachable').mockResolvedValue(true);

      let result;
      for (let i = 0; i < connectionHealth.THRESHOLD; i++) {
        result = await connectionHealth.recordFailure(id, 'All configured authentication methods failed');
      }

      expect(result.paused).toBe(true);
      expect(result.state).toBe('auth_failed');

      const row = getRow(id);
      expect(row.conn_paused).toBe(1);
      expect(row.conn_state).toBe('auth_failed');
      expect(row.conn_reachable).toBe(1);
      expect(row.conn_paused_reason).toMatch(/credentials/i);
      expect(row.conn_failures).toBe(connectionHealth.THRESHOLD);

      const notif = db.prepare(
        "SELECT * FROM notifications WHERE title LIKE 'Host needs attention:%' ORDER BY id DESC LIMIT 1"
      ).get();
      expect(notif).toBeTruthy();
      expect(notif.type).toBe('warning');
      expect(notif.user_id).toBeNull(); // broadcast

      const audit = db.prepare(
        "SELECT * FROM audit_log WHERE action = 'host_conn_paused' AND target_id = ? ORDER BY id DESC LIMIT 1"
      ).get(String(id));
      expect(audit).toBeTruthy();
    });

    it('only notifies/audits once on the 0→1 pause transition (not on every failure after)', async () => {
      const id = makeHost('auth-pause-once');
      jest.spyOn(connectionHealth, 'probeReachable').mockResolvedValue(true);
      for (let i = 0; i < connectionHealth.THRESHOLD + 3; i++) {
        await connectionHealth.recordFailure(id, 'All configured authentication methods failed');
      }
      const auditCount = db.prepare(
        "SELECT COUNT(*) AS c FROM audit_log WHERE action = 'host_conn_paused' AND target_id = ?"
      ).get(String(id)).c;
      expect(auditCount).toBe(1);
      const notifCount = db.prepare(
        "SELECT COUNT(*) AS c FROM notifications WHERE title = ?"
      ).get(`Host needs attention: ${getRow(id).name}`).c;
      expect(notifCount).toBe(1);
    });

    it('an auth-shaped failure whose TCP probe fails does NOT pause (looks like a network blip)', async () => {
      const id = makeHost('auth-unreachable');
      jest.spyOn(connectionHealth, 'probeReachable').mockResolvedValue(false);

      let result;
      for (let i = 0; i < connectionHealth.THRESHOLD; i++) {
        result = await connectionHealth.recordFailure(id, 'Authentication failed');
      }

      expect(result.paused).toBe(false);
      expect(result.state).toBe('unreachable');
      const row = getRow(id);
      expect(row.conn_paused).toBe(0);
      expect(row.conn_reachable).toBe(0);
    });

    it('kind=unreachable NEVER pauses regardless of failure count, and never calls the probe', async () => {
      const id = makeHost('net-unreachable');
      const probeSpy = jest.spyOn(connectionHealth, 'probeReachable');

      let result;
      for (let i = 0; i < connectionHealth.THRESHOLD + 3; i++) {
        result = await connectionHealth.recordFailure(id, 'getaddrinfo ENOTFOUND remote.example.com');
      }

      expect(result.paused).toBe(false);
      expect(result.state).toBe('unreachable');
      const row = getRow(id);
      expect(row.conn_paused).toBe(0);
      expect(row.conn_failures).toBe(connectionHealth.THRESHOLD + 3);
      // Transient kinds never need the TCP probe — the point is they keep
      // retrying forever with the existing backoff, unchanged.
      expect(probeSpy).not.toHaveBeenCalled();
    });

    it('kind=refused / kind=timeout also never pause', async () => {
      const idRefused = makeHost('refused');
      const idTimeout = makeHost('timeout');
      for (let i = 0; i < connectionHealth.THRESHOLD + 1; i++) {
        await connectionHealth.recordFailure(idRefused, 'connect ECONNREFUSED 10.0.0.1:22');
        await connectionHealth.recordFailure(idTimeout, 'SSH connection timeout to 10.0.0.1:22');
      }
      expect(getRow(idRefused).conn_paused).toBe(0);
      expect(getRow(idTimeout).conn_paused).toBe(0);
    });

    it('kind=other never pauses', async () => {
      const id = makeHost('other-kind');
      for (let i = 0; i < connectionHealth.THRESHOLD + 1; i++) {
        await connectionHealth.recordFailure(id, 'Something completely unexpected happened');
      }
      const row = getRow(id);
      expect(row.conn_paused).toBe(0);
      expect(row.conn_state).toBe('error');
    });

    it('unknown hostId is a safe no-op (never throws)', async () => {
      const result = await connectionHealth.recordFailure(999999, 'All configured authentication methods failed');
      expect(result).toEqual({ paused: false, state: 'unknown' });
    });

    it('truncates a very long error message', async () => {
      const id = makeHost('long-error');
      const huge = 'x'.repeat(1000);
      await connectionHealth.recordFailure(id, huge);
      const row = getRow(id);
      expect(row.conn_last_error.length).toBeLessThan(400);
    });
  });

  // ─── recordSuccess ──────────────────────────────────────────────────

  describe('recordSuccess', () => {
    it('clears a paused host, resets failures, and audits the recovery', async () => {
      const id = makeHost('recovers');
      jest.spyOn(connectionHealth, 'probeReachable').mockResolvedValue(true);
      for (let i = 0; i < connectionHealth.THRESHOLD; i++) {
        await connectionHealth.recordFailure(id, 'All configured authentication methods failed');
      }
      expect(getRow(id).conn_paused).toBe(1);
      jest.restoreAllMocks();

      connectionHealth.recordSuccess(id);

      const row = getRow(id);
      expect(row.conn_paused).toBe(0);
      expect(row.conn_failures).toBe(0);
      expect(row.conn_state).toBe('ok');
      expect(row.conn_paused_reason).toBeNull();
      expect(row.conn_last_error).toBeNull();

      const audit = db.prepare(
        "SELECT * FROM audit_log WHERE action = 'host_conn_recovered' AND target_id = ? ORDER BY id DESC LIMIT 1"
      ).get(String(id));
      expect(audit).toBeTruthy();
    });

    it('is silent (no audit) for a never-before-observed host (conn_state="unknown" is not "unhealthy")', () => {
      const id = makeHost('already-healthy');
      connectionHealth.recordSuccess(id);
      const row = getRow(id);
      expect(row.conn_state).toBe('ok');
      const audit = db.prepare(
        "SELECT * FROM audit_log WHERE action = 'host_conn_recovered' AND target_id = ?"
      ).get(String(id));
      expect(audit).toBeUndefined();
    });

    it('unknown hostId is a safe no-op', () => {
      expect(() => connectionHealth.recordSuccess(999999)).not.toThrow();
    });
  });

  // ─── resume ─────────────────────────────────────────────────────────

  describe('resume', () => {
    it('clears a paused host without needing a success event, and audits with the given username', async () => {
      const id = makeHost('manual-resume');
      jest.spyOn(connectionHealth, 'probeReachable').mockResolvedValue(true);
      for (let i = 0; i < connectionHealth.THRESHOLD; i++) {
        await connectionHealth.recordFailure(id, 'All configured authentication methods failed');
      }
      jest.restoreAllMocks();
      expect(connectionHealth.isPaused(id)).toBe(true);

      connectionHealth.resume(id, { username: 'bogdan' });

      expect(connectionHealth.isPaused(id)).toBe(false);
      const row = getRow(id);
      expect(row.conn_failures).toBe(0);
      expect(row.conn_state).toBe('unknown');
      expect(row.conn_paused_reason).toBeNull();

      const audit = db.prepare(
        "SELECT * FROM audit_log WHERE action = 'host_conn_resume' AND target_id = ? ORDER BY id DESC LIMIT 1"
      ).get(String(id));
      expect(audit).toBeTruthy();
      expect(audit.username).toBe('bogdan');
    });

    it('defaults username to "system" when not provided', () => {
      const id = makeHost('resume-default-user');
      connectionHealth.resume(id, {});
      const audit = db.prepare(
        "SELECT * FROM audit_log WHERE action = 'host_conn_resume' AND target_id = ? ORDER BY id DESC LIMIT 1"
      ).get(String(id));
      expect(audit.username).toBe('system');
    });
  });

  // ─── isPaused ───────────────────────────────────────────────────────

  describe('isPaused', () => {
    it('reflects conn_paused for a known host', () => {
      const id = makeHost('paused-flag');
      expect(connectionHealth.isPaused(id)).toBe(false);
      db.prepare('UPDATE docker_hosts SET conn_paused = 1 WHERE id = ?').run(id);
      expect(connectionHealth.isPaused(id)).toBe(true);
    });

    it('returns false (never throws) for an unknown host', () => {
      expect(connectionHealth.isPaused(9999999)).toBe(false);
    });
  });

  // ─── getHealth ──────────────────────────────────────────────────────

  describe('getHealth', () => {
    it('returns the persisted conn_* fields, camelCased', async () => {
      const id = makeHost('health-fields');
      jest.spyOn(connectionHealth, 'probeReachable').mockResolvedValue(true);
      for (let i = 0; i < connectionHealth.THRESHOLD; i++) {
        await connectionHealth.recordFailure(id, 'All configured authentication methods failed');
      }
      jest.restoreAllMocks();

      const health = connectionHealth.getHealth(id);
      expect(health.state).toBe('auth_failed');
      expect(health.paused).toBe(true);
      expect(health.reachable).toBe(true);
      expect(health.pausedReason).toMatch(/credentials/i);
      expect(health.failures).toBe(connectionHealth.THRESHOLD);
      expect(typeof health.lastErrorAt).toBe('string');
    });

    it('returns null for an unknown host', () => {
      expect(connectionHealth.getHealth(9999999)).toBeNull();
    });
  });

  // ─── probeReachable (real implementation — no mocking) ─────────────

  describe('probeReachable (real net implementation)', () => {
    it('resolves false when host or port is missing', async () => {
      expect(await connectionHealth.probeReachable(null, null)).toBe(false);
      expect(await connectionHealth.probeReachable('10.0.0.1', null)).toBe(false);
      expect(await connectionHealth.probeReachable('', 22)).toBe(false);
    });

    it('resolves false (within the timeout) for a non-routable/closed target', async () => {
      // 192.0.2.0/24 is TEST-NET-1 (RFC 5737) — reserved for documentation,
      // guaranteed to never route anywhere. Exercises the real
      // net.createConnection path with a short timeout, no mocking.
      const reachable = await connectionHealth.probeReachable('192.0.2.1', 65535, 500);
      expect(reachable).toBe(false);
    }, 5000);
  });
});
