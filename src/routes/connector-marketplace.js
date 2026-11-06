'use strict';

const { Router } = require('express');
const { writeable } = require('../middleware/auth');
const connectors = require('../services/connector-marketplace');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();
function route(handler) { return async (req, res, next) => { try { await handler(req, res); } catch (error) { if (error.name === 'ConnectorMarketplaceError') return res.status(error.status || 400).json({ error: error.message, code: error.code, details: error.details }); next(error); } }; }
function audit(req, action, connectorKey, details = {}) { auditService.log({ userId: req.user.id, username: req.user.username, action,
  targetType: 'connector_integration', targetId: String(connectorKey), details, ip: getClientIp(req) }); }

router.get('/', route((req, res) => res.json(connectors.overview(req.user))));
router.post('/marketplace', writeable, route((req, res) => {
  const entry = connectors.register(req.body || {}, req.user); audit(req, 'connector_marketplace_register', entry.connectorKey,
    { version: entry.version, supportLevel: entry.supportLevel, manifestHash: entry.manifestHash, signatureState: entry.signatureState }); res.status(201).json({ entry });
}));
router.post('/:connectorKey/cmdb-syncs', writeable, route((req, res) => {
  const plan = connectors.planCmdbSync(req.params.connectorKey, req.body || {}, req.user); audit(req, 'connector_cmdb_sync_plan', plan.connectorKey,
    { product: plan.product, resourceType: plan.resourceType, resourceRef: plan.resourceRef, state: plan.state, planHash: plan.planHash, externalMutationsStarted: 0 }); res.status(201).json({ plan });
}));
router.post('/:connectorKey/itsm-changes', writeable, route((req, res) => {
  const change = connectors.linkItsmChange(req.params.connectorKey, req.body || {}, req.user); audit(req, 'connector_itsm_change_link', change.connectorKey,
    { product: change.product, ticketRef: change.ticketRef, approvalState: change.approvalState, gateState: change.gateState, evidenceHash: change.evidenceHash }); res.status(201).json({ change });
}));
router.post('/:connectorKey/siem-events', writeable, route((req, res) => {
  const event = connectors.normalizeSiemEvent(req.params.connectorKey, req.body || {}, req.user); audit(req, 'connector_siem_event_normalize', event.connectorKey,
    { destinationKind: event.destinationKind, eventId: event.eventId, envelopeHash: event.envelopeHash, rawPayloadStored: false }); res.status(201).json({ event });
}));
router.post('/:connectorKey/secret-references', writeable, route((req, res) => {
  const reference = connectors.bindSecretReference(req.params.connectorKey, req.body || {}, req.user); audit(req, 'connector_secret_reference_bind', reference.connectorKey,
    { providerKind: reference.providerKind, purpose: reference.purpose, referenceHash: reference.referenceHash, secretMaterialStored: false }); res.status(201).json({ reference });
}));
router.post('/:connectorKey/ipam-dns-plans', writeable, route((req, res) => {
  const plan = connectors.planIpamDns(req.params.connectorKey, req.body || {}, req.user); audit(req, 'connector_ipam_dns_plan', plan.connectorKey,
    { product: plan.product, action: plan.action, resourceRef: plan.resourceRef, planHash: plan.planHash, externalMutationsStarted: 0 }); res.status(201).json({ plan });
}));
router.post('/:connectorKey/backup-observations', writeable, route((req, res) => {
  const observation = connectors.recordBackupObservation(req.params.connectorKey, req.body || {}, req.user); audit(req, 'connector_backup_observation', observation.connectorKey,
    { providerKind: observation.providerKind, jobRef: observation.jobRef, workloadRef: observation.workloadRef, status: observation.status, evidenceHash: observation.evidenceHash }); res.status(201).json({ observation });
}));
router.post('/:connectorKey/monitoring-targets', writeable, route((req, res) => {
  const target = connectors.saveMonitoringTarget(req.params.connectorKey, req.body || {}, req.user); audit(req, 'connector_monitoring_target_plan', target.connectorKey,
    { providerKind: target.providerKind, endpointOrigin: target.endpointOrigin, mode: target.mode, targetHash: target.targetHash, networkCallsStarted: 0 }); res.status(201).json({ target });
}));
router.post('/:connectorKey/event-publications', writeable, route((req, res) => {
  const publication = connectors.planEventPublish(req.params.connectorKey, req.body || {}, req.user); audit(req, 'connector_event_publication_plan', publication.connectorKey,
    { providerKind: publication.providerKind, channel: publication.channel, eventId: publication.eventId, envelopeHash: publication.envelopeHash, externalPublishesStarted: 0 }); res.status(201).json({ publication });
}));
router.put('/:connectorKey/openapi-operations', writeable, route((req, res) => {
  const operation = connectors.registerOpenApiOperation(req.params.connectorKey, req.body || {}, req.user); audit(req, 'connector_openapi_operation_allowlist', operation.connectorKey,
    { operationKey: operation.operationKey, method: operation.method, path: operation.path, risk: operation.risk, operationHash: operation.operationHash }); res.json({ operation });
}));
router.post('/:connectorKey/openapi-operations/:operationKey/prototypes', writeable, route((req, res) => {
  const prototype = connectors.prototypeOpenApiRequest(req.params.connectorKey, req.params.operationKey, req.body || {}, req.user); audit(req, 'connector_openapi_request_prototype', prototype.connectorKey,
    { operationKey: prototype.operationKey, requestHash: prototype.requestHash, allowlistEnforced: true, networkCallsStarted: 0 }); res.status(201).json({ prototype });
}));

module.exports = router;
