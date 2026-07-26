'use strict';

const { Router } = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const terminalAccess = require('../services/terminal-access');
const audit = require('../services/audit');
const cluster = require('../services/cluster');
const { getClientIp } = require('../utils/helpers');

const router = Router();

function _isAdmin(user) {
  return user?.role === 'admin' || (Array.isArray(user?.roles) && user.roles.includes('admin'));
}

function _validateMutation(req, res, next) {
  if (typeof req.body?.locked !== 'boolean') {
    return res.status(400).json({ error: 'locked must be a boolean' });
  }
  next();
}

function _reason(value) {
  return String(value || '').trim().slice(0, terminalAccess.MAX_REASON_LENGTH);
}

function _terminateAndPublish(hostId, reason) {
  const wsServer = require('../ws');
  const terminatedSessions = wsServer.terminateExecSessions({ hostId, reason });
  cluster.publish('terminal:lock', { hostId, reason }).catch(() => {});
  return terminatedSessions;
}

router.get('/', requireAuth, (req, res) => {
  try {
    const state = terminalAccess.status(req.query.targetHostId || 0);
    const wsServer = require('../ws');
    if (_isAdmin(req.user)) state.activeSessions = wsServer.getActiveExecSessions();
    else state.activeSessions = { count: wsServer.getActiveExecSessions().count };
    res.json(state);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
  }
});

router.put('/global', requireAuth, requireRole('admin'), _validateMutation, (req, res) => {
  try {
    const before = terminalAccess.status().global;
    const reason = _reason(req.body.reason);
    const state = terminalAccess.setGlobal({ locked: req.body.locked, reason, userId: req.user.id });
    const terminatedSessions = req.body.locked && state.effective.locked
      ? _terminateAndPublish(null, reason || 'Global terminal access locked by an administrator')
      : 0;
    audit.log({
      userId: req.user.id,
      username: req.user.username,
      action: req.body.locked ? 'terminal_access_lock' : 'terminal_access_unlock',
      targetType: 'terminal_access',
      targetId: 'global',
      details: { reason, previousReason: before.reason, terminatedSessions, override: state.override },
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });
    res.json({ ...state, terminatedSessions });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
  }
});

router.put('/hosts/:hostId', requireAuth, requireRole('admin'), _validateMutation, (req, res) => {
  try {
    const hostId = terminalAccess.normalizeHostId(req.params.hostId);
    const before = terminalAccess.status(hostId).hosts.find(item => item.hostId === hostId) || { reason: '' };
    const reason = _reason(req.body.reason);
    const state = terminalAccess.setHost(hostId, { locked: req.body.locked, reason, userId: req.user.id });
    const terminatedSessions = req.body.locked && state.effective.locked
      ? _terminateAndPublish(hostId, reason || `Terminal access locked for host ${hostId}`)
      : 0;
    audit.log({
      userId: req.user.id,
      username: req.user.username,
      action: req.body.locked ? 'terminal_access_lock' : 'terminal_access_unlock',
      targetType: 'host',
      targetId: String(hostId),
      details: { reason, previousReason: before.reason, terminatedSessions, override: state.override },
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });
    res.json({ ...state, terminatedSessions });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
  }
});

module.exports = router;
