'use strict';

const { Router } = require('express');
const oci = require('../services/oci-compose');
const audit = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');
const hostPermissions = require('../services/host-permissions');

const router = Router();
const ACCESS_RANK = { view: 1, operate: 2, admin: 3 };

function canAccess(req, artifact, required) {
  if (req.user.role === 'admin') return true;
  const level = hostPermissions.resolveEffectivePermission(req.user.id, artifact.host_id, false);
  return (ACCESS_RANK[level] || 0) >= ACCESS_RANK[required];
}

function requireArtifactAccess(req, res, required = 'view') {
  const artifact = oci.get(req.params.id);
  if (!artifact) { res.status(404).json({ error: 'OCI artifact not found' }); return null; }
  if (!canAccess(req, artifact, required)) { res.status(403).json({ error: 'Insufficient host access' }); return null; }
  return artifact;
}

function record(req, action, artifact, details = {}) {
  audit.log({
    userId: req.user.id, username: req.user.username,
    action, targetType: 'oci_compose_artifact', targetId: String(artifact.id || artifact),
    details, ip: getClientIp(req),
  });
}

router.get('/', requireAuth, requireRole('admin', 'operator'), (req, res) => {
  res.json(oci.list().filter(artifact => canAccess(req, artifact, 'view')));
});

router.post('/', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  try {
    const artifact = await oci.create(req.body || {}, req.user.id);
    record(req, 'oci_compose_create', artifact, {
      registry_id: artifact.registry_id, repository: artifact.repository,
      source_ref: artifact.source_ref, digest: artifact.digest,
      signature_policy: artifact.signature_policy, host_id: artifact.host_id,
    });
    res.status(201).json(artifact);
  } catch (err) { res.status(err.status || 400).json({ error: err.message, code: err.code }); }
}));

router.get('/:id', requireAuth, requireRole('admin', 'operator'), (req, res) => {
  const artifact = requireArtifactAccess(req, res, 'view');
  if (!artifact) return;
  res.json(artifact);
});

router.get('/:id/history', requireAuth, requireRole('admin', 'operator'), (req, res) => {
  if (!requireArtifactAccess(req, res, 'view')) return;
  res.json(oci.history(req.params.id, req.query.limit));
});

router.post('/:id/refresh', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  try {
    const before = oci.get(req.params.id);
    const artifact = await oci.refresh(req.params.id);
    record(req, 'oci_compose_refresh', artifact, { previous_digest: before.digest, digest: artifact.digest });
    res.json(artifact);
  } catch (err) { res.status(err.status || 500).json({ error: err.message, code: err.code }); }
}));

router.post('/:id/plan', requireAuth, requireRole('admin', 'operator'), asyncHandler(async (req, res) => {
  try {
    if (!requireArtifactAccess(req, res, 'operate')) return;
    const plan = oci.plan(req.params.id, req.user.id);
    record(req, 'oci_compose_plan', req.params.id, { digest: plan.digest, plan_hash: plan.planHash });
    res.json(plan);
  } catch (err) { res.status(err.status || 500).json({ error: err.message, code: err.code }); }
}));

router.post('/:id/deploy', requireAuth, requireRole('admin', 'operator'), writeable, asyncHandler(async (req, res) => {
  try {
    if (!requireArtifactAccess(req, res, 'operate')) return;
    const result = oci.deploy(req.params.id, req.body?.planHash, req.user.id);
    record(req, 'oci_compose_deploy', result.artifact, { digest: result.artifact.digest });
    res.json(result);
  } catch (err) { res.status(err.status || 500).json({ error: err.message, code: err.code }); }
}));

router.post('/:id/down', requireAuth, requireRole('admin', 'operator'), writeable, asyncHandler(async (req, res) => {
  try {
    if (!requireArtifactAccess(req, res, 'operate')) return;
    const result = oci.down(req.params.id, req.user.id);
    record(req, 'oci_compose_down', result.artifact, { digest: result.artifact.digest });
    res.json(result);
  } catch (err) { res.status(err.status || 500).json({ error: err.message, code: err.code }); }
}));

router.delete('/:id', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const artifact = oci.get(req.params.id);
    const result = oci.remove(req.params.id);
    record(req, 'oci_compose_delete', artifact || req.params.id, artifact ? { digest: artifact.digest } : {});
    res.json(result);
  } catch (err) { res.status(err.status || 400).json({ error: err.message, code: err.code }); }
});

module.exports = router;
