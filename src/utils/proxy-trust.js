'use strict';

module.exports = function proxyTrust(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'loopback';
  if (raw === 'false' || raw === '0') return false;
  if (raw === 'true' || /^\d+$/.test(raw)) {
    throw new Error('TRUST_PROXY must be false or explicit proxy IPs/CIDRs, not blanket trust or a hop count');
  }
  return raw;
};
