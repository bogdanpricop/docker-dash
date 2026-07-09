#!/usr/bin/env node
'use strict';

// docker-dash firewall-agent (MVP1). A tiny, dependency-free (Node stdlib only)
// local service that performs whitelisted firewall operations on THIS host, so
// docker-dash never needs host privileges itself. It reuses the EXACT same pure
// validation + backend builders as the dashboard (files under ./lib are verbatim
// copies of src/services/firewall/*), then executes the built argv with execFile
// (no shell) as root/sudo.
//
// Security: bearer-token auth (timing-safe), binds to 127.0.0.1 by default,
// whitelisted operations only, strict input validation, no raw-command endpoint.
//
// Env:
//   FW_AGENT_TOKEN  (required)  shared secret; put the SAME value in docker-dash
//   FW_AGENT_PORT   (default 9090)
//   FW_AGENT_BIND   (default 127.0.0.1)
//   FW_AGENT_SUDO   ("1" to prefix commands with sudo)
//   FW_AGENT_TLS    ("1" to serve HTTPS with mutual TLS — see README)
//   FW_AGENT_TLS_CERT / FW_AGENT_TLS_KEY / FW_AGENT_TLS_CA  (PEM file paths)

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { assertSafe } = require('./lib/validate');
const backends = require('./lib/backends');

const TOKEN = process.env.FW_AGENT_TOKEN || '';
const PORT = parseInt(process.env.FW_AGENT_PORT, 10) || 9090;
const BIND = process.env.FW_AGENT_BIND || '127.0.0.1';
const USE_SUDO = process.env.FW_AGENT_SUDO === '1';
const USE_TLS = process.env.FW_AGENT_TLS === '1';

if (!TOKEN || TOKEN.length < 16) {
  console.error('FATAL: set FW_AGENT_TOKEN to a long random secret (>=16 chars).');
  process.exit(1);
}

function run(bin, argv, timeoutMs = 20000) {
  return new Promise((resolve) => {
    // Shell-only backends (e.g. Windows PowerShell) have no argv bin — the Linux
    // agent doesn't support them, so report "not available" instead of crashing.
    if (!bin) return resolve({ exitCode: 127, stdout: '', stderr: 'backend not supported by this agent' });
    const file = USE_SUDO ? 'sudo' : bin;
    const args = USE_SUDO ? [bin, ...argv] : argv;
    execFile(file, args, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) resolve({ exitCode: err.code === 'ENOENT' ? 127 : (err.status == null ? 1 : err.status), stdout: stdout || '', stderr: stderr || err.message });
      else resolve({ exitCode: 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function runCommands(commands) {
  let stdout = '', stderr = '';
  for (const c of commands) {
    const r = await run(c.bin, c.argv);
    stdout += r.stdout; stderr += r.stderr;
    if (r.exitCode !== 0) return { exitCode: r.exitCode, stdout, stderr };
  }
  return { exitCode: 0, stdout, stderr };
}

async function detect() {
  for (const name of backends.DETECT_ORDER) {
    const be = backends.get(name);
    const r = await run(be.buildDetect().bin, be.buildDetect().argv, 8000);
    if (r.exitCode !== 0) continue;
    if (name === 'firewalld' && !/running/i.test(r.stdout)) continue;
    if (name === 'ufw' && !/Status:\s*active/i.test(r.stdout)) continue;
    return name;
  }
  return null;
}

function authOk(req) {
  const h = req.headers['authorization'] || '';
  const got = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = Buffer.from(got); const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, code, obj) { const s = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(s); }

const handler = (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (!authOk(req)) return send(res, 401, { error: 'unauthorized' });
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let payload = {};
    try { payload = body ? JSON.parse(body) : {}; } catch { return send(res, 400, { error: 'bad JSON' }); }
    try {
      const path = req.url.split('?')[0];
      if (path === '/detect') { return send(res, 200, { backend: await detect() }); }
      if (path === '/list') {
        const be = await detect(); if (!be) return send(res, 200, { backend: null, raw: '' });
        const r = await run(backends.get(be).buildList().bin, backends.get(be).buildList().argv);
        return send(res, 200, { backend: be, raw: r.stdout });
      }
      if (path === '/snapshot') {
        const be = await detect(); if (!be) return send(res, 200, { backend: null, content: '' });
        const r = await run(backends.get(be).buildSnapshot().bin, backends.get(be).buildSnapshot().argv);
        return send(res, 200, { backend: be, content: r.stdout });
      }
      if (path === '/apply') {
        const spec = assertSafe(payload.spec);
        const be = await detect(); if (!be) return send(res, 200, { ok: false, error: 'no firewall backend detected' });
        if (be === 'ufw' && (spec.scope === 'docker' || spec.scope === 'container')) return send(res, 200, { ok: false, error: 'ufw cannot filter Docker ports; use iptables' });
        const built = backends.get(be).buildApply(spec, { uuid: payload.uuid || 'nouuid', reason: spec.reason });
        const rr = await runCommands(built.commands);
        if (rr.exitCode !== 0) return send(res, 200, { ok: false, error: rr.stderr || `exit ${rr.exitCode}` });
        return send(res, 200, { ok: true, backend: be, built: { chain: built.chain, comment_tag: built.comment_tag, rule_expression: built.rule_expression } });
      }
      if (path === '/remove') {
        const rule = payload.rule || {};
        const be = backends.get(rule.backend) || backends.get(await detect());
        if (!be) return send(res, 200, { ok: false, error: 'no backend' });
        const built = be.buildRemove(rule);
        const rr = await runCommands(built.commands);
        if (rr.exitCode !== 0) return send(res, 200, { ok: false, error: rr.stderr || `exit ${rr.exitCode}` });
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'unknown endpoint' });
    } catch (err) {
      return send(res, 200, { ok: false, error: err.message });
    }
  });
};

let server;
if (USE_TLS) {
  // Mutual TLS: present our server cert AND require a client cert signed by our
  // CA. docker-dash presents its client cert (configured on the host row).
  const opts = {
    cert: fs.readFileSync(process.env.FW_AGENT_TLS_CERT),
    key: fs.readFileSync(process.env.FW_AGENT_TLS_KEY),
    ca: fs.readFileSync(process.env.FW_AGENT_TLS_CA),
    requestCert: true,
    rejectUnauthorized: true,
  };
  server = require('https').createServer(opts, handler);
} else {
  server = http.createServer(handler);
}

server.listen(PORT, BIND, () => console.log(`firewall-agent listening on ${USE_TLS ? 'https' : 'http'}://${BIND}:${PORT} (sudo=${USE_SUDO}, mTLS=${USE_TLS})`));
