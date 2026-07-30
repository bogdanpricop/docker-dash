'use strict';

const { Router } = require('express');
const { writeable } = require('../middleware/auth');
const plugins = require('../services/provider-plugins');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();
function route(handler) { return async (req, res, next) => { try { await handler(req, res); } catch (error) { if (error.name === 'ProviderPluginError') return res.status(error.status || 400).json({ error: error.message, code: error.code, details: error.details }); next(error); } }; }
function audit(req, action, pluginKey, details = {}) { auditService.log({ userId: req.user.id, username: req.user.username, action,
  targetType: 'provider_plugin', targetId: String(pluginKey), details, ip: getClientIp(req) }); }

router.get('/', route((req, res) => res.json(plugins.overview(req.user))));
router.post('/manifests', writeable, route((req, res) => {
  const plugin = plugins.register(req.body || {}, req.user); audit(req, 'provider_plugin_manifest_register', plugin.pluginKey,
    { version: plugin.version, manifestHash: plugin.manifestHash, signatureState: plugin.signatureState }); res.status(201).json({ plugin });
}));
router.post('/:pluginKey/consents', writeable, route((req, res) => {
  const consent = plugins.consent(req.params.pluginKey, req.body || {}, req.user); audit(req, 'provider_plugin_permission_consent', consent.pluginKey,
    { manifestHash: consent.manifestHash, permissionKey: consent.permissionKey, risk: consent.risk, decision: consent.decision }); res.json({ consent });
}));
router.get('/:pluginKey/compatibility', route((req, res) => res.json(plugins.compatibility(req.params.pluginKey, req.user))));
router.put('/:pluginKey/enabled', writeable, route((req, res) => {
  const plugin = plugins.enable(req.params.pluginKey, req.body || {}, req.user); audit(req, 'provider_plugin_enable_state', plugin.pluginKey,
    { enabled: plugin.enabled, manifestHash: plugin.manifestHash }); res.json({ plugin });
}));
router.post('/:pluginKey/sandbox-probes', writeable, route(async (req, res) => {
  const run = await plugins.sandboxProbe(req.params.pluginKey, req.body || {}, req.user); audit(req, 'provider_plugin_sandbox_probe', run.pluginKey,
    { method: run.method, requestHash: run.requestHash, status: run.status, responseHash: run.responseHash, payloadReturned: false }); res.status(201).json({ run });
}));
router.post('/:pluginKey/health', writeable, route((req, res) => {
  const health = plugins.recordHealth(req.params.pluginKey, req.body || {}, req.user); audit(req, 'provider_plugin_health_record', health.pluginKey,
    { state: health.state, evidenceHash: health.evidenceHash, errorRate: health.errorRate, crashCount: health.crashCount, payloadFieldsStored: [] }); res.status(health.duplicate ? 200 : 201).json({ health });
}));

module.exports = router;
