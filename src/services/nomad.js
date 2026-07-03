'use strict';

// v8.9.5-alpha.1 — Sprint 10: HashiCorp Nomad read-only client.
//
// Nomad is HashiCorp's workload orchestrator — jobs (containers, exec,
// java, raw_exec, qemu) scheduled onto client nodes. Simpler mental
// model than Kubernetes, popular in homelabs and smaller shops that
// want scheduling without the k8s surface area.
//
// TRANSPORT: HTTP(S) on port 4646 (default). Auth via ACL token in
// X-Nomad-Token header. TLS verification via optional CA cert.
//
// daemon_config shape (encrypted at rest via enc: prefix):
// {
//   endpoint: 'https://nomad.example.com:4646',
//   token: 'ACL-TOKEN-UUID',            // optional if ACL disabled
//   caCert: '...PEM...',                // optional
//   skipTlsVerify: false,
//   region: 'global',                   // default region filter
//   namespace: 'default'                // Nomad namespaces (Enterprise; OSS uses 'default')
// }
//
// SCOPE OF THIS ALPHA: read-only jobs / allocations / nodes / deployments.
// Job start/stop and eval submission deferred to alpha.2.

const http = require('http');
const https = require('https');
const log = require('../utils/logger')('nomad');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

class NomadClient {
  constructor(config) {
    if (!config || typeof config !== 'object') {
      throw new Error('NomadClient: config object required');
    }
    if (!config.endpoint) throw new Error('NomadClient: config.endpoint required');
    this._config = config;
    const isHttps = /^https:/i.test(config.endpoint);
    this._lib = isHttps ? https : http;
    const agentOpts = { keepAlive: true };
    if (isHttps) {
      agentOpts.rejectUnauthorized = !config.skipTlsVerify;
      if (config.caCert) agentOpts.ca = config.caCert;
    }
    this._agent = new this._lib.Agent(agentOpts);
  }

  get daemonType() { return 'nomad'; }

  async _request(method, path, body, opts = {}) {
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const url = new URL(path, this._config.endpoint);
    const reqOpts = {
      hostname: url.hostname,
      port: url.port || (this._lib === https ? 443 : 4646),
      method,
      path: url.pathname + url.search,
      headers: { 'Accept': 'application/json' },
      agent: this._agent,
    };
    if (this._config.token) reqOpts.headers['X-Nomad-Token'] = this._config.token;
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
        finish(null, new Error(`Nomad request timeout after ${timeoutMs / 1000}s: ${method} ${path}`));
      }, timeoutMs);
      const req = this._lib.request(reqOpts, (res) => {
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            try { req.destroy(); } catch { /* ignore */ }
            finish(null, new Error(`Nomad response exceeded ${MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try { parsed = raw ? JSON.parse(raw) : null; }
          catch (e) {
            // Nomad occasionally returns plain-text errors (401, 403);
            // surface the raw body when JSON parse fails.
            return finish(null, Object.assign(new Error(`Nomad non-JSON response (status ${res.statusCode}): ${raw.slice(0, 200)}`), {
              status: res.statusCode, nomadResponseText: raw,
            }));
          }
          if (res.statusCode >= 400) {
            const msg = (parsed && (parsed.error || parsed.message)) || `HTTP ${res.statusCode}`;
            return finish(null, Object.assign(new Error(`Nomad API error: ${msg}`), {
              status: res.statusCode, nomadResponse: parsed,
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

  /** GET /v1/agent/self — daemon version + region + config summary. */
  async agentSelf() { return this._request('GET', '/v1/agent/self'); }

  // ─── Jobs ───────────────────────────────────────────────

  /** GET /v1/jobs?namespace=...  — list all jobs in the namespace. */
  async listJobs(namespace) {
    const q = namespace ? `?namespace=${encodeURIComponent(namespace)}` : '';
    return await this._request('GET', `/v1/jobs${q}`) || [];
  }

  async getJob(jobId, namespace) {
    const q = namespace ? `?namespace=${encodeURIComponent(namespace)}` : '';
    return this._request('GET', `/v1/job/${encodeURIComponent(jobId)}${q}`);
  }

  async listJobAllocations(jobId, namespace) {
    const q = namespace ? `?namespace=${encodeURIComponent(namespace)}` : '';
    return await this._request('GET', `/v1/job/${encodeURIComponent(jobId)}/allocations${q}`) || [];
  }

  // ─── Allocations (running task instances) ───────────────

  async listAllocations(namespace) {
    const q = namespace ? `?namespace=${encodeURIComponent(namespace)}` : '';
    return await this._request('GET', `/v1/allocations${q}`) || [];
  }

  // ─── Nodes (Nomad client nodes = workers) ───────────────

  async listNodes() { return await this._request('GET', '/v1/nodes') || []; }

  // ─── Deployments ────────────────────────────────────────

  async listDeployments(namespace) {
    const q = namespace ? `?namespace=${encodeURIComponent(namespace)}` : '';
    return await this._request('GET', `/v1/deployments${q}`) || [];
  }

  // ─── Namespaces (Enterprise; OSS returns single 'default') ──

  async listNamespaces() {
    try { return await this._request('GET', '/v1/namespaces') || []; }
    catch (err) {
      // OSS returns 501 for /v1/namespaces if not enabled — surface as
      // an empty list rather than 500ing the whole page.
      if (err && (err.status === 501 || err.status === 400)) return [];
      throw err;
    }
  }
}

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
  return 'enc:' + encrypt(JSON.stringify(cfg || {}));
}

function fromHostRow(row) {
  if (!row) throw new Error('fromHostRow: row required');
  if (row.daemon_type !== 'nomad') {
    throw new Error(`fromHostRow: row is not a Nomad host (daemon_type=${row.daemon_type})`);
  }
  let cfg;
  try { cfg = decryptDaemonConfig(row.daemon_config); }
  catch (e) { throw new Error(`fromHostRow: invalid daemon_config: ${e.message}`); }
  return new NomadClient(cfg);
}

module.exports = {
  NomadClient,
  fromHostRow,
  decryptDaemonConfig,
  encryptDaemonConfig,
  _internals: { DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES },
};

if (false) log.info();
