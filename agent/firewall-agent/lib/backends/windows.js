'use strict';

// v8.9.26-alpha.1 — Windows Firewall backend builder (pure). Runs over SSH to a
// Windows OpenSSH host; the runner wraps each script in `powershell
// -EncodedCommand` so it survives the cmd.exe default shell. Host scope only
// (Windows has no DOCKER-USER concept) → HOST_ONLY. Each app rule gets a stable
// Name `APPFW_<uuid>` for deterministic removal.

const NAME = 'windows';

function _ruleName(uuid) { return `APPFW_${uuid}`; }
function _display(uuid, reason) { return reason ? `APPFW ${uuid} ${reason}` : `APPFW ${uuid}`; }
// Reason/uuid are app-generated + sanitized; strip single quotes defensively so
// they can't break a PowerShell single-quoted literal.
function _q(s) { return String(s == null ? '' : s).replace(/'/g, ''); }

function buildApply(spec, ctx) {
  const name = _ruleName(ctx.uuid);
  const action = spec.action === 'allow' ? 'Allow' : 'Block';
  const parts = ['New-NetFirewallRule', `-Name '${_q(name)}'`, `-DisplayName '${_q(_display(ctx.uuid, ctx.reason))}'`, '-Direction Inbound', `-Action ${action}`];
  if (spec.destination_port && spec.protocol !== 'icmp') {
    parts.push(`-Protocol ${spec.protocol.toUpperCase()}`, `-LocalPort ${spec.destination_port}`);
  } else if (spec.protocol === 'icmp') {
    parts.push('-Protocol ICMPv4');
  } // else: no -Protocol → Any (source-only rule)
  if (spec.source_ip) parts.push(`-RemoteAddress '${_q(spec.source_ip)}'`);
  const cmd = parts.join(' ');
  const script = `$ErrorActionPreference='Stop'; ${cmd} | Out-Null; Write-Output 'OK'`;
  return { commands: [{ shell: 'powershell', script }], chain: null, comment_tag: name, rule_expression: cmd };
}

function buildRemove(rule) {
  const name = rule.comment_tag || _ruleName(rule.rule_uuid);
  const script = `Remove-NetFirewallRule -Name '${_q(name)}' -ErrorAction SilentlyContinue; Write-Output 'OK'`;
  return { commands: [{ shell: 'powershell', script }] };
}

function buildSnapshot() {
  return { shell: 'powershell', script: "Get-NetFirewallRule | Where-Object {$_.DisplayName -like 'APPFW*'} | Select-Object Name,DisplayName,Direction,Action,Enabled | ConvertTo-Json" };
}
function buildList() {
  return { shell: 'powershell', script: "Get-NetFirewallRule | Where-Object {$_.DisplayName -like 'APPFW*'} | Format-Table DisplayName,Direction,Action,Enabled -AutoSize | Out-String" };
}
function buildDetect() {
  return { shell: 'powershell', script: "Get-NetFirewallProfile | Out-Null; Write-Output 'windows'" };
}

module.exports = { name: NAME, buildApply, buildRemove, buildSnapshot, buildList, buildDetect, _internals: { _ruleName } };
