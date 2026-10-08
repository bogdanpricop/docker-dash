'use strict';

// v8.9.1-alpha.1 — tests for the Proxmox VE client scaffold.
// Mocked https module, no real Proxmox cluster in CI.

process.env.APP_SECRET = 'test-proxmox';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const mockHttps = {
  _handlers: [],
  _mockNext(handler) { this._handlers.push(handler); },
  Agent: function Agent(_opts) { this._mockAgent = true; },
  request(opts, cb) {
    const handler = this._handlers.shift();
    if (!handler) throw new Error('mockHttps: no queued handler; call _mockNext first');
    const req = {
      _writtenBody: null, _opts: opts, _cb: cb,
      write(buf) { this._writtenBody = buf; },
      end() { setImmediate(() => handler(opts, cb, this)); },
      on(_e, _fn) { /* mock: never fires 'error' */ },
      destroy() { /* mock: no-op */ },
    };
    return req;
  },
};
jest.mock('https', () => mockHttps);

const { ProxmoxClient, fromHostRow, encryptDaemonConfig, decryptDaemonConfig } = require('../services/proxmox');

function fakeResponse({ status = 200, body = null }) {
  const bufChunks = [];
  if (body !== null) bufChunks.push(Buffer.from(JSON.stringify(body)));
  const listeners = {};
  return {
    statusCode: status,
    on(event, fn) { listeners[event] = fn; },
    _fire() {
      if (bufChunks.length && listeners.data) listeners.data(bufChunks[0]);
      if (listeners.end) listeners.end();
    },
  };
}

