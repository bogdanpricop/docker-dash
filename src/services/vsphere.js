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
const { prefixToNetmask } = require('./provider-operations/guest-customization');

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
      // v8.9.13-alpha.1 — LicenseManager MoRef (vCenter: LicenseManager,
      // ESXi: ha-license-manager) resolved from ServiceContent.
      licenseManager: { type: 'LicenseManager', value: 'LicenseManager' },
      // v8.9.14-alpha.2 — FileManager MoRef for datastore file delete
      // (vCenter: FileManager, ESXi: ha-nfc-file-manager... actually
      // 'ha-datastorebrowser'? no — FileManager on ESXi is 'ha-nfc-file-
      // manager'? Resolved from ServiceContent; default is the vCenter value).
      fileManager: { type: 'FileManager', value: 'FileManager' },
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
        finish(null, Object.assign(new Error(`vSphere SOAP timeout after ${timeoutMs / 1000}s`), {
          code: 'ETIMEDOUT', transient: true,
        }));
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
    const lm = _extractMoRef(resp, 'licenseManager');
    const fm = _extractMoRef(resp, 'fileManager');
    if (sm) this._moRefs.sessionManager = sm;
    if (pc) this._moRefs.propertyCollector = pc;
    if (rf) this._moRefs.rootFolder = rf;
    if (vm) this._moRefs.viewManager = vm;
    if (lm) this._moRefs.licenseManager = lm;
    if (fm) this._moRefs.fileManager = fm;
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
  async _listVirtualMachineRows() {
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
      'runtime.host',
      'config.version', 'config.template', 'config.annotation', 'summary.config.guestId',
      'capability.snapshotOperationsSupported',
      'summary.quickStats.overallCpuUsage', 'summary.quickStats.guestMemoryUsage',
      'summary.storage.committed', 'summary.storage.uncommitted',
      // v8.9.13-alpha.3 — per-datastore committed bytes, so the Datastores
      // tab can attribute used space to VMs vs "other".
      'storage.perDatastoreUsage'];
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
      hostRef: _firstManagedRef(o.props['runtime.host'], 'HostSystem'),
      isTemplate: o.props['config.template'] === 'true',
      description: o.props['config.annotation'] || null,
      osType: o.props['summary.config.guestId'] || o.props['summary.config.guestFullName'] || null,
      snapshotOperationsSupported: o.props['capability.snapshotOperationsSupported'] === 'true',
      cpuUsageMHz: parseInt(o.props['summary.quickStats.overallCpuUsage'], 10) || 0,
      memoryUsageMB: parseInt(o.props['summary.quickStats.guestMemoryUsage'], 10) || 0,
      storageCommittedBytes: parseInt(o.props['summary.storage.committed'], 10) || 0,
      storageUncommittedBytes: parseInt(o.props['summary.storage.uncommitted'], 10) || 0,
      // Array of { datastore: moref, committed } parsed from
      // storage.perDatastoreUsage (best-effort; [] if absent).
      datastoreUsage: _parseDatastoreUsage(o.props['storage.perDatastoreUsage'] || ''),
    }));
  }

  async listVMs() {
    return (await this._listVirtualMachineRows()).filter(row => !row.isTemplate);
  }

  async getVmHardware(vmMoref) {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(String(vmMoref || ''))) {
      throw Object.assign(new Error('Invalid vSphere VM hardware target'), { code: 'INVALID_PROVIDER_RESOURCE' });
    }
    await this._ensureLoggedIn();
    const raw = await this._retrievePropertiesDirect('VirtualMachine', vmMoref,
      ['config.hardware.device', 'guest.net']);
    const props = (_extractObjects(raw)[0] || { props: {} }).props;
    return _parseVmHardware(props['config.hardware.device'] || '', props['guest.net'] || '');
  }

  async getVmMigrationCompatibility(vmMoref, hostMorefs) {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(String(vmMoref || '')) || !Array.isArray(hostMorefs)
      || hostMorefs.length > 64 || hostMorefs.some(ref => !/^[A-Za-z0-9._:-]{1,160}$/.test(String(ref || '')))) {
      throw Object.assign(new Error('Invalid vSphere migration compatibility target'), { code: 'INVALID_MIGRATION_CONTEXT' });
    }
    await this._ensureLoggedIn();
    const vmRaw = await this._retrievePropertiesDirect('VirtualMachine', vmMoref, ['runtime.host']);
    const sourceRef = _firstManagedRef((_extractObjects(vmRaw)[0] || { props: {} }).props['runtime.host'], 'HostSystem');
    if (!hostMorefs.length) return { sourceRef, candidates: [] };
    const hosts = hostMorefs.map(ref => `<host type="HostSystem">${this._xesc(ref)}</host>`).join('');
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><QueryVMotionCompatibility xmlns="urn:vim25">
    <_this type="ServiceInstance">${MO_SERVICE_INSTANCE}</_this>
    <vm type="VirtualMachine">${this._xesc(vmMoref)}</vm>${hosts}
    <compatibility>cpu</compatibility><compatibility>software</compatibility>
  </QueryVMotionCompatibility></soap:Body>
