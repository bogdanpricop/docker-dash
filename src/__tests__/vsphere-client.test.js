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
    it('sends SOAP Login envelope and captures session cookie', async () => {
      let seenBody = null;
      mockHttps._mockNext((_opts, cb, req) => {
        seenBody = req._writtenBody.toString('utf8');
        const res = fakeResponse({
          status: 200,
          body: '<soap:Envelope><soap:Body><LoginResponse></LoginResponse></soap:Body></soap:Envelope>',
          setCookie: 'vmware_soap_session="deadbeef"; Path=/; HttpOnly',
        });
        cb(res); res._fire();
      });
      const c = new VSphereClient({ endpoint: 'https://esxi', username: 'root', password: 'p@ss<word>' });
      await c.login();
      expect(seenBody).toContain('<Login xmlns="urn:vim25">');
      expect(seenBody).toContain('<userName>root</userName>');
      // XML entity escape on the password
      expect(seenBody).toContain('<password>p@ss&lt;word&gt;</password>');
      expect(c._sessionCookie).toBe('vmware_soap_session="deadbeef"');
    });

    it('throws on missing session cookie', async () => {
      mockHttps._mockNext((_opts, cb, _req) => {
        const res = fakeResponse({ status: 200, body: '<Response/>' });
        cb(res); res._fire();
      });
      const c = new VSphereClient({ endpoint: 'https://esxi', username: 'root', password: 'x' });
      await expect(c.login()).rejects.toThrow(/no session cookie/);
    });
  });
});
