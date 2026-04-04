'use strict';

const { Router } = require('express');
const dockerService = require('../services/docker');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const { extractHostId } = require('../middleware/hostId');

const router = Router();
router.use(extractHostId);

// ── Swarm status ───────────────────────────────────────────────

// GET /api/swarm — swarm info + node count
router.get('/', requireAuth, async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    const info = await docker.info();
    if (!info.Swarm || info.Swarm.LocalNodeState === 'inactive') {
      return res.json({ active: false });
    }
    const swarm = await docker.swarmInspect();
    res.json({ active: true, info: info.Swarm, swarm });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/swarm/init — initialize a new swarm
router.post('/init', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/swarm/leave — leave swarm
router.post('/leave', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    await docker.swarmLeave({ Force: !!req.body.force });
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'swarm_leave', targetType: 'swarm', targetId: 'local',
      ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/swarm/join-token — get worker/manager join tokens
router.get('/join-token', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    const swarm = await docker.swarmInspect();
    res.json({
      worker: swarm.JoinTokens?.Worker,
      manager: swarm.JoinTokens?.Manager,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Nodes ──────────────────────────────────────────────────────

// GET /api/swarm/nodes
router.get('/nodes', requireAuth, async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    const nodes = await docker.listNodes();
    res.json(nodes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/swarm/nodes/:id — update node availability/role
router.patch('/nodes/:id', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/swarm/nodes/:id — remove node (must be drained first)
router.delete('/nodes/:id', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    await docker.getNode(req.params.id).remove({ force: !!req.query.force });
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'swarm_node_remove', targetType: 'swarm_node', targetId: req.params.id,
      ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Services ───────────────────────────────────────────────────

// GET /api/swarm/services
router.get('/services', requireAuth, async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    const services = await docker.listServices({ status: true });
    res.json(services);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/swarm/services/:id
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
router.post('/services', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  try {
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/swarm/services/:id/scale — scale service
router.post('/services/:id/scale', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  try {
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/swarm/services/:id
router.delete('/services/:id', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    await docker.getService(req.params.id).remove();
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'swarm_service_remove', targetType: 'swarm_service', targetId: req.params.id,
      ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Tasks ──────────────────────────────────────────────────────

// GET /api/swarm/tasks?service=id — list tasks (optionally filtered by service)
router.get('/tasks', requireAuth, async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    const filters = req.query.service ? { service: [req.query.service] } : {};
    const tasks = await docker.listTasks({ filters: JSON.stringify(filters) });
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