</soap:Envelope>`;
    return { sourceRef, candidates: _parseVmotionCompatibility(await this._soapPost(body)) };
  }

  async listTemplates() {
    return (await this._listVirtualMachineRows()).filter(row => row.isTemplate).map(row => ({
      kind: 'vmTemplate', nativeRef: row.moref, id: row.moref, uuid: row.uuid,
      name: row.name, description: row.description, osType: row.osType || row.guestOS,
      memoryMB: row.memoryMB, numCPU: row.numCPU, version: row.hwVersion,
      sizeBytes: row.storageCommittedBytes, source: 'vsphere-inventory',
    }));
  }

  async getClonePlacement(templateMoref) {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(String(templateMoref || ''))) {
      throw Object.assign(new Error('Invalid vSphere template reference'), { code: 'INVALID_PROVIDER_RESOURCE' });
    }
    await this._ensureLoggedIn();
    const raw = await this._retrievePropertiesDirect('VirtualMachine', templateMoref,
      ['parent', 'resourcePool', 'datastore', 'config.template']);
    const props = (_extractObjects(raw)[0] || { props: {} }).props;
    if (props['config.template'] !== 'true') {
      throw Object.assign(new Error('vSphere source is no longer a VM template'), { code: 'PROVIDER_ARTIFACT_NOT_FOUND' });
    }
    const folderRef = _firstManagedRef(props.parent, 'Folder');
    const poolRef = _firstManagedRef(props.resourcePool, 'ResourcePool');
    const datastoreRefs = _managedRefs(props.datastore, 'Datastore');
    if (!folderRef || !poolRef || !datastoreRefs.length) {
      throw Object.assign(new Error('vSphere clone placement is incomplete'), { code: 'PROVIDER_PLACEMENT_UNAVAILABLE' });
    }
    const datastores = (await this.listDatastores()).filter(item => item.accessible !== false && item.maintenanceMode !== 'inMaintenance');
    const sourceDatastores = datastoreRefs.map(ref => datastores.find(item => item.moref === ref)).filter(Boolean);
    if (!sourceDatastores.length) {
      throw Object.assign(new Error('vSphere source template datastore is unavailable'), { code: 'PROVIDER_PLACEMENT_UNAVAILABLE' });
    }
    return {
      folderRef, poolRef,
      datastores, sourceDatastores,
    };
  }

  _linuxCustomizationSpec(customization, tag = 'customization') {
    if (!customization || customization.osFamily !== 'linux' || !customization.network
      || !/^(?=.{1,63}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(String(customization.hostname || ''))
      || !customization.domain || customization.user || customization.sshAuthorizedKeys?.length) {
      throw Object.assign(new Error('Invalid or unsupported vSphere Linux guest customization'), {
        code: 'INVALID_GUEST_CUSTOMIZATION', status: 400,
      });
    }
    const network = customization.network;
    let ip;
    if (network.mode === 'static') {
      const [address, prefix] = String(network.address || '').split('/');
      ip = `<ip xsi:type="CustomizationFixedIp"><ipAddress>${this._xesc(address)}</ipAddress></ip>`
        + `<subnetMask>${prefixToNetmask(prefix)}</subnetMask><gateway>${this._xesc(network.gateway)}</gateway>`;
    } else {
      ip = '<ip xsi:type="CustomizationDhcpIpGenerator"/>';
    }
    const dnsServers = (network.dnsServers || []).map(value => `<dnsServerList>${this._xesc(value)}</dnsServerList>`).join('');
    const dnsSuffixes = [...new Set([customization.domain, ...(network.searchDomains || [])].filter(Boolean))]
      .map(value => `<dnsSuffixList>${this._xesc(value)}</dnsSuffixList>`).join('');
    const timeZone = customization.timezone ? `<timeZone>${this._xesc(customization.timezone)}</timeZone>` : '';
    return `<${tag}>
      <identity xsi:type="CustomizationLinuxPrep">
        <hostName xsi:type="CustomizationFixedName"><name>${this._xesc(customization.hostname)}</name></hostName>
        <domain>${this._xesc(customization.domain)}</domain>${timeZone}<hwClockUTC>true</hwClockUTC>
      </identity>
      <globalIPSettings>${dnsSuffixes}${dnsServers}</globalIPSettings>
      <nicSettingMap><adapter>${ip}<dnsDomain>${this._xesc(customization.domain)}</dnsDomain></adapter></nicSettingMap>
    </${tag}>`;
  }

  async checkCustomizationSpec(templateMoref, customization) {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(String(templateMoref || ''))) {
      throw Object.assign(new Error('Invalid vSphere template reference'), { code: 'INVALID_PROVIDER_RESOURCE' });
    }
    const spec = this._linuxCustomizationSpec(customization, 'spec');
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><CheckCustomizationSpec xmlns="urn:vim25">
    <_this type="VirtualMachine">${this._xesc(templateMoref)}</_this>${spec}
  </CheckCustomizationSpec></soap:Body>
</soap:Envelope>`;
    await this._soapPost(body);
    return { compatible: true };
  }

  async cloneTemplate(templateMoref, options = {}) {
    await this._ensureLoggedIn();
    const refs = [templateMoref, options.folderRef, options.poolRef, options.datastoreRef];
    if (refs.some(value => !/^[A-Za-z0-9._:-]{1,160}$/.test(String(value || '')))
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(String(options.name || ''))
      || options.mode !== 'full') {
      throw Object.assign(new Error('Invalid vSphere template clone request'), { code: 'INVALID_PROVIDER_RESOURCE', status: 400 });
    }
    const customization = options.customization
      ? this._linuxCustomizationSpec(options.customization) : '';
    if (options.customization) await this.checkCustomizationSpec(templateMoref, options.customization);
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><CloneVM_Task xmlns="urn:vim25">
    <_this type="VirtualMachine">${this._xesc(templateMoref)}</_this>
    <folder type="Folder">${this._xesc(options.folderRef)}</folder>
    <name>${this._xesc(options.name)}</name>
    <spec><location>
      <datastore type="Datastore">${this._xesc(options.datastoreRef)}</datastore>
      <pool type="ResourcePool">${this._xesc(options.poolRef)}</pool>
    </location><template>false</template>${customization}<powerOn>false</powerOn></spec>
  </CloneVM_Task></soap:Body>
</soap:Envelope>`;
    const response = await this._soapPost(body);
    const taskRef = _extractTag(response, 'returnval');
    if (!taskRef) throw Object.assign(new Error('vSphere clone operation returned no task'), { code: 'INVALID_PROVIDER_TASK_RESPONSE' });
    return { taskRef, provider: 'vsphere' };
  }

  /** Recursively discover ISO media on accessible datastores. */
  async listIsoImages() {
    await this._ensureLoggedIn();
    const datastores = await this.listDatastores();
    const artifacts = [];
    for (const datastore of datastores.filter(item => item.accessible !== false)) {
      try {
        const browser = await this._getDatastoreBrowser(datastore.moref);
        if (!browser) continue;
        const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <SearchDatastoreSubFolders_Task xmlns="urn:vim25">
      <_this type="HostDatastoreBrowser">${browser}</_this>
      <datastorePath>${this._xesc(`[${datastore.name}]`)}</datastorePath>
      <searchSpec>
        <query xsi:type="IsoImageFileQuery"/>
        <details><fileType>true</fileType><fileSize>true</fileSize><modification>true</modification><fileOwner>false</fileOwner></details>
        <searchCaseInsensitive>true</searchCaseInsensitive><matchPattern>*.iso</matchPattern>
      </searchSpec>
    </SearchDatastoreSubFolders_Task>
  </soap:Body>
</soap:Envelope>`;
        const response = await this._soapPost(body);
        const taskMoref = _extractTag(response, 'returnval');
        if (!taskMoref) continue;
        const result = await this._waitForTask(taskMoref, 30_000);
        for (const entry of _parseRecursiveSearchResults(result, datastore.name)) {
          artifacts.push({
            kind: 'iso', nativeRef: entry.datastorePath, id: entry.datastorePath,
            name: entry.name, storage: datastore.name, source: 'vsphere-datastore',
            sizeBytes: entry.fileSize, createdAt: entry.modified, format: 'iso',
          });
        }
      } catch (err) {
        log.warn('vSphere ISO inventory skipped an inaccessible datastore', { datastore: datastore.name, error: err?.name || 'Error' });
      }
    }
    return artifacts;
  }

  /** Submit a VM power action using the vSphere Web Services API. */
  async acquireVmConsoleTicket(vmMoref) {
    await this._ensureLoggedIn();
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(String(vmMoref || ''))) {
      throw Object.assign(new Error('Invalid vSphere VM reference'), { code: 'INVALID_PROVIDER_RESOURCE' });
    }
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <AcquireTicket xmlns="urn:vim25">
      <_this type="VirtualMachine">${this._xesc(vmMoref)}</_this>
      <ticketType>webmks</ticketType>
    </AcquireTicket>
  </soap:Body>
</soap:Envelope>`;
    const response = await this._soapPost(body);
    const ticket = _extractTag(response, 'ticket');
    const host = _extractTag(response, 'host');
    const port = Number(_extractTag(response, 'port')) || 443;
    let url = _extractTag(response, 'url');
    if (!url && host && ticket) url = `wss://${host}:${port}/ticket/${encodeURIComponent(ticket)}`;
    if (!ticket || !url) {
      throw Object.assign(new Error('vSphere did not issue a WebMKS console ticket'), {
        code: 'CONSOLE_TICKET_UNAVAILABLE', status: 502,
      });
    }
    const parsed = new URL(url);
    if (parsed.protocol !== 'wss:' || parsed.username || parsed.password) {
      throw Object.assign(new Error('vSphere returned an invalid WebMKS URL'), {
        code: 'INVALID_CONSOLE_TICKET', status: 502,
      });
    }
    return {
      url: parsed.href, ticket, host: host || parsed.hostname, port,
      sslThumbprint: _extractTag(response, 'sslThumbprint'),
      agent: this._agent,
    };
  }

  /** Submit a VM power action using the vSphere Web Services API. */
  async vmPowerAction(vmMoref, action) {
    await this._ensureLoggedIn();
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(String(vmMoref || ''))) {
      throw Object.assign(new Error('Invalid vSphere VM reference'), { code: 'INVALID_PROVIDER_RESOURCE' });
    }
    const operation = {
      start: 'PowerOnVM_Task', shutdown: 'ShutdownGuest', reboot: 'RebootGuest',
      forceShutdown: 'PowerOffVM_Task', forceReboot: 'ResetVM_Task',
    }[action];
    if (!operation) throw Object.assign(new Error('Unsupported vSphere VM power action'), { code: 'PROVIDER_ACTION_UNAVAILABLE' });
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <${operation} xmlns="urn:vim25">
      <_this type="VirtualMachine">${this._xesc(vmMoref)}</_this>
    </${operation}>
  </soap:Body>
