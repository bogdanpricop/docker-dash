'use strict';

// v8.9.1-alpha.1 — Sprint 4 (Proxmox VE) foundation.
//
// SCOPE OF THIS ALPHA:
// Thin HTTPS client + read-only operations across VMs, LXC, nodes, and
// storages. Enough to prove the architecture works end-to-end against
// a real Proxmox cluster; state-changing operations (start/stop VMs,
// snapshots, backups) land in v8.9.1-alpha.2 once a maintainer with
// an actual Proxmox host has verified the plumbing.
//
// TRANSPORT
// Proxmox VE speaks JSON over HTTPS on port 8006. Every cluster node
// serves the API; requests go to any one node and it forwards
// internally as needed. API endpoint: https://<node>:8006/api2/json/*
//
// AUTH
// Two mechanisms:
//   - Session ticket (cookie + CSRFPreventionToken) — for interactive
//     browser sessions.
//   - API token (single Authorization header) — for automation.
//     Format: "PVEAPIToken=USER@REALM!TOKENID=UUID"
//
// docker-dash uses API tokens only — they're stable, revocable, and
// scoped per-user. The token secret is stored in daemon_config,
// encrypted at rest by the same helper as Incus (v8.9.0-alpha.3).
//
// TLS
// Proxmox homelab installs commonly use self-signed certs. We support
// skipTlsVerify=true (with clear warning in the howto) plus explicit
// CA trust via a pinned fingerprint (deferred to alpha.2).
//
// TIMEOUT + SIZE CAPS (matches v8.7.x hardening pattern):
//   - 30 s AbortController timeout on every request
//   - 16 MB response body cap

const https = require('https');
const log = require('../utils/logger')('proxmox');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

class ProxmoxClient {
  constructor(config) {
    if (!config || typeof config !== 'object') {
      throw new Error('ProxmoxClient: config object required');
    }
    if (!config.endpoint) {
      throw new Error('ProxmoxClient: config.endpoint required (e.g. https://pve.example.com:8006)');
    }
    // v8.9.11-alpha.6 — normalize: prepend https:// if bare hostname given.
    if (!/^https?:\/\//i.test(config.endpoint)) {
      config = { ...config, endpoint: 'https://' + config.endpoint };
    }
    if (!config.tokenId || !config.tokenSecret) {
      throw new Error('ProxmoxClient: config.tokenId + config.tokenSecret required (PVEAPIToken auth)');
    }
    if (!/^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+![a-zA-Z0-9._-]+$/.test(config.tokenId)) {
      throw new Error('ProxmoxClient: tokenId must be in "USER@REALM!TOKENID" form');
    }
    this._config = config;
    this._agent = new https.Agent({
      keepAlive: true,
      rejectUnauthorized: !config.skipTlsVerify,
    });
  }

