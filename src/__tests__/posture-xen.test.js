'use strict';

process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';

const xenCheck = require('../services/posture/checks/xen');
const { encryptDaemonConfig } = require('../services/xen');

describe('Xen posture check', () => {
  it('flags unverified TLS and plaintext credential storage', async () => {
    const findings = await xenCheck.run({ hosts: [{
      id: 1, name: 'xcp', daemon_type: 'xen',
      daemon_config: JSON.stringify({ provider: 'xapi', username: 'root', password: 'secret', skipTlsVerify: true }),
    }] });
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkId: 'xen.credential-unencrypted', severity: 'high' }),
      expect.objectContaining({ checkId: 'xen.tls-verify-disabled', severity: 'high' }),
    ]));
  });

  it('flags raw password auth and an unpinned host key', async () => {
    const findings = await xenCheck.run({ hosts: [{
      id: 2, name: 'dom0', daemon_type: 'xen',
      daemon_config: encryptDaemonConfig({ provider: 'raw', sshHost: 'dom0', sshUsername: 'svc', sshPassword: 'secret' }),
    }] });
    expect(findings.map(finding => finding.checkId).sort()).toEqual(['xen.ssh-host-key-unpinned', 'xen.ssh-password-auth']);
  });

  it('accepts an encrypted, verified configuration', async () => {
    const findings = await xenCheck.run({ hosts: [{
      id: 3, name: 'xo', daemon_type: 'xen',
      daemon_config: encryptDaemonConfig({ provider: 'xo', endpoint: 'https://xo.test', token: 'token', caCert: 'PEM', skipTlsVerify: false }),
    }] });
    expect(findings).toEqual([]);
  });

  it('is registered in the posture registry', () => {
    expect(require('../services/posture/checks').ALL.some(check => check.id === 'xen')).toBe(true);
  });
});
