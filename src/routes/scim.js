'use strict';

const { Router } = require('express');
const { requireAuth, requireFeature, writeable } = require('../middleware/auth');
const scim = require('../services/scim');
const audit = require('../services/audit');
const { getDb } = require('../db');
const { getClientIp } = require('../utils/helpers');
const router = Router();

router.use(requireFeature('governance'), requireAuth);
router.use((req, res, next) => {
  try {
    if (!req.user.serviceToken) throw Object.assign(new Error('SCIM requires a scoped service token'),{status:403});
    if (req.user.tenantId != null) throw Object.assign(new Error('Tenant-scoped credentials cannot administer global SCIM resources'),{status:403});
    const scope=['GET','HEAD','OPTIONS'].includes(req.method)?'scim.read':'scim.write';
    if (!Array.isArray(req.user.scopes) || !req.user.scopes.includes(scope)) throw Object.assign(new Error('SCIM requires '+scope+' scope'),{status:403});
    next();
  }
  catch (error) { res.status(error.status || 403).json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: String(error.status || 403), detail: error.message }); }
});

function route(handler, status = 200) { return (req, res, next) => { try {
  const result = handler(req, res); if (!res.headersSent) res.status(status).json(result);
} catch (error) {
  if (error.name === 'ScimError') return res.status(error.status).json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
    status: String(error.status), scimType: error.scimType, detail: error.message });
  next(error);
} }; }

function mutation(action, type, handler, status = 200) {
  return route(req => getDb().transaction(() => {
    const result = handler(req);
    audit.log({userId:req.user.id,username:req.user.username,action:'scim_'+action,targetType:type,
      targetId:String(result?.id || req.params.id),details:{serviceTokenId:req.user.serviceTokenId || null},
      ip:getClientIp(req),userAgent:req.headers['user-agent']});
    return result;
  }).immediate(),status);
}

router.get('/ServiceProviderConfig', route(() => ({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
  patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 }, filter: { supported: true, maxResults: 200 },
  changePassword: { supported: false }, sort: { supported: false }, etag: { supported: true }, authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', primary: true }] })));
router.get('/ResourceTypes', route(() => ({ schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: 2,
  Resources: [{ id: 'User', name: 'User', endpoint: '/Users', schema: scim.USER_SCHEMA }, { id: 'Group', name: 'Group', endpoint: '/Groups', schema: scim.GROUP_SCHEMA }] })));
router.get('/Schemas', route(() => ({ schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: 2,
  Resources: [{ id: scim.USER_SCHEMA, name: 'User' }, { id: scim.GROUP_SCHEMA, name: 'Group' }] })));

router.get('/Users', route(req => scim.listUsers(req.query)));
router.get('/Users/:id', route(req => scim.getUser(req.params.id)));
router.post('/Users', writeable, mutation('user_create','user',req => scim.createUser(req.body || {}), 201));
router.put('/Users/:id', writeable, mutation('user_replace','user',req => scim.replaceUser(req.params.id, req.body || {})));
router.patch('/Users/:id', writeable, mutation('user_patch','user',req => scim.patchUser(req.params.id, req.body || {})));
router.delete('/Users/:id', writeable, mutation('user_delete','user',req => { scim.deleteUser(req.params.id); return null; }, 204));
router.get('/Groups', route(req => scim.listGroups(req.query)));
router.get('/Groups/:id', route(req => scim.getGroup(req.params.id)));
router.post('/Groups', writeable, mutation('group_create','team',req => scim.createGroup(req.body || {}), 201));
router.put('/Groups/:id', writeable, mutation('group_replace','team',req => scim.replaceGroup(req.params.id, req.body || {})));
router.patch('/Groups/:id', writeable, mutation('group_patch','team',req => scim.patchGroup(req.params.id, req.body || {})));
router.delete('/Groups/:id', writeable, mutation('group_delete','team',req => { scim.deleteGroup(req.params.id); return null; }, 204));

module.exports = router;
