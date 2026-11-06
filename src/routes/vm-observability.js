'use strict';

const { Router } = require('express');
const { writeable } = require('../middleware/auth');
const observability = require('../services/vm-observability');
const advanced = require('../services/vm-observability-advanced');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();
function route(handler) {
  return async (req, res, next) => {
    try { await handler(req, res); } catch (error) {
      if (error.name === 'VmObservabilityError' || error.name === 'VmObservabilityAdvancedError') {
        return res.status(error.status || 400).json({ error: error.message, code: error.code, details: error.details });
      }
      next(error);
    }
  };
}
function audit(req, action, targetType, targetId, details = {}) {
  auditService.log({ userId: req.user.id, username: req.user.username, action, targetType,
    targetId: String(targetId), details, ip: getClientIp(req) });
}

router.get('/catalog', route((req, res) => res.json(observability.catalog(req.user))));
router.get('/performance', route((req, res) => res.json(observability.performance(req.query, req.user))));
router.get('/dashboards/:kind', route((req, res) => res.json(observability.dashboard(req.params.kind, req.query, req.user))));

router.get('/events', route((req, res) => res.json({ events: observability.events(req.query, req.user) })));
router.post('/events/ingest', writeable, route((req, res) => {
  const result = observability.ingestEvents(req.body || {}, req.user);
  audit(req, 'vm_event_ingest', 'provider_host', result.providerHostId, { adapter: result.adapter,
    accepted: result.accepted, inserted: result.inserted, duplicates: result.duplicates });
  res.status(202).json(result);
}));
router.get('/timeline', route((req, res) => res.json(observability.timeline(req.query, req.user))));
router.get('/incidents/:resourceKey', route((req, res) => res.json(observability.incidentTimeline(req.params.resourceKey,
  req.query, req.user))));

router.get('/topology', route((req, res) => res.json(observability.topology(req.query, req.user))));
router.put('/topology/edges', writeable, route((req, res) => {
  const edge = observability.saveTopologyEdge(req.body || {}, req.user);
  audit(req, 'vm_topology_edge_update', 'vm_topology_edge', edge.id, { from: `${edge.from_type}:${edge.from_key}`,
    to: `${edge.to_type}:${edge.to_key}`, relation: edge.relation, active: !!edge.active });
  res.json({ edge });
}));
router.get('/topology/impact/:eventId', route((req, res) => res.json(observability.topologyImpact(req.params.eventId, req.user))));

router.get('/signal-rules', route((req, res) => res.json(observability.signalRules(req.user))));
router.post('/signal-rules', writeable, route((req, res) => {
  const rule = observability.createSignalRule(req.body || {}, req.user);
  audit(req, 'vm_signal_rule_create', 'vm_signal_rule', rule.id, { name: rule.name, severity: rule.severity,
    matchMode: rule.match_mode });
  res.status(201).json({ rule });
}));
router.post('/signal-rules/evaluate', writeable, route((req, res) => {
  const result = observability.evaluateSignals(req.body || {}, req.user);
  const controls = advanced.reconcileSuppressions(req.user);
  audit(req, 'vm_signal_rules_evaluate', 'provider_host', result.providerHostId, { ...result, controls });
  res.json({ ...result, controls });
}));

