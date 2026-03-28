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

      // Set cookie — auto-detect HTTPS from request protocol or X-Forwarded-Proto
      const isHttps = config.session.secureCookie || req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.cookie(config.session.cookieName, result.token, {
        httpOnly: true,
        secure: isHttps,
        sameSite: isHttps ? 'strict' : 'lax',
        maxAge: config.session.ttl,
        path: '/',
      });

      auditService.log({ userId: result.user.id, username, action: 'login', ip, userAgent: ua });
      res.json({
        token: result.token, // Also in body for when cookies are blocked (Edge Tracking Prevention, HTTP on public IPs)
        user: result.user,
        setupRequired: result.setupRequired,
        mustChangePassword: result.user.mustChangePassword,
        defaultAdminActive: authService.hasDefaultAdminActive(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

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
router.post('/validate-reset-token', async (req, res) => {
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
router.post('/reset-password-token', async (req, res) => {
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
    db.prepare('UPDATE users SET password_hash = ?, failed_attempts = 0, is_locked = 0, locked_until = NULL, updated_at = datetime(\'now\') WHERE id = ?')
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

module.exports = router;
