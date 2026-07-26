'use strict';

process.env.APP_SECRET = 'test-xen';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const mockHttps = {
  _handlers: [],
  _mockNext(handler) { this._handlers.push(handler); },
  Agent: function Agent() {},
  request(opts, cb) {
    const handler = this._handlers.shift();
    if (!handler) throw new Error(`mockHttps: no response queued for ${opts.method} ${opts.path}`);
    const req = {
      body: '',
      write(value) { this.body += value.toString(); },
      end() { setImmediate(() => handler(opts, cb, this)); },
      on() {}, destroy() {},
    };
    return req;
  },
};
jest.mock('https', () => mockHttps);

jest.mock('ssh2', () => {
  const { EventEmitter } = require('events');
  class MockClient extends EventEmitter {
    static responses = [];
    static commands = [];
    connect() { setImmediate(() => this.emit('ready')); }
    exec(command, cb) {
      MockClient.commands.push(command);
      const response = MockClient.responses.shift() || { stdout: '', stderr: '', code: 0 };
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.destroy = () => {};
      cb(null, stream);
      setImmediate(() => {
        if (response.stdout) stream.emit('data', Buffer.from(response.stdout));
        if (response.stderr) stream.stderr.emit('data', Buffer.from(response.stderr));
        stream.emit('close', response.code || 0);
      });
    }
    end() {}
  }
  return { Client: MockClient };
});

const {
  XenOrchestraClient, XapiClient, XenRawClient, normalizeProvider,
  encryptDaemonConfig, decryptDaemonConfig, fromHostRow, _internals,
} = require('../services/xen');

