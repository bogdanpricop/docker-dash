'use strict';

const { Router } = require('express');
const identity = require('../services/identity-governance');
const { requireFeature } = require('../middleware/auth');
const router = Router();
router.use(requireFeature('governance'));

router.post('/exchange', (req, res, next) => {
  try { res.json(identity.exchange(req.body?.assertion)); } catch (error) {
    if (error.name === 'IdentityGovernanceError') return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  }
});

module.exports = router;
