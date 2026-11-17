'use strict';

const dgx = require('../dgx');
const { redact } = require('../redactor');
const { sha256 } = require('../../../utils/crypto');

const MAX_FINDINGS = 12;
const RANK = new Map(['critical', 'high', 'unknown', 'medium', 'low', 'negligible'].map((level, index) => [level, index]));

function field(value) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 160) : '';
}

function normalizedFindings(scans) {
  const findings = new Map();
  for (const scan of scans) {
    let rows;
    try { rows = JSON.parse(scan.results_json); } catch { throw new Error('A stored scan has unreadable evidence. Rescan the image.'); }
    if (!Array.isArray(rows)) throw new Error('A stored scan has unreadable evidence. Rescan the image.');
    for (const row of rows) {
      const id = field(row?.id);
      const pkg = field(row?.package);
      if (!id || !pkg) continue;
      const version = field(row.version);
      const type = field(row.type);
      // The scanners report different target paths for the same package in an image.
      const key = JSON.stringify([scan.imageId || '', id, pkg, version]);
      const level = field(row.severity).toLowerCase();
      const severity = RANK.has(level) ? level : 'unknown';
      const artifactKind = row._class === 'third-party-binary' || ['gobinary', 'go-module'].includes(type) || pkg === 'stdlib' ? 'binary'
        : row._class === 'os-package' || ['alpine', 'apk', 'debian', 'ubuntu', 'wolfi', 'chainguard', 'deb', 'rpm', 'os'].includes(type) ? 'os'
          : row._class === 'npm-package' || ['npm', 'node-pkg', 'python', 'python-pkg', 'java', 'java-archive'].includes(type) ? 'dependency' : 'unknown';
      if (!findings.has(key)) findings.set(key, {
        ...(scan.imageId ? { imageId: scan.imageId } : {}), id, package: pkg, version, artifactKind, severity, sources: [],
      });
      const item = findings.get(key);
      if (item.artifactKind === 'unknown') item.artifactKind = artifactKind;
      if (RANK.get(severity) < RANK.get(item.severity)) item.severity = severity;
      const fixedIn = field(row.fixedIn);
      if (!item.sources.some(source => source.scanId === scan.id && source.fixedIn === fixedIn)) {
        item.sources.push({ scanId: scan.id, scanner: scan.scanner, fixedIn, severity, target: field(row.target) });
      }
    }
  }
  return [...findings.values()].sort((a, b) => RANK.get(a.severity) - RANK.get(b.severity)
    || a.id.localeCompare(b.id) || a.package.localeCompare(b.package));
}

function classify(item) {
  const hasFix = source => /[0-9]/.test(source.fixedIn);
  const advisoryCheck = {
    binary: 'check_binary_release', os: 'check_distribution',
    dependency: 'check_dependency_advisory', unknown: 'check_vendor_advisory',
  }[item.artifactKind];
  const fixes = [...new Set(item.sources.filter(hasFix).map(source => source.fixedIn))];
  if (fixes.length > 1 || (fixes.length && item.sources.some(source => !hasFix(source)))) {
    return { remediation: 'resolve_scanner_difference', checks: ['compare_advisories', advisoryCheck] };
  }
  if (!fixes.length) return { remediation: 'investigate_without_fix', checks: ['review_exposure', advisoryCheck] };
  const remediation = item.artifactKind === 'binary' ? 'verify_rebuilt_binary'
    : item.artifactKind === 'dependency' ? 'verify_dependency_update' : 'verify_patched_candidate';
  return { remediation, checks: ['scan_candidate', advisoryCheck] };
}

function schemaFor(findings) {
  const properties = Object.fromEntries(findings.map(item => [item.evidenceId, { type: 'string', enum: item.checks }]));
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

function validateChoices(value, findings) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== findings.length
    || !findings.every(item => Object.hasOwn(value, item.evidenceId) && item.checks.includes(value[item.evidenceId]))) {
    throw new Error('DGX returned checks outside the permitted evidence.');
  }
}

function prioritize(inventory, stack) {
  if (!stack) return inventory.slice(0, MAX_FINDINGS);
  const groups = new Map();
  for (const item of inventory) {
    if (!groups.has(item.imageId)) groups.set(item.imageId, []);
    groups.get(item.imageId).push(item);
  }
  const selected = [];
  for (let depth = 0; selected.length < Math.min(inventory.length, MAX_FINDINGS); depth++) {
    for (const items of groups.values()) {
      if (items[depth]) selected.push(items[depth]);
      if (selected.length === MAX_FINDINGS) break;
    }
  }
  return selected;
}

async function analyze({ scans, runningContainers, stack = false }, config, request = dgx.request) {
  const inventory = normalizedFindings(scans);
  const findings = prioritize(inventory, stack).map((item, index) => ({
    ...item, ...classify(item), evidenceId: 'F' + (index + 1),
  }));
  if (!findings.length) return { findings: [], total: 0, model: config.model, transport: 'no_findings' };

  // The inference request contains neither raw scanner descriptions nor any Docker identifiers.
  const evidence = findings.map(item => ({
    id: item.evidenceId,
    advisory: /^(?:CVE-[0-9]{4}-[0-9]{4,12}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/i.test(item.id) ? item.id : 'other',
    severity: item.severity,
    artifactKind: item.artifactKind,
    remediation: item.remediation,
    scannerCount: new Set(item.sources.map(source => source.scanner)).size,
    checks: item.checks,
  }));
  const { redacted } = redact(JSON.stringify({ runningContainers, evidence }), []);
  const response = await request(config, '/v1/chat/completions', {
    model: config.model,
    messages: [
      { role: 'system', content: 'Choose one allowed verification check for each evidence key. For a compiled binary, check its publisher release or the toolchain used to rebuild it. For OS packages, confirm the distribution advisory. For conflicting scanner evidence compare advisories. When no fix is published, review exposure of affected workloads. Return the required JSON only.' },
      { role: 'user', content: redacted },
    ],
    temperature: 0,
    max_tokens: 768,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
    response_format: { type: 'json_schema', json_schema: { name: 'dgx_security_checks', strict: true, schema: schemaFor(findings) } },
  }, 45000);
  const choice = response?.choices?.[0];
  if (choice?.finish_reason !== 'stop' || !choice.message?.content) throw new Error('DGX did not return a complete triage response.');
  let checks;
  try { checks = JSON.parse(choice.message.content); } catch { throw new Error('DGX returned malformed triage JSON.'); }
  validateChoices(checks, findings);
  return {
    transport: 'dgx',
    model: config.model,
    payloadHash: sha256(redacted),
    total: inventory.length,
    findings: findings.map(({ checks: _options, ...item }) => ({ ...item, nextCheck: checks[item.evidenceId] })),
  };
}

module.exports = { analyze };
