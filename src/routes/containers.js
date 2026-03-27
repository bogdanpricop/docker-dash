'use strict';

const { Router } = require('express');
const dockerService = require('../services/docker');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable, requireFeature } = require('../middleware/auth');
const { getClientIp, sanitizeId } = require('../utils/helpers');
const { getDb } = require('../db');

const { extractHostId } = require('../middleware/hostId');

const router = Router();
router.use(extractHostId);

// List containers
router.get('/', requireAuth, async (req, res) => {
  try {
    const containers = await dockerService.listContainers(req.hostId);
    res.json(containers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Container Metadata ───────────────────────────
// Bulk: get all container metadata (for list view enrichment)
router.get('/_meta', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM container_meta').all();
    const map = {};
    rows.forEach(r => {
      try { r.custom_fields = JSON.parse(r.custom_fields || '{}'); } catch { r.custom_fields = {}; }
      map[r.container_name] = r;
    });
    res.json(map);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get metadata for a single container by name
router.get('/:name/meta', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM container_meta WHERE container_name = ?').get(req.params.name);
    if (!row) {
      return res.json({
        container_name: req.params.name,
        app_name: '', description: '', lan_link: '', web_link: '',
        docs_url: '', category: '', owner: '', icon: '', color: '',
        notes: '', custom_fields: {},
      });
    }
    try { row.custom_fields = JSON.parse(row.custom_fields || '{}'); } catch { row.custom_fields = {}; }
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update (upsert) metadata for a container
router.put('/:name/meta', requireAuth, requireRole('admin', 'operator'), writeable, (req, res) => {
  try {
    const db = getDb();
    const { app_name, description, lan_link, web_link, docs_url,
            category, owner, icon, color, notes, custom_fields } = req.body;
    const customJson = typeof custom_fields === 'string' ? custom_fields : JSON.stringify(custom_fields || {});

    db.prepare(`
      INSERT INTO container_meta (container_name, app_name, description, lan_link, web_link, docs_url, category, owner, icon, color, notes, custom_fields, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(container_name) DO UPDATE SET
        app_name=excluded.app_name, description=excluded.description,
        lan_link=excluded.lan_link, web_link=excluded.web_link,
        docs_url=excluded.docs_url, category=excluded.category,
        owner=excluded.owner, icon=excluded.icon, color=excluded.color,
        notes=excluded.notes, custom_fields=excluded.custom_fields,
        updated_at=datetime('now')
    `).run(req.params.name, app_name || '', description || '', lan_link || '', web_link || '',
           docs_url || '', category || '', owner || '', icon || '', color || '',
           notes || '', customJson);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'container_meta_update', targetType: 'container', targetId: req.params.name,
      ip: getClientIp(req),
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inspect container
router.get('/:id/inspect', requireAuth, async (req, res) => {
  try {
    const data = await dockerService.inspectContainer(req.params.id, req.hostId);
    res.json(data);
  } catch (err) {
    res.status(err.statusCode === 404 ? 404 : 500).json({ error: err.message });
  }
});

// Container logs (enhanced with regex, level filter, stats)
router.get('/:id/logs', requireAuth, async (req, res) => {
  try {
    const { tail, since, until, search, regex, level, download } = req.query;
    let lines = await dockerService.getContainerLogs(req.params.id, {
      tail: parseInt(tail) || 100,
      since, until,
    }, req.hostId);

    // Server-side full-text search
    if (search) {
      const q = search.toLowerCase();
      lines = lines.filter(l => l.toLowerCase().includes(q));
    }

    // Regex search (with length limit to prevent ReDoS)
    if (regex) {
      try {
        if (regex.length > 200) throw new Error('Regex too long');
        const re = new RegExp(regex, 'i');
        // Test on first line to detect catastrophic backtracking
        const testLine = lines[0] || '';
        const start = Date.now();
        re.test(testLine);
        if (Date.now() - start > 100) throw new Error('Regex too slow');
        lines = lines.filter(l => re.test(l));
      } catch { /* invalid/dangerous regex, skip */ }
    }

    // Log level filter (ERROR, WARN, INFO, DEBUG)
    if (level) {
      const levels = level.split(',').map(l => l.trim().toLowerCase());
      const patterns = {
        error: /\b(error|fatal|panic|exception|critical)\b/i,
        warn: /\b(warn|warning)\b/i,
        info: /\b(info)\b/i,
        debug: /\b(debug|trace)\b/i,
      };
      lines = lines.filter(line => {
        return levels.some(lvl => patterns[lvl]?.test(line));
      });
    }

    // Log stats summary
    const stats = {
      total: lines.length,
      errors: lines.filter(l => /\b(error|fatal|panic|exception)\b/i.test(l)).length,
      warnings: lines.filter(l => /\b(warn|warning)\b/i.test(l)).length,
    };

    // Download as file
    if (download === 'true') {
      const name = req.params.id.substring(0, 12);
      const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="logs-${name}-${ts}.log"`);
      return res.send(lines.join('\n'));
    }

    res.json({ lines, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Container stats (one-shot)
router.get('/:id/stats', requireAuth, async (req, res) => {
  try {
    const stats = await dockerService.getContainerStats(req.params.id, req.hostId);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Container actions (start/stop/restart/pause/unpause/kill)
router.post('/:id/:action', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  const validActions = ['start', 'stop', 'restart', 'pause', 'unpause', 'kill'];
  const { id, action } = req.params;

  if (!validActions.includes(action)) {
    return res.status(400).json({ error: `Invalid action: ${action}` });
  }

  try {
    await dockerService.containerAction(id, action, req.hostId);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: `container_${action}`, targetType: 'container', targetId: id,
      ip: getClientIp(req),
    });
    res.json({ ok: true, action });
  } catch (err) {
    res.status(err.message.includes('Docker Dash') ? 403 : 500).json({ error: err.message });
  }
});

// Remove container
router.delete('/:id', requireAuth, requireRole('admin'), writeable, requireFeature('remove'), async (req, res) => {
  try {
    const { force, v } = req.query;
    await dockerService.removeContainer(req.params.id, {
      force: force === 'true', v: v === 'true',
    }, req.hostId);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'container_remove', targetType: 'container', targetId: req.params.id,
      details: { force, removeVolumes: v }, ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.message.includes('Docker Dash') ? 403 : 500).json({ error: err.message });
  }
});

// Rename container
router.put('/:id/rename', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    await dockerService.renameContainer(req.params.id, name, req.hostId);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'container_rename', targetType: 'container', targetId: req.params.id,
      details: { newName: name }, ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create container
router.post('/', requireAuth, requireRole('admin'), writeable, requireFeature('create'), async (req, res) => {
  try {
    const result = await dockerService.createContainer(req.body, req.hostId);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'container_create', targetType: 'container', targetId: result.id,
      details: { image: req.body.Image, name: req.body.name }, ip: getClientIp(req),
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clone/duplicate container
router.post('/:id/clone', requireAuth, requireRole('admin'), writeable, requireFeature('create'), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const docker = dockerService.getDocker(req.hostId);
    const source = docker.getContainer(req.params.id);
    const inspect = await source.inspect();

    const createOpts = {
      name,
      Image: inspect.Config.Image,
      Cmd: inspect.Config.Cmd,
      Env: inspect.Config.Env,
      ExposedPorts: inspect.Config.ExposedPorts,
      Labels: { ...(inspect.Config.Labels || {}) },
      WorkingDir: inspect.Config.WorkingDir,
      Entrypoint: inspect.Config.Entrypoint,
      Volumes: inspect.Config.Volumes,
      User: inspect.Config.User,
      HostConfig: {
        ...inspect.HostConfig,
        // Clear port bindings to avoid conflicts
        PortBindings: {},
      },
      NetworkingConfig: { EndpointsConfig: inspect.NetworkSettings?.Networks || {} },
    };

    // Remove compose labels from clone
    delete createOpts.Labels['com.docker.compose.project'];
    delete createOpts.Labels['com.docker.compose.service'];
    delete createOpts.Labels['com.docker.compose.config-hash'];
    delete createOpts.Labels['com.docker.compose.container-number'];
    delete createOpts.Labels['com.docker.compose.depends_on'];
    delete createOpts.Labels['com.docker.compose.image'];
    delete createOpts.Labels['com.docker.compose.oneoff'];
    delete createOpts.Labels['com.docker.compose.project.config_files'];
    delete createOpts.Labels['com.docker.compose.project.working_dir'];
    delete createOpts.Labels['com.docker.compose.version'];

    const newContainer = await docker.createContainer(createOpts);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'container_clone', targetType: 'container', targetId: name,
      details: { sourceId: req.params.id, sourceName: inspect.Name?.replace(/^\//, '') },
      ip: getClientIp(req),
    });

    res.status(201).json({ ok: true, id: newContainer.id, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk actions
router.post('/bulk', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  const { ids, action } = req.body;
  if (!ids?.length || !action) return res.status(400).json({ error: 'ids and action required' });

  const results = [];
  for (const id of ids) {
    try {
      if (action === 'remove') {
        await dockerService.removeContainer(id, { force: true }, req.hostId);
      } else {
        await dockerService.containerAction(id, action, req.hostId);
      }
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: err.message });
    }
  }

  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: `bulk_${action}`, targetType: 'container',
    details: { ids, results: results.filter(r => !r.ok) }, ip: getClientIp(req),
  });

  res.json({ results });
});

// Update container (pull latest + recreate)
router.post('/:id/update', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  const { id } = req.params;
  try {
    const docker = dockerService.getDocker(req.hostId);
    const container = docker.getContainer(id);
    const inspect = await container.inspect();
    const image = inspect.Config.Image;
    const name = inspect.Name.replace(/^\//, '');

    if (dockerService.isSelf(inspect.Id)) {
      return res.status(403).json({ error: 'Cannot update Docker Dash itself' });
    }

    // Check if part of compose project
    const project = inspect.Config.Labels?.['com.docker.compose.project'];
    const workingDir = inspect.Config.Labels?.['com.docker.compose.project.working_dir'];

    if (project && workingDir) {
      // Use docker compose for stack containers — sanitize labels to prevent injection
      const { execFileSync } = require('child_process');
      const { sanitizeShellArg } = require('../utils/helpers');
      const safeDir = sanitizeShellArg(workingDir);
      const service = sanitizeShellArg(inspect.Config.Labels?.['com.docker.compose.service'] || '');

      if (!safeDir || !require('fs').existsSync(safeDir)) {
        return res.status(400).json({ error: 'Invalid compose working directory' });
      }

      const pullArgs = service
        ? ['compose', 'pull', service]
        : ['compose', 'pull'];
      const upArgs = service
        ? ['compose', 'up', '-d', service]
        : ['compose', 'up', '-d'];

      execFileSync('docker', pullArgs, { cwd: safeDir, timeout: 120000, encoding: 'utf8' });
      const output = execFileSync('docker', upArgs, { cwd: safeDir, timeout: 60000, encoding: 'utf8' });

      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'container_update', targetType: 'container', targetId: name,
        details: { image, method: 'compose', project }, ip: getClientIp(req),
      });
      return res.json({ ok: true, method: 'compose', output });
    }

    // Manual pull + recreate for standalone containers
    await new Promise((resolve, reject) => {
      docker.pull(image, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err) => err ? reject(err) : resolve());
      });
    });

    const wasRunning = inspect.State.Running;
    if (wasRunning) await container.stop();
    await container.remove();

    const createOpts = {
      name,
      Image: inspect.Config.Image,
      Cmd: inspect.Config.Cmd,
      Env: inspect.Config.Env,
      ExposedPorts: inspect.Config.ExposedPorts,
      Labels: inspect.Config.Labels,
      WorkingDir: inspect.Config.WorkingDir,
      Entrypoint: inspect.Config.Entrypoint,
      Volumes: inspect.Config.Volumes,
      Hostname: inspect.Config.Hostname,
      User: inspect.Config.User,
      HostConfig: inspect.HostConfig,
      NetworkingConfig: { EndpointsConfig: inspect.NetworkSettings?.Networks || {} },
    };

    const newContainer = await docker.createContainer(createOpts);
    if (wasRunning) await newContainer.start();

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'container_update', targetType: 'container', targetId: name,
      details: { image, method: 'recreate', newId: newContainer.id },
      ip: getClientIp(req),
    });

    res.json({ ok: true, method: 'recreate', newId: newContainer.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export container config
router.get('/:id/export', requireAuth, async (req, res) => {
  try {
    const data = await dockerService.inspectContainer(req.params.id, req.hostId);
    const { format } = req.query;

    if (format === 'compose') {
      const compose = generateCompose(data);
      res.type('text/yaml').send(compose);
    } else if (format === 'run') {
      const cmd = generateRunCommand(data);
      res.type('text/plain').send(cmd);
    } else {
      res.json(data);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function generateCompose(data) {
  const lines = ['services:', `  ${data.name}:`, `    image: ${data.image}`];
  const rp = data.restartPolicy;
  if (rp && rp.Name && rp.Name !== 'no') {
    lines.push(`    restart: ${rp.Name}${rp.MaximumRetryCount ? `:${rp.MaximumRetryCount}` : ''}`);
  }
  if (data.env?.length) {
    lines.push('    environment:');
    data.env.forEach(e => lines.push(`      - ${e}`));
  }
  const ports = data.ports || {};
  const portEntries = Object.entries(ports).filter(([, v]) => v?.length);
  if (portEntries.length) {
    lines.push('    ports:');
    portEntries.forEach(([container, bindings]) => {
      bindings.forEach(b => {
        lines.push(`      - "${b.HostPort || ''}:${container.replace('/tcp', '').replace('/udp', '')}"`);
      });
    });
  }
  if (data.mounts?.length) {
    lines.push('    volumes:');
    data.mounts.forEach(m => {
      const ro = m.RW === false ? ':ro' : '';
      lines.push(`      - ${m.Source || m.Name}:${m.Destination}${ro}`);
    });
  }
  const nets = Object.keys(data.networks || {}).filter(n => n !== 'bridge');
  if (nets.length) {
    lines.push('    networks:');
    nets.forEach(n => lines.push(`      - ${n}`));
  }
  const labels = Object.entries(data.labels || {}).filter(([k]) => !k.startsWith('com.docker.compose'));
  if (labels.length) {
    lines.push('    labels:');
    labels.forEach(([k, v]) => lines.push(`      ${k}: "${v}"`));
  }
  if (nets.length) {
    lines.push('');
    lines.push('networks:');
    nets.forEach(n => lines.push(`  ${n}:\n    external: true`));
  }
  return lines.join('\n');
}

function generateRunCommand(data) {
  let cmd = `docker run -d \\\n  --name ${data.name}`;
  const rp = data.restartPolicy;
  if (rp && rp.Name && rp.Name !== 'no') {
    cmd += ` \\\n  --restart ${rp.Name}${rp.MaximumRetryCount ? `:${rp.MaximumRetryCount}` : ''}`;
  }
  if (data.env?.length) data.env.forEach(e => cmd += ` \\\n  -e "${e}"`);
  const ports = data.ports || {};
  Object.entries(ports).filter(([, v]) => v?.length).forEach(([container, bindings]) => {
    bindings.forEach(b => {
      cmd += ` \\\n  -p ${b.HostPort || ''}:${container.replace('/tcp', '')}`;
    });
  });
  if (data.mounts?.length) {
    data.mounts.forEach(m => {
      const ro = m.RW === false ? ':ro' : '';
      cmd += ` \\\n  -v ${m.Source || m.Name}:${m.Destination}${ro}`;
    });
  }
  const nets = Object.keys(data.networks || {}).filter(n => n !== 'bridge');
  if (nets.length) cmd += ` \\\n  --network ${nets[0]}`;
  if (data.resources?.memory) cmd += ` \\\n  --memory ${data.resources.memory}`;
  if (data.resources?.cpuQuota && data.resources?.cpuPeriod) {
    const cpus = (data.resources.cpuQuota / data.resources.cpuPeriod).toFixed(1);
    cmd += ` \\\n  --cpus ${cpus}`;
  }
  const labels = Object.entries(data.labels || {}).filter(([k]) => !k.startsWith('com.docker.compose'));
  labels.forEach(([k, v]) => cmd += ` \\\n  --label ${k}="${v}"`);
  cmd += ` \\\n  ${data.image}`;
  return cmd;
}

// ─── Smart Restart with Backoff ───────────────────────

router.post('/:id/smart-restart', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  const { id } = req.params;
  try {
    const docker = dockerService.getDocker(req.hostId);
    const container = docker.getContainer(id);
    const inspect = await container.inspect();
    const name = inspect.Name.replace(/^\//, '');
    const image = inspect.Config.Image;

    // Get restart history from events
    const db = require('../db').getDb();
    const recentRestarts = db.prepare(`
      SELECT COUNT(*) AS cnt FROM docker_events
      WHERE actor_name = ? AND action = 'start'
      AND event_time > datetime('now', '-1 hour') AND host_id = ?
    `).get(name, req.hostId || 0)?.cnt || 0;

    // Exponential backoff: 0s, 5s, 15s, 45s, 120s (max)
    const backoffSeconds = Math.min(120, Math.floor(5 * Math.pow(3, Math.min(recentRestarts, 4))));

    if (recentRestarts > 10) {
      // Too many restarts — suggest rollback
      return res.json({
        ok: false,
        action: 'rollback_suggested',
        message: `Container "${name}" has restarted ${recentRestarts} times in the last hour. Likely crash-looping.`,
        recentRestarts,
        suggestion: 'Consider rolling back to a previous image version.',
      });
    }

    if (recentRestarts > 2 && backoffSeconds > 5) {
      // Return backoff info — don't block the event loop
      return res.json({
        ok: false,
        action: 'backoff',
        message: `Backoff active: wait ${backoffSeconds}s before retrying (${recentRestarts} restarts in 1h)`,
        retryAfterSeconds: backoffSeconds,
        recentRestarts,
      });
    }

    // Restart
    if (inspect.State.Running) {
      await container.restart({ t: 10 });
    } else {
      await container.start();
    }

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'container_smart_restart', targetType: 'container', targetId: name,
      details: JSON.stringify({ recentRestarts, backoffSeconds }),
      ip: getClientIp(req),
    });

    res.json({
      ok: true,
      action: 'restarted',
      backoffApplied: backoffSeconds > 0 && recentRestarts > 2,
      backoffSeconds,
      recentRestarts,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Deploy Preview ───────────────────────────────────

router.get('/:id/deploy-preview', requireAuth, async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    const container = docker.getContainer(req.params.id);
    const inspect = await container.inspect();
    const imageName = inspect.Config.Image;
    const name = inspect.Name.replace(/^\//, '');

    // Current image info
    const currentImage = await docker.getImage(inspect.Image).inspect();
    const currentDigest = currentImage.RepoDigests?.[0]?.split('@')[1]?.substring(0, 19) || 'unknown';
    const currentCreated = currentImage.Created;

    // Try to get remote image info (registry manifest check)
    let remoteDigest = null;
    let updateAvailable = false;
    try {
      // Use docker CLI to check remote digest without pulling
      const { execSync } = require('child_process');
      const manifest = execSync(`docker manifest inspect ${imageName} 2>/dev/null || echo "UNAVAILABLE"`, {
        timeout: 15000, encoding: 'utf8',
      });
      if (!manifest.includes('UNAVAILABLE')) {
        const parsed = JSON.parse(manifest);
        remoteDigest = (parsed.config?.digest || parsed.digest || '').substring(0, 19);
        updateAvailable = remoteDigest && remoteDigest !== currentDigest;
      }
    } catch { /* manifest check not available */ }

    res.json({
      container: name,
      image: imageName,
      current: {
        digest: currentDigest,
        created: currentCreated,
        size: currentImage.Size,
      },
      remote: remoteDigest ? { digest: remoteDigest } : null,
      updateAvailable,
      config: {
        ports: Object.entries(inspect.NetworkSettings?.Ports || {}).map(([k, v]) => ({
          container: k, host: v?.[0]?.HostPort || null,
        })),
        env: (inspect.Config.Env || []).length,
        volumes: Object.keys(inspect.Mounts || {}).length || (inspect.Mounts || []).length,
        restart: inspect.HostConfig?.RestartPolicy?.Name || 'no',
        memoryLimit: inspect.HostConfig?.Memory || 0,
        cpuShares: inspect.HostConfig?.CpuShares || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Safe-Pull Update ─────────────────────────────────

router.post('/:id/safe-update', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  const { id } = req.params;
  try {
    const docker = dockerService.getDocker(req.hostId);
    const container = docker.getContainer(id);
    const inspect = await container.inspect();
    const image = inspect.Config.Image;
    const name = inspect.Name.replace(/^\//, '');

    if (dockerService.isSelf(inspect.Id)) {
      return res.status(403).json({ error: 'Cannot update Docker Dash itself' });
    }

    // Step 1: Pull new image
    await new Promise((resolve, reject) => {
      docker.pull(image, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err) => err ? reject(err) : resolve());
      });
    });

    // Step 2: Get new image digest
    const newImage = await docker.getImage(image).inspect();
    const newDigest = newImage.Id;

    // Step 3: Scan with Trivy (if available)
    let scanPassed = true;
    let scanSummary = null;
    try {
      const { execSync } = require('child_process');
      const scanResult = execSync(
        `trivy image --severity CRITICAL,HIGH --format json --quiet ${image} 2>/dev/null`,
        { timeout: 120000, encoding: 'utf8' }
      );
      const parsed = JSON.parse(scanResult);
      const results = parsed.Results || [];
      let critical = 0, high = 0;
      for (const r of results) {
        for (const v of (r.Vulnerabilities || [])) {
          if (v.Severity === 'CRITICAL') critical++;
          if (v.Severity === 'HIGH') high++;
        }
      }
      scanSummary = { critical, high, passed: critical === 0 };
      scanPassed = critical === 0; // Block on critical vulns only
    } catch {
      // Trivy not available — skip scan, allow update
      scanSummary = { scanner: 'unavailable', passed: true };
    }

    if (!scanPassed) {
      return res.json({
        ok: false,
        blocked: true,
        reason: 'Vulnerability scan found critical issues',
        scan: scanSummary,
        image,
        message: 'Update blocked. New image has critical vulnerabilities. Use regular update to override.',
      });
    }

    // Step 4: Safe — recreate container with new image
    const wasRunning = inspect.State.Running;
    if (wasRunning) await container.stop();
    await container.remove();

    const createOpts = {
      name,
      Image: image,
      Cmd: inspect.Config.Cmd,
      Env: inspect.Config.Env,
      ExposedPorts: inspect.Config.ExposedPorts,
      Labels: inspect.Config.Labels,
      WorkingDir: inspect.Config.WorkingDir,
      Entrypoint: inspect.Config.Entrypoint,
      Volumes: inspect.Config.Volumes,
      Hostname: inspect.Config.Hostname,
      User: inspect.Config.User,
      HostConfig: inspect.HostConfig,
      NetworkingConfig: { EndpointsConfig: inspect.NetworkSettings?.Networks || {} },
    };

    const newContainer = await docker.createContainer(createOpts);
    if (wasRunning) await newContainer.start();

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'container_safe_update', targetType: 'container', targetId: name,
      details: JSON.stringify({ image, scan: scanSummary, newId: newContainer.id }),
      ip: getClientIp(req),
    });

    res.json({ ok: true, method: 'safe-pull', scan: scanSummary, newId: newContainer.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Troubleshooting Wizard ───────────────────────────

router.get('/:id/diagnose', requireAuth, async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    const container = docker.getContainer(req.params.id);
    const inspect = await container.inspect();
    const name = inspect.Name.replace(/^\//, '');
    const state = inspect.State;

    const steps = [];

    // Step 1: Container state
    steps.push({
      step: 1, title: 'Container State',
      status: state.Running ? 'ok' : state.ExitCode === 0 ? 'info' : 'error',
      detail: state.Running ? 'Container is running' :
        `Exited with code ${state.ExitCode} (${state.Error || 'no error message'})`,
      suggestion: state.Running ? null :
        state.ExitCode === 137 ? 'Container was killed (OOM or docker kill). Check memory limits.' :
        state.ExitCode === 1 ? 'Application error. Check logs for stack trace.' :
        state.ExitCode === 127 ? 'Command not found. Check image and entrypoint.' :
        `Exit code ${state.ExitCode}. Check logs for details.`,
    });

    // Step 2: Health check
    if (state.Health) {
      const hStatus = state.Health.Status;
      steps.push({
        step: 2, title: 'Health Check',
        status: hStatus === 'healthy' ? 'ok' : hStatus === 'starting' ? 'warning' : 'error',
        detail: `Health: ${hStatus}. Last ${state.Health.FailingStreak || 0} checks failed.`,
        suggestion: hStatus === 'unhealthy' ? 'Health check is failing. Check the health check command and endpoint.' : null,
        log: state.Health.Log?.slice(-3)?.map(l => ({ output: l.Output?.trim(), exitCode: l.ExitCode })),
      });
    }

    // Step 3: Logs (last 20 lines)
    let logLines = '';
    try {
      const logs = await container.logs({ stdout: true, stderr: true, tail: 20, timestamps: false });
      logLines = logs.toString('utf8').replace(/[\x00-\x08]/g, '').trim();
    } catch {}

    const hasErrors = /error|exception|fatal|panic|traceback|fail/i.test(logLines);
    steps.push({
      step: 3, title: 'Recent Logs',
      status: hasErrors ? 'warning' : 'ok',
      detail: hasErrors ? 'Error patterns detected in recent logs' : 'No obvious errors in recent logs',
      log: logLines.split('\n').slice(-10),
    });

    // Step 4: Port bindings
    const ports = inspect.NetworkSettings?.Ports || {};
    const portIssues = Object.entries(ports).filter(([, v]) => v && v.length > 0).length === 0 && Object.keys(ports).length > 0;
    steps.push({
      step: 4, title: 'Port Bindings',
      status: portIssues ? 'warning' : 'ok',
      detail: portIssues ? 'Container exposes ports but none are bound to host' :
        `${Object.entries(ports).filter(([, v]) => v).length} port(s) bound`,
      suggestion: portIssues ? 'Add host port bindings if external access is needed.' : null,
    });

    // Step 5: Mounts/Volumes
    const mounts = inspect.Mounts || [];
    const missingMounts = mounts.filter(m => m.Type === 'bind' && !require('fs').existsSync(m.Source));
    steps.push({
      step: 5, title: 'Volumes & Mounts',
      status: missingMounts.length > 0 ? 'error' : 'ok',
      detail: missingMounts.length > 0 ?
        `${missingMounts.length} bind mount(s) point to missing host paths` :
        `${mounts.length} mount(s), all accessible`,
      suggestion: missingMounts.length > 0 ?
        `Missing paths: ${missingMounts.map(m => m.Source).join(', ')}` : null,
    });

    // Step 6: Resource limits
    const memLimit = inspect.HostConfig?.Memory || 0;
    const memUsage = state.Running ? null : null; // Can't get usage for stopped containers
    steps.push({
      step: 6, title: 'Resource Limits',
      status: memLimit === 0 ? 'info' : 'ok',
      detail: memLimit > 0 ? `Memory limit: ${require('../utils/helpers').formatBytes(memLimit)}` : 'No memory limit set (unlimited)',
      suggestion: memLimit === 0 ? 'Consider setting a memory limit to prevent OOM kills on the host.' : null,
    });

    // Step 7: Restart policy
    const restartPolicy = inspect.HostConfig?.RestartPolicy?.Name || 'no';
    const restartCount = inspect.RestartCount || 0;
    steps.push({
      step: 7, title: 'Restart Policy',
      status: restartCount > 10 ? 'error' : restartPolicy === 'no' ? 'info' : 'ok',
      detail: `Policy: ${restartPolicy}. Restarted ${restartCount} time(s).`,
      suggestion: restartCount > 10 ? 'Container is crash-looping. Fix the root cause before relying on restart policy.' :
        restartPolicy === 'no' ? 'Consider "unless-stopped" for production containers.' : null,
    });

    // Step 8: Image age
    try {
      const img = await docker.getImage(inspect.Image).inspect();
      const ageDays = Math.floor((Date.now() - new Date(img.Created).getTime()) / 86400000);
      steps.push({
        step: 8, title: 'Image Age',
        status: ageDays > 365 ? 'warning' : ageDays > 90 ? 'info' : 'ok',
        detail: `Image created ${ageDays} days ago`,
        suggestion: ageDays > 180 ? 'Image is quite old. Consider updating to get security patches.' : null,
      });
    } catch {}

    // Overall score
    const errors = steps.filter(s => s.status === 'error').length;
    const warnings = steps.filter(s => s.status === 'warning').length;
    const overall = errors > 0 ? 'critical' : warnings > 0 ? 'warning' : 'healthy';

    res.json({ container: name, image: inspect.Config.Image, overall, steps, errors, warnings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
