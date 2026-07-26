'use strict';

// Unified Xen management layer.
//
// Supported management planes:
//   xo   — Xen Orchestra REST API (/rest/v0), preferred for multi-pool fleets.
//   xapi — Native XenAPI used by XCP-ng, XenServer and Citrix Hypervisor.
//          JSON-RPC 2.0 is preferred, with an XML-RPC fallback for older hosts.
//   raw  — Xen Project libxl/xl over SSH for standalone dom0 installations.
//
// The public methods intentionally expose one normalized resource model so the
// routes and UI do not depend on product/version-specific response shapes.

const http = require('http');
const https = require('https');
const { Client: SshClient } = require('ssh2');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const ORIGINATOR = 'Docker Dash Xen integration';
const XAPI_NULL_REF = 'OpaqueRef:NULL';

class XenError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'XenError';
    this.code = options.code || null;
    this.data = options.data || [];
    this.status = options.status || null;
    this.provider = options.provider || null;
  }
}

function _endpoint(value, defaultProtocol = 'https:') {
  if (!value || typeof value !== 'string') throw new Error('Xen endpoint is required');
  const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `${defaultProtocol}//${value}`;
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Xen endpoint must use HTTP or HTTPS');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

function _agentFor(url, cfg) {
  if (url.protocol !== 'https:') return undefined;
  if (cfg._agent) return cfg._agent;
  cfg._agent = new https.Agent({
    keepAlive: true,
    rejectUnauthorized: !cfg.skipTlsVerify,
    ...(cfg.caCert ? { ca: cfg.caCert } : {}),
  });
  return cfg._agent;
}

function _httpRequest(cfg, method, path, options = {}) {
  const base = cfg._endpoint instanceof URL ? cfg._endpoint : _endpoint(cfg.endpoint);
  const url = new URL(path, `${base.origin}${base.pathname || '/'}`);
  const body = options.body == null
    ? null
    : Buffer.from(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (body) headers['Content-Length'] = body.length;
  const transport = url.protocol === 'https:' ? https : http;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    const chunks = [];
    const finish = (value, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    };
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      method,
      path: url.pathname + url.search,
      headers,
      agent: _agentFor(url, cfg),
    }, (res) => {
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          req.destroy();
          return finish(null, new XenError(`Xen response exceeded ${MAX_RESPONSE_BYTES} bytes`, {
            status: 502, provider: cfg.provider,
          }));
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish({
        status: res.statusCode || 0,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', err => finish(null, new XenError(`Xen response failed: ${err.message}`, {
        code: err.code, status: 502, provider: cfg.provider,
      })));
      res.on('aborted', () => finish(null, new XenError('Xen response was aborted', {
        code: 'RESPONSE_ABORTED', status: 502, provider: cfg.provider,
      })));
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish(null, new XenError(`Xen request timeout after ${timeoutMs / 1000}s: ${method} ${url.pathname}`, {
        code: 'TIMEOUT', status: 504, provider: cfg.provider,
      }));
    }, timeoutMs);
    req.on('error', err => finish(null, new XenError(err.message, {
      code: err.code, status: 502, provider: cfg.provider,
    })));
    if (body) req.write(body);
    req.end();
  });
}

function _idFrom(value) {
  if (!value) return null;
  if (typeof value === 'object') return value.id || value.uuid || _idFrom(value.href);
  const str = String(value);
  const parts = str.split('/').filter(Boolean);
  return parts[parts.length - 1] || str;
}

function _openApiOperationHasFields(spec, operation, requiredFields) {
  if (!spec || typeof spec !== 'object' || !operation || typeof operation !== 'object') return false;
  const fields = new Set();
  const seen = new Set();
  const stack = [operation];
  const resolveRef = ref => {
    if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
    return ref.slice(2).split('/').reduce((value, part) => value?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
  };
  while (stack.length && seen.size < 1024) {
    const value = stack.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (value.properties && typeof value.properties === 'object') {
      Object.keys(value.properties).forEach(field => fields.add(field));
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref') {
        const resolved = resolveRef(child);
        if (resolved) stack.push(resolved);
      } else if (child && typeof child === 'object') stack.push(child);
    }
  }
  return requiredFields.every(field => fields.has(field));
}

function _num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function _numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function _refId(value) {
  if (!value || value === XAPI_NULL_REF) return null;
  return String(value);
}

function _relationIds(value) {
  const rows = Array.isArray(value) ? value : (value && typeof value === 'object' ? Object.values(value) : (value ? [value] : []));
  return [...new Set(rows.map(_idFrom).filter(Boolean))];
}

function _hasOperation(value, names) {
  if (!Array.isArray(value) && (!value || typeof value !== 'object')) return null;
  const operations = new Set(Array.isArray(value) ? value : Object.keys(value || {}));
  return names.some(name => operations.has(name));
}

async function _mapLimit(values, limit, mapper) {
  const input = Array.isArray(values) ? values : [];
  const output = new Array(input.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < input.length) {
      const index = cursor++;
      output[index] = await mapper(input[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), input.length) }, worker));
  return output;
}

const VM_ACTION_ALIASES = {
  start: 'start', clean_shutdown: 'shutdown', hard_shutdown: 'forceShutdown',
  clean_reboot: 'reboot', hard_reboot: 'forceReboot', suspend: 'suspend',
  resume: 'resume', pause: 'pause', unpause: 'unpause', snapshot: 'snapshot',
  snapshot_with_quiesce: 'snapshotQuiesced',
};

function _normalizedAllowedActions(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.map(action => VM_ACTION_ALIASES[action] || action).filter(Boolean))];
}

class XenOrchestraClient {
  constructor(config) {
    this._config = { ...config, provider: 'xo' };
    this._config._endpoint = _endpoint(config.endpoint);
    this._restFeatures = { provisioning: false, guestCustomization: false, migration: null };
    if (!config.token && !(config.username && config.password)) {
      throw new Error('Xen Orchestra requires an authentication token or username + password');
    }
  }

  get provider() { return 'xo'; }

  _authHeaders() {
    if (this._config.token) return { Cookie: `authenticationToken=${this._config.token}` };
    return { Authorization: `Basic ${Buffer.from(`${this._config.username}:${this._config.password}`).toString('base64')}` };
  }

  async _request(method, path, body) {
    const res = await _httpRequest(this._config, method, path, {
      body,
      headers: {
        ...this._authHeaders(),
        ...(body == null ? {} : { 'Content-Type': 'application/json' }),
      },
    });
    let parsed = null;
    if (res.text) {
      try { parsed = JSON.parse(res.text); }
      catch {
        throw new XenError(`Xen Orchestra returned invalid JSON (HTTP ${res.status})`, {
          status: 502, provider: 'xo',
        });
      }
    }
    if (res.status < 200 || res.status >= 300) {
      const message = parsed?.message || parsed?.error || `HTTP ${res.status}`;
      throw new XenError(`Xen Orchestra API error: ${message}`, {
        status: res.status, code: parsed?.code, data: parsed?.data, provider: 'xo',
      });
    }
    return parsed;
  }

  async _collection(name, fields) {
    const query = fields ? `?fields=${encodeURIComponent(fields.join(','))}` : '';
    const result = await this._request('GET', `/rest/v0/${name}${query}`);
    return Array.isArray(result) ? result : (Array.isArray(result?.items) ? result.items : []);
  }

  async info() {
    const [me] = await Promise.all([
      this._request('GET', '/rest/v0/users/me'),
      this._discoverRestFeatures(),
    ]);
    return {
      provider: 'xo', product: 'Xen Orchestra', apiVersion: 'v0',
      username: me?.email || me?.name || me?.id || null,
      capabilities: this.capabilities(),
    };
  }

  capabilities() {
    return {
      provider: 'xo', pools: true, hosts: true, vms: true, templates: true, storages: true,
      networks: true, tasks: true, events: false, powerActions: true,
      snapshots: true, snapshotQuiesce: false, backups: false, console: !!this._config.token,
      provisioning: this._restFeatures.provisioning,
      guestCustomization: this._restFeatures.guestCustomization,
      hardwareDetails: true, diskHotplug: true, nicHotplug: true,
      migrationPreflight: true, migrationLive: true, migrationCold: true, migrationStorage: true,
      migrationExecute: !!this._restFeatures.migration,
      vmGroups: true,
      taskCancel: false,
      taskCleanup: false,
      vmActions: ['start', 'shutdown', 'forceShutdown', 'reboot', 'forceReboot', 'suspend', 'resume', 'pause', 'unpause'],
    };
  }

  async _discoverRestFeatures() {
    try {
      const spec = await this._request('GET', '/rest/v0/docs/swagger.json');
      const paths = spec && typeof spec === 'object' ? spec.paths || {} : {};
      const route = Object.entries(paths).find(([path]) => /\/pools\/\{id\}\/actions\/create_vm$/.test(path));
      const provisioning = !!route?.[1]?.post;
      const migrationRoute = Object.entries(paths).find(([path, value]) =>
        /\/vms\/\{id\}\/actions\/(?:migrate|migrate_vm)$/.test(path) && value?.post);
      const migrationFields = migrationRoute
        ? ['targetHost', 'target_host', 'host', 'host_id'].filter(field =>
          _openApiOperationHasFields(spec, migrationRoute[1].post, [field])) : [];
      const storageFields = migrationRoute
        ? ['targetSr', 'target_sr', 'sr', 'sr_id'].filter(field =>
          _openApiOperationHasFields(spec, migrationRoute[1].post, [field])) : [];
      this._restFeatures = {
        provisioning,
        guestCustomization: provisioning
          && _openApiOperationHasFields(spec, route[1].post, ['cloud_config', 'network_config']),
        migration: migrationRoute && migrationFields.length ? {
          action: migrationRoute[0].split('/').pop(), targetField: migrationFields[0],
          storageField: storageFields[0] || null,
        } : null,
      };
    } catch {
      this._restFeatures = { provisioning: false, guestCustomization: false, migration: null };
    }
    return this._restFeatures;
  }

