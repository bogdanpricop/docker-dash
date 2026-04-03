'use strict';

const { Router } = require('express');
const authService = require('../services/auth');
const auditService = require('../services/audit');
const emailService = require('../services/email');
const { requireAuth, requireRole } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const config = require('../config');
const { getClientIp } = require('../utils/helpers');
const { getDb } = require('../db');
const { generateToken, sha256 } = require('../utils/crypto');
const bcrypt = require('bcrypt');

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
      res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// ─── OIDC / OAuth Flow ────────────────────────────────────

const https = require('https');
const http = require('http');
const crypto = require('crypto');

/** Fetch JSON from a URL (for OIDC discovery, token exchange, userinfo) */
function _oidcFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
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

/** Decode JWT payload (no verification - we trust the token_endpoint response) */
function _decodeJwtPayload(jwt) {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch { return null; }
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
    const disco = await _oidcFetch(`${issuer}/.well-known/openid-configuration`);
    if (!disco.body?.authorization_endpoint) {
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
    const params = new URLSearchParams({
      client_id: config.oidc.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid profile email',
      state,
    });

    const authUrl = `${disco.body.authorization_endpoint}?${params.toString()}`;
    res.json({ url: authUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    const disco = await _oidcFetch(`${issuer}/.well-known/openid-configuration`);
    if (!disco.body?.token_endpoint) return res.status(500).send('OIDC discovery failed');

    const redirectUri = config.oidc.redirectUri || `${config.app.publicUrl || config.app.baseUrl}/api/auth/oidc/callback`;

    // Exchange code for tokens
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.oidc.clientId,
      client_secret: config.oidc.clientSecret,
      code,
      redirect_uri: redirectUri,
    }).toString();

    const tokenRes = await _oidcFetch(disco.body.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    });

    if (tokenRes.status !== 200 || !tokenRes.body?.access_token) {
      return res.status(401).send('Token exchange failed: ' + (tokenRes.body?.error_description || tokenRes.body?.error || 'unknown'));
    }

    // Extract user info — try id_token first, then userinfo endpoint
    let userInfo = null;
    if (tokenRes.body.id_token) {
      userInfo = _decodeJwtPayload(tokenRes.body.id_token);
    }

    if ((!userInfo || !userInfo.email) && disco.body.userinfo_endpoint) {
      const uiRes = await _oidcFetch(disco.body.userinfo_endpoint, {
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

    // Find or create user
    const user = authService.findOrCreateSsoUser(username, config.oidc.defaultRole || 'viewer', email);
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

module.exports = router;
