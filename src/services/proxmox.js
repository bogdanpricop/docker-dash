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

function _parseSizeBytes(value) {
  const match = /^([0-9]+(?:\.[0-9]+)?)([KMGTPE]?)$/i.exec(String(value || '').trim());
  if (!match) return null;
  const power = ['', 'K', 'M', 'G', 'T', 'P', 'E'].indexOf(match[2].toUpperCase());
  const bytes = Number(match[1]) * (power < 0 ? 1 : 1024 ** power);
  return Number.isSafeInteger(Math.round(bytes)) ? Math.round(bytes) : null;
}

function _configParts(value) {
  const parts = String(value || '').split(',');
  const options = {};
  for (const part of parts.slice(1)) {
    const at = part.indexOf('=');
    if (at > 0) options[part.slice(0, at)] = part.slice(at + 1);
  }
  return { source: parts[0] || '', options };
}

function _flag(value) {
  if (value === undefined || value === null || value === '') return null;
  return !['0', 'false', 'off', 'no'].includes(String(value).toLowerCase());
}

function _proxmoxHotplug(config, device) {
  if (config.hotplug === undefined) return null;
  return String(config.hotplug).split(/[;,]/).includes(device);
}

function _storageBacking(source) {
  const match = /^([^:]+):(.+)$/.exec(String(source || ''));
  return {
    type: match ? 'storage-volume' : 'host-path',
    storageId: match?.[1] || null, storageName: match?.[1] || null,
    path: match?.[2] || source || null,
  };
}

