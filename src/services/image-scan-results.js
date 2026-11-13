'use strict';

const { getDb } = require('../db');
const admission = require('./image-admission');

function _makeSummary(vulns) {
  return {
    critical: vulns.filter(v => v.severity === 'critical').length,
    high: vulns.filter(v => v.severity === 'high').length,
    medium: vulns.filter(v => v.severity === 'medium').length,
    low: vulns.filter(v => v.severity === 'low').length,
    total: vulns.length,
  };
}

function _grypeResult(data, imageName) {
  const vulns = [];
  for (const match of (data.matches || [])) {
    const v = match.vulnerability || {};
    const pkg = match.artifact || {};
    const related = (match.relatedVulnerabilities || [])[0] || {};
    const cvssEntries = [...(v.cvss || []), ...(related.cvss || [])];
    const cvssScore = cvssEntries.length > 0
      ? Math.max(...cvssEntries.map(c => c.metrics?.baseScore || 0))
      : null;

    vulns.push({
      id: v.id || '?',
      severity: (v.severity || 'unknown').toLowerCase(),
      package: pkg.name || '?',
      version: pkg.version || '?',
      fixedIn: (v.fix?.versions || [])[0] || null,
      title: related.description?.substring(0, 200) || v.description?.substring(0, 200) || '',
      url: (related.urls || v.urls || [])[0] || '',
      cvss: cvssScore,
      type: pkg.type || '',
      target: pkg.locations?.[0]?.path || '',
    });
  }

  const recommendations = _generateRemediation(vulns, imageName);
  return {
    scanner: 'grype',
    image: imageName,
    scannedAt: new Date().toISOString(),
    vulnerabilities: vulns,
    summary: _makeSummary(vulns),
    recommendations,
  };
}

function _trivyResult(data, imageName) {
  const vulns = [];
  for (const r of (data.Results || [])) {
    for (const v of (r.Vulnerabilities || [])) {
      vulns.push({
        id: v.VulnerabilityID || '?',
        severity: (v.Severity || 'unknown').toLowerCase(),
        package: v.PkgName || '?',
        version: v.InstalledVersion || '?',
        fixedIn: v.FixedVersion || null,
        title: v.Title || '',
        description: v.Description || '',
        url: v.PrimaryURL || '',
        references: (v.References || []).slice(0, 3),
        cvss: v.CVSS ? Object.values(v.CVSS)[0]?.V3Score || null : null,
        target: r.Target || '',
        type: r.Type || '',
      });
    }
  }
  // Generate remediation recommendations
  const recommendations = _generateRemediation(vulns, imageName);

  return {
    scanner: 'trivy',
    image: imageName,
    scannedAt: new Date().toISOString(),
    vulnerabilities: vulns,
    summary: _makeSummary(vulns),
    recommendations,
  };
}

function _classifyVuln(v) {
  const pkg = (v.package || '').toLowerCase();
  const target = (v.target || '').toLowerCase();

  // Go binaries (Docker Scout, Docker CLI, Trivy) — compiled third-party tools
  const goPatterns = ['google.golang.org/', 'go.opentelemetry.io/', 'github.com/docker/', 'github.com/cloudflare/',
    'github.com/containerd/', 'github.com/moby/', 'golang.org/', 'github.com/aquasecurity/'];
  if (goPatterns.some(p => pkg.startsWith(p)) || v.type === 'gobinary' || target.includes('scout') || target.includes('trivy')) {
    return 'third-party-binary';
  }
  if (pkg === 'stdlib' && (target.includes('scout') || target.includes('trivy') || target.includes('docker'))) {
    return 'third-party-binary';
  }

  // OS packages (Alpine apk, Debian apt)
  if (['alpine', 'debian', 'ubuntu', 'wolfi', 'chainguard'].includes(v.type) || target.includes('alpine') || target.includes('debian')) {
    return 'os-package';
  }

  // Node.js / npm packages
  if (v.type === 'node-pkg' || v.type === 'npm' || target.includes('node_modules') || target.includes('package-lock')) {
    return 'npm-package';
  }

  // Heuristic: Go module paths
  if (pkg.includes('/') && (pkg.includes('.com/') || pkg.includes('.org/') || pkg.includes('.io/'))) {
    return 'third-party-binary';
  }

  return 'other';
}

