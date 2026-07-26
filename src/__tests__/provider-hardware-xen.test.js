'use strict';

const { XenOrchestraClient, XapiClient, XenRawClient } = require('../services/xen');

describe('Xen VM hardware inventory', () => {
  it('reads Xen Orchestra VBD/VDI/SR and VIF/network relations', async () => {
    const client = new XenOrchestraClient({ endpoint: 'https://xo.test', token: 'token' });
    const records = {
      'vms/vm-1': { $VBDs: ['vbd-1'], $VIFs: ['vif-1'] },
      'vbds/vbd-1': { userdevice: '0', device: 'xvda', type: 'Disk', mode: 'RW', currently_attached: true, bootable: true, unpluggable: true, allowed_operations: ['unplug'], $VDI: 'vdi-1' },
      'vdis/vdi-1': { name_label: 'root', virtual_size: 1000, physical_utilisation: 500, $SR: 'sr-1', allowed_operations: ['resize_online'], sm_config: { allocation: 'thin' } },
      'srs/sr-1': { name_label: 'Shared SR', type: 'nfs', shared: true },
      'vifs/vif-1': { device: '0', MAC: 'AA:BB:CC:DD:EE:FF', MTU: 1500, currently_attached: true, allowed_operations: ['unplug'], locking_mode: 'locked', $network: 'net-1' },
      'networks/net-1': { name_label: 'Servers', bridge: 'xapi0', MTU: 1500 },
    };
    client._resource = jest.fn(async (collection, id) => records[`${collection}/${id}`]);
    const result = await client.getVmHardware('vm-1');
    expect(result.disks[0]).toEqual(expect.objectContaining({
      device: 'xvda', capacityBytes: 1000, backing: expect.objectContaining({ storageName: 'Shared SR' }),
    }));
    expect(result.nics[0]).toEqual(expect.objectContaining({
      macAddress: 'AA:BB:CC:DD:EE:FF', network: expect.objectContaining({ name: 'Servers', bridge: 'xapi0' }),
    }));
  });

  it('reads direct XAPI device records and guest metrics', async () => {
    const client = new XapiClient({ endpoint: 'https://xapi.test', username: 'root', password: 'secret' });
    const calls = {
      'VM.get_record': { VBDs: ['OpaqueRef:vbd'], VIFs: ['OpaqueRef:vif'], guest_metrics: 'OpaqueRef:metrics' },
      'VM_guest_metrics.get_record': { networks: { '0/ip': '198.51.100.7' } },
      'VBD.get_record': { VDI: 'OpaqueRef:vdi', device: 'xvda', userdevice: '0', type: 'Disk', mode: 'RW', currently_attached: true, unpluggable: true, allowed_operations: ['unplug'] },
      'VDI.get_record': { name_label: 'root', virtual_size: '2048', physical_utilisation: '1024', SR: 'OpaqueRef:sr', allowed_operations: ['resize_online'] },
      'SR.get_record': { uuid: 'sr-uuid', name_label: 'Local SR', type: 'lvm' },
      'VIF.get_record': { network: 'OpaqueRef:network', device: '0', MAC: '00:16:3E:00:00:01', MTU: 1500, currently_attached: true, allowed_operations: ['unplug'] },
      'network.get_record': { uuid: 'network-uuid', name_label: 'LAN', bridge: 'xenbr0', MTU: 1500 },
    };
    client._call = jest.fn(async method => calls[method]);
    const result = await client.getVmHardware('OpaqueRef:vm');
    expect(result.disks[0]).toEqual(expect.objectContaining({ device: 'xvda', allocatedBytes: '1024' }));
    expect(result.nics[0].addresses).toEqual([{ address: '198.51.100.7', source: 'xapi-guest-metrics' }]);
  });

  it('labels standalone xl/xm runtime topology as incomplete', async () => {
    const client = new XenRawClient({ sshHost: 'xen.test', sshUsername: 'root', sshPassword: 'secret' });
    client._tool = jest.fn(async args => args.startsWith('block-list')
      ? { stdout: 'Vdev BE handle state evt-ch ring-ref BE-path\n51712 0 1 4 10 11 /local/domain/0/backend/vbd/4/51712\n' }
      : { stdout: 'Idx BE MAC Addr. handle state evt-ch tx-/rx-ring-ref BE-path\n0 0 00:16:3e:11:22:33 1 4 10 11 /local/domain/0/backend/vif/4/0\n' });
    const result = await client.getVmHardware('4');
    expect(result.disks).toHaveLength(1);
    expect(result.nics[0]).toEqual(expect.objectContaining({ macAddress: '00:16:3e:11:22:33' }));
    expect(result.diskWarnings.join(' ')).toMatch(/runtime/i);
    expect(result.disks[0].capabilities.hotPlug).toBe(false);
  });

  it('uses XAPI possible-host and assert-can-boot evidence without mutating the VM', async () => {
    const client = new XapiClient({ endpoint: 'https://xapi.test', username: 'root', password: 'secret' });
    client._call = jest.fn(async (method, params) => {
      if (method === 'VM.get_record') return {
        resident_on: 'OpaqueRef:host-a', allowed_operations: ['pool_migrate'],
      };
      if (method === 'VM.get_possible_hosts') return ['OpaqueRef:host-a', 'OpaqueRef:host-b'];
      if (method === 'VM.assert_can_boot_here' && params[1] === 'OpaqueRef:host-b') return undefined;
      if (method === 'VM.assert_can_boot_here') throw Object.assign(new Error('cannot boot'), { code: 'VM_BAD_POWER_STATE' });
      throw new Error(`Unexpected ${method}`);
    });
    const result = await client.getVmMigrationCompatibility('OpaqueRef:vm', ['OpaqueRef:host-a', 'OpaqueRef:host-b']);
    expect(result.sourceRef).toBe('OpaqueRef:host-a');
    expect(result.candidates[1]).toEqual(expect.objectContaining({
      targetRef: 'OpaqueRef:host-b', modes: expect.objectContaining({ live: 'conditional', cold: 'conditional' }),
    }));
    expect(client._call.mock.calls.map(call => call[0])).not.toEqual(expect.arrayContaining(['VM.pool_migrate', 'VM.migrate_send']));
  });

  it('keeps XAPI compatibility unknown when an older host lacks the assertion method', async () => {
    const client = new XapiClient({ endpoint: 'https://xapi.test', username: 'root', password: 'secret' });
    client._call = jest.fn(async method => {
      if (method === 'VM.get_record') return { resident_on: 'OpaqueRef:host-a', allowed_operations: [] };
      if (method === 'VM.get_possible_hosts') throw Object.assign(new Error('missing'), { code: 'MESSAGE_METHOD_UNKNOWN' });
      throw Object.assign(new Error('missing'), { code: 'MESSAGE_METHOD_UNKNOWN' });
    });
    const result = await client.getVmMigrationCompatibility('OpaqueRef:vm', ['OpaqueRef:host-b']);
    expect(result.candidates[0].checks.map(check => check.state)).toEqual(['unknown', 'unknown']);
    expect(result.candidates[0].blockers).toEqual([]);
    expect(result.candidates[0].modes.live).toBe('unknown');
  });

  it('submits and cancels XAPI migration as durable asynchronous tasks', async () => {
    const client = new XapiClient({ endpoint: 'https://xapi.test', username: 'root', password: 'secret' });
    client._call = jest.fn(async method => method === 'VM.get_by_uuid'
      ? 'OpaqueRef:vm' : method === 'task.get_by_uuid' ? 'OpaqueRef:task' : 'OpaqueRef:new-task');
    await expect(client.migrateVm('vm-uuid', 'OpaqueRef:host-b', { live: true }))
      .resolves.toEqual({ taskRef: 'OpaqueRef:new-task', provider: 'xapi' });
    expect(client._call).toHaveBeenCalledWith('Async.VM.pool_migrate', [
      'OpaqueRef:vm', 'OpaqueRef:host-b', { live: 'true' },
    ]);
    await expect(client.cancelTask('task-uuid')).resolves.toEqual({ ok: true, provider: 'xapi' });
    expect(client._call).toHaveBeenCalledWith('task.cancel', ['OpaqueRef:task']);
  });

  it('enables Xen Orchestra migration only from a recognized runtime OpenAPI schema', async () => {
    const client = new XenOrchestraClient({ endpoint: 'https://xo.test', token: 'token' });
    client._request = jest.fn(async (method, path, body) => {
      if (method === 'GET') return {
        paths: {
          '/rest/v0/vms/{id}/actions/migrate': {
            post: { requestBody: { content: { 'application/json': { schema: {
              type: 'object', properties: { targetHost: { type: 'string' }, targetSr: { type: 'string' } },
            } } } } },
          },
        },
      };
      expect(path).toBe('/rest/v0/vms/vm-1/actions/migrate');
      expect(body).toEqual({ targetHost: 'host-2', targetSr: 'sr-3' });
      return { task: 'task-9' };
    });
    await client._discoverRestFeatures();
    expect(client.capabilities().migrationExecute).toBe(true);
    await expect(client.migrateVm('vm-1', 'host-2', { targetStorage: 'sr-3' }))
      .resolves.toEqual({ taskRef: 'task-9', provider: 'xo' });

    client._request.mockResolvedValueOnce({ paths: {
      '/rest/v0/vms/{id}/actions/migrate': { post: { requestBody: { properties: { destination: {} } } } },
    } });
    await client._discoverRestFeatures();
    expect(client.capabilities().migrationExecute).toBe(false);
  });
});
