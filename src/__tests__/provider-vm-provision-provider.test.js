'use strict';

jest.mock('../services/provider-sdk/artifact-catalog', () => ({}));
jest.mock('../services/provider-sdk/identity-store', () => ({}));
jest.mock('../services/provider-sdk/resource-schema', () => ({ normalizeResource: jest.fn() }));
jest.mock('../services/proxmox', () => ({}));
jest.mock('../services/vsphere', () => ({}));
jest.mock('../services/xen', () => ({}));

const bridge = require('../services/provider-operations/provision-provider');
const guest = require('../services/provider-operations/guest-customization');

describe('provider create-from-template bridge', () => {
  it('renders structured customization into Xen Orchestra create_vm payloads', async () => {
    const cloneTemplate = jest.fn(async () => ({ taskRef: 'task-1', provider: 'xo' }));
    const target = {
      host: { id: 7, daemon_type: 'xen' }, resolved: { nativeRef: 'template-1' },
      artifact: { provenance: { pool: 'pool-1' } }, template: { pool: 'pool-1' },
      client: { provider: 'xo', cloneTemplate },
    };
    const customization = guest.normalize({
      hostname: 'app-01', domain: 'example.internal', user: 'deploy',
      network: { mode: 'dhcp', interfaceName: 'eth0', dnsServers: ['1.1.1.1'] },
    });
    await expect(bridge.submit(target, {
      name: 'app-01', mode: 'full', storageId: null, customization,
    }, {})).resolves.toEqual({ taskRef: 'task-1', provider: 'xo' });
    expect(cloneTemplate).toHaveBeenCalledWith('template-1', 'app-01', expect.objectContaining({
      mode: 'full', poolId: 'pool-1',
      cloudConfig: expect.stringContaining('hostname: app-01'),
      networkConfig: expect.stringContaining('dhcp4: true'),
    }));
  });

  it('fails closed for direct XAPI customization before clone submission', async () => {
    const cloneTemplate = jest.fn();
    const target = {
      host: { id: 7, daemon_type: 'xen' }, resolved: { nativeRef: 'OpaqueRef:template' },
      artifact: { provenance: {} }, template: {},
      client: { provider: 'xapi', cloneTemplate },
    };
    await expect(bridge.submit(target, {
      name: 'app-01', mode: 'linked', storageId: null,
      customization: guest.normalize({ hostname: 'app-01' }),
    }, {})).rejects.toMatchObject({ code: 'GUEST_CUSTOMIZATION_UNSUPPORTED', status: 409 });
    expect(cloneTemplate).not.toHaveBeenCalled();
  });

  it('targets a discovered Proxmox VM for separate idempotent customization verification', async () => {
    const configureCloudInit = jest.fn(async () => ({ configured: true }));
    const cloudInitStatus = jest.fn(async () => ({ configured: true }));
    const target = {
      host: { daemon_type: 'proxmox' }, client: { provider: 'proxmox', configureCloudInit, cloudInitStatus },
    };
    const found = { nativeRef: 'qemu/240', raw: { vmid: 240, node: 'pve-a' } };
    const customization = guest.normalize({ hostname: 'app-01' });
    await bridge.customize(target, found, customization);
    await expect(bridge.customizationStatus(target, found, customization)).resolves.toEqual({ configured: true });
    expect(configureCloudInit).toHaveBeenCalledWith('pve-a', '240', customization);
    expect(cloudInitStatus).toHaveBeenCalledWith('pve-a', '240', customization);
  });
});
