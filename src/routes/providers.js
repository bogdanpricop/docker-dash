'use strict';

const { Router } = require('express');
const config = require('../config');
const { getDb } = require('../db');
const providerSdk = require('../services/provider-sdk/registry');
const providerVmDetail = require('../services/provider-sdk/vm-detail');
const providerVmPower = require('../services/provider-operations/vm-power');
const providerVmSnapshots = require('../services/provider-operations/vm-snapshots');
const conformance = require('../services/provider-conformance');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { requireHostAccess } = require('../middleware/hostAccess');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

router.use((req, res, next) => config.features.providerSdkV2
  ? next() : res.status(404).json({ error: 'Provider SDK v2 is disabled' }));

function _isAdmin(user) {
  return user?.role === 'admin' || (Array.isArray(user?.roles) && user.roles.includes('admin'));
}

function _host(hostId) {
  const id = Number.parseInt(hostId, 10);
  if (!Number.isInteger(id) || id <= 0) return { error: { status: 400, message: 'Invalid provider host ID' } };
  const host = getDb().prepare('SELECT * FROM docker_hosts WHERE id = ?').get(id);
  if (!host) return { error: { status: 404, message: 'Provider host not found' } };
  if (!host.is_active) return { error: { status: 400, message: `Provider host "${host.name}" is not active` } };
  return { host };
}

function _conformanceError(res, err) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider conformance request failed' : err.message,
    code: err?.code || 'PROVIDER_CONFORMANCE_ERROR',
  });
}

function _powerError(res, err) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider VM power request failed' : err.message,
    code: err?.code || 'VM_POWER_ERROR',
    ...(status < 500 && err?.details ? { details: err.details } : {}),
  });
}

function _snapshotError(res, err) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({
    error: status >= 500 ? 'Provider VM snapshot request failed' : err.message,
    code: err?.code || 'VM_SNAPSHOT_ERROR',
    ...(status < 500 && err?.details ? { details: err.details } : {}),
  });
}

router.get('/manifests', requireAuth, (_req, res) => {
  res.json({ schemaVersion: '1.0', manifests: conformance.manifests.listManifests() });
});

router.get('/scorecard', requireAuth, (_req, res) => {
  res.json({ schemaVersion: '1.0', providers: conformance.scorecard() });
});

router.get('/conformance/export', requireAuth, requireRole('admin'), (req, res) => {
  const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
  try { res.json(conformance.exportEvidence(undefined, { limit })); }
  catch (err) { _conformanceError(res, err); }
});

router.get('/:hostId/conformance', requireAuth, requireHostAccess('view', { param: 'hostId' }), (req, res) => {
  const resolved = _host(req.params.hostId);
  if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  try {
    const items = conformance.listForHost(resolved.host.id, { limit });
    res.json({ schemaVersion: '1.0', count: items.length, items });
  } catch (err) { _conformanceError(res, err); }
});

router.get('/:hostId/conformance/:runId', requireAuth, requireHostAccess('view', { param: 'hostId' }), (req, res) => {
  const resolved = _host(req.params.hostId);
  if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  const run = conformance.get(req.params.runId);
  if (!run || run.hostId !== resolved.host.id) return res.status(404).json({ error: 'Provider conformance run not found' });
  res.json(run);
});

router.post('/:hostId/conformance', requireAuth, requireRole('admin'), requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
  const resolved = _host(req.params.hostId);
  if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
  if (req.body?.mode !== undefined && req.body.mode !== 'live_readonly') {
    return res.status(400).json({ error: 'Only live_readonly conformance is available', code: 'INVALID_CONFORMANCE_MODE' });
  }
  try {
    const run = await conformance.runForHost(resolved.host, { createdBy: req.user.id });
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'provider_conformance_run', targetType: 'host', targetId: String(resolved.host.id),
      details: { runId: run.id, provider: run.providerType, mode: run.mode, grade: run.grade, score: run.score, maxScore: run.maxScore, evidenceHash: run.evidenceHash },
      ip: getClientIp(req),
    });
    res.status(201).json(run);
  } catch (err) { _conformanceError(res, err); }
}));

router.get('/:hostId/capabilities', requireAuth, requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
  if (!config.features.providerSdkV2) return res.status(404).json({ error: 'Provider SDK v2 is disabled' });
  const hostId = Number.parseInt(req.params.hostId, 10);
  if (!Number.isInteger(hostId) || hostId <= 0) return res.status(400).json({ error: 'Invalid provider host ID' });
  const refresh = req.query.refresh === 'true' || req.query.refresh === '1';
  if (refresh && !_isAdmin(req.user)) {
    return res.status(403).json({ error: 'Capability refresh requires admin role' });
  }
  const host = getDb().prepare('SELECT * FROM docker_hosts WHERE id = ?').get(hostId);
  if (!host) return res.status(404).json({ error: 'Provider host not found' });
  if (!host.is_active) return res.status(400).json({ error: `Provider host "${host.name}" is not active` });
  try {
    const envelope = await providerSdk.capabilitiesForHost(host, { refresh });
    if (refresh) {
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_capability_refresh', targetType: 'host', targetId: String(hostId),
        details: {
          provider: host.daemon_type, status: envelope.probe.status,
          durationMs: envelope.probe.durationMs,
        },
        ip: getClientIp(req),
      });
    }
    res.json(envelope);
  } catch (err) {
    const status = Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).json({
      error: status >= 500 ? 'Provider capability discovery failed' : err.message,
      code: err?.code || 'PROVIDER_CAPABILITY_ERROR',
    });
  }
}));

