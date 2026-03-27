'use strict';

const Docker = require('dockerode');
const config = require('../config');
const log = require('../utils/logger')('docker');
const os = require('os');
const { getDb } = require('../db');

class DockerService {
  constructor() {
    this.connections = new Map();
    this._selfId = null;
    this._hostCache = new Map(); // hostId → { config, lastCheck, healthy }
    this._healthInterval = null;
  }

  // ─── Connection Management ─────────────────────────────────

  /** Get docker connection for a host (default: local) */
  getDocker(hostId = 0) {
    if (this.connections.has(hostId)) return this.connections.get(hostId);

    const hostConfig = this._getHostConfig(hostId);
    const docker = this._createConnection(hostConfig);
    this.connections.set(hostId, docker);
    return docker;
  }

  /** Read host config from DB (or use defaults for host 0) */
  _getHostConfig(hostId) {
    if (hostId === 0) {
      // Check if DB has a default host override
      try {
        const db = getDb();
        const row = db.prepare('SELECT * FROM docker_hosts WHERE id = 1 OR is_default = 1 ORDER BY is_default DESC LIMIT 1').get();
        if (row) return this._parseHostRow(row);
      } catch { /* DB not ready yet, use config */ }
      return { id: 0, name: 'Local', connectionType: 'socket', socketPath: config.docker.socketPath };
    }

    const db = getDb();
    const row = db.prepare('SELECT * FROM docker_hosts WHERE id = ?').get(hostId);
    if (!row) throw new Error(`Docker host ${hostId} not found`);
    if (!row.is_active) throw new Error(`Docker host "${row.name}" is not active`);
    return this._parseHostRow(row);
  }

  _parseHostRow(row) {
    let tlsConfig = null;
    let sshConfig = null;
    const { tryParseJson } = require('../utils/helpers');
    tlsConfig = tryParseJson(row.tls_config);
    sshConfig = tryParseJson(row.ssh_config);
    return {
      id: row.id,
      name: row.name,
      connectionType: row.connection_type,
      socketPath: row.socket_path,
      host: row.host,
      port: row.port,
      tlsConfig,
      sshConfig,
      isActive: row.is_active,
      isDefault: row.is_default,
    };
  }

  /** Create Dockerode instance from host config */
  _createConnection(hostConfig) {
    switch (hostConfig.connectionType) {
      case 'socket':
        return new Docker({ socketPath: hostConfig.socketPath || config.docker.socketPath });

      case 'tcp': {
        const opts = {
          host: hostConfig.host,
          port: hostConfig.port || 2376,
          timeout: 30000,
        };
        if (hostConfig.tlsConfig) {
          opts.ca = hostConfig.tlsConfig.ca;
          opts.cert = hostConfig.tlsConfig.cert;
          opts.key = hostConfig.tlsConfig.key;
        }
        // If port is 2375 and no TLS, connect without TLS (Docker Desktop mode)
        if (!hostConfig.tlsConfig && hostConfig.port === 2375) {
          opts.protocol = 'http';
        } else if (hostConfig.tlsConfig) {
          opts.protocol = 'https';
        }
        return new Docker(opts);
      }

      case 'ssh': {
        // SSH tunnel: check if tunnel exists, if not it will be created async
        const tunnel = this._getExistingTunnel(hostConfig.id);
        if (tunnel && tunnel.localPort) {
          return new Docker({ host: '127.0.0.1', port: tunnel.localPort, protocol: 'http' });
        }
        // Tunnel doesn't exist yet — trigger async creation and throw
        this._ensureTunnel(hostConfig);
        throw new Error(`SSH tunnel for host "${hostConfig.name}" is starting. Please wait a moment and retry.`);
      }

      default:
        return new Docker({ socketPath: config.docker.socketPath });
    }
  }

  /** Check if SSH tunnel already exists */
  _getExistingTunnel(hostId) {
    try {
      const sshTunnelService = require('./ssh-tunnel');
      return sshTunnelService.getTunnel(hostId);
    } catch {
      return null;
    }
  }

