'use strict';

const { getDb } = require('../db');

function hostScope(hostId) {
  const defaultHost = getDb().prepare('SELECT id FROM docker_hosts WHERE is_default = 1 ORDER BY id LIMIT 1').get();
  return id => id === hostId || (defaultHost && [0, defaultHost.id].includes(id) && [0, defaultHost.id].includes(hostId));
}

// Removal conservatively protects every matching short-ID policy. Connection
// authorization additionally checks that a short ID is unique in live inventory.
function matchesContainer(policy, info, matchesHost) {
  if (!matchesHost(policy.hostId)) return false;
  if (policy.scopeType === 'container') {
    return /^[a-f0-9]{12,64}$/.test(policy.scopeKey || '') && info.Id.startsWith(policy.scopeKey);
  }
  const project = info.Config?.Labels?.['com.docker.compose.project'];
  return policy.scopeType === 'stack' && !!project && policy.scopeKey === project;
}

module.exports = { hostScope, matchesContainer };
