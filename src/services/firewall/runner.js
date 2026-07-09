'use strict';

// v8.9.22-alpha.1 — firewall execution channels. Three ways to run privileged
// firewall work on a host, none of which give the app container host privileges:
//   • ssh   → reuse the host's live SSH tunnel (sshTunnelService.exec)
//   • local → execFileSync inside the container (only works if the operator added
//             iptables/caps + host netns; otherwise "unavailable" — by design)
//   • agent → HTTP(S) to a standalone firewall-agent that does the privileged work
// For ssh/local the SERVICE builds the argv and we run it here. For agent, the
// service sends the rule SPEC to the agent's whitelisted endpoint (agentRequest).

const { execFileSync } = require('child_process');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT = 20000;

// POSIX single-quote every token so a validated command survives the SSH shell.
function toShellCommand(bin, argv) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return [bin, ...argv].map(q).join(' ');
}

// PowerShell -EncodedCommand payload (base64/UTF-16LE) — cmd.exe-safe, so a
// validated PS script survives the Windows OpenSSH default shell.
function psEncode(script) { return Buffer.from(script, 'utf16le').toString('base64'); }

// Firewall binaries live in /usr/sbin (often absent from a non-root login PATH)
// and require root. So over SSH we: (1) put /usr/sbin on PATH, and (2) use
// passwordless sudo when it's available — a root SSH user runs directly, a user
// with NOPASSWD sudo runs via sudo, and an unprivileged user fails cleanly.
function _sshFirewallCommand(bin, argv) {
  const inner = toShellCommand(bin, argv);
  return 'export PATH=/usr/sbin:/sbin:/usr/local/sbin:$PATH; '
    + `if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then sudo -n ${inner}; else ${inner}; fi`;
}

// Run a list of {bin, argv} commands in order. Stops at the first non-zero exit.
// Returns { exitCode, stdout, stderr }.
async function runCommands(host, commands, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
  let stdout = '', stderr = '';
  for (const c of commands) {
    const r = await _runOne(host, c, timeoutMs);
    stdout += r.stdout || '';
    stderr += r.stderr || '';
    if (r.exitCode !== 0) return { exitCode: r.exitCode, stdout, stderr };
  }
  return { exitCode: 0, stdout, stderr };
}

async function _runOne(host, command, timeoutMs) {
  // Windows Firewall: a PowerShell script (encoded so it survives cmd.exe).
  if (command.shell === 'powershell') {
    const b64 = psEncode(command.script);
    if (host.connectionType === 'ssh') {
      const sshTunnelService = require('../ssh-tunnel');
      const r = await sshTunnelService.exec(host.id, `powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`, { timeoutMs });
      return { exitCode: r.exitCode == null ? 0 : r.exitCode, stdout: r.stdout, stderr: r.stderr };
    }
    try {
      const stdout = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { timeout: timeoutMs, encoding: 'utf8' });
      return { exitCode: 0, stdout, stderr: '' };
    } catch (err) {
      return { exitCode: err.code === 'ENOENT' ? 127 : (err.status == null ? 1 : err.status), stdout: (err.stdout || '').toString(), stderr: (err.stderr || err.message || '').toString() };
    }
  }

  const { bin, argv } = command;
  if (host.connectionType === 'ssh') {
    const sshTunnelService = require('../ssh-tunnel');
    const r = await sshTunnelService.exec(host.id, _sshFirewallCommand(bin, argv), { timeoutMs });
    return { exitCode: r.exitCode == null ? 0 : r.exitCode, stdout: r.stdout, stderr: r.stderr };
  }
  // local (socket/tcp host id representing the machine docker-dash runs on)
  try {
    const stdout = execFileSync(bin, argv, { timeout: timeoutMs, encoding: 'utf8' });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { exitCode: 127, stdout: '', stderr: `${bin} not found on this host (firewall backend unavailable in the container)` };
    }
    return { exitCode: err.status == null ? 1 : err.status, stdout: (err.stdout || '').toString(), stderr: (err.stderr || err.message || '').toString() };
  }
}

// Read a single command's stdout (detect/list/snapshot). Throws on non-zero.
async function runRead(host, command, opts) {
  const r = await runCommands(host, [command], opts);
  if (r.exitCode !== 0) {
    const e = new Error(r.stderr || `command failed (exit ${r.exitCode})`);
    e.exitCode = r.exitCode;
    throw e;
  }
  return r.stdout;
}

// Build the http(s).request options for an agent call. When the agent config
// carries a client cert+key (mTLS), present them and REQUIRE a valid server cert
// (verified against the provided CA); otherwise fall back to bearer-token auth
// over http/https with a relaxed server-cert check (self-signed agent).
function _agentReqOptions(agentCfg, payloadLen, timeoutMs) {
  const o = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': payloadLen,
      'Authorization': `Bearer ${agentCfg.token || ''}`,
    },
    timeout: timeoutMs,
  };
  const tls = agentCfg.tls;
  if (tls && tls.cert && tls.key) {
    o.cert = tls.cert; o.key = tls.key;
    if (tls.ca) o.ca = tls.ca;
    o.rejectUnauthorized = true; // mutual TLS — verify the agent's cert
  } else {
    o.rejectUnauthorized = false; // token-only: tolerate a self-signed agent cert
  }
  return o;
}

// Agent channel: POST JSON to the standalone firewall-agent (bearer token, and
// mutual TLS when client certs are configured).
function agentRequest(agentCfg, path, body, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(path, agentCfg.url); } catch (e) { return reject(new Error(`Bad agent URL: ${e.message}`)); }
    const payload = Buffer.from(JSON.stringify(body || {}));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, _agentReqOptions(agentCfg, payload.length, timeoutMs), (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : {}; } catch { json = { raw: data }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
        else reject(new Error((json && json.error) || `agent HTTP ${res.statusCode}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('agent request timed out')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { toShellCommand, runCommands, runRead, agentRequest, psEncode, DEFAULT_TIMEOUT, _internals: { _agentReqOptions, _sshFirewallCommand } };
