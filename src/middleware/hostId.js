'use strict';

const { getDb } = require('../db');
const { parseHostId, defaultHost } = require('../utils/host-id');
const selected = Symbol('validated Docker host');

/**
 * Middleware: extract hostId from query string or header.
 * Sets req.hostId (defaults to 0 = local/default host).
 */
function extractHostId(req, res, next) {
  if (req[selected]) return next();
  const query = req.query;
  const header = req.headers['x-docker-host'];
  const queryId = query.hostId === undefined ? undefined : parseHostId(query.hostId);
  const headerId = header === undefined ? undefined : parseHostId(header);
  const malformedKey = Object.keys(query).some(key => key !== 'hostId' && /^hostId(?:$|\[)/i.test(key));
  if (malformedKey || queryId === null || headerId === null) {
    return res.status(400).json({ error: 'Invalid hostId', code: 'INVALID_HOST_ID' });
  }
  if (queryId !== undefined && headerId !== undefined && queryId !== headerId) {
    return res.status(400).json({ error: 'Query and header select different Docker hosts', code: 'HOST_SELECTION_CONFLICT' });
  }
  const hostId = queryId ?? headerId ?? 0;

  try {
    const db = getDb();
    const host = hostId === 0 ? defaultHost(db) : db.prepare('SELECT id, is_active, name, connection_type FROM docker_hosts WHERE id = ?').get(hostId);
    if (hostId !== 0 && !host) {
      return res.status(404).json({ error: `Docker host ${hostId} not found`, code: 'HOST_NOT_FOUND' });
    }
    if (host && !host.is_active) {
      return res.status(400).json({ error: `Docker host "${host.name}" is not active`, code: 'HOST_INACTIVE' });
    }
    req.hostId = hostId;
    req.resolvedHostId = host?.id ?? hostId;
    req.hostName = host?.name;
    req.hostConnectionType = host?.connection_type;
    req[selected] = true;
  } catch {
    return res.status(503).json({ error: 'Docker host selection is temporarily unavailable', code: 'HOST_LOOKUP_UNAVAILABLE' });
  }
  next();
}

module.exports = { extractHostId };
