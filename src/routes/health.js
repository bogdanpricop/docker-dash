'use strict';

const { getDb } = require('../db');
const _pkgVersion = require('../version');

// Health probes must remain available when an API quota is exhausted or unavailable.
module.exports = (req, res) => {
  try {
    getDb().prepare('SELECT 1').get();
    // v7.0.0: expose cluster role so load balancers can route writes
    // to the leader (sticky-session LBs use this via health-check-conditional
    // routing; e.g. Caddy `health_uri` + `health_headers` matchers).
    const cluster = require('../services/cluster');
    const status = cluster.getStatus();
    res.json({
      status: 'ok',
      version: _pkgVersion,
      timestamp: new Date().toISOString(),
      mode: status.mode,
      role: status.role,
      nodeId: status.nodeId,
    });
  } catch {
    res.status(503).json({ status: 'error', message: 'Database unavailable' });
  }
};
