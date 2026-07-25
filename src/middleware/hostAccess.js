'use strict';

// Per-host authorization middleware. Global RBAC still decides which kinds of
// operations a role may perform; this layer narrows that authority to the
// selected host. Admins retain global access for backward compatibility.

const hostPermissions = require('../services/host-permissions');

const LEVELS = ['view', 'operate', 'admin'];
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function _isAdmin(user) {
  return user?.role === 'admin'
    || (Array.isArray(user?.roles) && user.roles.includes('admin'));
}

function _rank(level) {
  return LEVELS.indexOf(level);
}

function _hostIdFromRequest(req, options = {}) {
  const raw = options.param
    ? req.params?.[options.param]
    : (req.hostId ?? req.query?.hostId ?? req.headers?.['x-docker-host'] ?? 0);
  const hostId = Number.parseInt(raw, 10);
  return Number.isInteger(hostId) && hostId >= 0 ? hostId : null;
}

function _check(req, res, next, required, options) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });

  const hostId = _hostIdFromRequest(req, options);
  if (hostId === null) return res.status(400).json({ error: 'Invalid hostId' });

  if (_isAdmin(req.user)) {
    req.hostAccess = 'admin';
    return next();
  }

  try {
    const permission = hostPermissions.resolveEffectivePermission(req.user.id, hostId, false);
    if (_rank(permission) < _rank(required)) {
      return res.status(403).json({
        error: 'Insufficient permissions for this host',
        code: 'HOST_ACCESS_DENIED',
        hostId,
        required,
        permission,
      });
    }
    req.hostAccess = permission;
    next();
  } catch (err) {
    next(err);
  }
}

/** Require a fixed host permission level. */
function requireHostAccess(required = 'view', options = {}) {
  if (!LEVELS.includes(required)) throw new Error(`Invalid host access level: ${required}`);
  return (req, res, next) => _check(req, res, next, required, options);
}

/** Require view for reads and operate for state-changing HTTP methods. */
function requireHostAccessForMethod(options = {}) {
  return (req, res, next) => {
    const required = READ_METHODS.has(req.method) ? 'view' : 'operate';
    return _check(req, res, next, required, options);
  };
}

module.exports = {
  requireHostAccess,
  requireHostAccessForMethod,
  _internals: { _hostIdFromRequest, _isAdmin },
};
