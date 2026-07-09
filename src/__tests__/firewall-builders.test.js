'use strict';

const { iptables, firewalld, ufw } = require('../services/firewall/backends');

const ctx = { uuid: 'abc-123', reason: 'vendor' };

describe('iptables builder', () => {
  test('docker allow → DOCKER-USER + conntrack --ctorigdstport + comment + ACCEPT', () => {
    const r = iptables.buildApply({ action: 'allow', scope: 'docker', source_ip: '89.40.10.20', destination_port: 8082, protocol: 'tcp' }, ctx);
    const argv = r.commands[0].argv;
    expect(r.commands[0].bin).toBe('iptables');
    expect(argv.slice(0, 3)).toEqual(['-I', 'DOCKER-USER', '-p']);
    expect(argv).toEqual(expect.arrayContaining(['-m', 'conntrack', '--ctorigdstport', '8082', '-s', '89.40.10.20', '-j', 'ACCEPT']));
    expect(argv).toContain('APPFW uuid=abc-123 reason=vendor');
    expect(r.chain).toBe('DOCKER-USER');
  });
  test('host block IP (no port) → INPUT -s ... DROP, no -p', () => {
    const r = iptables.buildApply({ action: 'block', scope: 'host', source_ip: '89.40.10.20', protocol: 'tcp' }, ctx);
    const argv = r.commands[0].argv;
    expect(argv[0]).toBe('-I'); expect(argv[1]).toBe('INPUT');
    expect(argv).not.toContain('-p');
    expect(argv).toEqual(expect.arrayContaining(['-s', '89.40.10.20', '-j', 'DROP']));
  });
  test('host open port → INPUT -p tcp --dport ACCEPT', () => {
    const r = iptables.buildApply({ action: 'allow', scope: 'host', destination_port: 443, protocol: 'tcp' }, ctx);
    expect(r.commands[0].argv).toEqual(expect.arrayContaining(['-p', 'tcp', '--dport', '443', '-j', 'ACCEPT']));
  });
  test('remove rebuilds the same tuple with -D', () => {
    const rule = { action: 'allow', scope: 'docker', source_ip: '89.40.10.20', destination_port: 8082, protocol: 'tcp', comment_tag: 'APPFW uuid=abc-123 reason=vendor' };
    const rm = iptables.buildRemove(rule).commands[0].argv;
    expect(rm[0]).toBe('-D'); expect(rm[1]).toBe('DOCKER-USER');
    expect(rm).toContain('--ctorigdstport'); expect(rm).toContain('APPFW uuid=abc-123 reason=vendor');
  });
});

describe('firewalld builder', () => {
  test('allow IP to port → permanent rich rule + reload', () => {
    const r = firewalld.buildApply({ action: 'allow', scope: 'host', source_ip: '89.40.10.20', destination_port: 8082, protocol: 'tcp' }, ctx);
    expect(r.commands).toHaveLength(2);
    const add = r.commands[0].argv;
    expect(add).toContain('--permanent');
    expect(add.some(a => a.startsWith('--add-rich-rule='))).toBe(true);
    expect(add.find(a => a.startsWith('--add-rich-rule=')))
      .toContain('source address="89.40.10.20"');
    expect(r.commands[1].argv).toEqual(['--reload']);
  });
  test('port-only open → --add-port; remove → --remove-port', () => {
    const r = firewalld.buildApply({ action: 'allow', scope: 'host', destination_port: 443, protocol: 'tcp' }, ctx);
    expect(r.commands[0].argv).toContain('--add-port=443/tcp');
    const rm = firewalld.buildRemove({ action: 'allow', scope: 'host', destination_port: 443, protocol: 'tcp', chain_name: 'public' });
    expect(rm.commands[0].argv).toContain('--remove-port=443/tcp');
  });
});

describe('ufw builder', () => {
  test('allow from IP to port with comment', () => {
    const r = ufw.buildApply({ action: 'allow', scope: 'host', source_ip: '89.40.10.20', destination_port: 8082, protocol: 'tcp' }, ctx);
    expect(r.commands[0].bin).toBe('ufw');
    expect(r.commands[0].argv).toEqual(['allow', 'from', '89.40.10.20', 'to', 'any', 'port', '8082', 'proto', 'tcp', 'comment', 'APPFW uuid=abc-123 reason=vendor']);
  });
  test('remove prepends delete and drops comment', () => {
    const rm = ufw.buildRemove({ action: 'allow', scope: 'host', source_ip: '89.40.10.20', destination_port: 8082, protocol: 'tcp' });
    expect(rm.commands[0].argv[0]).toBe('delete');
    expect(rm.commands[0].argv).not.toContain('comment');
  });
});
