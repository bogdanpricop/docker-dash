'use strict';

const { _internals } = require('../services/firewall/runner');

describe('firewall runner — agent request options (mTLS)', () => {
  test('token-only → relaxed server-cert check, no client cert', () => {
    const o = _internals._agentReqOptions({ token: 'x'.repeat(20) }, 12, 5000);
    expect(o.rejectUnauthorized).toBe(false);
    expect(o.cert).toBeUndefined();
    expect(o.key).toBeUndefined();
    expect(o.headers.Authorization).toBe(`Bearer ${'x'.repeat(20)}`);
    expect(o.headers['Content-Length']).toBe(12);
  });

  test('mTLS → presents client cert+key and verifies the agent cert', () => {
    const o = _internals._agentReqOptions({ token: 't'.repeat(20), tls: { cert: 'CERT', key: 'KEY', ca: 'CA' } }, 5, 5000);
    expect(o.rejectUnauthorized).toBe(true);
    expect(o.cert).toBe('CERT');
    expect(o.key).toBe('KEY');
    expect(o.ca).toBe('CA');
  });

  test('mTLS without a CA still verifies against system roots', () => {
    const o = _internals._agentReqOptions({ token: 't'.repeat(20), tls: { cert: 'CERT', key: 'KEY' } }, 5, 5000);
    expect(o.rejectUnauthorized).toBe(true);
    expect(o.ca).toBeUndefined();
  });
});
