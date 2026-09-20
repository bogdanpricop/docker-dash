'use strict';

function normalizeCapability(cap) {
  return String(cap).toUpperCase().replace(/^CAP_/, '');
}

// Docker's defaults include NET_RAW. Checking only CapAdd misses the usual
// case, including a latent capability that a non-root process cannot use yet.
function hasRawSocketCapability(hostConfig = {}) {
  const added = new Set((hostConfig.CapAdd || []).map(normalizeCapability));
  const dropped = new Set((hostConfig.CapDrop || []).map(normalizeCapability));
  return hostConfig.Privileged === true || added.has('ALL') || added.has('NET_RAW')
    || (!dropped.has('ALL') && !dropped.has('NET_RAW'));
}

module.exports = { normalizeCapability, hasRawSocketCapability };
