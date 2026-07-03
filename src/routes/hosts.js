'use strict';

const { Router } = require('express');
const dockerService = require('../services/docker');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const { getDb } = require('../db');
const log = require('../utils/logger')('hosts');
const { encryptSshConfig, decryptSshConfig } = require('../services/host-config-crypto');
const asyncHandler = require('../utils/asyncHandler');

// Validate docker socket path — must be an absolute path with safe characters only
const SOCKET_RE = /^\/[a-zA-Z0-9_./-]+$/;

const router = Router();

// List all hosts with status
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const hosts = db.prepare('SELECT * FROM docker_hosts ORDER BY is_default DESC, name ASC').all();

  const result = hosts.map(h => {
    const status = dockerService.getHostStatus(h.id);
    return {
      id: h.id,
      name: h.name,
      connectionType: h.connection_type,
      host: h.host,
      port: h.port,
      socketPath: h.socket_path,
      isActive: !!h.is_active,
      isDefault: !!h.is_default,
      environment: h.environment || 'development',
      lastSeenAt: h.last_seen_at,
      createdAt: h.created_at,
      healthy: status.healthy,
      lastCheck: status.lastCheck,
      // Don't expose secrets
      // v8.9.0-alpha.3 — expose daemon_type so the frontend can render
      // per-daemon badges on host cards and gate nav items based on
      // "any-host-has-daemon-type=X".
      daemonType: h.daemon_type || 'docker',
      hasTls: !!(h.tls_config && h.tls_config !== '{}' && h.tls_config !== 'null'),
      hasSsh: !!(h.ssh_config && h.ssh_config !== '{}' && h.ssh_config !== 'null'),
      // Include SSH host for display in cards (no credentials)
      sshHost: (() => {
        if (!h.ssh_config) return null;
        try { return (decryptSshConfig(h.ssh_config) || {}).host || null; } catch { return null; }
      })(),
    };
  });

  res.json(result);
}));

// Get single host details
router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  const host = db.prepare('SELECT * FROM docker_hosts WHERE id = ?').get(req.params.id);
  if (!host) return res.status(404).json({ error: 'Host not found' });

  const status = dockerService.getHostStatus(host.id);
  const result = {
    id: host.id,
    name: host.name,
    connectionType: host.connection_type,
    host: host.host,
    port: host.port,
    socketPath: host.socket_path,
    isActive: !!host.is_active,
    isDefault: !!host.is_default,
    environment: host.environment || 'development',
    lastSeenAt: host.last_seen_at,
    createdAt: host.created_at,
    healthy: status.healthy,
    hasTls: !!(host.tls_config && host.tls_config !== '{}'),
    hasSsh: !!(host.ssh_config && host.ssh_config !== '{}'),
  };

  // Include SSH config (without password/key) for editing
  if (host.ssh_config) {
    try {
      const ssh = decryptSshConfig(host.ssh_config);
      if (ssh) {
        result.sshHost = ssh.host;
        result.sshPort = ssh.port;
        result.sshUsername = ssh.username;
        result.sshAuthType = ssh.privateKey ? 'key' : 'password';
        result.sshDockerSocket = ssh.dockerSocket;
      }
    } catch { /* SSH config may not exist for this host */ }
  }

  res.json(result);
}));

// Get Docker info for a specific host (enriched with platform detection)
router.get('/:id/info', requireAuth, asyncHandler(async (req, res) => {
  const hostId = parseInt(req.params.id);
  const info = await dockerService.getInfo(hostId);
  // v6.12.0: auto-detect platform (Synology DSM, Unraid, TrueNAS SCALE,
  // QNAP, OMV, or a generic Linux distro) from the docker info response.
  const platformDetect = require('../services/platform-detect');
  try {
    info.platform = platformDetect.detectForHost(hostId, info);
  } catch { /* best-effort, never fail the whole /info call over detection */ }
  // v6.12.1: reuse cached cloud probe if we've already run it; otherwise
  // kick it off in the background so the first /info call returns fast
  // and subsequent calls pick up the vendor label.
  const cachedCloud = platformDetect.peekCloud(hostId);
  if (cachedCloud === undefined) {
    info.cloud = null;
    platformDetect.probeCloudForHost(hostId).catch(() => { /* cached as null on failure */ });
  } else {
    info.cloud = cachedCloud;
  }
  res.json(info);
}));