</soap:Envelope>`;
    const response = await this._soapPost(body);
    const taskRef = operation.endsWith('_Task') ? _extractTag(response, 'returnval') : null;
    if (operation.endsWith('_Task') && !taskRef) {
      throw Object.assign(new Error('vSphere power operation returned no task'), { code: 'INVALID_PROVIDER_TASK_RESPONSE' });
    }
    return { taskRef, provider: 'vsphere' };
  }

  async getTaskStatus(taskMoref) {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(String(taskMoref || ''))) {
      throw Object.assign(new Error('Invalid vSphere task reference'), { code: 'INVALID_PROVIDER_TASK' });
    }
    const raw = await this._retrievePropertiesDirect('Task', taskMoref,
      ['info.state', 'info.progress', 'info.error', 'info.result', 'info.cancelable', 'info.cancelled']);
    const props = (_extractObjects(raw)[0] || { props: {} }).props;
    const resultRef = _firstManagedRef(props['info.result'], 'VirtualMachine');
    return {
      status: props['info.state'] || 'unknown',
      progress: parseInt(props['info.progress'], 10) || 0,
      error: props['info.error'] ? (_extractFault(props['info.error']) || 'vSphere task failed') : null,
      ...(props['info.cancelable'] === undefined ? {} : { cancelable: props['info.cancelable'] === 'true' }),
      ...(props['info.cancelled'] === undefined ? {} : { cancelled: props['info.cancelled'] === 'true' }),
      ...(resultRef ? { resultRef } : {}),
    };
  }

  /** Submit a vSphere relocation and return its durable Task MoRef. */
  async relocateVm(vmMoref, options = {}) {
    await this._ensureLoggedIn();
    const hostRef = String(options.hostRef || '');
    const datastoreRef = options.datastoreRef == null ? null : String(options.datastoreRef);
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(String(vmMoref || ''))
      || !/^[A-Za-z0-9._:-]{1,160}$/.test(hostRef)
      || (datastoreRef && !/^[A-Za-z0-9._:-]{1,160}$/.test(datastoreRef))) {
      throw Object.assign(new Error('Invalid vSphere relocation target'), { code: 'INVALID_MIGRATION_CONTEXT', status: 400 });
    }
    const datastore = datastoreRef
      ? `<datastore type="Datastore">${this._xesc(datastoreRef)}</datastore>` : '';
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><RelocateVM_Task xmlns="urn:vim25">
    <_this type="VirtualMachine">${this._xesc(vmMoref)}</_this>
    <spec>${datastore}<host type="HostSystem">${this._xesc(hostRef)}</host></spec>
    <priority>defaultPriority</priority>
  </RelocateVM_Task></soap:Body>
</soap:Envelope>`;
    const taskRef = _extractTag(await this._soapPost(body), 'returnval');
    if (!taskRef) throw Object.assign(new Error('vSphere relocation returned no task'), { code: 'INVALID_PROVIDER_TASK_RESPONSE' });
    return { taskRef, provider: 'vsphere' };
  }

  /** Enter native host maintenance and return the durable vSphere Task MoRef. */
  async enterHostMaintenance(hostMoref, options = {}) {
    await this._ensureLoggedIn();
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(String(hostMoref || ''))) {
      throw Object.assign(new Error('Invalid vSphere host reference'), { code: 'INVALID_PROVIDER_RESOURCE' });
    }
    const timeout = Math.min(86400, Math.max(60, Math.round(Number(options.timeoutSeconds) || 3600)));
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><EnterMaintenanceMode_Task xmlns="urn:vim25">
    <_this type="HostSystem">${this._xesc(hostMoref)}</_this>
    <timeout>${timeout}</timeout><evacuatePoweredOffVms>false</evacuatePoweredOffVms>
  </EnterMaintenanceMode_Task></soap:Body>
