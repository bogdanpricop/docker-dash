'use strict';

// v8.96.0 — Diagnostic Sessions.
//
// Reads are open to any authenticated user: a session correlates data they can
// already see on the Containers and VM pages, and hiding the correlation from
// the people investigating an incident would be the wrong default. Creating and
// deleting a session are state changes, so they carry `writeable` and an audit
// entry; export is audited too, because it produces a file that leaves the
// application's boundary.

const { Router } = require('express');
const diagnostics = require('../services/diagnostics');
const auditService = require('../services/audit');
const { requireAuth, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();
router.use(requireAuth);

function handle(res, fn) {
  try {
    return res.json(fn());
  } catch (err) {
    if (err && err.name === 'DiagnosticsError') return res.status(err.status || 400).json({ error: err.message });
    throw err;
  }
}

router.get('/sessions', asyncHandler((_req, res) => handle(res, () => ({ sessions: diagnostics.list() }))));

router.get('/sessions/:id', asyncHandler((req, res) => handle(res, () => diagnostics.get(req.params.id))));

router.get('/sessions/:id/timeline', asyncHandler((req, res) =>
  handle(res, () => diagnostics.timeline(req.params.id, { buckets: req.query.buckets }))));

router.post('/sessions', writeable, asyncHandler((req, res) => {
  const body = req.body || {};
  return handle(res, () => {
    const session = diagnostics.create(body, req.user);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'diagnostic_session_create', targetType: 'diagnostic_session', targetId: String(session.id),
      // Counts and the window, not the subject identifiers in bulk: the audit
      // entry should say what was investigated, not restate the investigation.
      details: { name: session.name, subjects: session.subjects.length, from: session.window_start, to: session.window_end },
      ip: getClientIp(req),
    });
    return session;
  });
}));

router.get('/sessions/:id/export', asyncHandler((req, res) => handle(res, () => {
  const data = diagnostics.exportSession(req.params.id);
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'diagnostic_session_export', targetType: 'diagnostic_session', targetId: String(req.params.id),
    details: { series: data.series.length, annotations: data.annotations.length },
    ip: getClientIp(req),
  });
  return data;
})));

router.delete('/sessions/:id', writeable, asyncHandler((req, res) => handle(res, () => {
  const r = diagnostics.remove(req.params.id);
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'diagnostic_session_delete', targetType: 'diagnostic_session', targetId: String(req.params.id),
    details: {}, ip: getClientIp(req),
  });
  return r;
})));

module.exports = router;
