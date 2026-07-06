'use strict';

// v8.9.8-alpha.1 — Portainer G09 closure: real-time Docker events SSE stream.
// Uses the existing dockerService.getEventStream() which returns a stream
// of newline-delimited JSON events from the Docker daemon.

const { Router } = require('express');
const dockerService = require('../services/docker');
const { requireAuth } = require('../middleware/auth');
const { extractHostId } = require('../middleware/hostId');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();
router.use(extractHostId);

// GET /api/docker/events?filter=container — SSE stream of daemon events.
router.get('/events', requireAuth, asyncHandler(async (req, res) => {
  const filter = req.query.filter || null; // 'container' | 'image' | 'network' | 'volume'
  res.set('Content-Type', 'text/event-stream');
  res.set('Cache-Control', 'no-cache');
  res.set('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ hostId: req.hostId, filter })}\n\n`);

  const stream = await dockerService.getEventStream(req.hostId);
  let buffer = '';
  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const evt = JSON.parse(line);
        if (filter && evt.Type !== filter) continue;
        res.write(`data: ${line}\n\n`);
      } catch { /* skip malformed */ }
    }
  };
  const onEnd = () => { res.write('event: end\ndata: closed\n\n'); res.end(); };
  const onError = (err) => { res.write(`event: error\ndata: ${err.message}\n\n`); res.end(); };

  stream.on('data', onData);
  stream.on('end', onEnd);
  stream.on('error', onError);

  req.on('close', () => {
    try { stream.removeListener('data', onData); } catch { /* ignore */ }
    try { stream.destroy(); } catch { /* ignore */ }
  });
}));

module.exports = router;
