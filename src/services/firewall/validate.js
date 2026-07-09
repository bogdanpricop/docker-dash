'use strict';

// v8.9.22-alpha.1 — Firewall input validation (pure, zero-dep). Shared by the
// backend service AND the standalone agent (agent keeps its own copy). Every
// value that reaches a firewall command MUST pass through here first. We validate
// structurally AND reject shell metacharacters as defence-in-depth, because the
// SSH channel can only send a command string (no argv), so a controlled template
// with strictly-validated tokens is the safety boundary.

const net = require('net');

const ACTIONS = ['allow', 'block'];
const SCOPES = ['host', 'docker', 'container'];
const PROTOCOLS = ['tcp', 'udp', 'icmp'];

// Anything that could break out of a token in a shell/nft/ps context.
const DANGEROUS = /[;&|`$><(){}\[\]!*?~\n\r\t\\'"\s]/;

function validateIp(ip) {
  return typeof ip === 'string' && net.isIP(ip) !== 0;
}

// IPv4/IPv6 literal, or CIDR with an in-range prefix length.
function validateCidrOrIp(v) {
  if (typeof v !== 'string' || DANGEROUS.test(v)) return false;
  const slash = v.indexOf('/');
  if (slash === -1) return validateIp(v);
  const addr = v.slice(0, slash);
  const prefix = v.slice(slash + 1);
  const fam = net.isIP(addr);
  if (fam === 0) return false;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const n = parseInt(prefix, 10);
  return fam === 4 ? n >= 0 && n <= 32 : n >= 0 && n <= 128;
}

function validatePort(p) {
  const n = typeof p === 'number' ? p : parseInt(p, 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function validateProtocol(p) { return PROTOCOLS.includes(p); }
function validateScope(s) { return SCOPES.includes(s); }
function validateAction(a) { return ACTIONS.includes(a); }

// Temporary-rule lifetime: 1 minute .. 7 days.
function validateExpiryMinutes(m) {
  const n = typeof m === 'number' ? m : parseInt(m, 10);
  return Number.isInteger(n) && n >= 1 && n <= 10080;
}

// Reason is embedded in a rule comment/tag — keep it human but shell-safe.
function sanitizeReason(reason) {
  if (!reason) return '';
  return String(reason).replace(/[^\w .:@/-]/g, '').slice(0, 120).trim();
}

/**
 * Validate a normalized rule spec, throwing a clear Error on the first problem.
 * @param {object} spec { action, scope, source_ip?, destination_port?, protocol? }
 * @returns {object} the normalized spec (protocol defaulted to 'tcp', reason sanitized)
 */
function assertSafe(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('Missing rule spec');
  const action = spec.action;
  const scope = spec.scope;
  if (!validateAction(action)) throw new Error(`Invalid action "${action}" (allow|block)`);
  if (!validateScope(scope)) throw new Error(`Invalid scope "${scope}" (host|docker|container)`);

  const out = { action, scope };

  if (spec.source_ip !== undefined && spec.source_ip !== null && spec.source_ip !== '') {
    if (!validateCidrOrIp(spec.source_ip)) throw new Error(`Invalid source IP/CIDR "${spec.source_ip}"`);
    out.source_ip = spec.source_ip;
  }
  if (spec.destination_port !== undefined && spec.destination_port !== null && spec.destination_port !== '') {
    if (!validatePort(spec.destination_port)) throw new Error(`Invalid port "${spec.destination_port}" (1-65535)`);
    out.destination_port = parseInt(spec.destination_port, 10);
  }
  const proto = spec.protocol || 'tcp';
  if (!validateProtocol(proto)) throw new Error(`Invalid protocol "${proto}" (tcp|udp|icmp)`);
  out.protocol = proto;

  // A rule must constrain SOMETHING — refuse an all-traffic allow/block with no
  // source and no port (that would be an accidental blanket rule).
  if (out.source_ip === undefined && out.destination_port === undefined) {
    throw new Error('A rule must specify at least a source IP or a destination port');
  }

  out.reason = sanitizeReason(spec.reason);
  return out;
}

module.exports = {
  ACTIONS, SCOPES, PROTOCOLS, DANGEROUS,
  validateIp, validateCidrOrIp, validatePort, validateProtocol, validateScope,
  validateAction, validateExpiryMinutes, sanitizeReason, assertSafe,
};
