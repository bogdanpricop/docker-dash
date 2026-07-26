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
});
