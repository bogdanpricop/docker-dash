'use strict';

const { WebSocketServer } = require('ws');
const authService = require('../services/auth');
const dockerService = require('../services/docker');
const alertService = require('../services/alerts');
const { dockerEvents } = require('../services/misc');
const config = require('../config');
const log = require('../utils/logger')('ws');
const { tryParseJson } = require('../utils/helpers');
const cluster = require('../services/cluster');

class WsServer {
  constructor() {
    this.wss = null;
    this.clients = new Map(); // ws → { user, subscriptions: Set }
    this._eventStreams = new Map(); // hostId → stream
  }

  attach(server) {
    // ─── Per-IP connection tracking ──────────────────────────
    const _ipCounts = new Map(); // ip → count
    const _wsMaxPerIp = parseInt(process.env.WS_MAX_CONNECTIONS_PER_IP || '10', 10);
    const _wsQueryTokenEnabled = process.env.WS_QUERY_TOKEN_ENABLED === 'true';

    // ─── Origin allow-list ───────────────────────────────────
    function _getAllowedOrigins(host) {
      const raw = process.env.WS_ALLOWED_ORIGINS;
      if (raw && raw.trim()) {
        return new Set(raw.split(',').map(o => o.trim()).filter(Boolean));
      }
      // Default: same-host origins
      return new Set([
        `http://${host}`,
        `https://${host}`,
      ]);
    }

    const verifyClient = ({ req }, cb) => {
      const origin = req.headers.origin;
      const host = req.headers.host || 'localhost';
      const allowed = _getAllowedOrigins(host);

      // Reject cross-origin connections
      if (origin && !allowed.has(origin)) {
        log.warn('WS rejected: origin not allowed', { origin, allowed: [...allowed] });
        return cb(false, 403, 'Origin not allowed');
      }

      // Reject query token auth if not explicitly enabled
      if (!_wsQueryTokenEnabled) {
        const url = new URL(req.url, 'http://localhost');
        if (url.searchParams.has('token')) {
          log.warn('WS rejected: query token auth disabled (set WS_QUERY_TOKEN_ENABLED=true to enable)', { ip: req.socket?.remoteAddress });
          return cb(false, 403, 'Query token auth disabled');
        }
      }

      // Per-IP connection limit
      const ip = req.socket?.remoteAddress || 'unknown';
      const count = _ipCounts.get(ip) || 0;
      if (count >= _wsMaxPerIp) {
        log.warn('WS rejected: per-IP limit reached', { ip, limit: _wsMaxPerIp });
        return cb(false, 429, 'Too many connections');
      }
      _ipCounts.set(ip, count + 1);

      // Attach cleanup to socket close
      req.socket.once('close', () => {
        const cur = _ipCounts.get(ip) || 1;
        if (cur <= 1) _ipCounts.delete(ip);
        else _ipCounts.set(ip, cur - 1);
      });

      cb(true);
    };

    this.wss = new WebSocketServer({ server, path: '/ws', verifyClient });

    // Heartbeat: ping every 30s, terminate dead connections
    this._heartbeatInterval = setInterval(() => {
      for (const [ws, client] of this.clients) {
        if (client.isAlive === false) {
          this._cleanupClient(ws);
          ws.terminate();
          continue;
        }
        client.isAlive = false;
        try { ws.ping(); } catch {}
      }
    }, 30000);

    this.wss.on('connection', (ws, req) => {
      // Authenticate via cookie (preferred) or query param (fallback for blocked cookies)
      // NOTE: Query param auth is a fallback for browsers that block cookies (Edge Tracking Prevention).
      // Cookie-based auth is preferred as tokens in URLs can leak via logs/referrer.
      const cookieToken = this._extractCookie(req, config.session.cookieName);
      const url = new URL(req.url, 'http://localhost');
      const queryToken = url.searchParams.get('token');

      // In strict security mode, reject query-string token auth (cookie-only)
      let token;
      if (config.security.disableWsQueryAuth) {
        token = cookieToken;
        if (queryToken && !cookieToken) {
          log.warn('WS query-string auth rejected (strict mode)', { ip: req.socket?.remoteAddress });
        }
      } else {
        token = cookieToken || queryToken;
        if (queryToken && !cookieToken) {
          log.debug('WS auth via query param (cookie blocked)', { ip: req.socket?.remoteAddress });
        }
      }
      const user = authService.validateSession(token);

      if (!user) {
        ws.close(4001, 'Authentication required');
        return;
      }

      // v8.7.18 — capture connection IP so exec/audit events can attribute correctly.
      const ip = req.socket?.remoteAddress || 'unknown';
      const client = { user, ip, subscriptions: new Set(), isAlive: true, msgCount: 0, msgResetTime: Date.now() };
      this.clients.set(ws, client);
      log.debug('Client connected', { username: user.username });
      // v6.15.0: Prometheus gauge
      try { require('../services/metrics').recordWsConnection(1); } catch { /* best-effort */ }

      ws.on('pong', () => {
        const c = this.clients.get(ws);
        if (c) c.isAlive = true;
      });

      ws.on('message', (data) => this._handleMessage(ws, data));
      ws.on('close', () => {
        this._cleanupClient(ws);
        try { require('../services/metrics').recordWsConnection(-1); } catch { /* best-effort */ }
      });
      ws.on('error', (err) => log.error('WS error', err.message));

      ws.send(JSON.stringify({ type: 'connected', user: { id: user.id, username: user.username } }));
    });

    // Set up alert notifier
    alertService.setNotifier((type, data) => this.broadcast(type, data));

    // v6.17.1 Phase 3 — subscribe to cross-replica WS broadcasts from other
    // HA replicas. In standalone mode this is a no-op. The cluster module
    // filters out self-echoes via `nodeId`, so local delivery still happens
    // exactly once (via the direct `_localBroadcast` call in our own
    // `broadcast()`); only messages from OTHER replicas arrive here.
    cluster.subscribe('ws:broadcast', (payload) => {
      if (!payload || !payload.type) return;
      if (payload.kind === 'all') {
        this._localBroadcastAll(payload.type, payload.data);
      } else {
        this._localBroadcast(payload.type, payload.data, payload.channel || null);
      }
    });

    // v6.17.2 Phase 4 — Docker event streams are leader-only. Each replica
    // subscribing to Docker independently would deliver events N× to users
    // (because Phase 3 cross-replica broadcast now propagates them). Gate
    // start/stop on role transition.
    cluster.onBecomeLeader(() => {
      log.info('Became leader — starting Docker event streams');
      this._startAllEventStreams();
    });
    cluster.onBecomeReader(() => {
      log.info('Became reader — stopping Docker event streams');
      this._stopAllEventStreams();
    });

    log.info('WebSocket server attached', { mode: cluster.isHa() ? 'ha' : 'standalone', nodeId: cluster.nodeId() });
  }

