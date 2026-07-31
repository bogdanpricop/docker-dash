'use strict';

// WHY: Post-v8.2.0 audit found that src/services/auth.js — the security-critical
// core of the dashboard (login, sessions, lockout, password policy, MFA, SSO,
// admin user CRUD) — had no DEDICATED unit test file. auth-flow.test.js and
// auth-rbac.test.js cover happy paths and HTTP routes, but the service-level
// surface (validateSession edge cases, lockout counter, MFA setup/enable/disable,
// changePassword side effects, must_change_password enforcement, SSO provisioning)
// was only partially exercised. This file pins down the actual exported API so
// regressions surface immediately on `npx jest`.

process.env.APP_SECRET = 'test-secret-key-for-jest-tests-only';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'AuthSvcTest123!';
// Lower bcrypt cost so the test suite stays fast; 12 default is too slow for 15+ cases.
process.env.BCRYPT_ROUNDS = '4';
// Tight lockout threshold for deterministic lockout tests without hammering bcrypt.
process.env.LOCKOUT_ATTEMPTS = '3';

const bcrypt = require('bcrypt');

const { getDb, closeDb } = require('../db');
const db = getDb();

const authService = require('../services/auth');
const config = require('../config');
const { sha256 } = require('../utils/crypto');
const totp = require('../utils/totp');

// Seed admin once for the whole file.
authService.seedAdmin();

afterAll(() => {
  closeDb();
});

describe('AuthService — seedAdmin', () => {
  it('creates the default admin user with must_change_password=1 when none exists', () => {
    const admin = db.prepare('SELECT * FROM users WHERE username = ?').get(config.admin.defaultUsername);
    expect(admin).toBeTruthy();
    expect(admin.role).toBe('admin');
    expect(admin.is_active).toBe(1);
    expect(admin.must_change_password).toBe(1);
  });

  it('is a no-op when an admin already exists (idempotent)', () => {
    const before = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    authService.seedAdmin();
    authService.seedAdmin();
    const after = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    expect(after).toBe(before);
  });
});

describe('AuthService — bcrypt round-trip via login', () => {
  beforeAll(() => {
    // Clear must_change so login completes without forcing a change first.
    db.prepare('UPDATE users SET must_change_password = 0, failed_attempts = 0, is_locked = 0 WHERE username = ?')
      .run('admin');
    db.prepare('DELETE FROM login_attempts').run();
  });

  it('hashes the seeded admin password and bcrypt.compare verifies it', async () => {
    const admin = db.prepare('SELECT password_hash FROM users WHERE username = ?').get('admin');
    expect(admin.password_hash).toMatch(/^\$2[aby]\$/); // bcrypt prefix
    const ok = await bcrypt.compare('AuthSvcTest123!', admin.password_hash);
    expect(ok).toBe(true);
  });

  it('login() succeeds with correct password and returns a session token', async () => {
    const result = await authService.login('admin', 'AuthSvcTest123!', '127.0.0.1', 'jest');
    expect(result.error).toBeUndefined();
    expect(typeof result.token).toBe('string');
    expect(result.token.length).toBeGreaterThanOrEqual(32);
    expect(result.user.username).toBe('admin');
    expect(result.user.role).toBe('admin');
  });
});

