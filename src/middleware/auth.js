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

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  let user;
  if (source === 'apikey') {
    user = apiKeys.validate(token);
  } else {
    user = authService.validateSession(token);
  }

  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  req.user = user;
  req.authToken = token;
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

module.exports = { requireAuth, optionalAuth, requireRole, writeable, requireFeature };
