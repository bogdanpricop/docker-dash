'use strict';

const { Router } = require('express');
const dockerService = require('../services/docker');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable, requireFeature } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');

const { getDb } = require('../db');

const { extractHostId } = require('../middleware/hostId');

const router = Router();
router.use(extractHostId);

router.get('/', requireAuth, async (req, res) => {
  try { res.json(await dockerService.listImages(req.hostId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id/inspect', requireAuth, async (req, res) => {
  try { res.json(await dockerService.inspectImage(req.params.id, req.hostId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id/history', requireAuth, async (req, res) => {
  try { res.json(await dockerService.imageHistory(req.params.id, req.hostId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/pull', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'Image name required' });
    const output = await dockerService.pullImage(image, req.hostId);
    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'image_pull', targetType: 'image', targetId: image, ip: getClientIp(req) });
    res.json({ ok: true, output });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Image Pull with SSE Streaming ─────────────────────────
router.post('/pull-stream', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'Image name required' });

  try {
    const docker = dockerService.getDocker(req.hostId);

    docker.pull(image, (err, stream) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      docker.modem.followProgress(stream, (err, output) => {
        // onFinished
        if (err) {
          res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ type: 'done', image })}\n\n`);
          auditService.log({ userId: req.user.id, username: req.user.username,
            action: 'image_pull', targetType: 'image', targetId: image, ip: getClientIp(req) });
        }
        res.end();
      }, (event) => {
        // onProgress — each layer event
        const data = {
          type: 'progress',
          id: event.id || '',
          status: event.status || '',
          progress: event.progress || '',
        };
        if (event.progressDetail && event.progressDetail.total) {
          data.current = event.progressDetail.current || 0;
          data.total = event.progressDetail.total;
        }
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      });
    });

    req.on('close', () => {
      // Client disconnected — stream will be cleaned up by Docker
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    await dockerService.removeImage(req.params.id, { force: req.query.force === 'true' }, req.hostId);
    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'image_remove', targetType: 'image', targetId: req.params.id, ip: getClientIp(req) });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Image Config (for creation wizard) ─────────────
router.get('/:id/config', requireAuth, async (req, res) => {
  try {
    const data = await dockerService.inspectImage(req.params.id, req.hostId);
    const config = data.Config || data.ContainerConfig || {};
    res.json({
      exposedPorts: Object.keys(config.ExposedPorts || {}),
      env: config.Env || [],
      cmd: config.Cmd || [],
      workingDir: config.WorkingDir || '',
      volumes: Object.keys(config.Volumes || {}),
      entrypoint: config.Entrypoint || [],
      labels: config.Labels || {},
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Vulnerability Scanning ─────────────────────────
const { execSync, execFileSync } = require('child_process');
const scanLog = require('../utils/logger')('scan');

function _makeSummary(vulns) {
  return {
    critical: vulns.filter(v => v.severity === 'critical').length,
    high: vulns.filter(v => v.severity === 'high').length,
    medium: vulns.filter(v => v.severity === 'medium').length,
    low: vulns.filter(v => v.severity === 'low').length,
    total: vulns.length,
  };
}

function _scanWithGrype(imageName) {
  const output = execFileSync('grype', [imageName, '-o', 'json', '--quiet'], {
    timeout: 180000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: 'pipe',
  });
  const data = JSON.parse(output);
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

function _scanWithScout(imageName) {
  // Docker Scout uses SARIF format for structured output
  const output = execFileSync('docker', ['scout', 'cves', imageName, '--format', 'sarif', '--only-severity', 'critical,high,medium,low'], {
    timeout: 120000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: 'pipe',
    env: { ...process.env, DOCKER_CONFIG: DOCKER_CONFIG_DIR },
  });
  const data = JSON.parse(output);

  // SARIF format: runs[].results[] + runs[].tool.driver.rules[]
  const vulns = [];
  for (const run of (data.runs || [])) {
    const rules = {};
    for (const rule of (run.tool?.driver?.rules || [])) {
      rules[rule.id] = rule;
    }
    for (const result of (run.results || [])) {
      const ruleId = result.ruleId || '';
      const rule = rules[ruleId] || {};
      const severity = (result.level === 'error' ? 'critical'
        : result.level === 'warning' ? 'high'
        : result.level === 'note' ? 'medium'
        : 'low');

      // Extract package info from message or properties
      const props = rule.properties || result.properties || {};
      const pkgName = props.affected_version
        ? (rule.shortDescription?.text?.split(' in ')?.[1]?.split(' ')?.[0] || ruleId)
        : (result.message?.text?.match(/Package:\s*(\S+)/)?.[1] || ruleId);

      vulns.push({
        id: ruleId,
        severity: (props.cvssV3_severity || severity).toLowerCase(),
        package: pkgName,
        version: props.affected_version || '?',
        fixedIn: props.fixed_version || null,
        title: rule.shortDescription?.text || result.message?.text?.substring(0, 120) || '',
      });
    }
  }

  const recommendations = _generateRemediation(vulns, imageName);
  return {
    scanner: 'docker-scout',
    image: imageName,
    scannedAt: new Date().toISOString(),
    vulnerabilities: vulns,
    summary: _makeSummary(vulns),
    recommendations,
  };
}

function _scanWithTrivy(imageName) {
  const output = execFileSync('trivy', ['image', '--format', 'json', '--quiet', imageName], {
    timeout: 180000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: 'pipe',
  });
  const data = JSON.parse(output);
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
  const fixable = vulns.filter(v => v.fixedIn && v.fixedIn !== 'not fixed');
  const unfixable = vulns.filter(v => !v.fixedIn || v.fixedIn === 'not fixed');
  const critical = vulns.filter(v => v.severity === 'critical');
  const high = vulns.filter(v => v.severity === 'high');

  // Group fixable vulns by package
  const fixableByPkg = {};
  for (const v of fixable) {
    if (v._class === 'third-party-binary') continue;
    if (!fixableByPkg[v.package]) fixableByPkg[v.package] = { current: v.version, fixedIn: v.fixedIn, count: 0, maxSev: v.severity, class: v._class };
    fixableByPkg[v.package].count++;
    if (['critical', 'high'].includes(v.severity)) fixableByPkg[v.package].maxSev = v.severity;
  }

  // === Third-party binary vulnerabilities (Scout, Trivy, Docker CLI) ===
  if (binaryVulns.length > 0) {
    const binaryCritical = binaryVulns.filter(v => v.severity === 'critical');
    const binaryHigh = binaryVulns.filter(v => v.severity === 'high');
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
    const fixableOs = osVulns.filter(v => v.fixedIn && v.fixedIn !== 'not fixed');
    const unfixableOs = osVulns.filter(v => !v.fixedIn || v.fixedIn === 'not fixed');

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
  const appVulns = npmVulns.length + osVulns.length + otherVulns.length;
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

// Persistent docker config path (survives container restarts)
const DOCKER_CONFIG_DIR = '/data/.docker';
const DOCKER_CONFIG_PATH = '/data/.docker/config.json';

// Ensure docker CLI uses our persistent config
process.env.DOCKER_CONFIG = DOCKER_CONFIG_DIR;

function _isScoutAuthenticated() {
  try {
    const fs = require('fs');
    if (fs.existsSync(DOCKER_CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(DOCKER_CONFIG_PATH, 'utf8'));
      if (config.auths && Object.keys(config.auths).length > 0) return true;
    }
    return false;
  } catch { return false; }
}

// Docker Scout authentication
router.post('/scout-login', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });

    const fs = require('fs');
    // Ensure persistent config directory exists
    if (!fs.existsSync(DOCKER_CONFIG_DIR)) fs.mkdirSync(DOCKER_CONFIG_DIR, { recursive: true });

    // Run docker login via execFileSync with stdin pipe (no shell interpolation)
    const result = execFileSync('docker', ['login', '-u', username, '--password-stdin'], {
      timeout: 30000, encoding: 'utf8', input: password,
      env: { ...process.env, DOCKER_CONFIG: DOCKER_CONFIG_DIR },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const success = result.includes('Login Succeeded') || result.includes('Succeeded');

    if (success) {
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'scout_login', details: { dockerHubUser: username },
        ip: getClientIp(req),
      });
    }

    res.json({ ok: success, output: result.trim() });
  } catch (err) {
    const output = err.stdout || err.stderr || err.message;
    res.json({ ok: false, error: output.includes('unauthorized') ? 'Invalid username or password/token' : output.trim() });
  }
});

// Check which scanners are installed and ready
router.get('/scanners', requireAuth, (req, res) => {
  const available = [];
  try { execFileSync('trivy', ['--version'], { encoding: 'utf8', stdio: 'pipe' }); available.push('trivy'); } catch { /* trivy not installed */ }
  try { execFileSync('grype', ['version'], { encoding: 'utf8', stdio: 'pipe' }); available.push('grype'); } catch { /* grype not installed */ }
  try {
    execFileSync('docker', ['scout', 'version'], { encoding: 'utf8', stdio: 'pipe' });
    if (_isScoutAuthenticated()) {
      available.push('docker-scout');
    } else {
      available.push('docker-scout (not authenticated)');
    }
  } catch { /* docker scout not installed or docker CLI unavailable */ }
  res.json({ scanners: available });
});

router.get('/:id/scan', requireAuth, async (req, res) => {
  try {
    const imageData = await dockerService.inspectImage(req.params.id, req.hostId);
    const imageName = imageData.RepoTags?.[0] || req.params.id;
    const preferredScanner = (req.query.scanner || 'auto').toLowerCase();

    let result = null;

    if (preferredScanner === 'docker-scout' || preferredScanner === 'scout') {
      try { result = _scanWithScout(imageName); }
      catch (err) { scanLog.warn('Docker Scout scan failed', err.message); }
      if (!result) {
        return res.json({
          scanner: 'none', image: imageName, scannedAt: new Date().toISOString(),
          vulnerabilities: [], summary: _makeSummary([]),
          message: 'Docker Scout scan failed. Ensure you are logged in to Docker Hub (docker login).',
        });
      }
    } else if (preferredScanner === 'trivy') {
      try { result = _scanWithTrivy(imageName); }
      catch (err) { scanLog.warn('Trivy scan failed', err.message); }
      if (!result) {
        return res.json({
          scanner: 'none', image: imageName, scannedAt: new Date().toISOString(),
          vulnerabilities: [], summary: _makeSummary([]),
          message: 'Trivy scan failed. Check that Trivy is installed correctly.',
        });
      }
    } else if (preferredScanner === 'grype') {
      try { result = _scanWithGrype(imageName); }
      catch (err) { scanLog.warn('Grype scan failed', err.message); }
      if (!result) {
        return res.json({
          scanner: 'none', image: imageName, scannedAt: new Date().toISOString(),
          vulnerabilities: [], summary: _makeSummary([]),
          message: 'Grype scan failed. Check that Grype is installed correctly.',
        });
      }
    } else {
      // Auto mode: try Trivy first, then Grype, then Scout
      try { result = _scanWithTrivy(imageName); }
      catch (err) { scanLog.debug('Trivy auto-scan failed, trying Grype', err.message); }
      if (!result) {
        try { result = _scanWithGrype(imageName); }
        catch (err) { scanLog.debug('Grype auto-scan failed, trying Scout', err.message); }
      }
      if (!result && _isScoutAuthenticated()) {
        try { result = _scanWithScout(imageName); }
        catch (err) { scanLog.debug('Scout auto-scan failed', err.message); }
      }
      if (!result) {
        result = {
          scanner: 'none', image: imageName, scannedAt: new Date().toISOString(),
          vulnerabilities: [], summary: _makeSummary([]),
          message: 'No vulnerability scanner available. Install Trivy or Grype, or authenticate Docker Scout.',
        };
      }
    }

    // Save scan results to database
    if (result.scanner !== 'none') {
      try {
        const db = getDb();
        const fixable = (result.vulnerabilities || []).filter(v => v.fixedIn).length;
        db.prepare(`
          INSERT INTO scan_results (image_id, image_name, scanner, summary_critical, summary_high,
            summary_medium, summary_low, summary_total, fixable_count, results_json, recommendations_json, scanned_by, host_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          req.params.id, result.image, result.scanner,
          result.summary.critical, result.summary.high, result.summary.medium, result.summary.low, result.summary.total,
          fixable, JSON.stringify(result.vulnerabilities), JSON.stringify(result.recommendations || []),
          req.user?.id || null, req.hostId || 0
        );
      } catch (e) { scanLog.warn('Failed to save scan result', e.message); }
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scan history
router.get('/scan-history', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const { image, limit: lim } = req.query;
    const hostId = req.hostId || 0;
    const maxRows = Math.min(parseInt(lim) || 100, 500);
    const cols = 'id, image_id, image_name, scanner, summary_critical, summary_high, summary_medium, summary_low, summary_total, fixable_count, scanned_at, host_id';

    let rows;
    if (image) {
      rows = db.prepare(`SELECT ${cols} FROM scan_results WHERE image_name = ? AND host_id = ? ORDER BY scanned_at DESC LIMIT ?`).all(image, hostId, maxRows);
    } else {
      rows = db.prepare(`SELECT ${cols} FROM scan_results WHERE host_id = ? ORDER BY scanned_at DESC LIMIT ?`).all(hostId, maxRows);
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get full scan result by ID
router.get('/scan-history/:id', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM scan_results WHERE id = ?').get(parseInt(req.params.id));
    if (!row) return res.status(404).json({ error: 'Scan result not found' });
    row.vulnerabilities = JSON.parse(row.results_json || '[]');
    row.recommendations = JSON.parse(row.recommendations_json || '[]');
    delete row.results_json;
    delete row.recommendations_json;
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete scan results by IDs (POST to avoid /:id route conflict)
router.post('/scan-history/delete', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'ids array required' });
    const db = getDb();
    const placeholders = ids.map(() => '?').join(',');
    const result = db.prepare(`DELETE FROM scan_results WHERE id IN (${placeholders})`).run(...ids.map(Number));
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'scan_history_delete', details: { count: result.changes },
      ip: getClientIp(req),
    });
    res.json({ ok: true, deleted: result.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tag image
router.post('/:id/tag', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  try {
    const { repo, tag } = req.body;
    if (!repo) return res.status(400).json({ error: 'repo required' });
    const docker = dockerService.getDocker(req.hostId);
    const image = docker.getImage(req.params.id);
    await image.tag({ repo, tag: tag || 'latest' });
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'image_tag', targetType: 'image', targetId: req.params.id,
      details: { repo, tag: tag || 'latest' }, ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export image as tar
router.get('/:id/export', requireAuth, async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    const image = docker.getImage(req.params.id);
    const info = await image.inspect();
    const name = (info.RepoTags?.[0] || req.params.id.substring(0, 12)).replace(/[/:]/g, '_');

    const stream = await image.get();
    res.setHeader('Content-Type', 'application/x-tar');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.tar"`);
    stream.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import image from tar
router.post('/import', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    docker.loadImage(req, (err, stream) => {
      if (err) return res.status(500).json({ error: err.message });
      let output = '';
      stream.on('data', (chunk) => { output += chunk.toString(); });
      stream.on('end', () => {
        auditService.log({
          userId: req.user.id, username: req.user.username,
          action: 'image_import', ip: getClientIp(req),
        });
        res.json({ ok: true, output });
      });
      stream.on('error', (err) => res.status(500).json({ error: err.message }));
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Image Build ────────────────────────────────────
router.post('/build', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  const { dockerfile, tag, buildArgs = {} } = req.body;
  if (!dockerfile || !tag) return res.status(400).json({ error: 'dockerfile and tag required' });

  try {
    const docker = dockerService.getDocker(req.hostId);
    // Create a tar archive containing the Dockerfile
    const tarHeader = Buffer.alloc(512);
    const content = Buffer.from(dockerfile, 'utf8');
    const name = 'Dockerfile';

    // TAR header
    Buffer.from(name).copy(tarHeader, 0);
    Buffer.from('0000644\0').copy(tarHeader, 100); // mode
    Buffer.from('0000000\0').copy(tarHeader, 108); // uid
    Buffer.from('0000000\0').copy(tarHeader, 116); // gid
    Buffer.from(content.length.toString(8).padStart(11, '0') + '\0').copy(tarHeader, 124); // size
    Buffer.from('0000000\0').copy(tarHeader, 136); // mtime
    Buffer.from('        ').copy(tarHeader, 148); // checksum placeholder
    tarHeader[156] = 48; // type: regular file

    // Calculate checksum
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += tarHeader[i];
    Buffer.from(checksum.toString(8).padStart(6, '0') + '\0 ').copy(tarHeader, 148);

    // Build tar
    const padding = Buffer.alloc(512 - (content.length % 512 || 512));
    const endBlock = Buffer.alloc(1024);
    const tarBuf = Buffer.concat([tarHeader, content, padding, endBlock]);

    // Start build
    const stream = await docker.buildImage(tarBuf, {
      t: tag,
      buildargs: JSON.stringify(buildArgs),
      rm: true,
    });

    // Stream output as SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    stream.on('data', (chunk) => {
      try {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          const json = JSON.parse(line);
          if (json.stream) {
            res.write(`data: ${JSON.stringify({ type: 'output', text: json.stream })}\n\n`);
          } else if (json.error) {
            res.write(`data: ${JSON.stringify({ type: 'error', text: json.error })}\n\n`);
          } else if (json.status) {
            res.write(`data: ${JSON.stringify({ type: 'status', text: json.status + (json.progress || '') })}\n\n`);
          }
        }
      } catch { /* partial JSON chunk from Docker stream; skip malformed data */ }
    });

    stream.on('end', () => {
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'image_build', targetType: 'image', targetId: tag,
        ip: getClientIp(req),
      });
    });

    stream.on('error', (err) => {
      res.write(`data: ${JSON.stringify({ type: 'error', text: err.message })}\n\n`);
      res.end();
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Image Freshness Dashboard ────────────────────────

router.get('/freshness', requireAuth, async (req, res) => {
  try {
    const hostId = req.hostId || 0;
    const images = await dockerService.listImages(hostId);
    const db = getDb();

    const results = images.map(img => {
      const repoTags = img.RepoTags || img.repoTags || [];
      const name = repoTags[0] || '<none>';
      const created = img.Created || img.created;
      const createdDate = new Date(typeof created === 'number' ? created * 1000 : created);
      const ageDays = Math.floor((Date.now() - createdDate.getTime()) / 86400000);

      // Get latest scan for this image
      const scan = db.prepare(`
        SELECT summary_critical, summary_high, summary_medium, summary_low, summary_total, scanned_at
        FROM scan_results WHERE image_name = ? AND host_id = ?
        ORDER BY scanned_at DESC LIMIT 1
      `).get(name.split(':')[0], hostId);

      // Freshness score: 100 = brand new, decays with age and vulns
      let freshness = 100;
      if (ageDays > 365) freshness -= 40;
      else if (ageDays > 180) freshness -= 25;
      else if (ageDays > 90) freshness -= 15;
      else if (ageDays > 30) freshness -= 5;

      if (scan) {
        if (scan.summary_critical > 0) freshness -= 30;
        else if (scan.summary_high > 5) freshness -= 20;
        else if (scan.summary_high > 0) freshness -= 10;
      }

      return {
        name,
        id: (img.Id || img.id || '').replace('sha256:', '').substring(0, 12),
        size: img.Size || img.size || 0,
        created: createdDate.toISOString(),
        age_days: ageDays,
        freshness: Math.max(0, Math.min(100, freshness)),
        scan: scan ? {
          critical: scan.summary_critical,
          high: scan.summary_high,
          medium: scan.summary_medium,
          low: scan.summary_low,
          total: scan.summary_total,
          scanned_at: scan.scanned_at,
        } : null,
      };
    });

    results.sort((a, b) => a.freshness - b.freshness); // Stalest first
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
