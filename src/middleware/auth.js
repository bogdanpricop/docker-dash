'use strict';

const authService = require('../services/auth');
const { apiKeys } = require('../services/misc');
const config = require('../config');
const log = require('../utils/logger')('auth-middleware');

// ─── SSO Trusted Proxy IP Allow-list (FIX #12) ────────────────────────────────
// Parse SSO_TRUSTED_PROXY_IPS env var (CSV) into a Set at startup.
// Normalize IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1 → 127.0.0.1).
function _normalizeIp(ip) {
  if (!ip) return '';
  // Strip IPv6 brackets
  const stripped = ip.replace(/^\[/, '').replace(/\]$/, '');
  // Convert IPv4-mapped IPv6 to plain IPv4
  const v4mapped = stripped.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) return v4mapped[1];
  return stripped;
}

const _SSO_UNSET = Symbol('unset');
let _ssoTrustedIps = _SSO_UNSET; // sentinel = not yet initialized

function _getSsoTrustedIps() {
  if (_ssoTrustedIps !== _SSO_UNSET) return _ssoTrustedIps; // null or Set
  const raw = process.env.SSO_TRUSTED_PROXY_IPS;
  if (!raw || !raw.trim()) {
    _ssoTrustedIps = null; // fail closed — cached as null
    return null;
  }
  _ssoTrustedIps = new Set(
    raw.split(',').map(ip => _normalizeIp(ip.trim())).filter(Boolean)
  );
  return _ssoTrustedIps;
}

function _isSsoTrusted(req) {
  const trustedIps = _getSsoTrustedIps();
  if (!trustedIps) {
    // Env var not set → fail closed, never trust SSO headers
    log.warn('SSO headers present but SSO_TRUSTED_PROXY_IPS is not configured — ignoring SSO headers (fail closed)');
    return false;
  }
  const clientIp = _normalizeIp(req.ip || '');
  return trustedIps.has(clientIp);
}

// ─── Password-change-required allow-list (FIX #21) ────────────────────────────
// Paths that mustChangePassword users are still allowed to access.
// Matched against req.originalUrl (strips query string for comparison).
const MUST_CHANGE_PASSWORD_ALLOWED = new Set([
  '/api/auth/me',
  '/api/auth/change-password',
  '/api/auth/logout',
  '/api/health',
]);

function _isMustChangePasswordAllowed(req) {
  // Strip query string
  const path = req.originalUrl ? req.originalUrl.split('?')[0] : req.path;
  return MUST_CHANGE_PASSWORD_ALLOWED.has(path);
}

/** Extract session token from cookie or Authorization header */
function extractToken(req) {
  // Cookie
  const cookie = req.cookies?.[config.session.cookieName];
  if (cookie) return { token: cookie, source: 'cookie' };

  // Bearer token
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return { token: auth.substring(7), source: 'bearer' };

  // API key
  if (auth?.startsWith('ApiKey ')) return { token: auth.substring(7), source: 'apikey' };

  return { token: null, source: null };
}

/** Require authentication */
function requireAuth(req, res, next) {
  const { token, source } = extractToken(req);

  let user = null;

  if (token) {
    if (source === 'apikey') {
      user = apiKeys.validate(token);
    } else {
      user = authService.validateSession(token);
    }
  }

  // SSO header-based auth (Authelia, Authentik, Caddy forward_auth, Traefik)
  // FIX #12: Only trust SSO headers when req.ip is in the SSO_TRUSTED_PROXY_IPS allow-list.
  // If the env var is not set, fail closed — SSO headers are never trusted.
  if (!user && config.features.ssoHeaders) {
    const ssoUser = req.headers['x-forwarded-user'] || req.headers['remote-user'];
    if (ssoUser) {
      if (_isSsoTrusted(req)) {
        const ssoGroups = (req.headers['x-forwarded-groups'] || '').split(',').map(g => g.trim()).filter(Boolean);
        const ssoEmail = req.headers['x-forwarded-email'] || '';
        // Map SSO groups to Docker Dash roles
        let role = 'viewer';
        if (ssoGroups.includes('admin') || ssoGroups.includes('docker-dash-admin')) role = 'admin';
        else if (ssoGroups.includes('operator') || ssoGroups.includes('docker-dash-operator')) role = 'operator';
        // Auto-create or find SSO user
        user = authService.findOrCreateSsoUser(ssoUser, role, ssoEmail);
        req.ssoAuth = true;
      }
      // If not trusted, fall through — user remains null, auth will fail below
    }
  }

  if (!user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  req.user = user;
  req.authToken = token;

  // FIX #21: Enforce must_change_password — only allow password-change-related endpoints.
  if (user.mustChangePassword && !_isMustChangePasswordAllowed(req)) {
    return res.status(403).json({
      error: 'PASSWORD_CHANGE_REQUIRED',
      mustChangePassword: true,
    });
  }

  // Enforce API key permissions (read-only keys blocked from mutations)
  if (user.apiKey) return enforceApiKeyPermissions(req, res, next);

  next();
}

/** Optional auth - attach user if present but don't block */
function optionalAuth(req, res, next) {
  const { token, source } = extractToken(req);
  if (token) {
    req.user = source === 'apikey' ? apiKeys.validate(token) : authService.validateSession(token);
  }
  next();
}

/** Require specific role(s) */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

/** Enforce API key permissions (read-only keys can only GET) */
function enforceApiKeyPermissions(req, res, next) {
  if (req.user?.apiKey && req.user.permissions) {
    const perms = req.user.permissions;
    const isRead = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (isRead && !perms.includes('read') && !perms.includes('*')) {
      return res.status(403).json({ error: 'API key lacks read permission' });
    }
    if (!isRead && !perms.includes('write') && !perms.includes('*')) {
      return res.status(403).json({ error: 'API key lacks write permission (read-only key)' });
    }
  }
  next();
}

/** Block actions in read-only mode */
function writeable(req, res, next) {
  if (config.features.readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return res.status(403).json({ error: 'System is in read-only mode' });
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    try {
      const decision = require('../services/provider-operations/policy').globalHttpGate();
      if (!decision.allowed) {
        return res.status(423).json({ error: decision.reason, code: decision.code });
      }
    } catch (err) { return next(err); }
  }
  next();
}

/** Require feature flag */
function requireFeature(feature) {
  return (req, res, next) => {
    if (!config.features[feature]) {
      return res.status(403).json({ error: `Feature '${feature}' is disabled` });
    }
    next();
  };
}

module.exports = { requireAuth, optionalAuth, requireRole, writeable, requireFeature, enforceApiKeyPermissions };
