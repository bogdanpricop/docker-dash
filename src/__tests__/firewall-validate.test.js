'use strict';

const v = require('../services/firewall/validate');

describe('firewall validate — primitives', () => {
  test('IPs', () => {
    expect(v.validateIp('89.40.10.20')).toBe(true);
    expect(v.validateIp('::1')).toBe(true);
    expect(v.validateIp('999.1.1.1')).toBe(false);
    expect(v.validateIp('not-an-ip')).toBe(false);
  });
  test('CIDR or IP', () => {
    expect(v.validateCidrOrIp('10.0.0.0/8')).toBe(true);
    expect(v.validateCidrOrIp('192.168.1.5')).toBe(true);
    expect(v.validateCidrOrIp('2001:db8::/32')).toBe(true);
    expect(v.validateCidrOrIp('10.0.0.0/33')).toBe(false);
    expect(v.validateCidrOrIp('10.0.0.0/x')).toBe(false);
    expect(v.validateCidrOrIp('10.0.0.0; rm -rf /')).toBe(false);
  });
  test('ports', () => {
    expect(v.validatePort(8082)).toBe(true);
    expect(v.validatePort('443')).toBe(true);
    expect(v.validatePort(0)).toBe(false);
    expect(v.validatePort(70000)).toBe(false);
    expect(v.validatePort(-1)).toBe(false);
    expect(v.validatePort('abc')).toBe(false);
  });
  test('protocol / scope / action', () => {
    expect(v.validateProtocol('tcp')).toBe(true);
    expect(v.validateProtocol('sctp')).toBe(false);
    expect(v.validateScope('docker')).toBe(true);
    expect(v.validateScope('router')).toBe(false);
    expect(v.validateAction('allow')).toBe(true);
    expect(v.validateAction('nuke')).toBe(false);
  });
});

describe('firewall validate — assertSafe', () => {
  test('accepts a valid docker allow rule and defaults protocol', () => {
    const out = v.assertSafe({ action: 'allow', scope: 'docker', source_ip: '89.40.10.20', destination_port: 8082 });
    expect(out).toMatchObject({ action: 'allow', scope: 'docker', source_ip: '89.40.10.20', destination_port: 8082, protocol: 'tcp' });
  });
  test('rejects blanket rule with no source and no port', () => {
    expect(() => v.assertSafe({ action: 'block', scope: 'host' })).toThrow(/at least a source IP or a destination port/);
  });
  test('rejects bad action / scope / ip / port / protocol', () => {
    expect(() => v.assertSafe({ action: 'x', scope: 'host', destination_port: 22 })).toThrow(/Invalid action/);
    expect(() => v.assertSafe({ action: 'allow', scope: 'x', destination_port: 22 })).toThrow(/Invalid scope/);
    expect(() => v.assertSafe({ action: 'allow', scope: 'host', source_ip: 'bad ip' })).toThrow(/Invalid source/);
    expect(() => v.assertSafe({ action: 'allow', scope: 'host', destination_port: 99999 })).toThrow(/Invalid port/);
    expect(() => v.assertSafe({ action: 'allow', scope: 'host', destination_port: 22, protocol: 'sctp' })).toThrow(/Invalid protocol/);
  });
  test('sanitizes reason (strips shell-dangerous chars)', () => {
    const out = v.assertSafe({ action: 'allow', scope: 'host', destination_port: 443, reason: 'vendor; rm -rf / `id`' });
    expect(out.reason).not.toMatch(/[;`]/);
  });
});
