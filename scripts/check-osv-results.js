'use strict';

const fs = require('fs');

const DEFAULT_MINIMUM_SEVERITY = 9;

function severityScore(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) return null;
  const numeric = Number(normalized);
  if (Number.isFinite(numeric)) return numeric;

  return {
    CRITICAL: 10,
    HIGH: 8,
    MODERATE: 5,
    MEDIUM: 5,
    LOW: 2,
  }[normalized] || null;
}

function isDevOnly(pkg) {
  const groups = Array.isArray(pkg.dependency_groups)
    ? pkg.dependency_groups.map(group => String(group).toLowerCase())
    : [];

  return groups.length > 0 && groups.every(group => group === 'dev' || group === 'test');
}

function evaluateReport(report, minimumSeverity = DEFAULT_MINIMUM_SEVERITY) {
  if (!report || !Array.isArray(report.results)) {
    throw new Error('Invalid OSV report: results must be an array');
  }

  const findings = [];
  const unknownSeverity = [];
  let skippedDevPackages = 0;

  for (const result of report.results) {
    for (const pkg of result.packages || []) {
      if (isDevOnly(pkg)) {
        skippedDevPackages += 1;
        continue;
      }

      for (const group of pkg.groups || []) {
        const score = severityScore(group.max_severity);
        const finding = {
          package: pkg.package?.name || 'unknown',
          version: pkg.package?.version || 'unknown',
          ids: Array.isArray(group.ids) ? [...group.ids].sort() : [],
          score,
        };

        if (score === null) unknownSeverity.push(finding);
        else if (score >= minimumSeverity) findings.push(finding);
      }
    }
  }

  const unique = new Map();
  for (const finding of findings) {
    const key = `${finding.package}\0${finding.version}\0${finding.ids.join(',')}`;
    unique.set(key, finding);
  }

  return {
    findings: [...unique.values()].sort((a, b) => b.score - a.score),
    unknownSeverity,
    skippedDevPackages,
  };
}

function main(argv = process.argv.slice(2)) {
  const [reportPath, thresholdValue] = argv;
  if (!reportPath) throw new Error('Usage: node scripts/check-osv-results.js <report.json> [minimum-score]');

  const minimumSeverity = thresholdValue === undefined
    ? DEFAULT_MINIMUM_SEVERITY
    : Number(thresholdValue);
  if (!Number.isFinite(minimumSeverity) || minimumSeverity < 0 || minimumSeverity > 10) {
    throw new Error('Minimum severity must be a number between 0 and 10');
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const evaluated = evaluateReport(report, minimumSeverity);

  console.log(`OSV production gate: ${evaluated.findings.length} finding(s) at CVSS >= ${minimumSeverity}`);
  console.log(`Ignored ${evaluated.skippedDevPackages} dev-only vulnerable package(s)`);

  if (evaluated.unknownSeverity.length > 0) {
    console.warn(`OSV returned ${evaluated.unknownSeverity.length} finding group(s) without a numeric severity`);
  }

  for (const finding of evaluated.findings) {
    console.error(`- ${finding.package}@${finding.version}: ${finding.score} (${finding.ids.join(', ')})`);
  }

  return evaluated.findings.length === 0 ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
  }
}

module.exports = { severityScore, isDevOnly, evaluateReport, main };
