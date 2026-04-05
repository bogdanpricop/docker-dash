'use strict';

const express = require('express');
const { Router } = require('express');
const { execFileSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const zlib = require('zlib');
const dockerService = require('../services/docker');
const auditService = require('../services/audit');
const permService = require('../services/permissions');
const { requireAuth, requireRole, writeable, requireFeature } = require('../middleware/auth');
const { getClientIp, sanitizeId, sanitizeShellArg, formatBytes } = require('../utils/helpers');
const { getDb } = require('../db');

const { extractHostId } = require('../middleware/hostId');

const router = Router();
router.use(extractHostId);

// List containers (filtered by per-stack permissions)
router.get('/', requireAuth, async (req, res) => {
  try {
    let containers = await dockerService.listContainers(req.hostId);
    // Apply per-stack permission filtering
    containers = permService.filterContainers(containers, req.user.id, req.user.role);
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

// ─── Multi-Container Log Aggregation ──────────────────

// GET /logs/multi — aggregate logs from multiple containers
// NOTE: Must be registered BEFORE any /:id routes to avoid route conflicts
router.get('/logs/multi', requireAuth, async (req, res) => {
  try {
    const { containers: containerIds, tail = 100, since, search, level } = req.query;
    const docker = dockerService.getDocker(req.hostId);

    // If no containers specified, get all running
    let targetIds = containerIds ? containerIds.split(',') : [];
    if (targetIds.length === 0) {
      const all = await docker.listContainers();
      targetIds = all.slice(0, 20).map(c => c.Id.substring(0, 12)); // max 20
    }

    const results = await Promise.allSettled(targetIds.map(async (id) => {
      const container = docker.getContainer(id);
      const inspect = await container.inspect();
      const name = inspect.Name.replace(/^\//, '');
      const opts = { stdout: true, stderr: true, tail: parseInt(tail) || 100, timestamps: true };
      if (since) opts.since = Math.floor(new Date(since).getTime() / 1000);

      const logBuffer = await container.logs(opts);
      const lines = logBuffer.toString('utf8').replace(/[\x00-\x08]/g, '').trim().split('\n').filter(Boolean);

      return lines.map(line => {
        // Parse timestamp from Docker log format: 2026-04-05T12:00:00.123456789Z message
        const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
        const ts = tsMatch ? tsMatch[1] : '';
        const msg = tsMatch ? line.substring(tsMatch[0].length).replace(/^[.\d]*Z\s*/, '') : line;

        // Detect severity
        let severity = 'info';
        if (/\b(error|fatal|panic|exception|fail|critical)\b/i.test(msg)) severity = 'error';
        else if (/\b(warn|warning)\b/i.test(msg)) severity = 'warn';
        else if (/\b(debug|trace)\b/i.test(msg)) severity = 'debug';

        return { ts, msg, container: name, containerId: id, severity };
      });
    }));

    // Merge all logs and sort by timestamp
    let allLogs = [];
    results.forEach(r => {
      if (r.status === 'fulfilled') allLogs.push(...r.value);
    });
    allLogs.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));

    // Apply filters
    if (level && level !== 'all') {
      allLogs = allLogs.filter(l => l.severity === level);
    }
    if (search) {
      const regex = new RegExp(search, 'i');
      allLogs = allLogs.filter(l => regex.test(l.msg) || regex.test(l.container));
    }

    // Limit output
    allLogs = allLogs.slice(-500);

    res.json({ logs: allLogs, count: allLogs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Dependency Graph (all containers) ───────────────

router.get('/dependency-graph', requireAuth, async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    const allContainers = await docker.listContainers({ all: true });
    const nodes = [];
    const edges = [];
    const clusters = {};

    for (const c of allContainers) {
      const name = (c.Names?.[0] || '').replace(/^\//, '');
      const stack = c.Labels?.['com.docker.compose.project'] || null;
      const networks = Object.keys(c.NetworkSettings?.Networks || {});

      nodes.push({
        id: c.Id.substring(0, 12),
        name,
        image: c.Image,
        state: c.State,
        stack,
        networks,
      });

      if (stack) {
        if (!clusters[stack]) clusters[stack] = { id: stack, name: stack, type: 'stack', nodeIds: [] };
        clusters[stack].nodeIds.push(c.Id.substring(0, 12));
      }
    }

    const nameSet = new Map(nodes.map(n => [n.name.toLowerCase(), n]));
    const urlPattern = /(?:\/\/|@)([a-z0-9][\w.-]*?)(?::\d+|\/)/gi;

    for (const c of allContainers) {
      const sourceId = c.Id.substring(0, 12);
      let envVars = [];
      try {
        const inspect = await docker.getContainer(c.Id).inspect();
        envVars = inspect.Config?.Env || [];
        const links = inspect.HostConfig?.Links || [];
        for (const link of links) {
          const parts = link.split(':');
          const linkedName = (parts[0] || '').replace(/^\//, '').toLowerCase();
          const target = nameSet.get(linkedName);
          if (target && target.id !== sourceId) {
            edges.push({ source: sourceId, target: target.id, type: 'link', label: 'docker link' });
          }
        }
      } catch { /* skip */ }

      const seen = new Set();
      for (const env of envVars) {
        const eq = env.indexOf('=');
        if (eq <= 0) continue;
        const key = env.substring(0, eq);
        const value = env.substring(eq + 1);
        let match;
        urlPattern.lastIndex = 0;
        while ((match = urlPattern.exec(value)) !== null) {
          const hostname = match[1].toLowerCase();
          const target = nameSet.get(hostname);
          if (target && target.id !== sourceId && !seen.has(target.id)) {
            seen.add(target.id);
            edges.push({ source: sourceId, target: target.id, type: 'url', label: key });
          }
        }
        const cleanVal = value.replace(/:\d+$/, '').trim().toLowerCase();
        const target = nameSet.get(cleanVal);
        if (target && target.id !== sourceId && !seen.has(target.id)) {
          seen.add(target.id);
          edges.push({ source: sourceId, target: target.id, type: 'hostname', label: key });
        }
      }

      const nets = Object.keys(c.NetworkSettings?.Networks || {}).filter(n => n !== 'bridge' && n !== 'host' && n !== 'none');
      for (const net of nets) {
        for (const other of allContainers) {
          const otherId = other.Id.substring(0, 12);
          if (otherId === sourceId) continue;
          const otherNets = Object.keys(other.NetworkSettings?.Networks || {});
          if (otherNets.includes(net) && sourceId < otherId) {
            edges.push({ source: sourceId, target: otherId, type: 'network', label: net });
          }
        }
      }
    }

    res.json({ nodes, edges, clusters: Object.values(clusters) });
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
    // Check per-stack permission: actions require at least 'operate'
    const inspect = await dockerService.inspectContainer(id, req.hostId);
    const stack = inspect.Config?.Labels?.['com.docker.compose.project'] || '_standalone';
    const effectiveRole = permService.getEffectiveRole(req.user.id, stack, req.user.role);
    if (!permService.hasPermission(effectiveRole, 'operate')) {
      return res.status(403).json({ error: 'Insufficient stack permissions for this action' });
    }

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
    // Check per-stack permission: remove requires 'admin' on the stack
    const inspect = await dockerService.inspectContainer(req.params.id, req.hostId);
    const stack = inspect.Config?.Labels?.['com.docker.compose.project'] || '_standalone';
    const effectiveRole = permService.getEffectiveRole(req.user.id, stack, req.user.role);
    if (!permService.hasPermission(effectiveRole, 'admin')) {
      return res.status(403).json({ error: 'Insufficient stack permissions to remove this container' });
    }

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

// ─── Sandbox Containers ─────────────────────────────────

// Download a GitHub repo as a gzipped tarball buffer
async function _downloadGithubTarball(owner, repo, branch = 'main') {
  const url = `https://api.github.com/repos/${owner}/${repo}/tarball/${branch}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('GitHub download timeout (30s)')), 30000);
    const doRequest = (reqUrl) => {
      https.get(reqUrl, { headers: { 'User-Agent': 'docker-dash/1.0' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          clearTimeout(timeout);
          const loc = res.headers['location'];
          if (!loc) return reject(new Error('GitHub redirect missing Location header'));
          // Follow redirect
          const newTimeout = setTimeout(() => reject(new Error('GitHub download timeout (30s)')), 30000);
          https.get(loc, { headers: { 'User-Agent': 'docker-dash/1.0' } }, (res2) => {
            if (res2.statusCode !== 200) {
              clearTimeout(newTimeout);
              return reject(new Error(`GitHub tarball download failed: HTTP ${res2.statusCode}`));
            }
            const chunks = [];
            res2.on('data', (chunk) => chunks.push(chunk));
            res2.on('end', () => { clearTimeout(newTimeout); resolve(Buffer.concat(chunks)); });
            res2.on('error', (err) => { clearTimeout(newTimeout); reject(err); });
          }).on('error', (err) => { clearTimeout(newTimeout); reject(err); });
          return;
        }
        if (res.statusCode !== 200) {
          clearTimeout(timeout);
          return reject(new Error(`GitHub tarball download failed: HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => { clearTimeout(timeout); resolve(Buffer.concat(chunks)); });
        res.on('error', (err) => { clearTimeout(timeout); reject(err); });
      }).on('error', (err) => { clearTimeout(timeout); reject(err); });
    };
    doRequest(url);
  });
}

// Detect project stack from a list of filenames
function _detectStack(fileList) {
  const files = fileList.map(f => f.split('/').pop());
  if (files.includes('package.json')) {
    return { stack: 'node', image: 'node:20-alpine', installCmd: 'cd /app && npm install --ignore-scripts --production', startCmd: 'cd /app && npm start', port: 3000 };
  }
  if (files.includes('requirements.txt') || files.includes('pyproject.toml')) {
    return { stack: 'python', image: 'python:3.12-alpine', installCmd: 'cd /app && pip install --no-cache-dir -r requirements.txt', startCmd: 'cd /app && python app.py', port: 5000 };
  }
  if (files.includes('go.mod')) {
    return { stack: 'go', image: 'golang:1.22-alpine', installCmd: 'cd /app && go mod download', startCmd: 'cd /app && go run .', port: 8080 };
  }
  if (files.includes('Gemfile')) {
    return { stack: 'ruby', image: 'ruby:3.3-alpine', installCmd: 'cd /app && bundle install', startCmd: 'cd /app && ruby app.rb', port: 3000 };
  }
  if (files.includes('index.html')) {
    return { stack: 'static', image: 'nginx:alpine', installCmd: '', startCmd: '', port: 80 };
  }
  return { stack: 'generic', image: 'alpine:latest', installCmd: '', startCmd: '', port: 8080 };
}

// Read tar headers to list filenames (gunzips first, strips GitHub prefix)
function _peekTarFiles(tarBuffer) {
  let buf;
  try {
    buf = zlib.gunzipSync(tarBuffer);
  } catch {
    buf = tarBuffer; // already uncompressed
  }

  const files = [];
  let offset = 0;

  while (offset + 512 <= buf.length) {
    // Check for end-of-archive (two consecutive empty 512-byte blocks)
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (buf[offset + i] !== 0) { allZero = false; break; }
    }
    if (allZero) break;

    // Read filename (offset 0, 100 bytes, null-terminated)
    let nameEnd = 0;
    while (nameEnd < 100 && buf[offset + nameEnd] !== 0) nameEnd++;
    const rawName = buf.slice(offset, offset + nameEnd).toString('utf8');

    // Read file size (offset 124, 12 bytes, octal)
    const sizeStr = buf.slice(offset + 124, offset + 136).toString('utf8').trim().replace(/\0/g, '');
    const size = parseInt(sizeStr, 8) || 0;

    // Strip GitHub prefix (everything up to and including first '/')
    const slashIdx = rawName.indexOf('/');
    const relPath = slashIdx >= 0 ? rawName.slice(slashIdx + 1) : rawName;
    if (relPath && !relPath.endsWith('/')) {
      files.push(relPath);
    }

    // Advance past header + data blocks
    const dataBlocks = Math.ceil(size / 512);
    offset += 512 + dataBlocks * 512;
  }

  return files;
}

// Run exec inside container with timeout
async function _execWithTimeout(container, cmd, timeoutMs = 120000) {
  const exec = await container.exec({ Cmd: ['sh', '-c', cmd], AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ Tty: false });
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { stream.destroy(); reject(new Error(`Build timeout (${timeoutMs / 1000}s)`)); }, timeoutMs);
    stream.on('data', (chunk) => { output += chunk.toString().replace(/[\x00-\x08]/g, ''); });
    stream.on('end', () => { clearTimeout(timer); resolve(output); });
    stream.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// Ensure sandbox network exists (bridge, internal — no external access)
async function _ensureSandboxNetwork(docker) {
  const nets = await docker.listNetworks();
  if (!nets.find(n => n.Name === 'dd-sandbox')) {
    await docker.createNetwork({ Name: 'dd-sandbox', Driver: 'bridge', Internal: true, Labels: { 'docker-dash.managed': 'true' } });
  }
}

// POST /sandbox — create & start a sandbox container
router.post('/sandbox', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  try {
    const {
      mode = 'ephemeral', ttl = 3600, memLimit = 536870912, cpuLimit = 0.5, name, openTerminal,
      // Project source params
      projectSource = 'none',
      githubUrl,
      githubBranch = 'main',
      uploadContent,
      uploadFilename,
      autoDetect = (projectSource !== 'none'),
      startCommand,
      exposePort,
    } = req.body;

    // When a project source is specified, network isolation must be off (need registry access)
    const isolatedNetwork = projectSource !== 'none' ? false : (req.body.isolatedNetwork !== undefined ? req.body.isolatedNetwork : true);

    // ── Phase 1: resolve archive + detect stack ──────────────────
    let tarBuffer = null;
    let detectedStack = null;
    let resolvedImage = req.body.image;
    let resolvedInstallCmd = '';
    let resolvedStartCmd = '';
    let resolvedPort = null;

    if (projectSource === 'github') {
      if (!githubUrl) return res.status(400).json({ error: 'githubUrl is required when projectSource is github' });
      // Parse owner/repo from URL  (e.g. https://github.com/owner/repo or owner/repo)
      const match = githubUrl.replace(/\.git$/, '').match(/(?:github\.com\/)?([^/]+)\/([^/]+)$/);
      if (!match) return res.status(400).json({ error: 'Invalid githubUrl — expected https://github.com/owner/repo or owner/repo' });
      const [, owner, repo] = match;
      tarBuffer = await _downloadGithubTarball(owner, repo, githubBranch);
    } else if (projectSource === 'upload') {
      if (!uploadContent) return res.status(400).json({ error: 'uploadContent is required when projectSource is upload' });
      const filename = uploadFilename || '';
      if (filename.endsWith('.zip')) return res.status(400).json({ error: 'Only .tar and .tar.gz archives are supported' });
      tarBuffer = Buffer.from(uploadContent, 'base64');
    }

    if (tarBuffer && autoDetect) {
      const fileList = _peekTarFiles(tarBuffer);
      detectedStack = _detectStack(fileList);
      if (!resolvedImage) resolvedImage = detectedStack.image;
      resolvedInstallCmd = detectedStack.installCmd;
      resolvedStartCmd = detectedStack.startCmd;
      resolvedPort = detectedStack.port;
    }

    // Override with explicit params
    if (startCommand) resolvedStartCmd = startCommand;
    if (exposePort) resolvedPort = Number(exposePort);

    // Must have an image at this point
    if (!resolvedImage) return res.status(400).json({ error: 'image is required' });

    const docker = dockerService.getDocker(req.hostId);

    // Ensure sandbox network (only when isolated)
    if (isolatedNetwork) await _ensureSandboxNetwork(docker);

    const containerName = name || `sandbox-${resolvedImage.split(':')[0].split('/').pop()}-${Math.random().toString(36).substring(2, 6)}`;
    const expiresAt = ttl > 0 ? new Date(Date.now() + ttl * 1000).toISOString() : '';

    // Pull image if not available
    try {
      await docker.getImage(resolvedImage).inspect();
    } catch {
      await new Promise((resolve, reject) => {
        docker.pull(resolvedImage, (err, stream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (err2) => err2 ? reject(err2) : resolve());
        });
      });
    }

    const labels = {
      'docker-dash.sandbox': 'true',
      'docker-dash.sandbox.mode': mode,
      'docker-dash.sandbox.ttl': String(ttl),
      'docker-dash.sandbox.expires': expiresAt,
      'docker-dash.sandbox.user': req.user?.username || 'unknown',
    };
    if (detectedStack) {
      labels['docker-dash.sandbox.stack'] = detectedStack.stack;
      labels['docker-dash.sandbox.port'] = String(resolvedPort || detectedStack.port);
      labels['docker-dash.sandbox.startCmd'] = resolvedStartCmd;
    }

    const createOpts = {
      name: containerName,
      Image: resolvedImage,
      Labels: labels,
      HostConfig: {
        Memory: memLimit,
        NanoCpus: Math.round(cpuLimit * 1e9),
        SecurityOpt: ['no-new-privileges'],
        RestartPolicy: { Name: 'no' },
        NetworkMode: isolatedNetwork ? 'dd-sandbox' : 'bridge',
        Privileged: false,
      },
    };

    // Expose detected/requested port
    if (resolvedPort) {
      createOpts.ExposedPorts = { [`${resolvedPort}/tcp`]: {} };
      createOpts.HostConfig.PortBindings = { [`${resolvedPort}/tcp`]: [{ HostPort: '' }] };
    }

    const container = await docker.createContainer(createOpts);
    await container.start();

    // ── Phase 2: inject project files and run setup ──────────────
    let installLog = '';
    if (projectSource !== 'none' && tarBuffer) {
      // Inject tarball (putArchive accepts gzip directly)
      await container.putArchive(tarBuffer, { path: '/' });

      if (projectSource === 'github') {
        // GitHub tarballs unpack as owner-repo-sha/ — move contents to /app
        await _execWithTimeout(container,
          'mkdir -p /app && dir=$(ls / | grep -E \'^[a-zA-Z].*-[a-f0-9]{7,}$\' | head -1) && [ -n "$dir" ] && mv /"$dir"/* /app/ 2>/dev/null; ls /app/',
          30000
        );
      }

      // Run install command if present
      if (resolvedInstallCmd) {
        try {
          installLog = await _execWithTimeout(container, resolvedInstallCmd, 120000);
        } catch (err) {
          installLog = `Install failed: ${err.message}`;
        }
      }

      // Start application in background
      if (resolvedStartCmd) {
        const exec = await container.exec({
          Cmd: ['sh', '-c', `nohup ${resolvedStartCmd} > /tmp/app.log 2>&1 &`],
          AttachStdout: false,
          AttachStderr: false,
        });
        await exec.start({ Detach: true });
      }
    }

    // Store sandbox metadata
    const db = getDb();
    const sandboxMeta = { sandbox: { mode, ttl, createdAt: new Date().toISOString(), expiresAt, memLimit, cpuLimit } };
    try {
      db.prepare(`
        INSERT INTO container_meta (container_name, app_name, category, custom_fields)
        VALUES (?, ?, 'sandbox', ?)
        ON CONFLICT(container_name) DO UPDATE SET category = 'sandbox', custom_fields = json_patch(custom_fields, ?)
      `).run(containerName, `Sandbox: ${resolvedImage}`, JSON.stringify(sandboxMeta), JSON.stringify(sandboxMeta));
    } catch { /* table may not exist in older DBs */ }

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'sandbox_create', targetType: 'container', targetId: container.id,
      details: { image: resolvedImage, mode, ttl, memLimit, cpuLimit, name: containerName, projectSource, stack: detectedStack?.stack }, ip: getClientIp(req),
    });

    res.status(201).json({
      id: container.id,
      name: containerName,
      mode,
      expiresAt,
      stack: detectedStack?.stack || null,
      port: resolvedPort || null,
      startCommand: resolvedStartCmd || null,
      installLog: installLog || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /sandbox/active — list active sandbox containers
router.get('/sandbox/active', requireAuth, async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    const containers = await docker.listContainers({ all: true, filters: { label: ['docker-dash.sandbox=true'] } });
    const result = containers.map(c => ({
      id: c.Id.substring(0, 12),
      name: (c.Names?.[0] || '').replace(/^\//, ''),
      image: c.Image,
      state: c.State,
      mode: c.Labels?.['docker-dash.sandbox.mode'] || 'unknown',
      expires: c.Labels?.['docker-dash.sandbox.expires'] || '',
      user: c.Labels?.['docker-dash.sandbox.user'] || '',
      created: c.Created,
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /sandbox/:id — stop & remove a sandbox container
router.delete('/sandbox/:id', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    const container = docker.getContainer(req.params.id);
    const inspect = await container.inspect();
    const name = inspect.Name.replace(/^\//, '');

    // Verify it's a sandbox
    if (inspect.Config?.Labels?.['docker-dash.sandbox'] !== 'true') {
      return res.status(400).json({ error: 'Container is not a sandbox' });
    }

    try { await container.stop({ t: 5 }); } catch { /* may already be stopped */ }
    await container.remove({ force: true });

    // Clean up metadata
    try { getDb().prepare('DELETE FROM container_meta WHERE container_name = ?').run(name); } catch { }

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'sandbox_remove', targetType: 'container', targetId: req.params.id,
      details: { name }, ip: getClientIp(req),
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /sandbox/:id/extend — extend TTL by 1 hour
router.post('/sandbox/:id/extend', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    const container = docker.getContainer(req.params.id);
    const inspect = await container.inspect();
    const name = inspect.Name.replace(/^\//, '');

    if (inspect.Config?.Labels?.['docker-dash.sandbox'] !== 'true') {
      return res.status(400).json({ error: 'Container is not a sandbox' });
    }

    const currentExpires = inspect.Config.Labels['docker-dash.sandbox.expires'];
    const base = currentExpires ? new Date(currentExpires) : new Date();
    const newExpires = new Date(Math.max(base.getTime(), Date.now()) + 3600000).toISOString();

    // Docker doesn't allow label updates on running containers, so we store in DB
    try {
      const db = getDb();
      const row = db.prepare('SELECT custom_fields FROM container_meta WHERE container_name = ?').get(name);
      const cf = row ? JSON.parse(row.custom_fields || '{}') : {};
      if (cf.sandbox) cf.sandbox.expiresAt = newExpires;
      db.prepare('UPDATE container_meta SET custom_fields = ? WHERE container_name = ?').run(JSON.stringify(cf), name);
    } catch { }

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'sandbox_extend', targetType: 'container', targetId: req.params.id,
      details: { name, newExpires }, ip: getClientIp(req),
    });

    res.json({ ok: true, expiresAt: newExpires });
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

    // Record current state for rollback history
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO container_image_history (container_name, container_id, host_id, image_name, image_id, action, deployed_by, was_running, config_snapshot)
        VALUES (?, ?, ?, ?, ?, 'update', ?, ?, ?)
      `).run(
        name, inspect.Id, req.hostId || 0,
        image, inspect.Image,
        req.user.username, inspect.State.Running ? 1 : 0,
        JSON.stringify({ Image: image, Cmd: inspect.Config.Cmd, Env: inspect.Config.Env, ExposedPorts: inspect.Config.ExposedPorts, Labels: inspect.Config.Labels, WorkingDir: inspect.Config.WorkingDir, Entrypoint: inspect.Config.Entrypoint, Volumes: inspect.Config.Volumes, Hostname: inspect.Config.Hostname, User: inspect.Config.User, HostConfig: inspect.HostConfig })
      );
    } catch { /* table may not exist yet */ }

    // Check if part of compose project
    const project = inspect.Config.Labels?.['com.docker.compose.project'];
    const workingDir = inspect.Config.Labels?.['com.docker.compose.project.working_dir'];

    if (project && workingDir) {
      // Use docker compose for stack containers — sanitize labels to prevent injection
      const safeDir = sanitizeShellArg(workingDir);
      const service = sanitizeShellArg(inspect.Config.Labels?.['com.docker.compose.service'] || '');

      if (!safeDir || !fs.existsSync(safeDir)) {
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
    const db = getDb();
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
      const safeImage = sanitizeShellArg(imageName);
      const manifest = execFileSync('docker', ['manifest', 'inspect', safeImage], {
        timeout: 15000, encoding: 'utf8',
      });
      if (manifest && !manifest.includes('UNAVAILABLE')) {
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

    // Record current state for rollback history
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO container_image_history (container_name, container_id, host_id, image_name, image_id, action, deployed_by, was_running, config_snapshot)
        VALUES (?, ?, ?, ?, ?, 'safe-update', ?, ?, ?)
      `).run(
        name, inspect.Id, req.hostId || 0,
        image, inspect.Image,
        req.user.username, inspect.State.Running ? 1 : 0,
        JSON.stringify({ Image: image, Cmd: inspect.Config.Cmd, Env: inspect.Config.Env, ExposedPorts: inspect.Config.ExposedPorts, Labels: inspect.Config.Labels, WorkingDir: inspect.Config.WorkingDir, Entrypoint: inspect.Config.Entrypoint, Volumes: inspect.Config.Volumes, Hostname: inspect.Config.Hostname, User: inspect.Config.User, HostConfig: inspect.HostConfig })
      );
    } catch { /* table may not exist yet */ }

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
      const safeImg = sanitizeShellArg(image);
      const scanResult = execFileSync('trivy', ['image', '--severity', 'CRITICAL,HIGH', '--format', 'json', '--quiet', safeImg], {
        timeout: 120000, encoding: 'utf8',
      });
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
    } catch (err) { /* logs may not be available */ }

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
    const missingMounts = mounts.filter(m => m.Type === 'bind' && !fs.existsSync(m.Source));
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
      detail: memLimit > 0 ? `Memory limit: ${formatBytes(memLimit)}` : 'No memory limit set (unlimited)',
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
    } catch (err) { /* image inspect may fail for removed images */ }

    // Overall score
    const errors = steps.filter(s => s.status === 'error').length;
    const warnings = steps.filter(s => s.status === 'warning').length;
    const overall = errors > 0 ? 'critical' : warnings > 0 ? 'warning' : 'healthy';

    res.json({ container: name, image: inspect.Config.Image, overall, steps, errors, warnings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Container Doctor ────────────────────────────────

router.get('/:id/doctor', requireAuth, async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    const container = docker.getContainer(req.params.id);
    const inspect = await container.inspect();
    const name = inspect.Name.replace(/^\//, '');
    const state = inspect.State;

    // Collect last 50 lines of logs
    let logText = '';
    try {
      const logs = await container.logs({ stdout: true, stderr: true, tail: 50, timestamps: false });
      logText = logs.toString('utf8').replace(/[\x00-\x08]/g, '').trim();
    } catch { /* container may be stopped */ }

    // Run existing diagnose checks inline
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
      });
    }

    // Step 3: Logs analysis
    const hasErrors = /error|exception|fatal|panic|traceback|fail/i.test(logText);
    steps.push({
      step: 3, title: 'Recent Logs',
      status: hasErrors ? 'warning' : 'ok',
      detail: hasErrors ? 'Error patterns detected in recent logs' : 'No obvious errors in recent logs',
    });

    // Step 4: Port bindings
    const ports = inspect.NetworkSettings?.Ports || {};
    const portIssues = Object.entries(ports).filter(([, v]) => v && v.length > 0).length === 0 && Object.keys(ports).length > 0;
    steps.push({
      step: 4, title: 'Port Bindings',
      status: portIssues ? 'warning' : 'ok',
      detail: portIssues ? 'Container exposes ports but none are bound to host' :
        `${Object.entries(ports).filter(([, v]) => v).length} port(s) bound`,
    });

    // Step 5: Resource limits
    const memLimit = inspect.HostConfig?.Memory || 0;
    steps.push({
      step: 5, title: 'Resource Limits',
      status: memLimit === 0 ? 'info' : 'ok',
      detail: memLimit > 0 ? `Memory limit: ${formatBytes(memLimit)}` : 'No memory limit set (unlimited)',
      suggestion: memLimit === 0 ? 'Consider setting a memory limit.' : null,
    });

    // Step 6: Restart policy
    const restartPolicy = inspect.HostConfig?.RestartPolicy?.Name || 'no';
    const restartCount = inspect.RestartCount || 0;
    steps.push({
      step: 6, title: 'Restart Policy',
      status: restartCount > 10 ? 'error' : restartPolicy === 'no' ? 'info' : 'ok',
      detail: `Policy: ${restartPolicy}. Restarted ${restartCount} time(s).`,
    });

    // Run log pattern analysis
    const logPatterns = require('../services/log-patterns');
    const logAnalysis = logPatterns.analyzeLog(logText);

    // Overall score
    const errors = steps.filter(s => s.status === 'error').length;
    const warnings = steps.filter(s => s.status === 'warning').length;
    let overall = errors > 0 ? 'critical' : warnings > 0 ? 'warning' : 'healthy';
    if (logAnalysis.severity === 'critical') overall = 'critical';
    else if (logAnalysis.severity === 'warning' && overall === 'healthy') overall = 'warning';

    // Container context for AI prompt generation
    const containerContext = {
      name,
      image: inspect.Config.Image,
      stateStatus: state.Running ? 'running' : `exited (code ${state.ExitCode})`,
      restartPolicy,
      memoryLimit: memLimit > 0 ? formatBytes(memLimit) : 'unlimited',
      restartCount,
      env: (inspect.Config.Env || []).filter(e => !e.match(/password|secret|key|token/i)).slice(0, 20),
      networks: Object.keys(inspect.NetworkSettings?.Networks || {}),
      ports: Object.entries(ports).map(([k, v]) => `${k} -> ${v?.[0]?.HostPort || 'none'}`),
    };

    // Generate AI prompt
    const aiPrompt = logPatterns.generateAIPrompt(containerContext, { steps }, logAnalysis, logText);

    res.json({
      container: name,
      image: inspect.Config.Image,
      overall,
      steps,
      errors,
      warnings,
      logAnalysis,
      logText: logText.split('\n').slice(-30).join('\n'),
      aiPrompt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Dependency Analysis ──────────────────────────────

router.get('/:id/dependencies', requireAuth, async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    const container = docker.getContainer(req.params.id);
    const inspect = await container.inspect();
    const name = inspect.Name.replace(/^\//, '');
    const envVars = inspect.Config.Env || [];

    // Get all running containers to match hostnames
    const allContainers = await docker.listContainers({ all: true });
    const containerNames = allContainers.map(c => ({
      id: c.Id.substring(0, 12),
      name: (c.Names?.[0] || '').replace(/^\//, ''),
      image: c.Image,
      state: c.State,
    }));
    const nameSet = new Set(containerNames.map(c => c.name.toLowerCase()));

    // Parse env vars for references to other containers
    const urlPattern = /(?:\/\/|@)([a-z0-9][\w.-]*?)(?::\d+|\/)/gi;
    const hostPattern = /^([A-Z_]*(?:HOST|SERVER|ADDR|ENDPOINT|URL|URI))\s*=\s*(.+)$/i;
    const dependencies = [];
    const seen = new Set();

    for (const env of envVars) {
      const eq = env.indexOf('=');
      if (eq <= 0) continue;
      const key = env.substring(0, eq);
      const value = env.substring(eq + 1);

      // Method 1: Find hostnames in URLs (postgres://db:5432, redis://cache:6379)
      let match;
      urlPattern.lastIndex = 0;
      while ((match = urlPattern.exec(value)) !== null) {
        const hostname = match[1].toLowerCase();
        if (nameSet.has(hostname) && hostname !== name.toLowerCase() && !seen.has(hostname)) {
          seen.add(hostname);
          const target = containerNames.find(c => c.name.toLowerCase() === hostname);
          dependencies.push({
            type: 'url',
            envVar: key,
            hostname,
            container: target,
            description: `${key} connects to container "${target.name}" via URL`,
          });
        }
      }

      // Method 2: Check if value directly matches a container name
      const cleanVal = value.replace(/:\d+$/, '').trim().toLowerCase();
      if (nameSet.has(cleanVal) && cleanVal !== name.toLowerCase() && !seen.has(cleanVal)) {
        seen.add(cleanVal);
        const target = containerNames.find(c => c.name.toLowerCase() === cleanVal);
        dependencies.push({
          type: 'hostname',
          envVar: key,
          hostname: cleanVal,
          container: target,
          description: `${key} references container "${target.name}"`,
        });
      }
    }

    // Method 3: Check Docker links (legacy)
    const links = inspect.HostConfig?.Links || [];
    for (const link of links) {
      const parts = link.split(':');
      const linkedName = (parts[0] || '').replace(/^\//, '');
      if (linkedName && !seen.has(linkedName.toLowerCase())) {
        seen.add(linkedName.toLowerCase());
        const target = containerNames.find(c => c.name.toLowerCase() === linkedName.toLowerCase());
        dependencies.push({
          type: 'link',
          envVar: null,
          hostname: linkedName,
          container: target || { name: linkedName, state: 'unknown' },
          description: `Docker link to "${linkedName}"`,
        });
      }
    }

    // Method 4: Check same compose stack
    const stack = inspect.Config.Labels?.['com.docker.compose.project'];
    const stackContainers = stack
      ? containerNames.filter(c => {
          const cl = allContainers.find(ac => ac.Id.startsWith(c.id));
          return cl?.Labels?.['com.docker.compose.project'] === stack && c.name !== name;
        })
      : [];

    res.json({
      container: name,
      image: inspect.Config.Image,
      stack: stack || null,
      dependencies,
      stackMembers: stackContainers,
      networks: Object.keys(inspect.NetworkSettings?.Networks || {}),
      hasDependencies: dependencies.length > 0 || stackContainers.length > 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Deploy with Dependencies ─────────────────────────

router.post('/:id/deploy-with-deps', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const { destHostId } = req.body;
    if (destHostId === undefined) return res.status(400).json({ error: 'destHostId required' });

    const docker = dockerService.getDocker(req.hostId);
    const container = docker.getContainer(req.params.id);
    const inspect = await container.inspect();
    const name = inspect.Name.replace(/^\//, '');

    // Get dependencies
    const depsRes = await new Promise((resolve, reject) => {
      const http = require('http');
      const r = http.request({
        hostname: 'localhost', port: require('../config').app.port,
        path: `/api/containers/${req.params.id}/dependencies?hostId=${req.hostId || 0}`,
        headers: { 'Authorization': req.headers.authorization, 'Cookie': req.headers.cookie },
      }, (resp) => {
        let body = '';
        resp.on('data', d => body += d);
        resp.on('end', () => resolve(JSON.parse(body)));
      });
      r.on('error', reject);
      r.end();
    });

    // Collect containers to migrate: dependencies + main container
    const migrationService = require('../services/migration');
    const results = [];

    // 1. Migrate dependencies first
    const depContainers = (depsRes.dependencies || [])
      .filter(d => d.container?.id)
      .map(d => d.container);

    // Add stack members if in a compose stack
    const allToMigrate = [...depContainers];
    for (const sm of (depsRes.stackMembers || [])) {
      if (!allToMigrate.find(c => c.id === sm.id)) {
        allToMigrate.push(sm);
      }
    }

    for (const dep of allToMigrate) {
      try {
        const result = await migrationService.migrateContainer({
          containerId: dep.id,
          sourceHostId: req.hostId || 0,
          destHostId,
          zeroDowntime: true,
        });
        results.push({ container: dep.name, ...result });
      } catch (err) {
        results.push({ container: dep.name, ok: false, error: err.message });
      }
    }

    // 2. Migrate main container last
    try {
      const result = await migrationService.migrateContainer({
        containerId: req.params.id,
        sourceHostId: req.hostId || 0,
        destHostId,
        zeroDowntime: true,
      });
      results.push({ container: name, main: true, ...result });
    } catch (err) {
      results.push({ container: name, main: true, ok: false, error: err.message });
    }

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'container_deploy_with_deps', targetType: 'container', targetId: name,
      details: JSON.stringify({ destHostId, total: results.length, ok: results.filter(r => r.ok).length }),
      ip: getClientIp(req),
    });

    res.json({
      ok: results.every(r => r.ok),
      total: results.length,
      succeeded: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Container File Browser ─────────────────────────

function validateFilePath(p) {
  if (!p || typeof p !== 'string') return false;
  if (!p.startsWith('/')) return false;
  if (p.includes('..')) return false;
  if (p.includes('\0')) return false;
  return true;
}

router.get('/:id/files', requireAuth, async (req, res) => {
  try {
    const filePath = req.query.path || '/';
    if (!validateFilePath(filePath)) return res.status(400).json({ error: 'Invalid path' });

    const output = await dockerService.execCommand(
      req.params.id,
      ['ls', '-la', '--time-style=+%Y-%m-%dT%H:%M:%S', filePath],
      req.hostId
    );

    const lines = output.split('\n').filter(l => l.trim() && !l.startsWith('total'));
    const entries = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 7) continue;
      const permissions = parts[0];
      const owner = parts[2];
      const group = parts[3];
      const size = parseInt(parts[4]) || 0;
      const modified = parts[5];
      const name = parts.slice(6).join(' ').replace(/ -> .*$/, '');
      if (name === '.' || name === '..') continue;
      const type = permissions.startsWith('d') ? 'directory' :
                   permissions.startsWith('l') ? 'symlink' : 'file';
      entries.push({ name, type, size, modified, permissions, owner, group });
    }
    res.json({ path: filePath, entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/files/content', requireAuth, async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!validateFilePath(filePath)) return res.status(400).json({ error: 'Invalid path' });

    const output = await dockerService.execCommand(
      req.params.id,
      ['cat', filePath],
      req.hostId
    );

    const maxSize = 1024 * 1024; // 1MB
    const truncated = output.length > maxSize;
    res.json({
      path: filePath,
      content: truncated ? output.substring(0, maxSize) : output,
      truncated,
      size: output.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/files/download', requireAuth, async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!validateFilePath(filePath)) return res.status(400).json({ error: 'Invalid path' });

    const docker = dockerService.getDocker(req.hostId);
    const container = docker.getContainer(req.params.id);
    const archive = await container.getArchive({ path: filePath });
    const fileName = filePath.split('/').pop() || 'download';

    res.setHeader('Content-Type', 'application/x-tar');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}.tar"`);
    archive.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Container File Upload ─────────────────────────────
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB

router.post('/:id/files/upload', express.json({ limit: '75mb' }), requireAuth, requireRole('operator'), async (req, res) => {
  try {
    const { path: destPath, content, filename } = req.body || {};

    if (!destPath || typeof destPath !== 'string') {
      return res.status(400).json({ error: 'Destination path is required' });
    }
    if (!validateFilePath(destPath)) {
      return res.status(400).json({ error: 'Invalid destination path. Must start with / and not contain ..' });
    }
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'File content (base64) is required' });
    }

    // Decode base64 and check size
    const fileBuffer = Buffer.from(content, 'base64');
    if (fileBuffer.length > MAX_UPLOAD_SIZE) {
      return res.status(413).json({ error: `File too large. Maximum size is ${formatBytes(MAX_UPLOAD_SIZE)}` });
    }
    if (fileBuffer.length === 0) {
      return res.status(400).json({ error: 'File is empty' });
    }

    const fileName = (filename || 'uploaded-file').replace(/[/\\]/g, '_');

    // Create a tar archive in memory containing the file
    // tar format: 512-byte header + file data + padding to 512-byte boundary + 1024 zero bytes
    const fileSize = fileBuffer.length;
    const headerBuf = Buffer.alloc(512, 0);

    // File name (max 100 chars)
    const nameBytes = Buffer.from(fileName, 'utf8');
    nameBytes.copy(headerBuf, 0, 0, Math.min(nameBytes.length, 100));

    // File mode: 0644
    Buffer.from('0000644\0', 'ascii').copy(headerBuf, 100);
    // Owner ID
    Buffer.from('0001000\0', 'ascii').copy(headerBuf, 108);
    // Group ID
    Buffer.from('0001000\0', 'ascii').copy(headerBuf, 116);
    // File size (octal)
    Buffer.from(fileSize.toString(8).padStart(11, '0') + '\0', 'ascii').copy(headerBuf, 124);
    // Modification time
    const mtime = Math.floor(Date.now() / 1000);
    Buffer.from(mtime.toString(8).padStart(11, '0') + '\0', 'ascii').copy(headerBuf, 136);
    // Type flag: regular file
    headerBuf[156] = 0x30; // '0'
    // Magic
    Buffer.from('ustar\0', 'ascii').copy(headerBuf, 257);
    // Version
    Buffer.from('00', 'ascii').copy(headerBuf, 263);

    // Compute checksum
    // First, fill checksum field with spaces
    Buffer.from('        ', 'ascii').copy(headerBuf, 148);
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += headerBuf[i];
    Buffer.from(checksum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(headerBuf, 148);

    // Pad file data to 512-byte boundary
    const padding = (512 - (fileSize % 512)) % 512;
    const endBlock = Buffer.alloc(1024, 0); // end-of-archive marker

    const tarBuffer = Buffer.concat([
      headerBuf,
      fileBuffer,
      Buffer.alloc(padding, 0),
      endBlock,
    ]);

    // Upload using dockerode putArchive
    const docker = dockerService.getDocker(req.hostId);
    const container = docker.getContainer(req.params.id);
    await container.putArchive(tarBuffer, { path: destPath });

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'container_file_upload',
      targetId: req.params.id,
      details: JSON.stringify({ path: destPath, filename: fileName, size: fileSize }),
      ip: getClientIp(req),
    });

    res.json({ ok: true, path: destPath, filename: fileName, size: fileSize });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Container Diff ─────────────────────────────────

router.get('/:id/diff', requireAuth, async (req, res) => {
  try {
    const changes = await dockerService.containerDiff(req.params.id, req.hostId);
    const summary = {
      modified: changes.filter(c => c.kind === 0).length,
      added: changes.filter(c => c.kind === 1).length,
      deleted: changes.filter(c => c.kind === 2).length,
      total: changes.length,
    };
    res.json({ changes, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Container Image History & Rollback ──────────────

router.get('/:id/history', requireAuth, async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    const container = docker.getContainer(req.params.id);
    const inspect = await container.inspect();
    const name = inspect.Name.replace(/^\//, '');

    const db = getDb();
    let entries = [];
    try {
      entries = db.prepare(`
        SELECT * FROM container_image_history
        WHERE container_name = ? AND host_id = ?
        ORDER BY deployed_at DESC LIMIT 10
      `).all(name, req.hostId || 0);
    } catch { /* table may not exist yet */ }

    // Check if images still exist
    for (const entry of entries) {
      try {
        await docker.getImage(entry.image_id).inspect();
        entry.imageAvailable = true;
      } catch {
        entry.imageAvailable = false;
      }
    }

    res.json({
      container: name,
      currentImage: inspect.Config.Image,
      currentImageId: inspect.Image,
      entries,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/rollback', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  const { id } = req.params;
  const { historyId } = req.body;
  if (!historyId) return res.status(400).json({ error: 'historyId required' });

  try {
    const db = getDb();
    const entry = db.prepare('SELECT * FROM container_image_history WHERE id = ?').get(historyId);
    if (!entry) return res.status(404).json({ error: 'History entry not found' });

    const docker = dockerService.getDocker(req.hostId);
    const container = docker.getContainer(id);
    const inspect = await container.inspect();
    const name = inspect.Name.replace(/^\//, '');

    // Verify old image still exists
    try {
      await docker.getImage(entry.image_id).inspect();
    } catch {
      return res.status(400).json({ error: 'Previous image no longer exists locally. Re-pull the tag first.' });
    }

    // Record current state before rollback
    try {
      db.prepare(`
        INSERT INTO container_image_history (container_name, container_id, host_id, image_name, image_id, action, deployed_by, was_running, config_snapshot)
        VALUES (?, ?, ?, ?, ?, 'rollback', ?, ?, ?)
      `).run(
        name, inspect.Id, req.hostId || 0,
        inspect.Config.Image, inspect.Image,
        req.user.username, inspect.State.Running ? 1 : 0,
        JSON.stringify({ Image: inspect.Config.Image, Cmd: inspect.Config.Cmd, Env: inspect.Config.Env, ExposedPorts: inspect.Config.ExposedPorts, Labels: inspect.Config.Labels, WorkingDir: inspect.Config.WorkingDir, Entrypoint: inspect.Config.Entrypoint, Volumes: inspect.Config.Volumes, Hostname: inspect.Config.Hostname, User: inspect.Config.User, HostConfig: inspect.HostConfig })
      );
    } catch { /* table may not exist */ }

    // Recreate with old image
    const wasRunning = inspect.State.Running;
    if (wasRunning) await container.stop();
    await container.remove();

    // Parse config from history or rebuild from current
    let createOpts;
    if (entry.config_snapshot) {
      try {
        const cfg = JSON.parse(entry.config_snapshot);
        createOpts = {
          name,
          Image: entry.image_id,
          Cmd: cfg.Cmd,
          Env: cfg.Env,
          ExposedPorts: cfg.ExposedPorts,
          Labels: cfg.Labels,
          WorkingDir: cfg.WorkingDir,
          Entrypoint: cfg.Entrypoint,
          Volumes: cfg.Volumes,
          Hostname: cfg.Hostname,
          User: cfg.User,
          HostConfig: cfg.HostConfig,
          NetworkingConfig: { EndpointsConfig: inspect.NetworkSettings?.Networks || {} },
        };
      } catch {
        createOpts = null;
      }
    }

    if (!createOpts) {
      createOpts = {
        name,
        Image: entry.image_id,
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
    }

    const newContainer = await docker.createContainer(createOpts);
    if (wasRunning) await newContainer.start();

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'container_rollback', targetType: 'container', targetId: name,
      details: { fromImage: inspect.Config.Image, toImage: entry.image_name, toImageId: entry.image_id },
      ip: getClientIp(req),
    });

    res.json({ ok: true, newId: newContainer.id, rolledBackTo: entry.image_name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Deployment Pipeline ─────────────────────────────

router.post('/:id/pipeline/start', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  try {
    const pipelineService = require('../services/pipeline');
    const { skipScan, skipVerify } = req.body;
    const result = await pipelineService.start({
      containerId: req.params.id,
      hostId: req.hostId || 0,
      user: req.user,
      skipScan: !!skipScan,
      skipVerify: !!skipVerify,
      clientIp: getClientIp(req),
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/pipeline/status/:executionId', requireAuth, (req, res) => {
  try {
    const pipelineService = require('../services/pipeline');
    const result = pipelineService.getStatus(parseInt(req.params.executionId));
    if (!result) return res.status(404).json({ error: 'Pipeline not found' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/pipeline/history', requireAuth, async (req, res) => {
  try {
    const docker = dockerService.getDocker(req.hostId);
    const container = docker.getContainer(req.params.id);
    const inspect = await container.inspect();
    const name = inspect.Name.replace(/^\//, '');
    const pipelineService = require('../services/pipeline');
    const history = pipelineService.getHistory(name, req.hostId || 0);
    res.json({ container: name, pipelines: history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
