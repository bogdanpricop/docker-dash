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
const connectionHealth = require('../services/connection-health');
const hostPermissions = require('../services/host-permissions');
const hostGroups = require('../services/host-groups');
const { requireHostAccess } = require('../middleware/hostAccess');

// Validate docker socket path — must be an absolute path with safe characters only
const SOCKET_RE = /^\/[a-zA-Z0-9_./-]+$/;

const router = Router();

// List all hosts with status
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const db = getDb();
  let hosts = db.prepare('SELECT * FROM docker_hosts ORDER BY is_default DESC, name ASC').all();
  const isAdmin = req.user.role === 'admin'
    || (Array.isArray(req.user.roles) && req.user.roles.includes('admin'));
  const visibleIds = new Set(hostPermissions.filterVisibleHosts(
    req.user.id, isAdmin, hosts.map(h => h.id)
  ));
  hosts = hosts.filter(h => visibleIds.has(h.id));

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
      // v8.10.x — Connection Health circuit breaker: surface which host +
      // why, straight from the persisted conn_* columns (no secrets here).
      connState: h.conn_state || 'unknown',
      connPaused: !!h.conn_paused,
      connPausedReason: h.conn_paused_reason || null,
      connLastError: h.conn_last_error || null,
      connLastErrorAt: h.conn_last_error_at || null,
      connReachable: h.conn_reachable === null || h.conn_reachable === undefined ? null : !!h.conn_reachable,
      // Don't expose secrets
      // v8.9.0-alpha.3 — expose daemon_type so the frontend can render
      // per-daemon badges on host cards and gate nav items based on
      // "any-host-has-daemon-type=X".
      daemonType: h.daemon_type || 'docker',
      // v8.9.11-alpha.6 — extract the endpoint/socket for display on the
      // host card (no credentials). Falls back to null for Docker/Podman.
      daemonEndpoint: (() => {
        if (!h.daemon_config || h.daemon_type === 'docker' || h.daemon_type === 'podman') return null;
        try {
          let cfg;
          switch (h.daemon_type) {
            case 'incus':
            case 'lxd':
              cfg = require('../services/incus').decryptDaemonConfig(h.daemon_config);
              return cfg.transport === 'unix' ? cfg.socket : cfg.endpoint;
            case 'proxmox':
              cfg = require('../services/proxmox').decryptDaemonConfig(h.daemon_config); return cfg.endpoint;
            case 'kubernetes':
              cfg = require('../services/kubernetes').decryptDaemonConfig(h.daemon_config); return cfg.endpoint;
            case 'nomad':
              cfg = require('../services/nomad').decryptDaemonConfig(h.daemon_config); return cfg.endpoint;
            case 'vsphere':
              cfg = require('../services/vsphere').decryptDaemonConfig(h.daemon_config); return cfg.endpoint;
            default: return null;
          }
        } catch { return null; }
      })(),
      hasTls: !!(h.tls_config && h.tls_config !== '{}' && h.tls_config !== 'null'),
      hasSsh: !!(h.ssh_config && h.ssh_config !== '{}' && h.ssh_config !== 'null'),
      // Include SSH host for display in cards (no credentials)
      sshHost: (() => {
        if (!h.ssh_config) return null;
        try { return (decryptSshConfig(h.ssh_config) || {}).host || null; } catch { return null; }
      })(),
      groups: hostGroups.groupsForHost(h.id),
    };
  });

  res.json(result);
}));

