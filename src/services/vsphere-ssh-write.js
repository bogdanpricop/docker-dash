'use strict';

// v8.12 — ESXi firewall WRITE exec path (Phase B). SECURITY-CRITICAL.
//
// WHY A SEPARATE MODULE
//   `vsphere-ssh.js` is DELIBERATELY read-only — every command it runs is a
//   static get/list string, and its header advertises that guarantee. This
//   module holds the MUTATION esxcli commands so the read module never gains a
//   state-changing command of its own. The two share ONE connect/auth/exec
//   implementation via `vsphere-ssh.js`'s `_internals` (no logic is duplicated,
//   and the read module stays free of any mutation).
//
// SAFE COMMAND CONSTRUCTION
//   The SSH channel can only carry a command STRING (no argv), so a fixed
//   template with strictly-validated tokens is the injection boundary. Every
//   command here is built from a constant template; the only interpolated
//   tokens are:
//     • ruleset-id   — must match /^[A-Za-z0-9_.-]+$/ (no shell metacharacters),
//     • ip-address   — must pass validateCidrOrIp (IPv4/IPv6 literal or CIDR),
//     • enabled / allowed-all — strict booleans rendered as the literal
//       'true' | 'false'.
//   Anything else throws before a byte reaches the host. The caller
//   (platform-write.js) ALSO validates the ruleset-id against the host's actual
//   ruleset names first (defence-in-depth), so an unknown ruleset never gets here.
//
// COMMANDS (fixed templates)
//   esxcli network firewall ruleset set        --ruleset-id=<id> --enabled=<bool>
//   esxcli network firewall ruleset set        --ruleset-id=<id> --allowed-all=<bool>
//   esxcli network firewall ruleset allowedip add    --ruleset-id=<id> --ip-address=<ip>
//   esxcli network firewall ruleset allowedip remove --ruleset-id=<id> --ip-address=<ip>
//
// Toggling the WHOLE firewall on/off is intentionally NOT here (Phase B is
// ruleset-level only — see the deep-spec OUT section).

const vsphereSsh = require('./vsphere-ssh');
const validate = require('./firewall/validate');

// A valid esxcli ruleset id — alphanumerics plus _ . - only. This is the SAME
// safety class the read module relies on: no character here can break out of a
// shell token.
const RULESET_ID_RE = /^[A-Za-z0-9_.-]+$/;

function _assertRulesetId(rulesetId) {
  if (typeof rulesetId !== 'string' || !RULESET_ID_RE.test(rulesetId)) {
    throw new Error(`Invalid ESXi ruleset id "${rulesetId}"`);
  }
  return rulesetId;
}

function _assertIp(ipAddress) {
  if (!validate.validateCidrOrIp(ipAddress)) {
    throw new Error(`Invalid IP/CIDR "${ipAddress}"`);
  }
  return ipAddress;
}

// Strict boolean → literal. Never coerce arbitrary truthy values: only real
// booleans reach here (platform-write normalizes first).
function _boolLiteral(v) {
  if (v === true) return 'true';
  if (v === false) return 'false';
  throw new Error(`Expected a strict boolean, got "${v}"`);
}

// Connect, run one mutation command, map a non-zero exit to a friendly error,
// always close the connection. Reuses the read module's SSH plumbing so there is
// exactly one connect/auth/error-mapping implementation.
async function _run(sshConfig, command) {
  const { _connectSsh, _sshExec, _end, _cmdError } = vsphereSsh._internals;
  const ssh = await _connectSsh(sshConfig);
  try {
    const { stdout, stderr, code } = await _sshExec(ssh, command);
    if (code !== 0) throw _cmdError(command, code, stderr);
    return { ok: true, stdout, stderr };
  } finally { _end(ssh); }
}

/** Enable or disable a firewall ruleset. */
async function setRulesetEnabled(sshConfig, rulesetId, enabled) {
  const id = _assertRulesetId(rulesetId);
  const flag = _boolLiteral(enabled);
  await _run(sshConfig, `esxcli network firewall ruleset set --ruleset-id=${id} --enabled=${flag}`);
  return { ok: true };
}

/** Toggle a ruleset's "allow all IPs" flag. */
async function setRulesetAllowedAll(sshConfig, rulesetId, allowedAll) {
  const id = _assertRulesetId(rulesetId);
  const flag = _boolLiteral(allowedAll);
  await _run(sshConfig, `esxcli network firewall ruleset set --ruleset-id=${id} --allowed-all=${flag}`);
  return { ok: true };
}

/** Add an allowed IP / CIDR to a ruleset's allowed list. */
async function addAllowedIp(sshConfig, rulesetId, ipAddress) {
  const id = _assertRulesetId(rulesetId);
  const ip = _assertIp(ipAddress);
  await _run(sshConfig, `esxcli network firewall ruleset allowedip add --ruleset-id=${id} --ip-address=${ip}`);
  return { ok: true };
}

/** Remove an allowed IP / CIDR from a ruleset's allowed list. */
async function removeAllowedIp(sshConfig, rulesetId, ipAddress) {
  const id = _assertRulesetId(rulesetId);
  const ip = _assertIp(ipAddress);
  await _run(sshConfig, `esxcli network firewall ruleset allowedip remove --ruleset-id=${id} --ip-address=${ip}`);
  return { ok: true };
}

module.exports = {
  setRulesetEnabled, setRulesetAllowedAll, addAllowedIp, removeAllowedIp,
  RULESET_ID_RE,
  _internals: { _assertRulesetId, _assertIp, _boolLiteral, _run },
};