  async _request(method, path, body, opts = {}) {
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const url = new URL(path, this._config.endpoint);
    const reqOpts = {
      hostname: url.hostname,
      port: url.port || 8006,
      method,
      path: url.pathname + url.search,
      headers: {
        'Accept': 'application/json',
        'Authorization': `PVEAPIToken=${this._config.tokenId}=${this._config.tokenSecret}`,
      },
      agent: this._agent,
    };
    let bodyBuf = null;
    if (body) {
      // Proxmox accepts JSON and form-encoded; JSON is cleaner.
      bodyBuf = Buffer.from(JSON.stringify(body));
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
        finish(null, Object.assign(new Error(`Proxmox request timeout after ${timeoutMs / 1000}s: ${method} ${path}`), {
          code: 'ETIMEDOUT', transient: true,
        }));
      }, timeoutMs);
      const req = https.request(reqOpts, (res) => {
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            try { req.destroy(); } catch { /* ignore */ }
            return finish(null, new Error(`Proxmox response exceeded ${MAX_RESPONSE_BYTES} bytes`));
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try { parsed = raw ? JSON.parse(raw) : null; }
          catch (e) {
            return finish(null, new Error(`Proxmox response not JSON (status ${res.statusCode}): ${e.message}`));
          }
          // Proxmox error shape: {data: null, errors: {...}}
          if (res.statusCode >= 400) {
            const errMsg = (parsed && parsed.errors)
              ? Object.entries(parsed.errors).map(([k, v]) => `${k}: ${v}`).join('; ')
              : `HTTP ${res.statusCode}`;
            return finish(null, Object.assign(new Error(`Proxmox API error: ${errMsg}`), {
              status: res.statusCode, proxmoxResponse: parsed,
            }));
          }
          // Success envelope: { data: ... }
          finish(parsed && parsed.data);
        });
      });
      req.on('error', (err) => finish(null, err));
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }

  /** GET /api2/json/version — daemon version. Used as a health probe. */
  async version() {
    return this._request('GET', '/api2/json/version');
  }

  /** List cluster nodes. */
  async listNodes() {
    return (await this._request('GET', '/api2/json/nodes')) || [];
  }

  // v8.9.33 — pve-firewall state (read-only).
  async getClusterFirewallOptions() { return this._request('GET', '/api2/json/cluster/firewall/options'); }
  async getClusterFirewallRules() { return (await this._request('GET', '/api2/json/cluster/firewall/rules')) || []; }
  async getNodeFirewallOptions(node) { return this._request('GET', `/api2/json/nodes/${encodeURIComponent(node)}/firewall/options`); }
  async getNodeFirewallRules(node) { return (await this._request('GET', `/api2/json/nodes/${encodeURIComponent(node)}/firewall/rules`)) || []; }

  // v8.11 — pve-firewall WRITE (Phase A). Thin wrappers over _request; the
  // safety pipeline (validate + lockout guard + snapshot + commit-confirmed
  // auto-revert) lives in src/services/firewall/platform-write.js. These just
  // move bytes. Rule body shape: {type, action, source?, dest?, proto?, dport?,
  // enable, comment}. Options body e.g. {enable}.
  async setClusterFirewallOptions(opts) { return this._request('PUT', '/api2/json/cluster/firewall/options', opts); }
  async createClusterFirewallRule(rule) { return this._request('POST', '/api2/json/cluster/firewall/rules', rule); }
  async deleteClusterFirewallRule(pos) { return this._request('DELETE', `/api2/json/cluster/firewall/rules/${encodeURIComponent(pos)}`); }
  async setNodeFirewallOptions(node, opts) { return this._request('PUT', `/api2/json/nodes/${encodeURIComponent(node)}/firewall/options`, opts); }
  async createNodeFirewallRule(node, rule) { return this._request('POST', `/api2/json/nodes/${encodeURIComponent(node)}/firewall/rules`, rule); }
  async deleteNodeFirewallRule(node, pos) { return this._request('DELETE', `/api2/json/nodes/${encodeURIComponent(node)}/firewall/rules/${encodeURIComponent(pos)}`); }

  /** List all VMs across the cluster (via /cluster/resources?type=vm). */
  async listVMs() {
    return (await this._request('GET', '/api2/json/cluster/resources?type=vm')) || [];
  }

  /**
   * List LXC containers across the cluster. Note: Proxmox's /cluster/
   * resources endpoint returns both VMs and LXCs when queried without
   * a type filter; we filter here for clarity of the caller-facing API.
   */
  async listLXC() {
    const all = (await this._request('GET', '/api2/json/cluster/resources')) || [];
    return all.filter(r => r.type === 'lxc');
  }

  /** List storages across the cluster. */
  async listStorages() {
    return (await this._request('GET', '/api2/json/cluster/resources?type=storage')) || [];
  }

  /**
   * List deployable artifacts without returning provider credentials or URLs.
   * Proxmox models QEMU templates as cluster VM resources, while ISO and LXC
   * templates are storage content and therefore have to be enumerated per node.
   */
  async listArtifacts() {
    const [guests, nodes] = await Promise.all([this.listVMs(), this.listNodes()]);
    const artifacts = guests.filter(row => Number(row?.template) === 1 && row?.type !== 'lxc')
      .map(row => ({
        kind: 'vmTemplate', nativeRef: `qemu/${row.vmid}`, id: `qemu/${row.vmid}`,
        name: row.name || `VM template ${row.vmid}`, description: row.description || null,
        node: row.node || null, source: 'cluster-vm-template',
        cpuCount: row.maxcpu, memoryBytes: row.maxmem, sizeBytes: row.disk,
        tags: typeof row.tags === 'string' ? row.tags.split(/[;,]/).filter(Boolean) : [],
      }));
    const seen = new Set(artifacts.map(item => `${item.kind}|${item.nativeRef}`));
    for (const node of nodes || []) {
      if (!node?.node) continue;
      let storages;
      try {
        storages = await this._request('GET', `/api2/json/nodes/${encodeURIComponent(node.node)}/storage`);
      } catch { continue; }
      for (const storage of storages || []) {
        if (!storage?.storage || storage.enabled === 0 || storage.active === 0) continue;
        for (const contentType of ['iso', 'vztmpl']) {
          let rows;
          try {
            rows = await this._request('GET', `/api2/json/nodes/${encodeURIComponent(node.node)}/storage/${encodeURIComponent(storage.storage)}/content?content=${contentType}`);
          } catch { continue; }
          for (const row of rows || []) {
            const nativeRef = String(row.volid || row.id || '');
            const kind = contentType === 'iso' ? 'iso' : 'containerTemplate';
            if (!nativeRef || seen.has(`${kind}|${nativeRef}`)) continue;
            seen.add(`${kind}|${nativeRef}`);
            const basename = nativeRef.split('/').pop()?.split(':').pop() || nativeRef;
            artifacts.push({
              kind, nativeRef, id: nativeRef, name: row.name || basename,
              description: row.notes || null, node: node.node, storage: storage.storage,
              source: 'storage-content', sizeBytes: row.size, createdAt: row.ctime ? Number(row.ctime) * 1000 : null,
              format: row.format || (kind === 'iso' ? 'iso' : null),
            });
          }
        }
      }
    }
    return artifacts;
  }

  /** Inspect a single VM (state, config). */
  async getVM(node, vmid) {
    return this._request('GET', `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(vmid)}/status/current`);
  }

  /** Submit a QEMU/LXC power operation. Returns the native UPID. */
  async vmPowerAction(node, vmid, guestType, action) {
    const type = guestType === 'lxc' ? 'lxc' : guestType === 'qemu' ? 'qemu' : null;
    const endpointAction = {
      start: 'start', shutdown: 'shutdown', reboot: 'reboot',
      forceShutdown: 'stop', forceReboot: 'reset',
    }[action];
    if (!type || !endpointAction || (type === 'lxc' && action === 'forceReboot')) {
      throw Object.assign(new Error('Proxmox VM power action is unavailable'), { code: 'PROVIDER_ACTION_UNAVAILABLE', status: 400 });
    }
    const upid = await this._request('POST', `/api2/json/nodes/${encodeURIComponent(node)}/${type}/${encodeURIComponent(vmid)}/status/${endpointAction}`, {});
    if (typeof upid !== 'string' || !upid.startsWith('UPID:')) {
      throw Object.assign(new Error('Proxmox power operation returned no task'), { code: 'INVALID_PROVIDER_TASK_RESPONSE' });
    }
    return { taskRef: upid, node, provider: 'proxmox' };
  }

  async getTaskStatus(node, upid) {
    return this._request('GET', `/api2/json/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`);
  }

  async stopTask(node, upid) {
    await this._request('DELETE', `/api2/json/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}`);
    return { ok: true };
  }

  _guestPath(node, vmid, guestType) {
    const type = guestType === 'lxc' ? 'lxc' : guestType === 'qemu' ? 'qemu' : null;
    if (!type || !/^[A-Za-z0-9._-]{1,160}$/.test(String(node || '')) || !/^\d{1,20}$/.test(String(vmid || ''))) {
      throw Object.assign(new Error('Invalid Proxmox guest target'), { code: 'INVALID_PROVIDER_RESOURCE', status: 400 });
    }
    return `/api2/json/nodes/${encodeURIComponent(node)}/${type}/${encodeURIComponent(vmid)}`;
  }

  async listVMSnapshots(node, vmid, guestType) {
    const rows = (await this._request('GET', `${this._guestPath(node, vmid, guestType)}/snapshot`)) || [];
    const currentParent = rows.find(row => row?.name === 'current')?.parent || null;
    return rows.filter(row => row?.name && row.name !== 'current').map(row => ({
      nativeRef: String(row.name), name: String(row.name),
      description: row.description || null,
      createdAt: Number(row.snaptime) > 0 ? new Date(Number(row.snaptime) * 1000).toISOString() : null,
      parentRef: row.parent && row.parent !== 'current' ? String(row.parent) : null,
      isCurrent: currentParent === row.name, consistency: 'unknown', provider: 'proxmox',
    }));
  }

  async createVMSnapshot(node, vmid, guestType, options = {}) {
    const taskRef = await this._request('POST', `${this._guestPath(node, vmid, guestType)}/snapshot`, {
      snapname: options.name, ...(options.description ? { description: options.description } : {}),
    });
    return this._snapshotTask(taskRef, node);
  }

  async revertVMSnapshot(node, vmid, guestType, snapshotRef) {
    const taskRef = await this._request('POST', `${this._guestPath(node, vmid, guestType)}/snapshot/${encodeURIComponent(snapshotRef)}/rollback`, {});
    return this._snapshotTask(taskRef, node);
  }

  async deleteVMSnapshot(node, vmid, guestType, snapshotRef) {
    const taskRef = await this._request('DELETE', `${this._guestPath(node, vmid, guestType)}/snapshot/${encodeURIComponent(snapshotRef)}`);
    return this._snapshotTask(taskRef, node);
  }

  _snapshotTask(taskRef, node) {
    if (typeof taskRef !== 'string' || !taskRef.startsWith('UPID:')) {
      throw Object.assign(new Error('Proxmox snapshot operation returned no task'), { code: 'INVALID_PROVIDER_TASK_RESPONSE' });
    }
    return { taskRef, node, provider: 'proxmox' };
  }

  /** Inspect a single LXC (state, config). */
  async getLXC(node, vmid) {
    return this._request('GET', `/api2/json/nodes/${encodeURIComponent(node)}/lxc/${encodeURIComponent(vmid)}/status/current`);
  }

  /**
   * List backup files stored across the cluster.
   * Backups live per-storage — you query /nodes/{node}/storage/{storage}/content
   * with content=backup. This lists the union across all storages.
   */
  async listBackups() {
    const nodes = await this.listNodes();
    const all = [];
    for (const n of nodes) {
      try {
        const storages = await this._request('GET', `/api2/json/nodes/${encodeURIComponent(n.node)}/storage`);
        for (const s of (storages || [])) {
          if (!s.storage) continue;
          try {
            const contents = await this._request(
              'GET',
              `/api2/json/nodes/${encodeURIComponent(n.node)}/storage/${encodeURIComponent(s.storage)}/content?content=backup`
            );
            for (const c of (contents || [])) {
              all.push({ ...c, node: n.node, storage: s.storage });
            }
          } catch { /* skip storages that error */ }
        }
      } catch { /* skip nodes that error */ }
    }
    // Sort newest first.
    all.sort((a, b) => (b.ctime || 0) - (a.ctime || 0));
    return all;
  }
}

// ─── Config helpers (mirror the Incus pattern) ─────────────────
//
// daemon_config for Proxmox is a JSON blob with:
//   { endpoint: "https://pve.example.com:8006",
//     tokenId: "root@pam!docker-dash",
//     tokenSecret: "<UUID>",
//     skipTlsVerify: true|false }
//
// Encrypted at rest via the same AES-256-GCM helper Incus uses
// (src/utils/crypto.js), with the "enc:" prefix indicating encrypted
// form. Plaintext JSON is still accepted for backward compatibility.

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
  if (row.daemon_type !== 'proxmox') {
    throw new Error(`fromHostRow: row is not a Proxmox host (daemon_type=${row.daemon_type})`);
  }
  let cfg;
  try { cfg = decryptDaemonConfig(row.daemon_config); }
  catch (e) { throw new Error(`fromHostRow: invalid daemon_config: ${e.message}`); }
  return new ProxmoxClient(cfg);
}

module.exports = {
  ProxmoxClient,
  fromHostRow,
  decryptDaemonConfig,
  encryptDaemonConfig,
  _internals: { DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES },
};

// Silence unused-log warning; log is retained for the write-path
// audit hooks that land in alpha.2.
if (false) log.info();
