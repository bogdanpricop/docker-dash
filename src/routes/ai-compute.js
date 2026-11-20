'use strict';

const router = require('express').Router();
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { extractHostId } = require('../middleware/hostId');
const { requireHostAccessForMethod } = require('../middleware/hostAccess');
const { getDb } = require('../db');
const service = require('../services/ai-compute');
const metrics = require('../services/ai-compute-metrics');
const policy = require('../services/provider-operations/policy');
const audit = require('../services/audit');

router.use(requireAuth, requireRole('admin'));
// Fleet discovery must work even when the sidebar selects an unrelated provider.
router.get('/hosts', (_req, res) => res.set('Cache-Control', 'no-store').json(service.hosts()));
router.use(extractHostId, requireHostAccessForMethod());
router.use((req, res, next) => {
  const host = getDb().prepare('SELECT daemon_type FROM docker_hosts WHERE id=?').get(req.resolvedHostId);
  if (!host || !['docker', 'podman'].includes(host.daemon_type || 'docker')) return res.status(400).json({ error: 'Select a Docker host for AI Compute' });
  res.set('Cache-Control', 'no-store');
  next();
});
const handle = fn => async (req, res, next) => {
  try { res.json(await fn(req)); }
  catch (err) { if (err.status) res.status(err.status).json({ error: err.message }); else next(err); }
};
const hostId = req => req.resolvedHostId;
const change = (req, action, details) => {
  policy.assertAllowed({ providerType: 'docker', hostId: hostId(req) });
  audit.log({ userId: req.user.id, username: req.user.username, action, targetType: 'ai_compute', targetId: String(hostId(req)), details });
};

router.get('/inventory', handle(async req => ({ ...await service.inventory(hostId(req)), hostName: req.hostName })));
router.get('/catalog', handle(req => service.catalogForHost(hostId(req))));
router.get('/metrics', handle(req => metrics.sample(hostId(req))));
router.get('/history', handle(req => metrics.history(hostId(req), req.query.hours || 1)));
router.get('/jobs', handle(req => service.jobs(hostId(req))));
router.get('/jobs/:id', handle(req => service.getJob(hostId(req), req.params.id)));
router.post('/monitoring', writeable, handle(req => {
  change(req, 'ai_compute_monitoring', { enabled: req.body.enabled });
  return service.monitoring(hostId(req), req.body.enabled);
}));
router.post('/profiles', writeable, handle(async req => {
  change(req, 'ai_compute_profile', { containerId: req.body.containerId });
  return service.register(hostId(req), req.body, req.user);
}));
router.post('/probe', writeable, handle(async req => {
  const { containers } = await service.inventory(hostId(req));
  const c = containers.find(c => c.id === req.body.containerId);
  if (!c) throw Object.assign(new Error('Workload not found'), { status: 404 });
  change(req, 'ai_compute_probe', { containerId: c.id });
  return service.readiness(hostId(req), c.id, c.readyPort, c.engine);
}));
router.post('/cache', writeable, handle(req => {
  change(req, 'ai_compute_cache_inspect', { containerId: req.body.containerId });
  return service.cache(hostId(req), req.body.containerId);
}));
router.post('/plans', writeable, handle(req => service.prepare(hostId(req), req.body, req.user)));
router.post('/plans/:id/execute', writeable, handle(req => service.execute(hostId(req), req.params.id, req.user)));
router.post('/jobs/:id/rollback', writeable, handle(req => service.rollback(hostId(req), req.params.id, req.user)));

module.exports = router;