router.get('/advanced', route((req, res) => res.json(advanced.overview(req.user))));
router.post('/baselines', writeable, route((req, res) => {
  const policy = advanced.createBaseline(req.body || {}, req.user);
  audit(req, 'vm_observability_baseline_create', 'vm_observability_baseline', policy.id, { name: policy.name, metricKey: policy.metric_key });
  res.status(201).json({ policy });
}));
router.post('/baselines/evaluate', writeable, route((req, res) => {
  const result = advanced.evaluateBaselines(req.body || {}, req.user);
  audit(req, 'vm_observability_baselines_evaluate', 'vm_observability_baseline', req.body?.policyId || 'all', result);
  res.json(result);
}));
router.post('/maintenance', writeable, route((req, res) => {
  const window = advanced.createMaintenance(req.body || {}, req.user);
  audit(req, 'vm_observability_maintenance_create', 'vm_observability_maintenance', window.id,
    { scope: `${window.scope_type}:${window.scope_key}`, startsAt: window.starts_at, endsAt: window.ends_at });
  res.status(201).json({ window });
}));
router.post('/suppressions/reconcile', writeable, route((req, res) => {
  const result = advanced.reconcileSuppressions(req.user);
  audit(req, 'vm_observability_suppressions_reconcile', 'vm_observability_alert', 'active', result);
  res.json(result);
}));
router.post('/capacity-forecast', writeable, route((req, res) => {
  const forecast = advanced.capacityForecast(req.body || {}, req.user);
  audit(req, 'vm_observability_capacity_forecast', forecast.resourceType, forecast.resourceKey,
    { metricKey: forecast.metricKey, status: forecast.status, sampleCount: forecast.sampleCount });
  res.json({ forecast });
}));
router.post('/triage', writeable, route((req, res) => {
  const report = advanced.triage(req.body || {}, req.user);
  audit(req, 'vm_observability_triage', report.resourceType, report.resourceKey,
    { reportId: report.id, candidates: report.candidates.length, runbooks: report.runbooks.length });
  res.status(201).json({ report });
}));
router.post('/runbooks', writeable, route((req, res) => {
  const runbook = advanced.createRunbook(req.body || {}, req.user);
  audit(req, 'vm_observability_runbook_create', 'vm_observability_runbook', runbook.id, { name: runbook.name, version: runbook.version });
  res.status(201).json({ runbook });
}));
router.get('/privacy/:hostId', route((req, res) => res.json({ policy: advanced.privacyPolicy(req.params.hostId, null, req.user) })));
router.put('/privacy/:hostId', writeable, route((req, res) => {
  const policy = advanced.privacyPolicy(req.params.hostId, req.body || {}, req.user);
  audit(req, 'vm_observability_privacy_update', 'provider_host', req.params.hostId,
    { samplingRatio: policy.sampling_ratio, metricRetentionDays: policy.metric_retention_days,
      eventRetentionDays: policy.event_retention_days, residencyRegion: policy.residency_region });
  res.json({ policy });
}));
router.get('/privacy/:hostId/retention', route((req, res) => res.json(advanced.retentionPlan(req.params.hostId, req.user))));
router.post('/privacy/:hostId/retention/apply', writeable, route((req, res) => {
  const result = advanced.applyRetention(req.params.hostId, req.body || {}, req.user);
  audit(req, 'vm_observability_retention_apply', 'provider_host', req.params.hostId, result);
  res.json(result);
}));
router.post('/exports', writeable, route((req, res) => {
  const target = advanced.createExportTarget(req.body || {}, req.user);
  audit(req, 'vm_observability_export_create', 'vm_observability_export', target.id,
    { exportKind: target.export_kind, region: target.region, allowPrivateNetwork: !!target.allow_private_network });
  res.status(201).json({ target });
}));
router.get('/exports/:id/preview', route((req, res) => res.json(advanced.exportPreview(req.params.id, req.query, req.user))));
router.post('/exports/:id/deliver', writeable, route(async (req, res) => {
  const delivery = await advanced.deliverExport(req.params.id, req.body || {}, req.user);
  audit(req, 'vm_observability_export_deliver', 'vm_observability_export', req.params.id,
    { deliveryId: delivery.id, status: delivery.status, byteSize: delivery.byteSize, checksumSha256: delivery.checksumSha256 });
  res.status(202).json({ delivery });
}));
router.put('/slo', writeable, route((req, res) => {
  const policy = advanced.saveSlo(req.body || {}, req.user);
  audit(req, 'vm_observability_slo_update', policy.resource_type, policy.resource_key,
    { targetRatio: policy.target_ratio, windowDays: policy.window_days, excludeMaintenance: !!policy.exclude_maintenance });
  res.json({ policy });
}));
router.get('/slo/reports', route((req, res) => res.json(advanced.sloReports(req.user))));

module.exports = router;