  /** Ensure SSH tunnel is created (async, non-blocking) */
  _ensureTunnel(hostConfig) {
    // Don't try multiple times in parallel
    if (this._pendingTunnels?.has(hostConfig.id)) return;
    if (!this._pendingTunnels) this._pendingTunnels = new Set();
    this._pendingTunnels.add(hostConfig.id);

    const sshTunnelService = require('./ssh-tunnel');
    sshTunnelService.createTunnel(hostConfig)
      .then(() => {
        log.info(`SSH tunnel ready for host ${hostConfig.id} (${hostConfig.name})`);
        // Drop cached connection so next getDocker() picks up the tunnel
        this.connections.delete(hostConfig.id);
        this._pendingTunnels.delete(hostConfig.id);
      })
      .catch((err) => {
        log.error(`SSH tunnel creation failed for host ${hostConfig.id}: ${err.message}`);
        this._pendingTunnels.delete(hostConfig.id);
      });
  }

  /** Initialize all SSH tunnels for active hosts (called at startup) */
  async initSshTunnels() {
    const hosts = this.getActiveHosts();
    const sshHosts = hosts.filter(h => h.connectionType === 'ssh' && h.sshConfig);
    if (sshHosts.length === 0) return;

    log.info(`Initializing SSH tunnels for ${sshHosts.length} host(s)`);
    const sshTunnelService = require('./ssh-tunnel');
    for (const host of sshHosts) {
      try {
        await sshTunnelService.createTunnel(host);
        log.info(`SSH tunnel ready: ${host.name}`);
      } catch (err) {
        log.warn(`SSH tunnel failed for ${host.name}: ${err.message} (will retry)`);
      }
    }
  }

  /** Drop cached connection for a host (force reconnect) */
  dropConnection(hostId) {
    this.connections.delete(hostId);
    this._hostCache.delete(hostId);
  }

  /** Get all active hosts from DB */
  getActiveHosts() {
    try {
      const db = getDb();
      return db.prepare('SELECT * FROM docker_hosts WHERE is_active = 1 ORDER BY is_default DESC, name ASC').all()
        .map(r => this._parseHostRow(r));
    } catch {
      return [{ id: 0, name: 'Local', connectionType: 'socket', socketPath: config.docker.socketPath, isActive: true, isDefault: true }];
    }
  }