</soap:Envelope>`;
    const taskRef = _extractTag(await this._soapPost(body), 'returnval');
    if (!taskRef) throw Object.assign(new Error('vSphere maintenance operation returned no task'), { code: 'INVALID_PROVIDER_TASK_RESPONSE' });
    return { taskRef, provider: 'vsphere', action: 'enter' };
  }

  /** Exit native host maintenance and return the durable vSphere Task MoRef. */
  async exitHostMaintenance(hostMoref, options = {}) {
    await this._ensureLoggedIn();
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(String(hostMoref || ''))) {
      throw Object.assign(new Error('Invalid vSphere host reference'), { code: 'INVALID_PROVIDER_RESOURCE' });
    }
    const timeout = Math.min(86400, Math.max(60, Math.round(Number(options.timeoutSeconds) || 3600)));
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><ExitMaintenanceMode_Task xmlns="urn:vim25">
    <_this type="HostSystem">${this._xesc(hostMoref)}</_this><timeout>${timeout}</timeout>
  </ExitMaintenanceMode_Task></soap:Body>
</soap:Envelope>`;
    const taskRef = _extractTag(await this._soapPost(body), 'returnval');
    if (!taskRef) throw Object.assign(new Error('vSphere maintenance exit returned no task'), { code: 'INVALID_PROVIDER_TASK_RESPONSE' });
    return { taskRef, provider: 'vsphere', action: 'exit' };
  }

  async cancelTask(taskMoref) {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(String(taskMoref || ''))) {
      throw Object.assign(new Error('Invalid vSphere task reference'), { code: 'INVALID_PROVIDER_TASK' });
    }
    await this._ensureLoggedIn();
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><CancelTask xmlns="urn:vim25"><_this type="Task">${this._xesc(taskMoref)}</_this></CancelTask></soap:Body>
</soap:Envelope>`;
    await this._soapPost(body);
    return { ok: true };
  }

  async listVMSnapshots(vmMoref) {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(String(vmMoref || ''))) {
      throw Object.assign(new Error('Invalid vSphere VM reference'), { code: 'INVALID_PROVIDER_RESOURCE' });
    }
    await this._ensureLoggedIn();
    const raw = await this._retrievePropertiesDirect('VirtualMachine', vmMoref, ['snapshot']);
    return _parseSnapshotTree(raw);
  }

  async createVMSnapshot(vmMoref, options = {}) {
    await this._ensureLoggedIn();
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(String(vmMoref || ''))) {
      throw Object.assign(new Error('Invalid vSphere VM reference'), { code: 'INVALID_PROVIDER_RESOURCE' });
    }
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><CreateSnapshot_Task xmlns="urn:vim25">
    <_this type="VirtualMachine">${this._xesc(vmMoref)}</_this>
    <name>${this._xesc(options.name)}</name>
    <description>${this._xesc(options.description || '')}</description>
    <memory>false</memory><quiesce>${options.quiesce === true}</quiesce>
  </CreateSnapshot_Task></soap:Body>
</soap:Envelope>`;
    return this._snapshotTask(await this._soapPost(body));
  }

  async revertVMSnapshot(snapshotMoref) {
    await this._ensureLoggedIn();
    this._validateSnapshotRef(snapshotMoref);
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><RevertToSnapshot_Task xmlns="urn:vim25">
    <_this type="VirtualMachineSnapshot">${this._xesc(snapshotMoref)}</_this>
    <suppressPowerOn>true</suppressPowerOn>
  </RevertToSnapshot_Task></soap:Body>
</soap:Envelope>`;
    return this._snapshotTask(await this._soapPost(body));
  }

  async deleteVMSnapshot(snapshotMoref) {
    await this._ensureLoggedIn();
    this._validateSnapshotRef(snapshotMoref);
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><RemoveSnapshot_Task xmlns="urn:vim25">
    <_this type="VirtualMachineSnapshot">${this._xesc(snapshotMoref)}</_this>
    <removeChildren>false</removeChildren><consolidate>true</consolidate>
  </RemoveSnapshot_Task></soap:Body>
</soap:Envelope>`;
    return this._snapshotTask(await this._soapPost(body));
  }

  _validateSnapshotRef(value) {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(String(value || ''))) {
      throw Object.assign(new Error('Invalid vSphere snapshot reference'), { code: 'INVALID_PROVIDER_SNAPSHOT' });
    }
  }

  _snapshotTask(response) {
    const taskRef = _extractTag(response, 'returnval');
    if (!taskRef) throw Object.assign(new Error('vSphere snapshot operation returned no task'), { code: 'INVALID_PROVIDER_TASK_RESPONSE' });
    return { taskRef, provider: 'vsphere' };
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
      'summary.quickStats.uptime', 'runtime.bootTime', 'runtime.inMaintenanceMode',
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
        memoryFreeBytes: memBytes ? Math.max(0, memBytes - memUsedMB * 1024 * 1024) : null,
        memoryTotalMB: memTotalMB,
        memoryPercent: memTotalMB ? Math.round((memUsedMB / memTotalMB) * 100) : null,
        uptimeSeconds: parseInt(o.props['summary.quickStats.uptime'], 10) || null,
        bootTime: o.props['runtime.bootTime'] || null,
        maintenanceMode: o.props['runtime.inMaintenanceMode'] === 'true',
      };
    });
  }

  async listClusters(options = {}) {
    await this._ensureLoggedIn();
    const createViewBody = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body><CreateContainerView xmlns="urn:vim25">
    <_this type="${this._moRefs.viewManager.type}">${this._moRefs.viewManager.value}</_this>
    <container type="${this._moRefs.rootFolder.type}">${this._moRefs.rootFolder.value}</container>
    <type>ClusterComputeResource</type><recursive>true</recursive>
  </CreateContainerView></soap:Body>
</soap:Envelope>`;
    const viewId = _extractTag(await this._soapPost(createViewBody), 'returnval');
    if (!viewId) throw new Error('vSphere: cluster container view returned no ID');
    const properties = [
      'name', 'configurationEx.dasConfig', 'configurationEx.dasVmConfig',
      'summary.overallStatus', 'summary.numHosts', 'summary.numEffectiveHosts',
      'summary.totalMemory', 'summary.effectiveMemory', 'summary.currentFailoverLevel',
      'host', 'datastore',
    ];
    if (options.placement === true) properties.push('configurationEx.group', 'configurationEx.rule', 'drsRecommendation');
    const objects = _extractObjects(await this._retrieveProperties(viewId, 'ClusterComputeResource', properties));
    return objects.map(object => {
      const das = object.props['configurationEx.dasConfig'] || '';
      const groups = options.placement === true
        ? _parseClusterGroups(object.props['configurationEx.group'] || '') : [];
      return {
        moref: object.obj, id: object.obj, name: object.props.name || object.obj,
        haEnabled: _tagBool(das, 'enabled'),
        admissionControlEnabled: _tagBool(das, 'admissionControlEnabled'),
        hostMonitoring: _extractTag(das, 'hostMonitoring'),
        vmMonitoring: _extractTag(das, 'vmMonitoring'),
        vmComponentProtecting: _extractTag(das, 'vmComponentProtecting'),
        configuredFailoverLevel: _tagNumber(das, 'failoverLevel'),
        defaultRestartPriority: _extractTag(das, 'restartPriority') || 'medium',
        isolationResponse: _extractTag(das, 'isolationResponse'),
        heartbeatDatastoreRefs: _managedRefs(das, 'Datastore'),
        vmPriorities: _parseDasVmConfig(object.props['configurationEx.dasVmConfig'] || ''),
        ...(options.placement === true ? {
          groups,
          rules: _parseClusterRules(object.props['configurationEx.rule'] || '', groups),
          drsRecommendations: _parseDrsRecommendations(object.props.drsRecommendation || ''),
        } : {}),
        overallStatus: object.props['summary.overallStatus'] || null,
        hostCount: Number(object.props['summary.numHosts']) || 0,
        effectiveHostCount: Number(object.props['summary.numEffectiveHosts']) || 0,
        totalMemoryBytes: Number(object.props['summary.totalMemory']) || null,
        effectiveMemoryMB: Number(object.props['summary.effectiveMemory']) || null,
        currentFailoverLevel: _propertyNumber(object.props['summary.currentFailoverLevel']),
        hostRefs: _managedRefs(object.props.host, 'HostSystem'),
        datastoreRefs: _managedRefs(object.props.datastore, 'Datastore'),
        provider: 'vsphere',
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

  // ─── v8.9.13-alpha.1 — Networks / Services / Host Info ──────────

  /** List networks (standard port groups). Read-only. */
  async listNetworks() {
    await this._ensureLoggedIn();
    const createViewBody = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <CreateContainerView xmlns="urn:vim25">
      <_this type="${this._moRefs.viewManager.type}">${this._moRefs.viewManager.value}</_this>
      <container type="${this._moRefs.rootFolder.type}">${this._moRefs.rootFolder.value}</container>
      <type>Network</type>
      <recursive>true</recursive>
    </CreateContainerView>
  </soap:Body>
</soap:Envelope>`;
    const viewResp = await this._soapPost(createViewBody);
    const viewId = _extractTag(viewResp, 'returnval');
    if (!viewId) return [];
    const rawResp = await this._retrieveProperties(viewId, 'Network', ['name', 'summary.accessible']);
    return _extractObjects(rawResp).map(o => ({
      moref: o.obj,
      name: o.props['name'],
      accessible: o.props['summary.accessible'] === 'true',
    }));
  }

  /**
   * Host services (SSH, NTP, etc.) from config.service.service.
   * @param {string} hostMoref the HostSystem MoRef (from listHosts).
   */
  async getServices(hostMoref) {
    await this._ensureLoggedIn();
    const raw = await this._retrievePropertiesDirect('HostSystem', hostMoref, ['config.service.service']);
    const objs = _extractObjects(raw);
    const block = objs.length ? objs[0].props['config.service.service'] : '';
    if (!block) return [];
    const services = [];
    const re = /<HostService[^>]*>([\s\S]*?)<\/HostService>/g;
    let m;
    while ((m = re.exec(block))) {
      const s = m[1];
      services.push({
        key: _extractTag(s, 'key'),
        label: _extractTag(s, 'label'),
        running: _extractTag(s, 'running') === 'true',
        policy: _extractTag(s, 'policy'),
        required: _extractTag(s, 'required') === 'true',
      });
    }
    return services;
  }

  /**
   * Rich host info card data: DNS/NTP/BIOS/serial/vendor/boot time +
   * license. @param {string} hostMoref
   */
  async getHostInfo(hostMoref) {
    await this._ensureLoggedIn();
    const raw = await this._retrievePropertiesDirect('HostSystem', hostMoref, [
      'name', 'config.network.dnsConfig', 'config.dateTimeInfo.ntpConfig',
      'hardware.biosInfo', 'hardware.systemInfo', 'runtime.bootTime',
    ]);
    const objs = _extractObjects(raw);
    const p = objs.length ? objs[0].props : {};
    const dns = p['config.network.dnsConfig'] || '';
    const ntp = p['config.dateTimeInfo.ntpConfig'] || '';
    const bios = p['hardware.biosInfo'] || '';
    const sys = p['hardware.systemInfo'] || '';
    const dnsServers = [];
    { const re = /<address>([^<]+)<\/address>/g; let m; while ((m = re.exec(dns))) dnsServers.push(m[1]); }
    const ntpServers = [];
    { const re = /<server>([^<]+)<\/server>/g; let m; while ((m = re.exec(ntp))) ntpServers.push(m[1]); }

    // License (best-effort — may be denied on some ESXi).
    let license = null;
    try {
      const lm = this._moRefs.licenseManager;
      const licRaw = await this._retrievePropertiesDirect(lm.type, lm.value, ['licenses']);
      const licBlock = (_extractObjects(licRaw)[0] || { props: {} }).props['licenses'] || '';
      const m = /<LicenseManagerLicenseInfo[^>]*>([\s\S]*?)<\/LicenseManagerLicenseInfo>/.exec(licBlock);
      if (m) {
        const key = _extractTag(m[1], 'licenseKey') || '';
        const masked = key ? key.slice(0, -5).replace(/[A-Z0-9]/gi, 'X') + key.slice(-5) : null;
        license = { name: _extractTag(m[1], 'name'), key: masked };
      }
    } catch { /* license read denied — leave null */ }

    return {
      name: p['name'] || _extractTag(dns, 'hostName'),
      hostName: _extractTag(dns, 'hostName'),
      domainName: _extractTag(dns, 'domainName'),
      dnsServers, ntpServers,
      biosVersion: _extractTag(bios, 'biosVersion'),
      biosReleaseDate: _extractTag(bios, 'releaseDate'),
      vendor: _extractTag(sys, 'vendor'),
      model: _extractTag(sys, 'model'),
      serialNumber: _extractTag(sys, 'serialNumber'),
      bootTime: p['runtime.bootTime'] || null,
      license,
    };
  }

  // ─── v8.9.14-alpha.1 — Datastore browse + download ─────────────

  /** Resolve a datastore's HostDatastoreBrowser MoRef. */
  async _getDatastoreBrowser(dsMoref) {
    const raw = await this._retrievePropertiesDirect('Datastore', dsMoref, ['browser']);
    const objs = _extractObjects(raw);
    return objs.length ? (objs[0].props['browser'] || '').trim() : '';
  }

  /**
   * List files + folders in a datastore folder via HostDatastoreBrowser.
   * @param {string} dsName datastore name (e.g. "datastore1")
   * @param {string} folderPath relative folder inside the datastore ("" = root)
   */
  async browseDatastore(dsName, folderPath = '') {
    await this._ensureLoggedIn();
    const datastores = await this.listDatastores();
    const ds = datastores.find(d => d.name === dsName);
    if (!ds) throw new Error(`Datastore not found: ${dsName}`);
    const browser = await this._getDatastoreBrowser(ds.moref);
    if (!browser) throw new Error('Datastore browser unavailable on this host');
    const dsPath = `[${dsName}]${folderPath ? ' ' + folderPath : ''}`;
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <SearchDatastore_Task xmlns="urn:vim25">
      <_this type="HostDatastoreBrowser">${browser}</_this>
      <datastorePath>${this._xesc(dsPath)}</datastorePath>
      <searchSpec>
        <details>
          <fileType>true</fileType>
          <fileSize>true</fileSize>
          <modification>true</modification>
          <fileOwner>false</fileOwner>
        </details>
        <sortFoldersFirst>true</sortFoldersFirst>
      </searchSpec>
    </SearchDatastore_Task>
  </soap:Body>
</soap:Envelope>`;
    const resp = await this._soapPost(body);
    const taskMoref = _extractTag(resp, 'returnval');
    if (!taskMoref) throw new Error('SearchDatastore_Task returned no task');
    const result = await this._waitForTask(taskMoref, 30_000);
    return _parseSearchResults(result, dsName, folderPath);
  }

  /** Poll a Task MoRef until success/error. Returns info.result XML. */
  async _waitForTask(taskMoref, timeoutMs = 30_000) {
    const start = Date.now();
    // Date.now() is fine at runtime (only banned inside Workflow scripts).
    while (Date.now() - start < timeoutMs) {
      const raw = await this._retrievePropertiesDirect('Task', taskMoref,
        ['info.state', 'info.result', 'info.error']);
      const p = (_extractObjects(raw)[0] || { props: {} }).props;
      const state = p['info.state'];
      if (state === 'success') return p['info.result'] || '';
      if (state === 'error') {
        throw new Error(`vSphere task failed: ${_extractFault(p['info.error'] || '') || 'unknown'}`);
      }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('vSphere task timed out');
  }

  /**
   * Open an HTTPS GET stream to a datastore file (the /folder file API).
   * Resolves { stream, contentLength, contentType, status }. The caller pipes
   * `stream` to the client. dcPath defaults to ha-datacenter (standalone ESXi).
   */
  async datastoreDownload(dsName, filePath, dcPath = 'ha-datacenter') {
    await this._ensureLoggedIn();
    const encPath = String(filePath).split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const url = new URL(`/folder/${encPath}`, this._config.endpoint);
    url.searchParams.set('dsName', dsName);
    url.searchParams.set('dcPath', dcPath);
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname, port: url.port || 443, method: 'GET',
        path: url.pathname + url.search,
        headers: { Cookie: this._sessionCookie || '' },
        agent: this._agent,
      }, (res) => {
        if (res.statusCode >= 400) {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => reject(Object.assign(
            new Error(`Datastore download failed: HTTP ${res.statusCode}`),
            { status: res.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, 300) })));
          return;
        }
        resolve({
          stream: res, status: res.statusCode,
          contentLength: res.headers['content-length'] || null,
          contentType: res.headers['content-type'] || 'application/octet-stream',
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  // ─── v8.9.14-alpha.2 — Datastore upload/delete + service control ──
  // WRITE operations. Callers must gate admin + audit at the route layer.

  /**
   * Stream-upload a file to a datastore via HTTPS PUT (/folder API).
   * @param {string} dsName
   * @param {string} filePath  relative path inside the datastore
   * @param {stream.Readable} bodyStream  the incoming request body
   * @param {number|string} contentLength  optional; enables PUT w/o chunking
   */
  async datastoreUpload(dsName, filePath, bodyStream, contentLength, dcPath = 'ha-datacenter') {
    await this._ensureLoggedIn();
    const encPath = String(filePath).split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const url = new URL(`/folder/${encPath}`, this._config.endpoint);
    url.searchParams.set('dsName', dsName);
    url.searchParams.set('dcPath', dcPath);
    const headers = { Cookie: this._sessionCookie || '', 'Content-Type': 'application/octet-stream' };
    if (contentLength) headers['Content-Length'] = contentLength;
    else headers['Transfer-Encoding'] = 'chunked';
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname, port: url.port || 443, method: 'PUT',
        path: url.pathname + url.search, headers, agent: this._agent,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            return reject(Object.assign(new Error(`Datastore upload failed: HTTP ${res.statusCode}`),
              { status: res.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, 300) }));
          }
          resolve({ ok: true, status: res.statusCode });
        });
      });
      req.on('error', reject);
      bodyStream.on('error', (e) => { try { req.destroy(); } catch { /* ignore */ } reject(e); });
      bodyStream.pipe(req);
    });
  }

  /** Delete a datastore file/folder via FileManager.DeleteDatastoreFile_Task. */
  async deleteDatastoreFile(dsName, filePath, dcPath = 'ha-datacenter') {
    await this._ensureLoggedIn();
    const fm = this._moRefs.fileManager;
    const dsPath = `[${dsName}] ${filePath}`;
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <DeleteDatastoreFile_Task xmlns="urn:vim25">
      <_this type="${fm.type}">${fm.value}</_this>
      <name>${this._xesc(dsPath)}</name>
      <datacenter type="Datacenter">${this._xesc(dcPath)}</datacenter>
    </DeleteDatastoreFile_Task>
  </soap:Body>
</soap:Envelope>`;
    // ESXi standalone has no Datacenter MoRef; DeleteDatastoreFile_Task there
    // accepts the call without <datacenter> on some builds. Try with, and if
    // it faults on the datacenter arg, retry without it.
    let taskMoref;
    try {
      const resp = await this._soapPost(body);
      taskMoref = _extractTag(resp, 'returnval');
    } catch (err) {
      const bodyNoDc = body.replace(/<datacenter[^>]*>[\s\S]*?<\/datacenter>/, '');
      const resp = await this._soapPost(bodyNoDc);
      taskMoref = _extractTag(resp, 'returnval');
    }
    if (!taskMoref) throw new Error('DeleteDatastoreFile_Task returned no task');
    await this._waitForTask(taskMoref, 30_000);
    return { ok: true };
  }

  /** Resolve a host's HostServiceSystem MoRef (configManager.serviceSystem). */
  async _getServiceSystem(hostMoref) {
    const raw = await this._retrievePropertiesDirect('HostSystem', hostMoref, ['configManager.serviceSystem']);
    const objs = _extractObjects(raw);
    return objs.length ? (objs[0].props['configManager.serviceSystem'] || '').trim() : '';
  }

  /**
   * Start / stop / restart a host service.
   * @param {string} hostMoref
   * @param {string} serviceKey  e.g. "TSM-SSH", "ntpd"
   * @param {'start'|'stop'|'restart'} action
   */
  async hostServiceAction(hostMoref, serviceKey, action) {
    await this._ensureLoggedIn();
    const op = { start: 'StartService', stop: 'StopService', restart: 'RestartService' }[action];
    if (!op) throw new Error(`invalid service action: ${action}`);
    if (!/^[A-Za-z0-9._-]+$/.test(serviceKey)) throw new Error('invalid service key');
    const ss = await this._getServiceSystem(hostMoref);
    if (!ss) throw new Error('HostServiceSystem unavailable on this host');
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <${op} xmlns="urn:vim25">
      <_this type="HostServiceSystem">${ss}</_this>
      <id>${this._xesc(serviceKey)}</id>
    </${op}>
  </soap:Body>
</soap:Envelope>`;
    await this._soapPost(body);   // synchronous op; faults throw
    return { ok: true, action, serviceKey };
  }

  async _ensureLoggedIn() {
    if (!this._sessionCookie) await this.login();
  }

  /** RetrievePropertiesEx against a SPECIFIC managed object (no ContainerView
   *  traversal) — used for per-host detail + LicenseManager. */
  async _retrievePropertiesDirect(objType, objMoref, propPaths) {
    const pathSetTags = propPaths.map(p => `<pathSet>${p}</pathSet>`).join('');
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <RetrievePropertiesEx xmlns="urn:vim25">
      <_this type="${this._moRefs.propertyCollector.type}">${this._moRefs.propertyCollector.value}</_this>
      <specSet>
        <propSet>
          <type>${objType}</type>
          ${pathSetTags}
        </propSet>
        <objectSet>
          <obj type="${objType}">${objMoref}</obj>
        </objectSet>
      </specSet>
      <options/>
    </RetrievePropertiesEx>
  </soap:Body>
</soap:Envelope>`;
    return await this._soapPost(body);
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

// v8.9.14-alpha.1 — parse HostDatastoreBrowserSearchResults into a file list.
// Each <file xsi:type="FolderFileInfo|...FileInfo"> has path/fileSize/modification.
function _parseSearchResults(xml, dsName, folderPath) {
  const entries = [];
  const re = /<file\b[^>]*?\btype="([^"]+)"[^>]*>([\s\S]*?)<\/file>/g;
  let m;
  while ((m = re.exec(xml))) {
    const type = m[1];
    const block = m[2];
    const name = _extractTag(block, 'path');
    if (!name) continue;
    entries.push({
      name,
      isFolder: /Folder/i.test(type),
      fileSize: parseInt(_extractTag(block, 'fileSize'), 10) || null,
      modified: _extractTag(block, 'modification') || null,
      fileType: type,
    });
  }
  // Folders first, then files, alphabetical.
  entries.sort((a, b) => (b.isFolder - a.isFolder) || String(a.name).localeCompare(String(b.name)));
  return { datastore: dsName, folderPath: folderPath || '', entries };
}

