'use strict';

// v8.2.x further-split: extracted from src/routes/system.js.
// 9 routes covering /compose/:stack/* + /stacks list/get/create/config/env/
// deploy/validate. Mounted by system.js at `/` (NOT `/stacks` — the routes
// declare both `/stacks/...` and `/compose/...` paths, so the prefix would
// not match cleanly. Mounting at root keeps the exact original paths).

const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dockerService = require('../services/docker');
const { runCompose, auditTail, parseComposePlan } = require('../services/compose-runner');
const stacksFs = require('../services/stacks-fs');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const { extractHostId } = require('../middleware/hostId');
const asyncHandler = require('../utils/asyncHandler');
const { parseDockerRun } = require('../services/docker-run-parser');

const router = Router();
router.use(extractHostId);

const COMPOSE_ACTIONS = Object.freeze({
  up: ['up', '-d'],
  down: ['down'],
  restart: ['restart'],
  pull: ['pull'],
});
const MAX_USER_COMPOSE_RUNS = 3;
const activeComposeRuns = new Map();
const composePlanUnsupportedUntil = new Map();
const PLAN_CAPABILITY_TTL_MS = 5 * 60_000;

function _stackMatches(container, stackName) {
  return container.stack === stackName
    || container.labels?.['com.docker.compose.project'] === stackName;
}

function _knownBytes(value) {
  if (value == null) return null;
  const bytes = Number(value);
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
}

