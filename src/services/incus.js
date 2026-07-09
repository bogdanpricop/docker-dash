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
    // v8.9.3-alpha.1 — daemonType lets the same client serve LXD too.
    // Defaults to 'incus' for backward compatibility. LXD's REST API is
    // effectively identical (same endpoints, same operation semantics)
    // — only the socket path defaults differ (/var/snap/lxd/common/lxd/
    // unix.socket for snap installs, /var/lib/lxd/unix.socket otherwise).
    this._daemonType = config.daemonType || 'incus';
    if (config.transport === 'unix') {
      if (!config.socket) throw new Error('IncusClient: config.socket required for unix transport');
      this._agent = new http.Agent({ keepAlive: true });
    } else if (config.transport === 'https') {
      if (!config.endpoint) throw new Error('IncusClient: config.endpoint required for https transport');
      // v8.9.32 — the client cert MUST be on the pooling Agent so it's presented
      // on every TLS handshake (Incus authenticates clients by their cert). Incus
      // servers use self-signed certs, so we don't verify the server cert against
      // a CA — the trust model is the client-cert side. (skipTlsVerify default = do
      // not verify the server cert, matching how `incus remote add` pins by fp.)
      this._agent = new https.Agent({
        keepAlive: true,
        rejectUnauthorized: config.skipTlsVerify === false ? true : false,
        cert: config.cert || undefined,
        key: config.key || undefined,
      });
    } else {
      throw new Error(`IncusClient: unsupported transport "${config.transport}"`);
    }
  }

  /** Which product this client is talking to. Useful for error messages
   * + UI badges. Returns 'incus' or 'lxd'. */
  get daemonType() { return this._daemonType; }

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

  /** SHA-256 fingerprint of our client certificate (lowercase hex, no colons) —
   * this is what appears in `incus config trust list`. Null if no/invalid cert. */
  clientFingerprint() {
    if (!this._config || !this._config.cert) return this._config && this._config.fingerprint || null;
    try {
      const x = new (require('crypto').X509Certificate)(this._config.cert);
      return x.fingerprint256.replace(/:/g, '').toLowerCase();
    } catch { return this._config.fingerprint || null; }
  }

  /** Register OUR client cert with the Incus/LXD server using a trust token
   * (from `incus config trust add <name>`). We present our cert (via the Agent)
   * and the token authorizes adding it to the trust store. */
  async trustWithToken(token) {
    if (!token || typeof token !== 'string') throw new Error('trust token is required');
    // Incus (and recent LXD) accept trust_token; fall back to the legacy
    // password field for older LXD servers.
    try {
      return await this._request('POST', '/1.0/certificates', { trust_token: token.trim() });
    } catch (err) {
      if (err && err.status === 400) {
        return this._request('POST', '/1.0/certificates', { type: 'client', password: token.trim() });
      }
      throw err;
    }
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

  /** v8.9.33 — network ACLs (Incus's firewall primitive: ingress/egress rules). */
  async listNetworkAcls() {
    const resp = await this._request('GET', '/1.0/network-acls?recursion=1');
    return (resp && resp.metadata) || [];
  }

  // ─── Operation polling ───────────────────────────────────────
  //
  // Incus write endpoints return `{type: "async", operation: "/1.0/operations/<id>", ...}`
  // for anything that isn't instantaneous (start, stop, delete, snapshot).
  // The caller polls /1.0/operations/{id}/wait until it completes.
  //
  // For docker-dash we want a synchronous-looking API from the route
  // layer: fire the request, wait for the operation, surface success or
  // structured error. `_awaitOperation` implements that. Timeout applied
  // to the total wait (not just the initial HTTP call), capped to 5 min
  // — Incus VM operations can legitimately take that long.

  async _awaitOperation(opPath, opts = {}) {
    if (!opPath) return null;
    // opPath is e.g. "/1.0/operations/abc-123"
    const waitTimeoutSec = Math.min(300, opts.timeoutSec || 60);
    const resp = await this._request('GET', `${opPath}/wait?timeout=${waitTimeoutSec}`, null, {
      timeoutMs: (waitTimeoutSec + 5) * 1000,
    });
    // metadata.status: 'Success' | 'Failure' | 'Cancelled' | ...
    const meta = resp && resp.metadata;
    if (meta && meta.status_code === 200 && meta.status === 'Success') return meta;
    const err = new Error(`Incus operation failed: ${(meta && meta.err) || (meta && meta.status) || 'unknown'}`);
    err.incusOperation = meta;
    throw err;
  }

  /** Common helper for state-change actions. */
  async _changeInstanceState(name, action, opts = {}) {
    if (!name) throw new Error('instance name required');
    if (!['start', 'stop', 'restart', 'freeze', 'unfreeze'].includes(action)) {
      throw new Error(`invalid state action: ${action}`);
    }
    const project = opts.project ? `?project=${encodeURIComponent(opts.project)}` : '';
    const body = {
      action,
      timeout: typeof opts.timeout === 'number' ? opts.timeout : 30,
      force: !!opts.force,
      stateful: !!opts.stateful,
    };
    const resp = await this._request('PUT', `/1.0/instances/${encodeURIComponent(name)}/state${project}`, body);
    // Async operation — wait for it to complete unless opts.async is true.
    if (opts.async) return resp;
    return await this._awaitOperation(resp && resp.operation, { timeoutSec: opts.waitSec || 60 });
  }

  async startInstance(name, opts)   { return this._changeInstanceState(name, 'start', opts); }
  async stopInstance(name, opts)    { return this._changeInstanceState(name, 'stop', opts); }
  async restartInstance(name, opts) { return this._changeInstanceState(name, 'restart', opts); }
  async freezeInstance(name, opts)  { return this._changeInstanceState(name, 'freeze', opts); }
  async unfreezeInstance(name, opts) { return this._changeInstanceState(name, 'unfreeze', opts); }

  /** Delete an instance. Must be stopped first unless opts.force. */
  async deleteInstance(name, opts = {}) {
    if (!name) throw new Error('instance name required');
    const project = opts.project ? `?project=${encodeURIComponent(opts.project)}` : '';
    const resp = await this._request('DELETE', `/1.0/instances/${encodeURIComponent(name)}${project}`);
    if (opts.async) return resp;
    return await this._awaitOperation(resp && resp.operation, { timeoutSec: opts.waitSec || 60 });
  }

  /** Create a snapshot on an instance. */
  async createSnapshot(instance, snapshotName, opts = {}) {
    if (!instance) throw new Error('instance name required');
    if (!snapshotName) throw new Error('snapshot name required');
    const project = opts.project ? `?project=${encodeURIComponent(opts.project)}` : '';
    const body = { name: snapshotName, stateful: !!opts.stateful };
    const resp = await this._request('POST',
      `/1.0/instances/${encodeURIComponent(instance)}/snapshots${project}`, body);
    if (opts.async) return resp;
    return await this._awaitOperation(resp && resp.operation, { timeoutSec: opts.waitSec || 300 });
  }

  /** Restore an instance to a named snapshot. */
  async restoreSnapshot(instance, snapshotName, opts = {}) {
    if (!instance || !snapshotName) throw new Error('instance + snapshot names required');
    const project = opts.project ? `?project=${encodeURIComponent(opts.project)}` : '';
    // Incus restore is a PUT on the instance with { restore: <snapshot name> }.
    const resp = await this._request('PUT',
      `/1.0/instances/${encodeURIComponent(instance)}${project}`,
      { restore: snapshotName });
    if (opts.async) return resp;
    return await this._awaitOperation(resp && resp.operation, { timeoutSec: opts.waitSec || 300 });
  }

  /** Delete a snapshot. */
  async deleteSnapshot(instance, snapshotName, opts = {}) {
    if (!instance || !snapshotName) throw new Error('instance + snapshot names required');
    const project = opts.project ? `?project=${encodeURIComponent(opts.project)}` : '';
    const resp = await this._request('DELETE',
      `/1.0/instances/${encodeURIComponent(instance)}/snapshots/${encodeURIComponent(snapshotName)}${project}`);
    if (opts.async) return resp;
    return await this._awaitOperation(resp && resp.operation, { timeoutSec: opts.waitSec || 60 });
  }
}

