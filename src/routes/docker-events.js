'use strict';

const { Router } = require('express');
const { StringDecoder } = require('node:string_decoder');
const dockerService = require('../services/docker');
const auth = require('../services/auth');
const { apiKeys } = require('../services/misc');
const { getDb } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { extractHostId } = require('../middleware/hostId');
const { requireHostAccess } = require('../middleware/hostAccess');
const hostPermissions = require('../services/host-permissions');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();
router.use(extractHostId);
const MAX_PENDING = 256 * 1024;

function canContinue(req, credential, hostId) {
  const { token, source } = credential;
  try {
    let user = req.user;
    if (source === 'apikey') user = apiKeys.validate(token);
    else if (req.user.serviceToken) user = require('../services/identity-governance').validateToken(token);
    else if (token && source !== 'sso') user = auth.validateSession(token);
    if (!user || user.id !== req.user.id || user.role !== req.user.role || user.mustChangePassword) return false;
    if (hostId !== 0 && !getDb().prepare('SELECT is_active FROM docker_hosts WHERE id = ?').get(hostId)?.is_active) return false;
    return user.role === 'admin' || Boolean(hostPermissions.resolveEffectivePermission(user.id, hostId, false));
  } catch { return false; }
}

router.get('/events', requireAuth, requireHostAccess(), asyncHandler(async (req, res) => {
  const filter = req.query.filter;
  if (filter !== undefined && (typeof filter !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/i.test(filter))) {
    return res.status(400).json({ error: 'Invalid Docker event filter' });
  }
  const hostId = req.resolvedHostId ?? req.hostId;
  const credential = { token: req.authToken, source: req.authSource };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000).unref();
  const cancel = () => controller.abort();
  res.once('close', cancel);
  let stream;
  try {
    stream = await dockerService.getEventStream(hostId, { abortSignal: controller.signal });
  } catch {
    if (!res.destroyed) res.status(503).json({ error: 'Docker event stream is unavailable', code: 'EVENT_STREAM_UNAVAILABLE' });
    return;
  } finally {
    clearTimeout(timeout);
    res.off('close', cancel);
  }
  if (res.destroyed || controller.signal.aborted || !canContinue(req, credential, hostId)) {
    stream.destroy();
    if (!res.destroyed) res.status(controller.signal.aborted ? 503 : 403).json({ error: 'Docker event stream is unavailable' });
    return;
  }

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ hostId, filter: filter ?? null })}\n\n`);

  const decoder = new StringDecoder('utf8');
  let buffer = '', blocked = false, ended = false, sourceEnded = false;
  const heartbeat = setInterval(() => {
    if (!canContinue(req, credential, hostId)) finish('access_revoked');
    else if (!blocked && !res.write(': heartbeat\n\n')) { blocked = true; stream.pause(); }
  }, 10000).unref();
  function finish(event) {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    stream.destroy();
    if (!res.destroyed && !res.writableEnded) res.end(event ? `event: ${event}\ndata: {}\n\n` : undefined);
  }
  function flush() {
    let index;
    while (!ended && !blocked && (index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (!event || typeof event.Type !== 'string' || (filter && event.Type !== filter)) continue;
      if (!res.write(`data: ${line}\n\n`)) {
        blocked = true;
        stream.pause();
      }
    }
    if (sourceEnded && !blocked) finish('end');
  }
  stream.on('data', chunk => {
    buffer += decoder.write(chunk);
    if (buffer.length > MAX_PENDING) return finish('error');
    flush();
  });
  stream.once('end', () => {
    sourceEnded = true;
    buffer += decoder.end();
    if (buffer) buffer += '\n';
    flush();
  });
  stream.once('error', () => finish('error'));
  stream.once('close', () => { if (!sourceEnded) finish('end'); });
  res.on('drain', () => {
    if (ended) return;
    blocked = false;
    flush();
    if (!blocked) stream.resume();
  });
  res.once('close', () => finish());
}));

module.exports = router;
