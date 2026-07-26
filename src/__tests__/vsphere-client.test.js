'use strict';

// v8.9.11-alpha.1 — vSphere SOAP client tests.

process.env.APP_SECRET = 'test-vsphere';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

// Mock https so tests don't hit a real endpoint.
const mockHttps = {
  _handlers: [],
  _mockNext(handler) { this._handlers.push(handler); },
  Agent: function Agent(_opts) { this._mockAgent = true; },
  request(opts, cb) {
    const handler = this._handlers.shift();
    if (!handler) throw new Error('mockHttps: no queued handler');
    const req = {
      _opts: opts,
      _writtenBody: null,
      write(buf) { this._writtenBody = buf; },
      end() { setImmediate(() => handler(opts, cb, this)); },
      on() { /* mock */ },
      destroy() { /* mock */ },
    };
    return req;
  },
};
jest.mock('https', () => mockHttps);

const {
  VSphereClient, fromHostRow, encryptDaemonConfig, decryptDaemonConfig, _internals,
} = require('../services/vsphere');

function fakeResponse({ status = 200, body = '', setCookie = null }) {
  const bufChunks = body ? [Buffer.from(body)] : [];
  const listeners = {};
  return {
    statusCode: status,
    headers: setCookie ? { 'set-cookie': [setCookie] } : {},
    on(event, fn) { listeners[event] = fn; },
    _fire() {
      if (bufChunks.length && listeners.data) listeners.data(bufChunks[0]);
      if (listeners.end) listeners.end();
    },
  };
}

