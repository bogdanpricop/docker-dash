'use strict';

const { severityScore, isDevOnly, evaluateReport } = require('../../scripts/check-osv-results');

function pkg(name, severity, dependencyGroups, ids = ['GHSA-test']) {
  return {
    package: { name, version: '1.0.0' },
    dependency_groups: dependencyGroups,
    groups: [{ ids, max_severity: severity }],
  };
}

describe('OSV production severity gate', () => {
  test('normalizes numeric and named severities', () => {
    expect(severityScore('9.8')).toBe(9.8);
    expect(severityScore('CRITICAL')).toBe(10);
    expect(severityScore('')).toBeNull();
    expect(severityScore('unknown')).toBeNull();
  });

  test('only classifies exclusively dev/test dependency groups as dev-only', () => {
    expect(isDevOnly({ dependency_groups: ['dev'] })).toBe(true);
    expect(isDevOnly({ dependency_groups: ['test', 'dev'] })).toBe(true);
    expect(isDevOnly({ dependency_groups: ['dev', 'optional'] })).toBe(false);
    expect(isDevOnly({})).toBe(false);
  });

  test('blocks critical production findings and ignores dev-only findings', () => {
    const report = {
      results: [{
        packages: [
          pkg('production-critical', '9.1'),
          pkg('development-critical', '10', ['dev']),
          pkg('production-high', '8.9'),
        ],
      }],
    };

    const result = evaluateReport(report, 9);
    expect(result.findings).toEqual([
      expect.objectContaining({ package: 'production-critical', score: 9.1 }),
    ]);
    expect(result.skippedDevPackages).toBe(1);
  });

  test('deduplicates aliases for the same package and records unknown severity', () => {
    const duplicate = pkg('duplicate', 'CRITICAL', undefined, ['CVE-1', 'GHSA-1']);
    const result = evaluateReport({
      results: [{ packages: [duplicate, duplicate, pkg('unknown', 'UNKNOWN')] }],
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].ids).toEqual(['CVE-1', 'GHSA-1']);
    expect(result.unknownSeverity).toHaveLength(1);
  });

  test('rejects malformed scanner output', () => {
    expect(() => evaluateReport({})).toThrow('results must be an array');
  });
});
