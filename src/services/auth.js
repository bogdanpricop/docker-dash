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
    const db = getDb();

    // Check rate limiting
    if (this.isIpLocked(ip)) {
      this.logAttempt(ip, username, null, false, userAgent);
      return { error: 'Too many attempts. Try again later.', locked: true };
    }

    let user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
    if (!user) {
      // Try LDAP authentication if configured
      const ldapUser = await this._tryLdapLogin(username, password);
      if (ldapUser) {
        // Provision or update local user record for LDAP user
        user = this._provisionLdapUser(db, ldapUser);
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

    const valid = await bcrypt.compare(password, user.password_hash);
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

  /** Verify MFA token and TOTP code, create full session */
  verifyMfa(mfaToken, code, ip, userAgent) {
    const db = getDb();
    const tokenHash = sha256(mfaToken);

    const row = db.prepare(`
      SELECT * FROM mfa_tokens
      WHERE token_hash = ? AND used = 0 AND expires_at > datetime('now')
    `).get(tokenHash);

    if (!row) return { error: 'Invalid or expired MFA token' };

    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(row.user_id);
    if (!user) return { error: 'User not found' };

    // Decrypt TOTP secret and verify code
    let secret;
    try {
      secret = decrypt(user.totp_secret);
    } catch {
      return { error: 'MFA configuration error' };
    }

    if (!totp.verifyTOTP(secret, code)) {
      return { error: 'Invalid TOTP code' };
    }

    // Mark MFA token as used
    db.prepare('UPDATE mfa_tokens SET used = 1 WHERE id = ?').run(row.id);

    return this._createSession(user, ip, userAgent);
  }

  /** Verify MFA using a recovery code */
  verifyMfaRecovery(mfaToken, recoveryCode, ip, userAgent) {
    const db = getDb();
    const tokenHash = sha256(mfaToken);

    const row = db.prepare(`
      SELECT * FROM mfa_tokens
      WHERE token_hash = ? AND used = 0 AND expires_at > datetime('now')
    `).get(tokenHash);

    if (!row) return { error: 'Invalid or expired MFA token' };

    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(row.user_id);
    if (!user || !user.recovery_codes) return { error: 'No recovery codes available' };

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
    if (codeIndex === -1) return { error: 'Invalid recovery code' };

    // Remove used code, re-encrypt and store
    codes.splice(codeIndex, 1);
    db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?')
      .run(encrypt(JSON.stringify(codes)), user.id);

    // Mark MFA token as used
    db.prepare('UPDATE mfa_tokens SET used = 1 WHERE id = ?').run(row.id);

    log.warn('Recovery code used for MFA', { username: user.username, codesRemaining: codes.length });

    return this._createSession(user, ip, userAgent);
  }

  /** Setup MFA: generate secret and return otpauth URI */
  mfaSetup(userId) {
    const db = getDb();
    const user = db.prepare('SELECT id, username, totp_enabled FROM users WHERE id = ?').get(userId);
    if (!user) return { error: 'User not found' };

    const secret = totp.generateSecret();
    const otpauthUri = totp.generateOtpauthURI(secret, user.username);

    // Store encrypted secret (not yet enabled)
    db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?')
      .run(encrypt(secret), user.id);

    return { secret, otpauthUri };
  }

  /** Enable MFA after verifying first code */
  mfaEnable(userId, code) {
    const db = getDb();
    const user = db.prepare('SELECT id, username, totp_secret FROM users WHERE id = ?').get(userId);
    if (!user || !user.totp_secret) return { error: 'MFA not set up. Call /mfa/setup first.' };

    let secret;
    try {
      secret = decrypt(user.totp_secret);
    } catch {
      return { error: 'MFA configuration error' };
    }

    if (!totp.verifyTOTP(secret, code)) {
      return { error: 'Invalid TOTP code. Make sure your authenticator app is synced.' };
    }

    // Generate recovery codes
    const recoveryCodes = totp.generateRecoveryCodes();

    db.prepare('UPDATE users SET totp_enabled = 1, recovery_codes = ?, mfa_enrolled_at = ? WHERE id = ?')
      .run(encrypt(JSON.stringify(recoveryCodes)), now(), user.id);

    log.info('MFA enabled', { username: user.username });

    return { success: true, recoveryCodes };
  }

  /** Disable MFA (requires password confirmation) */
  async mfaDisable(userId, password) {
    const db = getDb();
    const user = db.prepare('SELECT id, username, password_hash FROM users WHERE id = ?').get(userId);
    if (!user) return { error: 'User not found' };

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return { error: 'Invalid password' };

    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL, mfa_enrolled_at = NULL WHERE id = ?')
      .run(user.id);

    log.info('MFA disabled', { username: user.username });

    return { success: true };
  }

  /** Clean expired MFA tokens */
  cleanMfaTokens() {
    const db = getDb();
    try {
      db.prepare("DELETE FROM mfa_tokens WHERE expires_at < datetime('now') OR used = 1").run();
    } catch { /* table may not exist yet */ }
  }

  /** Validate session token, return user */
  validateSession(token) {
    if (!token) return null;
    const db = getDb();
    const tokenHash = sha256(token);
    const row = db.prepare(`
      SELECT s.*, u.id as uid, u.username, u.display_name, u.role, u.is_active, u.must_change_password,
             u.password_changed_at, u.totp_enabled
      FROM sessions s JOIN users u ON s.user_id = u.id
      WHERE s.token_hash = ? AND s.is_valid = 1 AND s.expires_at > datetime('now')
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
      'SELECT COUNT(*) as c FROM login_attempts WHERE ip = ? AND success = 0 AND attempted_at > ?'
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
    const result = db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now') OR is_valid = 0").run();
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
    let user = db.prepare('SELECT id, username, role, is_active FROM users WHERE username = ?').get(username);
    if (user) {
      if (!user.is_active) return null;
      if (opts.updateRole && resolvedRole && resolvedRole !== user.role) {
        db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(resolvedRole, now(), user.id);
        log.info('SSO user role updated from IdP', { username, from: user.role, to: resolvedRole });
        user = { ...user, role: resolvedRole };
      }
      return { id: user.id, username: user.username, role: user.role, sso: true };
    }
    // Auto-create SSO user (no password — SSO-only)
    const r = db.prepare(
      'INSERT INTO users (username, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, 1)'
    ).run(username, email || null, 'SSO_NO_PASSWORD', resolvedRole);
    log.info('SSO user created', { username, role: resolvedRole });
    return { id: Number(r.lastInsertRowid), username, role: resolvedRole, sso: true };
  }

  /** Change password */
  async changePassword(userId, currentPassword, newPassword) {
    const db = getDb();
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
    if (!user) return { error: 'User not found' };

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return { error: 'Current password is incorrect' };

    const hash = await bcrypt.hash(newPassword, config.security.bcryptRounds);
    const timestamp = now();
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ?, updated_at = ? WHERE id = ?').run(hash, timestamp, timestamp, userId);

    // Invalidate all sessions (user must re-login with new password)
    db.prepare('UPDATE sessions SET is_valid = 0 WHERE user_id = ?').run(userId);
    return { success: true };
  }

  // ─── User Management (Admin) ──────────────────────────────

  listUsers() {
    const db = getDb();
    return db.prepare(`
      SELECT id, username, display_name, email, role, is_active, is_locked,
             last_login_at, created_at, updated_at, totp_enabled, mfa_enrolled_at
      FROM users ORDER BY username
    `).all();
  }

  getUser(id) {
    const db = getDb();
    return db.prepare(`
      SELECT id, username, display_name, email, role, is_active, is_locked,
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

    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return { success: true };
  }

  async resetPassword(id, newPassword) {
    const db = getDb();
    const hash = await bcrypt.hash(newPassword, config.security.bcryptRounds);
    const timestamp = now();
    db.prepare('UPDATE users SET password_hash = ?, failed_attempts = 0, is_locked = 0, locked_until = NULL, password_changed_at = ?, updated_at = ? WHERE id = ?')
      .run(hash, timestamp, timestamp, id);
    db.prepare('UPDATE sessions SET is_valid = 0 WHERE user_id = ?').run(id);
    return { success: true };
  }

  deleteUser(id) {
    const db = getDb();
    // Don't actually delete, just deactivate
    db.prepare('UPDATE users SET is_active = 0, updated_at = ? WHERE id = ?').run(now(), id);
    db.prepare('UPDATE sessions SET is_valid = 0 WHERE user_id = ?').run(id);
    return { success: true };
  }
}

module.exports = new AuthService();
