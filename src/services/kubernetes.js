'use strict';

// v8.9.4-alpha.1 — Sprint 5 (Kubernetes) foundation. Read-only client.
//
// SCOPE OF THIS ALPHA:
// Thin HTTPS client + a handful of read operations on namespaces, pods,
// deployments, services, and nodes. Enough to prove the architecture
// works end-to-end against a k3s / k0s / MicroK8s homelab cluster.
// Write operations (scale, rollout-restart, delete pod) land in the
// next alpha once real-world use verifies the plumbing.
//
// SCOPE DISCIPLINE (per deep-spec-sprint-5-kubernetes.md):
// - We are NOT competing with Lens / Rancher / Portainer. This is a
//   dashboard for a Docker-first operator who happens to run a small
//   k3s at home.
// - Everything below is minimum viable: list + status.
// - Anti-features (Helm, Ingress editing, RBAC editing, kubectl-in-
//   browser, Secret viewing, CRD editing) are OUT permanently.
//
// TRANSPORT
// Bearer-token auth over HTTPS. Kubernetes API server typically at
// port 6443 (k3s, k0s) or 8443 (MicroK8s). CA cert verification is
// preferred; skipTlsVerify=true is available for testing but strongly
// discouraged and callable out in howto.
//
// daemon_config shape (encrypted at rest via enc: prefix):
// {
//   endpoint: 'https://k3s.example.com:6443',
//   token: 'eyJhbG...',                    // ServiceAccount bearer token
//   caCert: '-----BEGIN CERTIFICATE-----...', // optional PEM
//   skipTlsVerify: false,                  // testing only
//   namespace: 'default'                   // default ns filter
// }
//
// TIMEOUT + SIZE CAPS
// 30 s per request. 16 MB response cap (namespace with 500 pods returns
// ~2 MB — 16 MB is comfortable headroom).

const https = require('https');
const log = require('../utils/logger')('kubernetes');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * KubernetesClient — thin wrapper over a single Kubernetes API server.
 *
 * Usage:
 *   const c = new KubernetesClient({
 *     endpoint: 'https://k3s.local:6443', token: '...', caCert: '...',
 *   });
 *   const nss = await c.listNamespaces();
 */
class KubernetesClient {
  constructor(config) {
    if (!config || typeof config !== 'object') {
      throw new Error('KubernetesClient: config object required');
    }
    if (!config.endpoint) throw new Error('KubernetesClient: config.endpoint required');
    if (!config.token) throw new Error('KubernetesClient: config.token required');
    this._config = config;
    // Custom Agent with the CA cert loaded if provided; otherwise fall
    // back to system CAs (won't verify a self-signed cluster cert).
    const agentOpts = {
      keepAlive: true,
      rejectUnauthorized: !config.skipTlsVerify,
    };
    if (config.caCert) agentOpts.ca = config.caCert;
    this._agent = new https.Agent(agentOpts);
  }

  /** Which daemon type this client serves. Constant for now — the class is k8s-specific. */
  get daemonType() { return 'kubernetes'; }

  /** Low-level request. Returns parsed JSON or throws. */
  async _request(method, path, body, opts = {}) {
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const url = new URL(path, this._config.endpoint);
    const reqOpts = {
      hostname: url.hostname,
      port: url.port || 443,
      method,
      path: url.pathname + url.search,
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${this._config.token}`,
      },
      agent: this._agent,
    };
    const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : null;
    if (bodyBuf) {
      reqOpts.headers['Content-Type'] = 'application/json';
      reqOpts.headers['Content-Length'] = bodyBuf.length;
    }
    return new Promise((resolve, reject) => {
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
        finish(null, new Error(`Kubernetes request timeout after ${timeoutMs / 1000}s: ${method} ${path}`));
      }, timeoutMs);
      const req = https.request(reqOpts, (res) => {
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            try { req.destroy(); } catch { /* ignore */ }
            finish(null, new Error(`Kubernetes response exceeded ${MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try { parsed = raw ? JSON.parse(raw) : null; }
          catch (e) {
            return finish(null, new Error(`Kubernetes response not JSON (status ${res.statusCode}): ${e.message}`));
          }
          if (res.statusCode >= 400) {
            const msg = (parsed && (parsed.message || parsed.reason)) || `HTTP ${res.statusCode}`;
            return finish(null, Object.assign(new Error(`Kubernetes API error: ${msg}`), {
              status: res.statusCode, kubernetesResponse: parsed,
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

  // ─── Health / version ───────────────────────────────────

  /**
   * GET /version — apiserver version + build info. Used for the
   * connectivity pill on the frontend "connected/not connected" badge.
   */
  async version() { return this._request('GET', '/version'); }

  // ─── Namespaces ─────────────────────────────────────────

  /**
   * GET /api/v1/namespaces — list namespaces. The response shape is a
   * standard k8s List: { kind, items: [...] }. We surface items only.
   */
  async listNamespaces() {
    const resp = await this._request('GET', '/api/v1/namespaces');
    return (resp && resp.items) || [];
  }

  // ─── Pods ───────────────────────────────────────────────

  /**
   * List pods, optionally scoped to a namespace. The unscoped variant
   * uses /api/v1/pods (all namespaces), which returns items with a
   * .metadata.namespace field so the frontend can group.
   */
  async listPods(namespace) {
    const path = namespace
      ? `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`
      : '/api/v1/pods';
    const resp = await this._request('GET', path);
    return (resp && resp.items) || [];
  }

  // ─── Deployments ────────────────────────────────────────

  /**
   * List Deployments (apps/v1 group). Only extension: we return items.
   */
  async listDeployments(namespace) {
    const path = namespace
      ? `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments`
      : '/apis/apps/v1/deployments';
    const resp = await this._request('GET', path);
    return (resp && resp.items) || [];
  }

  // ─── Services ───────────────────────────────────────────

  async listServices(namespace) {
    const path = namespace
      ? `/api/v1/namespaces/${encodeURIComponent(namespace)}/services`
      : '/api/v1/services';
    const resp = await this._request('GET', path);
    return (resp && resp.items) || [];
  }

  // ─── Nodes ──────────────────────────────────────────────

  /** GET /api/v1/nodes — cluster nodes. */
  async listNodes() {
    const resp = await this._request('GET', '/api/v1/nodes');
    return (resp && resp.items) || [];
  }
}

// daemon_config encryption at rest — same enc: prefix pattern as Incus /
// Proxmox / git credentials. Keyed by ENCRYPTION_KEY.

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

function encryptDaemonConfig(cfg) {
  const { encrypt } = require('../utils/crypto');
  const plain = JSON.stringify(cfg || {});
  return 'enc:' + encrypt(plain);
}

/** Build a KubernetesClient from a docker_hosts row. */
function fromHostRow(row) {
  if (!row) throw new Error('fromHostRow: row required');
  if (row.daemon_type !== 'kubernetes') {
    throw new Error(`fromHostRow: row is not a Kubernetes host (daemon_type=${row.daemon_type})`);
  }
  let cfg;
  try { cfg = decryptDaemonConfig(row.daemon_config); }
  catch (e) { throw new Error(`fromHostRow: invalid daemon_config: ${e.message}`); }
  return new KubernetesClient(cfg);
}

module.exports = {
  KubernetesClient,
  fromHostRow,
  decryptDaemonConfig,
  encryptDaemonConfig,
  _internals: { DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES },
};

if (false) log.info();
