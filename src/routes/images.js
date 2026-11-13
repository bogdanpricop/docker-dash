'use strict';

const { Router } = require('express');
const dockerService = require('../services/docker');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');

const { getDb } = require('../db');

const { extractHostId } = require('../middleware/hostId');
const { requireHostAccessForMethod } = require('../middleware/hostAccess');
const asyncHandler = require('../utils/asyncHandler');
const imageScans = require('../services/image-scan-results');
const permissions = require('../services/permissions');
const { listSecondaryStacks } = require('../services/stack-display-preferences');

function scanHostScope(req) {
  return [req.resolvedHostId ?? req.hostId, Number(req.hostId === 0 && req.user.role === 'admin')];
}

async function imageVisibility(req, includeConsumers = false) {
  const hostId = req.resolvedHostId ?? req.hostId;
  const secondary = req.query.secondary === 'hide' ? new Set(listSecondaryStacks(req.user.id, hostId)) : new Set();
  const containers = secondary.size || includeConsumers
    ? permissions.filterContainers(await dockerService.listContainers(hostId), req.user.id, req.user.role) : [];
  const secondaryImages = new Set();
  const primaryImages = new Set();
  for (const container of containers) {
    if (!container.imageIdFull) continue;
    (secondary.has(container.stack) ? secondaryImages : primaryImages).add(container.imageIdFull);
  }
  return { hidden: [...secondaryImages].filter(id => !primaryImages.has(id)),
    containers: containers.filter(container => !secondary.has(container.stack)) };
}

const router = Router();
router.use(requireAuth);
router.use(extractHostId);
router.use(requireHostAccessForMethod());

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const hostId = req.resolvedHostId ?? req.hostId;
  const [images, visibility] = await Promise.all([dockerService.listImages(hostId), imageVisibility(req)]);
  const hidden = new Set(visibility.hidden);
  res.json(images.filter(image => !hidden.has(image.id)));
}));

router.get('/:id/inspect', requireAuth, asyncHandler(async (req, res) => {
  res.json(await dockerService.inspectImage(req.params.id, req.resolvedHostId ?? req.hostId));
}));

router.get('/:id/history', requireAuth, asyncHandler(async (req, res) => {
  res.json(await dockerService.imageHistory(req.params.id, req.resolvedHostId ?? req.hostId));
}));

router.get('/:id/tag-status', requireAuth, requireRole('admin', 'operator'), asyncHandler(async (req, res) => {
  const { reference } = req.query;
  const hostId = req.resolvedHostId ?? req.hostId;
  const docker = dockerService.getDocker(hostId);
  const image = await docker.getImage(req.params.id).inspect();
  if (typeof reference !== 'string' || !image.RepoTags?.includes(reference)) {
    return res.status(400).json({ error: 'Choose a tag installed on this image' });
  }
  const repository = reference.slice(0, reference.lastIndexOf(':'));
  const installed = (image.RepoDigests || []).filter(digest => digest.split('@')[0] === repository);
  const auth = require('../services/registry').getAuthForImage(reference);
  const remote = await docker.getImage(reference).distribution(auth ? { authconfig: auth } : {});
  const registryDigest = remote.Descriptor?.digest;
  if (!/^sha256:[a-f0-9]{64}$/.test(registryDigest || '')) return res.status(502).json({ error: 'Registry did not provide a digest' });
  res.json({ installed, registryDigest, status: !installed.length ? 'unknown'
    : installed.some(digest => digest.endsWith('@' + registryDigest)) ? 'same' : 'different' });
}));

