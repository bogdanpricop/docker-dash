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

async function _runOne(host, { bin, argv }, timeoutMs) {
  if (host.connectionType === 'ssh') {
    const sshTunnelService = require('../ssh-tunnel');
    const r = await sshTunnelService.exec(host.id, toShellCommand(bin, argv), { timeoutMs });
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

// Agent channel: POST JSON to the standalone firewall-agent with a bearer token.
function agentRequest(agentCfg, path, body, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(path, agentCfg.url); } catch (e) { return reject(new Error(`Bad agent URL: ${e.message}`)); }
    const payload = Buffer.from(JSON.stringify(body || {}));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        'Authorization': `Bearer ${agentCfg.token || ''}`,
      },
      timeout: timeoutMs,
      // MVP: allow self-signed agent certs; mTLS is a Phase-3 hardening.
      rejectUnauthorized: false,
    }, (res) => {
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

module.exports = { toShellCommand, runCommands, runRead, agentRequest, DEFAULT_TIMEOUT };