// Add new host
router.post('/', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const { name, connectionType, socketPath, host, port, tlsCa, tlsCert, tlsKey,
            sshHost, sshPort, sshUsername, sshPassword, sshPrivateKey, sshPassphrase, sshDockerSocket } = req.body;

    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!connectionType) return res.status(400).json({ error: 'Connection type is required' });

    // Validate required fields per connection type
    if (connectionType === 'tcp' && !host) return res.status(400).json({ error: 'Host address is required for TCP' });
    if (connectionType === 'ssh' && (!sshHost || !sshUsername)) return res.status(400).json({ error: 'SSH host and username are required' });

    // Validate dockerSocket path (FIX #13)
    const effectiveDockerSocket = sshDockerSocket || '/var/run/docker.sock';
    if (connectionType === 'ssh' && !SOCKET_RE.test(effectiveDockerSocket)) {
      return res.status(400).json({ error: 'Invalid dockerSocket path' });
    }

    // Build config objects
    let tlsConfig = null;
    if (connectionType === 'tcp' && tlsCa) {
      tlsConfig = JSON.stringify({ ca: tlsCa, cert: tlsCert, key: tlsKey });
    }

    let sshConfig = null;
    if (connectionType === 'ssh') {
      sshConfig = encryptSshConfig({
        host: sshHost,
        port: sshPort || 22,
        username: sshUsername,
        password: sshPassword || undefined,
        privateKey: sshPrivateKey || undefined,
        passphrase: sshPassphrase || undefined,
        dockerSocket: effectiveDockerSocket,
      });
    }

    const db = getDb();
    const result = db.prepare(`
      INSERT INTO docker_hosts (name, connection_type, socket_path, host, port, tls_config, ssh_config, is_active, is_default)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)
    `).run(name, connectionType, socketPath || '/var/run/docker.sock', host || null, port || null, tlsConfig, sshConfig);

    const newId = result.lastInsertRowid;

    // Start SSH tunnel if needed
    if (connectionType === 'ssh') {
      try {
        const sshTunnelService = require('../services/ssh-tunnel');
        const hostConfig = dockerService._getHostConfig(newId);
        await sshTunnelService.createTunnel(hostConfig);
      } catch (err) {
        log.warn(`SSH tunnel creation failed for new host ${newId}: ${err.message}`);
      }
    }

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'host_create', targetType: 'host', targetId: String(newId),
      details: { name, connectionType, host }, ip: getClientIp(req),
    });

  res.status(201).json({ ok: true, id: newId });
}));

