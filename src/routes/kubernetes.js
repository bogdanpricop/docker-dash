'use strict';

// v8.9.4-alpha.1 — Sprint 5 (Kubernetes) routes. Read-only in this alpha.
//
// SECURITY: read-only routes require requireAuth. State-changing routes
// (deferred to alpha.2) will additionally require admin + writeable +
// audit_log per CLAUDE.md convention.
//
// ADDRESSING MODEL: per-host, per docker-dash convention. Each cluster
// is a docker_hosts row with daemon_type='kubernetes'. All routes take
// the host id via X-Host-ID header (extractHostId middleware).
//
// STATUS: alpha.1. Read of namespaces / pods / deployments / services /
// nodes shipped. Write ops (scale, rollout-restart, delete pod) deferred
// to alpha.2.

const { Router } = require('express');
const { getDb } = require('../db');
const { fromHostRow, buildKubeconfig } = require('../services/kubernetes');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { extractHostId } = require('../middleware/hostId');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();
router.use(extractHostId);

// Reusable guard: verify the target host is registered AND is k8s.
function _getK8sHost(req, res) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM docker_hosts WHERE id = ?').get(req.hostId);
  if (!row) { res.status(404).json({ error: `Host ${req.hostId} not found` }); return null; }
  if (row.daemon_type !== 'kubernetes') {
    res.status(400).json({
      error: `Host ${req.hostId} (${row.name}) is not a Kubernetes daemon (daemon_type=${row.daemon_type})`,
    });
    return null;
  }
  return row;
}

// ─── Health probe ───────────────────────────────────────────

router.get('/version', requireAuth, asyncHandler(async (req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  const client = fromHostRow(row);
  res.json(await client.version());
}));

// ─── Namespaces ─────────────────────────────────────────────

router.get('/namespaces', requireAuth, asyncHandler(async (req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  const client = fromHostRow(row);
  res.json(await client.listNamespaces());
}));

// ─── Pods ───────────────────────────────────────────────────

router.get('/pods', requireAuth, asyncHandler(async (req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  const client = fromHostRow(row);
  const ns = req.query.namespace || undefined;
  res.json(await client.listPods(ns));
}));

// ─── Deployments ────────────────────────────────────────────

router.get('/deployments', requireAuth, asyncHandler(async (req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  const client = fromHostRow(row);
  const ns = req.query.namespace || undefined;
  res.json(await client.listDeployments(ns));
}));

// ─── Services ───────────────────────────────────────────────

router.get('/services', requireAuth, asyncHandler(async (req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  const client = fromHostRow(row);
  const ns = req.query.namespace || undefined;
  res.json(await client.listServices(ns));
}));

// ─── Nodes ──────────────────────────────────────────────────

router.get('/nodes', requireAuth, asyncHandler(async (req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  const client = fromHostRow(row);
  res.json(await client.listNodes());
}));

// ─── v8.9.7-alpha.1 — Portainer G13 closure: Ingress + NetworkPolicy read ───

router.get('/ingresses', requireAuth, asyncHandler(async (req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  const ns = req.query.namespace || undefined;
  res.json(await fromHostRow(row).listIngresses(ns));
}));

router.get('/networkpolicies', requireAuth, asyncHandler(async (req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  const ns = req.query.namespace || undefined;
  res.json(await fromHostRow(row).listNetworkPolicies(ns));
}));

// ─── v8.9.8-alpha.1 — Portainer G04 closure: Kubernetes write ops ───
// Admin-only writes with audit trail. Anti-features stay OUT per Sprint 5.

router.post('/deployments/:ns/:name/scale', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    const row = _getK8sHost(req, res); if (!row) return;
    const { replicas } = req.body || {};
    if (!Number.isInteger(replicas) || replicas < 0) {
      return res.status(400).json({ error: 'replicas must be a non-negative integer' });
    }
    try {
      const result = await fromHostRow(row).scaleDeployment(req.params.ns, req.params.name, replicas);
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'k8s_deployment_scale', targetType: 'k8s_deployment',
        targetId: `${req.params.ns}/${req.params.name}`,
        details: { hostId: req.hostId, replicas }, ip: getClientIp(req),
      });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, kubernetesResponse: err.kubernetesResponse });
    }
  })
);

router.post('/deployments/:ns/:name/restart', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    const row = _getK8sHost(req, res); if (!row) return;
    try {
      const result = await fromHostRow(row).restartDeployment(req.params.ns, req.params.name);
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'k8s_deployment_restart', targetType: 'k8s_deployment',
        targetId: `${req.params.ns}/${req.params.name}`,
        details: { hostId: req.hostId }, ip: getClientIp(req),
      });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, kubernetesResponse: err.kubernetesResponse });
    }
  })
);

router.delete('/pods/:ns/:name', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    const row = _getK8sHost(req, res); if (!row) return;
    try {
      const result = await fromHostRow(row).deletePod(req.params.ns, req.params.name);
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'k8s_pod_delete', targetType: 'k8s_pod',
        targetId: `${req.params.ns}/${req.params.name}`,
        details: { hostId: req.hostId }, ip: getClientIp(req),
      });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, kubernetesResponse: err.kubernetesResponse });
    }
  })
);

router.post('/nodes/:name/cordon', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    const row = _getK8sHost(req, res); if (!row) return;
    const unschedulable = req.body.unschedulable !== false;
    try {
      const result = await fromHostRow(row).cordonNode(req.params.name, unschedulable);
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: unschedulable ? 'k8s_node_cordon' : 'k8s_node_uncordon',
        targetType: 'k8s_node', targetId: req.params.name,
        details: { hostId: req.hostId }, ip: getClientIp(req),
      });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, kubernetesResponse: err.kubernetesResponse });
    }
  })
);

// ─── v8.9.8-alpha.1 — Portainer G05 closure: pod log streaming (SSE) ───
router.get('/pods/:ns/:name/logs', requireAuth, asyncHandler(async (req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  const container = req.query.container || undefined;
  const follow = req.query.follow !== '0';
  const tailLines = Math.min(parseInt(req.query.tailLines || '200', 10) || 200, 5000);
  res.set('Content-Type', 'text/event-stream');
  res.set('Cache-Control', 'no-cache');
  res.set('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const stream = fromHostRow(row).streamPodLogs(req.params.ns, req.params.name,
    { container, follow, tailLines });
  const write = (chunk) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.length) res.write(`data: ${line}\n\n`);
    }
  };
  stream.on('data', write);
  stream.on('error', (err) => { res.write(`event: error\ndata: ${err.message}\n\n`); res.end(); });
  stream.on('end', () => { res.write(`event: end\ndata: ok\n\n`); res.end(); });
  req.on('close', () => stream.destroy());
}));

// ─── v8.9.7-alpha.1 — Portainer G08 closure: kubeconfig download ───

router.get('/kubeconfig', requireAuth, asyncHandler(async (req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  const yaml = buildKubeconfig(row);
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'kubeconfig_download', targetType: 'host', targetId: String(req.hostId),
    ip: getClientIp(req),
  });
  res.set('Content-Type', 'application/yaml');
  res.set('Content-Disposition', `attachment; filename="kubeconfig-${row.name || 'k8s'}.yaml"`);
  res.send(yaml);
}));

module.exports = router;
