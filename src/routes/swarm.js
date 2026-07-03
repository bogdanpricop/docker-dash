'use strict';

const { Router } = require('express');
const dockerService = require('../services/docker');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const { extractHostId } = require('../middleware/hostId');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();
router.use(extractHostId);

// ── Swarm status ───────────────────────────────────────────────

// GET /api/swarm — swarm info + node count
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const docker = dockerService.getDocker(req.hostId);
  const info = await docker.info();
  if (!info.Swarm || info.Swarm.LocalNodeState === 'inactive') {
    return res.json({ active: false });
  }
  const swarm = await docker.swarmInspect();
  res.json({ active: true, info: info.Swarm, swarm });
}));

// POST /api/swarm/init — initialize a new swarm
router.post('/init', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const { advertiseAddr, listenAddr } = req.body;
  const docker = dockerService.getDocker(req.hostId);
  const result = await docker.swarmInit({
    ListenAddr: listenAddr || '0.0.0.0:2377',
    AdvertiseAddr: advertiseAddr || undefined,
  });
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'swarm_init', targetType: 'swarm', targetId: 'local',
    ip: getClientIp(req),
  });
  res.json({ ok: true, nodeId: result });
}));

// POST /api/swarm/leave — leave swarm
router.post('/leave', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const docker = dockerService.getDocker(req.hostId);
  await docker.swarmLeave({ Force: !!req.body.force });
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'swarm_leave', targetType: 'swarm', targetId: 'local',
    ip: getClientIp(req),
  });
  res.json({ ok: true });
}));

// GET /api/swarm/join-token — get worker/manager join tokens
router.get('/join-token', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const docker = dockerService.getDocker(req.hostId);
  const swarm = await docker.swarmInspect();
  res.json({
    worker: swarm.JoinTokens?.Worker,
    manager: swarm.JoinTokens?.Manager,
  });
}));

// ── Nodes ──────────────────────────────────────────────────────

// GET /api/swarm/nodes
router.get('/nodes', requireAuth, asyncHandler(async (req, res) => {
  const docker = dockerService.getDocker(req.hostId);
  const nodes = await docker.listNodes();
  res.json(nodes);
}));

// PATCH /api/swarm/nodes/:id — update node availability/role
router.patch('/nodes/:id', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const docker = dockerService.getDocker(req.hostId);
  const node = docker.getNode(req.params.id);
  const inspect = await node.inspect();
  const { availability, role } = req.body;
  await node.update({
    version: inspect.Version.Index,
    Availability: availability || inspect.Spec.Availability,
    Role: role || inspect.Spec.Role,
    Labels: inspect.Spec.Labels || {},
  });
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'swarm_node_update', targetType: 'swarm_node', targetId: req.params.id,
    details: { availability, role }, ip: getClientIp(req),
  });
  res.json({ ok: true });
}));

// DELETE /api/swarm/nodes/:id — remove node (must be drained first)
router.delete('/nodes/:id', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const docker = dockerService.getDocker(req.hostId);
  await docker.getNode(req.params.id).remove({ force: !!req.query.force });
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'swarm_node_remove', targetType: 'swarm_node', targetId: req.params.id,
    ip: getClientIp(req),
  });
  res.json({ ok: true });
}));

// ── Services ───────────────────────────────────────────────────

// GET /api/swarm/services
router.get('/services', requireAuth, asyncHandler(async (req, res) => {
  const docker = dockerService.getDocker(req.hostId);
  const services = await docker.listServices({ status: true });
  res.json(services);
}));

// GET /api/swarm/services/:id — dynamic 404/500 status, leave alone
router.get('/services/:id', requireAuth, async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    const svc = await docker.getService(req.params.id).inspect();
    res.json(svc);
  } catch (err) {
    res.status(err.statusCode === 404 ? 404 : 500).json({ error: err.message });
  }
});

// POST /api/swarm/services — create service
router.post('/services', requireAuth, requireRole('admin', 'operator'), writeable, asyncHandler(async (req, res) => {
  const { name, image, replicas, ports, env, constraints, labels } = req.body;
  if (!name || !image) return res.status(400).json({ error: 'name and image are required' });

  const docker = dockerService.getDocker(req.hostId);
  const spec = {
    Name: name,
    TaskTemplate: {
      ContainerSpec: {
        Image: image,
        Env: env || [],
      },
      RestartPolicy: { Condition: 'any', Delay: 5000000000, MaxAttempts: 3 },
      Placement: constraints?.length ? { Constraints: constraints } : undefined,
    },
    Mode: { Replicated: { Replicas: parseInt(replicas) || 1 } },
    Labels: labels || {},
    EndpointSpec: ports?.length ? {
      Ports: ports.map(p => ({
        Protocol: p.protocol || 'tcp',
        TargetPort: parseInt(p.target),
        PublishedPort: parseInt(p.published),
        PublishMode: p.mode || 'ingress',
      })),
    } : undefined,
  };

  const svc = await docker.createService(spec);
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'swarm_service_create', targetType: 'swarm_service', targetId: name,
    details: { image, replicas }, ip: getClientIp(req),
  });
  res.status(201).json({ ok: true, id: svc.id });
}));