  async listVMs() {
    const rows = await this._collection('vms', [
      'id', 'uuid', 'name_label', 'power_state', 'CPUs', 'memory',
      'mainIpAddress', '$container', '$pool', '$snapshot_of', 'is_a_snapshot',
      'is_a_template', 'type', 'tags', 'current_operations',
      'allowed_operations', 'ha_restart_priority', 'ha_always_run',
      'affinity', '$affinity', 'groups', '$groups',
    ]);
    return rows.filter(v => !v.is_a_template && !v.is_a_snapshot && v.type !== 'VM-snapshot' && !v.$snapshot_of)
      .map(v => ({
        id: _idFrom(v), uuid: v.uuid || _idFrom(v), name: v.name_label || v.name || _idFrom(v),
        powerState: v.power_state || 'Unknown', cpus: _num(v.CPUs || v.cpus),
        memoryBytes: _num(v.memory || v.memory_dynamic_max), ipAddress: v.mainIpAddress || null,
        hostId: _idFrom(v.$container), poolId: _idFrom(v.$pool), tags: v.tags || [],
        currentOperations: v.current_operations || {}, provider: 'xo',
        haRestartPriority: typeof v.ha_restart_priority === 'string' ? v.ha_restart_priority : null,
        haAlwaysRun: typeof v.ha_always_run === 'boolean' ? v.ha_always_run : null,
        affinityRef: _idFrom(v.affinity || v.$affinity),
        groupRefs: (v.groups || v.$groups || []).map(_idFrom).filter(Boolean),
        allowedActions: _normalizedAllowedActions(v.allowed_operations),
      }));
  }

  async listVmGroups() {
    try {
      const rows = await this._collection('vm-groups', ['id', 'uuid', 'name_label', 'placement', 'VMs', 'vms', '$pool']);
      return rows.map((group, index) => ({
        id: _idFrom(group) || `group-${index}`, name: group.name_label || group.name || `VM group ${index + 1}`,
        placement: group.placement || null,
        vmRefs: (group.VMs || group.vms || []).map(_idFrom).filter(Boolean),
        poolRef: _idFrom(group.$pool), provider: 'xo',
      }));
    } catch (err) {
      if (err?.status === 404) return [];
      throw err;
    }
  }

