'use strict';

// v8.2.x further-split: extracted from src/routes/system.js.
// 9 routes covering /compose/:stack/* + /stacks list/get/create/config/env/
// deploy/validate. Mounted by system.js at `/` (NOT `/stacks` — the routes
// declare both `/stacks/...` and `/compose/...` paths, so the prefix would
// not match cleanly. Mounting at root keeps the exact original paths).

const { Router } = require('express');
const { execFileSync } = require('child_process');
const dockerService = require('../services/docker');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const { extractHostId } = require('../middleware/hostId');

const router = Router();
router.use(extractHostId);

router.post('/compose/:stack/:action', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  const { stack, action } = req.params;
  const validActions = ['up', 'down', 'restart', 'pull'];
  if (!validActions.includes(action)) return res.status(400).json({ error: 'Invalid action' });

  try {
    // Find compose project dir
    const containers = await dockerService.listContainers(req.hostId);
    const stackContainers = containers.filter(c => c.stack === stack);
    if (stackContainers.length === 0) return res.status(404).json({ error: 'Stack not found' });

    // Get compose file path from labels
    const docker = dockerService.getDocker(req.hostId);
    const firstContainer = await docker.getContainer(stackContainers[0].id).inspect();
    const workingDir = firstContainer.Config.Labels?.['com.docker.compose.project.working_dir'] || '';

    if (!workingDir) return res.status(400).json({ error: 'Cannot determine compose working directory' });

    const composeArgs = { up: ['up', '-d'], down: ['down'], restart: ['restart'], pull: ['pull'] };
    const args = ['compose', ...(composeArgs[action] || [])];

    const output = execFileSync('docker', args, { cwd: workingDir, timeout: 120000, encoding: 'utf8', stdio: 'pipe' });

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: `compose_${action}`, targetType: 'stack', targetId: stack,
      details: { workingDir }, ip: getClientIp(req),
    });

    res.json({ ok: true, output });
  } catch (err) {
    res.status(500).json({ error: err.stderr || err.message });
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
    const stackContainers = containers.filter(c => c.stack === req.params.stack);
    if (stackContainers.length === 0) return res.status(404).json({ error: 'Stack not found' });

    const docker = dockerService.getDocker(req.hostId);
    const firstContainer = await docker.getContainer(stackContainers[0].id).inspect();
    const workingDir = firstContainer.Config.Labels?.['com.docker.compose.project.working_dir'] || '';
    const configFile = firstContainer.Config.Labels?.['com.docker.compose.project.config_files'] || '';

    let config = '';
    let generated = false;

    if (workingDir) {
      try {
        config = execFileSync('docker', ['compose', 'config'], { cwd: workingDir, timeout: 10000, encoding: 'utf8', stdio: 'pipe' });
      } catch {
        // Try reading compose files directly
        const fsSync = require('fs');
        const pathSync = require('path');
        for (const fname of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
          const fp = pathSync.join(workingDir, fname);
          if (fsSync.existsSync(fp)) { config = fsSync.readFileSync(fp, 'utf8'); break; }
        }
      }
    }

    // Fallback: generate from container inspect metadata
    if (!config) {
      config = _generateComposeFromInspect(firstContainer, req.params.stack);
      generated = true;
    }

    res.json({ stack: req.params.stack, workingDir, configFile, config, generated });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Compose Validation ──────────────────────────────────────
const fs = require('fs');
const path = require('path');
const os = require('os');

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
      execFileSync('docker', ['compose', '-f', tmpFile, 'config', '--quiet'], {
        timeout: 10000, encoding: 'utf8', stdio: 'pipe',
      });
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
    const stacks = {};

    for (const c of containers) {
      const project = c.labels?.['com.docker.compose.project'];
      if (!project) continue;
      if (!stacks[project]) {
        stacks[project] = {
          name: project,
          workingDir: c.labels?.['com.docker.compose.project.working_dir'] || '',
          configFile: c.labels?.['com.docker.compose.project.config_files'] || '',
          containers: [], running: 0, total: 0,
        };
      }
      stacks[project].containers.push({ id: c.id, name: c.name, state: c.state, image: c.image });
      stacks[project].total++;
      if (c.state === 'running') stacks[project].running++;
    }

    res.json(Object.values(stacks));
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/stacks/:name', requireAuth, async (req, res) => {
  try {
    const containers = await dockerService.listContainers(req.hostId);
    const stackContainers = containers.filter(c => c.labels?.['com.docker.compose.project'] === req.params.name);
    if (stackContainers.length === 0) return res.status(404).json({ error: 'Stack not found' });

    const first = stackContainers[0];
    const workingDir = first.labels?.['com.docker.compose.project.working_dir'] || '';

    let config = '';
    if (workingDir) {
      const path = require('path');
      for (const fname of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
        const fp = path.join(workingDir, fname);
        try {
          if (fs.existsSync(fp)) { config = fs.readFileSync(fp, 'utf8'); break; }
        } catch (err) { /* compose file not readable */ }
      }
    }

    // Read .env file if exists
    let envFile = '';
    if (workingDir) {
      const path = require('path');
      const envPath = path.join(workingDir, '.env');
      try { if (fs.existsSync(envPath)) envFile = fs.readFileSync(envPath, 'utf8'); } catch (err) { /* .env not readable */ }
    }

    res.json({
      name: req.params.name,
      workingDir,
      containers: stackContainers.map(c => ({ id: c.id, name: c.name, state: c.state, image: c.image })),
      config,
      envFile,
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create new stack from scratch
router.post('/stacks', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const { name, dir, yaml, env } = req.body;
    if (!name || !yaml) return res.status(400).json({ error: 'name and yaml required' });

    const path = require('path');
    const targetDir = dir || `/opt/${name}`;

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
    const output = execFileSync('docker', ['compose', '-p', name, 'up', '-d'], { cwd: targetDir, timeout: 120000, encoding: 'utf8', stdio: 'pipe' });

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'stack_create', targetType: 'stack', targetId: name,
      details: { dir: targetDir }, ip: getClientIp(req),
    });

    res.status(201).json({ ok: true, output });
  } catch (err) {
    res.status(500).json({ error: err.stderr || err.message });
  }
});