// POST /api/swarm/services/:id/scale — scale service
router.post('/services/:id/scale', requireAuth, requireRole('admin', 'operator'), writeable, asyncHandler(async (req, res) => {
  const { replicas } = req.body;
  if (replicas === undefined) return res.status(400).json({ error: 'replicas required' });
  const docker = dockerService.getDocker(req.hostId);
  const svc = docker.getService(req.params.id);
  const inspect = await svc.inspect();
  await svc.update({
    version: inspect.Version.Index,
    ...inspect.Spec,
    Mode: { Replicated: { Replicas: parseInt(replicas) } },
  });
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'swarm_service_scale', targetType: 'swarm_service', targetId: req.params.id,
    details: { replicas }, ip: getClientIp(req),
  });
  res.json({ ok: true });
}));

// DELETE /api/swarm/services/:id
router.delete('/services/:id', requireAuth, requireRole('admin', 'operator'), writeable, asyncHandler(async (req, res) => {
  const docker = dockerService.getDocker(req.hostId);
  await docker.getService(req.params.id).remove();
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'swarm_service_remove', targetType: 'swarm_service', targetId: req.params.id,
    ip: getClientIp(req),
  });
  res.json({ ok: true });
}));

// ── Tasks ──────────────────────────────────────────────────────

// GET /api/swarm/tasks?service=id — list tasks (optionally filtered by service)
router.get('/tasks', requireAuth, asyncHandler(async (req, res) => {
  const docker = dockerService.getDocker(req.hostId);
  const filters = req.query.service ? { service: [req.query.service] } : {};
  const tasks = await docker.listTasks({ filters: JSON.stringify(filters) });
  res.json(tasks);
}));

// ── Stacks (v8.8.0, Sprint 2) ──────────────────────────────────
//
// Docker Compose / `docker stack deploy` both label services with
// com.docker.stack.namespace=<stack>. We derive the stack list by
// grouping services by that label. Services without the label belong
// to the synthetic "_standalone" bucket (freestanding `docker service
// create`), which the UI can either hide or show as "Standalone services".

router.get('/stacks', requireAuth, asyncHandler(async (req, res) => {
  const docker = dockerService.getDocker(req.hostId);
  const services = await docker.listServices({ status: true });
  const tasks = await docker.listTasks();
  const byStack = new Map();
  for (const svc of services) {
    const label = (svc.Spec && svc.Spec.Labels) || {};
    const stackName = label['com.docker.stack.namespace'] || '_standalone';
    if (!byStack.has(stackName)) {
      byStack.set(stackName, {
        name: stackName,
        services: 0,
        replicas: { desired: 0, running: 0 },
        createdAt: svc.CreatedAt,
      });
    }
    const entry = byStack.get(stackName);
    entry.services++;
    const rep = svc.Spec && svc.Spec.Mode && svc.Spec.Mode.Replicated;
    const desired = rep ? (rep.Replicas || 0) : 0;
    const running = tasks.filter(t => t.ServiceID === svc.ID
      && t.Status && t.Status.State === 'running').length;
    entry.replicas.desired += desired;
    entry.replicas.running += running;
    if (svc.CreatedAt && svc.CreatedAt < entry.createdAt) entry.createdAt = svc.CreatedAt;
  }
  res.json(Array.from(byStack.values()).sort((a, b) => a.name.localeCompare(b.name)));
}));

// DELETE a whole stack — removes every service labeled with the
// stack namespace. Volumes and networks persist (matches CLI
// `docker stack rm` semantics; operator does volume cleanup separately).
router.delete('/stacks/:name', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const docker = dockerService.getDocker(req.hostId);
  const services = await docker.listServices({
    filters: JSON.stringify({ label: [`com.docker.stack.namespace=${req.params.name}`] }),
  });
  if (services.length === 0) return res.status(404).json({ error: 'Stack not found' });
  let removed = 0;
  for (const svc of services) {
    try { await docker.getService(svc.ID).remove(); removed++; }
    catch { /* best-effort; report count in response */ }
  }
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'swarm_stack_remove', targetType: 'swarm_stack', targetId: req.params.name,
    details: { servicesRemoved: removed, servicesFound: services.length },
    ip: getClientIp(req),
  });
  res.json({ ok: true, servicesRemoved: removed, servicesFound: services.length });
}));

module.exports = router;