function _stackStorage(containers, images, volumes = [], stackName = '') {
  const imageById = new Map();
  const imageByRef = new Map();
  const volumeByName = new Map((volumes || []).map(volume => [volume.name, volume]));
  for (const image of images || []) {
    if (image.id) imageById.set(image.id, image);
    for (const ref of image.repoTags || []) imageByRef.set(ref, image);
  }

  const uniqueImageKeys = new Set();
  const measuredImages = new Map();
  let writableBytes = 0;
  let rootFsBytes = 0;
  let measuredContainers = 0;
  let measuredRootFs = 0;
  const namedVolumeNames = new Set();
  const measuredVolumes = new Map();
  const managedVolumeNames = new Set();
  let bindMounts = 0;
  let writableBindMounts = 0;
  let readOnlyBindMounts = 0;
  let tmpfsMounts = 0;

  const enriched = (containers || []).map(container => {
    const image = imageById.get(container.imageIdFull) || imageByRef.get(container.image) || null;
    const imageKey = image?.id || container.imageIdFull || `ref:${container.image}`;
    const imageSizeBytes = _knownBytes(image?.size);
    const writableSizeBytes = _knownBytes(container.sizeRw);
    const rootFsSizeBytes = _knownBytes(container.sizeRootFs);
    uniqueImageKeys.add(imageKey);
    if (imageSizeBytes != null) measuredImages.set(imageKey, imageSizeBytes);
    if (writableSizeBytes != null) {
      writableBytes += writableSizeBytes;
      measuredContainers++;
    }
    if (rootFsSizeBytes != null) {
      rootFsBytes += rootFsSizeBytes;
      measuredRootFs++;
    }
    const namedVolumeMounts = [];
    let containerBindMounts = 0;
    let containerWritableBindMounts = 0;
    let containerReadOnlyBindMounts = 0;
    let containerTmpfsMounts = 0;
    for (const mount of container.mounts || []) {
      if (mount.type === 'volume') {
        const name = mount.name || (volumeByName.has(mount.source) ? mount.source : null);
        if (!name) continue;
        const volume = volumeByName.get(name) || null;
        const sizeBytes = _knownBytes(volume?.size);
        const managed = volume?.labels?.['com.docker.compose.project'] === stackName;
        namedVolumeNames.add(name);
        if (sizeBytes != null) measuredVolumes.set(name, sizeBytes);
        if (managed) managedVolumeNames.add(name);
        namedVolumeMounts.push({ name, destination: mount.destination || '', rw: mount.rw !== false, sizeBytes, managed });
      } else if (mount.type === 'bind') {
        bindMounts++;
        containerBindMounts++;
        if (mount.rw === false) {
          readOnlyBindMounts++;
          containerReadOnlyBindMounts++;
        } else {
          writableBindMounts++;
          containerWritableBindMounts++;
        }
      } else if (mount.type === 'tmpfs') {
        tmpfsMounts++;
        containerTmpfsMounts++;
      }
    }
    return {
      ...container, imageSizeBytes, writableSizeBytes, rootFsSizeBytes,
      namedVolumeMounts, bindMountCount: containerBindMounts,
      writableBindMountCount: containerWritableBindMounts,
      readOnlyBindMountCount: containerReadOnlyBindMounts,
      tmpfsMountCount: containerTmpfsMounts,
    };
  });

  const imageBytes = [...measuredImages.values()].reduce((total, bytes) => total + bytes, 0);
  const imageMeasurementComplete = uniqueImageKeys.size > 0 && measuredImages.size === uniqueImageKeys.size;
  const containerMeasurementComplete = enriched.length > 0 && measuredContainers === enriched.length;
  const rootFsMeasurementComplete = enriched.length > 0 && measuredRootFs === enriched.length;
  const namedVolumeBytes = [...measuredVolumes.values()].reduce((total, bytes) => total + bytes, 0);
  const namedVolumeMeasurementComplete = measuredVolumes.size === namedVolumeNames.size;
  const storageFootprintComplete = imageMeasurementComplete && containerMeasurementComplete
    && namedVolumeMeasurementComplete;

  return {
    containers: enriched,
    storage: {
      available: measuredImages.size > 0 || measuredContainers > 0 || measuredRootFs > 0
        || namedVolumeNames.size > 0 || bindMounts > 0 || tmpfsMounts > 0,
      uniqueImages: uniqueImageKeys.size,
      measuredImages: measuredImages.size,
      measuredContainers,
      imageBytes: measuredImages.size > 0 ? imageBytes : null,
      writableBytes: measuredContainers > 0 ? writableBytes : null,
      rootFsBytes: measuredRootFs > 0 ? rootFsBytes : null,
      namedVolumes: namedVolumeNames.size,
      measuredNamedVolumes: measuredVolumes.size,
      namedVolumeBytes: namedVolumeNames.size === 0 || measuredVolumes.size > 0 ? namedVolumeBytes : null,
      managedNamedVolumes: managedVolumeNames.size,
      externalOrUnknownNamedVolumes: namedVolumeNames.size - managedVolumeNames.size,
      bindMounts,
      writableBindMounts,
      readOnlyBindMounts,
      tmpfsMounts,
      approximateFootprintBytes: storageFootprintComplete ? imageBytes + writableBytes + namedVolumeBytes : null,
      imageMeasurementComplete,
      containerMeasurementComplete,
      rootFsMeasurementComplete,
      namedVolumeMeasurementComplete,
      excludes: ['bind_mounts', 'logs', 'build_cache'],
    },
  };
}

function _filesystemStack(stackName) {
  return stacksFs.discover().find(candidate => candidate.name === stackName) || null;
}

function _readStackFiles(workingDir, composeFile = '') {
  let config = '';
  let resolvedComposeFile = composeFile;
  const candidates = composeFile
    ? [composeFile]
    : stacksFs.COMPOSE_FILES.map(name => path.join(workingDir, name));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        config = fs.readFileSync(candidate, 'utf8');
        resolvedComposeFile = candidate;
        break;
      }
    } catch { /* unreadable files are reported as an empty config */ }
  }

  let envFile = '';
  try {
    const envPath = path.join(workingDir, '.env');
    if (fs.existsSync(envPath)) envFile = fs.readFileSync(envPath, 'utf8');
  } catch { /* optional .env is unreadable */ }
  return { config, envFile, composeFile: resolvedComposeFile };
}

