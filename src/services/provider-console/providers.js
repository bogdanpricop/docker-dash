'use strict';

const tls = require('tls');
const WebSocket = require('ws');
const proxmox = require('../proxmox');
const vsphere = require('../vsphere');
const xen = require('../xen');

const CONNECT_TIMEOUT_MS = 15_000;
const MAX_CONNECT_HEADERS = 32 * 1024;

function _openWebSocket(url, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url, ['binary'], {
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      perMessageDeflate: false,
      maxPayload: 2 * 1024 * 1024,
      ...options,
    });
    const finish = (value, err) => {
      if (settled) return;
      settled = true;
      ws.off('open', onOpen);
      ws.off('error', onError);
      if (err) {
        try { ws.terminate(); } catch {}
        reject(err);
      } else resolve(value);
    };
    const onOpen = () => finish(ws);
    const onError = err => finish(null, err);
    ws.once('open', onOpen);
    ws.once('error', onError);
  });
}

function _parseProxmoxTarget(session) {
  const native = String(session.identity.nativeRef || '');
  const match = /^(qemu|lxc)\/(\d+)$/.exec(native);
  const fallbackId = /^\d+$/.test(native) ? Number(native) : null;
  const guestType = match?.[1] || (session.resource?.extensions?.guestType === 'lxc' ? 'lxc' : 'qemu');
  const vmid = match ? Number(match[2]) : fallbackId;
  const node = session.resource?.extensions?.node || null;
  if (!vmid) throw Object.assign(new Error('Proxmox VM console identity is invalid'), {
    code: 'INVALID_PROVIDER_RESOURCE', status: 409,
  });
  return { guestType, vmid, node };
}

async function _openProxmox(session) {
  const client = proxmox.fromHostRow(session.host);
  try {
    let target = _parseProxmoxTarget(session);
    if (!target.node) {
      const rows = await client.listVMs();
      const current = rows.find(row => Number(row.vmid) === target.vmid && (row.type || 'qemu') === target.guestType);
      target = { ...target, node: current?.node || null };
    }
    if (!target.node) throw Object.assign(new Error('Proxmox VM node placement is unavailable'), {
      code: 'CONSOLE_PLACEMENT_UNAVAILABLE', status: 409,
    });
    const ticket = await client.createVmConsoleProxy(target.node, target.guestType, target.vmid);
    const descriptor = client.vmConsoleWebSocket(ticket);
    const socket = await _openWebSocket(descriptor.url, {
      headers: descriptor.headers, agent: descriptor.agent,
    });
    return {
      protocol: 'rfb', socket, password: descriptor.password,
      close: () => { try { socket.close(); } catch {} client._agent?.destroy?.(); },
    };
  } catch (err) {
    client._agent?.destroy?.();
    throw err;
  }
}

async function _openVsphere(session) {
  const client = vsphere.fromHostRow(session.host);
  try {
    await client.login();
    const descriptor = await client.acquireVmConsoleTicket(session.identity.nativeRef);
    const socket = await _openWebSocket(descriptor.url, { agent: descriptor.agent });
    return {
      protocol: 'rfb', socket,
      close: () => {
        try { socket.close(); } catch {}
        Promise.resolve(client.logout()).catch(() => {}).finally(() => client._agent?.destroy?.());
      },
    };
  } catch (err) {
    try { await client.logout(); } catch {}
    client._agent?.destroy?.();
    throw err;
  }
}

async function _openXo(session, client) {
  const descriptor = client.vmConsoleProxy(session.identity.nativeRef);
  const socket = await _openWebSocket(descriptor.url, {
    headers: descriptor.headers,
    rejectUnauthorized: descriptor.rejectUnauthorized,
    ...(descriptor.ca ? { ca: descriptor.ca } : {}),
  });
  return { protocol: 'rfb', socket, close: () => { try { socket.close(); } catch {} } };
}

