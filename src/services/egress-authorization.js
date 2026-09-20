'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { getDb } = require('../db');
const dockerService = require('./docker');
const egressFilter = require('./egress-filter');

function sourceAddress(value) {
  if (typeof value !== 'string') throw new Error('Invalid source address');
  let address = value.toLowerCase().startsWith('::ffff:') ? value.slice(7) : value;
  if (!net.isIP(address) || address.includes('%')) throw new Error('Invalid source address');
  if (net.isIP(address) === 6) address = new URL(`http://[${address}]`).hostname.slice(1, -1);
  return address;
}

function addresses(container) {
  return Object.values(container.NetworkSettings?.Networks || {}).flatMap(network =>
    [network.IPAddress, network.GlobalIPv6Address].filter(Boolean).map(sourceAddress));
}

function hostScope(hostId) {
  const defaultHost = getDb().prepare('SELECT id FROM docker_hosts WHERE is_default = 1 ORDER BY id LIMIT 1').get();
  return id => id === hostId || (defaultHost && [0, defaultHost.id].includes(id) && [0, defaultHost.id].includes(hostId));
}

async function resolveSource(source, { hostId = 0, docker = dockerService.getDocker(hostId),
  policies = () => egressFilter.listPolicies(), matchesHost = hostScope(hostId) } = {}) {
  source = sourceAddress(source);
  const containers = await docker.listContainers({ all: false });
  if (!Array.isArray(containers) || containers.length > 5000) throw new Error('Inventory unavailable or too large');
  const candidates = containers.filter(container => addresses(container).includes(source));
  if (candidates.length !== 1) throw new Error('Source identity missing or ambiguous');
  const id = candidates[0].Id;
  if (!/^[a-f0-9]{64}$/.test(id || '')) throw new Error('Invalid container identity');
  const inspect = await docker.getContainer(id).inspect();
  if (inspect.Id !== id || !inspect.State?.Running || !addresses(inspect).includes(source)) {
    throw new Error('Container identity changed');
  }
  const precheck = egressFilter.canApplyFilter(inspect);
  if (!precheck.ok) throw new Error('Container cannot be safely filtered');
  const project = inspect.Config?.Labels?.['com.docker.compose.project'];
  const applicable = policies().filter(policy => policy.active && matchesHost(policy.hostId) && (
    (policy.scopeType === 'container' && /^[a-f0-9]{12,64}$/.test(policy.scopeKey) && id.startsWith(policy.scopeKey)
      && containers.filter(container => container.Id?.startsWith(policy.scopeKey)).length === 1)
    || (policy.scopeType === 'stack' && project && policy.scopeKey === project)
  ));
  if (!applicable.length || applicable.length > 100) throw new Error('No applicable policy or too many policies');
  const result = applicable.map(policy => {
    if (!['enforce', 'audit-only'].includes(policy.mode) || !Array.isArray(policy.allowlist)
      || policy.allowlist.length > 1000 || policy.allowlist.some(entry => egressFilter._internals.validateAllowlistEntry(entry))) {
      throw new Error('Invalid persisted policy');
    }
    return { id: policy.id, mode: policy.mode, allowlist: policy.allowlist.map(entry => entry.trim().toLowerCase().replace(/\.$/, '')) };
  });
  return { source, containerId: id, policies: result };
}

function createHandler(resolve = resolveSource) {
  let inFlight = 0;
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    let url, source;
    try {
      url = new URL(req.url, 'http://local');
      if (req.method !== 'GET' || url.pathname !== '/resolve' || req.url.length > 256) throw new Error('Invalid request');
      source = sourceAddress(url.searchParams.get('source'));
    } catch { res.writeHead(400); res.end('{"error":"Invalid request"}'); return; }
    if (inFlight >= 32) { res.writeHead(503); res.end('{"error":"Authorization busy"}'); return; }
    inFlight++;
    // Keep timed-out Docker calls counted until they settle, preventing an
    // unavailable daemon from accumulating unbounded work on successive retries.
    const pending = Promise.resolve().then(() => resolve(source)).finally(() => { inFlight--; });
    let timer;
    try {
      const authorization = await Promise.race([pending, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Authorization timeout')), 3000);
      })]);
      const body = JSON.stringify(authorization);
      if (Buffer.byteLength(body) > 65536) throw new Error('Authorization too large');
      res.end(body);
    } catch {
      res.writeHead(403); res.end('{"error":"Source authorization unavailable"}');
    } finally { clearTimeout(timer); }
  };
}

let server;
async function start() {
  if (server || process.platform === 'win32') return false;
  const policyPath = process.env.DD_EGRESS_POLICY_PATH || '/data/egress-policy/policy.json';
  const socketPath = path.join(path.dirname(policyPath), 'resolver.sock');
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(socketPath)) {
    if (!fs.lstatSync(socketPath).isSocket()) throw new Error('Egress resolver path is not a socket');
    // Never steal another live instance's authorization socket.
    const live = await new Promise(resolve => {
      const socket = net.connect(socketPath);
      socket.setTimeout(500);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); resolve(true); });
      socket.once('error', error => { socket.destroy(); resolve(error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT'); });
    });
    if (live) throw new Error('Egress resolver socket already in use');
    fs.unlinkSync(socketPath);
  }
  const listener = http.createServer({ requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 2048 }, createHandler());
  listener.maxConnections = 64;
  listener.timeout = 5000;
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(socketPath, () => {
      try { fs.chmodSync(socketPath, 0o600); resolve(); } catch (error) { listener.close(); reject(error); }
    });
  });
  server = listener;
  return true;
}

async function stop() {
  const listener = server;
  server = null;
  if (!listener) return;
  listener.closeAllConnections();
  await new Promise(resolve => listener.close(resolve));
}

module.exports = { resolveSource, createHandler, start, stop };
