'use strict';

const posture = require('../services/posture');
const { _score, _grade, _dedupe, _key } = posture._internals;
const insecureDocker = require('../services/posture/checks/insecure-docker');

describe('posture scoring', () => {
  test('empty findings → perfect A', () => {
    expect(_score([])).toEqual({ score: 100, grade: 'A', counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } });
  });
  test('weighted penalty + grade boundaries', () => {
    expect(_score([{ severity: 'critical' }]).score).toBe(60); // 100-40
    expect(_score([{ severity: 'critical' }]).grade).toBe('C');
    expect(_score([{ severity: 'high' }, { severity: 'medium' }]).score).toBe(72); // 100-20-8
    expect(_score([{ severity: 'low' }]).grade).toBe('A'); // 97
    // three criticals → 100-120 clamped to 0 → F
    expect(_score([{ severity: 'critical' }, { severity: 'critical' }, { severity: 'critical' }]).score).toBe(0);
    expect(_score([{ severity: 'critical' }, { severity: 'critical' }, { severity: 'critical' }]).grade).toBe('F');
  });
  test('grade thresholds', () => {
    expect(_grade(90)).toBe('A');
    expect(_grade(75)).toBe('B');
    expect(_grade(55)).toBe('C');
    expect(_grade(35)).toBe('D');
    expect(_grade(34)).toBe('F');
  });
});

describe('posture dedupe + key', () => {
  test('same key keeps the highest severity', () => {
    const a = { checkId: 'x', hostId: 1, subject: 's', severity: 'low' };
    const b = { checkId: 'x', hostId: 1, subject: 's', severity: 'critical' };
    const out = _dedupe([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('critical');
  });
  test('key is stable and distinguishes host/subject', () => {
    expect(_key({ checkId: 'x', hostId: 1, subject: 's' })).toBe(_key({ checkId: 'x', hostId: 1, subject: 's' }));
    expect(_key({ checkId: 'x', hostId: 1, subject: 's' })).not.toBe(_key({ checkId: 'x', hostId: 2, subject: 's' }));
  });
});

describe('posture remediation dispatcher', () => {
  test('rejects a missing action', async () => {
    await expect(posture.remediate(undefined, {})).rejects.toThrow(/action is required/);
  });
  test('rejects an unsupported action (only safe actions are one-click)', async () => {
    await expect(posture.remediate({ type: 'fw-block-port', port: 2375 }, {})).rejects.toThrow(/Unsupported remediation/);
  });
  test('fw-reconcile requires a hostId', async () => {
    await expect(posture.remediate({ type: 'fw-reconcile' }, {})).rejects.toThrow(/hostId required/);
  });
});

describe('insecure-docker check', () => {
  const ctx = (hosts) => ({ hosts });
  test('flags a plain-TCP docker host without TLS as critical', async () => {
    const out = await insecureDocker.run(ctx([{ id: 3, name: 'edge', connection_type: 'tcp', daemon_type: 'docker', tls_config: null }]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ checkId: 'fw.insecure-docker', severity: 'critical', hostId: 3 });
  });
  test('does NOT flag a TCP host WITH TLS, nor socket/ssh hosts', async () => {
    const out = await insecureDocker.run(ctx([
      { id: 1, name: 'tls', connection_type: 'tcp', daemon_type: 'docker', tls_config: JSON.stringify({ ca: 'x', cert: 'y', key: 'z' }) },
      { id: 2, name: 'local', connection_type: 'socket', daemon_type: 'docker' },
      { id: 4, name: 'ssh', connection_type: 'ssh', daemon_type: 'docker' },
    ]));
    expect(out).toHaveLength(0);
  });
});