function fakeResponse(status, body, headers = {}) {
  const listeners = {};
  return {
    statusCode: status, headers,
    on(event, fn) { listeners[event] = fn; },
    fire() {
      if (body && listeners.data) listeners.data(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
      listeners.end?.();
    },
  };
}

function queueJson(body, status = 200, inspect) {
  mockHttps._mockNext((opts, cb, req) => {
    inspect?.(opts, req);
    const response = fakeResponse(status, body);
    cb(response); response.fire();
  });
}

describe('unified Xen client', () => {
  beforeEach(() => {
    mockHttps._handlers.length = 0;
    const { Client } = require('ssh2');
    Client.responses.length = 0;
    Client.commands.length = 0;
  });

  it('normalizes product aliases to management providers', () => {
    expect(normalizeProvider('xen-orchestra')).toBe('xo');
    expect(normalizeProvider('XCP-NG')).toBe('xapi');
    expect(normalizeProvider('citrix-hypervisor')).toBe('xapi');
    expect(normalizeProvider('libxl')).toBe('raw');
    expect(() => normalizeProvider('unknown')).toThrow(/Unsupported Xen provider/);
  });

  it('accepts OpenSSH and hexadecimal SHA-256 host-key fingerprints', () => {
    const bytes = Buffer.alloc(32, 7);
    expect(_internals._hostKeySha256Hex(`SHA256:${bytes.toString('base64').replace(/=+$/, '')}`)).toBe(bytes.toString('hex'));
    expect(_internals._hostKeySha256Hex(bytes.toString('hex').toUpperCase())).toBe(bytes.toString('hex'));
    expect(() => _internals._hostKeySha256Hex('not-a-fingerprint')).toThrow(/SHA-256/);
  });

  it('encrypts daemon_config and reconstructs the correct provider', () => {
    const config = { provider: 'xapi', endpoint: 'https://xcp.test', username: 'svc', password: 'secret' };
    const encrypted = encryptDaemonConfig(config);
    expect(encrypted).toMatch(/^enc:/);
    expect(encrypted).not.toContain('secret');
    expect(decryptDaemonConfig(encrypted)).toEqual(config);
    expect(fromHostRow({ daemon_type: 'xen', daemon_config: encrypted })).toBeInstanceOf(XapiClient);
  });

  it('encodes and parses nested XML-RPC values and faults', () => {
    const value = { Status: 'Success', Value: ['one', true, 2] };
    const xml = `<methodResponse><params><param>${_internals._xmlValue(value)}</param></params></methodResponse>`;
    expect(_internals._parseXmlRpcResponse(xml)).toEqual(value);
    const fault = `<methodResponse><fault>${_internals._xmlValue({ faultCode: 500, faultString: 'bad request' })}</fault></methodResponse>`;
    expect(() => _internals._parseXmlRpcResponse(fault)).toThrow(/bad request/);
  });

  it('uses Xen Orchestra token auth and normalizes VM inventory', async () => {
    let auth;
    queueJson([{ id: 'vm-1', uuid: 'u-1', name_label: 'web', power_state: 'Running', CPUs: 4, memory: 2147483648, allowed_operations: ['clean_shutdown', 'snapshot'] },
      { id: 'tpl', name_label: 'template', is_a_template: true }], 200, (opts) => { auth = opts.headers.Cookie; expect(opts.path).toContain('/rest/v0/vms'); });
    const client = new XenOrchestraClient({ endpoint: 'https://xo.test', token: 'TOKEN' });
    const vms = await client.listVMs();
    expect(auth).toBe('authenticationToken=TOKEN');
    expect(vms).toEqual([expect.objectContaining({ id: 'vm-1', uuid: 'u-1', name: 'web', cpus: 4, memoryBytes: 2147483648, allowedActions: ['shutdown', 'snapshot'] })]);
  });

  it('submits Xen Orchestra VM actions only through the action map', async () => {
    let request;
    queueJson({ task: 'task-1' }, 200, (opts, req) => { request = { opts, body: JSON.parse(req.body) }; });
    const client = new XenOrchestraClient({ endpoint: 'https://xo.test', token: 'TOKEN' });
    await client.vmAction('vm/unsafe', 'shutdown');
    expect(request.opts.path).toBe('/rest/v0/vms/vm%2Funsafe/actions/clean_shutdown');
    expect(request.body).toEqual({});
    await expect(client.vmAction('vm-1', 'formatDisk')).rejects.toThrow(/Unsupported/);
  });

  it('uses one concurrent XAPI login and JSON-RPC task operations', async () => {
    let loginCount = 0;
    queueJson({ jsonrpc: '2.0', result: 'OpaqueRef:session', id: 1 }, 200, (_opts, req) => {
      expect(JSON.parse(req.body).method).toBe('session.login_with_password'); loginCount++;
    });
    queueJson({ jsonrpc: '2.0', result: {
      'OpaqueRef:vm': { uuid: 'vm-uuid', name_label: 'db', power_state: 'Running', is_control_domain: false, is_a_template: false, is_a_snapshot: false, snapshot_of: 'OpaqueRef:NULL' },
    }, id: 2 });
    queueJson({ jsonrpc: '2.0', result: { 'OpaqueRef:pool': { uuid: 'pool-uuid', name_label: 'main' } }, id: 3 });
    const client = new XapiClient({ endpoint: 'https://xcp.test', username: 'svc', password: 'secret' });
    const [vms, pools] = await Promise.all([client.listVMs(), client.listPools()]);
    expect(loginCount).toBe(1);
    expect(vms[0]).toMatchObject({ id: 'vm-uuid', ref: 'OpaqueRef:vm', name: 'db' });
    expect(pools[0]).toMatchObject({ id: 'pool-uuid', name: 'main' });

    queueJson({ jsonrpc: '2.0', result: 'OpaqueRef:vm', id: 4 });
    queueJson({ jsonrpc: '2.0', result: 'OpaqueRef:task', id: 5 }, 200, (_opts, req) => {
      expect(JSON.parse(req.body).method).toBe('Async.VM.clean_shutdown');
    });
    expect(await client.vmAction('vm-uuid', 'shutdown')).toEqual({ taskRef: 'OpaqueRef:task', provider: 'xapi' });

    queueJson({ jsonrpc: '2.0', result: 'OpaqueRef:task', id: 6 });
    queueJson({ jsonrpc: '2.0', result: '', id: 7 }, 200, (_opts, req) => {
      expect(JSON.parse(req.body).method).toBe('task.destroy');
    });
    expect(await client.deleteTask('task-uuid')).toEqual({ ok: true, id: 'task-uuid', provider: 'xapi' });
  });

  it('falls back from unavailable JSON-RPC to legacy XML-RPC', async () => {
    mockHttps._mockNext((opts, cb) => {
      expect(opts.path).toBe('/jsonrpc');
      const response = fakeResponse(404, '<html>missing</html>'); cb(response); response.fire();
    });
    mockHttps._mockNext((opts, cb, req) => {
      expect(opts.path).toBe('/');
      expect(req.body).toContain('<methodName>session.login_with_password</methodName>');
      const response = fakeResponse(200, `<methodResponse><params><param>${_internals._xmlValue({ Status: 'Success', Value: 'OpaqueRef:xml-session' })}</param></params></methodResponse>`);
      cb(response); response.fire();
    });
    const client = new XapiClient({ endpoint: 'https://legacy.test', username: 'root', password: 'secret' });
    expect(await client.login()).toBe('OpaqueRef:xml-session');
    expect(client.capabilities().protocol).toBe('xml');
  });

  it('relogs after SESSION_INVALID', async () => {
    queueJson({ jsonrpc: '2.0', result: 'OpaqueRef:s1', id: 1 });
    queueJson({ jsonrpc: '2.0', error: { code: 1, message: 'SESSION_INVALID', data: ['OpaqueRef:s1'] }, id: 2 });
    queueJson({ jsonrpc: '2.0', result: 'OpaqueRef:s2', id: 3 });
    queueJson({ jsonrpc: '2.0', result: {}, id: 4 });
    const client = new XapiClient({ endpoint: 'https://xcp.test', username: 'svc', password: 'secret' });
    expect(await client.listPools()).toEqual([]);
  });

  it('supports xl inventory and protects Domain-0/action arguments', async () => {
    const { Client } = require('ssh2');
    Client.responses.push(
      { stdout: 'xl' },
      { stdout: 'host : dom0\nxen_version : 4.19\nnr_cpus : 8\ntotal_memory : 16384\n' },
      { stdout: JSON.stringify([{ domid: 0, config: { c_info: { name: 'Domain-0', uuid: 'dom0' } } },
        { domid: 2, config: { c_info: { name: 'web', uuid: 'uuid-web' }, b_info: { max_vcpus: 2, max_memkb: 1048576 } }, state: 'running' }]) },
    );
    const client = new XenRawClient({ sshHost: 'dom0.test', sshUsername: 'svc', sshPrivateKey: 'KEY', hostKeySha256: 'ab'.repeat(32) });
    const info = await client.info();
    expect(info).toMatchObject({ product: 'Xen Project (libxl)', version: '4.19', cpus: 8, toolstack: 'xl' });
    expect(await client.listVMs()).toEqual([expect.objectContaining({ id: 'uuid-web', name: 'web', domid: 2 })]);
    await expect(client.vmAction('Domain-0', 'shutdown')).rejects.toThrow(/protected/);
    await expect(client.vmAction('vm; reboot dom0', 'shutdown')).rejects.toThrow(/Invalid/);
  });

  it('detects legacy xm only when xl is unavailable and narrows actions', async () => {
    const { Client } = require('ssh2');
    Client.responses.push(
      { stdout: 'xm' },
      { stdout: 'Name ID Mem VCPUs State Time(s)\nDomain-0 0 1024 2 r----- 1.0\nlegacy 3 512 1 -b---- 2.5\n' },
    );
    const client = new XenRawClient({ sshHost: 'old.test', sshUsername: 'root', sshPassword: 'secret' });
    expect(await client.listVMs()).toEqual([expect.objectContaining({ name: 'legacy', domid: 3 })]);
    expect(client.capabilities()).toMatchObject({ toolstack: 'xm', legacyXend: true });
    await expect(client.vmAction('3', 'forceReboot')).rejects.toThrow(/unavailable/);
  });
});
