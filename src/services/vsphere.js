'use strict';

// v8.9.11-alpha.1 — VMware vSphere / ESXi read-only client.
//
// Works against both:
//   - Standalone ESXi (free / paid) — SOAP at /sdk
//   - vCenter Server — same SOAP at /sdk
//
// Zero new npm deps. Hand-rolled SOAP over stdlib https, then hand-parsed
// XML with tolerant regex (we only need a handful of well-known fields).
//
// SCOPE OF THIS ALPHA:
// - login (session cookie captured for follow-up calls)
// - listVMs — VM name, powerState, guestOS, memoryMB, numCPU, uuid
// - listHosts — hostname, model, cpuCores, cpuMHz, memorySize, connectionState
// - listDatastores — name, type, capacity, freeSpace
//
// Anti-features (won't do): power ops, snapshot ops, VM console. If you
// want to migrate a VM OFF ESXi, that's what Sprint 7 VM Migration is
// for (URL/OVA import to Proxmox).

const https = require('https');
const log = require('../utils/logger')('vsphere');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const SOAP_HEADERS = {
  'Content-Type': 'text/xml; charset=utf-8',
  'SOAPAction': 'urn:vim25/6.7',
};

// Static managed object references — same across all vSphere endpoints.
const MO_SERVICE_INSTANCE = 'ServiceInstance';
const MO_SESSION_MANAGER = 'SessionManager';
const MO_PROPERTY_COLLECTOR = 'propertyCollector';
const MO_VIEW_MANAGER = 'ViewManager';
const MO_ROOT_FOLDER = 'group-d1'; // vSphere convention

class VSphereClient {
  constructor(config) {
    if (!config || typeof config !== 'object') throw new Error('VSphereClient: config required');
    if (!config.endpoint) throw new Error('VSphereClient: endpoint required');
    if (!config.username || !config.password) throw new Error('VSphereClient: username + password required');
    // v8.9.11-alpha.6 — normalize endpoint: prepend https:// if missing.
    // vSphere SOAP always speaks TLS; users often paste just the hostname.
    if (!/^https?:\/\//i.test(config.endpoint)) {
      config = { ...config, endpoint: 'https://' + config.endpoint };
    }
    this._config = config;
    this._agent = new https.Agent({
      keepAlive: true,
      rejectUnauthorized: !config.skipTlsVerify,
    });
    this._sessionCookie = null;
    // v8.9.11-alpha.8 — Managed Object References differ between vCenter and
    // standalone ESXi. vCenter: sessionManager=SessionManager,
    // propertyCollector=propertyCollector, rootFolder=group-d1. Standalone
    // ESXi: sessionManager=ha-sessionmgr, propertyCollector=ha-property-
    // collector, rootFolder=ha-folder-root. Hardcoding the vCenter values
    // makes Login authenticate against a MoRef that doesn't exist on ESXi,
    // yielding "The session is not authenticated" on the next call. We seed
    // the vCenter defaults and OVERRIDE them from the real ServiceContent in
    // retrieveServiceContent() (which works on both).
    this._moRefs = {
      sessionManager: { type: 'SessionManager', value: MO_SESSION_MANAGER },
      propertyCollector: { type: 'PropertyCollector', value: MO_PROPERTY_COLLECTOR },
      rootFolder: { type: 'Folder', value: MO_ROOT_FOLDER },
      viewManager: { type: 'ViewManager', value: MO_VIEW_MANAGER },
    };
  }

  get daemonType() { return 'vsphere'; }

