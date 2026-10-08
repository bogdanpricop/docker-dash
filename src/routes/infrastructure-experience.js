'use strict';

const { Router } = require('express');
const experience = require('../services/infrastructure-experience');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

function _actor(req) {
  return {
    userId: req.user.id, role: req.user.role, roles: req.user.roles,
    isAdmin: req.user.role === 'admin' || (Array.isArray(req.user.roles) && req.user.roles.includes('admin')),
  };
}

function _sendError(res, err) {
  const status = Number.isInteger(err?.status) ? err.status : 400;
  res.status(status).json({
    error: status >= 500 ? 'Infrastructure experience request failed' : err.message,
    code: err?.code || 'INFRASTRUCTURE_EXPERIENCE_ERROR',
  });
}

router.get('/home', requireAuth, (req, res) => {
  try { res.json(experience.home(_actor(req))); } catch (err) { _sendError(res, err); }
});

router.get('/navigation', requireAuth, (req, res) => {
  try { res.json(experience.navigation(_actor(req))); } catch (err) { _sendError(res, err); }
});

router.get('/actions', requireAuth, asyncHandler(async (req, res) => {
  try {
    res.json(await experience.actionAvailability(_actor(req), {
      hostId: req.query.hostId, resourceKind: req.query.resourceKind,
      resourceState: req.query.resourceState,
    }));
  } catch (err) { _sendError(res, err); }
}));

module.exports = router;
module.exports._internals = { _actor };