  async migrateVm(vmId, targetRef, options = {}) {
    const feature = this._restFeatures.migration;
    if (!feature) throw new XenError('Xen Orchestra migration action was not discovered', {
      code: 'PROVIDER_ACTION_UNAVAILABLE', status: 400, provider: 'xo',
    });
    const id = String(vmId || '');
    const target = String(targetRef || '');
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id) || !/^[A-Za-z0-9._:-]{1,200}$/.test(target)) {
      throw new XenError('Invalid Xen Orchestra migration target', { code: 'INVALID_MIGRATION_CONTEXT', status: 400, provider: 'xo' });
    }
    const body = { [feature.targetField]: target };
    if (options.targetStorage) {
      if (!feature.storageField) throw new XenError('Xen Orchestra storage migration schema is unavailable', {
        code: 'PROVIDER_ACTION_UNAVAILABLE', status: 400, provider: 'xo',
      });
      body[feature.storageField] = options.targetStorage;
    }
    const response = await this._request('POST', `/rest/v0/vms/${encodeURIComponent(id)}/actions/${encodeURIComponent(feature.action)}`, body);
    const taskRef = _idFrom(response?.taskId || response?.task || response?.href || response);
    if (!taskRef) throw new XenError('Xen Orchestra migration returned no task', { code: 'INVALID_PROVIDER_TASK_RESPONSE', status: 502, provider: 'xo' });
    return { taskRef, provider: 'xo' };
  }

  async _resource(collection, id, fields) {
    const query = fields?.length ? `?fields=${encodeURIComponent(fields.join(','))}` : '';
    return this._request('GET', `/rest/v0/${collection}/${encodeURIComponent(id)}${query}`);
  }

  async getVmHardware(vmId) {
    const id = String(vmId || '');
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) {
      throw new XenError('Invalid Xen Orchestra VM hardware target', { code: 'INVALID_PROVIDER_RESOURCE', status: 400, provider: 'xo' });
    }
    const vm = await this._resource('vms', id, ['$VBDs', '$VIFs', 'VBDs', 'VIFs']);
    const vbdIds = _relationIds(vm?.$VBDs || vm?.VBDs).slice(0, 128);
    const vifIds = _relationIds(vm?.$VIFs || vm?.VIFs).slice(0, 64);
    const diskWarnings = [];
    const nicWarnings = [];
    const disks = (await _mapLimit(vbdIds, 8, async vbdId => {
      try {
        const vbd = await this._resource('vbds', vbdId, [
          'id', 'uuid', 'userdevice', 'device', 'type', 'mode', 'currently_attached', 'bootable',
          'unpluggable', 'empty', 'allowed_operations', '$VDI', 'VDI',
        ]);
        const vdiId = _idFrom(vbd?.$VDI || vbd?.VDI);
        const vdi = vdiId ? await this._resource('vdis', vdiId, [
          'id', 'uuid', 'name_label', 'virtual_size', 'physical_utilisation', 'type',
          'read_only', 'sharable', 'allowed_operations', '$SR', 'SR', 'sm_config',
        ]).catch(() => null) : null;
        const srId = _idFrom(vdi?.$SR || vdi?.SR);
        const sr = srId ? await this._resource('srs', srId, ['id', 'uuid', 'name_label', 'type', 'shared']).catch(() => null) : null;
        const allowed = vbd?.allowed_operations;
        return {
          nativeRef: vbdId, label: vdi?.name_label || vbd?.device || `Disk ${vbd?.userdevice || ''}`.trim(),
          type: String(vbd?.type || '').toLowerCase() === 'cd' ? 'cdrom' : 'disk',
          device: vbd?.device || null, bus: 'xen-vbd', unit: vbd?.userdevice,
          capacityBytes: vdi?.virtual_size, allocatedBytes: vdi?.physical_utilisation,
          provisioning: vdi?.sm_config?.allocation === 'thin' ? 'thin' : 'unknown',
          backing: { type: vdi?.type || sr?.type || null, storageId: srId, storageName: sr?.name_label || null, path: null },
          attachment: {
            connected: vbd?.currently_attached, startConnected: vbd?.empty === false,
            bootable: vbd?.bootable, readOnly: vbd?.mode === 'RO' || vdi?.read_only, shared: vdi?.sharable,
          },
          capabilities: {
            hotPlug: _hasOperation(allowed, ['plug']),
            hotUnplug: vbd?.unpluggable === false ? false : (vbd?.unpluggable === true ? _hasOperation(allowed, ['unplug']) : null),
            onlineResize: _hasOperation(vdi?.allowed_operations, ['resize_online']),
          }, status: vbd?.currently_attached === false ? 'disconnected' : 'configured',
        };
      } catch { diskWarnings.push(`VBD ${vbdId} could not be read`); return null; }
    })).filter(Boolean);
    const nics = (await _mapLimit(vifIds, 8, async vifId => {
      try {
        const vif = await this._resource('vifs', vifId, [
          'id', 'uuid', 'device', 'MAC', 'MTU', 'currently_attached', 'allowed_operations',
          'locking_mode', 'ipv4_addresses', 'ipv6_addresses', 'ipv4_allowed', 'ipv6_allowed',
          'qos_algorithm_params', '$network', 'network',
        ]);
        const networkId = _idFrom(vif?.$network || vif?.network);
        const network = networkId ? await this._resource('networks', networkId,
          ['id', 'uuid', 'name_label', 'bridge', 'MTU']).catch(() => null) : null;
        const addresses = [...(vif?.ipv4_addresses || []), ...(vif?.ipv6_addresses || [])]
          .map(address => ({ address, source: 'provider' }));
        return {
          nativeRef: vifId, label: `NIC ${vif?.device ?? ''}`.trim(), device: vif?.device,
          model: 'Xen paravirtualized', macAddress: vif?.MAC,
          network: { id: networkId, name: network?.name_label || null, bridge: network?.bridge || null },
          addresses, mtu: vif?.MTU || network?.MTU,
          attachment: { connected: vif?.currently_attached, startConnected: true },
          security: { lockingMode: vif?.locking_mode || null },
          qos: { rateLimitMbps: vif?.qos_algorithm_params?.kbps ? Number(vif.qos_algorithm_params.kbps) / 1000 : null },
          capabilities: {
            hotPlug: _hasOperation(vif?.allowed_operations, ['plug']),
            hotUnplug: _hasOperation(vif?.allowed_operations, ['unplug']),
            connectDisconnect: _hasOperation(vif?.allowed_operations, ['plug', 'unplug']),
          }, status: vif?.currently_attached === false ? 'disconnected' : 'configured',
        };
      } catch { nicWarnings.push(`VIF ${vifId} could not be read`); return null; }
    })).filter(Boolean);
    return {
      disks, nics, diskAvailable: vbdIds.length === 0 || disks.length > 0,
      nicAvailable: vifIds.length === 0 || nics.length > 0,
      diskReason: vbdIds.length && !disks.length ? 'Xen Orchestra VBD relations could not be read' : null,
      nicReason: vifIds.length && !nics.length ? 'Xen Orchestra VIF relations could not be read' : null,
      diskWarnings, nicWarnings,
    };
  }

  async getVmMigrationCompatibility(vmId, targetIds) {
    const id = String(vmId || '');
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id) || !Array.isArray(targetIds) || targetIds.length > 64) {
      throw new XenError('Invalid Xen Orchestra migration context', { code: 'INVALID_MIGRATION_CONTEXT', status: 400, provider: 'xo' });
    }
    const [vms, hosts] = await Promise.all([this.listVMs(), this.listHosts()]);
    const vm = vms.find(item => String(item.id) === id || String(item.uuid) === id);
    if (!vm) throw new XenError('Xen Orchestra VM was not found', { code: 'PROVIDER_VM_NOT_FOUND', status: 404, provider: 'xo' });
    const hostById = new Map(hosts.map(item => [String(item.id), item]));
    return {
      sourceRef: vm.hostId || null,
      warnings: ['Xen Orchestra exposes no portable side-effect-free per-target migration dry run; pool and capacity evidence is heuristic'],
      candidates: targetIds.map(targetRef => {
        const target = hostById.get(String(targetRef));
        const samePool = !!target && !!vm.poolId && target.poolId === vm.poolId;
        return {
          targetRef: String(targetRef), current: String(targetRef) === String(vm.hostId),
          checks: [{
            key: 'xo.poolBoundary', state: vm.poolId && target?.poolId ? (samePool ? 'pass' : 'fail') : 'unknown',
            reason: samePool ? 'VM and target host are in the same Xen Orchestra pool'
              : (vm.poolId && target?.poolId ? 'VM and target host are in different pools' : 'Pool relation was not reported'),
            confidence: vm.poolId && target?.poolId ? 'high' : 'low',
          }],
          blockers: samePool || !vm.poolId || !target?.poolId ? []
            : [{ type: 'CROSS_POOL_MAPPING_REQUIRED', reason: 'Cross-pool migration requires storage and network mapping', modes: ['live', 'cold', 'storage'] }],
          warnings: [{ type: 'XO_HEURISTIC_ONLY', reason: 'Execution must revalidate compatibility through the supported XO migration action', modes: ['live', 'cold', 'storage'] }],
          modes: {
            live: samePool && String(vm.powerState).toLowerCase() === 'running' ? 'conditional' : (samePool ? 'unsupported' : 'unknown'),
            cold: samePool ? 'conditional' : 'unknown', storage: samePool ? 'unknown' : 'unsupported',
          },
        };
      }),
    };
  }

  vmConsoleProxy(vmId) {
    const id = String(vmId || '');
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) {
      throw new XenError('Invalid Xen Orchestra VM console target', {
        code: 'INVALID_PROVIDER_RESOURCE', status: 400, provider: 'xo',
      });
    }
    if (!this._config.token) {
      throw new XenError('Xen Orchestra console proxy requires a scoped authentication token', {
        code: 'CONSOLE_TOKEN_AUTH_REQUIRED', status: 409, provider: 'xo',
      });
    }
    const url = new URL(`/api/consoles/${encodeURIComponent(id)}`, this._config._endpoint);
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    return {
      url: url.href,
      headers: {
        Cookie: `token=${encodeURIComponent(this._config.token)}; authenticationToken=${encodeURIComponent(this._config.token)}`,
      },
      rejectUnauthorized: !this._config.skipTlsVerify,
      ca: this._config.caCert || undefined,
    };
  }

  async listTemplates() {
    let rows;
    try {
      rows = await this._collection('vm-templates', [
        'id', 'uuid', 'name_label', 'name_description', 'CPUs', 'memory',
        '$pool', 'tags', 'is_default_template',
      ]);
    } catch (err) {
      if (err?.status !== 404) throw err;
      rows = (await this._collection('vms', [
        'id', 'uuid', 'name_label', 'name_description', 'CPUs', 'memory',
        '$pool', 'tags', 'is_a_template', 'is_default_template',
      ])).filter(row => row.is_a_template);
    }
    return rows.map(row => ({
      kind: 'vmTemplate', nativeRef: _idFrom(row), id: _idFrom(row),
      uuid: row.uuid || _idFrom(row), name: row.name_label || row.name || _idFrom(row),
      description: row.name_description || null, cpuCount: _num(row.CPUs || row.cpus),
      memoryBytes: _num(row.memory || row.memory_dynamic_max), pool: _idFrom(row.$pool),
      default: !!row.is_default_template, tags: row.tags || [], source: 'xo-vm-templates',
    }));
  }

  async listHosts() {
    const rows = await this._collection('hosts', [
      'id', 'uuid', 'name_label', 'address', 'enabled', 'power_state',
      'CPUs', 'memory', 'version', '$pool', 'current_operations',
    ]);
    return rows.map(h => ({
      id: _idFrom(h), uuid: h.uuid || _idFrom(h), name: h.name_label || h.name || _idFrom(h),
      address: h.address || null, enabled: h.enabled !== false,
      powerState: h.power_state || (h.enabled === false ? 'disabled' : 'Running'),
      cpus: _num(h.CPUs || h.cpus), memoryBytes: _num(h.memory), version: h.version || null,
      poolId: _idFrom(h.$pool), provider: 'xo',
    }));
  }

  async listPools() {
    const rows = await this._collection('pools', [
      'id', 'uuid', 'name_label', 'master', 'default_SR', 'HA_enabled', 'ha_enabled',
      'ha_host_failures_to_tolerate', 'ha_plan_exists_for', 'ha_overcommitted',
      'ha_allow_overcommit', 'ha_statefiles', 'ha_cluster_stack',
    ]);
    return rows.map(p => ({
      id: _idFrom(p), uuid: p.uuid || _idFrom(p), name: p.name_label || p.name || _idFrom(p),
      masterId: _idFrom(p.master), defaultStorageId: _idFrom(p.default_SR),
      haEnabled: typeof p.ha_enabled === 'boolean' ? p.ha_enabled : !!p.HA_enabled,
      haHostFailuresToTolerate: _numOrNull(p.ha_host_failures_to_tolerate),
      haPlanExistsFor: _numOrNull(p.ha_plan_exists_for),
      haOvercommitted: typeof p.ha_overcommitted === 'boolean' ? p.ha_overcommitted : null,
      haAllowOvercommit: typeof p.ha_allow_overcommit === 'boolean' ? p.ha_allow_overcommit : null,
      haStatefileCount: Array.isArray(p.ha_statefiles) ? p.ha_statefiles.length : null,
      haClusterStack: p.ha_cluster_stack || null, provider: 'xo',
    }));
  }

  async listStorages() {
    const rows = await this._collection('srs', [
      'id', 'uuid', 'name_label', 'type', 'physical_size', 'physical_usage',
      'content_type', 'shared', '$pool',
    ]);
    return rows.map(s => ({
      id: _idFrom(s), uuid: s.uuid || _idFrom(s), name: s.name_label || s.name || _idFrom(s),
      type: s.type || s.content_type || null, totalBytes: _num(s.physical_size),
      usedBytes: _num(s.physical_usage), shared: !!s.shared, poolId: _idFrom(s.$pool),
      provider: 'xo',
    }));
  }

  async listNetworks() {
    const rows = await this._collection('networks', ['id', 'uuid', 'name_label', 'bridge', 'MTU', '$pool']);
    return rows.map(n => ({
      id: _idFrom(n), uuid: n.uuid || _idFrom(n), name: n.name_label || n.name || _idFrom(n),
      bridge: n.bridge || null, mtu: _num(n.MTU || n.mtu), poolId: _idFrom(n.$pool), provider: 'xo',
    }));
  }

  async listTasks() {
    const rows = await this._collection('tasks', ['id', 'name_label', 'status', 'progress', 'start', 'end', 'result', 'error_info']);
    return rows.map(t => ({
      id: _idFrom(t), name: t.name_label || t.name || _idFrom(t), status: t.status,
      progress: _num(t.progress), startedAt: t.start || null, endedAt: t.end || null,
      result: t.result || null, error: t.error_info || null, provider: 'xo',
    }));
  }

  async getTask(id) {
    return this._request('GET', `/rest/v0/tasks/${encodeURIComponent(id)}`);
  }

  async cloneTemplate(templateId, name, options = {}) {
    const safeId = value => /^[A-Za-z0-9._:-]{1,160}$/.test(String(value || ''));
    if (!safeId(templateId) || !safeId(options.poolId)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(String(name || ''))
      || options.mode !== 'full') {
      throw new XenError('Invalid Xen Orchestra template provisioning request', { status: 400, provider: 'xo' });
    }
    for (const value of [options.cloudConfig, options.networkConfig]) {
      if (value !== undefined && (typeof value !== 'string' || value.length > 65536 || /\u0000/.test(value))) {
        throw new XenError('Xen Orchestra cloud-init payload is invalid', {
          status: 400, code: 'INVALID_GUEST_CUSTOMIZATION', provider: 'xo',
        });
      }
    }
    const result = await this._request('POST',
      `/rest/v0/pools/${encodeURIComponent(options.poolId)}/actions/create_vm?sync=false`, {
        name_label: name, template: String(templateId), boot: false,
        ...(options.cloudConfig ? { cloud_config: options.cloudConfig } : {}),
        ...(options.networkConfig ? { network_config: options.networkConfig } : {}),
      });
    const taskRef = String(result?.taskId || result?.task || '');
    if (!safeId(taskRef)) {
      throw new XenError('Xen Orchestra create operation returned no durable task', {
        status: 502, code: 'INVALID_PROVIDER_TASK_RESPONSE', provider: 'xo',
      });
    }
    return { taskRef, provider: 'xo', stage: 'clone' };
  }

  async listSnapshots(vmId) {
    const rows = await this._collection('vms', [
      'id', 'uuid', 'name_label', 'power_state', '$snapshot_of', 'is_a_snapshot',
      'type', 'snapshot_time', 'name_description',
    ]);
    return rows.filter(v => {
      const owner = _idFrom(v.$snapshot_of);
      return (v.is_a_snapshot || v.type === 'VM-snapshot' || owner) && owner === vmId;
    }).map(v => ({
      id: _idFrom(v), uuid: v.uuid || _idFrom(v), name: v.name_label || _idFrom(v),
      vmId, createdAt: v.snapshot_time || null, description: v.name_description || null,
      consistency: 'unknown', provider: 'xo',
    }));
  }

  async vmAction(vmId, action, options = {}) {
    const actions = {
      start: 'start', shutdown: 'clean_shutdown', forceShutdown: 'hard_shutdown',
      reboot: 'clean_reboot', forceReboot: 'hard_reboot', suspend: 'suspend',
      resume: 'resume', pause: 'pause', unpause: 'unpause',
    };
    if (!actions[action]) throw new XenError(`Unsupported Xen Orchestra VM action: ${action}`, { status: 400, provider: 'xo' });
    return this._request('POST', `/rest/v0/vms/${encodeURIComponent(vmId)}/actions/${actions[action]}`, options);
  }

  async createSnapshot(vmId, name, options = {}) {
    if (options.quiesce === true) throw new XenError('Xen Orchestra quiesced snapshots are not advertised by this API adapter', {
      status: 400, provider: 'xo', code: 'SNAPSHOT_QUIESCE_UNAVAILABLE',
    });
    return this._request('POST', `/rest/v0/vms/${encodeURIComponent(vmId)}/actions/snapshot`, { name_label: name });
  }

  async revertSnapshot(snapshotId) {
    return this._request('POST', `/rest/v0/vms/${encodeURIComponent(snapshotId)}/actions/revert`, {});
  }

  async deleteSnapshot(snapshotId) {
    return this._request('DELETE', `/rest/v0/vms/${encodeURIComponent(snapshotId)}`);
  }

  async close() {
    this._config._agent?.destroy?.();
    this._config._agent = null;
  }
}

