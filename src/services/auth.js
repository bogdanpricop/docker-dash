'use strict';

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { getDb } = require('../db');
const config = require('../config');
const ldapService = require('./ldap');
const { generateToken, sha256, encrypt, decrypt } = require('../utils/crypto');
const totp = require('../utils/totp');
const { now } = require('../utils/helpers');
const log = require('../utils/logger')('auth');

// Pre-computed dummy hash used for timing-safe "user not found" path (FIX #18).
// Cost 12, random string — this ensures bcrypt.compare always runs even for unknown usernames.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12);

class AuthService {
  /** Seed default admin user if none exists */
  seedAdmin() {
    const db = getDb();
    const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    if (count === 0) {
      const hash = bcrypt.hashSync(config.admin.defaultPassword, config.security.bcryptRounds);
      db.prepare(`INSERT INTO users (username, display_name, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, 1)`)
        .run(config.admin.defaultUsername, 'Administrator', hash, 'admin');
      log.info('Default admin user created (password change required on first login)');
    }
  }

  /** Check if initial setup has been completed */
  isSetupComplete() {
    const db = getDb();
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'setup_completed'").get();
      return row?.value === 'true';
    } catch { return true; /* assume complete if setting doesn't exist */ }
  }

  /** Mark setup as completed */
  completeSetup() {
    const db = getDb();
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('setup_completed', 'true', datetime('now'))").run();
  }

  /** Check if default admin account is still active with default username */
  hasDefaultAdminActive() {
    const db = getDb();
    const admin = db.prepare("SELECT id, is_active FROM users WHERE username = ? COLLATE NOCASE").get(config.admin.defaultUsername);
    return admin?.is_active === 1;
  }

  /** Validate password strength (FIX #28) — synchronous, keeps original call signature */
  validatePassword(password) {
    if (!password || password.length < 12) return 'Password must be at least 12 characters';
    if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter';
    if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter';
    if (!/\d/.test(password)) return 'Password must contain at least one number';
    if (!/[^A-Za-z0-9]/.test(password)) return 'Password must contain at least one symbol';

    // Common password blacklist
    const lower = password.toLowerCase();
    const BLACKLIST = [
      'admin', 'password', 'docker', 'dashboard', 'qwerty', 'changeme',
      'letmein', '123456', 'password123', '12345678', '123456789',
      'iloveyou', 'sunshine', 'princess', 'welcome', 'monkey',
    ];
    if (BLACKLIST.some(b => lower.includes(b))) {
      return 'Password is too common or contains a blacklisted word';
    }

    return null; // valid (sync checks passed)
  }

  /** HIBP k-anonymity breach check — async, fail-open (FIX #28) */
  async checkHibp(password) {
    if (process.env.HIBP_API_ENABLED !== 'true') return null;
    try {
      const sha1 = require('crypto').createHash('sha1').update(password).digest('hex').toUpperCase();
      const prefix = sha1.substring(0, 5);
      const suffix = sha1.substring(5);
      const result = await new Promise((resolve, reject) => {
        const https = require('https');
        const req = https.get(
          `https://api.pwnedpasswords.com/range/${prefix}`,
          { headers: { 'User-Agent': 'docker-dash' }, timeout: 3000 },
          (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve(data));
          }
        );
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('HIBP timeout')); });
      });
      const lines = result.split('\n');
      for (const line of lines) {
        const [hash] = line.split(':');
        if (hash && hash.trim() === suffix) {
          return 'Password has been found in a data breach. Please choose a different password.';
        }
      }
    } catch (err) {
      log.warn('HIBP check failed (fail-open)', err.message);
      // fail-open: allow the password
    }
    return null;
  }

  /** Authenticate user by username + password */
  /** Try LDAP authentication — returns ldapUser object or null */
  async _tryLdapLogin(username, password) {
    const cfg = ldapService.getConfig();
    if (!cfg || !cfg.enabled) return null;
    try {
      return await ldapService.authenticate(username, password);
    } catch (err) {
      log.warn('LDAP auth failed', { username, error: err.message });
      return null;
    }
  }

  /** Create or update a local user record for an LDAP-authenticated user */
  _provisionLdapUser(db, ldapUser) {
    const existing = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(ldapUser.username);
    if (existing) {
      // A directory account must never take over a local account with the same name.
      if (existing.auth_source !== 'ldap') throw new Error('Username belongs to a local account');
      // Update email/displayName if changed
      db.prepare("UPDATE users SET display_name = ?, email = ?, auth_source = 'ldap' WHERE id = ?")
        .run(ldapUser.displayName, ldapUser.email, existing.id);
      return db.prepare("SELECT * FROM users WHERE id = ?").get(existing.id);
    }
    // FIX #26: Provision new user with a cryptographically unguessable unusable password (login only via LDAP).
    // Cost 12 + 48 random bytes ensures the hash is never guessable or brute-forceable.
    const unguessable = crypto.randomBytes(48).toString('hex');
    const unusableHash = bcrypt.hashSync(unguessable, 12);
    const cfg = ldapService.getConfig();
    const defaultRole = cfg.defaultRole || 'viewer';
    db.prepare(`INSERT INTO users (username, display_name, email, password_hash, role, auth_source, is_active)
                VALUES (?, ?, ?, ?, ?, 'ldap', 1)`)
      .run(ldapUser.username, ldapUser.displayName, ldapUser.email, unusableHash, defaultRole);
    return db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(ldapUser.username);
  }

  async login(username, password, ip, userAgent) {
    if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
      return { error: 'Invalid credentials' };
    }
    const db = getDb();

    // Check rate limiting
    if (this.isIpLocked(ip)) {
      this.logAttempt(ip, username, null, false, userAgent);
      return { error: 'Too many attempts. Try again later.', locked: true };
    }

    let ldapVerified = false;
    let user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
    if (!user) {
      // Try LDAP authentication if configured
      const ldapUser = await this._tryLdapLogin(username, password);
      if (ldapUser) {
        // Provision or update local user record for LDAP user
        user = this._provisionLdapUser(db, ldapUser);
        ldapVerified = true;
      }
      if (!user) {
        // FIX #18: Run dummy bcrypt compare to prevent user-enumeration via timing side-channel.
        await bcrypt.compare(password, DUMMY_HASH);
        this.logAttempt(ip, username, null, false, userAgent);
        return { error: 'Invalid credentials' };
      }
    }

    if (!user.is_active) {
      this.logAttempt(ip, username, user.id, false, userAgent);
      return { error: 'Account is disabled' };
    }

    if (user.is_locked && user.locked_until && new Date(user.locked_until) > new Date()) {
      this.logAttempt(ip, username, user.id, false, userAgent);
      return { error: 'Account is locked. Try again later.' };
    }

    if (!['local', 'ldap'].includes(user.auth_source)) {
      this.logAttempt(ip, username, user.id, false, userAgent);
      return { error: 'Use your identity provider to sign in' };
    }
    // LDAP accounts have deliberately unusable local hashes. Revalidate with
    // the directory on every login so password/group revocations take effect.
    const valid = user.auth_source === 'ldap'
      ? ldapVerified || !!(await this._tryLdapLogin(username, password))
      : await bcrypt.compare(password, user.password_hash);
    // Password/directory verification is asynchronous. Serialize its result with
    // credential changes and read fresh account state before issuing any token.
    return db.transaction(() => {
      const current = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      if (!current || !current.is_active || current.auth_version !== user.auth_version) {
        this.logAttempt(ip, username, current?.id || null, false, userAgent);
        return { error: 'Invalid credentials' };
      }
      user = current;
      if (this.isIpLocked(ip)) {
        this.logAttempt(ip, username, user.id, false, userAgent);
        return { error: 'Too many attempts. Try again later.', locked: true };
      }
      if (user.is_locked && user.locked_until && new Date(user.locked_until) > new Date()) {
        this.logAttempt(ip, username, user.id, false, userAgent);
        return { error: 'Account is locked. Try again later.' };
      }
      if (!valid) {
        const fails = user.failed_attempts + 1;
        if (fails >= config.security.lockoutAttempts) {
          const lockUntil = new Date(Date.now() + config.security.lockoutDurationMs).toISOString();
          db.prepare('UPDATE users SET failed_attempts = ?, is_locked = 1, locked_until = ? WHERE id = ?')
            .run(fails, lockUntil, user.id);
          log.warn('Account locked', { username, attempts: fails });
        } else {
          db.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').run(fails, user.id);
        }
        this.logAttempt(ip, username, user.id, false, userAgent);
        return { error: 'Invalid credentials' };
      }

      // Success - reset failed attempts
      db.prepare('UPDATE users SET failed_attempts = 0, is_locked = 0, locked_until = NULL, last_login_at = ? WHERE id = ?')
        .run(now(), user.id);

      // Check if MFA is enabled for this user
      if (user.totp_enabled) {
        // Create a temporary MFA token (5 min TTL)
        const mfaToken = generateToken(32);
        const mfaTokenHash = sha256(mfaToken);
        const mfaExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

        db.prepare('INSERT INTO mfa_tokens (token_hash, user_id, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)')
          .run(mfaTokenHash, user.id, ip, userAgent, mfaExpiresAt);

        this.logAttempt(ip, username, user.id, true, userAgent);
        log.info('Login pending MFA', { username, ip });

        return {
          mfaRequired: true,
          mfaToken,
          user: {
            id: user.id, username: user.username, displayName: user.display_name, role: user.role,
            mustChangePassword: !!user.must_change_password,
          },
        };
      }

      // No MFA — create full session
      return this._createSession(user, ip, userAgent);
    }).immediate();
  }

  /** Create a full session for a user (shared by login and MFA verify) */
  _createSession(user, ip, userAgent) {
    const db = getDb();
    const token = generateToken(32);
    const tokenHash = sha256(token);
    const expiresAt = new Date(Date.now() + config.session.ttl).toISOString();

    db.prepare('INSERT INTO sessions (token_hash, user_id, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(tokenHash, user.id, ip, userAgent, expiresAt);

    this.logAttempt(ip, user.username, user.id, true, userAgent);
    log.info('Login successful', { username: user.username, ip });

    return {
      token,
      user: {
        id: user.id, username: user.username, displayName: user.display_name, role: user.role,
        mustChangePassword: !!user.must_change_password,
      },
      setupRequired: !this.isSetupComplete(),
    };
  }

  // ─── MFA / TOTP Methods ────────────────────────────────────

  // Call only inside the factor's immediate transaction.
  _mfaAllowed(db, user) {
    if (!user.mfa_locked_until) return true;
    const expired = db.prepare("SELECT julianday(?) <= julianday('now') AS expired").get(user.mfa_locked_until)?.expired;
    if (!expired) return false;
    db.prepare('UPDATE users SET mfa_failed_attempts=0,mfa_locked_until=NULL WHERE id=?').run(user.id);
    return true;
  }

  _mfaFailed(db, user) {
    const until = new Date(Date.now() + config.security.lockoutDurationMs).toISOString();
    db.prepare('UPDATE users SET mfa_failed_attempts=mfa_failed_attempts+1, mfa_locked_until=CASE WHEN mfa_failed_attempts+1>=? THEN ? ELSE mfa_locked_until END WHERE id=?')
      .run(config.security.lockoutAttempts, until, user.id);
    log.warn('MFA verification rejected', { userId: user.id });
  }

  _mfaSucceeded(db, user) {
    db.prepare('UPDATE users SET mfa_failed_attempts=0,mfa_locked_until=NULL WHERE id=?').run(user.id);
  }

  _consumeTotp(db, user, secret, code) {
    const counter = totp.matchTOTPCounter(secret, code);
    if (counter === null) return false;
    return db.prepare('UPDATE users SET totp_last_counter=? WHERE id=? AND (totp_last_counter IS NULL OR totp_last_counter<?)').run(counter, user.id, counter).changes === 1;
  }

  /** Verify MFA token and TOTP code, create full session */
  verifyMfa(mfaToken, code, ip, userAgent) {
    const db = getDb();
    if (typeof mfaToken !== 'string' || !mfaToken) return { error: 'Invalid or expired MFA token' };
    return db.transaction(() => {
      const tokenHash = sha256(mfaToken);

      const row = db.prepare(`
        SELECT * FROM mfa_tokens
        WHERE token_hash = ? AND used = 0 AND attempts < 5 AND julianday(expires_at) > julianday('now')
      `).get(tokenHash);

      if (!row) return { error: 'Invalid or expired MFA token' };

      const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(row.user_id);
      if (!user || !user.totp_enabled) return { error: 'MFA is not enabled' };
      if (!this._mfaAllowed(db, user)) return { error: 'Too many MFA attempts. Try again later.' };
      db.prepare('UPDATE mfa_tokens SET attempts=attempts+1,used=CASE WHEN attempts+1>=5 THEN 1 ELSE used END WHERE id=?').run(row.id);

      // Decrypt TOTP secret and verify code
      let secret;
      try {
        secret = decrypt(user.totp_secret);
      } catch {
        return { error: 'MFA configuration error' };
      }

      if (!this._consumeTotp(db, user, secret, code)) {
        this._mfaFailed(db, user);
        return { error: 'Invalid or already used TOTP code' };
      }
      this._mfaSucceeded(db, user);

      // Mark MFA token as used
      db.prepare('UPDATE mfa_tokens SET used = 1 WHERE id = ?').run(row.id);

      return this._createSession(user, ip, userAgent);
    }).immediate();
  }

  /** Verify MFA using a recovery code */
  verifyMfaRecovery(mfaToken, recoveryCode, ip, userAgent) {
    const db = getDb();
    if (typeof mfaToken !== 'string' || !mfaToken) return { error: 'Invalid or expired MFA token' };
    return db.transaction(() => {
      const tokenHash = sha256(mfaToken);

      const row = db.prepare(`
        SELECT * FROM mfa_tokens
        WHERE token_hash = ? AND used = 0 AND attempts < 5 AND julianday(expires_at) > julianday('now')
      `).get(tokenHash);

      if (!row) return { error: 'Invalid or expired MFA token' };

      const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(row.user_id);
      if (!user || !user.totp_enabled || !user.recovery_codes) return { error: 'No recovery codes available' };
      if (!this._mfaAllowed(db, user)) return { error: 'Too many MFA attempts. Try again later.' };
      db.prepare('UPDATE mfa_tokens SET attempts=attempts+1,used=CASE WHEN attempts+1>=5 THEN 1 ELSE used END WHERE id=?').run(row.id);

      // Decrypt recovery codes and check
      let codes;
      try {
        codes = JSON.parse(decrypt(user.recovery_codes));
      } catch {
        return { error: 'Recovery code configuration error' };
      }

      // v8.7.11 (security fix) — constant-time lookup. The previous
      // `codes.indexOf(normalizedInput)` did short-circuit string equality, so
      // an attacker with a valid mfaToken (e.g. obtained via stolen username
      // +password) could use response timing to determine prefix matches of
      // recovery codes — meaningfully accelerating brute force against the
      // small recovery-code search space. Now we always iterate ALL codes
      // (no early-break) and use crypto.timingSafeEqual per comparison.
      if (typeof recoveryCode !== 'string' || recoveryCode.length > 128) {
        this._mfaFailed(db, user);
        return { error: 'Invalid recovery code' };
      }
      const normalizedInput = recoveryCode.toLowerCase().trim();
      const inputBuf = Buffer.from(normalizedInput, 'utf8');
      let codeIndex = -1;
      for (let i = 0; i < codes.length; i++) {
        const candidateBuf = Buffer.from(String(codes[i]), 'utf8');
        // timingSafeEqual throws on mismatched length; recovery codes are
        // fixed-length so a length-mismatch is structurally impossible for
        // well-formed input — the guard is defensive only.
        if (candidateBuf.length === inputBuf.length
            && crypto.timingSafeEqual(candidateBuf, inputBuf)) {
          codeIndex = i;
          // do NOT break — total time must be independent of match position
        }
      }
      if (codeIndex === -1) {
        this._mfaFailed(db, user);
        return { error: 'Invalid recovery code' };
      }
      this._mfaSucceeded(db, user);

      // Remove used code, re-encrypt and store
      codes.splice(codeIndex, 1);
      db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?')
        .run(encrypt(JSON.stringify(codes)), user.id);

      // Mark MFA token as used
      db.prepare('UPDATE mfa_tokens SET used = 1 WHERE id = ?').run(row.id);

      log.warn('Recovery code used for MFA', { username: user.username, codesRemaining: codes.length });

      return this._createSession(user, ip, userAgent);
    }).immediate();
  }

  /** Setup MFA: generate secret and return otpauth URI */
  mfaSetup(userId) {
    const db = getDb();
    return db.transaction(() => {
      const user = db.prepare('SELECT id, username, totp_enabled FROM users WHERE id = ? AND is_active = 1').get(userId);
      if (!user) return { error: 'User not found' };
      if (user.totp_enabled) return { error: 'Disable existing MFA before enrolling a new authenticator' };
      const secret = totp.generateSecret();
      const otpauthUri = totp.generateOtpauthURI(secret, user.username);
      db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(encrypt(secret), user.id);
      return { secret, otpauthUri };
    }).immediate();
  }

  /** Enable MFA after verifying first code */
  mfaEnable(userId, code) {
    const db = getDb();
    return db.transaction(() => {
      const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(userId);
      if (!user || !user.totp_secret) return { error: 'MFA not set up. Call /mfa/setup first.' };
      if (user.totp_enabled) return { error: 'MFA is already enabled' };
      if (!this._mfaAllowed(db, user)) return { error: 'Too many MFA attempts. Try again later.' };
      let secret;
      try { secret = decrypt(user.totp_secret); }
      catch { return { error: 'MFA configuration error' }; }
      if (!this._consumeTotp(db, user, secret, code)) {
        this._mfaFailed(db, user);
        return { error: 'Invalid or already used TOTP code. Wait for the next authenticator code.' };
      }
      this._mfaSucceeded(db, user);
      const recoveryCodes = totp.generateRecoveryCodes();
      db.prepare('UPDATE users SET totp_enabled = 1, recovery_codes = ?, mfa_enrolled_at = ? WHERE id = ?')
        .run(encrypt(JSON.stringify(recoveryCodes)), now(), user.id);
      log.info('MFA enabled', { username: user.username });
      return { success: true, recoveryCodes };
    }).immediate();
  }

  /** Verify a local TOTP as a fresh step-up factor without creating a session. */
  verifyStepUpMfa(userId, code) {
    const db = getDb();
    return db.transaction(() => {
      const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(Number(userId));
      if (!user || !user.totp_enabled || !user.totp_secret) {
        return { error: 'Local TOTP enrollment is required for privileged step-up' };
      }
      if (!this._mfaAllowed(db, user)) return { error: 'Too many MFA attempts. Try again later.' };
      let secret;
      try { secret = decrypt(user.totp_secret); }
      catch { return { error: 'MFA configuration error' }; }
      if (!this._consumeTotp(db, user, secret, code)) {
        this._mfaFailed(db, user);
        return { error: 'Invalid or already used TOTP code' };
      }
      this._mfaSucceeded(db, user);
      log.info('Privileged step-up MFA verified', { username: user.username });
      return { success: true, verifiedAt: now() };
    }).immediate();
  }

  /** Disable MFA (requires password confirmation) */
  async mfaDisable(userId, password) {
    const db = getDb();
    const user = db.prepare('SELECT id, username, password_hash, auth_version FROM users WHERE id = ? AND is_active = 1').get(userId);
    if (!user) return { error: 'User not found' };

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return { error: 'Invalid password' };

    const changed = db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL, mfa_enrolled_at = NULL WHERE id = ? AND auth_version = ? AND password_hash = ? AND is_active = 1')
      .run(user.id, user.auth_version, user.password_hash);
    if (changed.changes !== 1) return { error: 'Account changed; sign in again before disabling MFA' };

    log.info('MFA disabled', { username: user.username });

    return { success: true };
  }

  /** Clean expired MFA tokens */
  cleanMfaTokens() {
    const db = getDb();
    try {
      db.prepare("DELETE FROM mfa_tokens WHERE COALESCE(julianday(expires_at),0) <= julianday('now') OR used = 1").run();
    } catch { /* table may not exist yet */ }
  }

  /** Validate session token, return user */
  validateSession(token) {
    if (typeof token !== 'string' || !token) return null;
    return this.validateSessionHash(sha256(token));
  }

  // Long-lived transports retain the digest, never the reusable bearer token.
  validateSessionHash(tokenHash) {
    if (typeof tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(tokenHash)) return null;
    const db = getDb();
    const row = db.prepare(`
      SELECT s.*, u.id as uid, u.username, u.display_name, u.role, u.is_active, u.must_change_password,
             u.password_changed_at, u.totp_enabled
      FROM sessions s JOIN users u ON s.user_id = u.id
      WHERE s.token_hash = ? AND s.is_valid = 1 AND julianday(s.expires_at) > julianday('now')
    `).get(tokenHash);

    if (!row || !row.is_active) return null;

    let mustChangePassword = !!row.must_change_password;

    // In strict mode: reject login if password older than passwordMaxAgeDays
    if (config.security.passwordMaxAgeDays > 0 && row.password_changed_at) {
      const ageMs = Date.now() - new Date(row.password_changed_at).getTime();
      const maxAgeMs = config.security.passwordMaxAgeDays * 24 * 3600 * 1000;
      if (ageMs > maxAgeMs) {
        mustChangePassword = true;
      }
    }

    return {
      id: row.uid, username: row.username, displayName: row.display_name, role: row.role,
      mustChangePassword, totpEnabled: !!row.totp_enabled,
    };
  }

  /** Logout - invalidate session */
  logout(token) {
    if (!token) return;
    const db = getDb();
    db.prepare('UPDATE sessions SET is_valid = 0 WHERE token_hash = ?').run(sha256(token));
  }

  /** Check if IP is rate-limited */
  isIpLocked(ip) {
    const db = getDb();
    const windowStart = new Date(Date.now() - config.rateLimit.loginWindowMs).toISOString();
    const count = db.prepare(
      'SELECT COUNT(*) as c FROM login_attempts WHERE ip = ? AND success = 0 AND julianday(attempted_at) > julianday(?)'
    ).get(ip, windowStart).c;
    return count >= config.rateLimit.loginMaxAttempts;
  }

  /** Log login attempt */
  logAttempt(ip, username, userId, success, userAgent) {
    const db = getDb();
    db.prepare('INSERT INTO login_attempts (ip, username, user_id, success, user_agent) VALUES (?, ?, ?, ?, ?)')
      .run(ip, username, userId, success ? 1 : 0, userAgent);
  }

  /** Clean expired sessions */
  cleanSessions() {
    const db = getDb();
    const result = db.prepare("DELETE FROM sessions WHERE COALESCE(julianday(expires_at),0) <= julianday('now') OR is_valid = 0").run();
    if (result.changes > 0) log.debug('Cleaned sessions', { count: result.changes });
  }

  /**
   * Find or create an SSO user. New users get the given role. Existing users
   * keep their current role UNLESS `opts.updateRole` is true — that opt-in
   * (used by the OIDC callback when group→role mapping is configured) lets
   * the IdP own the role, so a demote in Entra/Okta takes effect on the
   * user's next login.
   */
  findOrCreateSsoUser(username, role, email, opts = {}) {
    const db = getDb();
    const resolvedRole = role || 'viewer';
    const identity = opts.identity || { source: 'proxy', issuer: process.env.SSO_IDENTITY_NAMESPACE || 'trusted-proxy', subject: username };
    const { source, issuer, subject } = identity;
    const validText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
    if (!['oidc','proxy'].includes(source) || !validText(issuer,2048) || !validText(subject,255)
      || !validText(username,255) || !['admin','operator','viewer'].includes(resolvedRole)) return null;
    if (source === 'oidc') {
      try { const url = new URL(issuer); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null; } catch { return null; }
    }
    return db.transaction(() => {
      let user = db.prepare('SELECT * FROM users WHERE external_source=? AND external_issuer=? AND external_subject=?').get(source,issuer,subject);
      if (user) {
        if (!user.is_active || user.auth_source !== source) return null;
        if (opts.updateRole && resolvedRole !== user.role) {
          db.prepare('UPDATE users SET role=?,updated_at=? WHERE id=?').run(resolvedRole,now(),user.id);
          require('./audit').log({ userId:user.id, username:user.username, action:'sso_role_updated', targetType:'user', targetId:String(user.id), details:{ source, from:user.role, to:resolvedRole } });
          user = { ...user, role:resolvedRole };
        }
      } else {
        // Names and email addresses are display/contact data, never proof of
        // ownership of another account. Resolve collisions to a separate name.
        let localName = username;
        if (db.prepare('SELECT id FROM users WHERE username=?').get(localName)) {
          localName = username.slice(0,80) + '~' + source + '-' + sha256(JSON.stringify([source,issuer,subject]));
          if (db.prepare('SELECT id FROM users WHERE username=?').get(localName)) return null;
        }
        let contact = (source === 'proxy' || opts.emailVerified === true) && validText(email,254) ? email : null;
        if (contact && db.prepare('SELECT id FROM users WHERE email=?').get(contact)) contact = null;
        const id = Number(db.prepare(`INSERT INTO users(username,display_name,email,password_hash,role,is_active,auth_source,
          external_source,external_issuer,external_subject,must_change_password) VALUES (?,?,?,'EXTERNAL_NO_PASSWORD',?,1,?,?,?,?,0)`)
          .run(localName,username,contact,resolvedRole,source,source,issuer,subject).lastInsertRowid);
        require('./audit').log({ userId:id, username:localName, action:'sso_user_created', targetType:'user', targetId:String(id), details:{ source, role:resolvedRole } });
        user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
      }
      return { id:user.id, username:user.username, display_name:user.display_name, role:user.role, sso:true, mustChangePassword:!!user.must_change_password };
    }).immediate();
  }

  /** Change password */
  async changePassword(userId, currentPassword, newPassword) {
    const db = getDb();
    const user = db.prepare('SELECT password_hash, auth_version, auth_source FROM users WHERE id = ? AND is_active = 1').get(userId);
    if (!user) return { error: 'User not found' };
    if (user.auth_source !== 'local') return { error: 'Only local accounts support password changes' };

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return { error: 'Current password is incorrect' };

    const hash = await bcrypt.hash(newPassword, config.security.bcryptRounds);
    const timestamp = now();
    return db.transaction(() => {
      // A reset/deactivation during bcrypt must invalidate this authorization.
      const changed = db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ?, updated_at = ? WHERE id = ? AND password_hash = ? AND auth_version = ? AND is_active = 1')
        .run(hash, timestamp, timestamp, userId, user.password_hash, user.auth_version);
      if (changed.changes !== 1) return { error: 'Account changed; sign in again before changing your password' };
      db.prepare('UPDATE sessions SET is_valid = 0 WHERE user_id = ?').run(userId);
      db.prepare("UPDATE password_reset_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(userId);
      return { success: true };
    }).immediate();
  }

  // ─── User Management (Admin) ──────────────────────────────

  listUsers() {
    const db = getDb();
    return db.prepare(`
      SELECT id, username, display_name, email, role, is_active, is_locked, auth_source,
             last_login_at, created_at, updated_at, totp_enabled, mfa_enrolled_at
      FROM users ORDER BY username
    `).all();
  }

  getUser(id) {
    const db = getDb();
    return db.prepare(`
      SELECT id, username, display_name, email, role, is_active, is_locked, auth_source,
             last_login_at, created_at, updated_at
      FROM users WHERE id = ?
    `).get(id);
  }

  async createUser({ username, displayName, email, password, role }) {
    const db = getDb();
    const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
    if (existing) return { error: 'Username already exists' };

    const pwErr = this.validatePassword(password);
    if (pwErr) return { error: pwErr };
    const hibpErr = await this.checkHibp(password);
    if (hibpErr) return { error: hibpErr };

    const hash = await bcrypt.hash(password, config.security.bcryptRounds);
    const result = db.prepare(
      'INSERT INTO users (username, display_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
    ).run(username, displayName || username, email, hash, role || 'viewer');
    return { id: result.lastInsertRowid };
  }

  updateUser(id, { displayName, email, role, isActive }) {
    const db = getDb();
    const sets = [];
    const params = [];

    if (displayName !== undefined) { sets.push('display_name = ?'); params.push(displayName); }
    if (email !== undefined) { sets.push('email = ?'); params.push(email); }
    if (role !== undefined) { sets.push('role = ?'); params.push(role); }
    if (isActive !== undefined) { sets.push('is_active = ?'); params.push(isActive ? 1 : 0); }
    sets.push('updated_at = ?'); params.push(now());
    params.push(id);

    db.transaction(() => {
      db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      if (email !== undefined || (isActive !== undefined && !isActive)) {
        db.prepare("UPDATE password_reset_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(id);
      }
    }).immediate();
    return { success: true };
  }

  async resetPassword(id, newPassword) {
    const db = getDb();
    const hash = await bcrypt.hash(newPassword, config.security.bcryptRounds);
    const timestamp = now();
    return db.transaction(() => {
      const user = db.prepare('SELECT auth_source FROM users WHERE id=?').get(id);
      if (!user) return { error: 'User not found' };
      if (user.auth_source !== 'local') return { error: 'Only local accounts support password resets' };
      db.prepare('UPDATE users SET password_hash = ?, failed_attempts = 0, is_locked = 0, locked_until = NULL, password_changed_at = ?, updated_at = ? WHERE id = ?')
        .run(hash, timestamp, timestamp, id);
      db.prepare('UPDATE sessions SET is_valid = 0 WHERE user_id = ?').run(id);
      db.prepare("UPDATE password_reset_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(id);
      return { success: true };
    }).immediate();
  }

  deleteUser(id) {
    const db = getDb();
    // Don't actually delete, just deactivate
    db.transaction(() => {
      db.prepare('UPDATE users SET is_active = 0, updated_at = ? WHERE id = ?').run(now(), id);
      db.prepare('UPDATE sessions SET is_valid = 0 WHERE user_id = ?').run(id);
      db.prepare("UPDATE password_reset_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(id);
    }).immediate();
    return { success: true };
  }
}

module.exports = new AuthService();