router.put('/stacks/:name/config', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const { config: yamlContent, workingDir } = req.body;
    if (!yamlContent || !workingDir) return res.status(400).json({ error: 'config and workingDir required' });

    const path = require('path');
    let targetFile = null;
    for (const fname of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
      const fp = path.join(workingDir, fname);
      if (fs.existsSync(fp)) { targetFile = fp; break; }
    }
    if (!targetFile) targetFile = path.join(workingDir, 'docker-compose.yml');

    // Backup existing file
    if (fs.existsSync(targetFile)) {
      fs.copyFileSync(targetFile, targetFile + '.bak');
    }
    fs.writeFileSync(targetFile, yamlContent, 'utf8');

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'stack_config_update', targetType: 'stack', targetId: req.params.name,
      details: { workingDir }, ip: getClientIp(req),
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Save .env file for stack
router.post('/stacks/:name/env', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const { env, workingDir } = req.body;
    if (!workingDir) return res.status(400).json({ error: 'workingDir required' });
    const path = require('path');
    const envPath = path.join(workingDir, '.env');
    fs.writeFileSync(envPath, (env || '').trim() + '\n', 'utf8');
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'stack_env_update', targetType: 'stack', targetId: req.params.name,
      ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/stacks/:name/deploy', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const { workingDir } = req.body;
    if (!workingDir) return res.status(400).json({ error: 'workingDir required' });
    const output = execFileSync('docker', ['compose', 'up', '-d'], { cwd: workingDir, timeout: 120000, encoding: 'utf8', stdio: 'pipe' });

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'stack_deploy', targetType: 'stack', targetId: req.params.name,
      details: { workingDir }, ip: getClientIp(req),
    });

    res.json({ ok: true, output });
  } catch (err) {
    res.status(500).json({ error: err.stderr || err.message });
  }
});

module.exports = router;
