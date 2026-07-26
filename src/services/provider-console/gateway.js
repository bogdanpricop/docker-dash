'use strict';

const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;
const config = require('../../config');
const auth = require('../auth');
const audit = require('../audit');
const cluster = require('../cluster');
const hostPermissions = require('../host-permissions');
const log = require('../../utils/logger')('provider-console');
const broker = require('./broker');
const providers = require('./providers');
const ByteChannel = require('./byte-channel');
const rfb = require('./rfb');

const PATH = '/ws/provider-console';
const TOKEN_PROTOCOL_PREFIX = 'dd-console.';
const ATTACH_TIMEOUT_MS = 10_000;
const active = new Map();
let wss = null;

function _cookie(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const item of raw.split(';')) {
    const index = item.indexOf('=');
    if (index < 0) continue;
    if (item.slice(0, index).trim() === name) {
      try { return decodeURIComponent(item.slice(index + 1).trim()); }
      catch { return null; }
    }
  }
  return null;
}

function _protocols(req) {
  return String(req.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim()).filter(Boolean);
}

function _launchToken(req) {
  const protocol = _protocols(req).find(value => value.startsWith(TOKEN_PROTOCOL_PREFIX));
  return protocol ? protocol.slice(TOKEN_PROTOCOL_PREFIX.length) : null;
}

function _originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const configured = String(process.env.WS_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  const allowed = configured.length ? configured : [`http://${req.headers.host}`, `https://${req.headers.host}`];
  return allowed.includes(origin);
}