// Get single host details
router.get('/:id', requireAuth, requireHostAccess('view', { param: 'id' }), asyncHandler(async (req, res) => {
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
    // v8.10.x — Connection Health circuit breaker fields (see GET / above).
    connState: host.conn_state || 'unknown',
    groups: hostGroups.groupsForHost(host.id),
    connPaused: !!host.conn_paused,
    connPausedReason: host.conn_paused_reason || null,
    connLastError: host.conn_last_error || null,
    connLastErrorAt: host.conn_last_error_at || null,
    connReachable: host.conn_reachable === null || host.conn_reachable === undefined ? null : !!host.conn_reachable,
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

  // v8.9.11-alpha.6 — expose daemon_type + non-secret daemon_config fields
  // for the Edit non-Docker host dialog. Secrets (password/token/key)
  // are NOT returned — the frontend shows an "already set" placeholder
  // and only writes back on non-empty input.
  result.daemonType = host.daemon_type || 'docker';
  if (host.daemon_config && _NON_DOCKER_TYPES.has(host.daemon_type)) {
    try {
      let cfg;
      switch (host.daemon_type) {
        case 'incus':
        case 'lxd':
          cfg = require('../services/incus').decryptDaemonConfig(host.daemon_config);
          result.daemonConfig = {
            transport: cfg.transport, socket: cfg.socket, endpoint: cfg.endpoint,
            skipTlsVerify: !!cfg.skipTlsVerify,
            certPresent: !!cfg.cert, keyPresent: !!cfg.key,
          };
          break;
        case 'proxmox':
          cfg = require('../services/proxmox').decryptDaemonConfig(host.daemon_config);
          result.daemonConfig = {
            endpoint: cfg.endpoint, tokenId: cfg.tokenId,
            tokenSecretPresent: !!cfg.tokenSecret,
            skipTlsVerify: !!cfg.skipTlsVerify,
          };
          break;
        case 'kubernetes':
          cfg = require('../services/kubernetes').decryptDaemonConfig(host.daemon_config);
          result.daemonConfig = {
            endpoint: cfg.endpoint,
            tokenPresent: !!cfg.token,
            caCertPresent: !!cfg.caCert,
            skipTlsVerify: !!cfg.skipTlsVerify,
          };
          break;
        case 'nomad':
          cfg = require('../services/nomad').decryptDaemonConfig(host.daemon_config);
          result.daemonConfig = {
            endpoint: cfg.endpoint,
            tokenPresent: !!cfg.token,
            caCertPresent: !!cfg.caCert,
            skipTlsVerify: !!cfg.skipTlsVerify,
          };
          break;
        case 'vsphere':
          cfg = require('../services/vsphere').decryptDaemonConfig(host.daemon_config);
          result.daemonConfig = {
            endpoint: cfg.endpoint, username: cfg.username,
            passwordPresent: !!cfg.password,
            skipTlsVerify: !!cfg.skipTlsVerify,
            // v8.9.15-alpha.2 — non-secret SSH access fields for the editor.
            sshHost: (cfg.sshConfig && cfg.sshConfig.host) || '',
            sshPort: (cfg.sshConfig && cfg.sshConfig.port) || 22,
            sshUser: (cfg.sshConfig && cfg.sshConfig.user) || '',
            sshPasswordPresent: !!(cfg.sshConfig && cfg.sshConfig.password),
            sshKeyPresent: !!(cfg.sshConfig && cfg.sshConfig.privateKey),
          };
          break;
      }
    } catch { /* config unreadable — leave out */ }
  }

  res.json(result);
}));