  /** Test a connection config (without saving) */
  async testConnection(hostConfig) {
    const docker = this._createConnection(hostConfig);
    const start = Date.now();
    try {
      const info = await Promise.race([
        docker.info(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout (10s)')), 10000)),
      ]);
      const latency = Date.now() - start;
      return {
        ok: true,
        latency,
        hostname: info.Name,
        dockerVersion: info.ServerVersion,
        os: `${info.OperatingSystem} (${info.Architecture})`,
        containers: info.Containers,
        images: info.Images,
        cpus: info.NCPU,
        memory: info.MemTotal,
      };
    } catch (err) {
      return { ok: false, error: err.message, latency: Date.now() - start };
    }
  }

  /** Start periodic health checks for all hosts */
  startHealthChecks() {
    if (this._healthInterval) return;
    this._healthInterval = setInterval(() => this._checkAllHosts(), 60000);
    // Initial check after 5s
    setTimeout(() => this._checkAllHosts(), 5000);
  }

  stopHealthChecks() {
    if (this._healthInterval) { clearInterval(this._healthInterval); this._healthInterval = null; }
  }

  async _checkAllHosts() {
    const hosts = this.getActiveHosts();
    for (const host of hosts) {
      try {
        const docker = this.getDocker(host.id);
        await Promise.race([
          docker.ping(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);
        this._updateHostStatus(host.id, true);
      } catch {
        this._updateHostStatus(host.id, false);
        // Drop stale connection so next request creates fresh one
        this.connections.delete(host.id);
      }
    }
  }

  _updateHostStatus(hostId, healthy) {
    try {
      const db = getDb();
      if (healthy) {
        db.prepare('UPDATE docker_hosts SET last_seen_at = datetime(\'now\') WHERE id = ?').run(hostId);
      }
      this._hostCache.set(hostId, { healthy, lastCheck: Date.now() });
    } catch { /* ignore */ }
  }

  getHostStatus(hostId) {
    return this._hostCache.get(hostId) || { healthy: null, lastCheck: null };
  }

  /** Detect own container ID to prevent self-destruction */
  async detectSelfId() {
    try {
      const fs = require('fs');
      if (fs.existsSync('/proc/self/cgroup')) {
        const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
        const match = cgroup.match(/[a-f0-9]{64}/);
        if (match) { this._selfId = match[0]; return; }
      }
      const hostname = os.hostname();
      if (/^[a-f0-9]{12,64}$/.test(hostname)) { this._selfId = hostname; }
    } catch { /* ignore */ }
  }

  isSelf(containerId) {
    if (!this._selfId) return false;
    return containerId.startsWith(this._selfId) || this._selfId.startsWith(containerId);
  }

  // ─── Containers ──────────────────────────────────────────

  async listContainers(hostId = 0) {
    const docker = this.getDocker(hostId);
    const containers = await docker.listContainers({ all: true });
    return containers.map(c => ({
      id: c.Id,
      shortId: c.Id.substring(0, 12),
      name: c.Names[0]?.replace(/^\//, '') || 'unknown',
      image: c.Image,
      imageId: c.ImageID?.substring(7, 19),
      state: c.State,
      status: c.Status,
      created: c.Created,
      ports: c.Ports.map(p => ({
        private: p.PrivatePort, public: p.PublicPort, type: p.Type, ip: p.IP
      })),
      networks: Object.keys(c.NetworkSettings?.Networks || {}),
      mounts: (c.Mounts || []).map(m => ({
        type: m.Type, source: m.Source, destination: m.Destination, rw: m.RW
      })),
      labels: c.Labels || {},
      stack: c.Labels?.['com.docker.compose.project'] || null,
      isSelf: hostId === 0 && this.isSelf(c.Id),
      hostId,
    }));
  }

  async inspectContainer(id, hostId = 0) {
    const container = this.getDocker(hostId).getContainer(id);
    const data = await container.inspect({ size: true });
    return {
      id: data.Id,
      name: data.Name?.replace(/^\//, ''),
      image: data.Config.Image,
      created: data.Created,
      state: data.State,
      restartCount: data.RestartCount,
      platform: data.Platform,
      env: data.Config.Env || [],
      cmd: data.Config.Cmd,
      entrypoint: data.Config.Entrypoint,
      workingDir: data.Config.WorkingDir,
      hostname: data.Config.Hostname,
      ports: data.NetworkSettings?.Ports || {},
      mounts: data.Mounts || [],
      networks: data.NetworkSettings?.Networks || {},
      healthcheck: data.State.Health || null,
      labels: data.Config.Labels || {},
      sizeRw: data.SizeRw || 0,
      sizeRootFs: data.SizeRootFs || 0,
      resources: {
        cpuShares: data.HostConfig?.CpuShares,
        cpuQuota: data.HostConfig?.CpuQuota,
        cpuPeriod: data.HostConfig?.CpuPeriod,
        memory: data.HostConfig?.Memory,
        memorySwap: data.HostConfig?.MemorySwap,
        memoryReservation: data.HostConfig?.MemoryReservation,
        pidsLimit: data.HostConfig?.PidsLimit,
      },
      restartPolicy: data.HostConfig?.RestartPolicy,
      isSelf: hostId === 0 && this.isSelf(data.Id),
      hostId,
    };
  }

  async containerAction(id, action, hostId = 0) {
    if (hostId === 0 && this.isSelf(id) && ['stop', 'restart', 'remove', 'kill', 'pause'].includes(action)) {
      throw new Error('Cannot perform this action on Docker Dash itself');
    }
    const container = this.getDocker(hostId).getContainer(id);
    switch (action) {
      case 'start': await container.start(); break;
      case 'stop': await container.stop(); break;
      case 'restart': await container.restart(); break;
      case 'pause': await container.pause(); break;
      case 'unpause': await container.unpause(); break;
      case 'kill': await container.kill(); break;
      default: throw new Error(`Unknown action: ${action}`);
    }
  }

  async removeContainer(id, { force = false, v = false } = {}, hostId = 0) {
    if (hostId === 0 && this.isSelf(id)) throw new Error('Cannot remove Docker Dash itself');
    const container = this.getDocker(hostId).getContainer(id);
    await container.remove({ force, v });
  }

  async renameContainer(id, newName, hostId = 0) {
    const container = this.getDocker(hostId).getContainer(id);
    await container.rename({ name: newName });
  }

  async createContainer(opts, hostId = 0) {
    const docker = this.getDocker(hostId);
    const container = await docker.createContainer(opts);
    return { id: container.id };
  }

  async getContainerLogs(id, { tail = 100, since, until } = {}, hostId = 0) {
    const container = this.getDocker(hostId).getContainer(id);
    const opts = { stdout: true, stderr: true, tail, timestamps: true };
    if (since) opts.since = Math.floor(new Date(since).getTime() / 1000);
    if (until) opts.until = Math.floor(new Date(until).getTime() / 1000);
    const buffer = await container.logs(opts);
    return this._demuxLogs(buffer);
  }

  async getContainerStats(id, hostId = 0) {
    const container = this.getDocker(hostId).getContainer(id);
    const stats = await container.stats({ stream: false });
    return this._parseStats(stats);
  }

  // ─── Images ───────────────────────────────────────────────

  async listImages(hostId = 0) {
    const docker = this.getDocker(hostId);
    const images = await docker.listImages({ all: false });
    return images.map(img => ({
      id: img.Id,
      shortId: img.Id.replace('sha256:', '').substring(0, 12),
      repoTags: img.RepoTags || [],
      repoDigests: img.RepoDigests || [],
      size: img.Size,
      virtualSize: img.VirtualSize,
      created: img.Created,
      labels: img.Labels || {},
      containers: img.Containers,
      hostId,
    }));
  }

  async inspectImage(id, hostId = 0) {
    const image = this.getDocker(hostId).getImage(id);
    return await image.inspect();
  }

  async imageHistory(id, hostId = 0) {
    const image = this.getDocker(hostId).getImage(id);
    return await image.history();
  }

  async pullImage(repoTag, hostId = 0) {
    const docker = this.getDocker(hostId);
    return new Promise((resolve, reject) => {
      docker.pull(repoTag, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err, output) => {
          if (err) return reject(err);
          resolve(output);
        });
      });
    });
  }

  async removeImage(id, { force = false } = {}, hostId = 0) {
    const image = this.getDocker(hostId).getImage(id);
    await image.remove({ force });
  }

  // ─── Volumes ──────────────────────────────────────────────

  async listVolumes(hostId = 0) {
    const docker = this.getDocker(hostId);
    const { Volumes } = await docker.listVolumes();
    let sizeMap = {};
    try {
      const df = await docker.df();
      for (const v of (df.Volumes || [])) {
        if (v.Name && v.UsageData) sizeMap[v.Name] = v.UsageData.Size;
      }
    } catch { /* size info unavailable */ }
    return (Volumes || []).map(v => ({
      name: v.Name,
      driver: v.Driver,
      mountpoint: v.Mountpoint,
      scope: v.Scope,
      labels: v.Labels || {},
      options: v.Options || {},
      created: v.CreatedAt,
      size: sizeMap[v.Name] ?? -1,
      hostId,
    }));
  }

  async inspectVolume(name, hostId = 0) {
    const volume = this.getDocker(hostId).getVolume(name);
    return await volume.inspect();
  }

  async removeVolume(name, { force = false } = {}, hostId = 0) {
    const volume = this.getDocker(hostId).getVolume(name);
    await volume.remove({ force });
  }

  // ─── Networks ─────────────────────────────────────────────

  async listNetworks(hostId = 0) {
    const docker = this.getDocker(hostId);
    const networks = await docker.listNetworks();
    const results = [];
    for (const n of networks) {
      let containers = {};
      try {
        const detail = await docker.getNetwork(n.Id).inspect();
        containers = detail.Containers || {};
      } catch { /* ignore inspect errors */ }
      const subnet = n.IPAM?.Config?.[0]?.Subnet || '';
      results.push({
        id: n.Id,
        shortId: n.Id.substring(0, 12),
        name: n.Name,
        driver: n.Driver,
        scope: n.Scope,
        internal: n.Internal,
        ipam: n.IPAM,
        containers,
        subnet,
        labels: n.Labels || {},
        created: n.Created,
        hostId,
      });
    }
    return results;
  }

  async inspectNetwork(id, hostId = 0) {
    const network = this.getDocker(hostId).getNetwork(id);
    return await network.inspect();
  }

  async createNetwork(opts, hostId = 0) {
    const docker = this.getDocker(hostId);
    return await docker.createNetwork(opts);
  }

  async removeNetwork(id, hostId = 0) {
    const network = this.getDocker(hostId).getNetwork(id);
    await network.remove();
  }

  // ─── System ───────────────────────────────────────────────

  async getInfo(hostId = 0) {
    const docker = this.getDocker(hostId);
    const [info, version] = await Promise.all([docker.info(), docker.version()]);
    return {
      hostname: info.Name,
      os: `${info.OperatingSystem} (${info.Architecture})`,
      kernelVersion: info.KernelVersion,
      dockerVersion: version.Version,
      apiVersion: version.ApiVersion,
      containers: info.Containers,
      containersRunning: info.ContainersRunning,
      containersPaused: info.ContainersPaused,
      containersStopped: info.ContainersStopped,
      images: info.Images,
      memTotal: info.MemTotal,
      cpus: info.NCPU,
      storageDriver: info.Driver,
      serverTime: new Date().toISOString(),
      uptime: os.uptime(),
      hostId,
    };
  }

  async getDiskUsage(hostId = 0) {
    const docker = this.getDocker(hostId);
    return await docker.df();
  }

  async prune({ containers, images, volumes, networks, buildCache } = {}, hostId = 0) {
    const docker = this.getDocker(hostId);
    const results = {};
    if (containers) results.containers = await docker.pruneContainers();
    if (images) results.images = await docker.pruneImages();
    if (volumes) results.volumes = await docker.pruneVolumes();
    if (networks) results.networks = await docker.pruneNetworks();
    return results;
  }

  // ─── Events Stream ────────────────────────────────────────

  async getEventStream(hostId = 0) {
    const docker = this.getDocker(hostId);
    return await docker.getEvents();
  }

  // ─── Exec ─────────────────────────────────────────────────

  async createExec(containerId, shell = '/bin/sh', hostId = 0) {
    const container = this.getDocker(hostId).getContainer(containerId);
    return await container.exec({
      Cmd: [shell],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Env: ['TERM=xterm-256color'],
    });
  }

  // ─── Helpers ──────────────────────────────────────────────

  _parseStats(stats) {
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats.cpu_usage.total_usage || 0);
    const systemDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats.system_cpu_usage || 0);
    const cpuCount = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
    const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;

    const memUsage = stats.memory_stats.usage - (stats.memory_stats.stats?.cache || 0);
    const memLimit = stats.memory_stats.limit;

    let netRx = 0, netTx = 0;
    if (stats.networks) {
      for (const iface of Object.values(stats.networks)) {
        netRx += iface.rx_bytes || 0;
        netTx += iface.tx_bytes || 0;
      }
    }

    let blkRead = 0, blkWrite = 0;
    if (stats.blkio_stats?.io_service_bytes_recursive) {
      for (const entry of stats.blkio_stats.io_service_bytes_recursive) {
        if (entry.op === 'read' || entry.op === 'Read') blkRead += entry.value;
        if (entry.op === 'write' || entry.op === 'Write') blkWrite += entry.value;
      }
    }

    return {
      cpuPercent: Math.round(cpuPercent * 100) / 100,
      memUsage,
      memLimit,
      memPercent: memLimit > 0 ? Math.round((memUsage / memLimit) * 10000) / 100 : 0,
      netRx, netTx,
      blkRead, blkWrite,
      pids: stats.pids_stats?.current || 0,
    };
  }

  _demuxLogs(buffer) {
    if (typeof buffer === 'string') return buffer.split('\n').filter(Boolean);
    const lines = [];
    let pos = 0;
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    while (pos < buf.length) {
      if (pos + 8 > buf.length) break;
      const size = buf.readUInt32BE(pos + 4);
      pos += 8;
      if (pos + size > buf.length) break;
      const line = buf.slice(pos, pos + size).toString('utf8').trimEnd();
      if (line) lines.push(line);
      pos += size;
    }
    return lines.length > 0 ? lines : buf.toString('utf8').split('\n').filter(Boolean);
  }
}

module.exports = new DockerService();