describe('VSphereClient (v8.9.11-alpha.1)', () => {
  beforeEach(() => { mockHttps._handlers.length = 0; });

  describe('constructor', () => {
    it('rejects missing config', () => {
      expect(() => new VSphereClient(null)).toThrow(/config required/);
    });
    it('rejects missing endpoint', () => {
      expect(() => new VSphereClient({ username: 'x', password: 'y' })).toThrow(/endpoint required/);
    });
    it('rejects missing username or password', () => {
      expect(() => new VSphereClient({ endpoint: 'https://e' })).toThrow(/username/);
      expect(() => new VSphereClient({ endpoint: 'https://e', username: 'a' })).toThrow(/password/);
    });
    it('accepts a full config', () => {
      expect(() => new VSphereClient({ endpoint: 'https://esxi', username: 'root', password: 'x' })).not.toThrow();
    });
    it('exposes daemonType', () => {
      const c = new VSphereClient({ endpoint: 'https://e', username: 'a', password: 'b' });
      expect(c.daemonType).toBe('vsphere');
    });
  });

  describe('daemon_config encryption', () => {
    it('round-trips', () => {
      const cfg = {
        endpoint: 'https://esxi.example.com',
        username: 'root',
        password: 'SECRET-PASSWORD-123',
        skipTlsVerify: true,
      };
      const enc = encryptDaemonConfig(cfg);
      expect(enc).toMatch(/^enc:/);
      expect(enc).not.toContain('SECRET-PASSWORD');
      expect(decryptDaemonConfig(enc)).toEqual(cfg);
    });
  });

  describe('fromHostRow', () => {
    it('rejects a non-vsphere row', () => {
      expect(() => fromHostRow({ daemon_type: 'docker' })).toThrow(/not a vSphere/);
    });
    it('accepts a vsphere row with encrypted config', () => {
      const enc = encryptDaemonConfig({ endpoint: 'https://esxi', username: 'root', password: 'x' });
      const client = fromHostRow({ daemon_type: 'vsphere', daemon_config: enc });
      expect(client).toBeInstanceOf(VSphereClient);
    });
  });

  describe('host maintenance tasks', () => {
    it('submits bounded Enter/ExitMaintenanceMode tasks with safe host references', async () => {
      const client = new VSphereClient({ endpoint: 'https://vc', username: 'svc', password: 'secret' });
      client._sessionCookie = 'vmware_soap_session=test';
      client._soapPost = jest.fn(async () => '<returnval type="Task">task-42</returnval>');
      await expect(client.enterHostMaintenance('host-12', { timeoutSeconds: 7200 }))
        .resolves.toEqual({ taskRef: 'task-42', provider: 'vsphere', action: 'enter' });
      expect(client._soapPost.mock.calls[0][0]).toContain('<EnterMaintenanceMode_Task');
      expect(client._soapPost.mock.calls[0][0]).toContain('<timeout>7200</timeout>');
      expect(client._soapPost.mock.calls[0][0]).toContain('<evacuatePoweredOffVms>false</evacuatePoweredOffVms>');
      await expect(client.exitHostMaintenance('host-12', { timeoutSeconds: 60 }))
        .resolves.toEqual({ taskRef: 'task-42', provider: 'vsphere', action: 'exit' });
      expect(client._soapPost.mock.calls[1][0]).toContain('<ExitMaintenanceMode_Task');
      await expect(client.enterHostMaintenance('host/<unsafe>')).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESOURCE' });
    });
  });

  describe('XML parsing helpers', () => {
    it('extractTag pulls simple text values', () => {
      const xml = '<envelope><foo>bar</foo><nested><baz>qux</baz></nested></envelope>';
      expect(_internals._extractTag(xml, 'foo')).toBe('bar');
      expect(_internals._extractTag(xml, 'baz')).toBe('qux');
    });

    it('extractTag decodes entities', () => {
      const xml = '<name>&lt;html&gt;</name>';
      expect(_internals._extractTag(xml, 'name')).toBe('<html>');
    });

    it('extractFault surfaces localizedMessage', () => {
      const xml = '<Fault><localizedMessage>invalid login</localizedMessage></Fault>';
      expect(_internals._extractFault(xml)).toBe('invalid login');
    });

    it('extractMoRef parses a managed-object reference with type + value', () => {
      const xml = '<returnval>' +
        '<sessionManager type="SessionManager">ha-sessionmgr</sessionManager>' +
        '<rootFolder type="Folder">ha-folder-root</rootFolder>' +
        '</returnval>';
      expect(_internals._extractMoRef(xml, 'sessionManager')).toEqual({ type: 'SessionManager', value: 'ha-sessionmgr' });
      expect(_internals._extractMoRef(xml, 'rootFolder')).toEqual({ type: 'Folder', value: 'ha-folder-root' });
      expect(_internals._extractMoRef(xml, 'viewManager')).toBeNull();
    });

    it('extractMoRef tolerates a namespace prefix', () => {
      const xml = '<vim25:sessionManager type="SessionManager">SessionManager</vim25:sessionManager>';
      expect(_internals._extractMoRef(xml, 'sessionManager')).toEqual({ type: 'SessionManager', value: 'SessionManager' });
    });

    it('extracts managed references from property collector values', () => {
      expect(_internals._managedRefs('<ManagedObjectReference type="Datastore">datastore-4</ManagedObjectReference>', 'Datastore'))
        .toEqual(['datastore-4']);
      expect(_internals._firstManagedRef('group-v3', 'Folder')).toBe('group-v3');
    });

    it('parses DRS groups, mandatory rules and native recommendations', () => {
      const groups = _internals._parseClusterGroups(`<ArrayOfClusterGroupInfo>
        <ClusterGroupInfo xsi:type="ClusterVmGroup"><name>apps</name><vm type="VirtualMachine">vm-1</vm><vm type="VirtualMachine">vm-2</vm></ClusterGroupInfo>
        <ClusterGroupInfo xsi:type="ClusterHostGroup"><name>gold</name><host type="HostSystem">host-1</host></ClusterGroupInfo>
      </ArrayOfClusterGroupInfo>`);
      expect(groups).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'apps', type: 'vm', refs: ['vm-1', 'vm-2'] }),
        expect.objectContaining({ name: 'gold', type: 'host', refs: ['host-1'] }),
      ]));
      const rules = _internals._parseClusterRules(`<ArrayOfClusterRuleInfo>
        <ClusterRuleInfo xsi:type="ClusterAntiAffinityRuleSpec"><key>11</key><name>spread</name><enabled>true</enabled><mandatory>true</mandatory><vm type="VirtualMachine">vm-1</vm><vm type="VirtualMachine">vm-2</vm></ClusterRuleInfo>
        <ClusterRuleInfo xsi:type="ClusterVmHostRuleInfo"><key>12</key><name>gold-only</name><enabled>true</enabled><mandatory>false</mandatory><vmGroupName>apps</vmGroupName><affineHostGroupName>gold</affineHostGroupName></ClusterRuleInfo>
      </ArrayOfClusterRuleInfo>`, groups);
      expect(rules).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'vm-anti-affinity', mandatory: true, vmRefs: ['vm-1', 'vm-2'] }),
        expect.objectContaining({ kind: 'vm-host-affinity', mandatory: false, hostRefs: ['host-1'] }),
      ]));
      expect(_internals._parseDrsRecommendations(`<ArrayOfClusterRecommendation><ClusterRecommendation>
        <key>r-1</key><rating>4</rating><reason>&lt;balance&gt;</reason><time>2026-07-26T12:00:00Z</time>
        <vm type="VirtualMachine">vm-1</vm><target type="HostSystem">host-1</target>
      </ClusterRecommendation></ArrayOfClusterRecommendation>`)).toEqual([
        expect.objectContaining({ nativeId: 'r-1', rating: 4, reason: '<balance>', vmRefs: ['vm-1'], hostRefs: ['host-1'] }),
      ]);
    });

    it('parseSearchResults splits folders and files, folders first', () => {
      const xml = `<returnval>
        <folderPath>[datastore1]</folderPath>
        <file xsi:type="FolderFileInfo"><path>my-vm</path><modification>2026-01-01T00:00:00Z</modification></file>
        <file xsi:type="IsoImageFileInfo"><path>ubuntu.iso</path><fileSize>1500000000</fileSize><modification>2026-02-02T00:00:00Z</modification></file>
        <file xsi:type="VmConfigFileInfo"><path>my-vm.vmx</path><fileSize>2000</fileSize></file>
      </returnval>`;
      const r = _internals._parseSearchResults(xml, 'datastore1', '');
      expect(r.datastore).toBe('datastore1');
      expect(r.entries).toHaveLength(3);
      // folder first
      expect(r.entries[0]).toMatchObject({ name: 'my-vm', isFolder: true });
      const iso = r.entries.find(e => e.name === 'ubuntu.iso');
      expect(iso).toMatchObject({ isFolder: false, fileSize: 1500000000 });
    });

    it('parseDatastoreUsage attributes committed bytes per datastore', () => {
      const xml = `
        <VirtualMachineUsageOnDatastore><datastore type="Datastore">datastore-11</datastore><committed>5000</committed><uncommitted>100</uncommitted></VirtualMachineUsageOnDatastore>
        <VirtualMachineUsageOnDatastore><datastore type="Datastore">datastore-22</datastore><committed>3000</committed></VirtualMachineUsageOnDatastore>`;
      const r = _internals._parseDatastoreUsage(xml);
      expect(r).toEqual([
        { datastore: 'datastore-11', committed: 5000 },
        { datastore: 'datastore-22', committed: 3000 },
      ]);
    });

    it('parses recursive datastore ISO results with stable datastore paths', () => {
      const xml = `<HostDatastoreBrowserSearchResults><folderPath>[datastore1] media/linux</folderPath>
        <file xsi:type="IsoImageFileInfo"><path>debian.iso</path><fileSize>1024</fileSize><modification>2026-07-01T00:00:00Z</modification></file>
      </HostDatastoreBrowserSearchResults>`;
      expect(_internals._parseRecursiveSearchResults(xml, 'datastore1')).toEqual([
        expect.objectContaining({ name: 'debian.iso', folderPath: 'media/linux', datastorePath: '[datastore1] media/linux/debian.iso', fileSize: 1024 }),
      ]);
    });

    it('extractObjects parses RetrievePropertiesEx returnval blocks', () => {
      const xml = `
        <returnval>
          <objects>
            <obj type="VirtualMachine">vm-123</obj>
            <propSet><name>name</name><val>web-01</val></propSet>
            <propSet><name>summary.runtime.powerState</name><val>poweredOn</val></propSet>
          </objects>
          <objects>
            <obj type="VirtualMachine">vm-456</obj>
            <propSet><name>name</name><val>db-01</val></propSet>
            <propSet><name>summary.runtime.powerState</name><val>poweredOff</val></propSet>
          </objects>
        </returnval>
      `;
      const objs = _internals._extractObjects(xml);
      expect(objs).toHaveLength(2);
      expect(objs[0]).toMatchObject({
        obj: 'vm-123', type: 'VirtualMachine',
        props: { name: 'web-01', 'summary.runtime.powerState': 'poweredOn' },
      });
      expect(objs[1].props.name).toBe('db-01');
      expect(objs[1].props['summary.runtime.powerState']).toBe('poweredOff');
    });

    it('parses a nested snapshot tree with current and consistency evidence', () => {
      const xml = `<snapshot><currentSnapshot type="VirtualMachineSnapshot">snapshot-2</currentSnapshot>
        <rootSnapshotList><snapshot type="VirtualMachineSnapshot">snapshot-1</snapshot>
          <vm type="VirtualMachine">vm-1</vm><name>root &amp; safe</name><description>base</description>
          <createTime>2026-07-01T00:00:00Z</createTime><state>poweredOff</state><quiesced>false</quiesced>
          <childSnapshotList><snapshot type="VirtualMachineSnapshot">snapshot-2</snapshot>
            <vm type="VirtualMachine">vm-1</vm><name>child</name><createTime>2026-07-02T00:00:00Z</createTime>
            <state>poweredOn</state><quiesced>true</quiesced></childSnapshotList>
        </rootSnapshotList></snapshot>`;
      expect(_internals._parseSnapshotTree(xml)).toEqual([
        expect.objectContaining({ nativeRef: 'snapshot-1', name: 'root & safe', parentRef: null, consistency: 'crash', isCurrent: false }),
        expect.objectContaining({ nativeRef: 'snapshot-2', name: 'child', parentRef: 'snapshot-1', consistency: 'quiesced', isCurrent: true }),
      ]);
    });

    it('parses per-VM DAS overrides and preserves missing failover depth as unknown', () => {
      const xml = `<ClusterDasVmConfigInfo><key type="VirtualMachine">vm-41</key><dasSettings>
        <restartPriority>highest</restartPriority><isolationResponse>shutdown</isolationResponse>
      </dasSettings></ClusterDasVmConfigInfo>`;
      expect(_internals._parseDasVmConfig(xml)).toEqual({
        'vm-41': { restartPriority: 'highest', isolationResponse: 'shutdown' },
      });
      expect(_internals._propertyNumber(undefined)).toBeNull();
      expect(_internals._propertyNumber('0')).toBe(0);
      expect(_internals._propertyNumber('not-a-number')).toBeNull();
    });
  });

  describe('HA cluster inventory', () => {
    it('reads bounded ClusterComputeResource DAS and summary properties', async () => {
      const client = new VSphereClient({ endpoint: 'https://vc', username: 'svc', password: 'secret' });
      client._sessionCookie = 'vmware_soap_session=test';
      client._moRefs = {
        viewManager: { type: 'ViewManager', value: 'ViewManager' },
        rootFolder: { type: 'Folder', value: 'group-d1' },
      };
      client._soapPost = jest.fn(async () => '<returnval type="ContainerView">view-42</returnval>');
      client._retrieveProperties = jest.fn(async (_view, type, properties) => {
        expect(type).toBe('ClusterComputeResource');
        expect(properties).toEqual(expect.arrayContaining(['configurationEx.dasConfig', 'summary.currentFailoverLevel']));
        return `<objects><obj type="ClusterComputeResource">domain-c7</obj>
          <propSet><name>name</name><val>Production</val></propSet>
          <propSet><name>configurationEx.dasConfig</name><val><enabled>true</enabled><admissionControlEnabled>true</admissionControlEnabled><hostMonitoring>enabled</hostMonitoring><failoverLevel>2</failoverLevel><defaultVmSettings><restartPriority>high</restartPriority><isolationResponse>shutdown</isolationResponse></defaultVmSettings></val></propSet>
          <propSet><name>configurationEx.dasVmConfig</name><val><ClusterDasVmConfigInfo><key type="VirtualMachine">vm-41</key><dasSettings><restartPriority>highest</restartPriority></dasSettings></ClusterDasVmConfigInfo></val></propSet>
          <propSet><name>summary.overallStatus</name><val>green</val></propSet>
          <propSet><name>summary.numHosts</name><val>3</val></propSet>
          <propSet><name>host</name><val><ManagedObjectReference type="HostSystem">host-1</ManagedObjectReference><ManagedObjectReference type="HostSystem">host-2</ManagedObjectReference></val></propSet>
          <propSet><name>datastore</name><val><ManagedObjectReference type="Datastore">datastore-9</ManagedObjectReference></val></propSet>
        </objects>`;
      });
      await expect(client.listClusters()).resolves.toEqual([expect.objectContaining({
        moref: 'domain-c7', name: 'Production', haEnabled: true,
        admissionControlEnabled: true, configuredFailoverLevel: 2,
        currentFailoverLevel: null, hostRefs: ['host-1', 'host-2'], datastoreRefs: ['datastore-9'],
        vmPriorities: { 'vm-41': { restartPriority: 'highest', isolationResponse: null } },
      })]);
    });
  });

  describe('login flow', () => {
    it('retrieves service content first, then sends Login + captures cookie', async () => {
      const seenBodies = [];
      // v8.9.11-alpha.7 — login() now issues RetrieveServiceContent FIRST to
      // establish the session, THEN Login. Queue two responses.
      // 1) RetrieveServiceContent — returns standalone-ESXi MoRefs + cookie.
      mockHttps._mockNext((_opts, cb, req) => {
        seenBodies.push(req._writtenBody.toString('utf8'));
        const res = fakeResponse({
          status: 200,
          body: '<soap:Envelope><soap:Body><RetrieveServiceContentResponse><returnval>' +
            '<rootFolder type="Folder">ha-folder-root</rootFolder>' +
            '<propertyCollector type="PropertyCollector">ha-property-collector</propertyCollector>' +
            '<viewManager type="ViewManager">ViewManager</viewManager>' +
            '<about><version>8.0.0</version></about>' +
            '<sessionManager type="SessionManager">ha-sessionmgr</sessionManager>' +
            '</returnval></RetrieveServiceContentResponse></soap:Body></soap:Envelope>',
          setCookie: 'vmware_soap_session="deadbeef"; Path=/; HttpOnly',
        });
        cb(res); res._fire();
      });
      // 2) Login — authenticates the session.
      mockHttps._mockNext((_opts, cb, req) => {
        seenBodies.push(req._writtenBody.toString('utf8'));
        const res = fakeResponse({
          status: 200,
          body: '<soap:Envelope><soap:Body><LoginResponse></LoginResponse></soap:Body></soap:Envelope>',
        });
        cb(res); res._fire();
      });
      const c = new VSphereClient({ endpoint: 'https://esxi', username: 'root', password: 'p@ss<word>' });
      await c.login();
      expect(seenBodies[0]).toContain('<RetrieveServiceContent xmlns="urn:vim25">');
      expect(seenBodies[1]).toContain('<Login xmlns="urn:vim25">');
      expect(seenBodies[1]).toContain('<userName>root</userName>');
      // XML entity escape on the password
      expect(seenBodies[1]).toContain('<password>p@ss&lt;word&gt;</password>');
      // CRITICAL: Login must target the ESXi sessionManager MoRef parsed from
      // ServiceContent (ha-sessionmgr), NOT the hardcoded vCenter default.
      expect(seenBodies[1]).toContain('ha-sessionmgr');
      expect(c._moRefs.sessionManager.value).toBe('ha-sessionmgr');
      expect(c._moRefs.rootFolder.value).toBe('ha-folder-root');
      expect(c._moRefs.propertyCollector.value).toBe('ha-property-collector');
      expect(c._sessionCookie).toBe('vmware_soap_session="deadbeef"');
    });

    it('surfaces a SOAP fault returned with HTTP 200 (bad credentials)', async () => {
      // RetrieveServiceContent sets a cookie...
      mockHttps._mockNext((_opts, cb, _req) => {
        const res = fakeResponse({
          status: 200,
          body: '<soap:Envelope><soap:Body><RetrieveServiceContentResponse><returnval/></RetrieveServiceContentResponse></soap:Body></soap:Envelope>',
          setCookie: 'vmware_soap_session="anon"; Path=/',
        });
        cb(res); res._fire();
      });
      // ...but Login returns a fault with HTTP 200.
      mockHttps._mockNext((_opts, cb, _req) => {
        const res = fakeResponse({
          status: 200,
          body: '<soap:Envelope><soap:Body><soap:Fault><faultstring>Cannot complete login due to an incorrect user name or password.</faultstring></soap:Fault></soap:Body></soap:Envelope>',
        });
        cb(res); res._fire();
      });
      const c = new VSphereClient({ endpoint: 'https://esxi', username: 'root', password: 'wrong' });
      await expect(c.login()).rejects.toThrow(/incorrect user name or password/i);
    });
  });

  describe('VM power operations', () => {
    it('queries ServiceInstance VMotion compatibility without submitting a task', async () => {
      const client = new VSphereClient({ endpoint: 'https://vcenter', username: 'svc', password: 'x' });
      client._sessionCookie = 'vmware_soap_session="test"';
      client._retrievePropertiesDirect = jest.fn().mockResolvedValue(`<returnval><objects>
        <obj type="VirtualMachine">vm-42</obj><propSet><name>runtime.host</name><val type="HostSystem">host-1</val></propSet>
      </objects></returnval>`);
      client._soapPost = jest.fn().mockResolvedValue(`<QueryVMotionCompatibilityResponse>
        <returnval><host type="HostSystem">host-2</host><compatibility>cpu</compatibility><compatibility>software</compatibility></returnval>
      </QueryVMotionCompatibilityResponse>`);
      await expect(client.getVmMigrationCompatibility('vm-42', ['host-1', 'host-2'])).resolves.toEqual({
        sourceRef: 'host-1', candidates: [{ hostRef: 'host-2', compatibility: ['cpu', 'software'] }],
      });
      const body = client._soapPost.mock.calls[0][0];
      expect(body).toContain('<QueryVMotionCompatibility xmlns="urn:vim25">');
      expect(body).toContain('<compatibility>cpu</compatibility><compatibility>software</compatibility>');
      expect(body).not.toMatch(/_Task|RelocateVM|MigrateVM/);
    });

    it('acquires a one-time WebMKS ticket and validates its WebSocket URL', async () => {
      let requestBody = '';
      mockHttps._mockNext((_opts, cb, req) => {
        requestBody = req._writtenBody.toString('utf8');
        const res = fakeResponse({ status: 200, body: `<soap:Envelope><soap:Body><AcquireTicketResponse><returnval>
          <ticket>one-time-ticket</ticket><host>esxi-a.internal</host><port>443</port>
          <url>wss://esxi-a.internal/ticket/one-time-ticket</url><sslThumbprint>AA:BB</sslThumbprint>
        </returnval></AcquireTicketResponse></soap:Body></soap:Envelope>` });
        cb(res); res._fire();
      });
      const client = new VSphereClient({ endpoint: 'https://vcenter', username: 'svc', password: 'x' });
      client._sessionCookie = 'vmware_soap_session="test"';
      await expect(client.acquireVmConsoleTicket('vm-42')).resolves.toMatchObject({
        url: 'wss://esxi-a.internal/ticket/one-time-ticket', ticket: 'one-time-ticket',
        host: 'esxi-a.internal', port: 443, sslThumbprint: 'AA:BB',
      });
      expect(requestBody).toContain('<AcquireTicket xmlns="urn:vim25">');
      expect(requestBody).toContain('<ticketType>webmks</ticketType>');
    });

    it('submits a task-backed power action using the VM MoRef', async () => {
      let requestBody = '';
      mockHttps._mockNext((_opts, cb, req) => {
        requestBody = req._writtenBody.toString('utf8');
        const res = fakeResponse({
          status: 200,
          body: '<soap:Envelope><soap:Body><PowerOnVM_TaskResponse><returnval type="Task">haTask-42</returnval></PowerOnVM_TaskResponse></soap:Body></soap:Envelope>',
        });
        cb(res); res._fire();
      });
      const client = new VSphereClient({ endpoint: 'https://esxi', username: 'root', password: 'x' });
      client._sessionCookie = 'vmware_soap_session="test"';
      await expect(client.vmPowerAction('42-vm', 'start')).resolves.toEqual({
        taskRef: 'haTask-42', provider: 'vsphere',
      });
      expect(requestBody).toContain('<PowerOnVM_Task xmlns="urn:vim25">');
      expect(requestBody).toContain('<_this type="VirtualMachine">42-vm</_this>');
    });

    it('uses synchronous guest operations without inventing a task', async () => {
      let requestBody = '';
      mockHttps._mockNext((_opts, cb, req) => {
        requestBody = req._writtenBody.toString('utf8');
        const res = fakeResponse({ status: 200, body: '<soap:Envelope><soap:Body><ShutdownGuestResponse/></soap:Body></soap:Envelope>' });
        cb(res); res._fire();
      });
      const client = new VSphereClient({ endpoint: 'https://esxi', username: 'root', password: 'x' });
      client._sessionCookie = 'vmware_soap_session="test"';
      await expect(client.vmPowerAction('vm-9', 'shutdown')).resolves.toEqual({ taskRef: null, provider: 'vsphere' });
      expect(requestBody).toContain('<ShutdownGuest xmlns="urn:vim25">');
    });

    it('reads native task state and progress through the property collector', async () => {
      mockHttps._mockNext((_opts, cb, _req) => {
        const res = fakeResponse({ status: 200, body: `<soap:Envelope><soap:Body><RetrievePropertiesExResponse><returnval><objects>
          <obj type="Task">haTask-42</obj>
          <propSet><name>info.state</name><val>success</val></propSet>
          <propSet><name>info.progress</name><val>100</val></propSet>
        </objects></returnval></RetrievePropertiesExResponse></soap:Body></soap:Envelope>` });
        cb(res); res._fire();
      });
      const client = new VSphereClient({ endpoint: 'https://esxi', username: 'root', password: 'x' });
      client._sessionCookie = 'vmware_soap_session="test"';
      await expect(client.getTaskStatus('haTask-42')).resolves.toEqual({ status: 'success', progress: 100, error: null });
    });

    it('submits RelocateVM_Task and cancels only the selected native task', async () => {
      const bodies = [];
      mockHttps._mockNext((_opts, cb, req) => {
        bodies.push(req._writtenBody.toString('utf8'));
        const res = fakeResponse({ status: 200, body: '<returnval type="Task">task-relocate-1</returnval>' });
        cb(res); res._fire();
      });
      mockHttps._mockNext((_opts, cb, req) => {
        bodies.push(req._writtenBody.toString('utf8'));
        const res = fakeResponse({ status: 200, body: '<CancelTaskResponse/>' });
        cb(res); res._fire();
      });
      const client = new VSphereClient({ endpoint: 'https://vcenter', username: 'root', password: 'x' });
      client._sessionCookie = 'vmware_soap_session="test"';
      await expect(client.relocateVm('vm-42', { hostRef: 'host-9', datastoreRef: 'datastore-3' }))
        .resolves.toEqual({ taskRef: 'task-relocate-1', provider: 'vsphere' });
      await expect(client.cancelTask('task-relocate-1')).resolves.toEqual({ ok: true });
      expect(bodies[0]).toContain('<RelocateVM_Task xmlns="urn:vim25">');
      expect(bodies[0]).toContain('<datastore type="Datastore">datastore-3</datastore>');
      expect(bodies[0]).toContain('<host type="HostSystem">host-9</host>');
      expect(bodies[1]).toContain('<CancelTask xmlns="urn:vim25">');
    });
  });

  describe('VM snapshot operations', () => {
    it('submits safe task-backed create, revert and delete SOAP operations', async () => {
      const bodies = [];
      for (const task of ['create-1', 'revert-1', 'delete-1']) {
        mockHttps._mockNext((_opts, cb, req) => {
          bodies.push(req._writtenBody.toString('utf8'));
          const res = fakeResponse({ status: 200, body: `<soap:Envelope><soap:Body><Response><returnval type="Task">haTask-${task}</returnval></Response></soap:Body></soap:Envelope>` });
          cb(res); res._fire();
        });
      }
      const client = new VSphereClient({ endpoint: 'https://esxi', username: 'root', password: 'x' });
      client._sessionCookie = 'vmware_soap_session="test"';
      await expect(client.createVMSnapshot('vm-9', { name: 'safe&amp;', description: '<checkpoint>', quiesce: true }))
        .resolves.toEqual({ taskRef: 'haTask-create-1', provider: 'vsphere' });
      await expect(client.revertVMSnapshot('snapshot-9')).resolves.toEqual({ taskRef: 'haTask-revert-1', provider: 'vsphere' });
      await expect(client.deleteVMSnapshot('snapshot-9')).resolves.toEqual({ taskRef: 'haTask-delete-1', provider: 'vsphere' });
      expect(bodies[0]).toContain('<CreateSnapshot_Task xmlns="urn:vim25">');
      expect(bodies[0]).toContain('<name>safe&amp;amp;</name>');
      expect(bodies[0]).toContain('<description>&lt;checkpoint&gt;</description>');
      expect(bodies[0]).toContain('<quiesce>true</quiesce>');
      expect(bodies[1]).toContain('<suppressPowerOn>true</suppressPowerOn>');
      expect(bodies[2]).toContain('<removeChildren>false</removeChildren><consolidate>true</consolidate>');
    });
  });

  describe('template inventory', () => {
    it('separates vSphere templates from runnable virtual machines', async () => {
      mockHttps._mockNext((_opts, cb) => { const res = fakeResponse({ status: 200, body: '<returnval>view-1</returnval>' }); cb(res); res._fire(); });
      mockHttps._mockNext((_opts, cb) => { const res = fakeResponse({ status: 200, body: `<returnval><objects>
        <obj type="VirtualMachine">vm-9000</obj><propSet><name>name</name><val>Ubuntu Gold</val></propSet>
        <propSet><name>summary.config.uuid</name><val>42000000-0000-4000-8000-000000009000</val></propSet>
        <propSet><name>config.template</name><val>true</val></propSet><propSet><name>summary.config.numCpu</name><val>4</val></propSet>
        <propSet><name>summary.config.memorySizeMB</name><val>8192</val></propSet>
      </objects></returnval>` }); cb(res); res._fire(); });
      const client = new VSphereClient({ endpoint: 'https://esxi', username: 'root', password: 'x' });
      client._sessionCookie = 'vmware_soap_session="test"';
      await expect(client.listTemplates()).resolves.toEqual([
        expect.objectContaining({ kind: 'vmTemplate', nativeRef: 'vm-9000', name: 'Ubuntu Gold', numCPU: 4, memoryMB: 8192 }),
      ]);
    });

    it('submits a powered-off full CloneVM task with explicit placement', async () => {
      let body = '';
      mockHttps._mockNext((_opts, cb, req) => {
        body = req._writtenBody.toString('utf8');
        const res = fakeResponse({ status: 200, body: '<CloneVM_TaskResponse><returnval type="Task">haTask-clone-1</returnval></CloneVM_TaskResponse>' });
        cb(res); res._fire();
      });
      const client = new VSphereClient({ endpoint: 'https://esxi', username: 'root', password: 'x' });
      client._sessionCookie = 'vmware_soap_session="test"';
      await expect(client.cloneTemplate('vm-9000', {
        name: 'app-01', mode: 'full', folderRef: 'group-v3', poolRef: 'resgroup-1', datastoreRef: 'datastore-4',
      })).resolves.toEqual({ taskRef: 'haTask-clone-1', provider: 'vsphere' });
      expect(body).toContain('<CloneVM_Task xmlns="urn:vim25">');
      expect(body).toContain('<folder type="Folder">group-v3</folder>');
      expect(body).toContain('<datastore type="Datastore">datastore-4</datastore>');
      expect(body).toContain('<template>false</template><powerOn>false</powerOn>');
      expect(body.indexOf('<location>')).toBeLessThan(body.indexOf('<template>false</template>'));
    });

    it('prechecks and embeds LinuxPrep customization in official CloneSpec order', async () => {
      const bodies = [];
      mockHttps._mockNext((_opts, cb, req) => {
        bodies.push(req._writtenBody.toString('utf8'));
        const res = fakeResponse({ status: 200, body: '<CheckCustomizationSpecResponse/>' }); cb(res); res._fire();
      });
      mockHttps._mockNext((_opts, cb, req) => {
        bodies.push(req._writtenBody.toString('utf8'));
        const res = fakeResponse({ status: 200, body: '<CloneVM_TaskResponse><returnval type="Task">haTask-custom-clone</returnval></CloneVM_TaskResponse>' }); cb(res); res._fire();
      });
      const client = new VSphereClient({ endpoint: 'https://esxi', username: 'root', password: 'x' });
      client._sessionCookie = 'vmware_soap_session="test"';
      const customization = {
        osFamily: 'linux', hostname: 'app-01', domain: 'example.internal', timezone: 'Europe/Bucharest',
        user: null, sshAuthorizedKeys: [],
        network: {
          mode: 'static', address: '192.0.2.10/25', gateway: '192.0.2.1',
          dnsServers: ['1.1.1.1'], searchDomains: ['apps.example.internal'],
        },
      };
      await expect(client.cloneTemplate('vm-9000', {
        name: 'app-01', mode: 'full', folderRef: 'group-v3', poolRef: 'resgroup-1', datastoreRef: 'datastore-4', customization,
      })).resolves.toEqual({ taskRef: 'haTask-custom-clone', provider: 'vsphere' });
      expect(bodies[0]).toContain('<CheckCustomizationSpec xmlns="urn:vim25">');
      expect(bodies[0]).toContain('<spec>');
      expect(bodies[1]).toContain('<identity xsi:type="CustomizationLinuxPrep">');
      expect(bodies[1]).toContain('<subnetMask>255.255.255.128</subnetMask>');
      expect(bodies[1]).toContain('<dnsSuffixList>apps.example.internal</dnsSuffixList>');
      expect(bodies[1].indexOf('<template>false</template>')).toBeLessThan(bodies[1].indexOf('<customization>'));
      expect(bodies[1].indexOf('</customization>')).toBeLessThan(bodies[1].indexOf('<powerOn>false</powerOn>'));
    });
  });
});