function _xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function _xmlDecode(value) {
  return String(value).replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function _xmlValue(value) {
  if (value === null || value === undefined) return '<value><string></string></value>';
  if (typeof value === 'boolean') return `<value><boolean>${value ? 1 : 0}</boolean></value>`;
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? `<value><int>${value}</int></value>`
      : `<value><double>${value}</double></value>`;
  }
  if (Array.isArray(value)) return `<value><array><data>${value.map(_xmlValue).join('')}</data></array></value>`;
  if (typeof value === 'object') {
    return `<value><struct>${Object.entries(value).map(([k, v]) =>
      `<member><name>${_xmlEscape(k)}</name>${_xmlValue(v)}</member>`).join('')}</struct></value>`;
  }
  return `<value><string>${_xmlEscape(value)}</string></value>`;
}

function _xmlTokens(xml) {
  return String(xml).replace(/<\?xml[^>]*\?>/gi, '').match(/<[^>]+>|[^<]+/g) || [];
}

function _parseXmlRpcValue(tokens, state) {
  const skip = () => {
    while (state.i < tokens.length && !tokens[state.i].startsWith('<') && !tokens[state.i].trim()) state.i++;
  };
  skip();
  if (!/^<value(?:\s[^>]*)?>$/i.test(tokens[state.i] || '')) throw new Error('Invalid XML-RPC value');
  state.i++; skip();
  const token = tokens[state.i] || '';
  if (/^<\/value>$/i.test(token)) { state.i++; return ''; }
  if (!token.startsWith('<')) {
    state.i++;
    skip();
    if (/^<\/value>$/i.test(tokens[state.i] || '')) state.i++;
    return _xmlDecode(token.trim());
  }
  const open = token.match(/^<([\w.:-]+)(?:\s[^>]*)?>$/);
  if (!open) throw new Error('Invalid XML-RPC type');
  const type = open[1].toLowerCase();
  state.i++;
  if (type === 'array') {
    skip(); if (/^<data(?:\s[^>]*)?>$/i.test(tokens[state.i] || '')) state.i++;
    const values = [];
    while (state.i < tokens.length) {
      skip();
      if (/^<\/data>$/i.test(tokens[state.i] || '')) { state.i++; break; }
      values.push(_parseXmlRpcValue(tokens, state));
    }
    skip(); if (/^<\/array>$/i.test(tokens[state.i] || '')) state.i++;
    skip(); if (/^<\/value>$/i.test(tokens[state.i] || '')) state.i++;
    return values;
  }
  if (type === 'struct') {
    const out = {};
    while (state.i < tokens.length) {
      skip();
      if (/^<\/struct>$/i.test(tokens[state.i] || '')) { state.i++; break; }
      if (/^<member(?:\s[^>]*)?>$/i.test(tokens[state.i] || '')) state.i++;
      skip(); if (/^<name(?:\s[^>]*)?>$/i.test(tokens[state.i] || '')) state.i++;
      let name = '';
      if (!(tokens[state.i] || '').startsWith('<')) name = _xmlDecode(tokens[state.i++].trim());
      skip(); if (/^<\/name>$/i.test(tokens[state.i] || '')) state.i++;
      out[name] = _parseXmlRpcValue(tokens, state);
      skip(); if (/^<\/member>$/i.test(tokens[state.i] || '')) state.i++;
    }
    skip(); if (/^<\/value>$/i.test(tokens[state.i] || '')) state.i++;
    return out;
  }
  let raw = '';
  while (state.i < tokens.length && !new RegExp(`^<\\/${type}>$`, 'i').test(tokens[state.i])) raw += tokens[state.i++];
  if (state.i < tokens.length) state.i++;
  skip(); if (/^<\/value>$/i.test(tokens[state.i] || '')) state.i++;
  raw = _xmlDecode(raw.trim());
  if (type === 'boolean') return raw === '1' || raw.toLowerCase() === 'true';
  if (['double', 'i4', 'int', 'i8'].includes(type)) return Number(raw);
  if (type === 'base64') return Buffer.from(raw, 'base64').toString('utf8');
  return raw;
}

function _parseXmlRpcResponse(xml) {
  const tokens = _xmlTokens(xml);
  const faultIndex = tokens.findIndex(t => /^<fault(?:\s[^>]*)?>$/i.test(t));
  const valueIndex = tokens.findIndex((t, i) => i > faultIndex && /^<value(?:\s[^>]*)?>$/i.test(t));
  if (valueIndex < 0) throw new Error('Invalid XML-RPC response: value missing');
  const state = { i: valueIndex };
  const value = _parseXmlRpcValue(tokens, state);
  if (faultIndex >= 0) {
    throw new XenError(value.faultString || 'XML-RPC fault', {
      code: value.faultCode || 'XML_RPC_FAULT', data: [value], provider: 'xapi',
    });
  }
  return value;
}

class XapiClient {
  constructor(config) {
    this._config = { ...config, provider: 'xapi' };
    this._endpoint = _endpoint(config.endpoint);
    this._config._endpoint = this._endpoint;
    if (!config.username || !config.password) throw new Error('XAPI requires username + password');
    this._protocol = ['json', 'xml'].includes(config.protocol) ? config.protocol : 'auto';
    this._activeProtocol = null;
    this._session = null;
    this._loginPromise = null;
    this._rpcId = 0;
  }

  get provider() { return 'xapi'; }

  _setEndpoint(url) {
    this._endpoint = _endpoint(url);
    this._config._endpoint = this._endpoint;
  }

  async _rpcJson(method, params) {
    const res = await _httpRequest(this._config, 'POST', '/jsonrpc', {
      body: { jsonrpc: '2.0', method, params, id: ++this._rpcId },
      headers: { 'Content-Type': 'application/json' },
    });
    let parsed;
    try { parsed = JSON.parse(res.text); }
    catch {
      throw new XenError(`XAPI JSON-RPC unavailable (HTTP ${res.status})`, {
        code: 'JSON_RPC_UNAVAILABLE', status: res.status || 502, provider: 'xapi',
      });
    }
    const error = parsed?.error;
    if (error) {
      const code = Array.isArray(error) ? error[0] : (error.message || error.code);
      const data = Array.isArray(error) ? error.slice(1) : (error.data || []);
      throw new XenError(`XAPI ${code}${data.length ? `: ${data.join(', ')}` : ''}`, {
        code, data, status: res.status >= 400 ? res.status : 502, provider: 'xapi',
      });
    }
    if (res.status < 200 || res.status >= 300) {
      throw new XenError(`XAPI HTTP ${res.status}`, { status: res.status, provider: 'xapi' });
    }
    return parsed?.result;
  }

