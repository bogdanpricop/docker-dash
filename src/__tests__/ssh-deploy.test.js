'use strict';

// v8.9.20-alpha.1 — pure-helper coverage for ssh-deploy. The network paths
// (deployPublicKey/testConnection) need a live SSH server and are exercised
// manually; here we lock down the path resolution + PowerShell encoding.

const deploy = require('../services/ssh-deploy');
const { _windowsKeysPath, _psEncode } = deploy._internals;

describe('ssh-deploy path resolution', () => {
  test('linux/docker/proxmox → profile authorized_keys', () => {
    expect(deploy._authorizedKeysPath('linux')).toBe('~/.ssh/authorized_keys');
    expect(deploy._authorizedKeysPath('proxmox')).toBe('~/.ssh/authorized_keys');
    expect(deploy._authorizedKeysPath('generic')).toBe('~/.ssh/authorized_keys');
  });

  test('esxi → per-user keys dir (root default)', () => {
    expect(deploy._authorizedKeysPath('esxi')).toBe('/etc/ssh/keys-root/authorized_keys');
    expect(deploy._authorizedKeysPath('esxi', 'svc')).toBe('/etc/ssh/keys-svc/authorized_keys');
  });

  test('windows path depends on admin membership', () => {
    expect(_windowsKeysPath(true)).toBe('C:\\ProgramData\\ssh\\administrators_authorized_keys');
    expect(_windowsKeysPath(false)).toBe('%USERPROFILE%\\.ssh\\authorized_keys');
  });
});

describe('PowerShell -EncodedCommand payload', () => {
  test('is base64 of UTF-16LE and round-trips', () => {
    const script = "$x = 'héllo'; Write-Output $x;";
    const b64 = _psEncode(script);
    expect(b64).toMatch(/^[A-Za-z0-9+/]+=*$/); // pure base64, cmd.exe-safe
    const back = Buffer.from(b64, 'base64').toString('utf16le');
    expect(back).toBe(script);
  });
});
