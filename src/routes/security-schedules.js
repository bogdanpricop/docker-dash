'use strict';

const { Router } = require('express');
const scans = require('../services/security-scan-schedules');
const audit = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const { nextScheduleRuns, validScheduleCron } = require('../utils/schedule-cron');

const router = Router();
router.use(requireAuth, requireRole('admin'));

function numericId(value) {
  const id = Number(value);
  if (typeof value !== 'string' || /[^0-9]/.test(value) || !Number.isSafeInteger(id) || id < 1) {
    throw Object.assign(new Error('Invalid security scan ID'), { status: 400 });
  }
  return id;
}

function log(req, action, id, details) {
  audit.log({ userId: req.user.id, username: req.user.username,
    action, targetType: 'security_scan_schedule', targetId: String(id), details, ip: getClientIp(req) });
}

router.get('/', (req, res) => res.json(scans.list()));
router.get('/preview', (req, res) => {
  if (!validScheduleCron(req.query.cron)) return res.status(400).json({ error: 'Invalid cron expression' });
  res.json({ nextRuns: nextScheduleRuns(req.query.cron, new Date(), 5) });
});
router.get('/runs/:id', (req, res) => res.json(scans.getRun(numericId(req.params.id))));
router.get('/runs/:id/report', (req, res) => {
  const report = scans.downloadImageReport(numericId(req.params.id));
  res.attachment(report.filename).set({ 'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream' }).send(report.content);
});
router.get('/:id/history', (req, res) => res.json(scans.history(numericId(req.params.id))));

router.post('/', writeable, (req, res) => {
  const schedule = scans.save(null, req.body, req.user.id);
  log(req, 'security_scan_schedule_create', schedule.id, { hostId: schedule.hostId, kind: schedule.kind });
  res.status(201).json(schedule);
});

router.put('/:id', writeable, (req, res) => {
  const schedule = scans.save(numericId(req.params.id), req.body, req.user.id);
  log(req, 'security_scan_schedule_update', schedule.id, { hostId: schedule.hostId, kind: schedule.kind, enabled: schedule.enabled });
  res.json(schedule);
});

router.delete('/:id', writeable, (req, res) => {
  const id = numericId(req.params.id);
  scans.remove(id);
  log(req, 'security_scan_schedule_delete', id);
  res.json({ ok: true });
});

router.post('/:id/run-now', writeable, (req, res) => {
  const id = numericId(req.params.id);
  const run = scans.enqueueManual(id);
  log(req, 'security_scan_schedule_queue', id, { runId: run.id, hostId: run.hostId });
  res.status(202).json(run);
});

module.exports = router;
