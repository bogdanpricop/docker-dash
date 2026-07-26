'use strict';

const hardware = require('../services/provider-sdk/vm-hardware');

const host = { id: 7 };
const resource = { id: `ddr_vm_${'a'.repeat(26)}` };

describe('common VM hardware contract', () => {
  it('normalizes opaque device identities, topology, totals, and tri-state evidence', () => {
    const result = hardware.normalizeVmHardware({ host, providerType: 'xen', resource, raw: {
      disks: [{
        nativeRef: 'OpaqueRef:VDI-secret', label: 'root', capacityBytes: 1000, allocatedBytes: 250,
        provisioning: 'thin', backing: { storageName: 'shared-sr', path: 'disk.vhd' },
        attachment: { connected: true }, capabilities: { hotPlug: true },
      }],
      nics: [{
        nativeRef: 'OpaqueRef:VIF-secret', macAddress: 'aa-bb-cc-dd-ee-ff',
        network: { name: 'servers', vlanId: 20 },
        addresses: [{ address: '10.0.0.8', prefixLength: 24, source: 'guest-agent' }],
        capabilities: { hotPlug: false, connectDisconnect: true },
      }],
    } });
    expect(result.summary).toEqual(expect.objectContaining({
      diskCount: 1, nicCount: 1, totalDiskCapacityBytes: 1000, totalDiskAllocatedBytes: 250,
    }));
    expect(result.disks[0]).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^ddh_disk_[a-f0-9]{26}$/), provisioning: 'thin',
      capabilities: { hotPlug: true, hotUnplug: null, onlineResize: null },
    }));
    expect(result.nics[0]).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^ddh_nic_[a-f0-9]{26}$/), macAddress: 'AA:BB:CC:DD:EE:FF',
    }));
    expect(JSON.stringify(result)).not.toContain('OpaqueRef:');
  });

  it('bounds collections and sanitizes warnings without inventing invalid addresses', () => {
    const result = hardware.normalizeVmHardware({ host, providerType: 'proxmox', resource, raw: {
      disks: Array.from({ length: hardware.MAX_DISKS + 2 }, (_, index) => ({ nativeRef: index, label: `disk-${index}` })),
      nics: [{ nativeRef: 'net0', addresses: ['not-an-ip'] }], diskWarnings: ['token=super-secret'],
    } });
    expect(result.disks).toHaveLength(hardware.MAX_DISKS);
    expect(result.sections.disks.truncated).toBe(true);
    expect(result.nics[0].addresses).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('super-secret');
  });
});
