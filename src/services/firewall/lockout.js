'use strict';

// v8.9.22-alpha.1 — lockout guard. The single most dangerous firewall mistake is
// locking yourself (and docker-dash) out of the host. Before ANY block/close, we
// refuse to touch the SSH port docker-dash manages the host through, the
// docker-dash management port, or a protected admin source IP.

const MGMT_PORT = 8101; // docker-dash HTTP

/**
 * @param {object} p
 * @param {number} p.sshPort    the SSH port docker-dash uses for this host (default 22)
 * @param {object} p.spec       normalized rule spec (from validate.assertSafe)
 * @param {string[]} [p.adminIps] source IPs that must never be blocked
 * @param {string} [p.requesterIp] the admin's own IP (never block it)
 * @throws Error if the rule would risk a lockout
 */
function check({ sshPort = 22, spec, adminIps = [], requesterIp }) {
  if (!spec || spec.action !== 'block') return; // only blocks/closes are dangerous
  const protectedPorts = new Set([Number(sshPort) || 22, MGMT_PORT]);

  if (spec.destination_port && protectedPorts.has(Number(spec.destination_port)) && !spec.source_ip) {
    throw new Error(`Refusing to close port ${spec.destination_port} for everyone — it is the SSH/management port (lockout guard). Restrict by a source IP if you really need this.`);
  }

  const neverBlock = new Set([...(adminIps || [])]);
  if (requesterIp) neverBlock.add(requesterIp);
  if (spec.source_ip && neverBlock.has(spec.source_ip)) {
    throw new Error(`Refusing to block ${spec.source_ip} — it is your own / an admin IP (lockout guard).`);
  }
}

module.exports = { check, MGMT_PORT };
