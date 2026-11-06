'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TRIVY_BLOCKING = new Set(['UNKNOWN', 'HIGH', 'CRITICAL']);
const GRYPE_BLOCKING = new Set(['HIGH', 'CRITICAL']);
const JUSTIFICATIONS = new Set(['vulnerable_code_not_present', 'vendor_patch_applied']);
const cleanPath = value => String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const canonicalize = value => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
};

function normalizeTrivy(report) {
  const findings = [];
  for (const result of report.Results || []) {
    for (const item of result.Vulnerabilities || []) {
      const severity = String(item.Severity || '').toUpperCase();
      if (!TRIVY_BLOCKING.has(severity)) continue;
      findings.push({ scanner: 'trivy', id: item.VulnerabilityID, severity,
        target: cleanPath(result.Target), targetType: result.Type,
        packageName: item.PkgName, packageVersion: item.InstalledVersion,
        purl: item.PkgIdentifier?.PURL || '' });
    }
  }
  return findings;
}

function normalizeGrype(report) {
  const findings = [];
  for (const match of report.matches || []) {
    const severity = String(match.vulnerability?.severity || '').toUpperCase();
    if (!GRYPE_BLOCKING.has(severity)) continue;
    findings.push({ scanner: 'grype', id: match.vulnerability?.id, severity,
      packageName: match.artifact?.name, packageVersion: match.artifact?.version,
      packageType: match.artifact?.type,
      locations: (match.artifact?.locations || []).map(item => '/' + cleanPath(item.path)) });
  }
  return findings;
}

function matches(rule, finding) {
  for (const key of ['scanner', 'id', 'severity', 'target', 'targetType', 'packageName',
    'packageVersion', 'packageType', 'purl']) {
    if (rule[key] !== undefined && rule[key] !== finding[key]) return false;
  }
  return rule.location === undefined || finding.locations?.includes('/' + cleanPath(rule.location));
}

