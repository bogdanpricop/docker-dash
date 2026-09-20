'use strict';

const { Router } = require('express');
const pressure = require('../services/disk-pressure');
const audit = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

function record(req, action, hostId, details = {}) {
  audit.log({
    userId: req.user.id, username: req.user.username,
    action, targetType: 'docker_host', targetId: String(hostId),
    details, ip: getClientIp(req),
  });
}

router.get('/policies', requireAuth, requireRole('admin'), (_req, res) => res.json(pressure.listPolicies()));

router.get('/hosts/:hostId/policy', requireAuth, requireRole('admin'), (req, res) => {
  res.json(pressure.getPolicy(req.params.hostId) || { host_id: Number(req.params.hostId), enabled: false, dry_run_only: true });
});

router.put('/hosts/:hostId/policy', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const policy = pressure.updatePolicy(req.params.hostId, req.body || {});
    record(req, 'disk_pressure_policy_update', policy.host_id, {
      enabled: policy.enabled, dry_run_only: policy.dry_run_only,
      threshold_percent: policy.threshold_percent, max_docker_bytes: policy.max_docker_bytes,
      min_age_hours: policy.min_age_hours,
    });
    res.json(policy);
  } catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});

router.post('/hosts/:hostId/preview', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  try {
    const evaluation = await pressure.evaluate(req.params.hostId);
    record(req, 'disk_pressure_preview', evaluation.host_id, {
      threshold_met: evaluation.threshold_met, docker_bytes: evaluation.docker_bytes,
      candidate_bytes: evaluation.candidate_bytes,
    });
    res.json(evaluation);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
}));

router.post('/hosts/:hostId/run', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  try {
    const result = await pressure.run(req.params.hostId, {
      force: req.body?.force === true, triggerType: 'manual', userId: req.user.id,
    });
    record(req, 'disk_pressure_run', req.params.hostId, {
      status: result.status, dry_run: result.dry_run,
      force: req.body?.force === true, reclaimed_bytes: result.reclaimed_bytes || 0,
    });
    res.json(result);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
}));

router.get('/hosts/:hostId/history', requireAuth, requireRole('admin'), (req, res) => {
  res.json(pressure.history(req.params.hostId, req.query.limit));
});

module.exports = router;

