'use strict';

const YAML = require('yaml');
const customization = require('../services/provider-operations/guest-customization');

function sshKey(algorithm = 'ssh-ed25519') {
  const name = Buffer.from(algorithm);
  const key = Buffer.alloc(4 + name.length + 4 + 32, 7);
  key.writeUInt32BE(name.length, 0); name.copy(key, 4); key.writeUInt32BE(32, 4 + name.length);
  return `${algorithm} ${key.toString('base64')} deploy@example`;
}

describe('structured Linux guest customization', () => {
  it('normalizes a static profile and exposes fingerprints instead of public-key material', () => {
    const key = sshKey();
    const value = customization.normalize({
      osFamily: 'linux', hostname: 'APP-01', domain: 'Example.Internal',
      timezone: 'Europe/Bucharest', user: 'deploy', sshAuthorizedKeys: [key, key],
      network: {
        mode: 'static', interfaceName: 'ens18', address: '192.0.2.10/24', gateway: '192.0.2.1',
        dnsServers: ['1.1.1.1', '9.9.9.9'], searchDomains: ['Example.Internal'],
      },
    });
    expect(value).toMatchObject({ hostname: 'app-01', domain: 'example.internal', sshAuthorizedKeys: [key] });
    const safe = customization.summary(value);
    expect(safe).toMatchObject({ enabled: true, sshKeyCount: 1, sshKeyFingerprints: [expect.stringMatching(/^SHA256:/)] });
    expect(JSON.stringify(safe)).not.toContain(key);
  });

  it('renders safe cloud-init and network v2 YAML without passwords or commands', () => {
    const value = customization.normalize({
      hostname: 'app-01', domain: 'example.internal', user: 'deploy', sshAuthorizedKeys: [sshKey()],
      network: { mode: 'static', interfaceName: 'ens18', address: '192.0.2.10/25', gateway: '192.0.2.1', dnsServers: ['1.1.1.1'] },
    });
    const cloud = customization.renderCloudConfig(value);
    const cloudDoc = YAML.parse(cloud.replace(/^#cloud-config\n/, ''));
    expect(cloudDoc).toMatchObject({ hostname: 'app-01', fqdn: 'app-01.example.internal', disable_root: true, ssh_pwauth: false });
    expect(cloudDoc.users[1]).toMatchObject({ name: 'deploy', lock_passwd: true });
    expect(cloud).not.toMatch(/password|runcmd|bootcmd/i);
    expect(YAML.parse(customization.renderNetworkConfig(value))).toEqual({
      version: 2,
      ethernets: { ens18: {
        dhcp4: false, dhcp6: false, addresses: ['192.0.2.10/25'],
        routes: [{ to: '0.0.0.0/0', via: '192.0.2.1' }], nameservers: { addresses: ['1.1.1.1'] },
      } },
    });
    expect(customization.prefixToNetmask(25)).toBe('255.255.255.128');
  });

  it.each([
    [{ osFamily: 'windows', hostname: 'app-01' }, 'GUEST_OS_CUSTOMIZATION_UNAVAILABLE'],
    [{ hostname: 'bad_name' }, 'INVALID_GUEST_CUSTOMIZATION'],
    [{ hostname: 'app-01', password: 'secret' }, 'INVALID_GUEST_CUSTOMIZATION'],
    [{ hostname: 'app-01', sshAuthorizedKeys: ['-----BEGIN PRIVATE KEY-----'] }, 'INVALID_GUEST_CUSTOMIZATION'],
    [{ hostname: 'app-01', network: { mode: 'static', address: '192.0.2.10/24' } }, 'INVALID_GUEST_CUSTOMIZATION'],
    [{ hostname: 'app-01', network: { mode: 'dhcp', runcmd: ['unsafe'] } }, 'INVALID_GUEST_CUSTOMIZATION'],
  ])('rejects unsupported or unsafe input %#', (input, code) => {
    expect(() => customization.normalize(input)).toThrow(expect.objectContaining({ code }));
  });
});
