'use strict';

const { Router } = require('express');
const operations = require('../services/provider-operations');
const hostPermissions = require('../services/host-permissions');
const audit = require('../services/audit');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();
const ACCESS_RANK = { view: 1, operate: 2, admin: 3 };
const CANCEL_REQUESTABLE_STATES = new Set(['queued', 'running', 'waiting_retry', 'reconciling']);

function _isAdmin(user) {
  return user?.role === 'admin' || (Array.isArray(user?.roles) && user.roles.includes('admin'));
}

function _canAccess(req, operation, required = 'view') {
  if (_isAdmin(req.user)) return true;
  const hostId = operation?.provider?.endpointId;
  if (!Number.isInteger(hostId) || hostId <= 0) return false;
  const level = hostPermissions.resolveEffectivePermission(req.user.id, hostId, false);
  return (ACCESS_RANK[level] || 0) >= ACCESS_RANK[required];
}

function _operation(req, res, required = 'view') {
  const operation = operations.get(req.params.id);
  if (!operation) { res.status(404).json({ error: 'Provider operation not found', code: 'OPERATION_NOT_FOUND' }); return null; }
  if (!_canAccess(req, operation, required)) {
    res.status(403).json({ error: 'Insufficient host access', code: 'HOST_ACCESS_DENIED' }); return null;
  }
  return operation;
}

function _decorate(req, operation) {
  if (!operation) return operation;
  const role = req.user?.role;
  const operator = role === 'admin' || role === 'operator';
  return {
    ...operation,
    links: {
      self: `/api/operations/${operation.id}`,
      events: `/api/operations/${operation.id}/events`,
      activity: `#/activity/${operation.id}`,
      resource: operation.resource?.kind === 'artifact'
        ? '#/virtualization-catalog'
        : operation.resource?.kind === 'virtualMachine'
          ? `#/virtual-machines/${operation.provider?.endpointId}/${operation.resource?.id}`
          : `#/activity/${operation.id}`,
    },
    permissions: {
      canCancel: operator && CANCEL_REQUESTABLE_STATES.has(operation.state)
        && _canAccess(req, operation, 'operate'),
      canResolve: role === 'admin' && operation.state === 'unknown',
    },
  };
}

function _audit(req, action, targetId, details) {
  audit.log({
    userId: req.user.id, username: req.user.username, action,
    targetType: 'provider_operation', targetId: String(targetId),
    details, ip: getClientIp(req),
  });
}

function _sendError(res, err) {
  const status = Number.isInteger(err?.status) ? err.status : 400;
  res.status(status).json({ error: status >= 500 ? 'Provider operation request failed' : err.message, code: err?.code || 'PROVIDER_OPERATION_ERROR' });
}

router.get('/policies', requireAuth, requireRole('admin'), (_req, res) => {
  res.json({ policies: operations.policy.list() });
});

router.put('/policies/:scopeType/:scopeKey', requireAuth, requireRole('admin'), asyncHandler((req, res) => {
  try {
    const policy = operations.policy.set({
      scopeType: req.params.scopeType, scopeKey: req.params.scopeKey,
      mode: req.body?.mode, reason: req.body?.reason,
      freezeStartsAt: req.body?.freezeStartsAt, freezeEndsAt: req.body?.freezeEndsAt,
      updatedBy: req.user.id,
    });
    const emergency = operations.applyEmergencyStop(policy);
    _audit(req, 'provider_operation_policy_update', policy.id, {
      scopeType: policy.scope_type, scopeKey: policy.scope_key, mode: policy.mode,
      reason: policy.reason, freezeStartsAt: policy.freeze_starts_at,
      freezeEndsAt: policy.freeze_ends_at, emergency,
    });
    res.json({ policy, emergency });
  } catch (err) { _sendError(res, err); }
}));

router.get('/', requireAuth, (req, res) => {
  try {
    const limitText = req.query.limit === undefined ? '100' : String(req.query.limit);
    if (!/^\d{1,3}$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > 500) {
      return res.status(400).json({ error: 'Limit must be an integer between 1 and 500', code: 'INVALID_OPERATION_LIMIT' });
    }
    const hostId = req.query.hostId === undefined ? undefined : Number(req.query.hostId);
    const items = operations.list({ limit: 500, state: req.query.state, hostId })
      .filter(operation => _canAccess(req, operation, 'view'))
      .slice(0, Number(limitText)).map(operation => _decorate(req, operation));
    res.json({ schemaVersion: '1.0', count: items.length, items });
  } catch (err) { _sendError(res, err); }
});

router.get('/:id/events', requireAuth, (req, res) => {
  const operation = _operation(req, res, 'view'); if (!operation) return;
  try {
    const limit = req.query.limit === undefined ? 200 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return res.status(400).json({ error: 'Limit must be an integer between 1 and 500', code: 'INVALID_OPERATION_LIMIT' });
    }
    res.json({ operationId: operation.id, events: operations.events(operation.id, limit) });
  } catch (err) { _sendError(res, err); }
});

router.post('/:id/cancel', requireAuth, requireRole('admin', 'operator'), asyncHandler((req, res) => {
  const operation = _operation(req, res, 'operate'); if (!operation) return;
  try {
    const updated = operations.requestCancel(operation.id);
    _audit(req, 'provider_operation_cancel_request', operation.id, {
      providerType: operation.provider.type, hostId: operation.provider.endpointId,
      resourceId: operation.resource.id, previousState: operation.state,
    });
    res.status(202).json(_decorate(req, updated));
  } catch (err) { _sendError(res, err); }
}));

router.post('/:id/resolve', requireAuth, requireRole('admin'), asyncHandler((req, res) => {
  const operation = _operation(req, res, 'admin'); if (!operation) return;
  try {
    const updated = operations.resolveUnknown(operation.id, req.body?.resolution, req.body?.evidence, req.user.id);
    _audit(req, 'provider_operation_manual_resolution', operation.id, {
      providerType: operation.provider.type, hostId: operation.provider.endpointId,
      resourceId: operation.resource.id, resolution: updated.state,
      evidence: updated.resolution?.evidence,
    });
    res.json(_decorate(req, updated));
  } catch (err) { _sendError(res, err); }
}));

router.get('/:id', requireAuth, (req, res) => {
  const operation = _operation(req, res, 'view'); if (operation) res.json(_decorate(req, operation));
});

module.exports = router;
module.exports._internals = { _canAccess, _decorate };