function _parseProxmoxHardware(config = {}, guestType = 'qemu', agentInterfaces = []) {
  const disks = [];
  const nics = [];
  const agentByMac = new Map((Array.isArray(agentInterfaces) ? agentInterfaces : []).map(item => [
    String(item?.['hardware-address'] || item?.hardwareAddress || '').toUpperCase(), item,
  ]));
  if (guestType === 'qemu') {
    for (const [device, value] of Object.entries(config)) {
      const diskMatch = /^(ide|sata|scsi|virtio)(\d+)$/.exec(device);
      if (diskMatch && typeof value === 'string') {
        const { source, options } = _configParts(value);
        const cdrom = options.media === 'cdrom' || source === 'cdrom';
        disks.push({
          nativeRef: device, label: device, type: cdrom ? 'cdrom' : 'disk', device,
          bus: diskMatch[1], unit: Number(diskMatch[2]), capacityBytes: _parseSizeBytes(options.size),
          provisioning: options.preallocation === 'full' ? 'thick' : (options.preallocation ? 'unknown' : 'thin'),
          format: options.format || null, backing: _storageBacking(source),
          attachment: { connected: source !== 'none', startConnected: true, bootable: null, readOnly: cdrom, shared: _flag(options.shared) },
          capabilities: {
            hotPlug: _proxmoxHotplug(config, 'disk'), hotUnplug: _proxmoxHotplug(config, 'disk'),
            onlineResize: cdrom ? false : null,
          }, status: source === 'none' ? 'disconnected' : 'configured',
        });
      }
      const nicMatch = /^net(\d+)$/.exec(device);
      if (nicMatch && typeof value === 'string') {
        const { source, options } = _configParts(value);
        const modelMatch = /^([^=]+)=([0-9A-Fa-f:.-]+)$/.exec(source);
        const macAddress = modelMatch?.[2] || options.hwaddr || null;
        const agent = agentByMac.get(String(macAddress || '').toUpperCase());
        nics.push({
          nativeRef: device, label: device, device, model: modelMatch?.[1] || null, macAddress,
          network: { id: options.bridge || null, name: options.bridge || null, bridge: options.bridge || null, vlanId: options.tag },
          addresses: (agent?.['ip-addresses'] || []).map(address => ({
            address: address?.['ip-address'], prefixLength: address?.prefix, source: 'guest-agent',
          })),
          mtu: options.mtu, attachment: { connected: !_flag(options.link_down), startConnected: !_flag(options.link_down) },
          security: { firewall: _flag(options.firewall) }, qos: { rateLimitMbps: options.rate },
          capabilities: {
            hotPlug: _proxmoxHotplug(config, 'network'), hotUnplug: _proxmoxHotplug(config, 'network'), connectDisconnect: true,
          }, status: _flag(options.link_down) ? 'disconnected' : 'configured',
        });
      }
    }
  } else {
    for (const [device, value] of Object.entries(config)) {
      const diskMatch = /^(rootfs|mp(\d+))$/.exec(device);
      if (diskMatch && typeof value === 'string') {
        const { source, options } = _configParts(value);
        disks.push({
          nativeRef: device, label: device, type: device === 'rootfs' ? 'rootfs' : 'mount', device,
          bus: 'lxc-mount', unit: diskMatch[2] === undefined ? 0 : Number(diskMatch[2]) + 1,
          capacityBytes: _parseSizeBytes(options.size), provisioning: 'unknown', backing: _storageBacking(source),
          attachment: { connected: true, startConnected: true, bootable: device === 'rootfs', readOnly: _flag(options.ro) },
          capabilities: { hotPlug: null, hotUnplug: null, onlineResize: null }, status: 'configured',
        });
      }
      const nicMatch = /^net(\d+)$/.exec(device);
      if (nicMatch && typeof value === 'string') {
        const { source, options } = _configParts(value);
        const firstAt = source.indexOf('=');
        if (firstAt > 0) options[source.slice(0, firstAt)] = source.slice(firstAt + 1);
        const addresses = [];
        for (const ip of [options.ip, options.ip6]) {
          if (!ip || ['dhcp', 'auto', 'manual'].includes(String(ip).toLowerCase())) continue;
          const [address, prefixLength] = String(ip).split('/');
          addresses.push({ address, prefixLength, source: 'configuration' });
        }
        nics.push({
          nativeRef: device, label: options.name || device, device: options.name || device,
          model: options.type || 'veth', macAddress: options.hwaddr,
          network: { id: options.bridge || null, name: options.bridge || null, bridge: options.bridge || null, vlanId: options.tag },
          addresses, mtu: options.mtu, attachment: { connected: !_flag(options.link_down), startConnected: !_flag(options.link_down) },
          security: { firewall: _flag(options.firewall) }, qos: { rateLimitMbps: options.rate },
          capabilities: { hotPlug: null, hotUnplug: null, connectDisconnect: null },
          status: _flag(options.link_down) ? 'disconnected' : 'configured',
        });
      }
    }
  }
  return { disks, nics, diskAvailable: true, nicAvailable: true };
}

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

  /** Read-only Corosync/HA evidence used by the common HA readiness model. */
  async getClusterStatus() {
    return (await this._request('GET', '/api2/json/cluster/status')) || [];
  }

  async getHaStatus() {
    return (await this._request('GET', '/api2/json/cluster/ha/status/current')) || [];
  }

  async getHaResources() {
    return (await this._request('GET', '/api2/json/cluster/ha/resources')) || [];
  }

  /** Proxmox VE 9+ HA affinity rules (read-only). */
  async getHaRules() {
    return (await this._request('GET', '/api2/json/cluster/ha/rules')) || [];
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

  async getVmHardware(node, guestType, vmid) {
    const safeNode = String(node || '');
    const type = String(guestType || '');
    const id = Number(vmid);
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(safeNode) || !['qemu', 'lxc'].includes(type)
      || !Number.isSafeInteger(id) || id <= 0) {
      throw Object.assign(new Error('Invalid Proxmox VM hardware target'), { code: 'INVALID_PROVIDER_RESOURCE' });
    }
    const config = await this._request('GET',
      `/api2/json/nodes/${encodeURIComponent(safeNode)}/${type}/${id}/config`);
    let interfaces = [];
    if (type === 'qemu' && config?.agent && !/^0(?:,|$)/.test(String(config.agent))) {
      try {
        const result = await this._request('GET',
          `/api2/json/nodes/${encodeURIComponent(safeNode)}/qemu/${id}/agent/network-get-interfaces`);
        interfaces = result?.result || result || [];
      } catch { /* guest-agent networking is optional */ }
    }
    return _parseProxmoxHardware(config || {}, type, interfaces);
  }

  async getVmMigrationPreconditions(node, guestType, vmid) {
    const safeNode = String(node || '');
    const type = String(guestType || '');
    const id = Number(vmid);
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(safeNode) || !['qemu', 'lxc'].includes(type)
      || !Number.isSafeInteger(id) || id <= 0) {
      throw Object.assign(new Error('Invalid Proxmox VM migration target'), { code: 'INVALID_PROVIDER_RESOURCE' });
    }
    return this._request('GET', `/api2/json/nodes/${encodeURIComponent(safeNode)}/${type}/${id}/migrate`);
  }

  async getVmConfig(node, guestType, vmid) {
    const safeNode = String(node || '');
    const type = String(guestType || '');
    const id = Number(vmid);
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(safeNode) || !['qemu', 'lxc'].includes(type)
      || !Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error('Invalid Proxmox VM target'), { code: 'INVALID_PROVIDER_RESOURCE' });
    return this._request('GET', `/api2/json/nodes/${encodeURIComponent(safeNode)}/${type}/${id}/config`);
  }

  async getNodeMigrationInventory(node) {
    const safeNode = String(node || '');
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(safeNode)) {
      throw Object.assign(new Error('Invalid Proxmox migration node'), { code: 'INVALID_PROVIDER_RESOURCE' });
    }
    const [storages, networks] = await Promise.all([
      this._request('GET', `/api2/json/nodes/${encodeURIComponent(safeNode)}/storage`),
      this._request('GET', `/api2/json/nodes/${encodeURIComponent(safeNode)}/network`),
    ]);
    return { storages: storages || [], networks: networks || [] };
  }

  /**
   * Create Proxmox's short-lived VM console proxy ticket. The caller must keep
   * the returned ticket server-side and use it immediately with
   * /vncwebsocket; it is intentionally never part of a route response.
   */
  async createVmConsoleProxy(node, guestType, vmid) {
    const safeNode = String(node || '');
    const type = String(guestType || '');
    const id = Number(vmid);
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(safeNode) || !['qemu', 'lxc'].includes(type)
      || !Number.isSafeInteger(id) || id <= 0) {
      throw Object.assign(new Error('Invalid Proxmox VM console target'), {
        code: 'INVALID_PROVIDER_RESOURCE', status: 400,
      });
    }
    const data = await this._request('POST',
      `/api2/json/nodes/${encodeURIComponent(safeNode)}/${type}/${id}/vncproxy`,
      { websocket: 1 });
    if (!data?.ticket || !Number.isInteger(Number(data?.port))) {
      throw Object.assign(new Error('Proxmox did not issue a VM console ticket'), {
        code: 'CONSOLE_TICKET_UNAVAILABLE', status: 502,
      });
    }
    return { ...data, node: safeNode, guestType: type, vmid: id };
  }

  vmConsoleWebSocket(ticket) {
    const url = new URL(this._config.endpoint);
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    url.pathname = `/api2/json/nodes/${encodeURIComponent(ticket.node)}`
      + `/${ticket.guestType}/${ticket.vmid}/vncwebsocket`;
    url.search = '';
    url.searchParams.set('port', String(ticket.port));
    url.searchParams.set('vncticket', String(ticket.ticket));
    return {
      url: url.href,
      password: String(ticket.ticket),
      headers: { Authorization: `PVEAPIToken=${this._config.tokenId}=${this._config.tokenSecret}` },
      agent: this._agent,
    };
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

  /** Allocate the next cluster-wide VM identifier immediately before submit. */
  async nextVmId() {
    const value = await this._request('GET', '/api2/json/cluster/nextid');
    if (!/^\d{1,20}$/.test(String(value || ''))) {
      throw Object.assign(new Error('Proxmox returned an invalid next VM ID'), { code: 'INVALID_PROVIDER_RESOURCE' });
    }
    return String(value);
  }

  /** Clone a QEMU template. Returns the native UPID; completion is reconciled separately. */
  async cloneTemplate(node, vmid, options = {}) {
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(String(node || '')) || !/^\d{1,20}$/.test(String(vmid || ''))
      || !/^\d{1,20}$/.test(String(options.newid || ''))
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(String(options.name || ''))
      || !['full', 'linked'].includes(options.mode)) {
      throw Object.assign(new Error('Invalid Proxmox template clone request'), { code: 'INVALID_PROVIDER_RESOURCE', status: 400 });
    }
    const safePlacement = value => value === undefined || value === null || value === ''
      ? null : (/^[A-Za-z0-9._-]{1,160}$/.test(String(value)) ? String(value) : false);
    const target = safePlacement(options.targetNode);
    const storage = safePlacement(options.storage);
    const pool = safePlacement(options.pool);
    if (target === false || storage === false || pool === false) {
      throw Object.assign(new Error('Invalid Proxmox clone placement'), { code: 'INVALID_PROVIDER_RESOURCE', status: 400 });
    }
    const body = {
      newid: Number(options.newid), name: options.name, full: options.mode === 'full' ? 1 : 0,
      ...(target ? { target } : {}), ...(storage ? { storage } : {}), ...(pool ? { pool } : {}),
    };
    const taskRef = await this._request('POST', `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(vmid)}/clone`, body);
    if (typeof taskRef !== 'string' || !taskRef.startsWith('UPID:')) {
      throw Object.assign(new Error('Proxmox clone operation returned no task'), { code: 'INVALID_PROVIDER_TASK_RESPONSE' });
    }
    return { taskRef, node, targetVmid: String(options.newid), provider: 'proxmox' };
  }

  async getVMConfig(node, vmid) {
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(String(node || '')) || !/^\d{1,20}$/.test(String(vmid || ''))) {
      throw Object.assign(new Error('Invalid Proxmox VM config target'), { code: 'INVALID_PROVIDER_RESOURCE', status: 400 });
    }
    return this._request('GET', `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(vmid)}/config`);
  }

  _cloudInitConfig(customization) {
    if (!customization || customization.osFamily !== 'linux' || !customization.network) {
      throw Object.assign(new Error('Invalid Proxmox Cloud-Init customization'), { code: 'INVALID_GUEST_CUSTOMIZATION', status: 400 });
    }
    const network = customization.network;
    const searchDomains = [...new Set([customization.domain, ...(network.searchDomains || [])].filter(Boolean))];
    return {
      ...(customization.user ? { ciuser: customization.user } : {}),
      ...(customization.sshAuthorizedKeys?.length ? { sshkeys: customization.sshAuthorizedKeys.join('\n') } : {}),
      ipconfig0: network.mode === 'static' ? `ip=${network.address},gw=${network.gateway}` : 'ip=dhcp',
      ...(network.dnsServers?.length ? { nameserver: network.dnsServers.join(' ') } : {}),
      ...(searchDomains.length ? { searchdomain: searchDomains.join(' ') } : {}),
    };
  }

  async configureCloudInit(node, vmid, customization) {
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(String(node || '')) || !/^\d{1,20}$/.test(String(vmid || ''))) {
      throw Object.assign(new Error('Invalid Proxmox VM config target'), { code: 'INVALID_PROVIDER_RESOURCE', status: 400 });
    }
    const body = this._cloudInitConfig(customization);
    await this._request('PUT', `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(vmid)}/config`, body);
    return { configured: true, provider: 'proxmox' };
  }

  async cloudInitStatus(node, vmid, customization) {
    const expected = this._cloudInitConfig(customization);
    const actual = await this.getVMConfig(node, vmid);
    const normalizedKeys = value => String(value || '').replace(/%0A/gi, '\n').split(/\r?\n/).map(item => item.trim()).filter(Boolean).sort();
    const matches = Object.entries(expected).every(([key, value]) => key === 'sshkeys'
      ? JSON.stringify(normalizedKeys(actual?.[key])) === JSON.stringify(normalizedKeys(value))
      : String(actual?.[key] || '') === String(value));
    return { configured: matches, provider: 'proxmox' };
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

  /** Submit a same-cluster QEMU/LXC migration. Returns the native UPID. */
  async migrateVm(node, vmid, guestType, options = {}) {
    const type = guestType === 'lxc' ? 'lxc' : guestType === 'qemu' ? 'qemu' : null;
    const target = String(options.target || '');
    const mode = String(options.mode || '');
    if (!type || !/^[A-Za-z0-9._-]{1,160}$/.test(String(node || ''))
      || !/^\d{1,20}$/.test(String(vmid || ''))
      || !/^[A-Za-z0-9._-]{1,160}$/.test(target)
      || !['live', 'cold', 'storage'].includes(mode)
      || target === String(node)) {
      throw Object.assign(new Error('Invalid Proxmox migration target'), { code: 'INVALID_MIGRATION_CONTEXT', status: 400 });
    }
    if (type === 'lxc' && mode === 'live') {
      throw Object.assign(new Error('Proxmox LXC live migration is unavailable'), { code: 'PROVIDER_ACTION_UNAVAILABLE', status: 400 });
    }
    const body = { target };
    if (type === 'qemu') {
      body.online = mode === 'live' ? 1 : 0;
      if (mode === 'storage') {
        body['with-local-disks'] = 1;
        body.targetstorage = options.targetStorage || '1';
      }
    } else {
      body.restart = 0;
      if (mode === 'storage') body['target-storage'] = options.targetStorage || '1';
    }
    const upid = await this._request('POST', `${this._guestPath(node, vmid, type)}/migrate`, body);
    if (typeof upid !== 'string' || !upid.startsWith('UPID:')) {
      throw Object.assign(new Error('Proxmox migration returned no task'), { code: 'INVALID_PROVIDER_TASK_RESPONSE' });
    }
    return { taskRef: upid, node, provider: 'proxmox' };
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
  _internals: { DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES, _parseSizeBytes, _configParts, _parseProxmoxHardware },
};

// Silence unused-log warning; log is retained for the write-path
// audit hooks that land in alpha.2.
if (false) log.info();
