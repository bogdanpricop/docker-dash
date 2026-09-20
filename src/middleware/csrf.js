'use strict';

const crypto = require('crypto');
const log = require('../utils/logger')('csrf');
const config = require('../config');

const TOKEN_NAME = 'XSRF-TOKEN';
const HEADER_NAME = 'x-xsrf-token';
const EXEMPT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXEMPT_PATHS = [
  '/api/auth/login',
  '/api/auth/mfa/verify',
  '/api/auth/mfa/recovery',
  '/api/auth/request-password-reset',
  '/api/auth/reset-password-token',
  '/api/auth/validate-reset-token',
  '/api/git/webhook/',
  '/api/automation/webhooks/',
];

// Safety bypass: if CSRF_DISABLED=true, skip middleware (for smoke-testing without frontend rewrite)
const CSRF_DISABLED = process.env.CSRF_DISABLED === 'true';
if (CSRF_DISABLED) {
  log.warn('CSRF protection is DISABLED (CSRF_DISABLED=true). Do not use in production.');
}

function issueToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function ensureCookie(req, res) {
  if (!req.cookies || !req.cookies[TOKEN_NAME]) {
    const token = issueToken();
    res.cookie(TOKEN_NAME, token, {
      httpOnly: false,
      sameSite: 'strict',
      secure: req.secure,
      path: '/',
    });
    req.cookies = req.cookies || {};
    req.cookies[TOKEN_NAME] = token;
  }
}

module.exports = function csrf(req, res, next) {
  if (CSRF_DISABLED) return next();

  ensureCookie(req, res);

  if (EXEMPT_METHODS.has(req.method)) return next();
  if (EXEMPT_PATHS.some(p => p.endsWith('/') ? req.path.startsWith(p) : req.path === p)) return next();

  // Match authentication precedence: an arbitrary Authorization header must
  // not exempt a request that actually authenticates using a browser cookie/SSO.
  const ambientAuth = req.cookies?.[config.session.cookieName]
    || req.headers['x-forwarded-user'] || req.headers['remote-user'];
  if (!ambientAuth && /^(Bearer|ApiKey) \S+$/.test(req.headers.authorization || '')) return next();

  const cookieToken = req.cookies[TOKEN_NAME];
  const headerToken = req.headers[HEADER_NAME];

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'CSRF token missing or invalid', code: 'CSRF_FAILURE' });
  }

  next();
};