// Get Docker info for a specific host (enriched with platform detection)
router.get('/:id/info', requireAuth, requireHostAccess('view', { param: 'id' }), asyncHandler(async (req, res) => {
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

// v8.9.5-alpha.1 — set of daemon types that DON'T use a Docker socket.
// For these, POST /hosts takes { name, daemonType, daemonConfig } and
// skips all of the Docker-specific fields below.
const _NON_DOCKER_TYPES = new Set(['incus', 'lxd', 'proxmox', 'kubernetes', 'nomad', 'vsphere']);

// v8.9.5-alpha.1 — per-daemon config encryption helpers. Each service's
// encryptDaemonConfig produces an `enc:` prefixed blob using AES-256-GCM.
// Incus module handles both incus + lxd; the rest each own their own.
function _encryptDaemonConfig(daemonType, cfg) {
  switch (daemonType) {
    case 'incus':
    case 'lxd':
      return require('../services/incus').encryptDaemonConfig(cfg);
    case 'proxmox':
      return require('../services/proxmox').encryptDaemonConfig(cfg);
    case 'kubernetes':
      return require('../services/kubernetes').encryptDaemonConfig(cfg);
    case 'nomad':
      return require('../services/nomad').encryptDaemonConfig(cfg);
    case 'vsphere':
      return require('../services/vsphere').encryptDaemonConfig(cfg);
    default:
      throw new Error(`Unknown daemon type: ${daemonType}`);
  }
}

// Add new host
router.post('/', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const { name, connectionType, socketPath, host, port, tlsCa, tlsCert, tlsKey,
            sshHost, sshPort, sshUsername, sshPassword, sshPrivateKey, sshPassphrase, sshDockerSocket,
            daemonType, daemonConfig } = req.body;

    if (!name) return res.status(400).json({ error: 'Name is required' });

    // ─── v8.9.5-alpha.1 — non-Docker daemon registration path ─────
    // When daemonType is one of the non-Docker types, we skip all the
    // Docker-specific validation and store the encrypted daemon_config.
    if (daemonType && _NON_DOCKER_TYPES.has(daemonType)) {
      if (!daemonConfig || typeof daemonConfig !== 'object') {
        return res.status(400).json({ error: 'daemonConfig object is required for non-Docker hosts' });
      }
      const db = getDb();
      const enc = _encryptDaemonConfig(daemonType, daemonConfig);
      // connection_type is required by the schema — use 'tcp' as a
      // best-fit generic marker for these hosts (they all speak HTTP/
      // HTTPS, not a Unix socket from docker-dash's perspective).
      const result = db.prepare(`
        INSERT INTO docker_hosts (name, connection_type, daemon_type, daemon_config, is_active, is_default)
        VALUES (?, ?, ?, ?, 1, 0)
      `).run(name, connectionType || 'tcp', daemonType, enc);
      const newId = result.lastInsertRowid;
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'host_create', targetType: 'host', targetId: String(newId),
        details: { name, daemonType, endpoint: daemonConfig && daemonConfig.endpoint }, ip: getClientIp(req),
      });
      return res.status(201).json({ ok: true, id: newId, daemonType });
    }

    // ─── Docker/Podman path (existing) ────────────────────────────
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
            isActive, environment, daemonType, daemonConfig } = req.body;

    // v8.9.11-alpha.6 — non-Docker update path.
    // Accepts { name, daemonConfig } — daemon_type is fixed post-create.
    // Any secret field left empty in daemonConfig preserves the existing
    // value (encrypted at rest); non-empty values overwrite.
    if (existing.daemon_type && _NON_DOCKER_TYPES.has(existing.daemon_type)) {
      if (!daemonConfig || typeof daemonConfig !== 'object') {
        return res.status(400).json({ error: 'daemonConfig required for non-Docker host updates' });
      }
      // Merge with existing: decrypt current config, overlay non-empty
      // fields from the request, re-encrypt.
      let currentCfg;
      try {
        switch (existing.daemon_type) {
          case 'incus':
          case 'lxd': currentCfg = require('../services/incus').decryptDaemonConfig(existing.daemon_config); break;
          case 'proxmox': currentCfg = require('../services/proxmox').decryptDaemonConfig(existing.daemon_config); break;
          case 'kubernetes': currentCfg = require('../services/kubernetes').decryptDaemonConfig(existing.daemon_config); break;
          case 'nomad': currentCfg = require('../services/nomad').decryptDaemonConfig(existing.daemon_config); break;
          case 'vsphere': currentCfg = require('../services/vsphere').decryptDaemonConfig(existing.daemon_config); break;
        }
      } catch { currentCfg = {}; }

      const merged = { ...currentCfg };
      // Copy non-empty scalars from the request into merged.
      for (const [k, v] of Object.entries(daemonConfig)) {
        if (v === undefined) continue;
        if (typeof v === 'string' && v === '') continue; // keep existing secret
        merged[k] = v;
      }
      const enc = _encryptDaemonConfig(existing.daemon_type, merged);
      const nextName = (name !== undefined) ? name : existing.name;
      const nextIsActive = (isActive === undefined) ? existing.is_active : (isActive ? 1 : 0);
      const nextEnv = (environment !== undefined) ? environment : existing.environment;
      db.prepare(`UPDATE docker_hosts SET name = ?, daemon_config = ?, is_active = ?, environment = ?, updated_at = ? WHERE id = ?`)
        .run(nextName, enc, nextIsActive, nextEnv, new Date().toISOString(), hostId);
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'host_update', targetType: 'host', targetId: String(hostId),
        details: { name: nextName, daemonType: existing.daemon_type, endpoint: merged.endpoint },
        ip: getClientIp(req),
      });
      return res.json({ ok: true, id: hostId });
    }

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
        // v8.10.x — Connection Health circuit breaker: saving new
        // credentials is the admin's signal that the problem is fixed.
        // Clear any open circuit BEFORE recreating the tunnel so the fresh
        // attempt isn't short-circuited by _ensureTunnel/_scheduleReconnect
        // still seeing this host as paused.
        connectionHealth.resume(hostId, { username: req.user.username });
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

