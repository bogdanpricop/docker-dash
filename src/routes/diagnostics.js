'use strict';

// v8.96.0 — Diagnostic Sessions.
//
// Non-admin sessions are private and their subjects are checked against current
// host and stack grants before details, timelines or exports are returned.

const { Router } = require('express');
const diagnostics = require('../services/diagnostics');
const auditService = require('../services/audit');
const { requireAuth, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');
const hosts = require('../services/host-permissions');
const docker = require('../services/docker');
const permissions = require('../services/permissions');
const { parseHostId } = require('../utils/host-id');

const isAdmin = user => user.role === 'admin';
const unavailable = () => new diagnostics.DiagnosticsError('Diagnostic subject is not accessible', 403);

async function authorizeSubject(user, subject, creating) {
  if (!creating && isAdmin(user)) return subject;
  const type = creating ? subject?.type : subject.subject_type;
  const ref = creating ? subject?.ref : subject.subject_ref;
  const rawHost = type === 'vm'
    ? (creating ? subject?.providerHostId : subject.provider_host_id)
    : (creating ? subject?.hostId : subject.host_id);
  if (!['container', 'vm'].includes(type) || typeof ref !== 'string' || !ref || ref.length > 256
    || /[\x00-\x1f\x7f]/.test(ref)) {
    if (creating) throw new diagnostics.DiagnosticsError('Invalid diagnostic subject');
    throw unavailable();
  }
  const hostId = type === 'vm' ? parseHostId(rawHost) : hosts.normalizeHostId(rawHost ?? 0);
  if (hostId === null || (type === 'vm' && hostId === 0)) {
    if (creating) throw new diagnostics.DiagnosticsError('Invalid diagnostic subject host');
    throw unavailable();
  }
  if (isAdmin(user)) return type === 'vm' ? { ...subject, providerHostId: hostId } : { ...subject, hostId };
  if ((!creating && hostId !== (rawHost ?? 0)) || !hosts.resolveEffectivePermission(user.id, hostId, false)) throw unavailable();
  if (type === 'vm') return creating ? { ...subject, providerHostId: hostId } : subject;
  let container;
  try { container = await docker.inspectContainer(ref, hostId); }
  catch { throw unavailable(); }
  const stack = container.labels?.['com.docker.compose.project'] || '_standalone';
  if (!permissions.hasPermission(permissions.getEffectiveRole(user.id, stack, user.role), 'view')) throw unavailable();
  if (!container.id || (!creating && container.id !== ref)) throw unavailable();
  return creating ? { ...subject, ref: container.id, hostId, displayName: container.name } : subject;
}

async function sessionFor(user, id, verifySubjects = true) {
  const session = diagnostics.get(id);
  if (!isAdmin(user) && session.created_by !== user.id) throw new diagnostics.DiagnosticsError('Session not found', 404);
  if (verifySubjects) await Promise.all(session.subjects.map(subject => authorizeSubject(user, subject, false)));
  return session;
}

const router = Router();
router.use(requireAuth);

async function handle(res, fn) {
  try {
    return res.json(await fn());
  } catch (err) {
    if (err && err.name === 'DiagnosticsError') return res.status(err.status || 400).json({ error: err.message });
    throw err;
  }
}

router.get('/sessions', asyncHandler((req, res) =>
  handle(res, () => ({ sessions: diagnostics.list(isAdmin(req.user) ? undefined : req.user.id) }))));

router.get('/sessions/:id', asyncHandler((req, res) => handle(res, () => sessionFor(req.user, req.params.id))));

router.get('/sessions/:id/timeline', asyncHandler((req, res) => handle(res, async () => {
  const session = await sessionFor(req.user, req.params.id);
  return diagnostics.timeline(session.id, { buckets: req.query.buckets, includeAudit: isAdmin(req.user), session });
})));

router.post('/sessions', writeable, asyncHandler((req, res) => {
  const body = req.body || {};
  return handle(res, async () => {
    if (!Array.isArray(body.subjects) || body.subjects.length > diagnostics._internals.MAX_SUBJECTS) {
      throw new diagnostics.DiagnosticsError('Invalid diagnostic subject selection');
    }
    const subjects = await Promise.all(body.subjects.map(subject => authorizeSubject(req.user, subject, true)));
    const session = diagnostics.create({ ...body, subjects }, req.user);
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

router.get('/sessions/:id/export', asyncHandler((req, res) => handle(res, async () => {
  const session = await sessionFor(req.user, req.params.id);
  const data = diagnostics.exportSession(session.id, { includeAudit: isAdmin(req.user), session });
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'diagnostic_session_export', targetType: 'diagnostic_session', targetId: String(req.params.id),
    details: { series: data.series.length, annotations: data.annotations.length },
    ip: getClientIp(req),
  });
  return data;
})));

router.delete('/sessions/:id', writeable, asyncHandler((req, res) => handle(res, async () => {
  const session = await sessionFor(req.user, req.params.id, false);
  const r = diagnostics.remove(session.id);
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'diagnostic_session_delete', targetType: 'diagnostic_session', targetId: String(req.params.id),
    details: {}, ip: getClientIp(req),
  });
  return r;
})));

module.exports = router;