// Update host
router.put('/:id', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const db = getDb();
    const hostId = parseInt(req.params.id);
    const existing = db.prepare('SELECT * FROM docker_hosts WHERE id = ?').get(hostId);
    if (!existing) return res.status(404).json({ error: 'Host not found' });

    const { name, connectionType, socketPath, host, port, tlsCa, tlsCert, tlsKey,
            sshHost, sshPort, sshUsername, sshPassword, sshPrivateKey, sshPassphrase, sshDockerSocket,
            isActive, environment } = req.body;

    let tlsConfig = existing.tls_config;
    if (connectionType === 'tcp' && tlsCa !== undefined) {
      tlsConfig = tlsCa ? JSON.stringify({ ca: tlsCa, cert: tlsCert, key: tlsKey }) : null;
    }

    let sshConfig = existing.ssh_config;
    if (connectionType === 'ssh' && sshHost !== undefined) {
      // Validate dockerSocket path (FIX #13)
      const effectiveDockerSocketPut = sshDockerSocket || '/var/run/docker.sock';
      if (!SOCKET_RE.test(effectiveDockerSocketPut)) {
        return res.status(400).json({ error: 'Invalid dockerSocket path' });
      }
      sshConfig = encryptSshConfig({
        host: sshHost,
        port: sshPort || 22,
        username: sshUsername,
        password: sshPassword || undefined,
        privateKey: sshPrivateKey || undefined,
        passphrase: sshPassphrase || undefined,
        dockerSocket: effectiveDockerSocketPut,
      });
    }

    // Validate environment value if provided
    const validEnvs = ['development', 'staging', 'production', 'custom'];
    const envVal = environment !== undefined ? (validEnvs.includes(environment) ? environment : existing.environment) : existing.environment;

    db.prepare(`
      UPDATE docker_hosts SET name = ?, connection_type = ?, socket_path = ?, host = ?, port = ?,
        tls_config = ?, ssh_config = ?, is_active = ?, environment = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name || existing.name,
      connectionType || existing.connection_type,
      socketPath || existing.socket_path,
      host !== undefined ? host : existing.host,
      port !== undefined ? port : existing.port,
      tlsConfig, sshConfig,
      isActive !== undefined ? (isActive ? 1 : 0) : existing.is_active,
      envVal,
      hostId,
    );

    // Drop cached connection and recreate SSH tunnel if needed
    dockerService.dropConnection(hostId);
    const effectiveType = connectionType || existing.connection_type;
    if (effectiveType === 'ssh') {
      try {
        const sshTunnelService = require('../services/ssh-tunnel');
        sshTunnelService.closeTunnel(hostId);
        const hostConfig = dockerService._getHostConfig(hostId);
        await sshTunnelService.createTunnel(hostConfig);
      } catch (err) {
        log.warn(`SSH tunnel recreation failed for host ${hostId}: ${err.message}`);
      }
    } else {
      // Close SSH tunnel if switching away from SSH
      try { require('../services/ssh-tunnel').closeTunnel(hostId); } catch { /* tunnel may not be active */ }
    }

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'host_update', targetType: 'host', targetId: String(hostId),
      details: { name: name || existing.name }, ip: getClientIp(req),
    });

  res.json({ ok: true });
}));

// Delete host
router.delete('/:id', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const db = getDb();
    const hostId = parseInt(req.params.id);
    const host = db.prepare('SELECT * FROM docker_hosts WHERE id = ?').get(hostId);
    if (!host) return res.status(404).json({ error: 'Host not found' });
    if (host.is_default) return res.status(400).json({ error: 'Cannot delete the default host' });

    // Close SSH tunnel if exists
    try {
      const sshTunnelService = require('../services/ssh-tunnel');
      sshTunnelService.closeTunnel(hostId);
    } catch { /* tunnel may not be active or ssh-tunnel module unavailable */ }

    // Drop connection
    dockerService.dropConnection(hostId);

    // Delete from DB
    db.prepare('DELETE FROM docker_hosts WHERE id = ?').run(hostId);

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'host_delete', targetType: 'host', targetId: String(hostId),
      details: { name: host.name }, ip: getClientIp(req),
    });

  res.json({ ok: true });
}));

// Test connection
router.post('/test', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { connectionType, socketPath, host, port, tlsCa, tlsCert, tlsKey,
          sshHost, sshPort, sshUsername, sshPassword, sshPrivateKey, sshPassphrase } = req.body;

  if (connectionType === 'ssh') {
    // Test SSH connection
    const sshTunnelService = require('../services/ssh-tunnel');
    const result = await sshTunnelService.testConnection({
      host: sshHost,
      port: sshPort || 22,
      username: sshUsername,
      password: sshPassword,
      privateKey: sshPrivateKey,
      passphrase: sshPassphrase,
    });
    return res.json(result);
  }

  // Test Docker connection (socket or TCP)
  const hostConfig = {
    connectionType: connectionType || 'socket',
    socketPath: socketPath || '/var/run/docker.sock',
    host,
    port: port || (connectionType === 'tcp' ? 2376 : undefined),
    tlsConfig: tlsCa ? { ca: tlsCa, cert: tlsCert, key: tlsKey } : null,
  };

  const result = await dockerService.testConnection(hostConfig);
  res.json(result);
}));

// Test existing host connection
router.post('/:id/test', requireAuth, asyncHandler(async (req, res) => {
  const hostId = parseInt(req.params.id);
  const hostConfig = dockerService._getHostConfig(hostId);
  const result = await dockerService.testConnection(hostConfig);
  res.json(result);
}));

// POST /hosts/:id/drain — put host in maintenance mode
router.post('/:id/drain', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const hostId = parseInt(req.params.id);
    const docker = dockerService.getDocker(hostId);

    // List running containers on this host
    const containers = await docker.listContainers();
    const running = containers.filter(c => c.State === 'running');

    // Stop all non-essential containers (skip docker-dash itself)
    const results = [];
    for (const c of running) {
      const name = (c.Names?.[0] || '').replace(/^\//, '');
      if (name === 'docker-dash' || name === 'docker-dash-caddy') {
        results.push({ name, status: 'skipped', reason: 'System container' });
        continue;
      }
      try {
        const container = docker.getContainer(c.Id);
        await container.stop({ t: 10 });
        results.push({ name, status: 'stopped', image: c.Image });
      } catch (err) {
        results.push({ name, status: 'error', error: err.message });
      }
    }

    // Mark host as in maintenance in DB
    const db = getDb();
    try {
      db.prepare('UPDATE docker_hosts SET environment = ? WHERE id = ?').run('maintenance', hostId);
    } catch {}

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'host_drain', targetType: 'host', targetId: String(hostId),
      details: { stopped: results.filter(r => r.status === 'stopped').length, skipped: results.filter(r => r.status === 'skipped').length },
      ip: getClientIp(req),
    });

  res.json({ ok: true, results, totalStopped: results.filter(r => r.status === 'stopped').length });
}));

// POST /hosts/:id/activate — exit maintenance mode
router.post('/:id/activate', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const hostId = parseInt(req.params.id);
  const db = getDb();
  const host = db.prepare('SELECT * FROM docker_hosts WHERE id = ?').get(hostId);
  if (!host) return res.status(404).json({ error: 'Host not found' });

  // Restore environment (default to production)
  db.prepare('UPDATE docker_hosts SET environment = ? WHERE id = ?').run('production', hostId);

  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'host_activate', targetType: 'host', targetId: String(hostId),
    ip: getClientIp(req),
  });

  res.json({ ok: true });
}));

// Set host as default
router.post('/:id/default', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const db = getDb();
  const hostId = parseInt(req.params.id);
  const host = db.prepare('SELECT * FROM docker_hosts WHERE id = ?').get(hostId);
  if (!host) return res.status(404).json({ error: 'Host not found' });

  db.prepare('UPDATE docker_hosts SET is_default = 0').run();
  db.prepare('UPDATE docker_hosts SET is_default = 1 WHERE id = ?').run(hostId);

  res.json({ ok: true });
}));

module.exports = router;
