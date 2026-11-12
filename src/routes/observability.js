'use strict';

// Observability wizard routes — v7.2.0
//
// Admin-only endpoints backing the /system/observability wizard UI.
//
//   GET  /api/observability/detect           — scan running containers
//   POST /api/observability/import-dashboard — proxy POST to user's Grafana
//
// See plans/deep-spec-observability-wizard.md for architecture + security
// considerations (Grafana token handling in §5.3).

const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const dockerService = require('../services/docker');
const detect = require('../services/observability-detect');
const importer = require('../services/observability-import');
const auditService = require('../services/audit');

const router = Router();

// All wizard endpoints are admin-only — operators and viewers never see
// the sidebar link, and the backend rejects unauthorized calls explicitly.
router.use(requireAuth, requireRole('admin'));

// Detection — returns the current state of the user's Docker daemon.
// Safe to call repeatedly; the wizard uses it for the initial scan and
// any manual "Rescan" click.
router.get('/detect', asyncHandler(async (req, res) => {
  const result = await detect.detect(dockerService);
  // v7.6.0 — also probe reachability for any detected service. Catches the
  // "container running but inside-process crashed" + "wrong network" cases
  // that pure image-prefix detection misses. Best-effort; never blocks
  // the response longer than ~2s per service.
  const probes = await detect.probe(result);
  res.json({
    ...result,
    probes,
    // Ship the scrape-config snippet alongside so the frontend doesn't
    // need to know the API port or target name conventions.
    scrapeConfigSnippet: importer.scrapeConfigSnippet(
      result.dockerDashContainerId ? 'docker-dash' : 'app',
      parseInt(process.env.APP_PORT || '8101', 10)
    ),
  });
}));

// Dashboard import — the user provides their Grafana URL + a
// service-account token; we POST the dashboard JSON on their behalf.
// Token NEVER lands in our DB or logs (see §5.3 of the deep-spec).
router.post('/import-dashboard', writeable, asyncHandler(async (req, res) => {
  const { grafanaUrl, token } = req.body || {};
  if (!grafanaUrl || !token) {
    return res.status(400).json({ error: 'grafanaUrl and token are required' });
  }

  let result;
  try {
    result = await importer.importDashboard(grafanaUrl, token);
  } catch (err) {
    // Audit the failure (without the token) so operators can diagnose
    // via the audit log if needed.
    auditService.log({
      userId: req.user.id,
      username: req.user.username,
      action: 'observability_dashboard_import_failed',
      targetType: 'observability',
      targetId: 'docker-dash-overview',
      details: { grafanaUrl: grafanaUrl.replace(/\/$/, ''), error: err.message.substring(0, 200) },
    });
    return res.status(502).json({ error: err.message });
  }

  auditService.log({
    userId: req.user.id,
    username: req.user.username,
    action: 'observability_dashboard_imported',
    targetType: 'observability',
    targetId: result.dashboardUid,
    details: { grafanaUrl: grafanaUrl.replace(/\/$/, '') },
  });
  res.json(result);
}));

module.exports = router;