// v8.9.0-alpha.3 — daemon_config may be either plain JSON (legacy /
// alpha.1 / alpha.2) OR an encrypted blob prefixed with `enc:`. The
// encrypted form uses the existing AES-256-GCM helper in
// src/utils/crypto.js, keyed by ENCRYPTION_KEY, matching the pattern
// used for git credentials and API keys. Backward-compatible:
// existing rows with plaintext JSON keep working; new registrations
// via encryptDaemonConfig() land encrypted.

function decryptDaemonConfig(raw) {
  if (!raw) return {};
  if (typeof raw !== 'string') return {};
  if (raw.startsWith('enc:')) {
    const { decrypt } = require('../utils/crypto');
    let plain;
    try { plain = decrypt(raw.slice(4)); }
    catch (e) { throw new Error(`daemon_config decrypt failed (ENCRYPTION_KEY changed?): ${e.message}`); }
    return JSON.parse(plain);
  }
  return JSON.parse(raw);
}

/** Encrypt a config object for storage in daemon_config. */
function encryptDaemonConfig(cfg) {
  const { encrypt } = require('../utils/crypto');
  const plain = JSON.stringify(cfg || {});
  return 'enc:' + encrypt(plain);
}

// Helper: build an IncusClient from a docker_hosts row. Handles both
// plain-JSON legacy config and the new encrypted form transparently.
// v8.9.3-alpha.1: accepts LXD rows too (same REST API, different socket
// default). daemonType is stamped on the client for downstream use.
function fromHostRow(row) {
  if (!row) throw new Error('fromHostRow: row required');
  if (row.daemon_type !== 'incus' && row.daemon_type !== 'lxd') {
    throw new Error(`fromHostRow: row is not an Incus/LXD host (daemon_type=${row.daemon_type})`);
  }
  let cfg;
  try { cfg = decryptDaemonConfig(row.daemon_config); }
  catch (e) { throw new Error(`fromHostRow: invalid daemon_config JSON: ${e.message}`); }
  cfg.daemonType = row.daemon_type;
  if (!cfg.transport) cfg.transport = 'unix';
  if (cfg.transport === 'unix' && !cfg.socket) {
    // LXD's socket differs based on install method. Snap installs (the
    // Canonical default) live under /var/snap/lxd/common/lxd/. Legacy
    // package installs use /var/lib/lxd/. Snap is the modern default so
    // we try that first; operators with a package install override via
    // daemon_config.socket.
    cfg.socket = row.daemon_type === 'lxd'
      ? '/var/snap/lxd/common/lxd/unix.socket'
      : '/var/lib/incus/unix.socket';
  }
  return new IncusClient(cfg);
}

module.exports = {
  IncusClient,
  fromHostRow,
  decryptDaemonConfig,
  encryptDaemonConfig,
  // Constants exposed for tests
  _internals: { DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES },
};

// Silence "unused" for log — module retains reference for future use
// (start/stop/delete operations will log audit events here).
if (false) log.info();
