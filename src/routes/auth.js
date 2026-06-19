'use strict';

const { Router } = require('express');
const authService = require('../services/auth');
const auditService = require('../services/audit');
const emailService = require('../services/email');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const config = require('../config');
const { getClientIp } = require('../utils/helpers');
const { getDb } = require('../db');
const { generateToken, sha256 } = require('../utils/crypto');
const bcrypt = require('bcrypt');
const log = require('../utils/logger')('auth');

const router = Router();

// Login
router.post('/login',
  rateLimit(config.rateLimit.loginMaxAttempts, config.rateLimit.loginWindowMs),
  async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

      const ip = getClientIp(req);
      const ua = req.headers['user-agent'];
      const result = await authService.login(username, password, ip, ua);

      if (result.error) {
        return res.status(result.locked ? 429 : 401).json({ error: result.error });
      }

      // MFA check: if user has TOTP enabled, return mfaRequired instead of session
      // IMPORTANT: do NOT set session cookie here — MFA is not yet verified
      if (result.mfaRequired) {
        auditService.log({ userId: result.user.id, username, action: 'login_mfa_pending', ip, userAgent: ua });
        return res.json({
          mfaRequired: true,
          mfaToken: result.mfaToken,
        });
      }

      // MFA not required — set session cookie and respond
      const isHttps = config.security.isStrict || config.session.secureCookie || req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.cookie(config.session.cookieName, result.token, {
        httpOnly: true,
        secure: isHttps,
        sameSite: config.security.isStrict ? 'strict' : (isHttps ? 'strict' : 'lax'),
        maxAge: config.session.ttl,
        path: '/',
      });

      auditService.log({ userId: result.user.id, username, action: 'login', ip, userAgent: ua });

      const response = {
        user: result.user,
        setupRequired: result.setupRequired,
        mustChangePassword: result.user.mustChangePassword,
        defaultAdminActive: authService.hasDefaultAdminActive(),
      };

      // In strict security mode, do NOT include token in body (cookie-only)
      if (!config.security.disableTokenInBody) {
        response.token = result.token;
      }

      res.json(response);
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── MFA Endpoints ──────────────────────────────────────────

// Verify TOTP code during login
router.post('/mfa/verify',
  rateLimit(config.rateLimit.loginMaxAttempts, config.rateLimit.loginWindowMs),
  (req, res) => {
    try {
      const { mfaToken, code } = req.body;
      if (!mfaToken || !code) return res.status(400).json({ error: 'MFA token and code required' });

      const ip = getClientIp(req);
      const ua = req.headers['user-agent'];
      const result = authService.verifyMfa(mfaToken, code, ip, ua);

      if (result.error) return res.status(401).json({ error: result.error });

      // Set cookie
      const isHttps = config.security.isStrict || config.session.secureCookie || req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.cookie(config.session.cookieName, result.token, {
        httpOnly: true,
        secure: isHttps,
        sameSite: config.security.isStrict ? 'strict' : (isHttps ? 'strict' : 'lax'),
        maxAge: config.session.ttl,
        path: '/',
      });

      auditService.log({ userId: result.user.id, username: result.user.username, action: 'mfa_verify', ip, userAgent: ua });

      const response = {
        user: result.user,
        setupRequired: result.setupRequired,
        mustChangePassword: result.user.mustChangePassword,
        defaultAdminActive: authService.hasDefaultAdminActive(),
      };

      if (!config.security.disableTokenInBody) {
        response.token = result.token;
      }

      res.json(response);
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Verify recovery code during login
router.post('/mfa/recovery',
  rateLimit(config.rateLimit.loginMaxAttempts, config.rateLimit.loginWindowMs),
  (req, res) => {
    try {
      const { mfaToken, recoveryCode } = req.body;
      if (!mfaToken || !recoveryCode) return res.status(400).json({ error: 'MFA token and recovery code required' });

      const ip = getClientIp(req);
      const ua = req.headers['user-agent'];
      const result = authService.verifyMfaRecovery(mfaToken, recoveryCode, ip, ua);

      if (result.error) return res.status(401).json({ error: result.error });

      const isHttps = config.security.isStrict || config.session.secureCookie || req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.cookie(config.session.cookieName, result.token, {
        httpOnly: true,
        secure: isHttps,
        sameSite: config.security.isStrict ? 'strict' : (isHttps ? 'strict' : 'lax'),
        maxAge: config.session.ttl,
        path: '/',
      });

      auditService.log({ userId: result.user.id, username: result.user.username, action: 'mfa_recovery', ip, userAgent: ua,
        details: { method: 'recovery_code' } });

      const response = {
        user: result.user,
        setupRequired: result.setupRequired,
        mustChangePassword: result.user.mustChangePassword,
        defaultAdminActive: authService.hasDefaultAdminActive(),
      };

      if (!config.security.disableTokenInBody) {
        response.token = result.token;
      }

      res.json(response);
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Setup MFA (generate secret, return otpauth URI)
router.post('/mfa/setup', requireAuth, (req, res) => {
  try {
    const result = authService.mfaSetup(req.user.id);
    if (result.error) return res.status(400).json({ error: result.error });
    auditService.log({ userId: req.user.id, username: req.user.username, action: 'mfa_setup', ip: getClientIp(req) });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Enable MFA (verify first code)
router.post('/mfa/enable', requireAuth, (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'TOTP code required' });

    const result = authService.mfaEnable(req.user.id, code);
    if (result.error) return res.status(400).json({ error: result.error });

    auditService.log({ userId: req.user.id, username: req.user.username, action: 'mfa_enable', ip: getClientIp(req) });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Disable MFA (requires password confirmation)
router.post('/mfa/disable', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required to disable MFA' });

    const result = await authService.mfaDisable(req.user.id, password);
    if (result.error) return res.status(400).json({ error: result.error });

    auditService.log({ userId: req.user.id, username: req.user.username, action: 'mfa_disable', ip: getClientIp(req) });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: force-disable MFA for any user
router.delete('/users/:id/mfa', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const db = getDb();
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: 'User not found' });

    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL, mfa_enrolled_at = NULL WHERE id = ?')
      .run(user.id);

    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'mfa_disable_admin', targetType: 'user', targetId: String(user.id),
      details: { targetUsername: user.username }, ip: getClientIp(req) });

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
});

// Logout
router.post('/logout', requireAuth, (req, res) => {
  authService.logout(req.authToken);
  res.clearCookie(config.session.cookieName);
  auditService.log({ userId: req.user.id, username: req.user.username, action: 'logout', ip: getClientIp(req) });
  res.json({ ok: true });
});

// Current user
router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: req.user,
    setupRequired: !authService.isSetupComplete(),
    mustChangePassword: req.user.mustChangePassword,
    defaultAdminActive: authService.hasDefaultAdminActive(),
    mfaEnabled: !!req.user.totpEnabled,
  });
});

// Change password
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
    const pwErr = authService.validatePassword(newPassword);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const result = await authService.changePassword(req.user.id, currentPassword, newPassword);
    if (result.error) return res.status(400).json({ error: result.error });

    auditService.log({ userId: req.user.id, username: req.user.username, action: 'change_password', ip: getClientIp(req) });
    res.json({ ok: true, message: 'Password changed. Please log in again.' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Complete initial setup
router.post('/complete-setup', requireAuth, requireRole('admin'), (req, res) => {
  authService.completeSetup();
  auditService.log({ userId: req.user.id, username: req.user.username, action: 'complete_setup', ip: getClientIp(req) });
  res.json({ ok: true });
});

// Security status
router.get('/security-status', requireAuth, (req, res) => {
  res.json({
    setupComplete: authService.isSetupComplete(),
    defaultAdminActive: authService.hasDefaultAdminActive(),
    mustChangePassword: req.user.mustChangePassword,
  });
});

// ─── User Management (Admin only) ──────────────────────────

router.get('/users', requireAuth, requireRole('admin'), (req, res) => {
  res.json(authService.listUsers());
});

router.get('/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  const user = authService.getUser(parseInt(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

router.post('/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const result = await authService.createUser(req.body);
    if (result.error) return res.status(400).json({ error: result.error });
    auditService.log({ userId: req.user.id, username: req.user.username, action: 'create_user',
      targetType: 'user', targetId: String(result.id), details: { username: req.body.username }, ip: getClientIp(req) });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const id = parseInt(req.params.id);
    authService.updateUser(id, req.body);
    auditService.log({ userId: req.user.id, username: req.user.username, action: 'update_user',
      targetType: 'user', targetId: String(id), ip: getClientIp(req) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/users/:id/reset-password', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { password } = req.body;
    const pwErr = authService.validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    await authService.resetPassword(parseInt(req.params.id), password);
    auditService.log({ userId: req.user.id, username: req.user.username, action: 'reset_password',
      targetType: 'user', targetId: req.params.id, ip: getClientIp(req) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
    authService.deleteUser(id);
    auditService.log({ userId: req.user.id, username: req.user.username, action: 'delete_user',
      targetType: 'user', targetId: String(id), ip: getClientIp(req) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Email: Send Password Reset ──────────────────────────
router.post('/users/:id/send-reset', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const db = getDb();
    const user = authService.getUser(parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.email) return res.status(400).json({ error: 'User has no email address' });

    // Generate token (15 min expiry)
    const token = generateToken(32);
    const tokenHash = sha256(token);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // Invalidate old tokens
    db.prepare('UPDATE password_reset_tokens SET used_at = datetime(\'now\') WHERE user_id = ? AND used_at IS NULL').run(user.id);

    db.prepare('INSERT INTO password_reset_tokens (user_id, token_hash, type, expires_at) VALUES (?, ?, ?, ?)')
      .run(user.id, tokenHash, 'reset', expiresAt);

    const lang = req.body.lang || 'en';
    const baseUrl = req.body.origin || config.app.publicUrl || config.app.baseUrl;
    const resetUrl = `${baseUrl}/reset-password.html?token=${token}`;

    await emailService.sendPasswordReset({
      to: user.email,
      username: user.username,
      resetUrl,
      lang,
    });

    auditService.log({ userId: req.user.id, username: req.user.username, action: 'send_password_reset',
      targetType: 'user', targetId: String(user.id), ip: getClientIp(req) });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Email: Send Invitation ──────────────────────────
router.post('/users/:id/send-invite', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const db = getDb();
    const user = authService.getUser(parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.email) return res.status(400).json({ error: 'User has no email address' });

    // Generate token (24h expiry)
    const token = generateToken(32);
    const tokenHash = sha256(token);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // Invalidate old tokens
    db.prepare('UPDATE password_reset_tokens SET used_at = datetime(\'now\') WHERE user_id = ? AND used_at IS NULL').run(user.id);

    db.prepare('INSERT INTO password_reset_tokens (user_id, token_hash, type, expires_at) VALUES (?, ?, ?, ?)')
      .run(user.id, tokenHash, 'invite', expiresAt);

    const lang = req.body.lang || 'en';
    const baseUrl = req.body.origin || config.app.publicUrl || config.app.baseUrl;
    const inviteUrl = `${baseUrl}/reset-password.html?token=${token}&invite=1`;

    await emailService.sendInvitation({
      to: user.email,
      username: user.username,
      inviteUrl,
      invitedBy: req.user.username,
      lang,
    });

    auditService.log({ userId: req.user.id, username: req.user.username, action: 'send_invitation',
      targetType: 'user', targetId: String(user.id), ip: getClientIp(req) });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Public: Request Password Reset (self-service) ──────────
// Rate-limited. Always returns generic 200 to prevent user enumeration.
router.post('/request-password-reset',
  rateLimit(5, 15 * 60 * 1000),
  async (req, res) => {
    const GENERIC_OK = { ok: true, message: 'If an account exists with that email, a reset link has been sent.' };
    try {
      const { email, origin, lang = 'en' } = req.body;
      if (!email || typeof email !== 'string') {
        // Still return generic 200 — don't leak validation info
        return res.json(GENERIC_OK);
      }

      const db = getDb();
      const user = db.prepare('SELECT id, username, email FROM users WHERE LOWER(email) = LOWER(?) AND is_active = 1')
        .get(email.trim());

      if (!user) {
        // No account found — respond generically (no enumeration)
        return res.json(GENERIC_OK);
      }

      // Generate a 32-byte random token; store the SHA-256 hash
      const token = generateToken(32);
      const tokenHash = sha256(token);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

      // Invalidate any existing unused tokens for this user
      db.prepare("UPDATE password_reset_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL")
        .run(user.id);

      db.prepare('INSERT INTO password_reset_tokens (user_id, token_hash, type, expires_at) VALUES (?, ?, ?, ?)')
        .run(user.id, tokenHash, 'reset', expiresAt);

      const baseUrl = (origin || config.app.publicUrl || config.app.baseUrl || '').replace(/\/$/, '');
      const resetUrl = `${baseUrl}/reset-password.html?token=${token}`;

      // Attempt to send email; fall back to stderr log if unconfigured
      try {
        if (config.smtp && config.smtp.host) {
          await emailService.sendPasswordReset({ to: user.email, username: user.username, resetUrl, lang });
        } else {
          console.warn(`[auth] No SMTP configured — password reset URL for ${user.username}: ${resetUrl}`);
        }
      } catch (emailErr) {
        // Log the error but do NOT reveal it to the caller
        log.error('Password reset email failed', { userId: user.id, error: emailErr.message });
        console.warn(`[auth] Email send failed — password reset URL for ${user.username}: ${resetUrl}`);
      }

      auditService.log({
        userId: user.id, username: user.username,
        action: 'password_reset_requested',
        ip: getClientIp(req),
      });

      res.json(GENERIC_OK);
    } catch (err) {
      log.error('request-password-reset', err);
      // Always return generic 200 — never expose internals
      res.json(GENERIC_OK);
    }
  }
);

// ─── Public: Validate Reset Token ──────────────────────────
router.post('/validate-reset-token',
  rateLimit(config.rateLimit.loginMaxAttempts, config.rateLimit.loginWindowMs),
  async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const db = getDb();
    const tokenHash = sha256(token);
    const row = db.prepare(`
      SELECT rt.*, u.username FROM password_reset_tokens rt
      JOIN users u ON rt.user_id = u.id
      WHERE rt.token_hash = ? AND rt.used_at IS NULL AND rt.expires_at > datetime('now')
    `).get(tokenHash);

    if (!row) return res.status(400).json({ error: 'Invalid or expired token', valid: false });

    res.json({ valid: true, username: row.username, type: row.type });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Public: Reset Password with Token ──────────────────────
router.post('/reset-password-token',
  rateLimit(config.rateLimit.loginMaxAttempts, config.rateLimit.loginWindowMs),
  async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: 'Token and password required' });
    const pwErr = authService.validatePassword(newPassword);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const db = getDb();
    const tokenHash = sha256(token);
    const row = db.prepare(`
      SELECT rt.*, u.id as uid, u.username FROM password_reset_tokens rt
      JOIN users u ON rt.user_id = u.id
      WHERE rt.token_hash = ? AND rt.used_at IS NULL AND rt.expires_at > datetime('now')
    `).get(tokenHash);

    if (!row) return res.status(400).json({ error: 'Invalid or expired token' });

    // Set new password
    const hash = await bcrypt.hash(newPassword, config.security.bcryptRounds);
    db.prepare('UPDATE users SET password_hash = ?, password_changed_at = datetime(\'now\'), failed_attempts = 0, is_locked = 0, locked_until = NULL, updated_at = datetime(\'now\') WHERE id = ?')
      .run(hash, row.uid);

    // Mark token as used
    db.prepare('UPDATE password_reset_tokens SET used_at = datetime(\'now\') WHERE id = ?').run(row.id);

    // Invalidate existing sessions
    db.prepare('UPDATE sessions SET is_valid = 0 WHERE user_id = ?').run(row.uid);

    auditService.log({ userId: row.uid, username: row.username, action: 'password_reset_via_token' });

    res.json({ ok: true, username: row.username });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── OIDC / OAuth Flow ────────────────────────────────────

const https = require('https');
const crypto = require('crypto');

/** Fetch JSON from a URL (for OIDC discovery, token exchange, userinfo) */
function _oidcFetch(url, options = {}) {
  // FIX #11: Only allow HTTPS for OIDC endpoints
  if (!url.startsWith('https://')) {
    return Promise.reject(new Error(`OIDC fetch rejected: only HTTPS URLs are allowed (got: ${url})`));
  }
  return new Promise((resolve, reject) => {
    const mod = https;
    const urlObj = new URL(url);
    const reqOpts = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: { 'Accept': 'application/json', ...(options.headers || {}) },
      timeout: 10000,
    };
    const req = mod.request(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OIDC request timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ─── OIDC JWT Signature Verification (FIX #11) ──────────────────────────────

/** JWKS cache: { jwks, fetchedAt } per issuer */
const _jwksCache = new Map();
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Fetch JWKS from issuer and cache for 1 hour */
// v8.7.9 — Discovery cache (was missing; live-fetched on every login).
const _discoCache = new Map();
const DISCO_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// v8.7.9 — Force-refresh throttle for JWKS rotation handling. Prevents an
// attacker from DoS-ing the IdP by sending tokens with random kids.
const _jwksLastForcedRefresh = new Map();
const JWKS_FORCE_REFRESH_COOLDOWN_MS = 60 * 1000; // 1 minute per issuer

// v8.7.9 — Injectable fetcher so the cache layer is unit-testable without
// touching the network. Production uses _oidcFetch; tests assign a stub.
let _oidcFetchOverride = null;
function __fetch(url, opts) {
  return (_oidcFetchOverride || _oidcFetch)(url, opts);
}

async function _getDiscovery(issuer, { force = false } = {}) {
  if (!force) {
    const cached = _discoCache.get(issuer);
    if (cached && (Date.now() - cached.fetchedAt) < DISCO_CACHE_TTL_MS) return cached.body;
  }
  const res = await __fetch(`${issuer}/.well-known/openid-configuration`);
  if (!res.body) throw new Error('OIDC discovery returned no body');
  _discoCache.set(issuer, { body: res.body, fetchedAt: Date.now() });
  return res.body;
}

async function _getJwks(issuer, { force = false } = {}) {
  if (!force) {
    const cached = _jwksCache.get(issuer);
    if (cached && (Date.now() - cached.fetchedAt) < JWKS_CACHE_TTL_MS) return cached.jwks;
  } else {
    // Throttle force-refreshes (DoS protection: attacker-controlled tokens
    // with random kids must NOT be able to hammer the IdP). During cooldown
    // we return the stale cache; the caller's kid-find then fails and the
    // verify throws, without touching the network.
    const lastForced = _jwksLastForcedRefresh.get(issuer) || 0;
    if (Date.now() - lastForced < JWKS_FORCE_REFRESH_COOLDOWN_MS) {
      const cached = _jwksCache.get(issuer);
      if (cached) return cached.jwks;
    }
    _jwksLastForcedRefresh.set(issuer, Date.now());
  }
  const disco = await _getDiscovery(issuer);
  if (!disco.jwks_uri) throw new Error('OIDC discovery missing jwks_uri');
  const jwksRes = await __fetch(disco.jwks_uri);
  if (!jwksRes.body?.keys) throw new Error('Invalid JWKS response');
  _jwksCache.set(issuer, { jwks: jwksRes.body.keys, fetchedAt: Date.now() });
  return jwksRes.body.keys;
}

/**
 * Verify an OIDC ID token (RS256 only) against the issuer's JWKS.
 * Checks: signature, exp, nbf, iss, aud.
 * Returns the verified payload or throws with a descriptive message.
 */
async function _verifyIdToken(idToken, issuer, clientId) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT: expected 3 parts');

  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Malformed JWT: failed to parse header/payload');
  }

  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported JWT algorithm: ${header.alg} (only RS256 is supported)`);
  }

  // Find the matching JWK by kid. v8.7.9: on miss, force-refresh ONCE
  // (event-based cache invalidation for IdP key rotation). The cooldown in
  // _getJwks prevents attacker-driven DoS via tokens with random kids.
  //
  // The single-key fallback applies ONLY when the token itself has no kid
  // (rare, but valid OIDC) — NOT as a generic "if there's only one cached
  // key, use it regardless of kid mismatch", which would mask key-rotation
  // by silently picking the stale single cached key.
  let jwks = await _getJwks(issuer);
  let jwk = jwks.find(k => k.kid === header.kid);
  if (!jwk && !header.kid && jwks.length === 1) jwk = jwks[0];
  if (!jwk) {
    jwks = await _getJwks(issuer, { force: true });
    jwk = jwks.find(k => k.kid === header.kid);
    if (!jwk && !header.kid && jwks.length === 1) jwk = jwks[0];
    if (!jwk) throw new Error(`JWT verification failed: no matching JWK for kid=${header.kid} (refresh attempted)`);
    log.info('OIDC JWKS force-refresh succeeded (likely IdP key rotation)', { issuer, kid: header.kid });
  }
  if (jwk.kty !== 'RSA') throw new Error(`Unsupported JWK key type: ${jwk.kty}`);

  // Build public key from JWK
  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch (err) {
    throw new Error(`Failed to import JWK public key: ${err.message}`);
  }

  // Verify signature: RS256 = RSASSA-PKCS1-v1_5 + SHA256
  const signedPart = `${parts[0]}.${parts[1]}`;
  const signature = Buffer.from(parts[2], 'base64url');
  const valid = crypto.verify('SHA256', Buffer.from(signedPart), publicKey, signature);
  if (!valid) throw new Error('JWT signature verification failed');

  // Verify claims
  const now = Math.floor(Date.now() / 1000);

  if (payload.exp === undefined || now >= payload.exp) {
    throw new Error(`JWT expired at ${payload.exp}, now=${now}`);
  }

  if (payload.nbf !== undefined && now < payload.nbf) {
    throw new Error(`JWT not yet valid (nbf=${payload.nbf}, now=${now})`);
  }

  if (payload.iss !== issuer) {
    throw new Error(`JWT issuer mismatch: expected "${issuer}", got "${payload.iss}"`);
  }

  const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audList.includes(clientId)) {
    throw new Error(`JWT audience mismatch: "${clientId}" not in [${audList.join(', ')}]`);
  }

  return payload;
}

/**
 * v8.7.6 — Resolve a docker-dash role from OIDC ID-token claims using the
 * group-mapping config. Returns 'admin' / 'operator' / 'viewer' (highest
 * privilege wins when a user is in groups for multiple roles), or `null` if
 * no group lists are configured OR the user is in none of them. Pure
 * function — fully unit-testable.
 */
function _resolveRoleFromGroups(claims, oidcCfg) {
  if (!oidcCfg) return null;
  const hasAnyList = (oidcCfg.adminGroups?.length || 0)
    + (oidcCfg.operatorGroups?.length || 0)
    + (oidcCfg.viewerGroups?.length || 0) > 0;
  if (!hasAnyList) return null; // group mapping disabled — caller falls back

  const claimName = oidcCfg.groupClaim || 'groups';
  let raw = claims && claims[claimName];
  if (raw == null) raw = [];
  if (!Array.isArray(raw)) raw = [String(raw)];
  const userGroups = new Set(raw.map(g => String(g).toLowerCase()));

  const has = (list) => (list || []).some(g => userGroups.has(String(g).toLowerCase()));
  if (has(oidcCfg.adminGroups)) return 'admin';
  if (has(oidcCfg.operatorGroups)) return 'operator';
  if (has(oidcCfg.viewerGroups)) return 'viewer';
  return null; // configured but no match → caller can fall back to defaultRole
}

/**
 * v8.7.8 (security fix) — Did the IdP actually emit a groups claim we can act
 * on? Returns true ONLY when the claim is present AND non-empty AND not the
 * Entra-style "groups overage" indicator (which means the user has >200
 * groups and we'd need a Microsoft Graph API call we don't make).
 *
 * Used by the OIDC callback to gate `updateRole`. WITHOUT this guard, a
 * transient claim absence (Entra overage, app-registration regression,
 * id_token verification fallthrough to userinfo, scope strip by a broker)
 * was silently demoting an existing admin to viewer on their next login
 * because the resolver returned null and the caller fell back to
 * OIDC_DEFAULT_ROLE. The absence of evidence must NOT be treated as
 * evidence of demotion.
 */
function _hasUsableGroupsClaim(claims, oidcCfg) {
  if (!claims || !oidcCfg) return false;
  const claimName = oidcCfg.groupClaim || 'groups';

  // Entra "groups overage": claim itself is missing; instead the token has
  // `_claim_names: { groups: "src1" }` + `_claim_sources: { src1: { endpoint: <graph URL> } }`.
  // Treat as no-usable-claim so we don't demote on every login.
  if (claims._claim_names && claims._claim_names[claimName]) return false;

  const raw = claims[claimName];
  if (Array.isArray(raw)) return raw.length > 0;
  if (typeof raw === 'string') return raw.length > 0;
  return false;
}

// OIDC: Check if enabled
router.get('/oidc/enabled', (req, res) => {
  res.json({ enabled: config.oidc?.enabled || false });
});

// OIDC: Initiate login — redirect to provider
router.get('/oidc/login', async (req, res) => {
  try {
    if (!config.oidc?.enabled) return res.status(400).json({ error: 'OIDC is not enabled' });

    const issuer = config.oidc.issuerUrl.replace(/\/$/, '');
    const disco = await _getDiscovery(issuer); // v8.7.9 — cached
    if (!disco.authorization_endpoint) {
      return res.status(500).json({ error: 'Failed to discover OIDC endpoints' });
    }

    // Generate state parameter for CSRF protection
    const state = crypto.randomBytes(16).toString('hex');

    // Store state in a short-lived DB entry (5 min TTL)
    const db = getDb();
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS oidc_states (
        state TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      )`);
    } catch { /* table may already exist */ }
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    db.prepare('INSERT OR REPLACE INTO oidc_states (state, expires_at) VALUES (?, ?)').run(state, expiresAt);

    const redirectUri = config.oidc.redirectUri || `${config.app.publicUrl || config.app.baseUrl}/api/auth/oidc/callback`;
    // If group-mapping is configured, ask the IdP to emit the groups claim
    // (Entra ID honors this when "groupMembershipClaims" is set on the app
    // registration; other IdPs respect the openid-scope contract).
    const groupMappingOn = (config.oidc.adminGroups?.length || 0)
      + (config.oidc.operatorGroups?.length || 0)
      + (config.oidc.viewerGroups?.length || 0) > 0;
    const scope = groupMappingOn ? 'openid profile email groups' : 'openid profile email';
    const params = new URLSearchParams({
      client_id: config.oidc.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope,
      state,
    });

    const authUrl = `${disco.authorization_endpoint}?${params.toString()}`;
    res.json({ url: authUrl });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// OIDC: Callback — exchange code for tokens
router.get('/oidc/callback', async (req, res) => {
  try {
    if (!config.oidc?.enabled) return res.status(400).send('OIDC is not enabled');

    const { code, state, error: authError } = req.query;
    if (authError) return res.status(400).send(`OIDC error: ${authError}`);
    if (!code || !state) return res.status(400).send('Missing code or state parameter');

    // Validate state
    const db = getDb();
    const stateRow = db.prepare("SELECT * FROM oidc_states WHERE state = ? AND expires_at > datetime('now')").get(state);
    if (!stateRow) return res.status(400).send('Invalid or expired state parameter');
    db.prepare('DELETE FROM oidc_states WHERE state = ?').run(state);

    // Discover endpoints
    const issuer = config.oidc.issuerUrl.replace(/\/$/, '');
    const disco = await _getDiscovery(issuer); // v8.7.9 — cached
    if (!disco.token_endpoint) return res.status(500).send('OIDC discovery failed');

    const redirectUri = config.oidc.redirectUri || `${config.app.publicUrl || config.app.baseUrl}/api/auth/oidc/callback`;

    // Exchange code for tokens
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.oidc.clientId,
      client_secret: config.oidc.clientSecret,
      code,
      redirect_uri: redirectUri,
    }).toString();

    const tokenRes = await _oidcFetch(disco.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    });

    if (tokenRes.status !== 200 || !tokenRes.body?.access_token) {
      return res.status(401).send('Token exchange failed: ' + (tokenRes.body?.error_description || tokenRes.body?.error || 'unknown'));
    }

    // Extract user info — try id_token first (with signature verification), then userinfo endpoint
    let userInfo = null;
    if (tokenRes.body.id_token) {
      try {
        userInfo = await _verifyIdToken(tokenRes.body.id_token, issuer, config.oidc.clientId);
      } catch (err) {
        log.warn('OIDC id_token verification failed', { error: err.message });
        // Fall through to userinfo endpoint
      }
    }

    if ((!userInfo || !userInfo.email) && disco.userinfo_endpoint) {
      const uiRes = await _oidcFetch(disco.userinfo_endpoint, {
        headers: { 'Authorization': `Bearer ${tokenRes.body.access_token}` },
      });
      if (uiRes.status === 200 && uiRes.body) {
        userInfo = { ...userInfo, ...uiRes.body };
      }
    }

    if (!userInfo || (!userInfo.email && !userInfo.preferred_username && !userInfo.sub)) {
      return res.status(401).send('Could not determine user identity from OIDC provider');
    }

    // Determine username and email
    const email = userInfo.email || '';
    const username = userInfo.preferred_username || email.split('@')[0] || userInfo.sub;
    const displayName = userInfo.name || userInfo.given_name || username;

    // v8.7.6 / FIXED v8.7.8 — resolve role from the IdP groups claim when
    // mapping is configured. CRITICAL: only OVERWRITE an existing user's
    // role when the IdP actually emitted a usable groups claim. Without
    // that guard, a transient claim absence (Entra "groups overage",
    // app-registration regression, userinfo-endpoint fallback that drops
    // groups, scope strip by an upstream broker) silently demotes an
    // existing admin to viewer on their next login. Absence of evidence
    // is NOT evidence of demotion.
    const mappedRole = _resolveRoleFromGroups(userInfo, config.oidc);
    const groupMappingOn = (config.oidc.adminGroups?.length || 0)
      + (config.oidc.operatorGroups?.length || 0)
      + (config.oidc.viewerGroups?.length || 0) > 0;
    const groupsClaimUsable = _hasUsableGroupsClaim(userInfo, config.oidc);
    const assignedRole = mappedRole || (config.oidc.defaultRole || 'viewer');

    // Update existing role ONLY when we have evidence: mapping configured
    // AND the IdP actually sent groups. Otherwise preserve whatever role
    // the user already has (new users get defaultRole on creation; existing
    // users are untouched). warn-level so this is visible in ops/audit.
    const updateRole = groupMappingOn && groupsClaimUsable;
    if (groupMappingOn && !groupsClaimUsable) {
      const claimName = config.oidc.groupClaim || 'groups';
      log.warn('OIDC: groups claim absent or unusable — existing user role preserved (no demotion).', {
        username,
        claimName,
        hasOverageIndicator: !!(userInfo._claim_names && userInfo._claim_names[claimName]),
      });
    }

    const user = authService.findOrCreateSsoUser(username, assignedRole, email, { updateRole });
    if (!user) return res.status(403).send('Account is disabled');

    // Update display name if available
    if (displayName && displayName !== username) {
      db.prepare('UPDATE users SET display_name = ? WHERE id = ? AND (display_name IS NULL OR display_name = username)')
        .run(displayName, user.id);
    }

    // Create session
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'];
    const session = authService._createSession(
      { id: user.id, username: user.username, display_name: displayName, role: user.role },
      ip, ua
    );

    auditService.log({ userId: user.id, username: user.username, action: 'oidc_login', ip, userAgent: ua });

    // Set session cookie and redirect to app
    const isHttps = config.security.isStrict || config.session.secureCookie || req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.cookie(config.session.cookieName, session.token, {
      httpOnly: true,
      secure: isHttps,
      sameSite: config.security.isStrict ? 'strict' : (isHttps ? 'strict' : 'lax'),
      maxAge: config.session.ttl,
      path: '/',
    });

    // Redirect to app root
    res.redirect('/');
  } catch (err) {
    res.status(500).send('OIDC callback error: ' + err.message);
  }
});

// ─── Session Management (Admin only) ─────────────────────────────────────────

router.get('/sessions', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const db = getDb();
    const sessions = db.prepare(`
      SELECT s.id, s.user_id, u.username, s.token_hash, s.created_at, s.ip, s.user_agent
      FROM sessions s
      LEFT JOIN users u ON s.user_id = u.id
      WHERE s.is_valid = 1 AND s.expires_at > datetime('now')
      ORDER BY s.created_at DESC
    `).all();

    const currentTokenHash = sha256(req.authToken);
    res.json(sessions.map(s => ({
      id: s.id,
      userId: s.user_id,
      username: s.username || 'unknown',
      createdAt: s.created_at,
      lastActive: s.created_at,
      ip: s.ip,
      userAgent: s.user_agent,
      isCurrent: s.token_hash === currentTokenHash,
    })));
  } catch (err) {
    // Sessions table may not exist or have different schema
    res.json([]);
  }
});

router.delete('/sessions/:id', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const db = getDb();
    db.prepare('UPDATE sessions SET is_valid = 0 WHERE id = ?').run(parseInt(req.params.id));
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'session_terminate', targetType: 'session', targetId: String(req.params.id),
      ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── LDAP Configuration ──────────────────────────────────────────────────────

const ldapService = require('../services/ldap');

// GET /api/auth/ldap — get current LDAP config (password redacted)
router.get('/ldap', requireAuth, requireRole('admin'), (req, res) => {
  const cfg = ldapService.getConfig();
  if (!cfg) return res.json({ configured: false });
  const safe = { ...cfg, bindPassword: cfg.bindPassword ? '••••••••' : '' };
  res.json({ configured: true, ...safe });
});

// PUT /api/auth/ldap — save LDAP config
router.put('/ldap', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const { host, port, tls, tlsSkipVerify, bindDn, bindPassword, baseDn,
            userFilter, uidAttr, requiredGroup, defaultRole, enabled } = req.body;
    if (!host || !bindDn || !baseDn) {
      return res.status(400).json({ error: 'host, bindDn and baseDn are required' });
    }
    const existing = ldapService.getConfig();
    // Keep old password if not changed
    const finalPassword = (bindPassword && bindPassword !== '••••••••')
      ? bindPassword
      : (existing?.bindPassword || '');
    ldapService.saveConfig({
      host, port: parseInt(port) || (tls ? 636 : 389),
      tls: !!tls, tlsSkipVerify: !!tlsSkipVerify,
      bindDn, bindPassword: finalPassword,
      baseDn, userFilter: userFilter || '',
      uidAttr: uidAttr || 'uid',
      requiredGroup: requiredGroup || '',
      defaultRole: defaultRole || 'viewer',
      enabled: enabled !== false,
    });
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'ldap_config_saved', targetType: 'settings', targetId: host,
      ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/auth/ldap — remove LDAP config
router.delete('/ldap', requireAuth, requireRole('admin'), (req, res) => {
  ldapService.deleteConfig();
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'ldap_config_deleted', targetType: 'settings', targetId: 'ldap',
    ip: getClientIp(req),
  });
  res.json({ ok: true });
});

// POST /api/auth/ldap/test — test LDAP connection with provided config
router.post('/ldap/test', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { host, port, tls, tlsSkipVerify, bindDn, bindPassword, baseDn, userFilter, uidAttr } = req.body;
    if (!host || !bindDn || !bindPassword || !baseDn) {
      return res.status(400).json({ error: 'host, bindDn, bindPassword and baseDn are required' });
    }
    const result = await ldapService.testConnection({
      host, port: parseInt(port) || (tls ? 636 : 389),
      tls: !!tls, tlsSkipVerify: !!tlsSkipVerify,
      bindDn, bindPassword, baseDn, userFilter, uidAttr,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/auth/ldap/users — list users from LDAP directory (preview)
router.get('/ldap/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const cfg = ldapService.getConfig();
    if (!cfg) return res.status(404).json({ error: 'LDAP not configured' });
    const users = await ldapService.listUsers(cfg, 100);
    res.json({ users, total: users.length });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
// v8.7.6 — exposed for unit tests of the pure group→role resolver.
module.exports._resolveRoleFromGroups = _resolveRoleFromGroups;
// v8.7.8 (security fix) — pure helper that distinguishes "IdP returned no
// groups" from "user is in no relevant group" — the demotion guard.
module.exports._hasUsableGroupsClaim = _hasUsableGroupsClaim;
// v8.7.9 — cache layer + injectable fetcher for OIDC discovery/JWKS tests.
module.exports._oidcCacheInternals = {
  getDiscovery: _getDiscovery,
  getJwks: _getJwks,
  verifyIdToken: _verifyIdToken,
  setFetcher(fn) { _oidcFetchOverride = fn; },
  resetFetcher() { _oidcFetchOverride = null; },
  clear() { _discoCache.clear(); _jwksCache.clear(); _jwksLastForcedRefresh.clear(); },
  cooldownMs: JWKS_FORCE_REFRESH_COOLDOWN_MS,
};
