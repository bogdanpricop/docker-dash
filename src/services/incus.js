'use strict';

// v8.9.0-alpha — Sprint 3 foundation: Incus (LXC + KVM VMs) client.
//
// SCOPE OF THIS ALPHA:
// Thin HTTP client + a handful of read operations on instances and
// snapshots. Enough to prove the architecture works end-to-end against a
// real Incus daemon; the UI page + write operations (start/stop/delete/
// snapshot create/restore) land in v8.9.0 proper once a maintainer with
// an actual Incus host has verified the plumbing.
//
// TRANSPORT
// Incus talks JSON over HTTPS on port 8443 for remote hosts (TLS client
// cert auth) or over a Unix socket at /var/lib/incus/unix.socket (root
// or incus-admin group) for local hosts.
//
// The docker-dash container does not mount the Incus socket by default —
// operators who want local Incus need to add:
//   volumes:
//     - /var/lib/incus/unix.socket:/var/lib/incus/unix.socket
// to their compose file, and configure a hosts row with daemon_type='incus'
// and daemon_config = {"transport":"unix","socket":"/var/lib/incus/unix.socket"}.
//
// For remote: daemon_config = {"transport":"https","endpoint":
//   "https://host:8443","cert":"...PEM...","key":"...PEM...","fingerprint":"..."}
// TLS-verified via the server cert fingerprint (Incus's standard trust
// model — clients trust a specific fingerprint, not a CA).
//
// TIMEOUT + SIZE CAPS
// Per the v8.7.x hardening pattern, every fetch has an explicit
// AbortController with a 30 s cap. Response bodies are read as JSON
// with a 16 MB safety limit (Incus responses are usually a few KB;
// larger implies something is wrong).

const http = require('http');
const https = require('https');
const log = require('../utils/logger')('incus');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * IncusClient — thin wrapper over a single Incus endpoint.
 *
 * Usage:
 *   const c = new IncusClient({ transport: 'unix', socket: '...' });
 *   const list = await c.listInstances();
 */
class IncusClient {
  constructor(config) {
    if (!config || typeof config !== 'object') {
      throw new Error('IncusClient: config object required');
    }
    this._config = config;
    if (config.transport === 'unix') {
      if (!config.socket) throw new Error('IncusClient: config.socket required for unix transport');
      this._agent = new http.Agent({ keepAlive: true });
    } else if (config.transport === 'https') {
      if (!config.endpoint) throw new Error('IncusClient: config.endpoint required for https transport');
      // NOTE: cert/key parsing is stubbed here. Real production use needs:
      //   - PEM strings passed as opts.cert + opts.key on each request
      //   - Or a per-endpoint https.Agent with the cert already loaded
      //   - Fingerprint verification via socket 'secureConnect' hook
      // Deferred to v8.9.0 proper.
      this._agent = new https.Agent({ keepAlive: true, rejectUnauthorized: !config.skipTlsVerify });
    } else {
      throw new Error(`IncusClient: unsupported transport "${config.transport}"`);
    }
  }