function _parseRecursiveSearchResults(xml, dsName) {
  const blocks = [];
  const re = /<HostDatastoreBrowserSearchResults[^>]*>([\s\S]*?)<\/HostDatastoreBrowserSearchResults>/g;
  let match;
  while ((match = re.exec(xml || ''))) blocks.push(match[1]);
  if (!blocks.length) blocks.push(xml || '');
  const output = [];
  for (const block of blocks) {
    const rawFolder = _extractTag(block, 'folderPath') || '';
    const folder = rawFolder.replace(new RegExp(`^\\[${String(dsName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\s*`), '').replace(/^\/+|\/+$/g, '');
    const result = _parseSearchResults(block, dsName, folder);
    for (const entry of result.entries.filter(item => !item.isFolder)) {
      const relative = [folder, entry.name].filter(Boolean).join('/');
      output.push({ ...entry, folderPath: folder, datastorePath: `[${dsName}] ${relative}` });
    }
  }
  return output;
}

// v8.9.13-alpha.3 — parse storage.perDatastoreUsage into
// [{ datastore: moref, committed }]. Each entry is a
// <VirtualMachineUsageOnDatastore> with <datastore> + <committed>.
function _parseDatastoreUsage(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<VirtualMachineUsageOnDatastore[^>]*>([\s\S]*?)<\/VirtualMachineUsageOnDatastore>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const dsMatch = /<datastore[^>]*>([^<]+)<\/datastore>/.exec(block);
    const committed = parseInt(_extractTag(block, 'committed'), 10) || 0;
    if (dsMatch) out.push({ datastore: dsMatch[1].trim(), committed });
  }
  return out;
}

