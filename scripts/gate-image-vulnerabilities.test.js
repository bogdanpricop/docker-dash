'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { evaluateReports, validatePolicy } = require('./gate-image-vulnerabilities');

const actualPolicy = JSON.parse(fs.readFileSync(path.join(__dirname, '../docker/scanners/image-vulnerability-policy.json'), 'utf8'));
validatePolicy(actualPolicy, new Date().toISOString().slice(0, 10));
assert.equal(actualPolicy.exceptions.length, 7);

const rule = { scanner: 'trivy', id: 'CVE-test', severity: 'HIGH', target: 'usr/local/bin/tool',
  targetType: 'gobinary', packageName: 'example/module', packageVersion: 'v1.2.3',
  purl: 'pkg:golang/example/module@v1.2.3', expiresOn: '2027-01-07',
  justification: 'vulnerable_code_not_present',
  reason: 'The exact compiled artifact does not include the affected server-side package or execution path.',
  references: ['https://example.test/advisory'] };
const finding = { VulnerabilityID: 'CVE-test', Severity: 'HIGH', PkgName: 'example/module',
  InstalledVersion: 'v1.2.3', PkgIdentifier: { PURL: 'pkg:golang/example/module@v1.2.3' } };
const report = { Results: [{ Target: 'usr/local/bin/tool', Type: 'gobinary', Vulnerabilities: [finding] }] };
const emptyGrype = { matches: [] };

let result = evaluateReports(report, emptyGrype, { schemaVersion: 1, exceptions: [rule] }, '2026-10-07');
assert.equal(result.allowed.length, 1); assert.equal(result.blocked.length, 0); assert.equal(result.unused.length, 0);

const changed = structuredClone(report); changed.Results[0].Vulnerabilities[0].InstalledVersion = 'v1.2.4';
result = evaluateReports(changed, emptyGrype, { schemaVersion: 1, exceptions: [rule] }, '2026-10-07');
assert.equal(result.allowed.length, 0); assert.equal(result.blocked.length, 1); assert.equal(result.unused.length, 1);

assert.throws(() => evaluateReports(report, emptyGrype, { schemaVersion: 1, exceptions: [rule] }, '2027-01-07'), /Expired exception/);
assert.throws(() => validatePolicy({ schemaVersion: 1, exceptions: [rule, structuredClone(rule)] }, '2026-10-07'),
  /Duplicate policy rule/);

const newFinding = structuredClone(report); newFinding.Results[0].Vulnerabilities.push({ ...finding, VulnerabilityID: 'CVE-new' });
result = evaluateReports(newFinding, emptyGrype, { schemaVersion: 1, exceptions: [rule] }, '2026-10-07');
assert.equal(result.allowed.length, 1); assert.equal(result.blocked.length, 1);

console.log('PASS image vulnerability policy: schema, duplicates, exact matching, drift, expiry and new findings');
