'use strict';

const { evidence } = require('../schema');

function supported(source = 'adapter', constraints) {
  return evidence('supported', { source, constraints });
}

function unsupported(reason, source = 'adapter') {
  return evidence('unsupported', { source, reason });
}

function conditional(reason, constraints, source = 'configuration') {
  return evidence('conditional', { source, reason, constraints });
}

function unknown(reason, source = 'fallback') {
  return evidence('unknown', { source, reason });
}

function adapterNotImplemented(upstreamName) {
  return unsupported(`${upstreamName || 'Provider'} may support this feature, but the Docker Dash adapter does not implement it`);
}

module.exports = { supported, unsupported, conditional, unknown, adapterNotImplemented };
