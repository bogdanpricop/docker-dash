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
    exec(command, options, cb) {
      if (typeof options === 'function') { cb = options; options = {}; }
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

  it('uses durable XAPI tasks for host disable/enable and reads live host state', async () => {
    const client = new XapiClient({ endpoint: 'https://xcp.test', username: 'svc', password: 'secret' });
    client._call = jest.fn(async (method) => {
      if (method === 'Async.host.disable') return 'OpaqueRef:task-disable';
      if (method === 'Async.host.enable') return 'OpaqueRef:task-enable';
      if (method === 'host.get_record') return {
        uuid: 'host-uuid', name_label: 'xcp-a', enabled: false,
        resident_VMs: ['OpaqueRef:vm-a', 'OpaqueRef:NULL'],
      };
      throw new Error(method);
    });
    await expect(client.disableHost('OpaqueRef:host-a')).resolves.toEqual({
      taskRef: 'OpaqueRef:task-disable', provider: 'xapi', action: 'disable',
    });
    await expect(client.enableHost('OpaqueRef:host-a')).resolves.toEqual({
      taskRef: 'OpaqueRef:task-enable', provider: 'xapi', action: 'enable',
    });
    await expect(client.getHost('OpaqueRef:host-a')).resolves.toEqual(expect.objectContaining({
      ref: 'OpaqueRef:host-a', enabled: false, residentVmRefs: ['OpaqueRef:vm-a'],
    }));
    await expect(client.disableHost('unsafe/ref')).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESOURCE' });
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
    queueJson([{ id: 'vm-1', uuid: 'u-1', name_label: 'web', power_state: 'Running', CPUs: 4, memory: 2147483648, ha_restart_priority: '', allowed_operations: ['clean_shutdown', 'snapshot'] },
      { id: 'tpl', name_label: 'template', is_a_template: true }], 200, (opts) => { auth = opts.headers.Cookie; expect(opts.path).toContain('/rest/v0/vms'); });
    const client = new XenOrchestraClient({ endpoint: 'https://xo.test', token: 'TOKEN' });
    const vms = await client.listVMs();
    expect(auth).toBe('authenticationToken=TOKEN');
    expect(vms).toEqual([expect.objectContaining({ id: 'vm-1', uuid: 'u-1', name: 'web', cpus: 4, memoryBytes: 2147483648, haRestartPriority: '', allowedActions: ['shutdown', 'snapshot'] })]);
  });

  it('discovers and reads only modern Xen Orchestra backup inventory routes', async () => {
    const client = new XenOrchestraClient({ endpoint: 'https://xo.test', token: 'TOKEN' });
    const paths = [];
    client._request = jest.fn(async (_method, path) => {
      paths.push(path);
      if (path === '/rest/v0/docs/swagger.json') return { paths: {
        '/rest/v0/backup-archives': { get: {} },
        '/rest/v0/backup-repositories': { get: {} },
      } };
      if (path.startsWith('/rest/v0/backup-repositories?')) return [{
        id: 'remote-a', name: 'Off-site', enabled: true,
        url: 's3://ACCESS:SECRET@bucket',
      }];
      if (path.startsWith('/rest/v0/backup-archives?')) return [{
        id: 'remote-a/xo-vm-backups/vm-uuid/20260726T100000Z.json',
        backupRepository: 'remote-a', mode: 'delta', size: 2048,
        timestamp: 1785060000000, vm: { uuid: 'vm-uuid', name_label: 'database' },
        withMemory: false,
      }];
      throw new Error(path);
    });
    await client._discoverRestFeatures();
    expect(client.capabilities().backups).toBe(true);
    const result = await client.listRecoveryPoints();
    expect(result.repositories).toEqual([expect.objectContaining({ nativeRef: 'remote-a', name: 'Off-site' })]);
    expect(result.points).toEqual([expect.objectContaining({
      repositoryRef: 'remote-a', workloadUuid: 'vm-uuid', mode: 'delta',
    })]);
    expect(paths.some(path => path.includes('/backup-archives?backup-repository=*'))).toBe(true);
    expect(paths.join(' ')).not.toMatch(/(?:^|[?&,])url(?:=|,|&|$)/);
    expect(JSON.stringify(result)).not.toContain('ACCESS');
  });

  it('fails closed when Xen Orchestra does not publish recovery-point routes', async () => {
    const client = new XenOrchestraClient({ endpoint: 'https://xo.test', token: 'TOKEN' });
    client._request = jest.fn(async path => path === '/rest/v0/docs/swagger.json' ? { paths: {} } : []);
    await expect(client.listRecoveryPoints()).rejects.toMatchObject({
      code: 'PROVIDER_BACKUP_INVENTORY_UNAVAILABLE', status: 400,
    });
    expect(client.capabilities().backups).toBe(false);
  });

  it('preserves Xen home affinity and reads advisory VM groups', async () => {
    queueJson([{ id: 'vm-1', uuid: 'u-1', name_label: 'web', power_state: 'Running',
      $affinity: 'host-1', $groups: ['group-1'] }]);
    queueJson([{ id: 'group-1', uuid: 'g-1', name_label: 'spread', placement: 'anti-affinity', VMs: ['vm-1'] }]);
    const client = new XenOrchestraClient({ endpoint: 'https://xo.test', token: 'TOKEN' });
    await expect(client.listVMs()).resolves.toEqual([expect.objectContaining({
      affinityRef: 'host-1', groupRefs: ['group-1'],
    })]);
    await expect(client.listVmGroups()).resolves.toEqual([expect.objectContaining({
      id: 'group-1', placement: 'anti-affinity', vmRefs: ['vm-1'],
    })]);
  });

  it('preserves Xen Orchestra HA pool depth and keeps absent values unknown', async () => {
    queueJson([
      { id: 'pool-a', uuid: 'pool-uuid-a', name_label: 'A', HA_enabled: true, ha_host_failures_to_tolerate: 2, ha_plan_exists_for: 1, ha_statefiles: ['sr-a'], ha_cluster_stack: 'xhad' },
      { id: 'pool-b', uuid: 'pool-uuid-b', name_label: 'B', HA_enabled: false },
    ]);
    const client = new XenOrchestraClient({ endpoint: 'https://xo.test', token: 'TOKEN' });
    await expect(client.listPools()).resolves.toEqual([
      expect.objectContaining({ id: 'pool-a', haEnabled: true, haHostFailuresToTolerate: 2, haPlanExistsFor: 1, haStatefileCount: 1, haClusterStack: 'xhad' }),
      expect.objectContaining({ id: 'pool-b', haEnabled: false, haHostFailuresToTolerate: null, haPlanExistsFor: null }),
    ]);
  });

  it('preserves XAPI HA plan and restart-priority records', async () => {
    const client = new XapiClient({ endpoint: 'https://xcp.test', username: 'svc', password: 'secret' });
    client._call = jest.fn(async method => {
      if (method === 'pool.get_all_records') return {
        'OpaqueRef:pool': { uuid: 'pool-uuid', name_label: 'Production', ha_enabled: true,
          ha_host_failures_to_tolerate: '2', ha_plan_exists_for: '1', ha_statefiles: ['OpaqueRef:sr'], ha_cluster_stack: 'xhad' },
      };
      if (method === 'VM.get_all_records') return {
        'OpaqueRef:vm': { uuid: 'vm-uuid', name_label: 'db', power_state: 'Running',
          resident_on: 'OpaqueRef:host', snapshot_of: 'OpaqueRef:NULL', ha_restart_priority: 'restart' },
      };
      throw new Error(method);
    });
    await expect(client.listPools()).resolves.toEqual([expect.objectContaining({
      ref: 'OpaqueRef:pool', haEnabled: true, haHostFailuresToTolerate: 2,
      haPlanExistsFor: 1, haStatefileCount: 1,
    })]);
    await expect(client.listVMs()).resolves.toEqual([expect.objectContaining({
      ref: 'OpaqueRef:vm', haRestartPriority: 'restart', hostRef: 'OpaqueRef:host',
    })]);
  });

  it('reads XAPI VM-group placement records and VM affinity references', async () => {
    const client = new XapiClient({ endpoint: 'https://xcp.test', username: 'svc', password: 'secret' });
    client._call = jest.fn(async method => {
      if (method === 'VM.get_all_records') return {
        'OpaqueRef:vm': { uuid: 'vm-uuid', name_label: 'db', power_state: 'Running', resident_on: 'OpaqueRef:host-a',
          affinity: 'OpaqueRef:host-b', groups: ['OpaqueRef:group'], snapshot_of: 'OpaqueRef:NULL' },
      };
      if (method === 'VM_group.get_all_records') return {
        'OpaqueRef:group': { uuid: 'group-uuid', name_label: 'databases', placement: 'anti_affinity', VMs: ['OpaqueRef:vm'] },
      };
      throw new Error(method);
    });
    await expect(client.listVMs()).resolves.toEqual([expect.objectContaining({
      affinityRef: 'OpaqueRef:host-b', groupRefs: ['OpaqueRef:group'],
    })]);
    await expect(client.listVmGroups()).resolves.toEqual([expect.objectContaining({
      ref: 'OpaqueRef:group', placement: 'anti_affinity', vmRefs: ['OpaqueRef:vm'],
    })]);
  });

  it('reads Xen Orchestra templates from the versioned template collection', async () => {
    queueJson([{ id: 'tpl-1', uuid: 'uuid-tpl', name_label: 'Debian gold', name_description: 'hardened', CPUs: 2, memory: 2147483648, is_default_template: true }], 200,
      opts => expect(opts.path).toContain('/rest/v0/vm-templates'));
    const client = new XenOrchestraClient({ endpoint: 'https://xo.test', token: 'TOKEN' });
    await expect(client.listTemplates()).resolves.toEqual([
      expect.objectContaining({ kind: 'vmTemplate', nativeRef: 'tpl-1', uuid: 'uuid-tpl', name: 'Debian gold', default: true }),
    ]);
  });

  it('discovers and uses the task-backed Xen Orchestra pool create workflow', async () => {
    queueJson({ id: 'user-1', email: 'ops@example.test' }, 200,
      opts => expect(opts.path).toBe('/rest/v0/users/me'));
    queueJson({
      paths: {
        '/rest/v0/pools/{id}/actions/create_vm': {
          post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateVmBody' } } } } },
        },
      },
      components: { schemas: { CreateVmBody: { properties: { cloud_config: {}, network_config: {} } } } },
    }, 200, opts => expect(opts.path).toBe('/rest/v0/docs/swagger.json'));
    const client = new XenOrchestraClient({ endpoint: 'https://xo.test', token: 'TOKEN' });
    const info = await client.info();
    expect(info.capabilities).toMatchObject({ provisioning: true, guestCustomization: true });

    queueJson({ taskId: 'task-create-1' }, 200, (opts, req) => {
      expect(opts).toMatchObject({ method: 'POST', path: '/rest/v0/pools/pool-1/actions/create_vm?sync=false' });
      expect(JSON.parse(req.body)).toEqual({
        name_label: 'app-01', template: 'template-1', boot: false,
        cloud_config: '#cloud-config\nhostname: app-01\n',
        network_config: 'version: 2\n',
      });
    });
    await expect(client.cloneTemplate('template-1', 'app-01', {
      mode: 'full', poolId: 'pool-1', cloudConfig: '#cloud-config\nhostname: app-01\n', networkConfig: 'version: 2\n',
    })).resolves.toEqual({ taskRef: 'task-create-1', provider: 'xo', stage: 'clone' });
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

  it('does not claim unsupported Xen Orchestra guest quiescing', async () => {
    const client = new XenOrchestraClient({ endpoint: 'https://xo.test', token: 'TOKEN' });
    expect(client.capabilities().snapshotQuiesce).toBe(false);
    await expect(client.createSnapshot('vm-1', 'safe', { quiesce: true }))
      .rejects.toMatchObject({ code: 'SNAPSHOT_QUIESCE_UNAVAILABLE' });
    expect(mockHttps._handlers).toHaveLength(0);
  });

  it('builds an authenticated same-origin-compatible Xen Orchestra console proxy target', () => {
    const client = new XenOrchestraClient({ endpoint: 'https://xo.test', token: 'SCOPED_TOKEN' });
    expect(client.capabilities().console).toBe(true);
    const descriptor = client.vmConsoleProxy('vm-uuid');
    expect(descriptor.url).toBe('wss://xo.test/api/consoles/vm-uuid');
    expect(descriptor.headers.Cookie).toContain('token=SCOPED_TOKEN');
    const passwordClient = new XenOrchestraClient({ endpoint: 'https://xo.test', username: 'svc', password: 'secret' });
    expect(passwordClient.capabilities().console).toBe(false);
    expect(() => passwordClient.vmConsoleProxy('vm-uuid')).toThrow(/scoped authentication token/i);
  });

  it('selects XAPI RFB before VT100 and retains the management session only server-side', async () => {
    queueJson({ jsonrpc: '2.0', result: 'OpaqueRef:session', id: 1 });
    queueJson({ jsonrpc: '2.0', result: ['OpaqueRef:serial', 'OpaqueRef:rfb'], id: 2 });
    queueJson({ jsonrpc: '2.0', result: {
      protocol: 'vt100', location: 'https://xcp-a/console?ref=serial',
    }, id: 3 });
    queueJson({ jsonrpc: '2.0', result: {
      protocol: 'rfb', location: 'https://xcp-a/console?ref=rfb',
    }, id: 4 });
    const client = new XapiClient({ endpoint: 'https://xcp.test', username: 'svc', password: 'secret' });
    await expect(client.getVmConsole('OpaqueRef:vm')).resolves.toMatchObject({
      protocol: 'rfb', location: 'https://xcp-a/console?ref=rfb', sessionId: 'OpaqueRef:session',
    });
    expect(client.capabilities().console).toBe(true);
  });

  it('dispatches XAPI quiesced snapshots through the explicit async method', async () => {
    queueJson({ jsonrpc: '2.0', result: 'OpaqueRef:session', id: 1 });
    queueJson({ jsonrpc: '2.0', result: 'OpaqueRef:vm', id: 2 });
    queueJson({ jsonrpc: '2.0', result: 'OpaqueRef:task', id: 3 }, 200, (_opts, req) => {
      const body = JSON.parse(req.body);
      expect(body.method).toBe('Async.VM.snapshot_with_quiesce');
      expect(body.params.slice(-2)).toEqual(['OpaqueRef:vm', 'before-upgrade']);
    });
    const client = new XapiClient({ endpoint: 'https://xcp.test', username: 'svc', password: 'secret' });
    await expect(client.createSnapshot('vm-uuid', 'before-upgrade', { quiesce: true }))
      .resolves.toEqual({ taskRef: 'OpaqueRef:task', provider: 'xapi' });
    expect(client.capabilities().snapshotQuiesce).toBe(true);
  });

  it('uses durable XAPI clone and provision stages for linked template creation', async () => {
    queueJson({ jsonrpc: '2.0', result: 'OpaqueRef:session', id: 1 });
    queueJson({ jsonrpc: '2.0', result: 'OpaqueRef:clone-task', id: 2 }, 200, (_opts, req) => {
      const body = JSON.parse(req.body);
      expect(body.method).toBe('Async.VM.clone');
      expect(body.params.slice(-2)).toEqual(['OpaqueRef:template', 'app-01']);
    });
    queueJson({ jsonrpc: '2.0', result: 'OpaqueRef:provision-task', id: 3 }, 200, (_opts, req) => {
      const body = JSON.parse(req.body);
      expect(body.method).toBe('Async.VM.provision');
      expect(body.params.at(-1)).toBe('OpaqueRef:cloned-vm');
    });
    queueJson({ jsonrpc: '2.0', result: {
      uuid: 'vm-uuid', current_operations: { 'OpaqueRef:provision-task': 'provision' }, allowed_operations: [],
    }, id: 4 }, 200, (_opts, req) => expect(JSON.parse(req.body).method).toBe('VM.get_record'));
    const client = new XapiClient({ endpoint: 'https://xcp.test', username: 'svc', password: 'secret' });
    await expect(client.cloneTemplate('OpaqueRef:template', 'app-01', { mode: 'linked' }))
      .resolves.toEqual({ taskRef: 'OpaqueRef:clone-task', provider: 'xapi', stage: 'clone' });
    await expect(client.provisionClonedVm('OpaqueRef:cloned-vm'))
      .resolves.toEqual({ taskRef: 'OpaqueRef:provision-task', provider: 'xapi', stage: 'provision' });
    await expect(client.getVmRecordByRef('OpaqueRef:cloned-vm')).resolves.toEqual(expect.objectContaining({ uuid: 'vm-uuid' }));
    expect(client.capabilities().provisioning).toBe(true);
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

  it('opens a standalone Xen console through the pinned SSH transport', async () => {
    const { Client } = require('ssh2');
    Client.responses.push({ stdout: 'xl' }, { stdout: '' });
    const client = new XenRawClient({ sshHost: 'dom0.test', sshUsername: 'svc', sshPrivateKey: 'KEY' });
    const descriptor = await client.openConsole('uuid-web');
    expect(descriptor.protocol).toBe('serial');
    expect(Client.commands).toEqual(['if command -v xl >/dev/null 2>&1; then printf xl; elif command -v xm >/dev/null 2>&1; then printf xm; else exit 127; fi',
      "LC_ALL=C xl console 'uuid-web'"]);
    descriptor.close();
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

describe('XAPI placement and HA mutations', () => {
  it('uses documented VM and VM_group methods with explicit member sets', async () => {
    const client = new XapiClient({ endpoint: 'https://xapi', username: 'root', password: 'secret', protocol: 'json' });
    client._call = jest.fn(async method => method === 'VM_group.create' ? 'OpaqueRef:group-new' : null);
    await client.setVmHaPolicy('OpaqueRef:vm', { haRestartPriority: 'restart', order: 2, startDelay: 30 });
    await client.setVmAffinity('OpaqueRef:vm', 'OpaqueRef:host');
    const group = await client.createVmGroup({ name: 'database replicas', placement: 'anti_affinity' });
    await client.setVmGroups('OpaqueRef:vm', [group.ref]);
    await client.destroyVmGroup(group.ref);
    expect(client._call).toHaveBeenCalledWith('VM.set_ha_restart_priority', ['OpaqueRef:vm', 'restart']);
    expect(client._call).toHaveBeenCalledWith('VM.set_order', ['OpaqueRef:vm', 2]);
    expect(client._call).toHaveBeenCalledWith('VM.set_start_delay', ['OpaqueRef:vm', 30]);
    expect(client._call).toHaveBeenCalledWith('VM.set_affinity', ['OpaqueRef:vm', 'OpaqueRef:host']);
    expect(client._call).toHaveBeenCalledWith('VM_group.create', [expect.objectContaining({ name_label: 'database replicas', placement: 'anti_affinity' })]);
    expect(client._call).toHaveBeenCalledWith('VM.set_groups', ['OpaqueRef:vm', ['OpaqueRef:group-new']]);
    expect(client._call).toHaveBeenCalledWith('VM_group.destroy', ['OpaqueRef:group-new']);
  });
});
