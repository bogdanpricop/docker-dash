'use strict';

const { validate } = require('../../scripts/audit-dependencies');
const now = new Date('2026-11-02T00:00:00Z');
const report = () => ({ metadata: {}, vulnerabilities: {
  deepmerge: { severity: 'low', via: [{ name: 'deepmerge', url: 'https://github.com/advisories/GHSA-gcqx-w48m-w2h4' }] },
} });

test('permits only the reviewed unpatched development advisory before expiry', () => {
  expect(validate(report(), now)).toBe(1);
  expect(() => validate(report(), new Date('2026-12-02'))).toThrow('Unreviewed');
});

test('rejects severity changes and new advisories on the same package', () => {
  const high = report();
  high.vulnerabilities.deepmerge.severity = 'high';
  expect(() => validate(high, now)).toThrow('Unreviewed');
  const changed = report();
  changed.vulnerabilities.deepmerge.via[0].url = 'https://github.com/advisories/new';
  expect(() => validate(changed, now)).toThrow('Unreviewed');
});

test('audit service failures cannot be reported as a clean scan', () => {
  expect(() => validate({ error: { code: 'ENETWORK' } }, now)).toThrow('Invalid');
});
