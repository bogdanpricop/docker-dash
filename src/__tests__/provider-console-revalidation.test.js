'use strict';
Object.assign(process.env, { APP_ENV: 'test', DB_PATH: ':memory:', APP_SECRET: 'console-session-fixture', ENCRYPTION_KEY: 'console-session-fixture-key', BCRYPT_ROUNDS: '4' });
jest.mock('../services/cluster', () => ({ subscribe: jest.fn() }));
jest.mock('../services/audit', () => ({ log: jest.fn() }));
jest.mock('../services/provider-console/providers', () => ({ openForSession: jest.fn() }));
jest.mock('../services/provider-console/access', () => ({ effective: jest.fn() }));
jest.mock('../services/host-permissions', () => ({ resolveEffectivePermission: jest.fn() }));
jest.mock('../services/provider-console/broker', () => ({ TOKEN_RE: /^[A-Za-z0-9_-]{43}$/, consume: jest.fn(), markClosed: jest.fn(), markConnected: jest.fn() }));
const { EventEmitter } = require('events');
const { randomBytes } = require('crypto');
const { getDb } = require('../db');
const auth = require('../services/auth');
const { sha256 } = require('../utils/crypto');
const gateway = require('../services/provider-console/gateway');
const providers = require('../services/provider-console/providers');
const access = require('../services/provider-console/access');
const permissions = require('../services/host-permissions');
const broker = require('../services/provider-console/broker');
const audit = require('../services/audit');
const config = require('../config');
let db, id;
beforeAll(() => {
  db = getDb();
  id = Number(db.prepare("INSERT INTO users(username,password_hash,role,is_active,must_change_password) VALUES ('console-user','old','operator',1,0)").run().lastInsertRowid);
});
beforeEach(() => {
  jest.clearAllMocks();
  db.exec('DELETE FROM sessions');
  db.prepare("UPDATE users SET role='operator',is_active=1,must_change_password=0 WHERE id=?").run(id);
  access.effective.mockReturnValue({ locked: false });
  permissions.resolveEffectivePermission.mockReturnValue('operate');
});
afterEach(() => {
  for (const item of [...gateway._internals.active.values()]) item.finalize('test_cleanup');
  gateway._internals.reset();
  jest.restoreAllMocks(); jest.useRealTimers();
});
function fixture(protocol = 'serial') {
  const token = randomBytes(32).toString('hex');
  db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,datetime('now','+1 day'))").run(sha256(token), id);
  const session = { id: randomBytes(8).toString('hex'), host_id: 1, resource_id: 'ddr_vm_' + 'a'.repeat(26), provider_type: 'proxmox' };
  const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const context = { session, user: auth.validateSession(token), sessionHash: sha256(token) };
  const ws = new EventEmitter(); ws.readyState = 1;
  ws.send = jest.fn((_data, options, callback) => { if (typeof options === 'function') options(); else callback?.(); });
  ws.close = jest.fn((code = 1000) => { if (ws.readyState !== 1) return; ws.readyState = 3; ws.emit('close', code); });
  const stream = new EventEmitter(); stream.write = jest.fn((_data, cb) => cb?.()); stream.destroy = jest.fn(() => stream.emit('close'));
  const upstream = { protocol, stream, socket: stream, close: jest.fn() };
  providers.openForSession.mockResolvedValue(upstream);
  return { token, session, req, context, ws, stream, upstream };
}
async function attached(f) {
  const started = gateway._internals._start(f.ws, f.req, f.context);
  await Promise.resolve();
  f.ws.emit('message', Buffer.from('{"type":"console:attach"}'), false);
  if (f.upstream.protocol === 'serial') await started;
  else await Promise.resolve();
  return { started };
}
function revoke(kind, f) {
  if (kind === 'logout') auth.logout(f.token);
  if (kind === 'expiry') db.prepare("UPDATE sessions SET expires_at=datetime('now','-1 second')").run();
  if (kind === 'disabled') db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(id);
  if (kind === 'role') db.prepare("UPDATE users SET role='admin' WHERE id=?").run(id);
  if (kind === 'password') db.prepare('UPDATE users SET must_change_password=1 WHERE id=?').run(id);
  if (kind === 'permission') permissions.resolveEffectivePermission.mockReturnValue('view');
  if (kind === 'lock') access.effective.mockReturnValue({ locked: true });
  if (kind === 'storage') {
    jest.spyOn(auth, 'validateSessionHash').mockImplementation(() => { throw Error('offline'); });
    broker.markClosed.mockImplementationOnce(() => { throw Error('offline'); });
    audit.log.mockImplementationOnce(() => { throw Error('offline'); });
  }
}
test.each(['logout','expiry','disabled','role','password','permission','lock','storage'])('%s blocks serial input and output and closes the upstream', async kind => {
  const f = fixture(); await attached(f);
  f.ws.emit('message', Buffer.from('allowed'), true);
  expect(f.stream.write).toHaveBeenCalledWith(Buffer.from('allowed'), expect.any(Function));
  f.stream.write.mockClear(); f.ws.send.mockClear();
  revoke(kind, f);
  f.ws.emit('message', Buffer.from('denied'), true);
  f.stream.emit('data', Buffer.from('private'));
  expect(f.stream.write).not.toHaveBeenCalled(); expect(f.ws.send).not.toHaveBeenCalled();
  expect(f.ws.close).toHaveBeenCalledWith(4003, 'Console access no longer valid');
  expect(f.upstream.close).toHaveBeenCalledTimes(1); expect(gateway.getActiveSessions().count).toBe(0);
});
test('provider output checks logout without waiting for client input', async () => {
  const f = fixture(); await attached(f); f.ws.send.mockClear();
  auth.logout(f.token); f.stream.emit('data', Buffer.from('private'));
  expect(f.ws.send).not.toHaveBeenCalled(); expect(f.upstream.close).toHaveBeenCalledTimes(1);
});
test('idle sweep closes a revoked session and releases its timers', async () => {
  jest.useFakeTimers(); const f = fixture(); await attached(f); auth.logout(f.token);
  jest.advanceTimersByTime(5000);
  expect(f.upstream.close).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
});
test('late provider connection is closed after browser disconnect', async () => {
  const f = fixture(); let resolve;
  providers.openForSession.mockReturnValue(new Promise(r => { resolve = r; }));
  const started = gateway._internals._start(f.ws, f.req, f.context);
  f.ws.close(); resolve(f.upstream); await started;
  expect(f.upstream.close).toHaveBeenCalledTimes(1); expect(f.ws.send).not.toHaveBeenCalled();
});
test('revocation during provider opening refuses the late connection', async () => {
  const f = fixture(); let resolve;
  providers.openForSession.mockReturnValue(new Promise(r => { resolve = r; }));
  const started = gateway._internals._start(f.ws, f.req, f.context);
  auth.logout(f.token); resolve(f.upstream); await started;
  expect(f.upstream.close).toHaveBeenCalledTimes(1); expect(f.ws.send).not.toHaveBeenCalled();
});
test('revocation before attach prevents a connected record or relay', async () => {
  const f = fixture(); const started = gateway._internals._start(f.ws, f.req, f.context);
  await Promise.resolve(); auth.logout(f.token);
  f.ws.emit('message', Buffer.from('{"type":"console:attach"}'), false); await started;
  expect(broker.markConnected).not.toHaveBeenCalled(); expect(f.upstream.close).toHaveBeenCalledTimes(1);
});
test('RFB handshake channels are closed during idle revocation', async () => {
  jest.useFakeTimers(); const f = fixture('rfb'); const { started } = await attached(f);
  expect(f.stream.listenerCount('data')).toBe(1);
  auth.logout(f.token); jest.advanceTimersByTime(5000); await started;
  expect(f.stream.destroy).toHaveBeenCalled(); expect(f.stream.listenerCount('data')).toBe(0);
  expect(f.upstream.close).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
});
test('RFB bytes arriving after revocation never reach handshake writes', async () => {
  const f = fixture('rfb'); const { started } = await attached(f);
  auth.logout(f.token); f.stream.emit('data', Buffer.from('RFB 003.008\n'));
  await started; expect(f.stream.write).not.toHaveBeenCalled(); expect(f.upstream.close).toHaveBeenCalledTimes(1);
});
test('real provider-console socket stops forwarding after logout', async () => {
  const http = require('http'), WebSocket = require('ws');
  const f = fixture(); broker.consume.mockReturnValue(f.session);
  const server = http.createServer(); const wss = gateway.attach(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = `127.0.0.1:${server.address().port}`;
  const client = new WebSocket(`ws://${address}${gateway.PATH}`, ['binary', `dd-console.${'A'.repeat(43)}`], {
    headers: { origin: `http://${address}`, cookie: `${config.session.cookieName}=${f.token}` },
  });
  try {
    await new Promise((resolve, reject) => { client.once('message', resolve); client.once('error', reject); });
    client.send('{"type":"console:attach"}');
    while (!broker.markConnected.mock.calls.length) await new Promise(resolve => setTimeout(resolve, 5));
    const messages = []; client.on('message', data => messages.push(data.toString()));
    const closed = new Promise(resolve => client.once('close', resolve));
    auth.logout(f.token); f.stream.emit('data', Buffer.from('private'));
    let timer;
    try {
      expect(await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => resolve('not-closed'), 1000); })])).toBe(4003);
    } finally { clearTimeout(timer); }
    expect(messages).toEqual([]);
    expect(f.upstream.close).toHaveBeenCalledTimes(1);
  } finally {
    client.terminate(); for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve));
  }
});
test.each([['password', 401], ['storage', 503]])('handshake refuses %s before consuming a launch token', async (mode, status) => {
  const http = require('http'), WebSocket = require('ws');
  const f = fixture(); revoke(mode, f);
  const server = http.createServer(), wss = gateway.attach(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = `127.0.0.1:${server.address().port}`;
  const client = new WebSocket(`ws://${address}${gateway.PATH}`, ['binary', `dd-console.${'A'.repeat(43)}`], {
    headers: { origin: `http://${address}`, cookie: `${config.session.cookieName}=${f.token}` },
  });
  client.on('error', () => {});
  try {
    const response = await new Promise(resolve => client.once('unexpected-response', (_request, res) => { res.resume(); resolve(res.statusCode); }));
    expect(response).toBe(status); expect(broker.consume).not.toHaveBeenCalled();
    expect(providers.openForSession).not.toHaveBeenCalled();
  } finally {
    client.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve));
  }
});
