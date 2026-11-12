'use strict';

const { Router } = require('express');
const bcrypt = require('bcrypt');
const { generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse } = require('@simplewebauthn/server');
const { getDb } = require('../db');
const config = require('../config');
const { requireAuth, writeable } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { generateToken, sha256 } = require('../utils/crypto');
const { getClientIp } = require('../utils/helpers');
const { mustChangePassword } = require('../utils/account-password-policy');
const auth = require('../services/auth');
const audit = require('../services/audit');

const router = Router();
const lifetime = 5 * 60_000;
const maxKeys = 20;
const limit = scope => rateLimit(config.rateLimit.loginMaxAttempts, config.rateLimit.loginWindowMs, 'auth-passkey-' + scope);

function relyingParty() {
  try {
    const url = new URL(config.app.publicUrl);
    if (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost')) {
      return { origin: url.origin, rpID: url.hostname, secure: url.protocol === 'https:' };
    }
  } catch { /* passkeys require a configured origin */ }
  return null;
}

function browserBinding(req, res, next) {
  const rp = relyingParty();
  const csrf = req.cookies?.['XSRF-TOKEN'];
  if (!rp || req.get('origin') !== rp.origin || !csrf) {
    return res.status(403).json({ error: 'Use the configured HTTPS address to continue with passkeys' });
  }
  req.passkeyRp = rp;
  req.passkeyBinding = sha256(csrf);
  next();
}

function sessionOnly(req, res, next) {
  const token = req.cookies?.[config.session.cookieName];
  if (!token || req.user.apiKey || req.user.serviceToken || !auth.validateSession(token)) {
    return res.status(403).json({ error: 'A signed-in browser session is required to manage passkeys' });
  }
  req.passkeyBinding = sha256(token);
  next();
}

function eligible(user) {
  return user?.is_active && user.auth_source === 'local' && !mustChangePassword(user);
}

function getUser(db, id) {
  return db.prepare(`SELECT *, (julianday(COALESCE(password_changed_at, created_at)) - 2440587.5) * 86400000
    AS passwordChangedAtMs FROM users WHERE id = ?`).get(id);
}

function createChallenge(req, purpose, options, user = null, name = null, handle = null) {
  const db = getDb();
  const id = generateToken();
  db.transaction(() => {
    db.prepare('DELETE FROM passkey_challenges WHERE expires_at <= ? OR (purpose = ? AND binding = ?)')
      .run(Date.now(), purpose, req.passkeyBinding);
    db.prepare('INSERT INTO passkey_challenges VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, purpose, req.passkeyBinding, options.challenge, user?.id ?? null, user?.auth_version ?? null,
        name, handle, Date.now() + lifetime);
  }).immediate();
  return { challengeId: id, options };
}

function takeChallenge(req, purpose) {
  const id = req.body?.challengeId;
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return null;
  return getDb().prepare(`DELETE FROM passkey_challenges
    WHERE id = ? AND purpose = ? AND binding = ? AND expires_at > ? RETURNING *`)
    .get(id, purpose, req.passkeyBinding, Date.now());
}

function log(req, user, action, id) {
  audit.log({ userId: user.id, username: user.username, action, targetType: 'passkey',
    targetId: id, ip: getClientIp(req), userAgent: req.get('user-agent') });
}

router.get('/enabled', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ origin: relyingParty()?.origin ?? null });
});

router.get('/', requireAuth, sessionOnly, (req, res) => {
  const db = getDb();
  const user = getUser(db, req.user.id);
  const keys = db.prepare(`SELECT id, name, created_at, last_used_at
    FROM passkeys WHERE user_id = ? ORDER BY created_at DESC`).all(req.user.id);
  res.set('Cache-Control', 'no-store').json({ eligible: !!eligible(user), origin: relyingParty()?.origin ?? null, keys });
});

router.post('/register/options', limit('register-options'), requireAuth, browserBinding, sessionOnly, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const password = req.body?.password;
  if (!name || name.length > 80 || typeof password !== 'string' || !password || password.length > 1024) {
    return res.status(400).json({ error: 'A passkey name and current password are required' });
  }
  const db = getDb();
  const user = getUser(db, req.user.id);
  if (!eligible(user) || !await bcrypt.compare(password, user.password_hash)) {
    return res.status(403).json({ error: 'The current password could not be verified for this account' });
  }
  const keys = db.prepare('SELECT id, user_handle FROM passkeys WHERE user_id = ?').all(user.id);
  if (keys.length >= maxKeys) return res.status(409).json({ error: 'Remove a passkey before adding another' });
  const handle = keys[0]?.user_handle || generateToken();
  const options = await generateRegistrationOptions({
    rpID: req.passkeyRp.rpID, rpName: 'Docker Dash', userName: user.username, userDisplayName: user.display_name || user.username,
    userID: Buffer.from(handle, 'hex'), attestationType: 'none', timeout: lifetime,
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: keys.map(key => ({ id: key.id })),
  });
  res.set('Cache-Control', 'no-store').json(createChallenge(req, 'register', options, user, name, handle));
});