router.post('/:hostId/virtual-machines/power/preflight', requireAuth,
  requireRole('admin', 'operator'), requireHostAccess('operate', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      res.json(await providerVmPower.preflightManyForHost(
        resolved.host, req.body?.resourceIds, req.body?.action, { canOperate: true }
      ));
    } catch (err) { _powerError(res, err); }
  }));

router.post('/:hostId/virtual-machines/power', requireAuth,
  requireRole('admin', 'operator'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerVmPower.submitManyForHost(resolved.host, req.body?.resourceIds, {
        ...req.body, idempotencyKey: req.get('Idempotency-Key'),
      }, { canOperate: true, createdBy: req.user.id });
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_vm_power_bulk_submit', targetType: 'host', targetId: String(resolved.host.id),
        details: {
          provider: resolved.host.daemon_type, action: result.preflight.action,
          count: result.operations.length, operationIds: result.operations.map(operation => operation.id),
          forced: providerVmPower.ACTIONS[result.preflight.action].force,
        }, ip: getClientIp(req),
      });
      res.status(202).json({
        schemaVersion: '1.0', count: result.operations.length,
        operations: result.operations, planHashes: result.preflight.plans.map(plan => plan.planHash),
      });
    } catch (err) { _powerError(res, err); }
  }));

router.post('/:hostId/virtual-machines/:resourceId/power/preflight', requireAuth,
  requireRole('admin', 'operator'), requireHostAccess('operate', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      res.json(await providerVmPower.preflightForHost(
        resolved.host, req.params.resourceId, req.body?.action, { canOperate: true }
      ));
    } catch (err) { _powerError(res, err); }
  }));

router.post('/:hostId/virtual-machines/:resourceId/power', requireAuth,
  requireRole('admin', 'operator'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerVmPower.submitForHost(resolved.host, req.params.resourceId, {
        ...req.body, idempotencyKey: req.get('Idempotency-Key'),
      }, { canOperate: true, createdBy: req.user.id });
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_vm_power_submit', targetType: 'virtualMachine', targetId: result.plan.resource.id,
        details: {
          provider: resolved.host.daemon_type, hostId: resolved.host.id,
          action: result.plan.action, operationId: result.operation.id,
          planHash: result.plan.planHash, forced: providerVmPower.ACTIONS[result.plan.action].force,
        }, ip: getClientIp(req),
      });
      res.status(202).json({ schemaVersion: '1.0', operation: result.operation, plan: result.plan });
    } catch (err) { _powerError(res, err); }
  }));

router.get('/:hostId/virtual-machines/:resourceId/snapshots', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try { res.json(await providerVmSnapshots.inventoryForHost(resolved.host, req.params.resourceId)); }
    catch (err) { _snapshotError(res, err); }
  }));

router.post('/:hostId/virtual-machines/:resourceId/snapshots/preflight', requireAuth,
  requireRole('admin', 'operator'), requireHostAccess('operate', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      res.json(await providerVmSnapshots.preflightForHost(
        resolved.host, req.params.resourceId, 'create', req.body || {}, null, { canOperate: true }
      ));
    } catch (err) { _snapshotError(res, err); }
  }));

router.post('/:hostId/virtual-machines/:resourceId/snapshots', requireAuth,
  requireRole('admin', 'operator'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerVmSnapshots.submitForHost(
        resolved.host, req.params.resourceId, 'create', { ...req.body, idempotencyKey: req.get('Idempotency-Key') },
        null, { canOperate: true, createdBy: req.user.id }
      );
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_vm_snapshot_create', targetType: 'virtualMachine', targetId: result.plan.vm.id,
        details: {
          provider: resolved.host.daemon_type, hostId: resolved.host.id,
          operationId: result.operation.id, snapshotName: result.plan.name,
          consistency: result.plan.consistency, isBackup: false,
        }, ip: getClientIp(req),
      });
      res.status(202).json({ schemaVersion: '1.0', operation: result.operation, plan: result.plan });
    } catch (err) { _snapshotError(res, err); }
  }));

for (const action of ['revert', 'delete']) {
  router.post(`/:hostId/virtual-machines/:resourceId/snapshots/:snapshotId/${action}/preflight`, requireAuth,
    requireRole('admin', 'operator'), requireHostAccess('operate', { param: 'hostId' }), asyncHandler(async (req, res) => {
      const resolved = _host(req.params.hostId);
      if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
      try {
        res.json(await providerVmSnapshots.preflightForHost(
          resolved.host, req.params.resourceId, action, req.body || {}, req.params.snapshotId, { canOperate: true }
        ));
      } catch (err) { _snapshotError(res, err); }
    }));
}

