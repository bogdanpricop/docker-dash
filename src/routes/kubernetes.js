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
const virtualization = require('../services/kubernetes-virtualization');
const convergence = require('../services/kubernetes-convergence');
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

function virtualizationRoute(handler) {
  return async (req, res, next) => {
    try { await handler(req, res); } catch (error) {
      if (['KubernetesVirtualizationError', 'KubernetesConvergenceError'].includes(error.name)) {
        return res.status(error.status || 400).json({ error: error.message, code: error.code, details: error.details });
      }
      next(error);
    }
  };
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

// ─── v8.62.0 — B301-B305: KubeVirt convergence ─────────────

router.get('/virtualization/capabilities', requireAuth, virtualizationRoute(async (req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  res.json(await virtualization.discover(row));
}));

router.post('/virtualization/capabilities/refresh', requireAuth, requireRole('admin'), writeable,
  virtualizationRoute(async (req, res) => {
    const row = _getK8sHost(req, res); if (!row) return;
    const snapshot = await virtualization.refreshDiscovery(row, req.user);
    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'kubevirt_capability_snapshot', targetType: 'host', targetId: String(req.hostId),
      details: { platform: snapshot.platform, evidenceHash: snapshot.evidenceHash, duplicate: snapshot.duplicate,
        providerMutationsStarted: 0 }, ip: getClientIp(req) });
    res.status(snapshot.duplicate ? 200 : 201).json({ snapshot });
  }));

router.get('/virtualization/inventory', requireAuth, virtualizationRoute(async (req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  res.json(await virtualization.inventory(row, req.query.namespace || undefined));
}));

router.post('/virtualization/inventory/refresh', requireAuth, requireRole('admin'), writeable,
  virtualizationRoute(async (req, res) => {
    const row = _getK8sHost(req, res); if (!row) return;
    const snapshot = await virtualization.refreshInventory(row, req.body?.namespace || undefined, req.user);
    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'kubevirt_inventory_snapshot', targetType: 'host', targetId: String(req.hostId),
      details: { namespace: snapshot.namespace, vmCount: snapshot.vmCount, migrationCount: snapshot.migrationCount,
        evidenceHash: snapshot.evidenceHash, duplicate: snapshot.duplicate, providerMutationsStarted: 0 }, ip: getClientIp(req) });
    res.status(snapshot.duplicate ? 200 : 201).json({ snapshot });
  }));

router.get('/virtualization/openshift', requireAuth, virtualizationRoute(async (req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  res.json(await virtualization.openShiftOverview(row, req.query.namespace || 'default'));
}));

router.get('/virtualization/harvester', requireAuth, virtualizationRoute(async (req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  res.json(await virtualization.harvesterOverview(row, req.query.namespace || 'default'));
}));

router.get('/virtualization/vms/:ns/:name/yaml', requireAuth, virtualizationRoute(async (req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  res.json(await virtualization.virtualMachineYaml(row, req.params.ns, req.params.name));
}));

router.post('/virtualization/vms/:ns/:name/dry-run', requireAuth, requireRole('admin'), writeable,
  virtualizationRoute(async (req, res) => {
    const row = _getK8sHost(req, res); if (!row) return;
    const result = await virtualization.dryRunVirtualMachine(row, req.params.ns, req.params.name, req.body?.yaml, req.user);
    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'kubevirt_vm_yaml_dry_run', targetType: 'kubevirt_vm',
      targetId: `${req.params.ns}/${req.params.name}`,
      details: { hostId: req.hostId, status: result.status, originalHash: result.originalHash,
        desiredHash: result.desiredHash, validationHash: result.validationHash, applied: false }, ip: getClientIp(req) });
    res.status(result.duplicate ? 200 : 201).json({ validation: result });
  }));

router.get('/virtualization/evidence', requireAuth, requireRole('admin'), virtualizationRoute((req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  res.json(virtualization.evidence(row.id, req.user));
}));

// ─── v8.63.0 — B306-B315: CDI/template/storage/network convergence ───

router.get('/virtualization/convergence/:kind', requireAuth, virtualizationRoute(async (req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  res.json(await convergence.liveEvidence(row, req.params.kind, req.query.namespace || undefined));
}));

