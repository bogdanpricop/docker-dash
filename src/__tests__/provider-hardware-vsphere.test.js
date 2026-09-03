'use strict';

const { _internals } = require('../services/vsphere');

describe('vSphere VM hardware parsing', () => {
  it('correlates controllers, virtual disks, distributed NICs, and guest addresses', () => {
    const devices = `<VirtualDevice xsi:type="VirtualLsiLogicController"><key>1000</key><busNumber>0</busNumber></VirtualDevice>
      <VirtualDevice xsi:type="VirtualDisk"><key>2000</key><deviceInfo><label>Hard disk 1</label></deviceInfo><controllerKey>1000</controllerKey><unitNumber>0</unitNumber>
        <capacityInBytes>34359738368</capacityInBytes><backing><fileName>[fast-ds] vm/vm.vmdk</fileName><datastore type="Datastore">datastore-12</datastore><thinProvisioned>true</thinProvisioned></backing>
        <connectable><connected>true</connected><startConnected>true</startConnected></connectable></VirtualDevice>
      <VirtualDevice xsi:type="VirtualVmxnet3"><key>4000</key><deviceInfo><label>Network adapter 1</label></deviceInfo><macAddress>00:50:56:AA:BB:CC</macAddress>
        <backing><port><switchUuid>dvs-uuid</switchUuid><portgroupKey>dvportgroup-8</portgroupKey></port></backing><connectable><connected>true</connected><startConnected>true</startConnected></connectable></VirtualDevice>`;
    const guest = `<GuestNicInfo><network>Servers</network><macAddress>00:50:56:AA:BB:CC</macAddress><connected>true</connected><ipConfig><ipAddress><ipAddress>192.0.2.10</ipAddress><prefixLength>24</prefixLength></ipAddress></ipConfig></GuestNicInfo>`;
    const result = _internals._parseVmHardware(devices, guest);
    expect(result.disks[0]).toEqual(expect.objectContaining({
      bus: 'lsilogic', capacityBytes: 34359738368, provisioning: 'thin',
      backing: expect.objectContaining({ storageId: 'datastore-12', storageName: 'fast-ds' }),
    }));
    expect(result.nics[0]).toEqual(expect.objectContaining({
      model: 'Vmxnet3', network: expect.objectContaining({ id: 'dvportgroup-8', name: 'Servers', distributedSwitch: 'dvs-uuid' }),
      addresses: [{ address: '192.0.2.10', source: 'vmware-tools' }],
    }));
  });

  it('parses host-scoped VMotion CPU and software compatibility evidence', () => {
    const result = _internals._parseVmotionCompatibility(`<QueryVMotionCompatibilityResponse xmlns="urn:vim25">
      <returnval><host type="HostSystem">host-21</host><compatibility>cpu</compatibility><compatibility>software</compatibility></returnval>
      <returnval><host type="HostSystem">host-22</host><compatibility>cpu</compatibility></returnval>
    </QueryVMotionCompatibilityResponse>`);
    expect(result).toEqual([
      { hostRef: 'host-21', compatibility: ['cpu', 'software'] },
      { hostRef: 'host-22', compatibility: ['cpu'] },
    ]);
  });

  it('normalizes physical NIC, standard-vSwitch MTU and teaming order read-only', () => {
    const physicalNics = `<ArrayOfPhysicalNic>
      <PhysicalNic><key>key-vim.host.PhysicalNic-vmnic0</key><device>vmnic0</device><driver>ixgben</driver>
        <linkSpeed><speedMb>10000</speedMb><duplex>true</duplex></linkSpeed><mac>00:11:22:33:44:55</mac></PhysicalNic>
      <PhysicalNic><key>key-vim.host.PhysicalNic-vmnic1</key><device>vmnic1</device><driver>ixgben</driver>
        <linkSpeed><speedMb>10000</speedMb><duplex>true</duplex></linkSpeed><mac>00:11:22:33:44:66</mac></PhysicalNic>
    </ArrayOfPhysicalNic>`;
    const switches = `<ArrayOfHostVirtualSwitch><HostVirtualSwitch>
      <key>key-vim.host.VirtualSwitch-vSwitch0</key><name>vSwitch0</name><mtu>9000</mtu>
      <pnic>key-vim.host.PhysicalNic-vmnic0</pnic><pnic>key-vim.host.PhysicalNic-vmnic1</pnic>
      <spec><policy><nicTeaming><policy>failover_explicit</policy><nicOrder>
        <activeNic>vmnic0</activeNic><standbyNic>vmnic1</standbyNic>
      </nicOrder></nicTeaming></policy></spec>
    </HostVirtualSwitch></ArrayOfHostVirtualSwitch>`;
    const result = _internals._parseHostNetworkEvidence({ hostRef: 'host-7', hostName: 'esx-a',
      physicalNicXml: physicalNics, virtualSwitchXml: switches });
    expect(result.physicalNics).toEqual([
      expect.objectContaining({ key: 'key-vim.host.PhysicalNic-vmnic0', device: 'vmnic0',
        linkState: 'up', speedMbps: 10000, duplex: 'full' }),
      expect.objectContaining({ device: 'vmnic1', linkState: 'up' }),
    ]);
    expect(result.switches).toEqual([expect.objectContaining({
      key: 'key-vim.host.VirtualSwitch-vSwitch0', name: 'vSwitch0', mtu: 9000,
      mode: 'active_backup', members: [
        expect.objectContaining({ device: 'vmnic0', role: 'active', adminState: 'up' }),
        expect.objectContaining({ device: 'vmnic1', role: 'standby', adminState: 'up' }),
      ],
    })]);
  });
});