router.post('/:hostId/virtual-machines/:resourceId/snapshots/:snapshotId/revert', requireAuth,
  requireRole('admin', 'operator'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerVmSnapshots.submitForHost(
        resolved.host, req.params.resourceId, 'revert', { ...req.body, idempotencyKey: req.get('Idempotency-Key') },
        req.params.snapshotId, { canOperate: true, createdBy: req.user.id }
      );
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_vm_snapshot_revert', targetType: 'provider_snapshot', targetId: result.plan.snapshot.id,
        details: { provider: resolved.host.daemon_type, hostId: resolved.host.id, vmId: result.plan.vm.id, operationId: result.operation.id },
        ip: getClientIp(req),
      });
      res.status(202).json({ schemaVersion: '1.0', operation: result.operation, plan: result.plan });
    } catch (err) { _snapshotError(res, err); }
  }));

router.delete('/:hostId/virtual-machines/:resourceId/snapshots/:snapshotId', requireAuth,
  requireRole('admin', 'operator'), requireHostAccess('operate', { param: 'hostId' }), writeable,
  asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    try {
      const result = await providerVmSnapshots.submitForHost(
        resolved.host, req.params.resourceId, 'delete', { ...req.body, idempotencyKey: req.get('Idempotency-Key') },
        req.params.snapshotId, { canOperate: true, createdBy: req.user.id }
      );
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'provider_vm_snapshot_delete', targetType: 'provider_snapshot', targetId: result.plan.snapshot.id,
        details: { provider: resolved.host.daemon_type, hostId: resolved.host.id, vmId: result.plan.vm.id, operationId: result.operation.id },
        ip: getClientIp(req),
      });
      res.status(202).json({ schemaVersion: '1.0', operation: result.operation, plan: result.plan });
    } catch (err) { _snapshotError(res, err); }
  }));

router.get('/:hostId/virtual-machines/:resourceId', requireAuth,
  requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
    const resolved = _host(req.params.hostId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    if (req.query.refresh !== undefined && !['true', 'false', '1', '0'].includes(String(req.query.refresh))) {
      return res.status(400).json({ error: 'refresh must be true or false', code: 'INVALID_REFRESH' });
    }
    const refresh = req.query.refresh === 'true' || req.query.refresh === '1';
    if (refresh && !_isAdmin(req.user)) {
      return res.status(403).json({ error: 'VM detail refresh requires admin role' });
    }
    try {
      const canOperate = _isAdmin(req.user) || ['operate', 'admin'].includes(req.hostAccess);
      const detail = await providerVmDetail.detailForHost(resolved.host, req.params.resourceId, {
        refresh, canOperate,
      });
      if (refresh) {
        auditService.log({
          userId: req.user.id, username: req.user.username,
          action: 'provider_vm_detail_refresh', targetType: 'virtualMachine',
          targetId: detail.resource.id,
          details: { hostId: resolved.host.id, provider: resolved.host.daemon_type, freshness: detail.freshness.state },
          ip: getClientIp(req),
        });
      }
      res.json(detail);
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      res.status(status).json({
        error: status >= 500 ? 'Provider VM detail failed' : err.message,
        code: err?.code || 'PROVIDER_VM_DETAIL_ERROR',
      });
    }
  }));

router.get('/:hostId/resources/:kind', requireAuth, requireHostAccess('view', { param: 'hostId' }), asyncHandler(async (req, res) => {
  if (!config.features.providerSdkV2) return res.status(404).json({ error: 'Provider SDK v2 is disabled' });
  const hostId = Number.parseInt(req.params.hostId, 10);
  if (!Number.isInteger(hostId) || hostId <= 0) return res.status(400).json({ error: 'Invalid provider host ID' });
  if (req.query.limit !== undefined && !/^\d{1,3}$/.test(String(req.query.limit))) {
    return res.status(400).json({ error: 'Resource limit must be an integer between 1 and 500', code: 'INVALID_RESOURCE_LIMIT' });
  }
  const limit = req.query.limit === undefined ? 200 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return res.status(400).json({ error: 'Resource limit must be an integer between 1 and 500', code: 'INVALID_RESOURCE_LIMIT' });
  }
  const host = getDb().prepare('SELECT * FROM docker_hosts WHERE id = ?').get(hostId);
  if (!host) return res.status(404).json({ error: 'Provider host not found' });
  if (!host.is_active) return res.status(400).json({ error: `Provider host "${host.name}" is not active` });
  try {
    res.json(await providerSdk.resourcesForHost(host, req.params.kind, { limit }));
  } catch (err) {
    const status = Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).json({
      error: status >= 500 ? 'Provider resource inventory failed' : err.message,
      code: err?.code || 'PROVIDER_RESOURCE_ERROR',
    });
  }
}));

module.exports = router;