describe('AuthService — failed-attempt counter & account lockout', () => {
  const ip = '10.99.0.1';
  let userId = null;

  beforeAll(async () => {
    db.prepare('DELETE FROM login_attempts').run();
    // Create a dedicated user so we don't lock out the admin used by other tests.
    const hash = bcrypt.hashSync('LockoutPass123!', 4);
    const r = db.prepare(
      'INSERT INTO users (username, display_name, password_hash, role, is_active, must_change_password) VALUES (?, ?, ?, ?, 1, 0)'
    ).run('lockoutuser', 'Lockout User', hash, 'viewer');
    userId = Number(r.lastInsertRowid);
  });

  beforeEach(() => {
    db.prepare('UPDATE users SET failed_attempts = 0, is_locked = 0, locked_until = NULL WHERE id = ?').run(userId);
    db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip);
  });

  it('increments failed_attempts on each wrong password', async () => {
    await authService.login('lockoutuser', 'wrong-1', ip, 'jest');
    let row = db.prepare('SELECT failed_attempts, is_locked FROM users WHERE id = ?').get(userId);
    expect(row.failed_attempts).toBe(1);
    expect(row.is_locked).toBe(0);

    await authService.login('lockoutuser', 'wrong-2', ip, 'jest');
    row = db.prepare('SELECT failed_attempts, is_locked FROM users WHERE id = ?').get(userId);
    expect(row.failed_attempts).toBe(2);
    expect(row.is_locked).toBe(0);
  });

  it('locks the account after LOCKOUT_ATTEMPTS (3) consecutive failures', async () => {
    for (let i = 0; i < config.security.lockoutAttempts; i++) {
      await authService.login('lockoutuser', `wrong-${i}`, ip, 'jest');
    }
    const row = db.prepare('SELECT failed_attempts, is_locked, locked_until FROM users WHERE id = ?').get(userId);
    expect(row.failed_attempts).toBeGreaterThanOrEqual(config.security.lockoutAttempts);
    expect(row.is_locked).toBe(1);
    expect(row.locked_until).toBeTruthy();
  });

  it('rejects login while account is locked, even with the correct password', async () => {
    // Force the account into a locked state with a future locked_until.
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE users SET is_locked = 1, locked_until = ?, failed_attempts = ? WHERE id = ?')
      .run(future, config.security.lockoutAttempts, userId);

    const result = await authService.login('lockoutuser', 'LockoutPass123!', '10.99.0.2', 'jest');
    expect(result.error).toMatch(/locked/i);
    expect(result.token).toBeUndefined();
  });

  it('resets failed_attempts back to 0 on a successful login', async () => {
    db.prepare('UPDATE users SET failed_attempts = 2, is_locked = 0, locked_until = NULL WHERE id = ?').run(userId);
    const result = await authService.login('lockoutuser', 'LockoutPass123!', '10.99.0.3', 'jest');
    expect(result.token).toBeTruthy();
    const row = db.prepare('SELECT failed_attempts, is_locked FROM users WHERE id = ?').get(userId);
    expect(row.failed_attempts).toBe(0);
    expect(row.is_locked).toBe(0);
  });
});

describe('AuthService — session create / validate / revoke', () => {
  let token = null;

  beforeAll(async () => {
    db.prepare('UPDATE users SET must_change_password = 0, failed_attempts = 0, is_locked = 0 WHERE username = ?')
      .run('admin');
    db.prepare('DELETE FROM login_attempts').run();
    const result = await authService.login('admin', 'AuthSvcTest123!', '127.0.0.10', 'jest');
    token = result.token;
  });

  it('validateSession returns the user for a freshly-issued token', () => {
    const user = authService.validateSession(token);
    expect(user).toBeTruthy();
    expect(user.username).toBe('admin');
    expect(user.role).toBe('admin');
    expect(typeof user.id).toBe('number');
  });

  it('validateSession returns null for a bogus / unknown token', () => {
    expect(authService.validateSession('not-a-real-token')).toBeNull();
  });

  it('validateSession returns null for falsy inputs (null, undefined, empty string)', () => {
    expect(authService.validateSession(null)).toBeNull();
    expect(authService.validateSession(undefined)).toBeNull();
    expect(authService.validateSession('')).toBeNull();
  });

  it('logout() invalidates the session so subsequent validateSession returns null', () => {
    expect(authService.validateSession(token)).toBeTruthy();
    authService.logout(token);
    expect(authService.validateSession(token)).toBeNull();

    // The session row should have is_valid = 0.
    const row = db.prepare('SELECT is_valid FROM sessions WHERE token_hash = ?').get(sha256(token));
    expect(row.is_valid).toBe(0);
  });

  it('logout() is safe to call with an empty / unknown token (no throw)', () => {
    expect(() => authService.logout(undefined)).not.toThrow();
    expect(() => authService.logout('')).not.toThrow();
    expect(() => authService.logout('garbage-token')).not.toThrow();
  });
});