router.post('/register/verify', limit('register-verify'), requireAuth, browserBinding, sessionOnly, writeable, async (req, res) => {
  const challenge = takeChallenge(req, 'register');
  if (!challenge || challenge.user_id !== req.user.id) return res.status(400).json({ error: 'Start a new passkey registration' });
  let verified;
  try {
    verified = await verifyRegistrationResponse({
      response: req.body.credential, expectedChallenge: challenge.challenge,
      expectedOrigin: req.passkeyRp.origin, expectedRPID: req.passkeyRp.rpID, requireUserVerification: true,
    });
  } catch { return res.status(400).json({ error: 'The device could not verify this passkey registration' }); }
  if (!verified.verified) return res.status(400).json({ error: 'Passkey registration could not be verified' });
  const { credential } = verified.registrationInfo;
  const db = getDb();
  const saved = db.transaction(() => {
    const user = getUser(db, req.user.id);
    if (!eligible(user) || user.auth_version !== challenge.auth_version
      || !auth.validateSession(req.cookies[config.session.cookieName])) return false;
    const count = db.prepare('SELECT COUNT(*) AS count FROM passkeys WHERE user_id = ?').get(user.id).count;
    if (count >= maxKeys) return false;
    return db.prepare(`INSERT INTO passkeys (id, user_id, name, user_handle, public_key, counter, transports)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(
      credential.id, user.id, challenge.name, challenge.user_handle,
      Buffer.from(credential.publicKey), credential.counter, JSON.stringify(credential.transports || [])
    ).changes === 1;
  }).immediate();
  if (!saved) return res.status(409).json({ error: 'Passkey already exists or account state changed. Start again.' });
  log(req, req.user, 'passkey_registered', credential.id);
  res.status(201).json({ ok: true });
});

router.delete('/:id', limit('revoke'), requireAuth, browserBinding, sessionOnly, (req, res) => {
  const changed = getDb().prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!changed.changes) return res.status(404).json({ error: 'Passkey not found' });
  log(req, req.user, 'passkey_revoked', req.params.id);
  res.json({ ok: true });
});

router.post('/login/options', limit('login-options'), browserBinding, async (req, res) => {
  const options = await generateAuthenticationOptions({ rpID: req.passkeyRp.rpID, userVerification: 'required', timeout: lifetime });
  res.set('Cache-Control', 'no-store').json(createChallenge(req, 'login', options));
});

router.post('/login/verify', limit('login-verify'), browserBinding, async (req, res) => {
  const db = getDb();
  const challenge = takeChallenge(req, 'login');
  const response = req.body?.credential;
  const invalid = () => res.status(401).json({ error: 'Passkey sign-in failed. Try again or use your password.' });
  if (!challenge || typeof response?.id !== 'string') return invalid();
  const key = db.prepare('SELECT * FROM passkeys WHERE id = ?').get(response.id);
  if (!key || response.response?.userHandle !== Buffer.from(key.user_handle, 'hex').toString('base64url')) return invalid();
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge.challenge, expectedOrigin: req.passkeyRp.origin,
      expectedRPID: req.passkeyRp.rpID, requireUserVerification: true,
      credential: { id: key.id, publicKey: new Uint8Array(key.public_key), counter: key.counter,
        transports: JSON.parse(key.transports) },
    });
  } catch { return invalid(); }
  if (!verification.verified) return invalid();
  const result = db.transaction(() => {
    const user = getUser(db, key.user_id);
    if (!eligible(user)) return null;
    const updated = db.prepare(`UPDATE passkeys SET counter = ?, last_used_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ? AND counter = ? AND public_key = ?`).run(
      verification.authenticationInfo.newCounter, key.id, key.user_id, key.counter, key.public_key);
    return updated.changes === 1 ? auth.signInWithVerifiedPasskey(user, getClientIp(req), req.get('user-agent')) : null;
  }).immediate();
  if (!result) return invalid();
  log(req, result.user, result.mfaRequired ? 'passkey_mfa_pending' : 'passkey_login', key.id);
  if (result.mfaRequired) return res.json({ mfaRequired: true, mfaToken: result.mfaToken });
  res.cookie(config.session.cookieName, result.token, {
    httpOnly: true, secure: req.passkeyRp.secure || config.session.secureCookie || config.security.isStrict,
    sameSite: 'strict', maxAge: config.session.ttl, path: '/',
  });
  res.json({ user: result.user, setupRequired: result.setupRequired, mustChangePassword: false,
    defaultAdminActive: auth.hasDefaultAdminActive() });
});

module.exports = router;
