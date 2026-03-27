'use strict';

const { WebSocketServer } = require('ws');
const authService = require('../services/auth');
const dockerService = require('../services/docker');
const alertService = require('../services/alerts');
const { dockerEvents } = require('../services/misc');
const config = require('../config');
const log = require('../utils/logger')('ws');
const { tryParseJson } = require('../utils/helpers');

class WsServer {
  constructor() {
    this.wss = null;
    this.clients = new Map(); // ws → { user, subscriptions: Set }
    this._eventStreams = new Map(); // hostId → stream
  }

  attach(server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

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
      // Authenticate via query param or cookie
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token') || this._extractCookie(req, config.session.cookieName);
      const user = authService.validateSession(token);

      if (!user) {
        ws.close(4001, 'Authentication required');
        return;
      }

      const client = { user, subscriptions: new Set(), isAlive: true, msgCount: 0, msgResetTime: Date.now() };
      this.clients.set(ws, client);
      log.debug('Client connected', { username: user.username });

      ws.on('pong', () => {
        const c = this.clients.get(ws);
        if (c) c.isAlive = true;
      });

      ws.on('message', (data) => this._handleMessage(ws, data));
      ws.on('close', () => this._cleanupClient(ws));
      ws.on('error', (err) => log.error('WS error', err.message));

      ws.send(JSON.stringify({ type: 'connected', user: { id: user.id, username: user.username } }));
    });

    // Set up alert notifier
    alertService.setNotifier((type, data) => this.broadcast(type, data));

    // Start Docker events listeners for all active hosts
    this._startAllEventStreams();

    log.info('WebSocket server attached');
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

  /** Broadcast to all clients subscribed to a channel or globally */
  broadcast(type, data, channel = null) {
    const message = JSON.stringify({ type, data, channel, time: Date.now() });
    for (const [ws, client] of this.clients) {
      if (ws.readyState !== 1) continue; // OPEN
      if (channel && !client.subscriptions.has(channel)) continue;
      try { ws.send(message); } catch { /* ignore */ }
    }
  }

  /** Broadcast to all authenticated clients */
  broadcastAll(type, data) {
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

          // Store in DB
          dockerEvents.store({
            eventType: data.type,
            action: data.action,
            actorId: data.actorId,
            actorName: data.actorName,
            attributes: data.attributes,
            eventTime: new Date(event.time * 1000).toISOString(),
            hostId,
          });

          // Broadcast
          this.broadcastAll('event', data);
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