describe('AuthService — validatePassword rules', () => {
  it('rejects passwords shorter than 12 characters', () => {
    expect(authService.validatePassword('Sh0rt!a')).toMatch(/12 characters/);
  });

  it('rejects passwords missing a digit', () => {
    expect(authService.validatePassword('NoDigitsHere!XX')).toMatch(/number/);
  });

  it('rejects passwords missing an uppercase letter', () => {
    expect(authService.validatePassword('nouppercasehere1!')).toMatch(/uppercase/);
  });

  it('rejects passwords missing a symbol', () => {
    expect(authService.validatePassword('NoSymbolsHere1X')).toMatch(/symbol/);
  });

  it('rejects common / blacklisted substrings (admin, password, qwerty, ...)', () => {
    expect(authService.validatePassword('MyAdmin123!XX')).toMatch(/common|blacklist/i);
    expect(authService.validatePassword('Password123!XX')).toMatch(/common|blacklist/i);
    expect(authService.validatePassword('Qwerty123!Xab')).toMatch(/common|blacklist/i);
  });

  it('accepts a strong, non-blacklisted password', () => {
    expect(authService.validatePassword('Tr0ub4dor!&Zx')).toBeNull();
  });
});

describe('AuthService — must_change_password enforcement', () => {
  let pwUserId = null;

  beforeAll(async () => {
    const result = await authService.createUser({
      username: 'mustchange',
      displayName: 'Must Change',
      email: 'mc@test.local',
      password: 'Tr0ub4dor!&Zx',
      role: 'viewer',
    });
    expect(result.id).toBeTruthy();
    pwUserId = Number(result.id);
    // Force the flag (createUser does not set it; we simulate an admin reset).
    db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(pwUserId);
  });

  it('login surfaces mustChangePassword=true when the flag is set', async () => {
    db.prepare('DELETE FROM login_attempts').run();
    const result = await authService.login('mustchange', 'Tr0ub4dor!&Zx', '127.0.1.1', 'jest');
    expect(result.token).toBeTruthy();
    expect(result.user.mustChangePassword).toBe(true);
  });

  it('changePassword clears must_change_password and invalidates all sessions', async () => {
    // Issue a session first.
    db.prepare('DELETE FROM login_attempts').run();
    const login = await authService.login('mustchange', 'Tr0ub4dor!&Zx', '127.0.1.2', 'jest');
    expect(login.token).toBeTruthy();
    expect(authService.validateSession(login.token)).toBeTruthy();

    const result = await authService.changePassword(pwUserId, 'Tr0ub4dor!&Zx', 'NewStr0ng#PwdXY');
    expect(result.success).toBe(true);

    const row = db.prepare('SELECT must_change_password, password_changed_at FROM users WHERE id = ?').get(pwUserId);
    expect(row.must_change_password).toBe(0);
    expect(row.password_changed_at).toBeTruthy();

    // Old session must be invalidated.
    expect(authService.validateSession(login.token)).toBeNull();
  });

  it('changePassword rejects an incorrect current password', async () => {
    const result = await authService.changePassword(pwUserId, 'WrongCurrent!XY', 'AnotherStr0ng#XY');
    expect(result.error).toMatch(/incorrect/i);
  });
});