  async _soapPost(body, opts = {}) {
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const url = new URL('/sdk', this._config.endpoint);
    const reqOpts = {
      hostname: url.hostname,
      port: url.port || 443,
      method: 'POST',
      path: url.pathname,
      headers: { ...SOAP_HEADERS },
      agent: this._agent,
    };
    if (this._sessionCookie) reqOpts.headers['Cookie'] = this._sessionCookie;
    const bodyBuf = Buffer.from(body, 'utf8');
    reqOpts.headers['Content-Length'] = bodyBuf.length;
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
        finish(null, new Error(`vSphere SOAP timeout after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      const req = https.request(reqOpts, (res) => {
        // Capture Set-Cookie for session
        if (res.headers['set-cookie']) {
          const c = res.headers['set-cookie'].find(x => /vmware_soap_session/i.test(x));
          if (c) this._sessionCookie = c.split(';')[0];
        }
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            try { req.destroy(); } catch { /* ignore */ }
            finish(null, new Error(`vSphere response exceeded ${MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            const faultMsg = _extractFault(raw) || `HTTP ${res.statusCode}`;
            return finish(null, Object.assign(new Error(`vSphere SOAP error: ${faultMsg}`), {
              status: res.statusCode, vsphereResponse: raw.slice(0, 500),
            }));
          }
          // v8.9.11-alpha.7 — vSphere can return a SOAP fault with HTTP 200
          // (e.g. bad credentials, "not authenticated"). Detect it so a failed
          // Login surfaces clearly instead of silently yielding an anonymous
          // session that only fails on the next call.
          const fault200 = _extractFault(raw);
          if (fault200) {
            return finish(null, Object.assign(new Error(`vSphere SOAP error: ${fault200}`), {
              status: res.statusCode, vsphereResponse: raw.slice(0, 500),
            }));
          }
          finish(raw);
        });
      });
      req.on('error', (err) => finish(null, err));
      req.write(bodyBuf);
      req.end();
    });
  }

  /** Escape XML entities in a string value. */
  _xesc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  async login() {
    // v8.9.11-alpha.7 — proper vSphere SOAP flow: RetrieveServiceContent
    // FIRST to establish the session (the server sets the
    // vmware_soap_session cookie on this first request), THEN Login
    // authenticates THAT session. Calling Login without first retrieving
    // service content leaves some ESXi/vCenter builds with an
    // unauthenticated session -> "The session is not authenticated" on the
    // next call. Idempotent: retrieveServiceContent may be called again
    // later by callers that want the About info.
    if (!this._sessionCookie) {
      await this.retrieveServiceContent();
    }
    const sm = this._moRefs.sessionManager;
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <Login xmlns="urn:vim25">
      <_this type="${sm.type}">${sm.value}</_this>
      <userName>${this._xesc(this._config.username)}</userName>
      <password>${this._xesc(this._config.password)}</password>
    </Login>
  </soap:Body>
</soap:Envelope>`;
    await this._soapPost(body);
    // A bad Login now throws via the SOAP-fault detection above, so reaching
    // here means the session cookie (set during RetrieveServiceContent and
    // authenticated by Login) is valid.
    if (!this._sessionCookie) throw new Error('vSphere login: no session cookie returned');
    return { ok: true };
  }

  async logout() {
    if (!this._sessionCookie) return;
    const sm = this._moRefs.sessionManager;
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <Logout xmlns="urn:vim25">
      <_this type="${sm.type}">${sm.value}</_this>
    </Logout>
  </soap:Body>
</soap:Envelope>`;
    try { await this._soapPost(body); } catch { /* ignore */ }
    this._sessionCookie = null;
  }

  /** Fetch the ServiceContent — includes about (version) info. Also caches
   * relevant MoRefs (rootFolder, viewManager, propertyCollector). */
  async retrieveServiceContent() {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <RetrieveServiceContent xmlns="urn:vim25">
      <_this type="ServiceInstance">${MO_SERVICE_INSTANCE}</_this>
    </RetrieveServiceContent>
  </soap:Body>
</soap:Envelope>`;
    const resp = await this._soapPost(body);
    // Override the seeded MoRefs with the real ones for THIS server (ESXi or
    // vCenter). Keep the seeded default if a ref isn't present in the reply.
    const sm = _extractMoRef(resp, 'sessionManager');
    const pc = _extractMoRef(resp, 'propertyCollector');
    const rf = _extractMoRef(resp, 'rootFolder');
    const vm = _extractMoRef(resp, 'viewManager');
    if (sm) this._moRefs.sessionManager = sm;
    if (pc) this._moRefs.propertyCollector = pc;
    if (rf) this._moRefs.rootFolder = rf;
    if (vm) this._moRefs.viewManager = vm;
    return {
      apiVersion: _extractTag(resp, 'apiVersion'),
      version: _extractTag(resp, 'version'),
      build: _extractTag(resp, 'build'),
      productName: _extractTag(resp, 'name'),
      productFullName: _extractTag(resp, 'fullName'),
      osType: _extractTag(resp, 'osType'),
      instanceUuid: _extractTag(resp, 'instanceUuid'),
    };
  }

  /**
   * List all VMs via CreateContainerView + RetrievePropertiesEx.
   * Returns array of { name, powerState, guestOS, memoryMB, numCPU, uuid, moref }.
   */
  async listVMs() {
    await this._ensureLoggedIn();
    // Step 1: create container view for VirtualMachine
    const createViewBody = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <CreateContainerView xmlns="urn:vim25">
      <_this type="${this._moRefs.viewManager.type}">${this._moRefs.viewManager.value}</_this>
      <container type="${this._moRefs.rootFolder.type}">${this._moRefs.rootFolder.value}</container>
      <type>VirtualMachine</type>
      <recursive>true</recursive>
    </CreateContainerView>
  </soap:Body>
</soap:Envelope>`;
    const viewResp = await this._soapPost(createViewBody);
    const viewId = _extractTag(viewResp, 'returnval');
    if (!viewId) throw new Error('vSphere: CreateContainerView returned no ID');

    // Step 2: retrieve properties.
    // v8.9.12-alpha.1 — richer per-VM data (ported from SOS ESXi Monitor):
    // guest IP/hostname/tools, HW version, live cpu/mem usage, storage.
    const props = ['name', 'summary.runtime.powerState', 'summary.config.guestFullName',
      'summary.config.memorySizeMB', 'summary.config.numCpu', 'summary.config.uuid',
      'guest.hostName', 'guest.ipAddress', 'guest.toolsStatus', 'guest.toolsVersion',
      'config.version',
      'summary.quickStats.overallCpuUsage', 'summary.quickStats.guestMemoryUsage',
      'summary.storage.committed', 'summary.storage.uncommitted'];
    const rawResp = await this._retrieveProperties(viewId, 'VirtualMachine', props);
    const objs = _extractObjects(rawResp);
    return objs.map(o => ({
      moref: o.obj,
      name: o.props['name'],
      powerState: o.props['summary.runtime.powerState'],
      guestOS: o.props['summary.config.guestFullName'],
      memoryMB: parseInt(o.props['summary.config.memorySizeMB'], 10) || null,
      numCPU: parseInt(o.props['summary.config.numCpu'], 10) || null,
      uuid: o.props['summary.config.uuid'],
      guestHostname: o.props['guest.hostName'] || null,
      ipAddress: o.props['guest.ipAddress'] || null,
      toolsStatus: o.props['guest.toolsStatus'] || null,
      toolsVersion: o.props['guest.toolsVersion'] || null,
      hwVersion: o.props['config.version'] || null,
      cpuUsageMHz: parseInt(o.props['summary.quickStats.overallCpuUsage'], 10) || 0,
      memoryUsageMB: parseInt(o.props['summary.quickStats.guestMemoryUsage'], 10) || 0,
      storageCommittedBytes: parseInt(o.props['summary.storage.committed'], 10) || 0,
      storageUncommittedBytes: parseInt(o.props['summary.storage.uncommitted'], 10) || 0,
    }));
  }

  async listHosts() {
    await this._ensureLoggedIn();
    const createViewBody = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <CreateContainerView xmlns="urn:vim25">
      <_this type="${this._moRefs.viewManager.type}">${this._moRefs.viewManager.value}</_this>
      <container type="${this._moRefs.rootFolder.type}">${this._moRefs.rootFolder.value}</container>
      <type>HostSystem</type>
      <recursive>true</recursive>
    </CreateContainerView>
  </soap:Body>
</soap:Envelope>`;
    const viewResp = await this._soapPost(createViewBody);
    const viewId = _extractTag(viewResp, 'returnval');
    // v8.9.12-alpha.1 — live host metrics (ported from SOS ESXi Monitor):
    // quickStats give CPU MHz used, memory MB used and uptime; product.*
    // gives version/build/apiVersion; hardware.* the CPU spec + host UUID.
    const props = ['name', 'summary.runtime.connectionState', 'summary.hardware.model',
      'summary.hardware.numCpuCores', 'summary.hardware.cpuMhz', 'summary.hardware.memorySize',
      'summary.hardware.numCpuThreads', 'summary.hardware.numCpuPkgs', 'summary.hardware.cpuModel',
      'summary.hardware.uuid',
      'summary.quickStats.overallCpuUsage', 'summary.quickStats.overallMemoryUsage',
      'summary.quickStats.uptime', 'runtime.bootTime',
      'summary.config.product.fullName', 'summary.config.product.version',
      'summary.config.product.build', 'summary.config.product.apiVersion'];
    const rawResp = await this._retrieveProperties(viewId, 'HostSystem', props);
    const objs = _extractObjects(rawResp);
    return objs.map(o => {
      const cpuMHz = parseInt(o.props['summary.hardware.cpuMhz'], 10) || 0;
      const cpuCores = parseInt(o.props['summary.hardware.numCpuCores'], 10) || 0;
      const memBytes = parseInt(o.props['summary.hardware.memorySize'], 10) || 0;
      const cpuUsedMHz = parseInt(o.props['summary.quickStats.overallCpuUsage'], 10) || 0;
      const memUsedMB = parseInt(o.props['summary.quickStats.overallMemoryUsage'], 10) || 0;
      const cpuTotalMHz = cpuMHz * cpuCores;
      const memTotalMB = memBytes ? Math.round(memBytes / (1024 * 1024)) : 0;
      return {
        moref: o.obj,
        name: o.props['name'],
        connectionState: o.props['summary.runtime.connectionState'],
        model: o.props['summary.hardware.model'],
        cpuModel: o.props['summary.hardware.cpuModel'] || null,
        cpuCores,
        cpuThreads: parseInt(o.props['summary.hardware.numCpuThreads'], 10) || null,
        cpuPackages: parseInt(o.props['summary.hardware.numCpuPkgs'], 10) || null,
        cpuMHz,
        memoryBytes: memBytes || null,
        hostUuid: o.props['summary.hardware.uuid'] || null,
        version: o.props['summary.config.product.fullName'],
        productVersion: o.props['summary.config.product.version'] || null,
        build: o.props['summary.config.product.build'] || null,
        apiVersion: o.props['summary.config.product.apiVersion'] || null,
        // Live metrics + derived percentages.
        cpuUsageMHz: cpuUsedMHz,
        cpuTotalMHz,
        cpuPercent: cpuTotalMHz ? Math.round((cpuUsedMHz / cpuTotalMHz) * 100) : null,
        memoryUsageMB: memUsedMB,
        memoryTotalMB: memTotalMB,
        memoryPercent: memTotalMB ? Math.round((memUsedMB / memTotalMB) * 100) : null,
        uptimeSeconds: parseInt(o.props['summary.quickStats.uptime'], 10) || null,
        bootTime: o.props['runtime.bootTime'] || null,
      };
    });
  }

  async listDatastores() {
    await this._ensureLoggedIn();
    const createViewBody = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <CreateContainerView xmlns="urn:vim25">
      <_this type="${this._moRefs.viewManager.type}">${this._moRefs.viewManager.value}</_this>
      <container type="${this._moRefs.rootFolder.type}">${this._moRefs.rootFolder.value}</container>
      <type>Datastore</type>
      <recursive>true</recursive>
    </CreateContainerView>
  </soap:Body>
</soap:Envelope>`;
    const viewResp = await this._soapPost(createViewBody);
    const viewId = _extractTag(viewResp, 'returnval');
    const props = ['name', 'summary.type', 'summary.capacity', 'summary.freeSpace',
      'summary.accessible', 'summary.maintenanceMode', 'summary.url'];
    const rawResp = await this._retrieveProperties(viewId, 'Datastore', props);
    const objs = _extractObjects(rawResp);
    return objs.map(o => ({
      moref: o.obj,
      name: o.props['name'],
      type: o.props['summary.type'],
      capacityBytes: parseInt(o.props['summary.capacity'], 10) || null,
      freeSpaceBytes: parseInt(o.props['summary.freeSpace'], 10) || null,
      accessible: o.props['summary.accessible'] === 'true',
      maintenanceMode: o.props['summary.maintenanceMode'] || null,
      url: o.props['summary.url'] || null,
    }));
  }

  async _ensureLoggedIn() {
    if (!this._sessionCookie) await this.login();
  }

  async _retrieveProperties(viewId, type, propPaths) {
    const pathSetTags = propPaths.map(p => `<pathSet>${p}</pathSet>`).join('');
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <RetrievePropertiesEx xmlns="urn:vim25">
      <_this type="${this._moRefs.propertyCollector.type}">${this._moRefs.propertyCollector.value}</_this>
      <specSet>
        <propSet>
          <type>${type}</type>
          ${pathSetTags}
        </propSet>
        <objectSet>
          <obj type="ContainerView">${viewId}</obj>
          <skip>true</skip>
          <selectSet xsi:type="TraversalSpec" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
            <name>view</name>
            <type>ContainerView</type>
            <path>view</path>
            <skip>false</skip>
          </selectSet>
        </objectSet>
      </specSet>
      <options/>
    </RetrievePropertiesEx>
  </soap:Body>
</soap:Envelope>`;
    return await this._soapPost(body);
  }
}

// ─── XML parsing helpers (tolerant regex) ───────────────────────

function _extractTag(xml, tagName) {
  const m = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`).exec(xml);
  return m ? _decodeEntities(m[1].trim()) : null;
}