// v8.95.0 — is this a Wasm image, and can this host actually run it?
//
// A Wasm image is identified by its OCI platform: os=wasi, architecture=wasm.
// Running one without a Wasm runtime registered gives `exec format error`, which
// is the single most common Wasm-on-Docker failure and says nothing useful. We
// hold both halves — the image's platform and the host's registered runtimes —
// so we can say it before the operator hits it.
//
// Read-only, and per-image rather than a sweep: inspecting every image to find
// the Wasm ones would be one round trip per image on hosts with hundreds.
router.get('/:id/wasm', requireAuth, asyncHandler(async (req, res) => {
  let inspect;
  try {
    inspect = await dockerService.inspectImage(req.params.id, req.resolvedHostId ?? req.hostId);
  } catch (err) {
    return res.status(err.statusCode === 404 ? 404 : 500).json({ error: err.message });
  }

  const os = String(inspect.Os || '').toLowerCase();
  const arch = String(inspect.Architecture || '').toLowerCase();
  const isWasm = os === 'wasi' && arch === 'wasm';

  // Host runtimes are best-effort: without them we still report what the image
  // is, but we must not claim anything about whether it will run here.
  let wasmRuntimes = null;
  try {
    const info = await dockerService.getInfo(req.resolvedHostId ?? req.hostId);
    wasmRuntimes = (info && info.runtimeCategories && info.runtimeCategories.wasm) || [];
  } catch { /* leave null — "unknown", not "incompatible" */ }

  res.json({
    isWasm,
    platform: os && arch ? `${os}/${arch}` : null,
    wasmRuntimes,
    hostHasWasmRuntime: wasmRuntimes === null ? null : wasmRuntimes.length > 0,
  });
}));

router.post('/pull', requireAuth, requireRole('admin', 'operator'), writeable, asyncHandler(async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'Image name required' });
  const output = await dockerService.pullImage(image, req.resolvedHostId ?? req.hostId);
  auditService.log({ userId: req.user.id, username: req.user.username,
    action: 'image_pull', targetType: 'image', targetId: image, ip: getClientIp(req) });
  res.json({ ok: true, output });
}));

