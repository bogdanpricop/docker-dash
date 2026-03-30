'use strict';

const authService = require('../services/auth');
const { apiKeys } = require('../services/misc');
const config = require('../config');

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
  if (!user && config.features.ssoHeaders) {
    const ssoUser = req.headers['x-forwarded-user'] || req.headers['remote-user'];
    if (ssoUser) {
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
  }

  if (!user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  req.user = user;
  req.authToken = token;

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