  /** Low-level request. Returns parsed JSON or throws. */
  async _request(method, path, body, opts = {}) {
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const isUnix = this._config.transport === 'unix';
    const reqOpts = isUnix
      ? {
        socketPath: this._config.socket,
        method,
        path,
        headers: { 'Accept': 'application/json' },
        agent: this._agent,
      }
      : (() => {
        const url = new URL(path, this._config.endpoint);
        return {
          hostname: url.hostname,
          port: url.port || 8443,
          method,
          path: url.pathname + url.search,
          headers: { 'Accept': 'application/json' },
          agent: this._agent,
          cert: this._config.cert,
          key: this._config.key,
        };
      })();
    const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : null;
    if (bodyBuf) {
      reqOpts.headers['Content-Type'] = 'application/json';
      reqOpts.headers['Content-Length'] = bodyBuf.length;
    }
    return new Promise((resolve, reject) => {
      const lib = isUnix ? http : https;
      let bytes = 0;
      const chunks = [];
      let settled = false;
      const finish = (result, err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve(result);
      };
      const timer = setTimeout(() => {
        try { req.destroy(); } catch { /* ignore */ }
        finish(null, new Error(`Incus request timeout after ${timeoutMs / 1000}s: ${method} ${path}`));
      }, timeoutMs);
      const req = lib.request(reqOpts, (res) => {
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            try { req.destroy(); } catch { /* ignore */ }
            finish(null, new Error(`Incus response exceeded ${MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try { parsed = raw ? JSON.parse(raw) : null; }
          catch (e) {
            return finish(null, new Error(`Incus response not JSON (status ${res.statusCode}): ${e.message}`));
          }
          if (res.statusCode >= 400) {
            const msg = (parsed && (parsed.error || parsed.error_code || parsed.metadata))
              || `HTTP ${res.statusCode}`;
            return finish(null, Object.assign(new Error(`Incus API error: ${msg}`), {
              status: res.statusCode, incusResponse: parsed,
            }));
          }
          finish(parsed);
        });
      });
      req.on('error', (err) => finish(null, err));
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }

  /** GET /1.0 — daemon info + supported API versions. Used for health probing. */
  async info() {
    return this._request('GET', '/1.0');
  }

  /**
   * List instances (containers + VMs) with recursion=1 so each element
   * has status, IPs, memory, and CPU usage in one call. This is the
   * canonical shape for a "list all instances" table.
   */
  async listInstances(project) {
    const q = project ? `?project=${encodeURIComponent(project)}&recursion=1` : '?recursion=1';
    const resp = await this._request('GET', `/1.0/instances${q}`);
    // Incus API wraps every response in { metadata, status_code, ... }.
    return (resp && resp.metadata) || [];
  }

  /** Detail on a single instance. */
  async getInstance(name, project) {
    const p = project ? `?project=${encodeURIComponent(project)}` : '';
    const resp = await this._request('GET', `/1.0/instances/${encodeURIComponent(name)}${p}`);
    return resp && resp.metadata;
  }

  /** List snapshots for one instance. */
  async listSnapshots(name, project) {
    const p = project ? `?project=${encodeURIComponent(project)}&recursion=1` : '?recursion=1';
    const resp = await this._request('GET', `/1.0/instances/${encodeURIComponent(name)}/snapshots${p}`);
    return (resp && resp.metadata) || [];
  }

  /** List images configured on this Incus. */
  async listImages() {
    const resp = await this._request('GET', '/1.0/images?recursion=1');
    return (resp && resp.metadata) || [];
  }

  /** List projects (Incus multi-tenancy primitive). */
  async listProjects() {
    const resp = await this._request('GET', '/1.0/projects?recursion=1');
    return (resp && resp.metadata) || [];
  }
}

// Helper: build an IncusClient from a docker_hosts row (JSON string in
// daemon_config). Kept in this module so route/service code doesn't
// need to know the config shape.
function fromHostRow(row) {
  if (!row) throw new Error('fromHostRow: row required');
  if (row.daemon_type !== 'incus') {
    throw new Error(`fromHostRow: row is not an Incus host (daemon_type=${row.daemon_type})`);
  }
  let cfg;
  try { cfg = row.daemon_config ? JSON.parse(row.daemon_config) : {}; }
  catch (e) { throw new Error(`fromHostRow: invalid daemon_config JSON: ${e.message}`); }
  if (!cfg.transport) cfg.transport = 'unix';
  if (cfg.transport === 'unix' && !cfg.socket) cfg.socket = '/var/lib/incus/unix.socket';
  return new IncusClient(cfg);
}

module.exports = {
  IncusClient,
  fromHostRow,
  // Constants exposed for tests
  _internals: { DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES },
};

// Silence "unused" for log — module retains reference for future use
// (start/stop/delete operations will log audit events here).
if (false) log.info();