describe('vSphere incremental placement mutation', () => {
  it('sends one escaped ClusterRuleSpec with modify=true and returns the durable task', async () => {
    const client = new VSphereClient({ endpoint: 'https://vc', username: 'svc', password: 'secret' });
    client._sessionCookie = 'vmware_soap_session=test';
    client._soapPost = jest.fn(async () => '<returnval type="Task">task-44</returnval>');
    const result = await client.reconfigureCluster('domain-c7', {
      kind: 'affinity_rule', operation: 'add', key: null,
      ruleKind: 'vm_vm_anti_affinity', name: 'db & web', enabled: true, mandatory: true,
      vmRefs: ['vm-1', 'vm-2'],
    });
    expect(result).toEqual({ taskRef: 'task-44', provider: 'vsphere' });
    const xml = client._soapPost.mock.calls[0][0];
    expect(xml).toContain('<ReconfigureComputeResource_Task');
    expect(xml).toContain('<spec xsi:type="ClusterConfigSpecEx"><rulesSpec><operation>add</operation>');
    expect(xml).toContain('xsi:type="ClusterAntiAffinityRuleSpec"');
    expect(xml).toContain('<name>db &amp; web</name>');
    expect(xml).toContain('<mandatory>true</mandatory>');
    expect(xml).toContain('<modify>true</modify>');
    expect(xml.match(/<rulesSpec>/g)).toHaveLength(1);
  });
});