describe('ProxmoxClient (v8.9.1-alpha.1)', () => {
  beforeEach(() => { mockHttps._handlers.length = 0; });

  describe('constructor', () => {
    it('rejects missing endpoint', () => {
      expect(() => new ProxmoxClient({ tokenId: 'a@b!c', tokenSecret: 'x' }))
        .toThrow(/endpoint required/);
    });

    it('rejects missing token', () => {
      expect(() => new ProxmoxClient({ endpoint: 'https://pve:8006' }))
        .toThrow(/tokenId.*tokenSecret required/);
    });

    it('rejects malformed tokenId', () => {
      expect(() => new ProxmoxClient({
        endpoint: 'https://pve:8006', tokenId: 'not-formatted', tokenSecret: 'x',
      })).toThrow(/USER@REALM!TOKENID/);
    });

    it('accepts a well-formed config', () => {
      expect(() => new ProxmoxClient({
        endpoint: 'https://pve.example.com:8006',
        tokenId: 'root@pam!docker-dash', tokenSecret: 'uuid-here',
      })).not.toThrow();
    });
  });

  describe('auth header + response envelope', () => {
    it('sends the PVEAPIToken Authorization header', async () => {
      let receivedAuth;
      mockHttps._mockNext((opts, cb, _req) => {
        receivedAuth = opts.headers.Authorization;
        const res = fakeResponse({
          status: 200,
          body: { data: { version: '8.1.4', release: '8.1', repoid: 'abc123' } },
        });
        cb(res); res._fire();
      });
      const client = new ProxmoxClient({
        endpoint: 'https://pve.example.com:8006',
        tokenId: 'root@pam!docker-dash',
        tokenSecret: 'my-uuid',
      });
      const info = await client.version();
      expect(receivedAuth).toBe('PVEAPIToken=root@pam!docker-dash=my-uuid');
      // Data envelope unwrapped.
      expect(info.version).toBe('8.1.4');
    });

    it('surfaces Proxmox errors with structured message', async () => {
      mockHttps._mockNext((_opts, cb, _req) => {
        const res = fakeResponse({
          status: 401,
          body: { data: null, errors: { 'PVEAPIToken': 'invalid token' } },
        });
        cb(res); res._fire();
      });
      const client = new ProxmoxClient({
        endpoint: 'https://pve:8006', tokenId: 'a@b!c', tokenSecret: 'x',
      });
      await expect(client.version()).rejects.toMatchObject({
        status: 401,
        message: expect.stringMatching(/PVEAPIToken.*invalid token/),
      });
    });

    it('listVMs returns [] when data missing', async () => {
      mockHttps._mockNext((_opts, cb, _req) => {
        const res = fakeResponse({ status: 200, body: { data: null } });
        cb(res); res._fire();
      });
      const client = new ProxmoxClient({
        endpoint: 'https://pve:8006', tokenId: 'a@b!c', tokenSecret: 'x',
      });
      expect(await client.listVMs()).toEqual([]);
    });

    it('listLXC filters cluster/resources by type=lxc', async () => {
      let receivedPath;
      mockHttps._mockNext((opts, cb, _req) => {
        receivedPath = opts.path;
        const res = fakeResponse({
          status: 200,
          body: { data: [
            { type: 'qemu', vmid: 100, name: 'web-vm' },
            { type: 'lxc',  vmid: 101, name: 'db-lxc' },
            { type: 'storage', storage: 'local' },
          ] },
        });
        cb(res); res._fire();
      });
      const client = new ProxmoxClient({
        endpoint: 'https://pve:8006', tokenId: 'a@b!c', tokenSecret: 'x',
      });
      const lxc = await client.listLXC();
      expect(receivedPath).toBe('/api2/json/cluster/resources');
      expect(lxc).toHaveLength(1);
      expect(lxc[0]).toMatchObject({ type: 'lxc', vmid: 101, name: 'db-lxc' });
    });

    it('reads cluster and HA evidence only from the documented GET endpoints', async () => {
      const paths = [];
      for (const data of [
        [{ type: 'cluster', name: 'prod', quorate: 1 }],
        [{ type: 'master', node: 'pve-a', status: 'active' }],
        [{ sid: 'vm:101', state: 'started' }],
      ]) {
        mockHttps._mockNext((opts, cb) => {
          paths.push({ method: opts.method, path: opts.path });
          const res = fakeResponse({ status: 200, body: { data } });
          cb(res); res._fire();
        });
      }
      const client = new ProxmoxClient({ endpoint: 'https://pve:8006', tokenId: 'a@b!c', tokenSecret: 'x' });
      await expect(client.getClusterStatus()).resolves.toEqual([expect.objectContaining({ name: 'prod' })]);
      await expect(client.getHaStatus()).resolves.toEqual([expect.objectContaining({ type: 'master' })]);
      await expect(client.getHaResources()).resolves.toEqual([expect.objectContaining({ sid: 'vm:101' })]);
      expect(paths).toEqual([
        { method: 'GET', path: '/api2/json/cluster/status' },
        { method: 'GET', path: '/api2/json/cluster/ha/status/current' },
        { method: 'GET', path: '/api2/json/cluster/ha/resources' },
      ]);
    });

    it('reads Proxmox VE 9 affinity rules without using a mutation method', async () => {
      let request;
      mockHttps._mockNext((opts, cb) => {
        request = { method: opts.method, path: opts.path };
        const res = fakeResponse({ status: 200, body: { data: [{ rule: 'web-spread', type: 'resource-affinity' }] } });
        cb(res); res._fire();
      });
      const client = new ProxmoxClient({ endpoint: 'https://pve:8006', tokenId: 'a@b!c', tokenSecret: 'x' });
      await expect(client.getHaRules()).resolves.toEqual([{ rule: 'web-spread', type: 'resource-affinity' }]);
      expect(request).toEqual({ method: 'GET', path: '/api2/json/cluster/ha/rules' });
    });

    it('aggregates VM templates, ISO images and container templates', async () => {
      const replies = [
        [{ type: 'qemu', vmid: 9000, name: 'ubuntu-gold', template: 1, node: 'pve-a' }],
        [{ node: 'pve-a' }],
        [{ storage: 'local', active: 1, enabled: 1 }],
        [{ volid: 'local:iso/debian.iso', size: 1024 }],
        [{ volid: 'local:vztmpl/debian.tar.zst', size: 2048 }],
      ];
      for (const data of replies) mockHttps._mockNext((_opts, cb) => { const res = fakeResponse({ status: 200, body: { data } }); cb(res); res._fire(); });
      const client = new ProxmoxClient({ endpoint: 'https://pve:8006', tokenId: 'a@b!c', tokenSecret: 'x' });
      await expect(client.listArtifacts()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'vmTemplate', nativeRef: 'qemu/9000' }),
        expect.objectContaining({ kind: 'iso', nativeRef: 'local:iso/debian.iso' }),
        expect.objectContaining({ kind: 'containerTemplate', nativeRef: 'local:vztmpl/debian.tar.zst' }),
      ]));
    });

    it('submits a native power task and reads its terminal status', async () => {
      const paths = [];
      mockHttps._mockNext((opts, cb) => {
        paths.push(opts.path);
        const res = fakeResponse({ status: 200, body: { data: 'UPID:pve-a:0001:power-task' } });
        cb(res); res._fire();
      });
      mockHttps._mockNext((opts, cb) => {
        paths.push(opts.path);
        const res = fakeResponse({ status: 200, body: { data: { status: 'stopped', exitstatus: 'OK' } } });
        cb(res); res._fire();
      });
      const client = new ProxmoxClient({ endpoint: 'https://pve:8006', tokenId: 'a@b!c', tokenSecret: 'x' });
      const task = await client.vmPowerAction('pve-a', 101, 'qemu', 'start');
      expect(task).toEqual({ taskRef: 'UPID:pve-a:0001:power-task', node: 'pve-a', provider: 'proxmox' });
      await expect(client.getTaskStatus('pve-a', task.taskRef)).resolves.toEqual({ status: 'stopped', exitstatus: 'OK' });
      expect(paths[0]).toBe('/api2/json/nodes/pve-a/qemu/101/status/start');
      expect(paths[1]).toContain('/api2/json/nodes/pve-a/tasks/UPID%3Apve-a%3A0001%3Apower-task/status');
    });

    it('submits one bounded vzdump workload as a durable UPID task', async () => {
      let seen;
      mockHttps._mockNext((opts, cb, req) => {
        seen = { method: opts.method, path: opts.path, body: JSON.parse(req._writtenBody.toString()) };
        const res = fakeResponse({ status: 200, body: { data: 'UPID:pve-a:0003:vzdump-task' } });
        cb(res); res._fire();
      });
      const client = new ProxmoxClient({ endpoint: 'https://pve:8006', tokenId: 'a@b!c', tokenSecret: 'x' });
      await expect(client.startVmBackup('pve-a', 101, 'qemu', {
        storage: 'pbs-prod', mode: 'snapshot', compress: 'zstd', bwlimitKiB: 2048,
      })).resolves.toEqual({
        taskRef: 'UPID:pve-a:0003:vzdump-task', node: 'pve-a', vmid: 101,
        guestType: 'qemu', storage: 'pbs-prod', provider: 'proxmox',
      });
      expect(seen).toEqual({ method: 'POST', path: '/api2/json/nodes/pve-a/vzdump',
        body: { vmid: 101, storage: 'pbs-prod', mode: 'snapshot', compress: 'zstd', bwlimit: 2048 } });
      await expect(client.startVmBackup('../unsafe', 101, 'qemu', { storage: 'pbs-prod' }))
        .rejects.toMatchObject({ code: 'INVALID_BACKUP_EXECUTION' });
      expect(mockHttps._handlers).toHaveLength(0);
    });

    it('restores QEMU and LXC backups only as new, powered-off unique targets', async () => {
      const seen = [];
      for (const task of ['qemu-restore', 'lxc-restore']) {
        mockHttps._mockNext((opts, cb, req) => {
          seen.push({ method: opts.method, path: opts.path, body: JSON.parse(req._writtenBody.toString()) });
          const res = fakeResponse({ status: 200, body: { data: `UPID:pve-a:0004:${task}` } });
          cb(res); res._fire();
        });
      }
      const client = new ProxmoxClient({ endpoint: 'https://pve:8006', tokenId: 'a@b!c', tokenSecret: 'x' });
      await expect(client.restoreVmBackup('pve-a', 9123, 'qemu',
        'pbs-prod:backup/vm/101/2026-07-26T10:00:00Z', { storage: 'local-lvm', bwlimitKiB: 4096 }))
        .resolves.toEqual(expect.objectContaining({ taskRef: 'UPID:pve-a:0004:qemu-restore',
          guestType: 'qemu', startAfterRestore: false, overwrite: false }));
      await expect(client.restoreVmBackup('pve-a', 9124, 'lxc',
        'local:backup/vzdump-lxc-101.tar.zst', { storage: 'local-zfs' }))
        .resolves.toEqual(expect.objectContaining({ taskRef: 'UPID:pve-a:0004:lxc-restore', guestType: 'lxc' }));
      expect(seen).toEqual([
        { method: 'POST', path: '/api2/json/nodes/pve-a/qemu', body: {
          vmid: 9123, archive: 'pbs-prod:backup/vm/101/2026-07-26T10:00:00Z', storage: 'local-lvm',
          force: 0, unique: 1, start: 0, 'live-restore': 0, bwlimit: 4096,
        } },
        { method: 'POST', path: '/api2/json/nodes/pve-a/lxc', body: {
          vmid: 9124, ostemplate: 'local:backup/vzdump-lxc-101.tar.zst', storage: 'local-zfs',
          restore: 1, force: 0, unique: 1, start: 0,
        } },
      ]);
      await expect(client.restoreVmBackup('pve-a', 9125, 'qemu', 'pbs:backup/vm', {
        storage: 'local-lvm', force: true,
      })).rejects.toMatchObject({ code: 'INVALID_RECOVERY_RESTORE' });
      await expect(client.restoreVmBackup('pve-a', 9125, 'qemu', 'pbs:backup/vm', {
        storage: 'local-lvm', start: true,
      })).rejects.toMatchObject({ code: 'INVALID_RECOVERY_RESTORE' });
      expect(mockHttps._handlers).toHaveLength(0);
    });

    it('isolates, asserts and destroys only through bounded restore-drill endpoints', async () => {
      const seen = [];
      const replies = [
        { digest: 'a'.repeat(40), net0: 'virtio=AA:BB,bridge=vmbr0',
          net1: 'e1000=CC:DD,bridge=vmbr1,link_down=0' },
        null,
        { description: `Docker Dash restore drill pdrr_${'a'.repeat(26)}`,
          net0: 'virtio=AA:BB,bridge=vmbr0,link_down=1',
          net1: 'e1000=CC:DD,bridge=vmbr1,link_down=1' },
        { status: 'running' }, null, { result: { name: 'Debian', version: '13' } },
        'UPID:pve-a:destroy-drill',
      ];
      for (const data of replies) mockHttps._mockNext((opts, cb, req) => {
        seen.push({ method: opts.method, path: opts.path,
          body: req._writtenBody ? JSON.parse(req._writtenBody.toString()) : null });
        const res = fakeResponse({ status: 200, body: { data } }); cb(res); res._fire();
      });
      const client = new ProxmoxClient({ endpoint: 'https://pve:8006', tokenId: 'a@b!c', tokenSecret: 'x' });
      const marker = `Docker Dash restore drill pdrr_${'a'.repeat(26)}`;
      await expect(client.configureRestoreDrillIsolation('pve-a', 9123, 'qemu', marker))
        .resolves.toEqual(expect.objectContaining({ configured: true, networkCount: 2 }));
      await expect(client.verifyRestoreDrillIsolation('pve-a', 9123, 'qemu', marker))
        .resolves.toEqual(expect.objectContaining({ configured: true, isolatedCount: 2 }));
      await expect(client.getVmStatus('pve-a', 9123, 'qemu')).resolves.toEqual({ status: 'running' });
      await expect(client.pingGuestAgent('pve-a', 9123)).resolves.toEqual({ reachable: true, provider: 'proxmox' });
      await expect(client.getGuestAgentOsInfo('pve-a', 9123)).resolves.toEqual({ name: 'Debian', version: '13' });
      await expect(client.destroyRestoreDrillTarget('pve-a', 9123, 'qemu')).resolves.toEqual({
        taskRef: 'UPID:pve-a:destroy-drill', node: 'pve-a', provider: 'proxmox',
      });
      expect(seen[1]).toEqual({ method: 'PUT', path: '/api2/json/nodes/pve-a/qemu/9123/config', body: {
        description: marker, digest: 'a'.repeat(40), net0: 'virtio=AA:BB,bridge=vmbr0,link_down=1',
        net1: 'e1000=CC:DD,bridge=vmbr1,link_down=1',
      } });
      expect(seen[4]).toEqual({ method: 'POST', path: '/api2/json/nodes/pve-a/qemu/9123/agent/ping', body: {} });
      expect(seen[6]).toEqual({ method: 'DELETE', path: '/api2/json/nodes/pve-a/qemu/9123',
        body: { purge: 0, 'destroy-unreferenced-disks': 0 } });
      await expect(client.configureRestoreDrillIsolation('pve-a', 9123, 'qemu', 'unsafe'))
        .rejects.toMatchObject({ code: 'INVALID_RESTORE_DRILL' });
      expect(mockHttps._handlers).toHaveLength(0);
    });

    it('rejects unsupported LXC force resets before network access', async () => {
      const client = new ProxmoxClient({ endpoint: 'https://pve:8006', tokenId: 'a@b!c', tokenSecret: 'x' });
      await expect(client.vmPowerAction('pve-a', 101, 'lxc', 'forceReboot'))
        .rejects.toMatchObject({ code: 'PROVIDER_ACTION_UNAVAILABLE', status: 400 });
      expect(mockHttps._handlers).toHaveLength(0);
    });

    it('normalizes snapshot trees and submits a native snapshot task', async () => {
      const seen = [];
      mockHttps._mockNext((opts, cb) => {
        seen.push({ method: opts.method, path: opts.path });
        const res = fakeResponse({ status: 200, body: { data: [
          { name: 'current', parent: 'child' },
          { name: 'root', description: 'checkpoint', snaptime: 1767225600 },
          { name: 'child', parent: 'root', snaptime: 1767312000 },
        ] } });
        cb(res); res._fire();
      });
      mockHttps._mockNext((opts, cb, req) => {
        seen.push({ method: opts.method, path: opts.path, body: req._writtenBody?.toString() });
        const res = fakeResponse({ status: 200, body: { data: 'UPID:pve-a:0002:snapshot-task' } });
        cb(res); res._fire();
      });
      const client = new ProxmoxClient({ endpoint: 'https://pve:8006', tokenId: 'a@b!c', tokenSecret: 'x' });
      await expect(client.listVMSnapshots('pve-a', 101, 'qemu')).resolves.toEqual([
        expect.objectContaining({ nativeRef: 'root', name: 'root', parentRef: null }),
        expect.objectContaining({ nativeRef: 'child', name: 'child', parentRef: 'root', isCurrent: true }),
      ]);
      await expect(client.createVMSnapshot('pve-a', 101, 'qemu', {
        name: 'before-upgrade', description: 'release checkpoint',
      })).resolves.toEqual({ taskRef: 'UPID:pve-a:0002:snapshot-task', node: 'pve-a', provider: 'proxmox' });
      expect(seen[0]).toEqual({ method: 'GET', path: '/api2/json/nodes/pve-a/qemu/101/snapshot' });
      expect(seen[1]).toEqual(expect.objectContaining({ method: 'POST', path: '/api2/json/nodes/pve-a/qemu/101/snapshot' }));
      expect(JSON.parse(seen[1].body)).toEqual({
        snapname: 'before-upgrade', description: 'release checkpoint',
      });
    });

    it('rejects invalid snapshot targets before network access', async () => {
      const client = new ProxmoxClient({ endpoint: 'https://pve:8006', tokenId: 'a@b!c', tokenSecret: 'x' });
      await expect(client.listVMSnapshots('../unsafe', 101, 'qemu')).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESOURCE' });
      expect(mockHttps._handlers).toHaveLength(0);
    });

    it('creates and moves QEMU disks through bounded native API requests', async () => {
      const seen = [];
      const replies = [
        { digest: 'a'.repeat(40), scsi0: 'local-lvm:vm-101-disk-0,size=8G' },
        null,
        'UPID:pve-a:disk-move',
      ];
      for (const data of replies) mockHttps._mockNext((opts, cb, req) => {
        seen.push({ method: opts.method, path: opts.path,
          body: req._writtenBody ? JSON.parse(req._writtenBody.toString()) : null });
        const res = fakeResponse({ status: 200, body: { data } }); cb(res); res._fire();
      });
      const client = new ProxmoxClient({ endpoint: 'https://pve:8006', tokenId: 'a@b!c', tokenSecret: 'x' });
      await expect(client.createVmDisk('pve-a', 101, 'qemu', {
        device: 'scsi1', storage: 'fast-zfs', sizeBytes: 2 * 1024 ** 3,
      })).resolves.toEqual(expect.objectContaining({ synchronous: true, device: 'scsi1', allocatedBytes: 2 * 1024 ** 3 }));
      await expect(client.moveVmDisk('pve-a', 101, 'qemu', 'scsi1', 'archive-zfs'))
        .resolves.toEqual({ taskRef: 'UPID:pve-a:disk-move', node: 'pve-a', provider: 'proxmox' });
      expect(seen).toEqual([
        { method: 'GET', path: '/api2/json/nodes/pve-a/qemu/101/config', body: null },
        { method: 'PUT', path: '/api2/json/nodes/pve-a/qemu/101/config',
          body: { scsi1: 'fast-zfs:2', digest: 'a'.repeat(40) } },
        { method: 'POST', path: '/api2/json/nodes/pve-a/qemu/101/move_disk',
          body: { disk: 'scsi1', storage: 'archive-zfs', delete: 1 } },
      ]);
      await expect(client.createVmDisk('pve-a', 101, 'lxc', {
        device: 'scsi1', storage: 'fast-zfs', sizeBytes: 2 * 1024 ** 3,
      })).rejects.toMatchObject({ code: 'INVALID_VM_DISK_REQUEST' });
      expect(mockHttps._handlers).toHaveLength(0);
    });

    it('allocates an ID and submits a full template clone as a durable UPID task', async () => {
      const seen = [];
      mockHttps._mockNext((opts, cb) => {
        seen.push({ method: opts.method, path: opts.path });
        const res = fakeResponse({ status: 200, body: { data: 240 } }); cb(res); res._fire();
      });
      mockHttps._mockNext((opts, cb, req) => {
        seen.push({ method: opts.method, path: opts.path, body: JSON.parse(req._writtenBody.toString()) });
        const res = fakeResponse({ status: 200, body: { data: 'UPID:pve-a:clone-240' } }); cb(res); res._fire();
      });
      const client = new ProxmoxClient({ endpoint: 'https://pve:8006', tokenId: 'a@b!c', tokenSecret: 'x' });
      const newid = await client.nextVmId();
      await expect(client.cloneTemplate('pve-a', '9000', {
        newid, name: 'app-01', mode: 'full', targetNode: 'pve-b', storage: 'fast-zfs',
      })).resolves.toEqual({ taskRef: 'UPID:pve-a:clone-240', node: 'pve-a', targetVmid: '240', provider: 'proxmox' });
      expect(seen[0].path).toBe('/api2/json/cluster/nextid');
      expect(seen[1]).toEqual(expect.objectContaining({
        method: 'POST', path: '/api2/json/nodes/pve-a/qemu/9000/clone',
        body: { newid: 240, name: 'app-01', full: 1, target: 'pve-b', storage: 'fast-zfs' },
      }));
    });

    it('writes and verifies passwordless Cloud-Init fields on the cloned VM', async () => {
      const seen = [];
      const customization = {
        osFamily: 'linux', hostname: 'app-01', domain: 'example.internal', user: 'deploy',
        sshAuthorizedKeys: ['ssh-ed25519 AAAATEST deploy@example'],
        network: {
          mode: 'static', address: '192.0.2.10/24', gateway: '192.0.2.1',
          dnsServers: ['1.1.1.1', '9.9.9.9'], searchDomains: ['apps.example.internal'],
        },
      };
      const expected = {
        ciuser: 'deploy', sshkeys: 'ssh-ed25519 AAAATEST deploy@example',
        ipconfig0: 'ip=192.0.2.10/24,gw=192.0.2.1', nameserver: '1.1.1.1 9.9.9.9',
        searchdomain: 'example.internal apps.example.internal',
      };
      mockHttps._mockNext((opts, cb, req) => {
        seen.push({ method: opts.method, path: opts.path, body: JSON.parse(req._writtenBody.toString()) });
        const res = fakeResponse({ status: 200, body: { data: null } }); cb(res); res._fire();
      });
      mockHttps._mockNext((opts, cb) => {
        seen.push({ method: opts.method, path: opts.path });
        const res = fakeResponse({ status: 200, body: { data: expected } }); cb(res); res._fire();
      });
      const client = new ProxmoxClient({ endpoint: 'https://pve:8006', tokenId: 'a@b!c', tokenSecret: 'x' });
      await expect(client.configureCloudInit('pve-a', '240', customization)).resolves.toEqual({ configured: true, provider: 'proxmox' });
      await expect(client.cloudInitStatus('pve-a', '240', customization)).resolves.toEqual({ configured: true, provider: 'proxmox' });
      expect(seen[0]).toEqual({ method: 'PUT', path: '/api2/json/nodes/pve-a/qemu/240/config', body: expected });
      expect(seen[1]).toEqual({ method: 'GET', path: '/api2/json/nodes/pve-a/qemu/240/config' });
    });

    it('creates a server-side VNC proxy descriptor without losing token scoping', async () => {
      let seen;
      mockHttps._mockNext((opts, cb, req) => {
        seen = { method: opts.method, path: opts.path, body: JSON.parse(req._writtenBody.toString()) };
        const res = fakeResponse({ status: 200, body: { data: { port: 5901, ticket: 'PVEVNC:short-ticket' } } });
        cb(res); res._fire();
      });
      const client = new ProxmoxClient({
        endpoint: 'https://pve:8006', tokenId: 'svc@pve!console', tokenSecret: 'api-secret',
      });
      const ticket = await client.createVmConsoleProxy('pve-a', 'qemu', 101);
      const descriptor = client.vmConsoleWebSocket(ticket);
      expect(seen).toEqual({
        method: 'POST', path: '/api2/json/nodes/pve-a/qemu/101/vncproxy', body: { websocket: 1 },
      });
      expect(new URL(descriptor.url).pathname).toBe('/api2/json/nodes/pve-a/qemu/101/vncwebsocket');
      expect(descriptor.password).toBe('PVEVNC:short-ticket');
      expect(descriptor.headers.Authorization).toBe('PVEAPIToken=svc@pve!console=api-secret');
      await expect(client.createVmConsoleProxy('../unsafe', 'qemu', 101))
        .rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESOURCE' });
    });
  });

  it('deduplicates shared PBS recovery points and keeps repository URLs out of the result', async () => {
    const client = new ProxmoxClient({
      endpoint: 'https://pve:8006', tokenId: 'a@b!c', tokenSecret: 'x',
    });
    client.listNodes = jest.fn(async () => [{ node: 'pve-a' }, { node: 'pve-b' }]);
    client._request = jest.fn(async (_method, path) => {
      if (/\/storage$/.test(path)) return [{
        storage: 'pbs-prod', type: 'pbs', shared: 1, enabled: 1, active: 1,
        content: 'backup', total: 10000, used: 4000, url: 'pbs://token:secret@pbs.internal',
      }];
      if (/content\?content=backup$/.test(path)) return [{
        volid: 'pbs-prod:backup/vm/101/2026-07-26T10:00:00Z', vmid: 101,
        subtype: 'pbs-vm', ctime: 1785060000, size: 4096, protected: 1,
        verification: { state: 'verified', timestamp: 1785063600 },
      }];
      throw new Error(path);
    });
    const result = await client.listRecoveryPoints();
    expect(result.repositories).toEqual([expect.objectContaining({
      nativeRef: 'pbs-prod', type: 'pbs', supportsVerification: true,
    })]);
    expect(result.points).toEqual([expect.objectContaining({
      workloadRef: 'qemu/101', mode: 'incremental', protected: true,
    })]);
    expect(JSON.stringify(result)).not.toContain('pbs.internal');
    expect(client._request).toHaveBeenCalledTimes(4);
  });

  describe('daemon_config encryption', () => {
    it('round-trips encryptDaemonConfig / decryptDaemonConfig', () => {
      const cfg = {
        endpoint: 'https://pve:8006',
        tokenId: 'root@pam!docker-dash',
        tokenSecret: 'a-very-secret-uuid',
        skipTlsVerify: true,
      };
      const enc = encryptDaemonConfig(cfg);
      expect(enc).toMatch(/^enc:/);
      expect(enc).not.toContain('a-very-secret-uuid');
      expect(decryptDaemonConfig(enc)).toEqual(cfg);
    });

    it('accepts plaintext JSON for backward-compat', () => {
      const cfg = { endpoint: 'https://pve:8006', tokenId: 'a@b!c', tokenSecret: 'x' };
      expect(decryptDaemonConfig(JSON.stringify(cfg))).toEqual(cfg);
    });

    it('fromHostRow works with encrypted daemon_config', () => {
      const cfg = {
        endpoint: 'https://pve.example.com:8006',
        tokenId: 'root@pam!docker-dash',
        tokenSecret: 'uuid',
      };
      const enc = encryptDaemonConfig(cfg);
      const client = fromHostRow({ daemon_type: 'proxmox', daemon_config: enc });
      expect(client._config.endpoint).toBe('https://pve.example.com:8006');
    });

    it('fromHostRow rejects non-Proxmox rows', () => {
      expect(() => fromHostRow({ daemon_type: 'docker' })).toThrow(/not a Proxmox host/);
    });
  });
});

