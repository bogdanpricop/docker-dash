'use strict';

// v8.2.x further-split: extracted from src/routes/misc.js.
// 3 routes for /api-keys/* — list, create, revoke. Mounted at /api-keys.

const { Router } = require('express');
const { apiKeys } = require('../services/misc');
const auditService = require('../services/audit');
const { requireAuth, writeable } = require('../middleware/auth');
const { getDb } = require('../db');
const { getClientIp } = require('../utils/helpers');
const log = require('../utils/logger')('misc');

const router = Router();

router.get('/', requireAuth, (req, res) => {
  res.json(apiKeys.list(req.user.id));
});

function userCredentials(req,res,next) {
  if (req.user.apiKey || req.user.serviceToken) return res.status(403).json({error:'Sign in as a user to manage API keys'});
  next();
}

router.post('/', requireAuth, userCredentials, writeable, (req, res) => {
  try {
    const result = getDb().transaction(() => {
      const created = apiKeys.create(req.user.id, req.body);
      auditService.log({ userId:req.user.id, username:req.user.username,
        action:'apikey_create', details:{ name:req.body.name }, ip:getClientIp(req) });
      return created;
    }).immediate();
    res.status(201).json(result);
  } catch (err) {
    if ([400,403].includes(err.status)) return res.status(err.status).json({error:err.message});
    log.error('API key creation failed'); res.status(500).json({ error:'Internal server error' });
  }
});

router.delete('/:id', requireAuth, userCredentials, writeable, (req, res) => {
  try {
    if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))) return res.status(400).json({error:'Invalid API key id'});
    if (!apiKeys.revoke(Number(req.params.id),req.user.id)) return res.status(404).json({error:'Active API key not found'});
    auditService.log({userId:req.user.id,username:req.user.username,action:'apikey_revoke',targetType:'api_key',targetId:req.params.id,ip:getClientIp(req)});
    res.json({ok:true});
  } catch {log.error('API key revocation failed');res.status(500).json({error:'Internal server error'});}
});

module.exports = router;