function _generateRemediation(vulns, imageName) {
  const recs = [];

  // Classify all vulnerabilities
  for (const v of vulns) v._class = _classifyVuln(v);

  const npmVulns = vulns.filter(v => v._class === 'npm-package');
  const osVulns = vulns.filter(v => v._class === 'os-package');
  const binaryVulns = vulns.filter(v => v._class === 'third-party-binary');
  const otherVulns = vulns.filter(v => v._class === 'other');
  const fixable = vulns.filter(hasFix);
  const critical = vulns.filter(v => v.severity === 'critical');
  const high = vulns.filter(v => v.severity === 'high');

  // Group fixable vulns by package
  const fixableByPkg = Object.create(null);
  for (const v of fixable) {
    if (v._class === 'third-party-binary') continue;
    if (!fixableByPkg[v.package]) fixableByPkg[v.package] = { current: v.version, fixedIn: v.fixedIn, count: 0, maxSev: v.severity, class: v._class };
    fixableByPkg[v.package].count++;
    if (['critical', 'high'].includes(v.severity)) fixableByPkg[v.package].maxSev = v.severity;
  }

  // === Third-party binary vulnerabilities (Scout, Trivy, Docker CLI) ===
  if (binaryVulns.length > 0) {
    const binaryCritical = binaryVulns.filter(v => v.severity === 'critical');
    const toolNames = [...new Set(binaryVulns.map(v => {
      const t = (v.target || '').toLowerCase();
      if (t.includes('scout')) return 'Docker Scout';
      if (t.includes('trivy')) return 'Trivy';
      if (v.package.includes('docker/cli')) return 'Docker CLI';
      return 'third-party tool';
    }))];

    recs.push({
      priority: binaryCritical.length > 0 ? 'info' : 'info',
      type: 'third-party',
      title: `${binaryVulns.length} vulnerabilities in third-party tools (${toolNames.join(', ')})`,
      description: `These CVEs are in pre-compiled binaries bundled in the image (${toolNames.join(', ')}). `
        + `They are NOT in your application code and cannot be fixed by changing your Dockerfile or package.json. `
        + `They will be resolved automatically when the tool maintainers release updated versions. `
        + `Risk is low because these tools are not exposed to the network — they only run locally for scanning/CLI operations.`
        + (binaryCritical.length > 0 ? ` Affected: ${binaryCritical.map(v => `${v.id} (${v.package})`).join(', ')}.` : ''),
    });
  }

  // === OS package vulnerabilities ===
  if (osVulns.length > 0) {
    const isAlpine = imageName.includes('alpine') || osVulns.some(v => v.type === 'alpine');
    const isDebian = imageName.includes('debian') || imageName.includes('ubuntu') || osVulns.some(v => v.type === 'debian');
    const fixableOs = osVulns.filter(hasFix);
    const unfixableOs = osVulns.filter(v => !hasFix(v));

    if (fixableOs.length > 0) {
      recs.push({
        priority: 'high',
        type: 'update-base',
        title: `Update base image (${fixableOs.length} fixable OS vulnerabilities)`,
        description: `Rebuild with the latest base image and add a package upgrade step. Fixes: ${[...new Set(fixableOs.map(v => v.package))].join(', ')}.`,
        command: isAlpine ? 'RUN apk update && apk upgrade --no-cache' : isDebian ? 'RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*' : '# Upgrade OS packages',
      });
    }

    if (unfixableOs.length > 0) {
      recs.push({
        priority: 'info',
        type: 'accept-risk',
        title: `${unfixableOs.length} OS vulnerabilities without patches`,
        description: `These affect OS packages (${[...new Set(unfixableOs.map(v => v.package))].join(', ')}) that don't have fixes yet in the current Alpine/Debian release. They will be patched in future OS updates.`,
      });
    }
  }

  // === npm package vulnerabilities ===
  const npmFixable = Object.entries(fixableByPkg).filter(([, v]) => v.class === 'npm-package');
  const npmCritical = npmFixable.filter(([, v]) => v.maxSev === 'critical');
  const npmHigh = npmFixable.filter(([, v]) => v.maxSev === 'high');

  if (npmCritical.length > 0) {
    recs.push({
      priority: 'critical',
      type: 'upgrade-packages',
      title: `Upgrade ${npmCritical.length} critical npm package(s)`,
      description: npmCritical.map(([pkg, info]) => `${pkg}: ${info.current} → ${info.fixedIn}`).join(', '),
      command: `npm update ${npmCritical.map(([pkg]) => pkg).join(' ')}\n# Or add overrides in package.json:\n${npmCritical.map(([pkg, info]) => `#   "${pkg}": "${info.fixedIn}"`).join('\n')}`,
    });
  }

  if (npmHigh.length > 0) {
    recs.push({
      priority: 'high',
      type: 'upgrade-packages',
      title: `Upgrade ${npmHigh.length} high-severity npm package(s)`,
      description: npmHigh.map(([pkg, info]) => `${pkg}: ${info.current} → ${info.fixedIn}`).join(', '),
      command: `npm update ${npmHigh.map(([pkg]) => pkg).join(' ')}`,
    });
  }

  // === Other fixable (unclassified) ===
  const otherFixable = Object.entries(fixableByPkg).filter(([, v]) => v.class !== 'npm-package' && v.class !== 'os-package');
  if (otherFixable.length > 0) {
    recs.push({
      priority: 'medium',
      type: 'upgrade-packages',
      title: `${otherFixable.length} other fixable package(s)`,
      description: otherFixable.map(([pkg, info]) => `${pkg}: ${info.current} → ${info.fixedIn}`).join(', '),
    });
  }

  // === Architecture recommendation ===
  if (vulns.length > 20) {
    recs.push({
      priority: 'medium',
      type: 'architecture',
      title: 'Consider a minimal base image',
      description: `This image has ${vulns.length} vulnerabilities. Using distroless or scratch-based images can eliminate OS-level CVEs entirely.`,
    });
  }

  // === Summary ===
  recs.push({
    priority: 'info',
    type: 'summary',
    title: 'Summary',
    description: `${vulns.length} total: ${npmVulns.length} npm, ${osVulns.length} OS, ${binaryVulns.length} third-party tools, ${otherVulns.length} other. `
      + `${fixable.length} fixable by you, ${binaryVulns.length} require upstream tool updates. `
      + `${critical.length} critical, ${high.length} high.`,
  });

  return recs;
}