  async _rpcXml(method, params) {
    const body = `<?xml version="1.0"?><methodCall><methodName>${_xmlEscape(method)}</methodName><params>`
      + params.map(p => `<param>${_xmlValue(p)}</param>`).join('') + '</params></methodCall>';
    const res = await _httpRequest(this._config, 'POST', '/', {
      body, headers: { 'Content-Type': 'text/xml' },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new XenError(`XAPI XML-RPC HTTP ${res.status}`, { status: res.status, provider: 'xapi' });
    }
    const envelope = _parseXmlRpcResponse(res.text);
    if (envelope && typeof envelope === 'object' && envelope.Status) {
      if (envelope.Status === 'Success') return envelope.Value;
      const details = Array.isArray(envelope.ErrorDescription) ? envelope.ErrorDescription : [];
      const code = details[0] || 'XAPI_FAILURE';
      throw new XenError(`XAPI ${code}${details.length > 1 ? `: ${details.slice(1).join(', ')}` : ''}`, {
        code, data: details.slice(1), status: 502, provider: 'xapi',
      });
    }
    return envelope;
  }

  async _rawCall(method, params) {
    if (this._activeProtocol === 'xml' || this._protocol === 'xml') return this._rpcXml(method, params);
    if (this._activeProtocol === 'json' || this._protocol === 'json') return this._rpcJson(method, params);
    try {
      const result = await this._rpcJson(method, params);
      this._activeProtocol = 'json';
      return result;
    } catch (err) {
      if (err.code !== 'JSON_RPC_UNAVAILABLE' && ![404, 405, 415].includes(err.status)) throw err;
      const result = await this._rpcXml(method, params);
      this._activeProtocol = 'xml';
      return result;
    }
  }

  async login(retry = true) {
    if (this._session) return this._session;
    if (this._loginPromise) return this._loginPromise;
    this._loginPromise = this._performLogin(retry);
    try { return await this._loginPromise; }
    finally { this._loginPromise = null; }
  }

  async _performLogin(retry) {
    try {
      this._session = await this._rawCall('session.login_with_password', [
        this._config.username, this._config.password, '1.0', ORIGINATOR,
      ]);
      return this._session;
    } catch (err) {
      // Pool supporters may reject even the initial login and identify the
      // coordinator. Follow it once while preserving scheme/port/TLS policy.
      if (retry && err.code === 'HOST_IS_SLAVE' && err.data?.[0]) {
        const next = new URL(this._endpoint.href);
        next.hostname = String(err.data[0]);
        this._setEndpoint(next.href);
        return this._performLogin(false);
      }
      throw err;
    }
  }

  async _call(method, params = [], retry = true) {
    const session = await this.login();
    try {
      return await this._rawCall(method, [session, ...params]);
    } catch (err) {
      if (!retry) throw err;
      if (err.code === 'SESSION_INVALID') {
        this._session = null;
        return this._call(method, params, false);
      }
      if (err.code === 'HOST_IS_SLAVE' && err.data && err.data[0]) {
        const master = String(err.data[0]);
        const next = new URL(this._endpoint.href);
        next.hostname = master;
        this._setEndpoint(next.href);
        this._session = null;
        return this._call(method, params, false);
      }
      throw err;
    }
  }

  capabilities() {
    return {
      provider: 'xapi', pools: true, hosts: true, vms: true, templates: true, storages: true,
      networks: true, tasks: true, events: false, powerActions: true,
      snapshots: true, snapshotQuiesce: true, backups: false, console: true, provisioning: true,
      protocol: this._activeProtocol || this._protocol,
      hardwareDetails: true, diskHotplug: true, nicHotplug: true,
      migrationPreflight: true, migrationLive: true, migrationCold: true, migrationStorage: true,
      migrationExecute: true,
      hostMaintenance: true,
      vmGroups: true,
      taskCancel: true,
      taskCleanup: true,
      vmActions: ['start', 'shutdown', 'forceShutdown', 'reboot', 'forceReboot', 'suspend', 'resume', 'pause', 'unpause'],
    };
  }

  async info() {
    const [hosts, pools] = await Promise.all([
      this._call('host.get_all_records'), this._call('pool.get_all_records').catch(() => ({})),
    ]);
    const first = Object.values(hosts || {})[0] || {};
    const sw = first.software_version || {};
    return {
      provider: 'xapi', product: sw.product_brand || sw.product_name || 'XenAPI',
      version: sw.product_version || sw.product_version_text || sw.xapi || null,
      apiVersion: sw.xapi || null, hostname: first.name_label || first.hostname || null,
      pools: Object.keys(pools || {}).length, protocol: this._activeProtocol,
      capabilities: this.capabilities(),
    };
  }

  async listVMs() {
    const records = await this._call('VM.get_all_records');
    return Object.entries(records || {}).filter(([, v]) =>
      !v.is_control_domain && !v.is_a_template && !v.is_a_snapshot
      && (!_refId(v.snapshot_of) || v.snapshot_of === XAPI_NULL_REF)
    ).map(([ref, v]) => ({
      id: v.uuid, uuid: v.uuid, ref, name: v.name_label || v.uuid,
      description: v.name_description || '', powerState: v.power_state || 'Unknown',
      cpus: _num(v.VCPUs_at_startup || v.VCPUs_max),
      memoryBytes: _num(v.memory_dynamic_max || v.memory_static_max),
      hostRef: _refId(v.resident_on), tags: v.tags || [],
      affinityRef: _refId(v.affinity), groupRefs: (v.groups || []).map(_refId).filter(Boolean),
      currentOperations: v.current_operations || {}, provider: 'xapi',
      haRestartPriority: typeof v.ha_restart_priority === 'string' ? v.ha_restart_priority : null,
      haAlwaysRun: typeof v.ha_always_run === 'boolean' ? v.ha_always_run : null,
      allowedActions: _normalizedAllowedActions(v.allowed_operations),
    }));
  }

  async listVmGroups() {
    const records = await this._call('VM_group.get_all_records');
    return Object.entries(records || {}).map(([ref, group], index) => ({
      id: group.uuid || ref, uuid: group.uuid || null, ref,
      name: group.name_label || group.uuid || `VM group ${index + 1}`,
      placement: group.placement || null,
      vmRefs: (group.VMs || []).map(_refId).filter(Boolean),
      provider: 'xapi',
    }));
  }

  async getVm(vmId) {
    const ref = String(vmId || '').startsWith('OpaqueRef:') ? String(vmId) : await this._vmRef(vmId);
    return { ref, ...(await this._call('VM.get_record', [ref])) };
  }

  async setVmHaPolicy(vmRef, values = {}) {
    if (values.haRestartPriority !== undefined) {
      await this._call('VM.set_ha_restart_priority', [String(vmRef), String(values.haRestartPriority)]);
    }
    if (values.order !== undefined) await this._call('VM.set_order', [String(vmRef), Number(values.order)]);
    if (values.startDelay !== undefined) await this._call('VM.set_start_delay', [String(vmRef), Number(values.startDelay)]);
    return { completed: true, provider: 'xapi' };
  }

  async setVmAffinity(vmRef, hostRef) {
    await this._call('VM.set_affinity', [String(vmRef), hostRef ? String(hostRef) : XAPI_NULL_REF]);
    return { completed: true, provider: 'xapi' };
  }

  async createVmGroup(values = {}) {
    const ref = await this._call('VM_group.create', [{
      name_label: String(values.name || ''), name_description: String(values.description || ''),
      placement: String(values.placement || 'anti_affinity'),
    }]);
    return { ref, provider: 'xapi' };
  }

  async setVmGroups(vmRef, groupRefs = []) {
    await this._call('VM.set_groups', [String(vmRef), groupRefs.map(String)]);
    return { completed: true, provider: 'xapi' };
  }

  async destroyVmGroup(groupRef) {
    await this._call('VM_group.destroy', [String(groupRef)]);
    return { completed: true, provider: 'xapi' };
  }

  async getVmHardware(vmId) {
    const vmRef = String(vmId || '').startsWith('OpaqueRef:') ? String(vmId) : await this._vmRef(vmId);
    const vm = await this._call('VM.get_record', [vmRef]);
    let guestNetworks = {};
    if (_refId(vm.guest_metrics)) {
      try { guestNetworks = (await this._call('VM_guest_metrics.get_record', [vm.guest_metrics]))?.networks || {}; }
      catch { /* guest metrics are optional */ }
    }
    const disks = (await _mapLimit((vm.VBDs || []).slice(0, 128), 8, async vbdRef => {
      const vbd = await this._call('VBD.get_record', [vbdRef]);
      let vdi = null; let sr = null;
      if (_refId(vbd.VDI)) {
        vdi = await this._call('VDI.get_record', [vbd.VDI]).catch(() => null);
        if (_refId(vdi?.SR)) sr = await this._call('SR.get_record', [vdi.SR]).catch(() => null);
      }
      const allowed = vbd.allowed_operations;
      const vdiAllowed = vdi?.allowed_operations;
      return {
        nativeRef: vbdRef, label: vdi?.name_label || vbd.device || `Disk ${vbd.userdevice || ''}`.trim(),
        type: String(vbd.type || '').toLowerCase() === 'cd' ? 'cdrom' : 'disk',
        device: vbd.device || null, bus: 'xen-vbd', unit: vbd.userdevice,
        capacityBytes: vdi?.virtual_size, allocatedBytes: vdi?.physical_utilisation,
        provisioning: vdi?.sm_config?.allocation === 'thin' || vdi?.sm_config?.['vhd-parent'] ? 'thin' : 'unknown',
        backing: { type: vdi?.type || sr?.type || null, storageId: sr?.uuid || null, storageName: sr?.name_label || null },
        attachment: {
          connected: vbd.currently_attached, startConnected: vbd.empty === false,
          bootable: vbd.bootable, readOnly: vbd.mode === 'RO' || vdi?.read_only, shared: vdi?.sharable,
        },
        capabilities: {
          hotPlug: _hasOperation(allowed, ['plug']),
          hotUnplug: vbd.unpluggable === false ? false : (vbd.unpluggable === true ? _hasOperation(allowed, ['unplug']) : null),
          onlineResize: _hasOperation(vdiAllowed, ['resize_online']),
        }, status: vbd.currently_attached === false ? 'disconnected' : 'configured',
      };
    })).filter(Boolean);
    const nics = (await _mapLimit((vm.VIFs || []).slice(0, 64), 8, async vifRef => {
      const vif = await this._call('VIF.get_record', [vifRef]);
      const network = _refId(vif.network) ? await this._call('network.get_record', [vif.network]).catch(() => null) : null;
      const prefix = `${vif.device}/`;
      const addresses = Object.entries(guestNetworks).filter(([key]) => key.startsWith(prefix) && /ip/i.test(key))
        .flatMap(([, value]) => Array.isArray(value) ? value : [value])
        .map(address => ({ address, source: 'xapi-guest-metrics' }));
      return {
        nativeRef: vifRef, label: `NIC ${vif.device ?? ''}`.trim(), device: vif.device,
        model: 'Xen paravirtualized', macAddress: vif.MAC,
        network: { id: network?.uuid || null, name: network?.name_label || null, bridge: network?.bridge || null },
        addresses, mtu: vif.MTU || network?.MTU,
        attachment: { connected: vif.currently_attached, startConnected: true },
        security: { lockingMode: vif.locking_mode || null },
        qos: { rateLimitMbps: vif.qos_algorithm_params?.kbps ? Number(vif.qos_algorithm_params.kbps) / 1000 : null },
        capabilities: {
          hotPlug: _hasOperation(vif.allowed_operations, ['plug']),
          hotUnplug: _hasOperation(vif.allowed_operations, ['unplug']),
          connectDisconnect: _hasOperation(vif.allowed_operations, ['plug', 'unplug']),
        }, status: vif.currently_attached === false ? 'disconnected' : 'configured',
      };
    })).filter(Boolean);
    return { disks, nics, diskAvailable: true, nicAvailable: true };
  }

  async getVmMigrationCompatibility(vmId, targetRefs) {
    if (!Array.isArray(targetRefs) || targetRefs.length > 64
      || targetRefs.some(ref => !/^OpaqueRef:[A-Za-z0-9._:-]{1,512}$/.test(String(ref || '')))) {
      throw new XenError('Invalid XAPI migration context', { code: 'INVALID_MIGRATION_CONTEXT', status: 400, provider: 'xapi' });
    }
    const vmRef = String(vmId || '').startsWith('OpaqueRef:') ? String(vmId) : await this._vmRef(vmId);
    const vm = await this._call('VM.get_record', [vmRef]);
    let possible = null;
    try { possible = new Set(await this._call('VM.get_possible_hosts', [vmRef])); }
    catch { /* older XAPI may not expose this helper */ }
    const candidates = await _mapLimit(targetRefs, 8, async targetRef => {
      let bootCheck = 'unknown';
      try { await this._call('VM.assert_can_boot_here', [vmRef, targetRef]); bootCheck = 'pass'; }
      catch (err) {
        const unavailable = /METHOD_UNKNOWN|MESSAGE_METHOD_UNKNOWN|NOT_IMPLEMENTED/i.test(String(err?.code || ''));
        bootCheck = unavailable ? 'unknown' : 'fail';
      }
      const possibleState = possible ? (possible.has(targetRef) ? 'pass' : 'fail') : 'unknown';
      const compatible = bootCheck === 'pass' && possibleState !== 'fail';
      const compatibilityUnknown = bootCheck === 'unknown' || possibleState === 'unknown';
      const allowed = new Set(vm.allowed_operations || []);
      const current = targetRef === _refId(vm.resident_on);
      return {
        targetRef, current,
        checks: [
          { key: 'xapi.possibleHost', state: possibleState, reason: possibleState === 'pass'
            ? 'XAPI includes the target in VM.get_possible_hosts'
            : (possibleState === 'fail' ? 'XAPI excludes the target from VM.get_possible_hosts' : 'Possible-host evidence is unavailable'), confidence: possible ? 'high' : 'low' },
          { key: 'xapi.assertCanBootHere', state: bootCheck, reason: bootCheck === 'pass'
            ? 'XAPI assert_can_boot_here passed for this target' : (bootCheck === 'fail' ? 'XAPI assert_can_boot_here rejected this target' : 'Boot compatibility is unknown'), confidence: 'high' },
        ],
        blockers: compatible || current || bootCheck === 'unknown' ? []
          : [{ type: 'XAPI_HOST_INCOMPATIBLE', reason: 'XAPI rejected this VM/host compatibility', modes: ['live', 'cold', 'storage'] }],
        warnings: [{ type: 'FABRIC_REVALIDATION_REQUIRED', reason: 'SR and network mappings must be revalidated immediately before migration', modes: ['live', 'cold', 'storage'] }],
        modes: {
          live: current ? 'unsupported' : (compatible && (allowed.has('pool_migrate') || allowed.has('migrate_send'))
            ? 'conditional' : (compatible || compatibilityUnknown ? 'unknown' : 'unsupported')),
          cold: current ? 'unsupported' : (compatible ? 'conditional' : (compatibilityUnknown ? 'unknown' : 'unsupported')),
          storage: current ? 'unsupported' : (compatible || compatibilityUnknown ? 'unknown' : 'unsupported'),
        },
      };
    });
    return { sourceRef: _refId(vm.resident_on), candidates, warnings: [] };
  }

  async getVmConsole(vmRef) {
    if (!/^OpaqueRef:[A-Za-z0-9._:-]+$/.test(String(vmRef || ''))) {
      throw new XenError('Invalid XAPI VM console target', {
        code: 'INVALID_PROVIDER_RESOURCE', status: 400, provider: 'xapi',
      });
    }
    const refs = await this._call('VM.get_consoles', [vmRef]);
    const records = [];
    for (const ref of Array.isArray(refs) ? refs.slice(0, 16) : []) {
      try { records.push({ ref, ...(await this._call('console.get_record', [ref])) }); }
      catch { /* a console may disappear during VM state transitions */ }
    }
    const record = records.find(item => String(item.protocol).toLowerCase() === 'rfb')
      || records.find(item => String(item.protocol).toLowerCase() === 'vt100');
    if (!record?.location) {
      throw new XenError('XAPI reported no supported RFB or VT100 console', {
        code: 'CONSOLE_UNAVAILABLE', status: 409, provider: 'xapi',
      });
    }
    const location = new URL(record.location, this._endpoint);
    if (location.protocol !== 'https:') {
      throw new XenError('XAPI console location must use HTTPS', {
        code: 'INVALID_CONSOLE_LOCATION', status: 502, provider: 'xapi',
      });
    }
    return {
      protocol: String(record.protocol).toLowerCase() === 'vt100' ? 'serial' : 'rfb',
      location: location.href, sessionId: await this.login(),
      rejectUnauthorized: !this._config.skipTlsVerify,
      ca: this._config.caCert || undefined,
    };
  }

  async listTemplates() {
    const records = await this._call('VM.get_all_records');
    return Object.entries(records || {}).filter(([, v]) =>
      !v.is_control_domain && v.is_a_template && !v.is_a_snapshot
    ).map(([ref, v]) => ({
      kind: 'vmTemplate', nativeRef: ref, ref, id: v.uuid || ref, uuid: v.uuid || null,
      name: v.name_label || v.uuid || ref, description: v.name_description || null,
      cpuCount: _num(v.VCPUs_at_startup || v.VCPUs_max),
      memoryBytes: _num(v.memory_dynamic_max || v.memory_static_max),
      default: !!v.is_default_template, tags: v.tags || [], source: 'xapi-vm-records',
    }));
  }

  async listHosts() {
    const [records, metrics] = await Promise.all([
      this._call('host.get_all_records'),
      this._call('host_metrics.get_all_records').catch(() => ({})),
    ]);
    return Object.entries(records || {}).map(([ref, h]) => {
      const m = metrics?.[h.metrics] || {};
      const sw = h.software_version || {};
      return {
        id: h.uuid, uuid: h.uuid, ref, name: h.name_label || h.hostname || h.uuid,
        address: h.address || null, enabled: h.enabled !== false,
        powerState: h.enabled === false ? 'disabled' : (m.live === false ? 'offline' : 'Running'),
        cpus: _num((h.host_CPUs || []).length), memoryBytes: _num(m.memory_total),
        memoryFreeBytes: _num(m.memory_free), version: sw.product_version || sw.xapi || null,
        product: sw.product_brand || sw.product_name || null, provider: 'xapi',
      };
    });
  }

  async listPools() {
    const records = await this._call('pool.get_all_records');
    return Object.entries(records || {}).map(([ref, p]) => ({
      id: p.uuid, uuid: p.uuid, ref, name: p.name_label || p.uuid,
      masterRef: _refId(p.master), defaultStorageRef: _refId(p.default_SR),
      haEnabled: !!p.ha_enabled,
      haHostFailuresToTolerate: _numOrNull(p.ha_host_failures_to_tolerate),
      haPlanExistsFor: _numOrNull(p.ha_plan_exists_for),
      haOvercommitted: typeof p.ha_overcommitted === 'boolean' ? p.ha_overcommitted : null,
      haAllowOvercommit: typeof p.ha_allow_overcommit === 'boolean' ? p.ha_allow_overcommit : null,
      haStatefileCount: Array.isArray(p.ha_statefiles) ? p.ha_statefiles.length : null,
      haClusterStack: p.ha_cluster_stack || null,
      haConfiguration: p.ha_configuration || {}, provider: 'xapi',
    }));
  }

  async listStorages() {
    const records = await this._call('SR.get_all_records');
    return Object.entries(records || {}).map(([ref, s]) => ({
      id: s.uuid, uuid: s.uuid, ref, name: s.name_label || s.uuid, type: s.type || s.content_type,
      totalBytes: _num(s.physical_size), usedBytes: _num(s.physical_utilisation),
      virtualAllocationBytes: _num(s.virtual_allocation), shared: !!s.shared,
      attached: (s.PBDs || []).length > 0, provider: 'xapi',
    }));
  }

  async listNetworks() {
    const records = await this._call('network.get_all_records');
    return Object.entries(records || {}).map(([ref, n]) => ({
      id: n.uuid, uuid: n.uuid, ref, name: n.name_label || n.uuid,
      bridge: n.bridge || null, mtu: _num(n.MTU), managed: n.managed !== false,
      provider: 'xapi',
    }));
  }

  async listTasks() {
    const records = await this._call('task.get_all_records');
    return Object.entries(records || {}).map(([ref, t]) => ({
      id: t.uuid || ref, uuid: t.uuid || null, ref, name: t.name_label || ref,
      status: t.status, progress: _num(t.progress), startedAt: t.created || null,
      endedAt: t.finished || null, result: t.result || null,
      error: t.error_info || null, provider: 'xapi',
    }));
  }

  async getTask(id) {
    const ref = String(id).startsWith('OpaqueRef:') ? id : await this._call('task.get_by_uuid', [id]);
    const t = await this._call('task.get_record', [ref]);
    return { id: t.uuid || id, ref, name: t.name_label || id, status: t.status,
      progress: _num(t.progress), result: t.result || null, error: t.error_info || null, provider: 'xapi' };
  }

  async deleteTask(id) {
    const ref = String(id).startsWith('OpaqueRef:') ? id : await this._call('task.get_by_uuid', [id]);
    await this._call('task.destroy', [ref]);
    return { ok: true, id, provider: 'xapi' };
  }

  async cancelTask(id) {
    const ref = String(id).startsWith('OpaqueRef:') ? id : await this._call('task.get_by_uuid', [id]);
    await this._call('task.cancel', [ref]);
    return { ok: true, provider: 'xapi' };
  }

  async migrateVm(vmId, targetRef, options = {}) {
    const vmRef = String(vmId).startsWith('OpaqueRef:') ? String(vmId) : await this._vmRef(vmId);
    if (!/^OpaqueRef:[A-Za-z0-9._:-]{1,512}$/.test(vmRef)
      || !/^OpaqueRef:[A-Za-z0-9._:-]{1,512}$/.test(String(targetRef || ''))) {
      throw new XenError('Invalid XAPI migration target', { code: 'INVALID_MIGRATION_CONTEXT', status: 400, provider: 'xapi' });
    }
    const taskRef = await this._call('Async.VM.pool_migrate', [vmRef, String(targetRef), {
      live: options.live === true ? 'true' : 'false',
    }]);
    return { taskRef, provider: 'xapi' };
  }

  async disableHost(hostRef) {
    if (!/^OpaqueRef:[A-Za-z0-9._:-]{1,512}$/.test(String(hostRef || ''))) {
      throw new XenError('Invalid XAPI host reference', { code: 'INVALID_PROVIDER_RESOURCE', status: 400, provider: 'xapi' });
    }
    return { taskRef: await this._call('Async.host.disable', [String(hostRef)]), provider: 'xapi', action: 'disable' };
  }

  async enableHost(hostRef) {
    if (!/^OpaqueRef:[A-Za-z0-9._:-]{1,512}$/.test(String(hostRef || ''))) {
      throw new XenError('Invalid XAPI host reference', { code: 'INVALID_PROVIDER_RESOURCE', status: 400, provider: 'xapi' });
    }
    return { taskRef: await this._call('Async.host.enable', [String(hostRef)]), provider: 'xapi', action: 'enable' };
  }

  async getHost(hostRef) {
    if (!/^OpaqueRef:[A-Za-z0-9._:-]{1,512}$/.test(String(hostRef || ''))) {
      throw new XenError('Invalid XAPI host reference', { code: 'INVALID_PROVIDER_RESOURCE', status: 400, provider: 'xapi' });
    }
    const value = await this._call('host.get_record', [String(hostRef)]);
    return {
      ref: String(hostRef), uuid: value.uuid || null, name: value.name_label || value.hostname || value.uuid,
      enabled: value.enabled !== false, residentVmRefs: (value.resident_VMs || []).filter(_refId),
    };
  }

  async listSnapshots(vmId) {
    const records = await this._call('VM.get_all_records');
    const vmRef = await this._call('VM.get_by_uuid', [vmId]);
    return Object.entries(records || {}).filter(([, v]) => v.is_a_snapshot && v.snapshot_of === vmRef)
      .map(([ref, v]) => ({
        id: v.uuid, uuid: v.uuid, ref, name: v.name_label || v.uuid,
        vmId, createdAt: v.snapshot_time || null, powerState: v.power_state,
        description: v.name_description || null,
        consistency: v.snapshot_info?.['snapshot-type'] === 'quiesced' ? 'quiesced' : 'unknown',
        provider: 'xapi',
      }));
  }

  async _vmRef(vmId) { return this._call('VM.get_by_uuid', [vmId]); }

  async cloneTemplate(templateRef, name, options = {}) {
    if (!/^OpaqueRef:[A-Za-z0-9._:-]{1,512}$/.test(String(templateRef || ''))
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(String(name || ''))
      || !['full', 'linked'].includes(options.mode)) {
      throw new XenError('Invalid XAPI template clone request', { status: 400, provider: 'xapi' });
    }
    let method; let params;
    if (options.mode === 'full') {
      if (!/^OpaqueRef:[A-Za-z0-9._:-]{1,512}$/.test(String(options.storageRef || ''))) {
        throw new XenError('A valid XAPI storage repository is required for a full clone', {
          status: 400, code: 'PROVIDER_PLACEMENT_UNAVAILABLE', provider: 'xapi',
        });
      }
      method = 'Async.VM.copy'; params = [templateRef, name, options.storageRef];
    } else { method = 'Async.VM.clone'; params = [templateRef, name]; }
    return { taskRef: await this._call(method, params), provider: 'xapi', stage: 'clone' };
  }

  async provisionClonedVm(vmRef) {
    if (!/^OpaqueRef:[A-Za-z0-9._:-]{1,512}$/.test(String(vmRef || ''))) {
      throw new XenError('Invalid XAPI cloned VM reference', { status: 400, provider: 'xapi' });
    }
    return { taskRef: await this._call('Async.VM.provision', [vmRef]), provider: 'xapi', stage: 'provision' };
  }

  async getVmRecordByRef(vmRef) {
    if (!/^OpaqueRef:[A-Za-z0-9._:-]{1,512}$/.test(String(vmRef || ''))) {
      throw new XenError('Invalid XAPI VM reference', { status: 400, provider: 'xapi' });
    }
    return this._call('VM.get_record', [vmRef]);
  }

  async defaultStorageRef() {
    const pools = await this._call('pool.get_all_records');
    const refs = Object.values(pools || {}).map(pool => _refId(pool.default_SR)).filter(ref => ref && ref !== XAPI_NULL_REF);
    if (refs.length !== 1) {
      throw new XenError('XAPI pool default storage is unavailable or ambiguous', {
        status: 409, code: 'PROVIDER_PLACEMENT_UNAVAILABLE', provider: 'xapi',
      });
    }
    return refs[0];
  }

  async vmAction(vmId, action) {
    const ref = await this._vmRef(vmId);
    const calls = {
      start: ['Async.VM.start', [ref, false, false]],
      shutdown: ['Async.VM.clean_shutdown', [ref]],
      forceShutdown: ['Async.VM.hard_shutdown', [ref]],
      reboot: ['Async.VM.clean_reboot', [ref]],
      forceReboot: ['Async.VM.hard_reboot', [ref]],
      suspend: ['Async.VM.suspend', [ref]],
      resume: ['Async.VM.resume', [ref, false, false]],
      pause: ['Async.VM.pause', [ref]],
      unpause: ['Async.VM.unpause', [ref]],
    };
    if (!calls[action]) throw new XenError(`Unsupported XAPI VM action: ${action}`, { status: 400, provider: 'xapi' });
    const taskRef = await this._call(calls[action][0], calls[action][1]);
    return { taskRef, provider: 'xapi' };
  }

  async createSnapshot(vmId, name, options = {}) {
    const ref = await this._vmRef(vmId);
    const method = options.quiesce === true ? 'Async.VM.snapshot_with_quiesce' : 'Async.VM.snapshot';
    return { taskRef: await this._call(method, [ref, name]), provider: 'xapi' };
  }

  async revertSnapshot(snapshotId) {
    const ref = await this._vmRef(snapshotId);
    return { taskRef: await this._call('Async.VM.revert', [ref]), provider: 'xapi' };
  }

  async deleteSnapshot(snapshotId) {
    const ref = await this._vmRef(snapshotId);
    return { taskRef: await this._call('Async.VM.destroy', [ref]), provider: 'xapi' };
  }

  async close() {
    if (this._session) {
      const session = this._session;
      this._session = null;
      try { await this._rawCall('session.logout', [session]); } catch { /* best effort */ }
    }
    this._config._agent?.destroy?.();
    this._config._agent = null;
  }
}

function _shellQuote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }

function _hostKeySha256Hex(value) {
  const input = String(value || '').trim().replace(/^SHA256:/i, '');
  if (/^[a-f0-9]{64}$/i.test(input)) return input.toLowerCase();
  try {
    const decoded = Buffer.from(input, 'base64');
    if (decoded.length === 32) return decoded.toString('hex');
  } catch { /* validation below */ }
  throw new Error('hostKeySha256 must be a SHA-256 hex digest or an OpenSSH SHA256: base64 fingerprint');
}

class XenRawClient {
  constructor(config) {
    this._config = { ...config, provider: 'raw' };
    this._toolstack = null;
    if (!config.sshHost || !config.sshUsername) throw new Error('Raw Xen requires SSH host + username');
    if (!config.sshPassword && !config.sshPrivateKey) throw new Error('Raw Xen requires an SSH password or private key');
    if (config.hostKeySha256) this._hostKeyHex = _hostKeySha256Hex(config.hostKeySha256);
  }

  get provider() { return 'raw'; }

  capabilities() {
    return {
      provider: 'raw', pools: false, hosts: true, vms: true, templates: false, storages: false,
      networks: false, tasks: false, events: false, powerActions: true,
      snapshots: false, snapshotQuiesce: false, backups: false, console: true, provisioning: false,
      taskCleanup: false, runningDomainsOnly: true, toolstack: this._toolstack || 'auto',
      hardwareDetails: true, diskHotplug: false, nicHotplug: false,
      migrationPreflight: false, migrationLive: false, migrationCold: false, migrationStorage: false,
      vmGroups: false,
      legacyXend: this._toolstack === 'xm',
      vmActions: this._toolstack === 'xm'
        ? ['shutdown', 'forceShutdown', 'reboot', 'pause', 'unpause']
        : ['shutdown', 'forceShutdown', 'reboot', 'forceReboot', 'pause', 'unpause'],
    };
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const conn = new SshClient();
      const opts = {
        host: this._config.sshHost,
        port: _num(this._config.sshPort) || 22,
        username: this._config.sshUsername,
        readyTimeout: DEFAULT_TIMEOUT_MS,
      };
      if (this._config.sshPrivateKey) {
        opts.privateKey = this._config.sshPrivateKey;
        if (this._config.sshPassphrase) opts.passphrase = this._config.sshPassphrase;
      } else opts.password = this._config.sshPassword;
      if (this._config.hostKeySha256) {
        opts.hostHash = 'sha256';
        opts.hostVerifier = hash => String(hash).toLowerCase() === this._hostKeyHex;
      }
      conn.once('ready', () => resolve(conn));
      conn.once('error', err => reject(new XenError(`Raw Xen SSH: ${err.message}`, {
        code: err.code, status: 502, provider: 'raw',
      })));
      conn.connect(opts);
    });
  }

  async _exec(command) {
    const conn = await this._connect();
    try {
      return await new Promise((resolve, reject) => {
        let stdout = '', stderr = '', settled = false;
        const finish = (value, err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) reject(err); else resolve(value);
        };
        const timer = setTimeout(() => finish(null, new XenError('Raw Xen command timeout', {
          code: 'TIMEOUT', status: 504, provider: 'raw',
        })), DEFAULT_TIMEOUT_MS);
        conn.exec(command, (err, stream) => {
          if (err) return finish(null, err);
          const append = (target, chunk) => {
            const value = chunk.toString();
            if (stdout.length + stderr.length + value.length > MAX_RESPONSE_BYTES) {
              stream.destroy();
              finish(null, new XenError(`Raw Xen output exceeded ${MAX_RESPONSE_BYTES} bytes`, {
                code: 'RESPONSE_TOO_LARGE', status: 502, provider: 'raw',
              }));
              return target;
            }
            return target + value;
          };
          stream.on('data', d => { stdout = append(stdout, d); });
          stream.stderr.on('data', d => { stderr = append(stderr, d); });
          stream.on('close', code => {
            if (code !== 0) return finish(null, new XenError(`Raw Xen command failed (${code}): ${stderr.trim() || 'no details'}`, {
              code: 'XL_COMMAND_FAILED', status: 502, provider: 'raw',
            }));
            finish({ stdout, stderr, code });
          });
        });
      });
    } finally { try { conn.end(); } catch { /* ignore */ } }
  }

  async _detectToolstack() {
    if (this._toolstack) return this._toolstack;
    const { stdout } = await this._exec('if command -v xl >/dev/null 2>&1; then printf xl; elif command -v xm >/dev/null 2>&1; then printf xm; else exit 127; fi');
    const tool = stdout.trim();
    if (tool !== 'xl' && tool !== 'xm') throw new XenError('No supported Xen toolstack found (xl or legacy xm)', {
      code: 'XEN_TOOLSTACK_NOT_FOUND', status: 400, provider: 'raw',
    });
    this._toolstack = tool;
    return tool;
  }

  async _tool(args) {
    const tool = await this._detectToolstack();
    const prefix = this._config.useSudo ? 'sudo -n ' : '';
    return this._exec(`LC_ALL=C ${prefix}${tool} ${args}`);
  }

  async info() {
    const tool = await this._detectToolstack();
    const { stdout } = await this._tool('info');
    const fields = {};
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^\s*([^:]+)\s*:\s*(.*?)\s*$/);
      if (match) fields[match[1].trim()] = match[2];
    }
    return {
      provider: 'raw', product: tool === 'xm' ? 'Xen Project (legacy xend)' : 'Xen Project (libxl)',
      version: fields.xen_version || fields.xen_changeset || null,
      hostname: fields.host || this._config.sshHost,
      cpus: _num(fields.nr_cpus), memoryMiB: _num(fields.total_memory),
      freeMemoryMiB: _num(fields.free_memory), xenCaps: fields.xen_caps || null,
      toolstack: tool, capabilities: this.capabilities(),
    };
  }

  _normalizeLongList(value) {
    const rows = Array.isArray(value) ? value : (value ? [value] : []);
    return rows.map((entry, index) => {
      const c = entry.config || entry;
      const create = c.c_info || c.create_info || c;
      const build = c.b_info || c.build_info || c;
      const domid = entry.domid ?? c.domid ?? index;
      const name = create.name || entry.name || `domain-${domid}`;
      const uuid = create.uuid || entry.uuid || String(domid);
      const state = entry.state || c.state || (domid === 0 ? 'running' : 'unknown');
      return {
        id: String(uuid), uuid: String(uuid), domid: _num(domid), name: String(name),
        powerState: /p|paused/i.test(String(state)) ? 'paused' : 'running', cpus: _num(build.max_vcpus || entry.vcpus),
        memoryBytes: _num(build.max_memkb || entry.mem) * (build.max_memkb ? 1024 : 1024 * 1024),
        provider: 'raw', transient: true,
      };
    }).filter(v => v.domid !== 0 && v.name !== 'Domain-0');
  }

  async listVMs() {
    const tool = await this._detectToolstack();
    if (tool === 'xm') return this._parseTableList((await this._tool('list')).stdout);
    try {
      const { stdout } = await this._tool('list -l');
      return this._normalizeLongList(JSON.parse(stdout));
    } catch (err) {
      if (err.code !== 'XL_COMMAND_FAILED' && !(err instanceof SyntaxError)) throw err;
      return this._parseTableList((await this._tool('list')).stdout);
    }
  }

  async getVmHardware(nativeRef) {
    const target = String(nativeRef || '');
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(target) || target === '0' || /^Domain-0$/i.test(target)) {
      throw new XenError('Invalid raw Xen VM hardware target', { code: 'INVALID_PROVIDER_RESOURCE', status: 400, provider: 'raw' });
    }
    const diskWarnings = ['Standalone Xen reports runtime block topology only; capacity and persistent backing may be unavailable'];
    const nicWarnings = ['Standalone Xen reports runtime network topology only; persistent network policy is unavailable'];
    let diskOutput = ''; let nicOutput = '';
    try { diskOutput = (await this._tool(`block-list ${_shellQuote(target)}`)).stdout; }
    catch { diskWarnings.push('Runtime block-list could not be read'); }
    try { nicOutput = (await this._tool(`network-list ${_shellQuote(target)}`)).stdout; }
    catch { nicWarnings.push('Runtime network-list could not be read'); }
    const diskLines = diskOutput.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(1, 129);
    const nicLines = nicOutput.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(1, 65);
    const disks = diskLines.map(line => line.split(/\s+/)).filter(cols => cols.length >= 2).map(cols => ({
      nativeRef: cols[0], label: cols[0], type: 'disk', device: cols[0], bus: 'xen-vbd',
      backing: { type: 'xen-backend', path: cols[cols.length - 1] },
      attachment: { connected: true, startConnected: null },
      capabilities: { hotPlug: false, hotUnplug: false, onlineResize: false },
      status: cols[3] || 'attached',
    }));
    const nics = nicLines.map(line => line.split(/\s+/)).filter(cols => cols.length >= 3).map(cols => ({
      nativeRef: cols[0], label: `NIC ${cols[0]}`, device: cols[0], model: 'Xen virtual interface', macAddress: cols[2],
      network: { bridge: null }, attachment: { connected: true, startConnected: null },
      capabilities: { hotPlug: false, hotUnplug: false, connectDisconnect: false }, status: cols[5] || 'attached',
    }));
    return {
      disks, nics, diskAvailable: !!diskOutput, nicAvailable: !!nicOutput,
      diskReason: diskOutput ? null : 'Runtime block topology is unavailable',
      nicReason: nicOutput ? null : 'Runtime network topology is unavailable', diskWarnings, nicWarnings,
    };
  }

  async getVmMigrationCompatibility() {
    return {
      sourceRef: null, candidates: [],
      warnings: ['Standalone Xen has no multi-host management plane for migration candidate discovery'],
    };
  }

  async openConsole(nativeRef) {
    const target = String(nativeRef || '');
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(target)) {
      throw new XenError('Invalid raw Xen console target', {
        code: 'INVALID_PROVIDER_RESOURCE', status: 400, provider: 'raw',
      });
    }
    const tool = await this._detectToolstack();
    const conn = await this._connect();
    const prefix = this._config.useSudo ? 'sudo -n ' : '';
    try {
      const stream = await new Promise((resolve, reject) => {
        conn.exec(`LC_ALL=C ${prefix}${tool} console ${_shellQuote(target)}`, { pty: true }, (err, channel) => {
          if (err) reject(err); else resolve(channel);
        });
      });
      return {
        protocol: 'serial', stream,
        close: () => { try { stream.end(); } catch {} try { conn.end(); } catch {} },
      };
    } catch (err) {
      try { conn.end(); } catch {}
      throw new XenError(`Raw Xen console failed: ${err.message}`, {
        code: err.code || 'CONSOLE_UNAVAILABLE', status: 502, provider: 'raw',
      });
    }
  }

  async listTemplates() { return []; }

  _parseTableList(stdout) {
    const lines = stdout.split(/\r?\n/).filter(Boolean).slice(1);
    return lines.map(line => line.trim().split(/\s+/)).filter(cols => cols.length >= 6 && cols[1] !== '0')
      .map(cols => ({
        id: cols[1], uuid: cols[1], domid: _num(cols[1]), name: cols[0],
        memoryBytes: _num(cols[2]) * 1024 * 1024, cpus: _num(cols[3]),
        powerState: /p/i.test(cols[4]) ? 'paused' : 'running', cpuTimeSeconds: _num(cols[5]), provider: 'raw', transient: true,
      }));
  }

  async listHosts() { const info = await this.info(); return [{ id: info.hostname, name: info.hostname, ...info }]; }
  async listPools() { return []; }
  async listStorages() { return []; }
  async listNetworks() { return []; }
  async listTasks() { return []; }
  async getTask() { throw new XenError('Raw Xen does not expose asynchronous tasks', { status: 400, provider: 'raw' }); }
  async deleteTask() { throw new XenError('Raw Xen does not expose asynchronous tasks', { status: 400, provider: 'raw' }); }
  async listSnapshots() { return []; }

  async vmAction(vmId, action) {
    const target = String(vmId || '');
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(target) || target === '0' || /^Domain-0$/i.test(target)) {
      throw new XenError('Invalid or protected Xen domain identifier', { status: 400, provider: 'raw' });
    }
    const actions = {
      shutdown: 'shutdown', forceShutdown: 'destroy', reboot: 'reboot',
      forceReboot: 'reboot -F', pause: 'pause', unpause: 'unpause',
    };
    const tool = await this._detectToolstack();
    if (!actions[action] || (tool === 'xm' && action === 'forceReboot')) {
      throw new XenError(`Raw Xen action "${action}" is unavailable without a persistent domain config`, {
        status: 400, provider: 'raw',
      });
    }
    await this._tool(`${actions[action]} ${_shellQuote(target)}`);
    return { ok: true, provider: 'raw', action, vmId: target };
  }

  async createSnapshot() { throw new XenError('Raw libxl does not provide portable VM snapshots', { status: 400, provider: 'raw' }); }
  async revertSnapshot() { throw new XenError('Raw libxl does not provide portable VM snapshots', { status: 400, provider: 'raw' }); }
  async deleteSnapshot() { throw new XenError('Raw libxl does not provide portable VM snapshots', { status: 400, provider: 'raw' }); }
  async close() { /* connections are one-shot */ }
}