// v8.9.11-alpha.3 — test-connection for non-Docker hosts. Called by
// the Register non-Docker host wizard before Save. Instantiates the
// per-daemon client with the submitted daemon_config and does one
// harmless read (info / version / login) to verify credentials.
// Does NOT persist anything.
// v8.9.15-alpha.2 — Test SSH credentials for a vSphere host from the wizard/
// edit dialog. Merges stored secrets (privateKey/password) when hostId is
// given and the submitted field is blank, mirroring test-non-docker.
router.post('/test-ssh', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { hostId } = req.body || {};
  let sshConfig = (req.body && req.body.sshConfig) || {};
  if (typeof sshConfig !== 'object') return res.status(400).json({ ok: false, error: 'sshConfig is required' });
  if (hostId) {
    try {
      const existing = getDb().prepare('SELECT daemon_type, daemon_config FROM docker_hosts WHERE id = ?').get(hostId);
      if (existing && existing.daemon_type === 'vsphere' && existing.daemon_config) {
        const stored = (require('../services/vsphere').decryptDaemonConfig(existing.daemon_config).sshConfig) || {};
        const merged = { ...stored };
        for (const [k, v] of Object.entries(sshConfig)) {
          if (v === undefined) continue;
          if (typeof v === 'string' && v === '') continue; // keep stored secret
          merged[k] = v;
        }
        sshConfig = merged;
      }
    } catch { /* fall back to submitted */ }
  }
  try {
    const result = await require('../services/vsphere-ssh').testSsh(sshConfig);
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
}));

