'use strict';

const { Router } = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const access = require('../services/provider-console/access');
const gateway = require('../services/provider-console/gateway');
const audit = require('../services/audit');
const cluster = require('../services/cluster');
const { getClientIp } = require('../utils/helpers');

const router = Router();

function _validate(req, res, next) {
  if (typeof req.body?.locked !== 'boolean') return res.status(400).json({ error: 'locked must be a boolean' });
  next();
}

function _reason(value) {
  return String(value || '').trim().slice(0, access.MAX_REASON_LENGTH);
}

function _applyAndTerminate(req, res, target, set) {
  try {
    const reason = _reason(req.body.reason);
    const state = set({ locked: req.body.locked, reason, userId: req.user.id });
    const effective = target.hostId === null
      ? { locked: state.global.locked && state.override !== 'allow' }
      : access.effective(target.hostId, target.resourceId);
    const terminatedSessions = req.body.locked && effective.locked
      ? gateway.terminateSessions({ ...target, reason: reason || 'Console access locked by an administrator' })
      : 0;
    if (req.body.locked && effective.locked) {
      cluster.publish('provider-console:lock', { ...target, reason }).catch(() => {});
    }
    audit.log({
      userId: req.user.id, username: req.user.username,
      action: req.body.locked ? 'provider_vm_console_access_lock' : 'provider_vm_console_access_unlock',
      targetType: target.resourceId ? 'virtualMachine' : (target.hostId ? 'host' : 'provider_console'),
      targetId: target.resourceId || (target.hostId ? String(target.hostId) : 'global'),
      details: { ...target, reason, terminatedSessions, override: state.override },
      ip: getClientIp(req), userAgent: req.headers['user-agent'],
    });
    res.json({ ...state, terminatedSessions });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
  }
}

router.get('/access', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const hostId = req.query.hostId === undefined ? null : access.normalizeHostId(req.query.hostId);
    const resourceId = req.query.resourceId === undefined ? null : access.normalizeResourceId(req.query.resourceId);
    res.json({ ...access.status(hostId, resourceId), activeSessions: gateway.getActiveSessions() });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
  }
});

router.put('/access/global', requireAuth, requireRole('admin'), _validate, (req, res) => {
  _applyAndTerminate(req, res, { hostId: null, resourceId: null }, input => access.setGlobal(input));
});

router.put('/access/hosts/:hostId', requireAuth, requireRole('admin'), _validate, (req, res) => {
  const hostId = access.normalizeHostId(req.params.hostId);
  _applyAndTerminate(req, res, { hostId, resourceId: null }, input => access.setHost(hostId, input));
});

router.put('/access/hosts/:hostId/virtual-machines/:resourceId',
  requireAuth, requireRole('admin'), _validate, (req, res) => {
    const hostId = access.normalizeHostId(req.params.hostId);
    const resourceId = access.normalizeResourceId(req.params.resourceId);
    _applyAndTerminate(req, res, { hostId, resourceId }, input => access.setVirtualMachine(hostId, resourceId, input));
  });

module.exports = router;
