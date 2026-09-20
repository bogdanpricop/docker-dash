'use strict';

process.env.APP_SECRET = 'test-vm-nic-clients';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const { ProxmoxClient } = require('../services/proxmox');
const { VSphereClient } = require('../services/vsphere');
const { XapiClient } = require('../services/xen');

describe('provider-native existing NIC link mutations', () => {
  it('changes only Proxmox link_down and binds the write to the config digest', async () => {
    const client = new ProxmoxClient({
      endpoint: 'https://pve.example.test:8006', tokenId: 'root@pam!dash', tokenSecret: 'secret',
    });
    client._request = jest.fn()
      .mockResolvedValueOnce({ digest: 'a'.repeat(40), net0: 'virtio=AA:BB,bridge=vmbr0,tag=10' })
      .mockResolvedValueOnce(null);
    await expect(client.setVmNicLinkState('pve-a', 101, 'qemu', 'net0', false))
      .resolves.toEqual(expect.objectContaining({ synchronous: true, provider: 'proxmox', unchanged: false }));
    expect(client._request).toHaveBeenNthCalledWith(2, 'PUT', '/api2/json/nodes/pve-a/qemu/101/config', {
      net0: 'virtio=AA:BB,bridge=vmbr0,tag=10,link_down=1', digest: 'a'.repeat(40),
    });
    client._agent.destroy();
  });

  it('edits only vSphere connectable state and preserves start/guest-control values', async () => {
    const client = new VSphereClient({ endpoint: 'https://vcenter.example.test', username: 'admin', password: 'secret' });
    client._reconfigureVmDisk = jest.fn(async () => ({ taskRef: 'task-1', provider: 'vsphere' }));
    const result = await client.setVmNicLinkState('vm-42', {
      nativeRef: 4000, deviceType: 'VirtualVmxnet3',
      attachment: { connected: true, startConnected: true, allowGuestControl: false },
    }, false);
    expect(result).toEqual({ taskRef: 'task-1', provider: 'vsphere', unchanged: false });
    const change = client._reconfigureVmDisk.mock.calls[0][1];
    expect(change).toContain('<operation>edit</operation>');
    expect(change).toContain('<key>4000</key>');
    expect(change).toContain('<startConnected>true</startConnected>');
    expect(change).toContain('<allowGuestControl>false</allowGuestControl>');
    expect(change).toContain('<connected>false</connected>');
    expect(change).not.toMatch(/remove|fileOperation/);
    client._agent.destroy();
  });

  it('uses only XenAPI VIF plug/unplug and requires the current allowed operation', async () => {
    const client = Object.create(XapiClient.prototype);
    client._call = jest.fn()
      .mockResolvedValueOnce({ currently_attached: true, allowed_operations: ['unplug'] })
      .mockResolvedValueOnce('OpaqueRef:task');
    await expect(client.setVmNicLinkState('OpaqueRef:vif', false)).resolves.toEqual({
      taskRef: 'OpaqueRef:task', provider: 'xapi', unchanged: false,
    });
    expect(client._call).toHaveBeenNthCalledWith(1, 'VIF.get_record', ['OpaqueRef:vif']);
    expect(client._call).toHaveBeenNthCalledWith(2, 'Async.VIF.unplug', ['OpaqueRef:vif']);
  });
});