function _reject(socket, status, message) {
  if (!socket.writable) return;
  const body = String(message || 'WebSocket rejected').slice(0, 120);
  try {
    socket.end(`HTTP/1.1 ${status} ${body}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch { try { socket.destroy(); } catch {} }
}

function _isAdmin(user) {
  return user?.role === 'admin' || (Array.isArray(user?.roles) && user.roles.includes('admin'));
}

function _canOperate(user, hostId) {
  if (!user || !['admin', 'operator'].includes(user.role)) return false;
  return ['operate', 'admin'].includes(
    hostPermissions.resolveEffectivePermission(user.id, hostId, _isAdmin(user))
  );
}

function _connectionCapacity(userId, ip) {
  let userCount = 0;
  let ipCount = 0;
  for (const item of active.values()) {
    if (Number(item.user.id) === Number(userId)) userCount++;
    if (item.ip === ip) ipCount++;
  }
  return {
    allowed: userCount < config.providerConsole.maxActivePerUser
      && ipCount < config.providerConsole.maxActivePerIp,
    userCount,
    ipCount,
  };
}

function _waitForAttach(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Console client attach timed out')), ATTACH_TIMEOUT_MS);
    const finish = err => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
      if (err) reject(err); else resolve();
    };
    const onClose = () => finish(new Error('Console client disconnected'));
    const onMessage = (data, isBinary) => {
      if (isBinary || data.length > 512) return finish(new Error('Invalid console attach message'));
      try {
        const message = JSON.parse(data.toString('utf8'));
        if (message?.type !== 'console:attach') throw new Error('invalid type');
        finish();
      } catch { finish(new Error('Invalid console attach message')); }
    };
    ws.on('message', onMessage);
    ws.once('close', onClose);
  });
}

function _forward(left, right, onFailure) {
  let failed = false;
  const fail = () => {
    if (failed) return;
    failed = true;
    onFailure();
  };
  left.startForward(data => right.write(data).catch(fail));
  right.startForward(data => left.write(data).catch(fail));
}

async function _bridgeRfb(ws, upstream) {
  const browser = new ByteChannel(ws);
  const provider = new ByteChannel(upstream.socket);
  try {
    await rfb.authenticateUpstream(provider, upstream.password || null);
    await rfb.authenticateBrowser(browser);
    _forward(browser, provider, () => { try { ws.close(1011, 'Console relay failed'); } catch {} });
    return { browser, provider };
  } catch (err) {
    browser.destroy();
    provider.destroy();
    throw err;
  }
}

function _bridgeSerial(ws, upstream) {
  const browser = new ByteChannel(ws);
  const provider = new ByteChannel(upstream.stream || upstream.socket);
  _forward(browser, provider, () => { try { ws.close(1011, 'Console relay failed'); } catch {} });
  return { browser, provider };
}

function _audit(session, user, req, action, details = {}) {
  audit.log({
    userId: user.id, username: user.username, action,
    targetType: 'virtualMachine', targetId: session.resource_id,
    details: {
      sessionId: session.id, hostId: session.host_id,
      provider: session.provider_type, ...details,
    },
    ip: req.socket?.remoteAddress || 'unknown',
    userAgent: req.headers['user-agent'],
  });
}

async function _start(ws, req, context) {
  const { session, user } = context;
  const startedAt = Date.now();
  let upstream = null;
  let channels = null;
  let finalized = false;
  const finalize = (code = 'closed') => {
    if (finalized) return;
    finalized = true;
    clearTimeout(maxTimer);
    active.delete(session.id);
    try { channels?.browser?.destroy(); } catch {}
    try { channels?.provider?.destroy(); } catch {}
    try { upstream?.close?.(); } catch {}
    broker.markClosed(session.id, code);
    _audit(session, user, req, 'provider_vm_console_close', {
      protocol: upstream?.protocol || null,
      durationSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
      closeCode: String(code).slice(0, 80),
    });
  };
  const maxTimer = setTimeout(() => {
    try { ws.close(1000, 'Maximum console duration reached'); } catch {}
    finalize('max_duration');
  }, config.providerConsole.maxSessionSeconds * 1000);
  maxTimer.unref?.();
  active.set(session.id, {
    ws, session, user, startedAt, finalize,
    ip: req.socket?.remoteAddress || 'unknown',
  });
  ws.once('close', (code) => finalize(`browser_${code}`));
  ws.once('error', () => finalize('browser_error'));
  try {
    upstream = await providers.openForSession(session);
    if (!['rfb', 'serial'].includes(upstream.protocol)) throw new Error('Unsupported console protocol');
    if (ws.readyState !== WebSocket.OPEN) return finalize('browser_closed');
    ws.send(JSON.stringify({
      type: 'console:ready', schemaVersion: '1.0', protocol: upstream.protocol,
      session: {
        id: session.id, provider: session.provider_type,
        resourceId: session.resource_id,
        displayName: session.resource?.displayName || session.resource_id,
        maxDurationSeconds: config.providerConsole.maxSessionSeconds,
      },
    }));
    await _waitForAttach(ws);
    broker.markConnected(session.id, upstream.protocol);
    _audit(session, user, req, 'provider_vm_console_open', {
      protocol: upstream.protocol, credentialIsolation: 'server-side',
    });
    channels = upstream.protocol === 'rfb'
      ? await _bridgeRfb(ws, upstream)
      : _bridgeSerial(ws, upstream);
    const providerSocket = upstream.stream || upstream.socket;
    providerSocket.once?.('close', () => { try { ws.close(1000, 'Provider console closed'); } catch {} });
    providerSocket.once?.('end', () => { try { ws.close(1000, 'Provider console closed'); } catch {} });
    providerSocket.once?.('error', () => { try { ws.close(1011, 'Provider console failed'); } catch {} });
  } catch (err) {
    log.warn('Provider console connection failed', {
      sessionId: session.id, hostId: session.host_id, provider: session.provider_type,
      code: /^[A-Z][A-Z0-9_]{1,79}$/.test(String(err?.code || '')) ? err.code : 'CONSOLE_CONNECT_FAILED',
    });
    _audit(session, user, req, 'provider_vm_console_failed', {
      code: /^[A-Z][A-Z0-9_]{1,79}$/.test(String(err?.code || '')) ? err.code : 'CONSOLE_CONNECT_FAILED',
    });
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'console:error', message: 'Provider console could not be opened' })); } catch {}
      try { ws.close(1011, 'Console unavailable'); } catch {}
    }
    finalize('connect_failed');
  }
}

function terminateSessions({ hostId = null, resourceId = null, reason = 'Console access locked' } = {}) {
  let count = 0;
  for (const item of [...active.values()]) {
    if (hostId !== null && Number(item.session.host_id) !== Number(hostId)) continue;
    if (resourceId !== null && item.session.resource_id !== resourceId) continue;
    count++;
    try { item.ws.close(4003, String(reason || 'Console access locked').slice(0, 120)); } catch {}
    item.finalize('access_locked');
  }
  return count;
}

function getActiveSessions() {
  const items = [...active.values()].map(item => ({
    id: item.session.id, hostId: item.session.host_id,
    resourceId: item.session.resource_id, provider: item.session.provider_type,
    user: item.user.username, startedAt: new Date(item.startedAt).toISOString(),
  }));
  return { count: items.length, items };
}

function attach(server) {
  if (wss) return wss;
  wss = new WebSocketServer({
    noServer: true, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false,
    handleProtocols(protocols) { return protocols.has('binary') ? 'binary' : false; },
  });
  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { return; }
    if (pathname !== PATH) return;
    if (!_originAllowed(req)) return _reject(socket, 403, 'Forbidden');
    const token = _launchToken(req);
    if (!broker.TOKEN_RE.test(String(token || '')) || !_protocols(req).includes('binary')) {
      return _reject(socket, 401, 'Unauthorized');
    }
    const user = auth.validateSession(_cookie(req, config.session.cookieName));
    if (!user) return _reject(socket, 401, 'Unauthorized');
    const ip = req.socket?.remoteAddress || 'unknown';
    if (!_connectionCapacity(user.id, ip).allowed) {
      return _reject(socket, 429, 'Too Many Requests');
    }
    let session;
    try {
      session = broker.consume(token, user.id);
      if (!_canOperate(user, session.host_id)) {
        broker.markClosed(session.id, 'permission_denied');
        _audit(session, user, req, 'provider_vm_console_denied', { code: 'PERMISSION_BLOCKED' });
        return _reject(socket, 403, 'Forbidden');
      }
    } catch (err) {
      return _reject(socket, [401, 403, 423, 429].includes(err.status) ? err.status : 401, 'Unauthorized');
    }
    req.providerConsoleContext = { session, user };
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws, req) => _start(ws, req, req.providerConsoleContext));
  cluster.subscribe('provider-console:lock', payload => terminateSessions({
    hostId: payload?.hostId ?? null,
    resourceId: payload?.resourceId ?? null,
    reason: payload?.reason || 'Console access locked by an administrator',
  }));
  log.info('Provider console gateway attached', { path: PATH });
  return wss;
}

module.exports = {
  PATH, attach, terminateSessions, getActiveSessions,
  _internals: {
    active, _cookie, _protocols, _launchToken, _originAllowed, _canOperate,
    _connectionCapacity, _waitForAttach, _forward, _bridgeRfb, _bridgeSerial,
    reset() { active.clear(); wss = null; },
  },
};