async function _allowedWorkingDir(req, stackName, requestedDir, { allowNew = false } = {}) {
  if (!requestedDir && !allowNew) return _resolveStackWorkingDir(req, stackName);
  const candidate = requestedDir || stacksFs.defaultStackDir(stackName);
  if (!candidate || !path.isAbsolute(candidate)) {
    throw Object.assign(new Error('A valid absolute working directory is required'), { status: 400 });
  }

  if (stacksFs._isInsideRoots(candidate)) return stacksFs.assertInsideRoots(candidate);

  // Preserve edit/deploy support for pre-existing Compose projects created
  // outside DD_STACKS_DIR, but only for the exact directory Docker reports.
  const containers = await dockerService.listContainers(req.hostId);
  const known = containers.some(container => _stackMatches(container, stackName)
    && container.labels?.['com.docker.compose.project.working_dir']
    && stacksFs._canonical(container.labels['com.docker.compose.project.working_dir'])
      === stacksFs._canonical(candidate));
  if (known) return stacksFs._canonical(candidate);

  throw Object.assign(new Error('Working directory must be inside DD_STACKS_DIR'), { status: 400 });
}

function _acquireComposeSlot(userId) {
  const key = String(userId || 'anonymous');
  const count = activeComposeRuns.get(key) || 0;
  if (count >= MAX_USER_COMPOSE_RUNS) {
    throw Object.assign(
      new Error(`At most ${MAX_USER_COMPOSE_RUNS} Compose operations may run concurrently`),
      { status: 429 }
    );
  }
  activeComposeRuns.set(key, count + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeComposeRuns.get(key) || 1) - 1;
    if (remaining > 0) activeComposeRuns.set(key, remaining);
    else activeComposeRuns.delete(key);
  };
}

function _errorMessage(err) {
  return String(err?.stderr || err?.message || 'Compose action failed').trim();
}

function _isPlanUnsupported(err) {
  const message = String(err?.output || err?.stderr || err?.message || '');
  return /(?:unknown|unrecognized|no such|not supported).{0,80}(?:dry-run|progress)|(?:dry-run|progress).{0,80}(?:unknown|unrecognized|not supported)/i.test(message);
}

async function _resolveStackWorkingDir(req, stack) {
  const containers = await dockerService.listContainers(req.hostId);
  const stackContainers = containers.filter(container => _stackMatches(container, stack));
  if (!stackContainers.length) {
    const discovered = _filesystemStack(stack);
    if (!discovered) throw Object.assign(new Error('Stack not found'), { status: 404 });
    return discovered.path;
  }

  const docker = dockerService.getDocker(req.hostId);
  const inspection = await docker.getContainer(stackContainers[0].id).inspect();
  const workingDir = inspection.Config?.Labels?.['com.docker.compose.project.working_dir'] || '';
  if (!workingDir || !path.isAbsolute(workingDir)) {
    throw Object.assign(new Error('Cannot determine compose working directory'), { status: 400 });
  }
  return workingDir;
}

function _dockerCliContext(hostId) {
  return require('../services/git')._dockerCliEnvForHost(hostId);
}

function _auditCompose(req, stack, action, workingDir, status, result) {
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: `compose_${action}`, targetType: 'stack', targetId: stack,
    details: {
      workingDir, hostId: req.hostId, status,
      exitCode: result?.exitCode ?? null,
      durationMs: result?.durationMs ?? null,
      outputTail: auditTail(result),
    },
    ip: getClientIp(req),
  });
}

function _sseWrite(res, event, payload) {
  if (res.destroyed || res.writableEnded) return;
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); }
  catch { /* client disconnected; compose keeps running to a safe completion */ }
}

