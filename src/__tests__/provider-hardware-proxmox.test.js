'use strict';

const { ProxmoxClient, _internals } = require('../services/proxmox');

describe('Proxmox VM hardware parsing', () => {
  it('parses QEMU disks, NICs, storage backing, VLAN, and guest-agent addresses', () => {
    const result = _internals._parseProxmoxHardware({
      hotplug: 'network,disk,usb', agent: '1',
      scsi0: 'local-lvm:vm-101-disk-0,size=32G,discard=on,iothread=1',
      ide2: 'local:iso/debian.iso,media=cdrom,size=700M',
      net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=120,firewall=1,rate=50',
    }, 'qemu', [{
      'hardware-address': 'AA:BB:CC:DD:EE:FF',
      'ip-addresses': [{ 'ip-address': '10.0.0.5', prefix: 24 }],
    }]);
    expect(result.disks).toEqual(expect.arrayContaining([
      expect.objectContaining({ device: 'scsi0', capacityBytes: 32 * 1024 ** 3, backing: expect.objectContaining({ storageId: 'local-lvm' }) }),
      expect.objectContaining({ device: 'ide2', type: 'cdrom' }),
    ]));
    expect(result.nics[0]).toEqual(expect.objectContaining({
      model: 'virtio', network: expect.objectContaining({ bridge: 'vmbr0', vlanId: '120' }),
      addresses: [{ address: '10.0.0.5', prefixLength: 24, source: 'guest-agent' }],
      capabilities: expect.objectContaining({ hotPlug: true }),
    }));
  });

  it('parses LXC rootfs, mount points, static addresses, and link state', () => {
    const result = _internals._parseProxmoxHardware({
      rootfs: 'local-lvm:vm-202-disk-0,size=8G', mp0: 'tank:subvol-202-disk-1,mp=/data,size=4G,ro=1',
      net0: 'name=eth0,bridge=vmbr1,hwaddr=02:00:00:00:00:01,ip=192.0.2.4/24,tag=5,link_down=1',
    }, 'lxc');
    expect(result.disks).toHaveLength(2);
    expect(result.disks[0]).toEqual(expect.objectContaining({ type: 'rootfs', capacityBytes: 8 * 1024 ** 3 }));
    expect(result.nics[0]).toEqual(expect.objectContaining({
      device: 'eth0', addresses: [{ address: '192.0.2.4', prefixLength: '24', source: 'configuration' }],
      status: 'disconnected',
    }));
  });

  it('reads only Proxmox migration preconditions, config and target fabric endpoints', async () => {
    const client = new ProxmoxClient({ endpoint: 'https://pve:8006', tokenId: 'a@b!c', tokenSecret: 'x' });
    client._request = jest.fn(async (_method, path) => path.endsWith('/storage') || path.endsWith('/network') ? [] : {});
    await client.getVmMigrationPreconditions('pve-a', 'qemu', 101);
    await client.getVmConfig('pve-a', 'qemu', 101);
    await client.getNodeMigrationInventory('pve-b');
    expect(client._request.mock.calls).toEqual([
      ['GET', '/api2/json/nodes/pve-a/qemu/101/migrate'],
      ['GET', '/api2/json/nodes/pve-a/qemu/101/config'],
      ['GET', '/api2/json/nodes/pve-b/storage'],
      ['GET', '/api2/json/nodes/pve-b/network'],
    ]);
    await expect(client.getVmMigrationPreconditions('../unsafe', 'qemu', 101))
      .rejects.toEqual(expect.objectContaining({ code: 'INVALID_PROVIDER_RESOURCE' }));
  });
});
