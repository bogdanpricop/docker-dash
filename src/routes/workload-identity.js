'use strict';

const { Router } = require('express');
const identity = require('../services/identity-governance');
const { requireFeature, writeable } = require('../middleware/auth');
const audit=require('../services/audit');
const { getClientIp }=require('../utils/helpers');
const router = Router();
router.use(requireFeature('governance'));

router.post('/exchange', writeable, (req, res, next) => {
  res.set('Cache-Control','no-store');
  try { res.json(identity.exchange(req.body?.assertion,(token,trust)=>audit.log({username:token.principal,
    action:'workload_identity_exchange',targetType:'service_token',targetId:String(token.id),
    details:{trustId:trust.id,scopes:token.scopes},ip:getClientIp(req),userAgent:req.headers['user-agent']}))); } catch (error) {
    if (error.name === 'IdentityGovernanceError') return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  }
});

module.exports = router;
