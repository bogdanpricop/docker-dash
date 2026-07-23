'use strict';

const { Router } = require('express');
const dockerService = require('../services/docker');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const { extractHostId } = require('../middleware/hostId');
const asyncHandler = require('../utils/asyncHandler');
const { humanizeDockerError } = require('../utils/docker-errors');

const router = Router();
router.use(extractHostId);

// Swarm lifecycle ops (init/leave) are admin-only and their failures come
// straight from the Docker daemon. Turn that into a plain, human message
// (shared humanizer) instead of a generic 500.
function swarmError(err) {
  return { error: humanizeDockerError(err) };
}

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
  let result;
  try {
    result = await docker.swarmInit({
      ListenAddr: listenAddr || '0.0.0.0:2377',
      AdvertiseAddr: advertiseAddr || undefined,
    });
  } catch (err) {
    return res.status(400).json(swarmError(err));
  }
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
  try {
    await docker.swarmLeave({ Force: !!req.body.force });
  } catch (err) {
    return res.status(400).json(swarmError(err));
  }
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

// POST /api/swarm/stacks/:name — deploy a compose YAML as a Swarm stack.
// Analog of the CLI `docker stack deploy -c file.yml <name>`.
//
// This is intentionally a MINIMAL first implementation covering the most
// common compose fields; anything not listed here is ignored on purpose
// with a message in the response so the operator knows what was skipped:
//
//   Supported (per service):
//     - image (required)
//     - command (string or array)
//     - environment (object or "KEY=VAL" array)
//     - ports (list of published:target[/proto] strings)
//     - labels (object)
//     - deploy.replicas (default 1)
//     - deploy.mode: replicated | global
//     - deploy.restart_policy.{condition,delay,max_attempts}
//     - deploy.placement.constraints (list)
//
//   Skipped (with warning): secrets, configs, extends, healthcheck,
//   deploy.resources, deploy.update_config, volumes with anonymous mounts,
//   depends_on, networks (services join default), networks: top-level
//   creation, secrets/configs top-level creation.
//
// Existing services in the stack are updated in-place (dockerode create
// vs update — future improvement). If a service with the composed name
// already exists it's removed and recreated, which is destructive but
// matches CLI behavior on first `docker stack deploy` runs when a swarm
// name collision exists.
router.post('/stacks/:name', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const stackName = req.params.name;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(stackName)) {
    return res.status(400).json({ error: 'Invalid stack name (alphanumeric, dot, underscore, dash; up to 63 chars)' });
  }
  const { compose } = req.body || {};
  if (!compose || typeof compose !== 'string') {
    return res.status(400).json({ error: 'compose (YAML string) is required' });
  }
  if (compose.length > 512 * 1024) {
    return res.status(413).json({ error: 'compose YAML exceeds 512 KB — split or simplify' });
  }
  const YAML = require('yaml');
  let doc;
  try { doc = YAML.parse(compose); }
  catch (e) { return res.status(400).json({ error: `YAML parse error: ${e.message}` }); }
  if (!doc || typeof doc.services !== 'object' || doc.services === null) {
    return res.status(400).json({ error: 'compose must have a top-level "services:" map' });
  }
  const services = doc.services;
  const svcNames = Object.keys(services);
  if (svcNames.length === 0) return res.status(400).json({ error: 'no services declared' });
  if (svcNames.length > 100) {
    return res.status(413).json({ error: 'more than 100 services in a single stack — split the compose file' });
  }

  const skipped = new Set();
  const results = [];
  const docker = dockerService.getDocker(req.hostId);

  // Helpers
  const envToArray = (env) => {
    if (!env) return [];
    if (Array.isArray(env)) return env.map(String);
    if (typeof env === 'object') {
      return Object.entries(env).map(([k, v]) => `${k}=${v == null ? '' : v}`);
    }
    return [];
  };
  const parsePorts = (ports) => {
    if (!Array.isArray(ports)) return [];
    const out = [];
    for (const p of ports) {
      let m;
      if (typeof p === 'string') {
        // "8080:80" or "8080:80/tcp" or "8080:80/udp"
        m = /^(\d+):(\d+)(?:\/(tcp|udp))?$/.exec(p);
      } else if (p && typeof p === 'object' && p.target && p.published) {
        m = [null, String(p.published), String(p.target), p.protocol || 'tcp'];
      }
      if (m) {
        out.push({
          Protocol: (m[3] || 'tcp'),
          PublishedPort: parseInt(m[1], 10),
          TargetPort: parseInt(m[2], 10),
          PublishMode: 'ingress',
        });
      } else {
        skipped.add('port-form-unsupported');
      }
    }
    return out;
  };

  for (const svcName of svcNames) {
    const svc = services[svcName];
    if (!svc || typeof svc !== 'object') {
      results.push({ service: svcName, ok: false, error: 'service entry must be a map' });
      continue;
    }
    if (!svc.image) {
      results.push({ service: svcName, ok: false, error: 'image is required' });
      continue;
    }
    if (svc.secrets) skipped.add('secrets');
    if (svc.configs) skipped.add('configs');
    if (svc.healthcheck) skipped.add('healthcheck');
    if (svc.depends_on) skipped.add('depends_on');
    if (svc.networks) skipped.add('networks-per-service');
    if (svc.volumes) skipped.add('volumes');
    if (svc.extends) skipped.add('extends');
    const deploy = (svc.deploy && typeof svc.deploy === 'object') ? svc.deploy : {};
    if (deploy.resources) skipped.add('deploy.resources');
    if (deploy.update_config) skipped.add('deploy.update_config');

    const mode = deploy.mode === 'global'
      ? { Global: {} }
      : { Replicated: { Replicas: parseInt(deploy.replicas, 10) || 1 } };
    const restartPolicy = (deploy.restart_policy && typeof deploy.restart_policy === 'object') ? {
      Condition: deploy.restart_policy.condition || 'any',
      Delay: (parseInt(deploy.restart_policy.delay, 10) || 5) * 1e9,
      MaxAttempts: parseInt(deploy.restart_policy.max_attempts, 10) || 0,
    } : { Condition: 'any', Delay: 5e9, MaxAttempts: 0 };
    const constraints = (deploy.placement && Array.isArray(deploy.placement.constraints))
      ? deploy.placement.constraints.map(String) : [];

    const fullName = `${stackName}_${svcName}`;
    const spec = {
      Name: fullName,
      Labels: {
        ...(svc.labels && typeof svc.labels === 'object' ? svc.labels : {}),
        'com.docker.stack.namespace': stackName,
      },
      TaskTemplate: {
        ContainerSpec: {
          Image: String(svc.image),
          Command: Array.isArray(svc.command) ? svc.command.map(String)
                 : (typeof svc.command === 'string' ? svc.command.split(' ') : undefined),
          Env: envToArray(svc.environment),
          Labels: {
            'com.docker.stack.namespace': stackName,
          },
        },
        RestartPolicy: restartPolicy,
        Placement: constraints.length ? { Constraints: constraints } : undefined,
      },
      Mode: mode,
      EndpointSpec: (() => {
        const ports = parsePorts(svc.ports);
        return ports.length ? { Ports: ports } : undefined;
      })(),
    };

    try {
      // If a service with the composed name already exists, remove it
      // first. Matches CLI first-run behavior; a follow-up release could
      // instead do an in-place update via getService().update().
      try {
        const existing = docker.getService(fullName);
        await existing.inspect();
        await existing.remove();
      } catch { /* not found — normal on first deploy */ }
      const created = await docker.createService(spec);
      results.push({ service: svcName, ok: true, id: created.id, name: fullName });
    } catch (err) {
      results.push({ service: svcName, ok: false, error: err.message });
    }
  }

  const okCount = results.filter(r => r.ok).length;
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'swarm_stack_deploy', targetType: 'swarm_stack', targetId: stackName,
    details: { hostId: req.hostId, services: results.length, succeeded: okCount, skipped: [...skipped] },
    ip: getClientIp(req),
  });
  res.status(okCount === results.length ? 200 : 207).json({
    ok: okCount === results.length,
    stack: stackName,
    services: results,
    skippedFeatures: [...skipped],
  });
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