function validatePolicy(policy, today) {
  assert.equal(policy.schemaVersion, 1, 'Unsupported image vulnerability policy schema');
  assert.ok(Array.isArray(policy.exceptions) && policy.exceptions.length, 'Policy has no exceptions');
  const keys = new Set();
  for (const rule of policy.exceptions) {
    for (const key of ['scanner', 'id', 'severity', 'packageName', 'packageVersion', 'expiresOn',
      'justification', 'reason', 'references']) assert.ok(rule[key], `Policy rule missing ${key}`);
    assert.ok(['trivy', 'grype'].includes(rule.scanner), `Unknown scanner ${rule.scanner}`);
    assert.ok(JUSTIFICATIONS.has(rule.justification), `Unknown justification for ${rule.id}`);
    assert.match(rule.expiresOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(today < rule.expiresOn, `Expired exception ${rule.scanner}:${rule.id} (${rule.expiresOn})`);
    assert.ok(rule.reason.length >= 60, `Exception reason is too short for ${rule.id}`);
    assert.ok(rule.references.length >= 1 && rule.references.every(ref => /^https:\/\//.test(ref) || /^docs\//.test(ref)),
      `Exception references are invalid for ${rule.id}`);
    const key = JSON.stringify(canonicalize(rule));
    assert.ok(!keys.has(key), `Duplicate policy rule ${rule.scanner}:${rule.id}`); keys.add(key);
  }
}

function evaluateReports(trivy, grype, policy, today) {
  validatePolicy(policy, today);
  const findings = [...normalizeTrivy(trivy), ...normalizeGrype(grype)];
  const used = new Set(), allowed = [], blocked = [];
  for (const finding of findings) {
    const candidates = policy.exceptions.map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => matches(rule, finding));
    if (candidates.length !== 1) { blocked.push(finding); continue; }
    used.add(candidates[0].index); allowed.push({ finding, rule: candidates[0].rule });
  }
  const unused = policy.exceptions.filter((_rule, index) => !used.has(index));
  return { findings, allowed, blocked, unused };
}

function verifyArtifactEvidence(rule, reviewed) {
  if (!rule.artifact) return;
  const artifact = reviewed.artifacts?.[rule.artifact];
  assert.ok(artifact, `Unknown reviewed artifact ${rule.artifact}`);
  assert.equal(rule.artifactSha256, artifact.binarySha256, `Policy hash drift for ${rule.artifact}`);
  assert.equal(sha256(artifact.path), rule.artifactSha256, `Installed ${rule.artifact} hash differs from policy`);
  if (rule.target) assert.equal(cleanPath(rule.target), cleanPath(artifact.path), `Target does not match ${rule.artifact}`);
  if (rule.location) assert.equal(cleanPath(rule.location), cleanPath(artifact.path), `Location does not match ${rule.artifact}`);
  const packageFile = `/usr/share/docker-dash/scanners/${rule.artifact}.packages.txt`;
  assert.equal(sha256(packageFile), artifact.metadata['packages.txt'], `Package inventory drift for ${rule.artifact}`);
  const packages = fs.readFileSync(packageFile, 'utf8').trim().split('\n');
  for (const prefix of rule.absentPackagePrefixes || []) {
    assert.ok(!packages.some(pkg => pkg === prefix || pkg.startsWith(prefix + '/')),
      `${prefix} is present in ${rule.artifact}`);
  }
  if (rule.modulePackagePrefixes) {
    const selected = packages.filter(pkg => rule.modulePackagePrefixes.some(prefix => pkg === prefix || pkg.startsWith(prefix + '/')));
    assert.ok(selected.length, `No reviewed module packages found in ${rule.artifact}`);
    assert.ok(selected.every(pkg => rule.allowedModulePackagePrefixes.some(prefix => pkg === prefix || pkg.startsWith(prefix + '/'))),
      `Engine implementation package is present in ${rule.artifact}`);
  }
}

function apkVersion(name, database = '/lib/apk/db/installed') {
  for (const block of fs.readFileSync(database, 'utf8').split('\n\n')) {
    const fields = Object.fromEntries(block.split('\n').filter(line => line.length > 2 && line[1] === ':')
      .map(line => [line[0], line.slice(2)]));
    if (fields.P === name) return fields.V;
  }
  return null;
}

function verifyRuntimeEvidence(rule, repositoryRoot) {
  if (rule.justification !== 'vendor_patch_applied') return;
  assert.equal(rule.packageType, 'apk');
  assert.equal(apkVersion(rule.packageName), rule.packageVersion, `Installed ${rule.packageName} version drift`);
  const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'Dockerfile'), 'utf8');
  assert.ok(dockerfile.includes(`FROM ${rule.baseImage} AS base`), 'Runtime base digest differs from reviewed policy');
}

function main() {
  const required = ['DD_TRIVY_REPORT', 'DD_GRYPE_REPORT', 'DD_IMAGE_VULNERABILITY_POLICY',
    'DD_SCANNER_REVIEW', 'DD_REPOSITORY_ROOT'];
  for (const name of required) assert.ok(process.env[name], `Missing ${name}`);
  const read = name => JSON.parse(fs.readFileSync(process.env[name], 'utf8'));
  const policy = read('DD_IMAGE_VULNERABILITY_POLICY');
  const reviewed = read('DD_SCANNER_REVIEW');
  const today = new Date().toISOString().slice(0, 10);
  const result = evaluateReports(read('DD_TRIVY_REPORT'), read('DD_GRYPE_REPORT'), policy, today);
  for (const { rule } of result.allowed) {
    verifyArtifactEvidence(rule, reviewed);
    verifyRuntimeEvidence(rule, process.env.DD_REPOSITORY_ROOT);
  }
  for (const item of result.allowed) console.log(`REVIEWED ${item.finding.scanner} ${item.finding.id} ${item.finding.packageName}@${item.finding.packageVersion}: ${item.rule.reason}`);
  for (const item of result.blocked) console.error('BLOCKING ' + JSON.stringify(item));
  for (const item of result.unused) console.error(`STALE-OR-MISSING ${item.scanner} ${item.id} ${item.packageName}@${item.packageVersion}`);
  assert.deepEqual(result.blocked, [], 'Unreviewed High/Critical/Unknown image findings');
  assert.deepEqual(result.unused, [], 'Policy contains stale or missing findings; review and remove/update the rule');
  console.log(`PASS image vulnerability gate: ${result.allowed.length} exact reviewed findings; no unreviewed blocking findings`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { normalizeTrivy, normalizeGrype, matches, validatePolicy, evaluateReports };