describe('Proxmox HA mutation wrappers', () => {
  it('uses scoped resource/rule endpoints without exposing transport details to callers', async () => {
    const client = new ProxmoxClient({ endpoint: 'https://pve:8006', tokenId: 'root@pam!dd', tokenSecret: 'secret' });
    client._request = jest.fn(async () => null);
    await client.updateHaResource('vm:100', { max_restart: 3 });
    await client.createHaRule({ type: 'resource-affinity', rule: 'db-web', affinity: 'separate' });
    await client.updateHaRule('db-web', { disable: 1 });
    await client.deleteHaRule('db-web');
    expect(client._request.mock.calls).toEqual([
      ['PUT', '/api2/json/cluster/ha/resources/vm%3A100', { max_restart: 3 }],
      ['POST', '/api2/json/cluster/ha/rules', { type: 'resource-affinity', rule: 'db-web', affinity: 'separate' }],
      ['PUT', '/api2/json/cluster/ha/rules/db-web', { disable: 1 }],
      ['DELETE', '/api2/json/cluster/ha/rules/db-web'],
    ]);
  });
});

describe('Proxmox storage replication reads', () => {
  it('uses read-only cluster definition and node status endpoints', async () => {
    const client = new ProxmoxClient({ endpoint: 'https://pve:8006', tokenId: 'root@pam!dd', tokenSecret: 'secret' });
    client._request = jest.fn(async () => []);
    await client.listStorageReplicationJobs();
    await client.getStorageReplicationStatus('pve-a', '101-0');
    expect(client._request.mock.calls).toEqual([
      ['GET', '/api2/json/cluster/replication'],
      ['GET', '/api2/json/nodes/pve-a/replication/101-0/status'],
    ]);
    await expect(client.getStorageReplicationStatus('../unsafe', '101-0'))
      .rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESOURCE' });
  });
});