router.post('/test-non-docker', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { daemonType, hostId } = req.body || {};
  let { daemonConfig } = req.body || {};
  if (!daemonType || !_NON_DOCKER_TYPES.has(daemonType)) {
    return res.status(400).json({ ok: false, error: `Unknown daemonType: ${daemonType}` });
  }
  if (!daemonConfig || typeof daemonConfig !== 'object') {
    return res.status(400).json({ ok: false, error: 'daemonConfig object is required' });
  }

  // v8.9.11-alpha.7 — Test from the Edit dialog: secret fields (password,
  // token, tokenSecret, cert, key) are left blank to mean "keep the stored
  // value". When a hostId is supplied, decrypt the stored config and overlay
  // only the NON-empty submitted fields, so Test works with the saved
  // credential the frontend never sees.
  if (hostId) {
    try {
      const db = getDb();
      const existing = db.prepare('SELECT daemon_type, daemon_config FROM docker_hosts WHERE id = ?').get(hostId);
      if (existing && existing.daemon_type === daemonType && existing.daemon_config) {
        const decMod = {
          incus: '../services/incus', lxd: '../services/incus',
          proxmox: '../services/proxmox', kubernetes: '../services/kubernetes',
          nomad: '../services/nomad', vsphere: '../services/vsphere',
        }[daemonType];
        const stored = require(decMod).decryptDaemonConfig(existing.daemon_config);
        const merged = { ...stored };
        for (const [k, v] of Object.entries(daemonConfig)) {
          if (v === undefined) continue;
          if (typeof v === 'string' && v === '') continue; // keep stored secret
          merged[k] = v;
        }
        daemonConfig = merged;
      }
    } catch { /* fall back to the submitted config as-is */ }
  }

  try {
    let summary;
    switch (daemonType) {
      case 'incus':
      case 'lxd': {
        const { IncusClient } = require('../services/incus');
        const cfg = { ...daemonConfig, daemonType };
        if (!cfg.transport) cfg.transport = 'unix';
        if (cfg.transport === 'unix' && !cfg.socket) {
          cfg.socket = daemonType === 'lxd'
            ? '/var/snap/lxd/common/lxd/unix.socket'
            : '/var/lib/incus/unix.socket';
        }
        const info = await new IncusClient(cfg).info();
        const env = (info && info.metadata && info.metadata.environment) || {};
        summary = { product: daemonType === 'lxd' ? 'LXD' : 'Incus',
          server: env.server_name, version: env.server_version, kernel: env.kernel_version };
        break;
      }
      case 'proxmox': {
        const { ProxmoxClient } = require('../services/proxmox');
        const version = await new ProxmoxClient(daemonConfig).version();
        summary = { product: 'Proxmox VE', version: version && version.version,
          release: version && version.release };
        break;
      }
      case 'kubernetes': {
        const { KubernetesClient } = require('../services/kubernetes');
        const version = await new KubernetesClient(daemonConfig).version();
        summary = { product: 'Kubernetes',
          version: version && (version.gitVersion || version.version),
          apiVersion: version && `${version.major}.${version.minor}`,
          platform: version && version.platform };
        break;
      }
      case 'nomad': {
        const { NomadClient } = require('../services/nomad');
        const self = await new NomadClient(daemonConfig).agentSelf();
        const tags = (self && self.member && self.member.Tags) || {};
        summary = { product: 'Nomad',
          server: self && self.member && self.member.Name,
          version: tags.build || tags.version, region: tags.region, dc: tags.dc };
        break;
      }
      case 'vsphere': {
        const { VSphereClient } = require('../services/vsphere');
        const client = new VSphereClient(daemonConfig);
        await client.login();
        try {
          const info = await client.retrieveServiceContent();
          summary = { product: info.productFullName || info.productName || 'vSphere',
            version: info.version, apiVersion: info.apiVersion, build: info.build };
        } finally {
          await client.logout();
        }
        break;
      }
      default:
        return res.status(400).json({ ok: false, error: `No test handler for ${daemonType}` });
    }
    res.json({ ok: true, summary });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message, status: err.status || null });
  }
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
router.post('/:id/test', requireAuth, requireHostAccess('view', { param: 'id' }), asyncHandler(async (req, res) => {
  const hostId = parseInt(req.params.id);
  const hostConfig = dockerService._getHostConfig(hostId);
  const result = await dockerService.testConnection(hostConfig);
  res.json(result);
}));

// v8.10.x — POST /hosts/:id/reconnect — manual "Retry" for a paused/failing
// host. Clears the Connection Health circuit breaker (if open) and forces a
// fresh tunnel attempt, without requiring a credential change first (e.g.
// the credentials were fine all along and the remote host is back up).
router.post('/:id/reconnect', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const hostId = parseInt(req.params.id);
  const db = getDb();
  const host = db.prepare('SELECT * FROM docker_hosts WHERE id = ?').get(hostId);
  if (!host) return res.status(404).json({ error: 'Host not found' });

  connectionHealth.resume(hostId, { username: req.user.username });

  // Best-effort: force a fresh connection attempt. Failures here are
  // expected if the host is still genuinely down — the circuit stays
  // closed (resumed) so ssh-tunnel.js's normal backoff picks it back up.
  try {
    const sshTunnelService = require('../services/ssh-tunnel');
    sshTunnelService.closeTunnel(hostId);
    dockerService.dropConnection(hostId);
    if (host.connection_type === 'ssh') {
      const hostConfig = dockerService._getHostConfig(hostId);
      await sshTunnelService.createTunnel(hostConfig);
    }
  } catch (err) {
    log.warn(`Manual reconnect attempt failed for host ${hostId}: ${err.message}`);
  }

  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'host_conn_reconnect', targetType: 'host', targetId: String(hostId),
    details: { name: host.name }, ip: getClientIp(req),
  });

  res.json({ ok: true, health: connectionHealth.getHealth(hostId) });
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