function _openXapiConnect(descriptor) {
  const url = new URL(descriptor.location);
  return new Promise((resolve, reject) => {
    let settled = false;
    let headers = Buffer.alloc(0);
    const socket = tls.connect({
      host: url.hostname, port: Number(url.port) || 443,
      servername: url.hostname,
      rejectUnauthorized: descriptor.rejectUnauthorized,
      ...(descriptor.ca ? { ca: descriptor.ca } : {}),
    });
    const timer = setTimeout(() => finish(null, Object.assign(new Error('XAPI console connection timed out'), {
      code: 'CONSOLE_CONNECT_TIMEOUT', status: 504,
    })), CONNECT_TIMEOUT_MS);
    const finish = (value, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('error', onError);
      socket.off('data', onHeaders);
      if (err) {
        try { socket.destroy(); } catch {}
        reject(err);
      } else resolve(value);
    };
    const onError = err => finish(null, err);
    const onHeaders = chunk => {
      headers = Buffer.concat([headers, chunk]);
      if (headers.length > MAX_CONNECT_HEADERS) {
        return finish(null, Object.assign(new Error('XAPI console returned oversized headers'), {
          code: 'INVALID_CONSOLE_RESPONSE', status: 502,
        }));
      }
      const end = headers.indexOf('\r\n\r\n');
      if (end < 0) return;
      const firstLine = headers.subarray(0, end).toString('latin1').split('\r\n')[0];
      if (!/^HTTP\/1\.[01] 2\d\d\b/.test(firstLine)) {
        return finish(null, Object.assign(new Error('XAPI console CONNECT was rejected'), {
          code: 'CONSOLE_CONNECT_REJECTED', status: 502,
        }));
      }
      const remainder = headers.subarray(end + 4);
      if (remainder.length) socket.unshift(remainder);
      finish(socket);
    };
    socket.once('error', onError);
    socket.on('data', onHeaders);
    socket.once('secureConnect', () => {
      socket.write([
        `CONNECT ${url.pathname}${url.search} HTTP/1.0`,
        `Host: ${url.host}`,
        `Cookie: session_id=${encodeURIComponent(descriptor.sessionId)}`,
        '', '',
      ].join('\r\n'));
    });
  });
}

async function _openXapi(session, client) {
  const descriptor = await client.getVmConsole(session.identity.nativeRef);
  const wsUrl = new URL(descriptor.location);
  wsUrl.protocol = 'wss:';
  try {
    const socket = await _openWebSocket(wsUrl.href, {
      headers: { Cookie: `session_id=${encodeURIComponent(descriptor.sessionId)}` },
      rejectUnauthorized: descriptor.rejectUnauthorized,
      ...(descriptor.ca ? { ca: descriptor.ca } : {}),
    });
    return { protocol: descriptor.protocol, socket, close: () => { try { socket.close(); } catch {} } };
  } catch {
    const socket = await _openXapiConnect(descriptor);
    return { protocol: descriptor.protocol, socket, close: () => { try { socket.destroy(); } catch {} } };
  }
}

async function _openXen(session) {
  const client = xen.clientForHost(session.host);
  if (client.provider === 'xo') return _openXo(session, client);
  if (client.provider === 'xapi') return _openXapi(session, client);
  return client.openConsole(session.identity.nativeRef);
}

async function openForSession(session) {
  if (session.host.daemon_type === 'proxmox') return _openProxmox(session);
  if (session.host.daemon_type === 'vsphere') return _openVsphere(session);
  if (session.host.daemon_type === 'xen') return _openXen(session);
  throw Object.assign(new Error('Provider console adapter is unavailable'), {
    code: 'PROVIDER_CONSOLE_UNAVAILABLE', status: 400,
  });
}

module.exports = {
  openForSession,
  _internals: {
    _openWebSocket, _parseProxmoxTarget, _openProxmox, _openVsphere,
    _openXo, _openXapi, _openXapiConnect,
  },
};
