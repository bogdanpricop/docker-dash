'use strict';

const { getDb } = require('../db');

/**
 * Middleware: extract hostId from query string or header.
 * Sets req.hostId (defaults to 0 = local/default host).
 */
function extractHostId(req, res, next) {
  const raw = req.query.hostId || req.headers['x-docker-host'] || '0';
  const hostId = parseInt(raw, 10);

  if (isNaN(hostId) || hostId < 0) {
    return res.status(400).json({ error: 'Invalid hostId' });
  }

  // hostId 0 always refers to the default host
  if (hostId === 0) {
    req.hostId = 0;
    return next();
  }

  // Validate host exists and is active
  try {
    const db = getDb();
    const host = db.prepare('SELECT id, is_active, name FROM docker_hosts WHERE id = ?').get(hostId);
    if (!host) {
      return res.status(404).json({ error: `Docker host ${hostId} not found` });
    }
    if (!host.is_active) {
      return res.status(400).json({ error: `Docker host "${host.name}" is not active` });
    }
    req.hostId = hostId;
    req.hostName = host.name;
    next();
  } catch (err) {
    req.hostId = 0;
    next();
  }
}

module.exports = { extractHostId };
