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

// Container logs
router.get('/:id/logs', requireAuth, async (req, res) => {
  try {
    const { tail, since, until, search, download } = req.query;
    let lines = await dockerService.getContainerLogs(req.params.id, {
      tail: parseInt(tail) || 100,
      since, until,
    }, req.hostId);

    // Server-side full-text search
    if (search) {
      const q = search.toLowerCase();
      lines = lines.filter(l => l.toLowerCase().includes(q));
    }

    // Download as file
    if (download === 'true') {
      const name = req.params.id.substring(0, 12);
      const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="logs-${name}-${ts}.log"`);
      return res.send(lines.join('\n'));
    }

    res.json({ lines });
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
      // Use docker compose for stack containers
      const { execSync } = require('child_process');
      const service = inspect.Config.Labels?.['com.docker.compose.service'] || '';
      const pullCmd = service
        ? `cd "${workingDir}" && docker compose pull ${service} 2>&1`
        : `cd "${workingDir}" && docker compose pull 2>&1`;
      const upCmd = service
        ? `cd "${workingDir}" && docker compose up -d ${service} 2>&1`
        : `cd "${workingDir}" && docker compose up -d 2>&1`;

      execSync(pullCmd, { timeout: 120000, encoding: 'utf8' });
      const output = execSync(upCmd, { timeout: 60000, encoding: 'utf8' });

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

module.exports = router;