// ─── Image Pull with SSE Streaming ─────────────────────────
router.post('/pull-stream', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'Image name required' });

  try {
    const docker = dockerService.getDocker(req.resolvedHostId ?? req.hostId);

    docker.pull(image, (err, stream) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      docker.modem.followProgress(stream, (err, _output) => {
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

router.delete('/:id', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  await dockerService.removeImage(req.params.id, { force: req.query.force === 'true' }, req.resolvedHostId ?? req.hostId);
  auditService.log({ userId: req.user.id, username: req.user.username,
    action: 'image_remove', targetType: 'image', targetId: req.params.id, ip: getClientIp(req) });
  res.json({ ok: true });
}));

// ─── Image Config (for creation wizard) ─────────────
router.get('/:id/config', requireAuth, asyncHandler(async (req, res) => {
  const data = await dockerService.inspectImage(req.params.id, req.resolvedHostId ?? req.hostId);
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
}));

// ─── Vulnerability Scanning ─────────────────────────
const { execFileSync } = require('child_process');
const scanLog = require('../utils/logger')('scan');

const SCOUT_DISABLED_REASON = 'Docker Scout is temporarily excluded because its latest published binary includes vulnerable dependencies and its plugin source is not publicly available for a security rebuild. Use Trivy or Grype. Scout will return only after a corrected build passes verification.';

// Keep a clear response for older clients without accepting or storing credentials.
router.post('/scout-login', requireAuth, requireRole('admin'), (req, res) => {
  res.status(503).json({ error: SCOUT_DISABLED_REASON, code: 'SCOUT_TEMPORARILY_DISABLED' });
});

// Check which scanners are installed and ready
router.get('/scanners', requireAuth, (req, res) => {
  const available = [];
  // v8.7.15 — explicit 5s timeout on version probes. The actual scan paths
  // (lines 128, 169, 219) all have 120s timeouts; these were inconsistent.
  // `trivy --version` should return instantly; if it hangs (broken install,
  // cache-lock issue) we want a fast failure, not an indefinite block on
  // the route that lists available scanners.
  try { execFileSync('trivy', ['--version'], { encoding: 'utf8', stdio: 'pipe', timeout: 5000 }); available.push('trivy'); } catch { /* trivy not installed */ }
  try { execFileSync('grype', ['version'], { encoding: 'utf8', stdio: 'pipe', timeout: 5000 }); available.push('grype'); } catch { /* grype not installed */ }
  res.json({ scanners: available, disabled: [{ scanner: 'docker-scout', reason: SCOUT_DISABLED_REASON }] });
});

router.get('/:id/scan', requireAuth, asyncHandler(async (req, res) => {
  if (['docker-scout', 'scout'].includes(String(req.query.scanner || '').toLowerCase())) {
    return res.status(503).json({ error: SCOUT_DISABLED_REASON, code: 'SCOUT_TEMPORARILY_DISABLED', scanner: 'none', status: 'disabled' });
  }
  const scanner = typeof req.query.scanner === 'string' ? req.query.scanner.toLowerCase() : 'auto';
  if (!['auto', 'trivy', 'grype'].includes(scanner)) return res.status(400).json({ error: 'Unknown vulnerability scanner' });
  const hostId = req.resolvedHostId ?? req.hostId;
  const imageData = await dockerService.inspectImage(req.params.id, hostId);
  const imageName = imageData.RepoTags?.[0] || req.params.id;
  let result;
  try {
    result = await imageScans.scanAndSave(dockerService.getDocker(hostId), imageData.Id, imageName, scanner, hostId, { userId: req.user.id });
  } catch (error) {
    scanLog.warn('Verified image scan unavailable', { hostId, imageId: imageData.Id, reason: error.message });
    return res.json({
      scanner: 'none', image: imageName, scannedAt: new Date().toISOString(),
      vulnerabilities: [], summary: imageScans.emptySummary(), message: error.message,
    });
  }
  res.json(result);
}));

// Scan history
router.get('/scan-history', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const { image, imageId, limit: lim } = req.query;
  const maxRows = Math.min(Math.max(parseInt(lim, 10) || 100, 1), 500);
  const cols = 'id, image_id, verified_image_id, image_name, scanner, summary_critical, summary_high, summary_medium, summary_low, summary_total, fixable_count, scanned_at, host_id';
  const filters = ['(host_id = ? OR (host_id = 0 AND ? = 1))'];
  const values = scanHostScope(req);
  const { hidden } = await imageVisibility(req);
  if (hidden.length) {
    filters.push('COALESCE(verified_image_id, image_id) NOT IN (SELECT value FROM json_each(?))');
    values.push(JSON.stringify(hidden));
  }
  if (typeof image === 'string') { filters.push('image_name = ?'); values.push(image); }
  if (typeof imageId === 'string') { filters.push('verified_image_id = ?'); values.push(imageId); }
  const rows = db.prepare(`SELECT ${cols} FROM scan_results WHERE ${filters.join(' AND ')}
    ORDER BY scanned_at DESC, id DESC LIMIT ?`).all(...values, maxRows);
  res.json(rows);
}));

// Get full scan result by ID
router.get('/scan-history/:id', requireAuth, asyncHandler((req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM scan_results WHERE id = ? AND (host_id = ? OR (host_id = 0 AND ? = 1))')
    .get(Number(req.params.id), ...scanHostScope(req));
  if (!row) return res.status(404).json({ error: 'Scan result not found' });
  row.vulnerabilities = JSON.parse(row.results_json || '[]');
  row.recommendations = JSON.parse(row.recommendations_json || '[]');
  delete row.results_json;
  delete row.recommendations_json;
  res.json(row);
}));

