'use strict';

// v8.9.2-alpha.1 — Sprint 7 (VM migration) routes.
//
// All routes require admin role. Migrations touch SSH, network, and
// remote shell commands on the Proxmox side — this is the highest-trust
// action set docker-dash exposes.

const { Router } = require('express');
const migrationSvc = require('../services/migration-vm');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

// List recent jobs (all users can see the queue; admins to mutate).
router.get('/', requireAuth, asyncHandler((req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
  res.json(migrationSvc.listJobs(limit));
}));

router.get('/:id', requireAuth, asyncHandler((req, res) => {
  const job = migrationSvc.getJob(parseInt(req.params.id, 10));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
}));

router.post('/', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  try {
    const jobId = migrationSvc.createJob(req.body || {}, req.user.id);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'vm_migration_start', targetType: 'vm_migration', targetId: String(jobId),
      details: {
        sourceUrl: req.body.sourceUrl,
        destinationHostId: req.body.destinationHostId,
        destinationVmid: req.body.destinationVmid,
      },
      ip: getClientIp(req),
    });
    res.status(202).json({ ok: true, jobId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

module.exports = router;
