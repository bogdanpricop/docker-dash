'use strict';

const lockout = require('../services/firewall/lockout');
const { toShellCommand } = require('../services/firewall/runner');

describe('firewall lockout guard', () => {
  test('allows are never blocked by the guard', () => {
    expect(() => lockout.check({ sshPort: 22, spec: { action: 'allow', destination_port: 22 } })).not.toThrow();
  });
  test('refuses closing the SSH port for everyone', () => {
    expect(() => lockout.check({ sshPort: 2222, spec: { action: 'block', destination_port: 2222 } })).toThrow(/SSH\/management port/);
  });
  test('refuses closing the management port', () => {
    expect(() => lockout.check({ sshPort: 22, spec: { action: 'block', destination_port: 8101 } })).toThrow(/lockout guard/);
  });
  test('allows blocking the SSH port when restricted to a source IP', () => {
    expect(() => lockout.check({ sshPort: 22, spec: { action: 'block', destination_port: 22, source_ip: '1.2.3.4' } })).not.toThrow();
  });
  test('refuses blocking your own / an admin IP', () => {
    expect(() => lockout.check({ sshPort: 22, spec: { action: 'block', source_ip: '9.9.9.9' }, requesterIp: '9.9.9.9' })).toThrow(/your own/);
    expect(() => lockout.check({ sshPort: 22, spec: { action: 'block', source_ip: '5.5.5.5' }, adminIps: ['5.5.5.5'] })).toThrow(/admin IP/);
  });
});

describe('runner.toShellCommand — POSIX quoting', () => {
  test('quotes every token and neutralizes injection', () => {
    const cmd = toShellCommand('iptables', ['-I', 'INPUT', '-s', "1.2.3.4'; rm -rf /"]);
    expect(cmd.startsWith("'iptables' '-I' 'INPUT' '-s' ")).toBe(true);
    // the malicious quote is escaped, not left to break out
    expect(cmd).toContain(`'\\''`);
  });
});