router.get('/scan-triage', requireAuth, asyncHandler(async (req, res) => {
  const hostId = req.resolvedHostId ?? req.hostId;
  const { hidden, containers } = await imageVisibility(req, true);
  const rows = getDb().prepare(`SELECT id, verified_image_id, image_name, scanner, scanned_at, results_json
    FROM scan_results AS scan
    WHERE host_id = ? AND verified_image_id IS NOT NULL
      AND verified_image_id NOT IN (SELECT value FROM json_each(?)) AND id = (
      SELECT MAX(id) FROM scan_results WHERE host_id = scan.host_id AND verified_image_id = scan.verified_image_id
    ) ORDER BY id DESC LIMIT 101`).all(hostId, JSON.stringify(hidden));
  const consumers = new Map();
  for (const container of containers) {
    if (!consumers.has(container.imageIdFull)) consumers.set(container.imageIdFull, []);
    consumers.get(container.imageIdFull).push({ id: container.id, name: container.name, stack: container.stack || '_standalone', state: container.state });
  }
  const findings = [];
  const severity = { critical: 0, high: 1, medium: 2, low: 3 };
  const scans = rows.slice(0, 100).map(row => {
    const { results_json: json, ...scan } = row;
    let vulnerabilities;
    try { vulnerabilities = JSON.parse(json); } catch { vulnerabilities = []; }
    if (!Array.isArray(vulnerabilities)) vulnerabilities = [];
    for (const finding of vulnerabilities) {
      findings.push({
        scanId: row.id, id: finding.id, package: finding.package, type: finding.type,
        version: finding.version, fixedIn: finding.fixedIn, severity: finding.severity, target: finding.target,
      });
    }
    return { ...scan, consumers: consumers.get(row.verified_image_id) || [] };
  });
  findings.sort((a, b) => (severity[a.severity] ?? 4) - (severity[b.severity] ?? 4) || b.scanId - a.scanId);
  res.json({
    host: { id: hostId, name: req.hostName }, scans, findings: findings.slice(0, 5000),
    truncated: rows.length > 100 || findings.length > 5000,
  });
}));

// Delete scan results by IDs (POST to avoid /:id route conflict)
router.post('/scan-history/delete', requireAuth, requireRole('admin'), writeable, asyncHandler((req, res) => {
  const { ids } = req.body;
  if (!ids?.length) return res.status(400).json({ error: 'ids array required' });
  // v8.7.39 — cap bulk delete. SQLite IN (...) builds a placeholder list
  // of length N; pre-fix a caller could submit 100k+ ids and pin the
  // writer. 1000 per call is generous (typical "clear all old scans" UI
  // is ≤ 100 entries); for full-table sweeps the operator should use
  // the retention purge cron instead.
  if (ids.length > 1000) {
    return res.status(413).json({ error: 'ids array exceeds max of 1000; split into multiple calls or use the retention purge' });
  }
  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  const result = db.prepare(`DELETE FROM scan_results WHERE id IN (${placeholders})`).run(...ids.map(Number));
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'scan_history_delete', details: { count: result.changes },
    ip: getClientIp(req),
  });
  res.json({ ok: true, deleted: result.changes });
}));

// Tag image
router.post('/:id/tag', requireAuth, requireRole('admin', 'operator'), writeable, asyncHandler(async (req, res) => {
  const { repo, tag } = req.body;
  if (!repo) return res.status(400).json({ error: 'repo required' });
  const docker = dockerService.getDocker(req.resolvedHostId ?? req.hostId);
  const image = docker.getImage(req.params.id);
  await image.tag({ repo, tag: tag || 'latest' });
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'image_tag', targetType: 'image', targetId: req.params.id,
    details: { repo, tag: tag || 'latest' }, ip: getClientIp(req),
  });
  res.json({ ok: true });
}));

// Export image as tar
router.get('/:id/export', requireAuth, asyncHandler(async (req, res) => {
  const docker = dockerService.getDocker(req.resolvedHostId ?? req.hostId);
  const image = docker.getImage(req.params.id);
  const info = await image.inspect();
  const name = (info.RepoTags?.[0] || req.params.id.substring(0, 12)).replace(/[/:]/g, '_');

  const stream = await image.get();
  res.setHeader('Content-Type', 'application/x-tar');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.tar"`);
  stream.pipe(res);
}));

// Import image from tar
router.post('/import', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const docker = dockerService.getDocker(req.resolvedHostId ?? req.hostId);
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
router.post('/build', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const { dockerfile, tag, buildArgs = {}, noCache = false, target = '' } = req.body;
  if (!dockerfile || !tag) return res.status(400).json({ error: 'dockerfile and tag required' });

  const docker = dockerService.getDocker(req.resolvedHostId ?? req.hostId);
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
      nocache: !!noCache,
      ...(target ? { target } : {}),
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
}));

// ─── Image Freshness Dashboard ────────────────────────

router.get('/freshness', requireAuth, asyncHandler(async (req, res) => {
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
}));

module.exports = router;