function _extractFault(xml) {
  const localized = /<localizedMessage>([\s\S]*?)<\/localizedMessage>/.exec(xml);
  if (localized) return _decodeEntities(localized[1]);
  const fault = /<faultstring>([\s\S]*?)<\/faultstring>/.exec(xml);
  if (fault) return _decodeEntities(fault[1]);
  return null;
}

// v8.9.11-alpha.8 — pull a Managed Object Reference from a ServiceContent
// reply: <sessionManager type="SessionManager">ha-sessionmgr</sessionManager>
// -> { type: 'SessionManager', value: 'ha-sessionmgr' }. Namespace-tolerant.
function _extractMoRef(xml, tag) {
  const m = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*\\btype="([^"]+)"[^>]*>([^<]+)</(?:\\w+:)?${tag}>`).exec(xml);
  if (!m) return null;
  return { type: m[1], value: _decodeEntities(m[2].trim()) };
}

function _decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * Extract <objects> blocks from a RetrievePropertiesEx response.
 * Each block looks like:
 *   <objects>
 *     <obj type="VirtualMachine">vm-123</obj>
 *     <propSet><name>name</name><val>foo</val></propSet>
 *     <propSet><name>summary.runtime.powerState</name><val>poweredOn</val></propSet>
 *   </objects>
 */