  /** Stop all Docker event streams. Used on leader→reader transition. */
  _stopAllEventStreams() {
    for (const [hostId, stream] of this._eventStreams) {
      try { stream.destroy(); } catch { /* ignore */ }
      this._eventStreams.delete(hostId);
    }
  }

  async _handleMessage(ws, raw) {
    const msg = tryParseJson(raw.toString());
    if (!msg) return;

    const client = this.clients.get(ws);
    if (!client) return;

    // Rate limiting: max 100 messages per second
    const now = Date.now();
    if (now - client.msgResetTime > 1000) {
      client.msgCount = 0;
      client.msgResetTime = now;
    }
    client.msgCount++;
    if (client.msgCount > 100) return;

    switch (msg.type) {
      case 'subscribe':
        client.subscriptions.add(msg.channel);
        ws.send(JSON.stringify({ type: 'subscribed', channel: msg.channel }));
        break;

      case 'unsubscribe':
        client.subscriptions.delete(msg.channel);
        ws.send(JSON.stringify({ type: 'unsubscribed', channel: msg.channel }));
        break;

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', time: Date.now() }));
        break;

      case 'exec:start':
        this.startExec(ws, msg.containerId, msg.shell, msg.cols, msg.rows, msg.hostId || 0);
        break;

      case 'exec:input':
        this._handleExecInput(ws, msg);
        break;

      case 'exec:resize':
        this._handleExecResize(ws, msg);
        break;

      // v8.9.15-alpha.1 — interactive SSH console to a vSphere/ESXi host.
      case 'ssh:start':
        this.startVsphereSsh(ws, msg.hostId || 0, msg.cols, msg.rows);
        break;
      case 'ssh:input':
        this._handleSshInput(ws, msg);
        break;
      case 'ssh:resize':
        this._handleSshResize(ws, msg);
        break;

      case 'logs:subscribe': {
        const client2 = this.clients.get(ws);
        if (!client2) break;
        // Cleanup previous log stream
        if (client2.logStream) { try { client2.logStream.destroy(); } catch {} client2.logStream = null; }

        try {
          const container = dockerService.getDocker(msg.hostId || 0).getContainer(msg.containerId);
          const stream = await container.logs({
            follow: true, stdout: true, stderr: true,
            tail: msg.tail || 100, timestamps: true,
          });

          client2.logStream = stream;
          client2.logContainerId = msg.containerId;

          stream.on('data', (chunk) => {
            if (ws.readyState !== 1) return;
            // Docker log stream has 8-byte header per frame
            const lines = [];
            let offset = 0;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            while (offset < buf.length) {
              if (offset + 8 > buf.length) { lines.push(buf.slice(offset).toString('utf8')); break; }
              const size = buf.readUInt32BE(offset + 4);
              if (size === 0 || offset + 8 + size > buf.length) { lines.push(buf.slice(offset).toString('utf8')); break; }
              lines.push(buf.slice(offset + 8, offset + 8 + size).toString('utf8'));
              offset += 8 + size;
            }
            try {
              ws.send(JSON.stringify({ type: 'logs:data', containerId: msg.containerId, lines }));
            } catch {}
          });

          stream.on('end', () => {
            try { ws.send(JSON.stringify({ type: 'logs:end', containerId: msg.containerId })); } catch {}
            client2.logStream = null;
          });

          stream.on('error', () => {
            try { ws.send(JSON.stringify({ type: 'logs:end', containerId: msg.containerId })); } catch {}
            client2.logStream = null;
          });

          ws.send(JSON.stringify({ type: 'logs:subscribed', containerId: msg.containerId }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'logs:error', error: err.message }));
        }
        break;
      }

      case 'logs:unsubscribe': {
        const client3 = this.clients.get(ws);
        if (client3?.logStream) {
          try { client3.logStream.destroy(); } catch {}
          client3.logStream = null;
          client3.logContainerId = null;
        }
        break;
      }

      default:
        ws.send(JSON.stringify({ type: 'error', message: `Unknown type: ${msg.type}` }));
    }
  }

  /** Broadcast to all clients subscribed to a channel or globally.
   *  v6.17.1: in HA mode, also publishes to Redis pub/sub so other replicas
   *  relay to their local clients. Loop-safe via `nodeId` filter in cluster.js. */
  broadcast(type, data, channel = null) {
    // Cross-replica publish (best-effort, fire-and-forget in HA; no-op standalone)
    cluster.publish('ws:broadcast', { kind: 'channel', type, data, channel }).catch(() => {});
    this._localBroadcast(type, data, channel);
  }

  /** Broadcast to all authenticated clients. HA-aware like `broadcast`. */
  broadcastAll(type, data) {
    cluster.publish('ws:broadcast', { kind: 'all', type, data }).catch(() => {});
    this._localBroadcastAll(type, data);
  }

  /** Local-only delivery for a channel broadcast (called directly on publish,
   *  and indirectly by the cluster subscriber when another replica broadcasts). */
  _localBroadcast(type, data, channel = null) {
    const message = JSON.stringify({ type, data, channel, time: Date.now() });
    for (const [ws, client] of this.clients) {
      if (ws.readyState !== 1) continue; // OPEN
      if (channel && !client.subscriptions.has(channel)) continue;
      try { ws.send(message); } catch { /* ignore */ }
    }
  }

  /** Local-only delivery for broadcastAll. */
  _localBroadcastAll(type, data) {
    const message = JSON.stringify({ type, data, time: Date.now() });
    for (const [ws] of this.clients) {
      if (ws.readyState !== 1) continue;
      try { ws.send(message); } catch { /* ignore */ }
    }
  }

  /** Send live stats to subscribed clients */
  broadcastStats(containerId, stats) {
    this.broadcast('stats:update', stats, `stats:${containerId}`);
  }

  /** Send live log line */
  broadcastLog(containerId, line) {
    this.broadcast('logs:line', { line }, `logs:${containerId}`);
  }

  /** Start Docker events streams for all active hosts */
  _startAllEventStreams() {
    const hosts = dockerService.getActiveHosts();
    for (const host of hosts) {
      this._startEventStream(host.id, host.name);
    }
  }

  /** Refresh event streams (call when hosts are added/removed) */
  refreshEventStreams() {
    const hosts = dockerService.getActiveHosts();
    const activeIds = new Set(hosts.map(h => h.id));

    // Stop streams for removed hosts
    for (const [hostId, stream] of this._eventStreams) {
      if (!activeIds.has(hostId)) {
        try { stream.destroy(); } catch {}
        this._eventStreams.delete(hostId);
      }
    }

    // Start streams for new hosts
    for (const host of hosts) {
      if (!this._eventStreams.has(host.id)) {
        this._startEventStream(host.id, host.name);
      }
    }
  }

  /** Start Docker events stream for a specific host */
  async _startEventStream(hostId = 0, hostName = 'Local') {
    try {
      const stream = await dockerService.getEventStream(hostId);
      stream.on('data', (chunk) => {
        try {
          const event = JSON.parse(chunk.toString());
          const data = {
            type: event.Type,
            action: event.Action,
            actorId: event.Actor?.ID,
            actorName: event.Actor?.Attributes?.name,
            attributes: event.Actor?.Attributes,
            time: event.time,
            hostId,
            hostName,
          };

          // Store in DB — but skip the high-frequency `exec_*` noise
          // (exec_create / exec_start / exec_die). Container healthchecks emit
          // 3 of these every few seconds per container; persisting them bloats
          // docker_events (>95% of rows on busy hosts) with no diagnostic value.
          // They're still broadcast live + fed to the notifier below; we only
          // skip PERSISTING them. Opt back in with DD_STORE_EXEC_EVENTS=true.
          const isExecNoise = data.type === 'container' && /^exec_/.test(String(data.action || ''));
          if (config.retention.storeExecEvents || !isExecNoise) {
            dockerEvents.store({
              eventType: data.type,
              action: data.action,
              actorId: data.actorId,
              actorName: data.actorName,
              attributes: data.attributes,
              eventTime: new Date(event.time * 1000).toISOString(),
              hostId,
            });
          }

          // Broadcast to WebSocket clients
          this.broadcastAll('event', data);

          // Send notifications for important events (crash, OOM, health fail)
          try {
            const eventNotifier = require('../services/eventNotifier');
            eventNotifier.processEvent(data);
            eventNotifier.evaluateWorkflows(data);
          } catch { /* notifier not critical */ }
        } catch { /* malformed event */ }
      });

      stream.on('error', (err) => {
        log.error(`Event stream error (host ${hostId})`, err.message);
        this._eventStreams.delete(hostId);
        setTimeout(() => this._startEventStream(hostId, hostName), 5000);
      });

      stream.on('end', () => {
        log.warn(`Event stream ended for host ${hostId}, reconnecting...`);
        this._eventStreams.delete(hostId);
        setTimeout(() => this._startEventStream(hostId, hostName), 5000);
      });

      this._eventStreams.set(hostId, stream);
    } catch (err) {
      // Rate-limit reconnect attempts for failing hosts (back off to 60s)
      if (!this._eventRetryCount) this._eventRetryCount = new Map();
      const retries = (this._eventRetryCount.get(hostId) || 0) + 1;
      this._eventRetryCount.set(hostId, retries);
      const delay = Math.min(10000 * retries, 60000);
      if (retries <= 3) {
        log.warn(`Event stream failed for host ${hostId}: ${err.message} (retry ${retries} in ${delay / 1000}s)`);
      }
      setTimeout(() => this._startEventStream(hostId, hostName), delay);
    }
  }

  // ─── Exec Handling ────────────────────────────────────────

  async _handleExecInput(ws, msg) {
    const client = this.clients.get(ws);
    if (!client?.execStream) return;
    try { client.execStream.write(msg.data); } catch { /* ignore */ }
  }

  async _handleExecResize(ws, msg) {
    const client = this.clients.get(ws);
    if (!client?.exec) return;
    try { await client.exec.resize({ w: msg.cols, h: msg.rows }); } catch { /* ignore */ }
  }

  // ─── vSphere/ESXi SSH console (v8.9.15-alpha.1) ─────────────
  _handleSshInput(ws, msg) {
    const c = this.clients.get(ws);
    if (!c || !c.sshStream) return;
    try { c.sshStream.write(msg.data); } catch { /* ignore */ }
  }

  _handleSshResize(ws, msg) {
    const c = this.clients.get(ws);
    if (!c || !c.sshStream) return;
    try { c.sshStream.setWindow(msg.rows, msg.cols, 0, 0); } catch { /* ignore */ }
  }

  /** Open an interactive SSH shell to a vSphere host's ESXi over ssh2. */
  async startVsphereSsh(ws, hostId, cols = 80, rows = 24) {
    const client = this.clients.get(ws);
    // SSH to the hypervisor is powerful — admin only.
    if (!client || client.user.role !== 'admin') {
      ws.send(JSON.stringify({ type: 'ssh:error', message: 'Admin role required for the SSH console' }));
      return;
    }
    let sshConfig, hostName;
    try {
      const { getDb } = require('../db');
      const row = getDb().prepare('SELECT * FROM docker_hosts WHERE id = ?').get(hostId);
      if (!row || row.daemon_type !== 'vsphere') throw new Error('Not a vSphere host');
      hostName = row.name;
      const cfg = require('../services/vsphere').decryptDaemonConfig(row.daemon_config);
      sshConfig = cfg.sshConfig;
      if (!sshConfig || !sshConfig.host || !sshConfig.user || !(sshConfig.password || sshConfig.privateKey)) {
        throw new Error('No SSH credentials configured for this host (Hosts → Edit → SSH access)');
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'ssh:error', message: err.message }));
      return;
    }
    const { Client: SshClient } = require('ssh2');
    const conn = new SshClient();
    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) { ws.send(JSON.stringify({ type: 'ssh:error', message: err.message })); try { conn.end(); } catch { /* ignore */ } return; }
        client.sshConn = conn;
        client.sshStream = stream;
        ws.send(JSON.stringify({ type: 'ssh:ready' }));
        const send = (d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ssh:output', data: d.toString('utf8') })); };
        stream.on('data', send);
        if (stream.stderr) stream.stderr.on('data', send);
        stream.on('close', () => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ssh:end' }));
          try { conn.end(); } catch { /* ignore */ }
          client.sshConn = null; client.sshStream = null;
        });
      });
      try {
        require('../services/audit').log({
          userId: client.user.id, username: client.user.username,
          action: 'vsphere_ssh_console', targetType: 'host', targetId: String(hostId),
          details: { host: hostName }, ip: client.ip,
        });
      } catch { /* ignore */ }
    });
    conn.on('error', (err) => {
      let m = err.message || 'SSH connection failed';
      if (/ECONNREFUSED/.test(m)) m = 'SSH not enabled on this ESXi host (Services → start TSM-SSH), or the port is blocked.';
      else if (/authentication|All configured authentication methods failed/i.test(m)) m = 'SSH authentication failed — check the SSH credentials.';
      ws.send(JSON.stringify({ type: 'ssh:error', message: m }));
    });
    const opts = { host: sshConfig.host, port: sshConfig.port || 22, username: sshConfig.user, readyTimeout: 20000 };
    if (sshConfig.privateKey) opts.privateKey = sshConfig.privateKey; else opts.password = sshConfig.password;
    try { conn.connect(opts); } catch (err) { ws.send(JSON.stringify({ type: 'ssh:error', message: err.message })); }
  }

  /** Start exec session for a client */
  async startExec(ws, containerId, shell = '/bin/sh', cols = 80, rows = 24, hostId = 0) {
    if (!config.features.exec) {
      ws.send(JSON.stringify({ type: 'exec:error', message: 'Exec is disabled' }));
      return;
    }

    const client = this.clients.get(ws);
    if (!client || client.user.role === 'viewer') {
      ws.send(JSON.stringify({ type: 'exec:error', message: 'Insufficient permissions' }));
      return;
    }

    // v8.7.18 SECURITY — per-stack permission check, matching the HTTP
    // pattern for container actions in src/routes/containers.js:329-334.
    // Without this, an operator restricted to specific stacks via the
    // per-stack permission system (admins set this via Settings → Users →
    // Stack Permissions) could exec into a container on ANY stack via
    // WebSocket. The HTTP container-action route (start/stop/restart) has
    // always checked this; the WS exec gate was the gap.
    try {
      const permService = require('../services/permissions');
      const inspect = await dockerService.inspectContainer(containerId, hostId);
      const stack = inspect.Config?.Labels?.['com.docker.compose.project'] || '_standalone';
      const effectiveRole = permService.getEffectiveRole(client.user.id, stack, client.user.role);
      if (!permService.hasPermission(effectiveRole, 'operate')) {
        ws.send(JSON.stringify({ type: 'exec:error', message: 'Insufficient stack permissions for exec' }));
        return;
      }
    } catch (err) {
      // inspect failed — container missing, host unreachable, etc.
      // Treat as deny rather than allow; surface the original error.
      ws.send(JSON.stringify({ type: 'exec:error', message: err.message || 'Container inspect failed' }));
      return;
    }

    try {
      const exec = await dockerService.createExec(containerId, shell, hostId);
      const stream = await exec.start({ hijack: true, stdin: true, Tty: true });

      client.exec = exec;
      client.execStream = stream;

      // Try to set initial terminal size
      try { await exec.resize({ w: cols, h: rows }); } catch {}

      stream.on('data', (chunk) => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'exec:output', data: chunk.toString() }));
        }
      });

      stream.on('end', () => {
        ws.send(JSON.stringify({ type: 'exec:end' }));
        client.exec = null;
        client.execStream = null;
      });

      // v8.7.18 — audit exec session start. The HTTP container actions
      // (start/stop/restart/remove) all audit; WS exec was the only state-
      // changing action that didn't, leaving operators able to run arbitrary
      // commands inside containers with no audit trail.
      try {
        const auditService = require('../services/audit');
        auditService.log({
          userId: client.user.id,
          username: client.user.username,
          action: 'container_exec',
          targetType: 'container',
          targetId: containerId,
          details: { hostId, shell },
          ip: client.ip,
        });
      } catch { /* audit best-effort; don't break the session if logging fails */ }

      ws.send(JSON.stringify({ type: 'exec:started', containerId }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'exec:error', message: err.message }));
    }
  }

  _cleanupClient(ws) {
    const client = this.clients.get(ws);
    if (!client) return;
    if (client.execStream) {
      try { client.execStream.destroy(); } catch {}
      client.execStream = null;
    }
    if (client.logStream) {
      try { client.logStream.destroy(); } catch {}
      client.logStream = null;
    }
    if (client.sshStream) { try { client.sshStream.close(); } catch {} client.sshStream = null; }
    if (client.sshConn) { try { client.sshConn.end(); } catch {} client.sshConn = null; }
    this.clients.delete(ws);
    log.debug('Client cleaned up', { username: client.user?.username });
  }

  _extractCookie(req, name) {
    const cookies = req.headers.cookie?.split(';') || [];
    for (const c of cookies) {
      const [k, v] = c.trim().split('=');
      if (k === name) return v;
    }
    return null;
  }

  getConnectedCount() {
    return this.clients.size;
  }
}

module.exports = new WsServer();