// v8.9.7-alpha.1 — Dockge G06 closure: docker-run → compose converter.
// Public POST endpoint (auth required). Body: { command: '<docker run ...>' }.
// Returns { yaml, serviceName, service } or 400 with a parse error.
router.post('/compose/convert', requireAuth, asyncHandler(async (req, res) => {
  const { command } = req.body || {};
  if (!command) return res.status(400).json({ error: 'command is required' });
  try {
    const parsed = parseDockerRun(command);
    res.json({ ok: true, yaml: parsed.yaml, serviceName: parsed.service_name, service: parsed.service });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Produce a read-only plan with the exact Compose action and host context that
// execution will use. Unsupported Compose versions fail explicitly; this route
// never falls back to running the real mutation.
router.post('/compose/:stack/:action/plan', requireAuth, requireRole('admin', 'operator'), async (req, res) => {
  const { stack, action } = req.params;
  const args = COMPOSE_ACTIONS[action];
  if (!args) return res.status(400).json({ error: 'Invalid action' });

  const capabilityKey = String(req.hostId || 0);
  if ((composePlanUnsupportedUntil.get(capabilityKey) || 0) > Date.now()) {
    return res.status(501).json({
      code: 'compose_dry_run_unsupported',
      error: 'This host Docker Compose version does not support safe deployment plans',
    });
  }

  let workingDir;
  let release;
  let cliContext;
  try {
    release = _acquireComposeSlot(req.user.id);
    workingDir = await _resolveStackWorkingDir(req, stack);
    cliContext = _dockerCliContext(req.hostId);
    const result = await runCompose(['--progress', 'json', '--dry-run', ...args], {
      cwd: workingDir, env: cliContext.env, timeoutMs: 60_000, maxBytes: 1024 * 1024,
    });
    const plan = parseComposePlan(result);
    _auditCompose(req, stack, `${action}_plan`, workingDir, 'success', result);
    res.json({
      ok: true, stack, action, workingDir,
      durationMs: result.durationMs, ...plan,
    });
  } catch (err) {
    const unsupported = _isPlanUnsupported(err);
    if (unsupported) composePlanUnsupportedUntil.set(capabilityKey, Date.now() + PLAN_CAPABILITY_TTL_MS);
    if (workingDir) _auditCompose(req, stack, `${action}_plan`, workingDir, unsupported ? 'unsupported' : 'failed', err);
    res.status(unsupported ? 501 : (err.status || 500)).json({
      code: unsupported ? 'compose_dry_run_unsupported' : 'compose_plan_failed',
      error: unsupported
        ? 'This host Docker Compose version does not support safe deployment plans'
        : _errorMessage(err),
    });
  } finally {
    cliContext?.cleanup();
    release?.();
  }
});

router.post('/compose/:stack/:action/stream', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  const { stack, action } = req.params;
  const args = COMPOSE_ACTIONS[action];
  if (!args) return res.status(400).json({ error: 'Invalid action' });

  let workingDir;
  let release;
  let cliContext;
  try {
    release = _acquireComposeSlot(req.user.id);
    workingDir = await _resolveStackWorkingDir(req, stack);
    cliContext = _dockerCliContext(req.hostId);
  } catch (err) {
    cliContext?.cleanup();
    release?.();
    return res.status(err.status || 500).json({ error: _errorMessage(err) });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  _sseWrite(res, 'start', { stack, action, workingDir });

  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n');
  }, 15_000);
  heartbeat.unref?.();

  try {
    const result = await runCompose(args, {
      cwd: workingDir,
      env: cliContext.env,
      onOutput: output => _sseWrite(res, 'output', output),
    });
    _auditCompose(req, stack, action, workingDir, 'success', result);
    _sseWrite(res, 'done', {
      ok: true, exitCode: result.exitCode, durationMs: result.durationMs,
    });
  } catch (err) {
    _auditCompose(req, stack, action, workingDir, 'failed', err);
    _sseWrite(res, 'error', {
      error: _errorMessage(err), exitCode: err.exitCode ?? null,
      durationMs: err.durationMs ?? null,
    });
  } finally {
    clearInterval(heartbeat);
    cliContext.cleanup();
    release();
    if (!res.writableEnded) res.end();
  }
});

// Backward-compatible JSON endpoint. It now uses the same asynchronous
// runner, so API clients that do not consume SSE no longer block Node.
router.post('/compose/:stack/:action', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  const { stack, action } = req.params;
  const args = COMPOSE_ACTIONS[action];
  if (!args) return res.status(400).json({ error: 'Invalid action' });

  let workingDir;
  let release;
  let cliContext;
  try {
    release = _acquireComposeSlot(req.user.id);
    workingDir = await _resolveStackWorkingDir(req, stack);
    cliContext = _dockerCliContext(req.hostId);
    const result = await runCompose(args, { cwd: workingDir, env: cliContext.env });
    _auditCompose(req, stack, action, workingDir, 'success', result);
    res.json({
      ok: true, output: result.stdout, stderr: result.stderr,
      exitCode: result.exitCode, durationMs: result.durationMs,
    });
  } catch (err) {
    if (workingDir) _auditCompose(req, stack, action, workingDir, 'failed', err);
    res.status(err.status || 500).json({ error: _errorMessage(err) });
  } finally {
    cliContext?.cleanup();
    release?.();
  }
});

/** Reconstruct a best-effort docker-compose.yml from a container inspect result */
function _generateComposeFromInspect(inspection, _stackName) {
  const labels = inspection.Config?.Labels || {};
  const rawName = labels['com.docker.compose.service'] || (inspection.Name || '').replace(/^\//, '');
  const serviceName = rawName.replace(/[^a-z0-9_-]/gi, '_') || 'app';
  const image = inspection.Config?.Image || 'unknown';

  // Ports
  const portBindings = inspection.HostConfig?.PortBindings || {};
  const ports = [];
  for (const [containerPort, bindings] of Object.entries(portBindings)) {
    if (!bindings) continue;
    const cp = containerPort.replace(/\/tcp$/, '');
    for (const b of bindings) {
      ports.push(b.HostPort ? `"${b.HostPort}:${cp}"` : `"${cp}"`);
    }
  }

  // Environment — filter Docker/compose-injected internal vars
  const internalPrefixes = ['PATH=', 'HOME=', 'HOSTNAME='];
  const env = (inspection.Config?.Env || []).filter(e => !internalPrefixes.some(p => e.startsWith(p)));

  // Mounts: bind mounts + named volumes
  const mounts = inspection.Mounts || [];
  const bindMounts = mounts.filter(m => m.Type === 'bind')
    .map(m => `${m.Source}:${m.Destination}${m.RW === false ? ':ro' : ''}`);
  const namedVolumes = mounts.filter(m => m.Type === 'volume')
    .map(m => `${m.Name}:${m.Destination}`);
  const allMounts = [...bindMounts, ...namedVolumes];

  // Restart policy
  const rp = inspection.HostConfig?.RestartPolicy?.Name;
  const restart = (rp === 'always' || rp === 'unless-stopped' || rp === 'on-failure') ? rp : null;

  // Networks (skip default bridge)
  const networks = Object.keys(inspection.NetworkSettings?.Networks || {})
    .filter(n => n !== 'bridge' && n !== 'host' && n !== 'none');

  // Build YAML lines
  const lines = ['services:'];
  lines.push(`  ${serviceName}:`);
  lines.push(`    image: ${image}`);
  if (ports.length) { lines.push('    ports:'); ports.forEach(p => lines.push(`      - ${p}`)); }
  if (env.length) { lines.push('    environment:'); env.forEach(e => lines.push(`      - ${JSON.stringify(e)}`)); }
  if (allMounts.length) { lines.push('    volumes:'); allMounts.forEach(v => lines.push(`      - ${v}`)); }
  if (restart) lines.push(`    restart: ${restart}`);
  if (networks.length) {
    lines.push('    networks:');
    networks.forEach(n => lines.push(`      - ${n}`));
  }

  // Named volumes section
  if (namedVolumes.length) {
    lines.push('');
    lines.push('volumes:');
    namedVolumes.forEach(v => lines.push(`  ${v.split(':')[0]}:`));
  }

  // External networks section
  if (networks.length) {
    lines.push('');
    lines.push('networks:');
    networks.forEach(n => lines.push(`  ${n}:\n    external: true`));
  }

  return lines.join('\n');
}

router.get('/compose/:stack/config', requireAuth, async (req, res) => {
  try {
    const containers = await dockerService.listContainers(req.hostId);
    const stackContainers = containers.filter(c => _stackMatches(c, req.params.stack));
    const discovered = stackContainers.length ? null : _filesystemStack(req.params.stack);
    if (stackContainers.length === 0 && !discovered) return res.status(404).json({ error: 'Stack not found' });

    let firstContainer = null;
    let workingDir = discovered?.path || '';
    let configFile = discovered?.composeFile || '';
    if (stackContainers.length) {
      const docker = dockerService.getDocker(req.hostId);
      firstContainer = await docker.getContainer(stackContainers[0].id).inspect();
      workingDir = firstContainer.Config.Labels?.['com.docker.compose.project.working_dir'] || '';
      configFile = firstContainer.Config.Labels?.['com.docker.compose.project.config_files'] || '';
    }

    let config = '';
    let generated = false;

    if (workingDir) {
      try {
        const result = await runCompose(['config'], { cwd: workingDir, timeoutMs: 10_000 });
        config = result.stdout;
      } catch {
        config = _readStackFiles(workingDir, discovered?.composeFile).config;
      }
    }

    // Fallback: generate from container inspect metadata
    if (!config && firstContainer) {
      config = _generateComposeFromInspect(firstContainer, req.params.stack);
      generated = true;
    }

    res.json({ stack: req.params.stack, workingDir, configFile, config, generated });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Compose Validation ──────────────────────────────────────

// v8.7.35 SECURITY — requireRole('admin', 'operator') added. Pre-fix this
// route only required requireAuth; every other stack management route
// (compose action, create, config update, env, deploy) required admin
// or admin/operator. A viewer-role user could submit YAML to be written
// to /tmp and validated via `docker compose config` — invoking the
// docker CLI on the host, which viewers should not be able to do
// indirectly. The temp file was cleaned up correctly, so no disk leak;
// the concern is the implicit privilege escalation (viewer → docker
// daemon access via the validator) and the resource cost (writing
// bodies up to 2 MB to disk + spawning docker compose) on a
// repeatedly-callable endpoint that wasn't role-gated.
router.post('/stacks/:name/validate', requireAuth, requireRole('admin', 'operator'), async (req, res) => {
  try {
    const { config: yamlContent } = req.body;
    if (!yamlContent) return res.status(400).json({ error: 'config required' });

    // Write to temp file and validate with docker compose
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `dd-validate-${Date.now()}.yml`);
    try {
      fs.writeFileSync(tmpFile, yamlContent, 'utf8');
      await runCompose(['-f', tmpFile, 'config', '--quiet'], { timeoutMs: 10_000 });
      res.json({ valid: true });
    } catch (err) {
      const errorMsg = err.stderr || err.message || 'Validation failed';
      res.json({ valid: false, error: errorMsg });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});
router.get('/stacks', requireAuth, async (req, res) => {
  try {
    const containers = await dockerService.listContainers(req.hostId);
    const stacks = new Map();

    for (const c of containers) {
      const project = c.labels?.['com.docker.compose.project'];
      if (!project) continue;
      if (!stacks.has(project)) {
        stacks.set(project, {
          name: project,
          workingDir: c.labels?.['com.docker.compose.project.working_dir'] || '',
          configFile: c.labels?.['com.docker.compose.project.config_files'] || '',
          containers: [], running: 0, total: 0, serviceCount: 0,
          services: [], source: 'runtime', discovered: false, diskOnly: false,
        });
      }
      const stack = stacks.get(project);
      stack.containers.push({ id: c.id, name: c.name, state: c.state, image: c.image });
      stack.total++;
      if (c.state === 'running') stack.running++;
    }

    // Merge stack definitions found on disk. Runtime state wins when both
    // sources describe the same project; disk-only entries remain actionable.
    const gitReposRoot = path.resolve(process.env.DATA_DIR || '/data', 'repos');
    for (const diskStack of stacksFs.discover()) {
      const diskPath = path.resolve(diskStack.path);
      if (diskPath === gitReposRoot || diskPath.startsWith(gitReposRoot + path.sep)) continue;
      const existing = stacks.get(diskStack.name);
      if (existing) {
        existing.discovered = true;
        existing.composeFile = diskStack.composeFile;
        existing.services = diskStack.services;
        existing.serviceCount = diskStack.serviceCount;
        if (!existing.workingDir) existing.workingDir = diskStack.path;
        continue;
      }
      stacks.set(diskStack.name, {
        name: diskStack.name,
        workingDir: diskStack.path,
        configFile: diskStack.composeFile,
        composeFile: diskStack.composeFile,
        containers: [], running: 0, total: 0,
        serviceCount: diskStack.serviceCount,
        services: diskStack.services,
        source: 'filesystem', discovered: true, diskOnly: true, status: 'stopped',
      });
    }

    res.json([...stacks.values()].sort((a, b) => a.name.localeCompare(b.name)));
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/stacks/:name', requireAuth, async (req, res) => {
  try {
    const containers = await dockerService.listContainers(req.hostId, { includeSize: true });
    const stackContainers = containers.filter(c => _stackMatches(c, req.params.name));
    let workingDir = '';
    let source = 'runtime';
    let services = [];
    let serviceCount = stackContainers.length;
    if (stackContainers.length) {
      workingDir = stackContainers[0].labels?.['com.docker.compose.project.working_dir'] || '';
    } else {
      const discovered = stacksFs.discover().find(candidate => candidate.name === req.params.name);
      if (!discovered) return res.status(404).json({ error: 'Stack not found' });
      workingDir = discovered.path;
      source = 'filesystem';
      services = discovered.services;
      serviceCount = discovered.serviceCount;
    }

    const files = workingDir ? _readStackFiles(workingDir) : { config: '', envFile: '' };
    let images = [];
    let volumes = [];
    if (stackContainers.length) {
      const needsVolumes = stackContainers.some(container => (container.mounts || []).some(mount => mount.type === 'volume'));
      const [imageResult, volumeResult] = await Promise.allSettled([
        dockerService.listImages(req.hostId),
        needsVolumes ? dockerService.listVolumes(req.hostId) : Promise.resolve([]),
      ]);
      if (imageResult.status === 'fulfilled') images = imageResult.value;
      if (volumeResult.status === 'fulfilled') volumes = volumeResult.value;
    }
    const measured = _stackStorage(stackContainers, images, volumes, req.params.name);

    res.json({
      name: req.params.name,
      workingDir,
      containers: measured.containers.map(c => ({
        id: c.id,
        name: c.name,
        state: c.state,
        image: c.image,
        imageSizeBytes: c.imageSizeBytes,
        writableSizeBytes: c.writableSizeBytes,
        rootFsSizeBytes: c.rootFsSizeBytes,
        namedVolumeMounts: c.namedVolumeMounts,
        bindMountCount: c.bindMountCount,
        writableBindMountCount: c.writableBindMountCount,
        readOnlyBindMountCount: c.readOnlyBindMountCount,
        tmpfsMountCount: c.tmpfsMountCount,
      })),
      storage: measured.storage,
      config: files.config, source, services, serviceCount,
      status: stackContainers.some(c => c.state === 'running') ? 'running' : 'stopped',
      diskOnly: stackContainers.length === 0,
      envFile: files.envFile,
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create new stack from scratch
router.post('/stacks', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  let cliContext;
  try {
    const { name, dir, yaml, env } = req.body;
    if (!name || !yaml) return res.status(400).json({ error: 'name and yaml required' });
    const targetDir = await _allowedWorkingDir(req, name, dir, { allowNew: true });

    // Create directory
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Write compose file
    fs.writeFileSync(path.join(targetDir, 'docker-compose.yml'), yaml, 'utf8');

    // Write .env file if provided
    if (env && env.trim()) {
      fs.writeFileSync(path.join(targetDir, '.env'), env.trim() + '\n', 'utf8');
    }

    // Deploy the stack
    cliContext = _dockerCliContext(req.hostId);
    const result = await runCompose(['-p', name, 'up', '-d'], {
      cwd: targetDir, env: cliContext.env,
    });

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'stack_create', targetType: 'stack', targetId: name,
      details: {
        dir: targetDir, exitCode: result.exitCode,
        durationMs: result.durationMs, outputTail: auditTail(result),
      },
      ip: getClientIp(req),
    });

    res.status(201).json({ ok: true, output: result.stdout, stderr: result.stderr });
  } catch (err) {
    res.status(err.status || 500).json({ error: _errorMessage(err) });
  } finally {
    cliContext?.cleanup();
  }
});

router.put('/stacks/:name/config', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const { config: yamlContent, workingDir } = req.body;
    if (!yamlContent) return res.status(400).json({ error: 'config required' });
    const targetDir = await _allowedWorkingDir(req, req.params.name, workingDir, { allowNew: true });
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    let targetFile = null;
    for (const fname of stacksFs.COMPOSE_FILES) {
      const fp = path.join(targetDir, fname);
      if (fs.existsSync(fp)) { targetFile = fp; break; }
    }
    if (!targetFile) targetFile = path.join(targetDir, 'docker-compose.yml');

    // Backup existing file
    if (fs.existsSync(targetFile)) {
      fs.copyFileSync(targetFile, targetFile + '.bak');
    }
    fs.writeFileSync(targetFile, yamlContent, 'utf8');

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'stack_config_update', targetType: 'stack', targetId: req.params.name,
      details: { workingDir: targetDir }, ip: getClientIp(req),
    });

    res.json({ ok: true, workingDir: targetDir });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
  }
});

// Save .env file for stack
router.post('/stacks/:name/env', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const { env, workingDir } = req.body;
    const targetDir = await _allowedWorkingDir(req, req.params.name, workingDir);
    const envPath = path.join(targetDir, '.env');
    fs.writeFileSync(envPath, (env || '').trim() + '\n', 'utf8');
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'stack_env_update', targetType: 'stack', targetId: req.params.name,
      ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
  }
});

router.post('/stacks/:name/deploy', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  let cliContext;
  try {
    const { workingDir } = req.body;
    const targetDir = await _allowedWorkingDir(req, req.params.name, workingDir);
    cliContext = _dockerCliContext(req.hostId);
    const result = await runCompose(['up', '-d'], {
      cwd: targetDir, env: cliContext.env,
    });

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'stack_deploy', targetType: 'stack', targetId: req.params.name,
      details: {
        workingDir: targetDir, exitCode: result.exitCode,
        durationMs: result.durationMs, outputTail: auditTail(result),
      },
      ip: getClientIp(req),
    });

    res.json({ ok: true, output: result.stdout, stderr: result.stderr });
  } catch (err) {
    res.status(err.status || 500).json({ error: _errorMessage(err) });
  } finally {
    cliContext?.cleanup();
  }
});

module.exports = router;