describe('AuthService — MFA / TOTP setup flow', () => {
  let mfaUserId = null;

  beforeAll(async () => {
    const r = await authService.createUser({
      username: 'mfauser',
      password: 'Tr0ub4dor!&Zx',
      role: 'viewer',
    });
    mfaUserId = Number(r.id);
  });

  it('mfaSetup returns a secret + otpauth URI and stores an encrypted secret', () => {
    const result = authService.mfaSetup(mfaUserId);
    expect(result.error).toBeUndefined();
    expect(typeof result.secret).toBe('string');
    expect(result.secret.length).toBeGreaterThan(0);
    expect(result.otpauthUri).toMatch(/^otpauth:\/\/totp\//);

    const row = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(mfaUserId);
    expect(row.totp_secret).toBeTruthy();
    expect(row.totp_secret).not.toBe(result.secret); // stored encrypted, not plaintext
    expect(row.totp_enabled).toBe(0);
  });

  it('mfaEnable rejects an invalid TOTP code', () => {
    const result = authService.mfaEnable(mfaUserId, '000000');
    expect(result.error).toMatch(/Invalid TOTP/i);
    const row = db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(mfaUserId);
    expect(row.totp_enabled).toBe(0);
  });

  it('mfaEnable activates MFA when given a valid TOTP code derived from the stored secret', () => {
    // Re-setup to grab the plaintext secret, then compute a valid code.
    const setup = authService.mfaSetup(mfaUserId);
    const validCode = totp.generateTOTP(setup.secret);

    const result = authService.mfaEnable(mfaUserId, validCode);
    expect(result.success).toBe(true);
    expect(Array.isArray(result.recoveryCodes)).toBe(true);
    expect(result.recoveryCodes.length).toBeGreaterThan(0);

    const row = db.prepare('SELECT totp_enabled, recovery_codes, mfa_enrolled_at FROM users WHERE id = ?').get(mfaUserId);
    expect(row.totp_enabled).toBe(1);
    expect(row.recovery_codes).toBeTruthy();
    expect(row.mfa_enrolled_at).toBeTruthy();
  });

  it('verifyStepUpMfa validates enrolled local TOTP without creating a session', () => {
    const setup = authService.mfaSetup(mfaUserId);
    const validCode = totp.generateTOTP(setup.secret);
    expect(authService.mfaEnable(mfaUserId, validCode).success).toBe(true);
    const sessionsBefore = db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?')
      .get(mfaUserId).count;
    expect(authService.verifyStepUpMfa(mfaUserId, validCode)).toEqual(expect.objectContaining({
      success: true, verifiedAt: expect.any(String),
    }));
    expect(authService.verifyStepUpMfa(mfaUserId, 'not-a-code')).toEqual({ error: 'Invalid TOTP code' });
    const sessionsAfter = db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?')
      .get(mfaUserId).count;
    expect(sessionsAfter).toBe(sessionsBefore);
  });

  // v8.7.11 — recovery-code lookup is now constant-time (was vulnerable to
  // a timing attack via Array.indexOf short-circuit equality). Functional
  // tests pin the behavior; the constant-time loop is documented inline in
  // verifyMfaRecovery and reviewed at PR time.
  describe('verifyMfaRecovery (v8.7.11 — constant-time)', () => {
    let mfaToken, recoveryCodes;

    beforeEach(async () => {
      // Re-arm MFA so each test has a fresh set of unused recovery codes
      try { await authService.mfaDisable(mfaUserId, 'Tr0ub4dor!&Zx'); } catch {}
      const setup = authService.mfaSetup(mfaUserId);
      const validCode = totp.generateTOTP(setup.secret);
      const enable = authService.mfaEnable(mfaUserId, validCode);
      recoveryCodes = enable.recoveryCodes;
      // Create an MFA token (simulates the login flow handing one out)
      const cryptoLib = require('crypto');
      mfaToken = cryptoLib.randomBytes(32).toString('hex');
      const sha256 = (s) => cryptoLib.createHash('sha256').update(s).digest('hex');
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      db.prepare('INSERT INTO mfa_tokens (token_hash, user_id, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(sha256(mfaToken), mfaUserId, '127.0.0.1', 'test', expiresAt);
    });

    it('accepts a valid recovery code and creates a session', () => {
      const r = authService.verifyMfaRecovery(mfaToken, recoveryCodes[0], '127.0.0.1', 'test');
      expect(r.user).toBeTruthy();
      expect(r.token).toBeTruthy();
      expect(r.error).toBeUndefined();
    });

    it('accepts the LAST recovery code as readily as the FIRST (constant-time loop, no short-circuit)', () => {
      const r = authService.verifyMfaRecovery(mfaToken, recoveryCodes[recoveryCodes.length - 1], '127.0.0.1', 'test');
      expect(r.user).toBeTruthy();
    });

    it('rejects an invalid recovery code', () => {
      const r = authService.verifyMfaRecovery(mfaToken, 'definitely-not-a-real-code', '127.0.0.1', 'test');
      expect(r.error).toMatch(/Invalid recovery code/);
    });

    it('rejects a code whose length matches no stored code (defensive length-guard)', () => {
      const r = authService.verifyMfaRecovery(mfaToken, 'x'.repeat(99), '127.0.0.1', 'test');
      expect(r.error).toMatch(/Invalid recovery code/);
    });

    it('consumes a used code so it cannot be reused', () => {
      const code = recoveryCodes[0];
      const first = authService.verifyMfaRecovery(mfaToken, code, '127.0.0.1', 'test');
      expect(first.user).toBeTruthy();
      const row = db.prepare('SELECT recovery_codes FROM users WHERE id = ?').get(mfaUserId);
      const { decrypt } = require('../utils/crypto');
      const remaining = JSON.parse(decrypt(row.recovery_codes));
      expect(remaining).not.toContain(code);
      expect(remaining.length).toBe(recoveryCodes.length - 1);
    });
  });

  it('mfaDisable refuses without the correct password and clears MFA when password matches', async () => {
    const bad = await authService.mfaDisable(mfaUserId, 'WrongPass!XYZ');
    expect(bad.error).toMatch(/Invalid password/i);

    const ok = await authService.mfaDisable(mfaUserId, 'Tr0ub4dor!&Zx');
    expect(ok.success).toBe(true);

    const row = db.prepare('SELECT totp_enabled, totp_secret, recovery_codes FROM users WHERE id = ?').get(mfaUserId);
    expect(row.totp_enabled).toBe(0);
    expect(row.totp_secret).toBeNull();
    expect(row.recovery_codes).toBeNull();
  });
});

describe('AuthService — SSO user provisioning', () => {
  it('findOrCreateSsoUser auto-creates a new user on first call', () => {
    const user = authService.findOrCreateSsoUser('sso-newcomer', 'operator', 'sso-newcomer@test.local');
    expect(user).toBeTruthy();
    expect(user.username).toBe('sso-newcomer');
    expect(user.role).toBe('operator');
    expect(user.sso).toBe(true);
  });

  it('findOrCreateSsoUser returns null for a deactivated SSO user', () => {
    db.prepare('UPDATE users SET is_active = 0 WHERE username = ?').run('sso-newcomer');
    expect(authService.findOrCreateSsoUser('sso-newcomer', 'operator', 'sso-newcomer@test.local')).toBeNull();
  });
});

describe('AuthService — IP rate limiting', () => {
  it('isIpLocked returns false below the threshold and true once exceeded', () => {
    const ip = '10.55.55.55';
    db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip);
    expect(authService.isIpLocked(ip)).toBe(false);

    // Insert explicit ISO timestamps so the windowStart comparison matches.
    // (The default `datetime('now')` produces a SQLite format that lex-sorts
    // differently than `.toISOString()`, which can hide rate-limit hits in tests.)
    const stmt = db.prepare(
      'INSERT INTO login_attempts (ip, username, user_id, success, user_agent, attempted_at) VALUES (?, ?, ?, 0, ?, ?)'
    );
    const nowIso = new Date().toISOString();
    for (let i = 0; i < config.rateLimit.loginMaxAttempts; i++) {
      stmt.run(ip, 'attacker', null, 'jest', nowIso);
    }
    expect(authService.isIpLocked(ip)).toBe(true);
  });
});
