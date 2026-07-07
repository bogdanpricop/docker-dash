'use strict';

// v8.9.12-alpha.1 — ESXi version/EOL/CVE knowledge base (ported from SOS).

const { checkVersion, ESXI_VERSIONS, ESXI_CRITICAL_CVES } = require('../services/esxi-version-db');

describe('esxi-version-db (v8.9.12-alpha.1)', () => {
  it('has the curated version + CVE tables', () => {
    expect(ESXI_VERSIONS.length).toBeGreaterThanOrEqual(5);
    expect(ESXI_CRITICAL_CVES.length).toBeGreaterThanOrEqual(7);
  });

  it('flags an End-of-Life version (6.7)', () => {
    const r = checkVersion('6.7.0', '22509723');
    expect(r.isEndOfLife).toBe(true);
    expect(r.isUpToDate).toBe(true); // matches latestBuild
    expect(r.recommendations.some(x => /End of Life/i.test(x))).toBe(true);
    // 6.7 is affected by several CVEs
    expect(r.applicableCVEs.length).toBeGreaterThan(0);
  });

  it('flags an out-of-date supported version (8.0 old build)', () => {
    const r = checkVersion('8.0.0', '20000000');
    expect(r.isEndOfLife).toBe(false);
    expect(r.isUpToDate).toBe(false);
    expect(r.recommendations.some(x => /Update to/i.test(x))).toBe(true);
  });

  it('reports up-to-date + supported for the latest 8.0 build', () => {
    const latest = ESXI_VERSIONS.find(v => v.version === '8.0').latestBuild;
    const r = checkVersion('8.0.3', latest);
    expect(r.isUpToDate).toBe(true);
    expect(r.isEndOfLife).toBe(false);
  });

  it('sorts CVEs by CVSS descending', () => {
    const r = checkVersion('7.0.0', '20000000');
    for (let i = 1; i < r.applicableCVEs.length; i++) {
      expect(r.applicableCVEs[i - 1].cvssScore).toBeGreaterThanOrEqual(r.applicableCVEs[i].cvssScore);
    }
  });

  it('handles an unrecognized version gracefully', () => {
    const r = checkVersion('5.5.0', '1234');
    expect(r.latestPatch).toBe('Unknown');
    expect(r.isEndOfLife).toBe(true);
    expect(r.recommendations[0]).toMatch(/not recognized/i);
  });

  it('counts critical vs high CVEs', () => {
    const r = checkVersion('8.0.0', '20000000');
    expect(r.criticalCVECount + r.highCVECount).toBe(r.applicableCVEs.length);
    expect(r.criticalCVECount).toBe(r.applicableCVEs.filter(c => c.severity === 'CRITICAL').length);
  });
});
