'use strict';

const { normalizeCapability, hasRawSocketCapability } = require('./egress-capabilities');

// Egress Audit (v6.6.2)
//
// Analyzes each container's network configuration and flags containers that
// can reach the public internet + cloud-metadata endpoints (IMDS).
//
// Read-only: no enforcement, just visibility. Enforcement (iptables / squid
// sidecar / whitelist) is a larger feature deferred to v6.7 per BACKLOG.md.
//
// The analysis is a pure function (analyzeContainer) that takes a container
// inspect + network-info map and returns findings + risk score. The route
// layer in src/routes/system.js is responsible for iterating containers and
// aggregating results; this keeps the logic unit-testable.

// Cloud IMDS endpoints per provider. Any container that can reach one of
// these via a non-internal network + IPv4 gateway is considered at risk of
// credential theft if the container is compromised. RFC1918 ranges listed
// for reference — flagged when the container is on a bridge that routes
// outbound (which is the default for `bridge` / user-defined bridges).
const IMDS_ENDPOINTS = [
  '169.254.169.254',  // AWS, Azure, OpenStack, GCP
  'metadata.google.internal',
  '169.254.169.253',  // AWS IPv6-compat
  'fd00:ec2::254',    // AWS IPv6
];

const RFC1918_HINTS = ['10.', '172.', '192.168.'];

/**
 * Analyze a single container's network posture.
 *
 * @param {object} inspect - Raw output of `docker inspect` (one container)
 * @param {Map<string, object>} networksByName - Map of network name -> inspect() data
 *                                              (needed to check the `--internal` flag per network)
 * @returns {{
 *   networkMode: string,
 *   networks: Array<{name, internal, gateway, ipAddress}>,
 *   canReachInternet: boolean,
 *   canReachIMDS: boolean,
 *   canReachRFC1918: boolean,
 *   findings: Array<{severity, message, fix}>,
 *   score: number,
 * }}
 */
function analyzeContainer(inspect, networksByName) {
  const findings = [];
  let score = 100;

  const hostConfig = inspect.HostConfig || {};
  const networkSettings = inspect.NetworkSettings || {};
  const networkMode = hostConfig.NetworkMode || 'default';
  const extraHosts = hostConfig.ExtraHosts || [];
  const dns = hostConfig.Dns || [];

  // Network classification
  const attached = networkSettings.Networks || {};
  const networks = Object.entries(attached).map(([name, n]) => {
    const netInfo = networksByName.get(name) || {};
    return {
      name,
      internal: netInfo.Internal === true,
      driver: netInfo.Driver || 'unknown',
      gateway: n.Gateway || null,
      ipAddress: n.IPAddress || null,
    };
  });

  // Verdict flags
  let canReachInternet = false;
  let canReachIMDS = false;
  let canReachRFC1918 = false;

  // --- network mode = host (worst case) ---
  if (networkMode === 'host') {
    score -= 45;
    canReachInternet = true;
    canReachIMDS = true;
    canReachRFC1918 = true;
    findings.push({
      severity: 'critical',
      message: 'Container uses host network mode — no network isolation at all',
      fix: 'Avoid network_mode: host. Use a bridge network with explicit port mappings.',
    });
    return { networkMode, networks, canReachInternet, canReachIMDS, canReachRFC1918, findings, score: Math.max(0, score), extraHosts, dns };
  }

  // --- network mode = none (best case) ---
  if (networkMode === 'none') {
    findings.push({
      severity: 'info',
      message: 'Container has no network access (network_mode: none)',
      fix: '',
    });
    return { networkMode, networks, canReachInternet, canReachIMDS, canReachRFC1918, findings, score, extraHosts, dns };
  }

  // --- network mode = container:<id> (shares another container's stack) ---
  if (networkMode.startsWith('container:')) {
    findings.push({
      severity: 'info',
      message: `Shares network namespace with ${networkMode} — egress posture matches that container`,
      fix: '',
    });
    // We'd need to recurse to compute verdict; leave neutral for v1.
    return { networkMode, networks, canReachInternet, canReachIMDS, canReachRFC1918, findings, score, extraHosts, dns };
  }

  // --- network mode = bridge / user-defined ---
  // Classify attached networks
  const nonInternalNets = networks.filter(n => !n.internal && n.gateway);
  const internalNets = networks.filter(n => n.internal);

  if (nonInternalNets.length > 0) {
    canReachInternet = true;
    canReachIMDS = true;   // any bridge with a gateway can route to 169.254.169.254 unless host blocks it
    canReachRFC1918 = true;

    // Warn only if there is NO internal alternative — an app on both an internal DB net and a public net is normal
    score -= 15;
    findings.push({
      severity: 'warning',
      message: `Can reach public internet + IMDS via ${nonInternalNets.map(n => n.name).join(', ')}`,
      fix: 'If outbound access is not required, attach only to networks with --internal: true (or network_mode: none).',
    });
  } else if (internalNets.length > 0) {
    findings.push({
      severity: 'info',
      message: `Only attached to internal networks (${internalNets.map(n => n.name).join(', ')}) — no outbound`,
      fix: '',
    });
  }

  // Flag ExtraHosts that map to IMDS (rare but a clear smell)
  for (const h of extraHosts) {
    const parts = h.split(':');
    if (parts.length >= 2 && IMDS_ENDPOINTS.includes(parts[1])) {
      score -= 20;
      findings.push({
        severity: 'critical',
        message: `extra_hosts maps "${parts[0]}" to IMDS endpoint ${parts[1]}`,
        fix: 'Remove this extra_hosts entry — it explicitly enables IMDS credential exfiltration.',
      });
    }
  }

  // Custom DNS is not inherently bad, but it's worth surfacing — bypassing
  // the Docker-managed DNS can be a pivot for DNS-based C2.
  if (dns.length > 0) {
    findings.push({
      severity: 'info',
      message: `Custom DNS servers configured: ${dns.join(', ')}`,
      fix: '',
    });
  }

  // Dangerous capability that enables raw socket / firewall manipulation
  const caps = (hostConfig.CapAdd || []).map(normalizeCapability);
  const networkCaps = [];
  if (hostConfig.Privileged || caps.includes('ALL') || caps.includes('NET_ADMIN')) networkCaps.push('NET_ADMIN');
  if (hasRawSocketCapability(hostConfig)) networkCaps.push('NET_RAW');
  if (networkCaps.length) {
    score -= 15;
    findings.push({
      severity: 'warning',
      message: `Has network-privileged capability: ${networkCaps.join(', ')} (including Docker defaults)`,
      fix: 'Explicitly drop NET_RAW (Docker grants it by default) and remove added NET_ADMIN/ALL before applying an egress filter. Recreate the container to change capabilities.',
    });
  }

  return {
    networkMode,
    networks,
    canReachInternet,
    canReachIMDS,
    canReachRFC1918,
    findings,
    score: Math.max(0, score),
    extraHosts,
    dns,
  };
}

module.exports = {
  analyzeContainer,
  _internals: { IMDS_ENDPOINTS, RFC1918_HINTS },
};
