'use strict';

const { Router } = require('express');
const blueprints = require('../services/compose-blueprints');
const auditService = require('../services/audit');
const hostPermissions = require('../services/host-permissions');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');

const router = Router();
const ACCESS_RANK = { view: 1, operate: 2, admin: 3 };

router.use(requireAuth, requireRole('admin', 'operator'));

function route(handler) {
  return async (req, res, next) => {
    try { await handler(req, res); }
    catch (error) {
      if (error instanceof blueprints.ComposeBlueprintError || (Number.isInteger(error?.status) && error.status < 500)) {
        return res.status(error.status || 400).json({
          error: error.message,
          code: error.code || 'COMPOSE_BLUEPRINT_ERROR',
          details: error.details || undefined,
        });
      }
      return next(error);
    }
  };
}

function admin(req) {
  if (req.user.role !== 'admin') {
    throw new blueprints.ComposeBlueprintError('Administrator access required', 403, 'ADMIN_REQUIRED');
  }
}

function canHost(req, hostId, required = 'view') {
  if (req.user.role === 'admin') return true;
  const level = hostPermissions.resolveEffectivePermission(req.user.id, Number(hostId), false);
  return (ACCESS_RANK[level] || 0) >= ACCESS_RANK[required];
}

function requireHost(req, hostId, required = 'operate') {
  if (!canHost(req, hostId, required)) {
    throw new blueprints.ComposeBlueprintError('Insufficient host access', 403, 'HOST_ACCESS_REQUIRED');
  }
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
    userAgent: req.headers['user-agent'],
  });
}

router.get('/', route((req, res) => {
  res.json(blueprints.list(req.user, {
    query: req.query.q,
    lifecycle: req.query.lifecycle,
    includeAll: req.query.includeAll === 'true',
  }));
}));

router.get('/:id', route((req, res) => {
  res.json(blueprints.get(req.params.id, req.user, req.query.versions === 'true'));
}));

router.post('/', writeable, route((req, res) => {
  admin(req);
  const result = blueprints.save(null, req.body || {}, req.user);
  audit(req, 'compose_blueprint_create', 'compose_blueprint', result.blueprint.id, {
    slug: result.blueprint.slug,
    category: result.blueprint.category,
  });
  res.status(201).json(result);
}));

router.put('/:id', writeable, route((req, res) => {
  admin(req);
  const result = blueprints.save(req.params.id, req.body || {}, req.user);
  audit(req, 'compose_blueprint_update', 'compose_blueprint', result.blueprint.id, {
    slug: result.blueprint.slug,
    lifecycle: result.blueprint.lifecycle,
  });
  res.json(result);
}));

router.post('/:id/state', writeable, route((req, res) => {
  admin(req);
  const result = blueprints.transition(req.params.id, req.body?.state, req.user);
  audit(req, 'compose_blueprint_transition', 'compose_blueprint', result.blueprint.id, {
    lifecycle: result.blueprint.lifecycle,
  });
  res.json(result);
}));

router.post('/:id/versions', writeable, route(async (req, res) => {
  admin(req);
  const result = await blueprints.createVersion(req.params.id, req.body || {}, req.user);
  audit(req, 'compose_blueprint_version_create', 'compose_blueprint_version', result.version.id, {
    blueprintId: result.version.blueprintId,
    version: result.version.version,
    digest: result.version.digest,
    signaturePolicy: result.version.signaturePolicy,
    versionHash: result.version.versionHash,
  });
  res.status(201).json(result);
}));

router.post('/:id/versions/:versionId/state', writeable, route((req, res) => {
  admin(req);
  const result = blueprints.transitionVersion(req.params.id, req.params.versionId, req.body?.state, req.user);
  audit(req, 'compose_blueprint_version_transition', 'compose_blueprint_version', req.params.versionId, {
    blueprintId: result.blueprint.id,
    state: req.body?.state,
    versionHash: result.versions.find(item => item.id === Number(req.params.versionId))?.versionHash || null,
  });
  res.json(result);
}));

router.get('/:id/versions/:versionId/diff', route((req, res) => {
  res.json(blueprints.diff(req.params.id, req.params.versionId, req.query.against, req.user));
}));

router.post('/:id/versions/:versionId/preview', route((req, res) => {
  requireHost(req, req.body?.hostId, 'operate');
  const result = blueprints.preview(req.params.versionId, req.body || {}, req.user);
  if (result.blueprint.id !== Number(req.params.id)) {
    throw new blueprints.ComposeBlueprintError('Version does not belong to blueprint', 404, 'BLUEPRINT_VERSION_NOT_FOUND');
  }
  audit(req, 'compose_blueprint_preview', 'compose_blueprint_version', req.params.versionId, {
    hostId: result.host.id,
    environment: result.environment,
    planHash: result.planHash,
    parametersHash: result.parametersHash,
    renderedOverrideHash: result.renderedOverrideHash,
    secretReferenceCount: result.secretReferenceAdmission?.referenceCount || 0,
  });
  res.json(result);
}));

router.post('/:id/versions/:versionId/instantiate', writeable, route(async (req, res) => {
  requireHost(req, req.body?.hostId, 'operate');
  const detail = blueprints.get(req.params.id, req.user, true);
  if (!detail.versions.some(item => item.id === Number(req.params.versionId))) {
    throw new blueprints.ComposeBlueprintError('Version does not belong to blueprint', 404, 'BLUEPRINT_VERSION_NOT_FOUND');
  }
  const result = await blueprints.instantiate(req.params.versionId, req.body || {}, req.user);
  audit(req, 'compose_blueprint_instantiate', 'compose_blueprint_instantiation', result.instantiation.id, {
    blueprintId: Number(req.params.id),
    versionId: Number(req.params.versionId),
    artifactId: result.artifact?.id || null,
    hostId: result.instantiation.hostId,
    environment: result.instantiation.environment,
    planHash: result.instantiation.planHash,
    parametersHash: result.instantiation.parametersHash,
    deduplicated: result.deduplicated,
  });
  res.status(result.deduplicated ? 200 : 201).json(result);
}));

router.get('/:id/instantiations', route((req, res) => {
  const result = blueprints.history(req.params.id, req.user, req.query.limit);
  result.instantiations = result.instantiations.filter(item => canHost(req, item.hostId, 'view'));
  res.json(result);
}));

module.exports = router;
