'use strict';

const { Router } = require('express');
const governance = require('../services/governance');
const auditService = require('../services/audit');
const { requireAuth, requireFeature, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');

const router = Router();

router.use(requireAuth, requireFeature('governance'));

function route(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof governance.GovernanceError) {
        return res.status(error.status).json({ error: error.message, code: error.code, details: error.details || undefined });
      }
      return next(error);
    }
  };
}

function audit(req, action, targetType, targetId, details = {}) {
  auditService.log({
    userId: req.user.id,
    username: req.user.username,
    action,
    targetType,
    targetId: String(targetId),
    details,
    ip: getClientIp(req),
  });
}

router.get('/catalog', route((req, res) => res.json(governance.catalog(req.user))));
router.get('/subjects', route((req, res) => res.json(governance.subjects(req.user))));

router.get('/roles', route((_req, res) => res.json({ roles: governance.listRoles() })));
router.post('/roles', writeable, route((req, res) => {
  const role = governance.createRole(req.body || {}, req.user);
  audit(req, 'governance_role_create', 'governance_role', role.id, { slug: role.slug, permissions: role.permissions });
  res.status(201).json({ role });
}));
router.put('/roles/:id', writeable, route((req, res) => {
  const role = governance.updateRole(req.params.id, req.body || {}, req.user);
  audit(req, 'governance_role_update', 'governance_role', role.id, { name: role.name, permissions: role.permissions });
  res.json({ role });
}));
router.delete('/roles/:id', writeable, route((req, res) => {
  const result = governance.deleteRole(req.params.id, req.user);
  audit(req, 'governance_role_delete', 'governance_role', req.params.id);
  res.json(result);
}));

router.get('/scopes', route((req, res) => res.json({ scopes: governance.listScopes(req.user) })));
router.post('/scopes', writeable, route((req, res) => {
  const scope = governance.createScope(req.body || {}, req.user);
  audit(req, 'governance_scope_create', 'governance_scope', scope.id, {
    type: scope.scope_type, key: scope.scope_key, parentId: scope.parent_id,
  });
  res.status(201).json({ scope });
}));
router.get('/scopes/:id/bindings', route((req, res) => {
  res.json({ bindings: governance.listBindings(req.params.id, req.user) });
}));
router.post('/bindings', writeable, route((req, res) => {
  const result = governance.createBinding(req.body || {}, req.user);
  audit(req, result.updated ? 'governance_binding_update' : 'governance_binding_create',
    'governance_binding', result.id, {
      scopeId: req.body.scopeId, roleId: req.body.roleId,
      userId: req.body.userId || null, teamId: req.body.teamId || null,
      expiresAt: req.body.expiresAt || null,
    });
  res.status(result.updated ? 200 : 201).json(result);
}));
router.delete('/bindings/:id', writeable, route((req, res) => {
  const result = governance.deleteBinding(req.params.id, req.user);
  audit(req, 'governance_binding_delete', 'governance_binding', req.params.id);
  res.json(result);
}));

// Invitation acceptance is intentionally outside a project permission check:
// possession of the high-entropy token plus email/domain match is the gate.
router.post('/invitations/accept', writeable, route((req, res) => {
  const result = governance.acceptInvitation(req.body?.token, req.user);
  audit(req, 'governance_invitation_accept', 'project', result.projectId, { role: result.role });
  res.json(result);
}));

router.get('/projects', route((req, res) => res.json({ projects: governance.listProjects(req.user) })));
router.post('/projects', writeable, route((req, res) => {
  const project = governance.createProject(req.body || {}, req.user);
  audit(req, 'governance_project_create', 'project', project.id, {
    slug: project.slug, parentScopeId: project.parentScopeId,
  });
  res.status(201).json({ project });
}));
router.get('/projects/:id', route((req, res) => res.json({ project: governance.getProject(req.params.id, req.user) })));
router.put('/projects/:id', writeable, route((req, res) => {
  const project = governance.updateProject(req.params.id, req.body || {}, req.user);
  audit(req, 'governance_project_update', 'project', project.id, {
    name: project.name, status: project.status, kind: project.kind, usageMode: project.usageMode,
  });
  res.json({ project });
}));

router.post('/projects/:id/members', writeable, route((req, res) => {
  const project = governance.setMember(req.params.id, req.body || {}, req.user);
  audit(req, 'governance_project_member_set', 'project', project.id, {
    memberUserId: req.body.userId, role: req.body.role || 'viewer',
  });
  res.json({ project });
}));
router.delete('/projects/:id/members/:userId', writeable, route((req, res) => {
  const result = governance.removeMember(req.params.id, req.params.userId, req.user);
  audit(req, 'governance_project_member_remove', 'project', req.params.id, { memberUserId: req.params.userId });
  res.json(result);
}));
router.post('/projects/:id/transfer-owner', writeable, route((req, res) => {
  const project = governance.transferOwnership(req.params.id, req.body?.userId, req.user);
  audit(req, 'governance_project_owner_transfer', 'project', project.id, { newOwnerUserId: req.body.userId });
  res.json({ project });
}));

router.get('/projects/:id/invitations', route((req, res) => {
  res.json({ invitations: governance.listInvitations(req.params.id, req.user) });
}));
router.post('/projects/:id/invitations', writeable, route((req, res) => {
  const invitation = governance.createInvitation(req.params.id, req.body || {}, req.user);
  audit(req, 'governance_invitation_create', 'project', req.params.id, {
    invitationId: invitation.id, email: invitation.email, emailDomain: invitation.emailDomain,
    role: invitation.role, expiresAt: invitation.expiresAt,
  });
  // token is returned once and deliberately omitted from audit storage.
  res.status(201).json({ invitation });
}));
router.delete('/projects/:id/invitations/:invitationId', writeable, route((req, res) => {
  const result = governance.revokeInvitation(req.params.id, req.params.invitationId, req.user);
  audit(req, 'governance_invitation_revoke', 'project', req.params.id, { invitationId: req.params.invitationId });
  res.json(result);
}));

router.put('/projects/:id/quotas', writeable, route((req, res) => {
  const quotas = governance.setQuotas(req.params.id, req.body || {}, req.user);
  audit(req, 'governance_project_quota_update', 'project', req.params.id, { quotas });
  res.json({ quotas });
}));
router.post('/projects/:id/resources', writeable, route((req, res) => {
  const result = governance.assignResource(req.params.id, req.body || {}, req.user);
  audit(req, 'governance_project_resource_assign', 'project', req.params.id, {
    resourceType: req.body.resourceType, resourceKey: req.body.resourceKey,
    providerHostId: req.body.providerHostId || 0,
    cpuMillicores: req.body.cpuMillicores || 0,
    memoryBytes: req.body.memoryBytes || 0,
    storageBytes: req.body.storageBytes || 0,
    warnings: result.warnings,
  });
  res.status(201).json(result);
}));
router.delete('/projects/:id/resources/:resourceId', writeable, route((req, res) => {
  const result = governance.unassignResource(req.params.id, req.params.resourceId, req.user);
  audit(req, 'governance_project_resource_unassign', 'project', req.params.id, { resourceId: req.params.resourceId });
  res.json(result);
}));

// V4.6b — extended capacity, approval, identity and blackout controls.
router.use('/controls', require('./governance-controls'));

module.exports = router;