router.post('/virtualization/convergence/:kind/refresh', requireAuth, requireRole('admin'), writeable,
  virtualizationRoute(async (req, res) => {
    const row = _getK8sHost(req, res); if (!row) return;
    const snapshot = await convergence.refreshEvidence(row, req.params.kind, req.body?.namespace || undefined, req.user);
    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'kubevirt_convergence_snapshot', targetType: 'host', targetId: String(req.hostId),
      details: { kind: snapshot.kind, namespace: snapshot.namespace, evidenceHash: snapshot.evidenceHash,
        duplicate: snapshot.duplicate, providerMutationsStarted: 0 }, ip: getClientIp(req) });
    res.status(snapshot.duplicate ? 200 : 201).json({ snapshot });
  }));

router.get('/virtualization/convergence-snapshots', requireAuth, requireRole('admin'), virtualizationRoute((req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  res.json({ snapshots: convergence.snapshots(row.id, req.user) });
}));

router.post('/virtualization/datavolumes/plans', requireAuth, requireRole('admin'), writeable,
  virtualizationRoute(async (req, res) => {
    const row = _getK8sHost(req, res); if (!row) return;
    const plan = await convergence.planDataVolume(row, req.body || {}, req.user);
    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'kubevirt_datavolume_plan', targetType: 'kubevirt_change_plan', targetId: String(plan.id),
      details: { namespace: plan.namespace, resourceName: plan.resourceName, planHash: plan.planHash,
        approvalId: plan.approvalId, duplicate: plan.duplicate, providerMutationsStarted: 0 }, ip: getClientIp(req) });
    res.status(plan.duplicate ? 200 : 201).json({ plan });
  }));

router.post('/virtualization/templates/plans', requireAuth, requireRole('admin'), writeable,
  virtualizationRoute(async (req, res) => {
    const row = _getK8sHost(req, res); if (!row) return;
    const plan = await convergence.planTemplateInstantiation(row, req.body || {}, req.user);
    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'kubevirt_template_plan', targetType: 'kubevirt_change_plan', targetId: String(plan.id),
      details: { namespace: plan.namespace, resourceName: plan.resourceName, planHash: plan.planHash,
        approvalId: plan.approvalId, duplicate: plan.duplicate, providerMutationsStarted: 0 }, ip: getClientIp(req) });
    res.status(plan.duplicate ? 200 : 201).json({ plan });
  }));

router.get('/virtualization/change-plans', requireAuth, requireRole('admin'), virtualizationRoute((req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  res.json({ plans: convergence.plans(row.id, req.user) });
}));

router.get('/virtualization/change-plans/:id/events', requireAuth, requireRole('admin'), virtualizationRoute((req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  res.json({ events: convergence.operationEvents(req.params.id, req.user) });
}));

router.post('/virtualization/change-plans/:id/execute', requireAuth, requireRole('admin'), writeable,
  virtualizationRoute(async (req, res) => {
    const row = _getK8sHost(req, res); if (!row) return;
    const plan = await convergence.executePlan(row, req.params.id, req.body || {}, req.user);
    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'kubevirt_change_execute', targetType: 'kubevirt_change_plan', targetId: String(plan.id),
      details: { kind: plan.kind, namespace: plan.namespace, resourceName: plan.resourceName,
        planHash: plan.planHash, approvalId: plan.approvalId, operationRef: plan.operationRef,
        state: plan.state, providerMutationStarted: plan.state === 'succeeded' }, ip: getClientIp(req) });
    res.json({ plan });
  }));

router.get('/virtualization/migration-policies', requireAuth, requireRole('admin'), virtualizationRoute(async (req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  res.json(await convergence.migrationPolicies(row, req.user));
}));

router.post('/virtualization/migration-policies', requireAuth, requireRole('admin'), writeable,
  virtualizationRoute((req, res) => {
    const row = _getK8sHost(req, res); if (!row) return;
    const policy = convergence.saveMigrationPolicy(row, req.body || {}, req.user);
    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'kubevirt_migration_policy_save', targetType: 'kubevirt_migration_policy', targetId: String(policy.id),
      details: { policyHash: policy.policyHash, applySupported: false, providerMutationsStarted: 0 }, ip: getClientIp(req) });
    res.status(201).json({ policy });
  }));

module.exports = router;