// Preserve the persistent Docker CLI configuration for registry/Compose users.
process.env.DOCKER_CONFIG ||= '/data/.docker';
function hasFix(finding) {
  const version = typeof finding.fixedIn === 'string' ? finding.fixedIn.trim() : '';
  return Boolean(version && !/^(?:not fixed|won.t fix|unknown|none|n\/a)$/i.test(version));
}

async function scanAndSave(docker, imageId, imageName, scanner, hostId, { userId = null, runId = null } = {}) {
  const report = await admission.scanImageReport(docker, imageId, scanner);
  const result = report.scanner === 'trivy' ? _trivyResult(report.data, imageName) : _grypeResult(report.data, imageName);
  const db = getDb();
  const fixable = result.vulnerabilities.filter(hasFix).length;
  const saved = db.prepare(`
    INSERT INTO scan_results (image_id, image_name, scanner, summary_critical, summary_high,
      summary_medium, summary_low, summary_total, fixable_count, results_json, recommendations_json, scanned_by, host_id, verified_image_id, security_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    imageId, imageName, result.scanner,
    result.summary.critical, result.summary.high, result.summary.medium, result.summary.low, result.summary.total,
    fixable, JSON.stringify(result.vulnerabilities), JSON.stringify(result.recommendations),
    userId, hostId, imageId, runId
  );
  result.scanId = Number(saved.lastInsertRowid);
  result.imageId = imageId;
  result.fixableCount = fixable;
  return result;
}

module.exports = { scanAndSave, hasFix, emptySummary: () => _makeSummary([]) };