function normalizeProvider(value) {
  const provider = String(value || 'xo').toLowerCase();
  if (['xo', 'xen-orchestra', 'xenorchestra'].includes(provider)) return 'xo';
  if (['xapi', 'xcp-ng', 'xcpng', 'xenserver', 'citrix-hypervisor'].includes(provider)) return 'xapi';
  if (['raw', 'libxl', 'xl', 'xen-project'].includes(provider)) return 'raw';
  throw new Error(`Unsupported Xen provider: ${provider}`);
}

function createClient(config) {
  if (!config || typeof config !== 'object') throw new Error('Xen config object required');
  const provider = normalizeProvider(config.provider);
  if (provider === 'xo') return new XenOrchestraClient(config);
  if (provider === 'xapi') return new XapiClient(config);
  return new XenRawClient(config);
}

function decryptDaemonConfig(raw) {
  if (!raw || typeof raw !== 'string') return {};
  if (raw.startsWith('enc:')) {
    const { decrypt } = require('../utils/crypto');
    let plain;
    try { plain = decrypt(raw.slice(4)); }
    catch (err) { throw new Error(`daemon_config decrypt failed (ENCRYPTION_KEY changed?): ${err.message}`); }
    return JSON.parse(plain);
  }
  return JSON.parse(raw);
}