function _extractObjects(xml) {
  const result = [];
  const objRegex = /<objects>([\s\S]*?)<\/objects>/g;
  let m;
  while ((m = objRegex.exec(xml))) {
    const block = m[1];
    const objMatch = /<obj\s+type="([^"]+)"[^>]*>([^<]+)<\/obj>/.exec(block);
    if (!objMatch) continue;
    const props = {};
    const propRegex = /<propSet>\s*<name>([^<]+)<\/name>\s*<val[^>]*>([\s\S]*?)<\/val>\s*<\/propSet>/g;
    let pm;
    while ((pm = propRegex.exec(block))) {
      props[pm[1]] = _decodeEntities(pm[2].trim());
    }
    result.push({ obj: objMatch[2], type: objMatch[1], props });
  }
  return result;
}

// ─── daemon_config encryption + fromHostRow ────────────────────

function decryptDaemonConfig(raw) {
  if (!raw) return {};
  if (typeof raw !== 'string') return {};
  if (raw.startsWith('enc:')) {
    const { decrypt } = require('../utils/crypto');
    let plain;
    try { plain = decrypt(raw.slice(4)); }
    catch (e) { throw new Error(`daemon_config decrypt failed: ${e.message}`); }
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
  if (row.daemon_type !== 'vsphere') {
    throw new Error(`fromHostRow: row is not a vSphere host (daemon_type=${row.daemon_type})`);
  }
  let cfg;
  try { cfg = decryptDaemonConfig(row.daemon_config); }
  catch (e) { throw new Error(`fromHostRow: invalid daemon_config: ${e.message}`); }
  return new VSphereClient(cfg);
}

module.exports = {
  VSphereClient, fromHostRow, decryptDaemonConfig, encryptDaemonConfig,
  _internals: { _extractTag, _extractFault, _extractObjects, _decodeEntities, _extractMoRef },
};

if (false) log.info();
