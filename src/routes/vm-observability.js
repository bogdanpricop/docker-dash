'use strict';

const { Router } = require('express');
const { writeable } = require('../middleware/auth');
const observability = require('../services/vm-observability');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();
function route(handler) {
  return async (req, res, next) => {
    try { await handler(req, res); } catch (error) {
      if (error.name === 'VmObservabilityError') {
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
  audit(req, 'vm_signal_rules_evaluate', 'provider_host', result.providerHostId, result);
  res.json(result);
}));

module.exports = router;
