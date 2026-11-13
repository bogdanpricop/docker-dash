'use strict';

const { createRequire } = require('node:module');
const { realpathSync } = require('node:fs');
const { mergeConfig } = require('jest-config');
const { validate } = require('../../scripts/audit-dependencies');

const report = (vulnerabilities = {}, total = Object.keys(vulnerabilities).length) =>
  ({ metadata: { vulnerabilities: { total } }, vulnerabilities });

test('requires clean npm audits, including the previously excepted advisory', () => {
  expect(() => validate(report())).not.toThrow();
  const advisory = { severity: 'low', via: [{ url: 'https://github.com/advisories/GHSA-gcqx-w48m-w2h4' }] };
  expect(() => validate(report({ deepmerge: advisory }))).toThrow(/zero npm advisories.*deepmerge/);
  expect(() => validate(report({}, 1))).toThrow(/zero npm advisories/);
});

test('rejects missing audit data and audit service errors', () => {
  expect(() => validate({ metadata: {} })).toThrow('Invalid npm audit response');
  expect(() => validate({ ...report(), error: { code: 'ENETWORK' } })).toThrow('Invalid npm audit response');
});

test('Jest resolves the patched local merge and preserves configuration semantics', () => {
  const fromJest = createRequire(require.resolve('jest-config'));
  const local = require.resolve('../../vendor/deepmerge');
  expect(realpathSync(fromJest.resolve('deepmerge'))).toBe(realpathSync(local));
  expect(mergeConfig({ globals: { a: true, nested: { first: 1 } }, setupFiles: ['first'] },
    { globals: { nested: { second: 2 } }, setupFiles: ['second'] })).toEqual({
    globals: { a: true, nested: { first: 1, second: 2 } },
    setupFiles: ['first', 'second'],
  });
});

test('drops prototype keys from source and target at every depth', () => {
  const merge = createRequire(require.resolve('jest-config'))('deepmerge');
  const payload = JSON.parse('{"__proto__":{"injected":true},"constructor":{"prototype":{"injected":true}},"prototype":{"injected":true},"enabled":true}');
  const nullTarget = Object.assign(Object.create(null), { own: true });
  const results = [
    merge(nullTarget, payload),
    merge(payload, { own: true }),
    mergeConfig({ globals: { own: true } }, { globals: payload }).globals,
    mergeConfig({ globals: payload }, { globals: { own: true } }).globals,
  ];
  for (const result of results) {
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result).toEqual({ own: true, enabled: true });
    expect(result.injected).toBeUndefined();
  }
});