function _parseSnapshotTree(xml) {
  const current = /<currentSnapshot\b[^>]*>([^<]+)<\/currentSnapshot>/.exec(xml)?.[1]?.trim() || null;
  const output = [];
  const stack = [];
  const token = /<(\/)?(rootSnapshotList|childSnapshotList)\b[^>]*>/g;
  let match;
  while ((match = token.exec(xml))) {
    if (!match[1]) {
      const closing = `</${match[2]}>`;
      const childAt = xml.indexOf('<childSnapshotList', token.lastIndex);
      const closeAt = xml.indexOf(closing, token.lastIndex);
      const headerEnd = childAt >= 0 && childAt < closeAt ? childAt : closeAt;
      const header = headerEnd >= token.lastIndex ? xml.slice(token.lastIndex, headerEnd) : '';
      const ref = /<snapshot\b[^>]*>([^<]+)<\/snapshot>/.exec(header)?.[1]?.trim() || null;
      const parent = stack.length ? stack[stack.length - 1].ref : null;
      const quiesced = _extractTag(header, 'quiesced');
      const item = ref ? {
        nativeRef: _decodeEntities(ref), name: _extractTag(header, 'name') || ref,
        description: _extractTag(header, 'description'), createdAt: _extractTag(header, 'createTime'),
        parentRef: parent, isCurrent: ref === current,
        consistency: quiesced === 'true' ? 'quiesced' : quiesced === 'false' ? 'crash' : 'unknown',
        powerState: _extractTag(header, 'state') || null, provider: 'vsphere',
      } : null;
      if (item) output.push(item);
      stack.push({ tag: match[2], ref });
    } else {
      const opened = stack.pop();
      if (!opened || opened.tag !== match[2]) return [];
    }
  }
  return stack.length ? [] : output;
}

