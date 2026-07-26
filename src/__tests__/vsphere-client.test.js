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
  });
});
