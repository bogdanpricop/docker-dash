'use strict';

const { Router } = require('express');
const identity = require('../services/identity-governance');
const { requireFeature } = require('../middleware/auth');
const router = Router();
router.use(requireFeature('governance'));

function route(handler) { return (req, res, next) => { try { handler(req, res); } catch (error) {
  if (error.name === 'IdentityGovernanceError') return res.status(error.status).json({ error: error.message, code: error.code });
  next(error);
} }; }

router.get('/realms', route((_req, res) => res.json({ realms: identity.listRealms({ publicOnly: true }).map(item => ({
  id: item.id, slug: item.slug, name: item.name, protocol: item.protocol, loginUrl: item.login_url,
})) })));
router.get('/resolve', route((req, res) => res.json({ realm: identity.resolveRealm(req.query.email || req.query.domain) })));

module.exports = router;