function _parseDasVmConfig(xml) {
  const priorities = {};
  const blocks = String(xml || '').match(/<(?:\w+:)?ClusterDasVmConfigInfo\b[^>]*>[\s\S]*?<\/(?:\w+:)?ClusterDasVmConfigInfo>/g) || [];
  for (const block of blocks.slice(0, 5000)) {
    const vmRef = _typedTagRef(block, 'key', 'VirtualMachine');
    if (!vmRef) continue;
    priorities[vmRef] = {
      restartPriority: _extractTag(block, 'restartPriority') || null,
      isolationResponse: _extractTag(block, 'isolationResponse') || null,
    };
  }
  return priorities;
}

function _elementBlocks(xml, localNames) {
  const output = [];
  const input = String(xml || '');
  for (const name of localNames) {
    const re = new RegExp(`<(?:\\w+:)?${name}\\b([^>]*)>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, 'g');
    let match;
    while ((match = re.exec(input))) {
      const type = /(?:xsi:)?type="([^"]+)"/.exec(match[1])?.[1]?.split(':').pop() || name;
      output.push({ type, body: match[2], attrs: match[1] });
    }
  }
  return output;
}

function _typedRefs(xml, tagName, expectedType) {
  const values = [];
  const re = new RegExp(`<(?:\\w+:)?${tagName}\\b([^>]*)>([^<]+)<\\/(?:\\w+:)?${tagName}>`, 'g');
  let match;
  while ((match = re.exec(String(xml || '')))) {
    const type = /(?:xsi:)?type="([^"]+)"/.exec(match[1])?.[1]?.split(':').pop();
    if (!expectedType || !type || type === expectedType) values.push(_decodeEntities(match[2].trim()));
  }
  return [...new Set(values.filter(Boolean))];
}

function _parseClusterGroups(xml) {
  const blocks = _elementBlocks(xml, ['ClusterGroupInfo', 'ClusterVmGroup', 'ClusterHostGroup']);
  return blocks.slice(0, 500).map((item, index) => ({
    nativeId: _extractTag(item.body, 'name') || `group-${index}`,
    name: _extractTag(item.body, 'name') || `Group ${index + 1}`,
    type: item.type === 'ClusterHostGroup' ? 'host' : 'vm',
    refs: item.type === 'ClusterHostGroup'
      ? _typedRefs(item.body, 'host', 'HostSystem') : _typedRefs(item.body, 'vm', 'VirtualMachine'),
  }));
}

function _parseClusterRules(xml, groups = []) {
  const groupByName = new Map(groups.map(group => [group.name, group]));
  const blocks = _elementBlocks(xml, [
    'ClusterRuleInfo', 'ClusterAffinityRuleSpec', 'ClusterAntiAffinityRuleSpec', 'ClusterVmHostRuleInfo',
  ]);
  const output = [];
  for (const [index, item] of blocks.slice(0, 500).entries()) {
    const base = {
      nativeId: _extractTag(item.body, 'key') || _extractTag(item.body, 'name') || `rule-${index}`,
      name: _extractTag(item.body, 'name') || `DRS rule ${index + 1}`,
      enabled: _tagBool(item.body, 'enabled') !== false,
      mandatory: _tagBool(item.body, 'mandatory') === true,
      source: 'vsphere-drs',
    };
    if (item.type === 'ClusterAffinityRuleSpec' || item.type === 'ClusterAntiAffinityRuleSpec') {
      output.push({
        ...base,
        kind: item.type === 'ClusterAntiAffinityRuleSpec' ? 'vm-anti-affinity' : 'vm-affinity',
        vmRefs: _typedRefs(item.body, 'vm', 'VirtualMachine'), hostRefs: [],
      });
      continue;
    }
    const vmGroup = groupByName.get(_extractTag(item.body, 'vmGroupName'));
    const affine = groupByName.get(_extractTag(item.body, 'affineHostGroupName'));
    const anti = groupByName.get(_extractTag(item.body, 'antiAffineHostGroupName'));
    if (affine) output.push({ ...base, nativeId: `${base.nativeId}:affine`, kind: 'vm-host-affinity', vmRefs: vmGroup?.refs || [], hostRefs: affine.refs || [] });
    if (anti) output.push({ ...base, nativeId: `${base.nativeId}:anti`, kind: 'vm-host-anti-affinity', vmRefs: vmGroup?.refs || [], hostRefs: anti.refs || [] });
  }
  return output.slice(0, 500);
}

function _parseDrsRecommendations(xml) {
  return _elementBlocks(xml, ['ClusterRecommendation', 'Recommendation']).slice(0, 500).map((item, index) => ({
    nativeId: _extractTag(item.body, 'key') || `recommendation-${index}`,
    rating: _tagNumber(item.body, 'rating'),
    reason: _extractTag(item.body, 'reason') || 'vCenter DRS recommendation',
    createdAt: _extractTag(item.body, 'time'),
    vmRefs: _typedRefs(item.body, 'vm', 'VirtualMachine'),
    hostRefs: [..._typedRefs(item.body, 'target', 'HostSystem'), ..._typedRefs(item.body, 'host', 'HostSystem')],
    source: 'vsphere-drs',
  }));
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

function _allTags(xml, tagName) {
  const values = [];
  const re = new RegExp(`<(?:\\w+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tagName}>`, 'g');
  let match;
  while ((match = re.exec(String(xml || '')))) values.push(_decodeEntities(match[1].replace(/<[^>]+>/g, '').trim()));
  return values.filter(Boolean);
}

function _tagBool(xml, name) {
  const value = _extractTag(String(xml || ''), name);
  return value === 'true' ? true : value === 'false' ? false : null;
}

function _tagNumber(xml, name) {
  const raw = _extractTag(String(xml || ''), name);
  if (raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function _propertyNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function _typedTagRef(xml, tagName, expectedType) {
  const match = new RegExp(`<(?:\\w+:)?${tagName}\\b[^>]*\\btype="${expectedType}"[^>]*>([^<]+)<\\/(?:\\w+:)?${tagName}>`)
    .exec(String(xml || ''));
  return match ? _decodeEntities(match[1].trim()) : null;
}

function _virtualDeviceBlocks(xml) {
  const output = [];
  const re = /<((?:[\w.-]+:)?(?:VirtualDevice|device))\b([^>]*)>([\s\S]*?)<\/\1>/g;
  let match;
  while ((match = re.exec(String(xml || '')))) {
    const type = /(?:xsi:)?type="([^"]+)"/.exec(match[2])?.[1] || '';
    output.push({ type: type.split(':').pop(), xml: match[3] });
  }
  return output;
}

function _guestNicRows(xml) {
  const rows = [];
  const re = /<(?:\w+:)?GuestNicInfo\b[^>]*>([\s\S]*?)<\/(?:\w+:)?GuestNicInfo>/g;
  let match;
  while ((match = re.exec(String(xml || '')))) {
    const block = match[1];
    const addresses = _allTags(block, 'ipAddress').filter(address => /^[0-9a-f:.]+$/i.test(address))
      .map(address => ({ address, source: 'vmware-tools' }));
    rows.push({
      macAddress: _extractTag(block, 'macAddress'), network: _extractTag(block, 'network'),
      connected: _tagBool(block, 'connected'), addresses,
    });
  }
  return rows;
}

function _parseVmHardware(deviceXml, guestNetXml) {
  const blocks = _virtualDeviceBlocks(deviceXml);
  const controllers = new Map();
  for (const item of blocks.filter(item => /Controller$/.test(item.type))) {
    const key = _tagNumber(item.xml, 'key');
    if (key !== null) controllers.set(key, {
      bus: item.type.replace(/^Virtual/, '').replace(/Controller$/, '').toLowerCase(),
      busNumber: _tagNumber(item.xml, 'busNumber'),
    });
  }
  const guestByMac = new Map(_guestNicRows(guestNetXml).map(item => [
    String(item.macAddress || '').replace(/[^a-f0-9]/gi, '').toUpperCase(), item,
  ]));
  const disks = [];
  const nics = [];
  for (const item of blocks) {
    const key = _tagNumber(item.xml, 'key');
    const controllerKey = _tagNumber(item.xml, 'controllerKey');
    const controller = controllers.get(controllerKey) || {};
    const unit = _tagNumber(item.xml, 'unitNumber');
    const label = _extractTag(item.xml, 'label');
    if (item.type === 'VirtualDisk' || item.type === 'VirtualCdrom') {
      const capacityInBytes = _tagNumber(item.xml, 'capacityInBytes');
      const capacityInKB = _tagNumber(item.xml, 'capacityInKB');
      const fileName = _extractTag(item.xml, 'fileName');
      const datastores = _managedRefs(item.xml, 'Datastore');
      const datastoreRef = datastores[0] || _typedTagRef(item.xml, 'datastore', 'Datastore');
      const thin = _tagBool(item.xml, 'thinProvisioned');
      const eager = _tagBool(item.xml, 'eagerlyScrub');
      const isCdrom = item.type === 'VirtualCdrom';
      disks.push({
        nativeRef: key, label, type: isCdrom ? 'cdrom' : 'disk',
        device: label, bus: controller.bus || null, unit,
        capacityBytes: capacityInBytes ?? (capacityInKB === null ? null : capacityInKB * 1024),
        provisioning: isCdrom ? 'unknown' : (thin === true ? 'thin' : (eager === true ? 'eagerZeroedThick' : (thin === false ? 'thick' : 'unknown'))),
        format: isCdrom ? 'iso' : null,
        backing: {
          type: fileName ? 'datastore-file' : 'device', storageId: datastoreRef,
          storageName: /^\[([^\]]+)\]/.exec(fileName || '')?.[1] || null, path: fileName,
        },
        attachment: {
          connected: _tagBool(item.xml, 'connected'), startConnected: _tagBool(item.xml, 'startConnected'),
          bootable: null, readOnly: isCdrom,
          shared: (() => { const sharing = _extractTag(item.xml, 'sharing'); return sharing ? /sharingMultiWriter/i.test(sharing) : null; })(),
        },
        capabilities: { hotPlug: null, hotUnplug: null, onlineResize: isCdrom ? false : null },
        status: _extractTag(item.xml, 'status') || 'configured',
      });
    } else if (/Virtual(?:Vmxnet|E1000|PCNet|Sriov|Ethernet)/i.test(item.type)) {
      const macAddress = _extractTag(item.xml, 'macAddress');
      const guest = guestByMac.get(String(macAddress || '').replace(/[^a-f0-9]/gi, '').toUpperCase());
      const networkRefs = _managedRefs(item.xml, 'Network');
      const networkRef = networkRefs[0] || _typedTagRef(item.xml, 'network', 'Network');
      const portgroup = _extractTag(item.xml, 'portgroupKey');
      const switchUuid = _extractTag(item.xml, 'switchUuid');
      const connectable = /<(?:\w+:)?connectable\b/.test(item.xml);
      nics.push({
        nativeRef: key, label, device: label, model: item.type.replace(/^Virtual/, ''), macAddress,
        network: {
          id: portgroup || networkRef,
          name: guest?.network || _extractTag(item.xml, 'deviceName'), bridge: null,
          distributedSwitch: switchUuid, vlanId: null,
        },
        addresses: guest?.addresses || [], mtu: null,
        attachment: {
          connected: guest?.connected ?? _tagBool(item.xml, 'connected'),
          startConnected: _tagBool(item.xml, 'startConnected'),
        },
        security: {}, qos: {
          reservationMbps: (() => { const value = _tagNumber(item.xml, 'reservation'); return value === null ? null : value / 1000; })(),
          rateLimitMbps: (() => { const value = _tagNumber(item.xml, 'limit'); return value === null || value < 0 ? null : value / 1000; })(),
        },
        capabilities: { hotPlug: null, hotUnplug: null, connectDisconnect: connectable ? true : null },
        status: guest?.connected === false ? 'disconnected' : (_extractTag(item.xml, 'status') || 'configured'),
      });
    }
  }
  return {
    disks, nics, diskAvailable: !!deviceXml, nicAvailable: !!deviceXml,
    diskReason: deviceXml ? null : 'vSphere returned no virtual-device configuration',
    nicReason: deviceXml ? null : 'vSphere returned no virtual-device configuration',
  };
}

function _parseVmotionCompatibility(xml) {
  const output = [];
  const re = /<(?:\w+:)?returnval\b[^>]*>([\s\S]*?)<\/(?:\w+:)?returnval>/g;
  let match;
  while ((match = re.exec(String(xml || '')))) {
    const block = match[1];
    const hostRef = _typedTagRef(block, 'host', 'HostSystem');
    if (!hostRef) continue;
    output.push({ hostRef, compatibility: _allTags(block, 'compatibility').map(value => value.toLowerCase()) });
  }
  return output;
}

function _managedRefs(value, expectedType) {
  const input = String(value || '');
  const output = [];
  const re = /<(?:ManagedObjectReference|[^>:\s]+:ManagedObjectReference)\b[^>]*\btype="([^"]+)"[^>]*>([^<]+)<\/(?:ManagedObjectReference|[^>:\s]+:ManagedObjectReference)>/g;
  let match;
  while ((match = re.exec(input))) if (!expectedType || match[1] === expectedType) output.push(_decodeEntities(match[2].trim()));
  if (!output.length && /^[A-Za-z0-9._:-]{1,160}$/.test(input)) output.push(input);
  return [...new Set(output)];
}

function _firstManagedRef(value, expectedType) { return _managedRefs(value, expectedType)[0] || null; }

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
  _internals: { _extractTag, _extractFault, _extractObjects, _decodeEntities, _extractMoRef, _managedRefs, _firstManagedRef, _parseSearchResults, _parseRecursiveSearchResults, _parseDatastoreUsage, _parseSnapshotTree, _parseDasVmConfig, _parseClusterGroups, _parseClusterRules, _parseDrsRecommendations, _elementBlocks, _typedRefs, _propertyNumber, _allTags, _typedTagRef, _virtualDeviceBlocks, _guestNicRows, _parseVmHardware, _parseVmotionCompatibility },
};

if (false) log.info();