function encryptDaemonConfig(config) {
  const { encrypt } = require('../utils/crypto');
  return `enc:${encrypt(JSON.stringify(config || {}))}`;
}

function fromHostRow(row) {
  if (!row) throw new Error('fromHostRow: row required');
  if (row.daemon_type !== 'xen') throw new Error(`fromHostRow: row is not a Xen host (daemon_type=${row.daemon_type})`);
  let config;
  try { config = decryptDaemonConfig(row.daemon_config); }
  catch (err) { throw new Error(`fromHostRow: invalid daemon_config: ${err.message}`); }
  return createClient(config);
}

const _clientCache = new Map();

function clientForHost(row) {
  const cached = _clientCache.get(row.id);
  if (cached) return cached.client;
  const client = fromHostRow(row);
  const timer = setTimeout(() => invalidateHost(row.id), 20 * 60_000);
  timer.unref?.();
  _clientCache.set(row.id, { client, timer });
  return client;
}

function invalidateHost(hostId) {
  const cached = _clientCache.get(Number(hostId));
  if (!cached) return;
  _clientCache.delete(Number(hostId));
  clearTimeout(cached.timer);
  Promise.resolve(cached.client.close?.()).catch(() => {});
}

module.exports = {
  XenError,
  XenOrchestraClient,
  XapiClient,
  XenRawClient,
  createClient,
  fromHostRow,
  clientForHost,
  invalidateHost,
  normalizeProvider,
  decryptDaemonConfig,
  encryptDaemonConfig,
  _internals: {
    DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES, _xmlValue, _parseXmlRpcResponse,
    _parseXmlRpcValue, _xmlTokens, _shellQuote, _idFrom, _hostKeySha256Hex,
    _normalizedAllowedActions, _openApiOperationHasFields,
  },
};
