'use strict';

/** Parse a single explicit ID without coercing arrays, booleans, or partial numbers. */
function parseHostId(value) {
  if (typeof value === 'string' && value.length && !/[^0-9]/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Keep the historical row-1 fallback when no host was marked as default.
function defaultHost(db) {
  return db.prepare('SELECT * FROM docker_hosts WHERE id = 1 OR is_default = 1 ORDER BY is_default DESC, id LIMIT 1').get();
}

function isDockerCompatible(daemonType = 'docker') {
  return daemonType === 'docker' || daemonType === 'podman';
}

module.exports = { parseHostId, defaultHost, isDockerCompatible };
