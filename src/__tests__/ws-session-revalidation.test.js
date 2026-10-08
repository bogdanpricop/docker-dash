'use strict';
Object.assign(process.env, { APP_ENV: 'test', DB_PATH: ':memory:', APP_SECRET: 'ws-revalidation-fixture', ENCRYPTION_KEY: 'ws-revalidation-encryption-key-32', BCRYPT_ROUNDS: '4' });
jest.mock('../services/cluster', () => ({ publish: jest.fn(async () => {}), subscribe: jest.fn(), onBecomeLeader: jest.fn(), onBecomeReader: jest.fn(), isHa: () => false, nodeId: () => 'fixture' }));
jest.mock('../services/docker', () => ({ inspectContainer: jest.fn(), createExec: jest.fn(), getDocker: jest.fn() }));
jest.mock('../services/terminal-access', () => ({ effective: () => ({ locked: false, hostId: 1 }) }));
jest.mock('../services/permissions', () => ({ getEffectiveRole: () => 'admin', hasPermission: () => true }));
jest.mock('../services/audit', () => ({ log: jest.fn() }));
const mockSshClients = [];
jest.mock('ssh2', () => {
  const { EventEmitter } = require('events');
  return { Client: class extends EventEmitter {
    constructor() { super(); this.end = jest.fn(); this.connect = jest.fn(); this.shell = jest.fn(); mockSshClients.push(this); }
  } };
});
const { EventEmitter } = require('events'), crypto = require('crypto');
const { getDb } = require('../db'), auth = require('../services/auth'), docker = require('../services/docker');
const { sha256 } = require('../utils/crypto'), { WsServer } = require('../ws');
let db, id, server;
beforeAll(() => {
  db = getDb(); id = Number(db.prepare("INSERT INTO users(username,password_hash,role,is_active,must_change_password) VALUES ('ws-fixture','old-hash','admin',1,0)").run().lastInsertRowid);
});
beforeEach(() => {
  jest.clearAllMocks(); mockSshClients.length=0; server = new WsServer();
  db.exec('DELETE FROM sessions');
  db.prepare("UPDATE users SET role='admin',is_active=1,must_change_password=0 WHERE id=?").run(id);
  docker.inspectContainer.mockResolvedValue({ Config: { Labels: {} } });
});
afterEach(() => { for (const ws of server.clients.keys()) server._cleanupClient(ws); jest.restoreAllMocks(); });
function connect() {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,datetime('now','+1 day'))").run(sha256(token),id);
  const send = jest.fn(), ws = { readyState: 1, send, close: jest.fn(), terminate: jest.fn() };
  const client = { user: auth.validateSession(token), sessionHash: sha256(token), logStreams: new Map(), subscriptions: new Set(), msgCount: 0, msgResetTime: Date.now() };
  server.clients.set(ws,client); server._bindSession(ws,client);
  return { token, ws, client, send };
}
function stream() { const value = new EventEmitter(); value.destroy = jest.fn(() => value.emit('close')); value.write = jest.fn(); value.close = jest.fn(() => value.emit('close')); return value; }
function deferred() { let resolve; const promise = new Promise(r => { resolve=r; }); return { promise, resolve }; }

test.each(['logout','password-reset','expired','disabled','role','forced-password','storage'])('%s closes streams and refuses input/output on an existing connection', async kind => {
  const {token,ws,client,send}=connect();
  const exec=stream(),logs=stream(),ssh=stream(),conn={end:jest.fn()};
  Object.assign(client,{execStream:exec,sshStream:ssh,sshConn:conn}); client.logStreams.set('fixture',logs);
  if(kind==='logout') auth.logout(token);
  if(kind==='password-reset') await auth.resetPassword(id,'NewFixturePass123!');
  if(kind==='expired') db.prepare("UPDATE sessions SET expires_at=datetime('now','-1 second')").run();
  if(kind==='disabled') db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(id);
  if(kind==='role') db.prepare("UPDATE users SET role='viewer' WHERE id=?").run(id);
  if(kind==='forced-password') db.prepare('UPDATE users SET must_change_password=1 WHERE id=?').run(id);
  if(kind==='storage') jest.spyOn(auth,'validateSessionHash').mockImplementation(()=>{throw Error('fixture storage outage');});
  await server._handleMessage(ws,Buffer.from(JSON.stringify({type:'exec:input',data:'whoami\n'})));
  ws.send(JSON.stringify({type:'exec:output',data:'private'}));
  expect(exec.write).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  expect(exec.destroy).toHaveBeenCalledTimes(1); expect(logs.destroy).toHaveBeenCalledTimes(1);
  expect(ssh.close).toHaveBeenCalledTimes(1); expect(conn.end).toHaveBeenCalledTimes(1);
  expect(ws.close).toHaveBeenCalledWith(4003,'Session no longer valid'); expect(server.clients.size).toBe(0);
});

test('revocation blocks a broadcast without waiting for client input or the periodic sweep', () => {
  const {token,send}=connect(); auth.logout(token);
  server._localBroadcastAll('private',{value:'secret'});
  expect(send).not.toHaveBeenCalled(); expect(server.clients.size).toBe(0);
});

test('periodic sweep removes idle revoked clients and leaves a valid session active', () => {
  const a=connect(),b=connect(); auth.logout(a.token); server._revalidateSessions();
  expect(server.clients.has(a.ws)).toBe(false); expect(server.clients.has(b.ws)).toBe(true);
  expect(b.ws.close).not.toHaveBeenCalled();
});

test.each(['inspect','create','start','resize'])('revocation during exec %s cannot attach a late terminal', async phase => {
  const {token,ws,send,client}=connect(), held=deferred(), output=stream();
  const exec={start:jest.fn(async()=>output),resize:jest.fn(async()=>{})};
  docker.createExec.mockResolvedValue(exec);
  if(phase==='inspect') docker.inspectContainer.mockReturnValue(held.promise);
  if(phase==='create') docker.createExec.mockReturnValue(held.promise);
  if(phase==='start') exec.start.mockReturnValue(held.promise);
  if(phase==='resize') exec.resize.mockReturnValue(held.promise);
  const started=server.startExec(ws,'fixture','/bin/sh',80,24,1);
  for(let i=0;i<5;i++) await Promise.resolve();
  auth.logout(token); server._revalidateSessions();
  held.resolve(phase==='inspect'?{Config:{Labels:{}}}:phase==='create'?exec:phase==='start'?output:undefined);
  await started;
  expect(client.execStream || null).toBeNull(); expect(send).not.toHaveBeenCalled();
  if(['start','resize'].includes(phase)) expect(output.destroy).toHaveBeenCalled();
  else expect(exec.start).not.toHaveBeenCalled();
});

test('concurrent exec startup is bounded and the next successful start closes the previous stream', async () => {
  const {ws}=connect(),held=deferred(),first=stream(),second=stream();
  docker.createExec.mockReturnValueOnce(held.promise);
  const pending=server.startExec(ws,'one'); await Promise.resolve();
  await server.startExec(ws,'two'); expect(docker.createExec).toHaveBeenCalledTimes(1);
  held.resolve({start:async()=>first,resize:async()=>{}}); await pending;
  docker.createExec.mockResolvedValue({start:async()=>second,resize:async()=>{}});
  await server.startExec(ws,'two'); expect(first.destroy).toHaveBeenCalledTimes(1);
  expect(server.clients.get(ws).execStream).toBe(second);
});

test('late log stream is destroyed when logout happens during Docker logs startup', async () => {
  const {token,ws,client,send}=connect(),held=deferred(),logs=stream();
  docker.getDocker.mockReturnValue({getContainer:()=>({logs:()=>held.promise})});
  const pending=server._subscribeClientLogs(ws,client,{containerId:'fixture',hostId:1,tail:10});
  for(let i=0;i<4;i++) await Promise.resolve();
  auth.logout(token); server._revalidateSessions(); held.resolve(logs); await pending;
  expect(logs.destroy).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
});

test.each(['ready','shell'])('late SSH %s callback closes the connection without granting a console', async phase => {
  const {token,ws,send}=connect();
  const hostId=db.prepare("INSERT INTO docker_hosts(name,connection_type,daemon_type,daemon_config) VALUES ('ws-ssh','ssh','vsphere',?)")
    .run(JSON.stringify({sshConfig:{host:'fixture.invalid',user:'fixture',password:'fixture',hostKeySha256:'ab'.repeat(32)}})).lastInsertRowid;
  await server.startVsphereSsh(ws,hostId);
  const conn=mockSshClients[0],output=stream();
  if(phase==='shell') conn.emit('ready');
  auth.logout(token); server._revalidateSessions();
  if(phase==='ready') { conn.emit('ready'); expect(conn.shell).not.toHaveBeenCalled(); }
  else { conn.shell.mock.calls[0][1](null,output); expect(output.close).toHaveBeenCalled(); }
  expect(conn.end).toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
});

test.each(['input','broadcast'])('real WebSocket blocks %s after logout and keeps only the session digest', async direction => {
  const http = require('http').createServer(), WebSocket = require('ws');
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,datetime('now','+1 day'))").run(sha256(token),id);
  server.attach(http); await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  const socket = new WebSocket('ws://127.0.0.1:'+http.address().port+'/ws', {
    headers: { Cookie: require('../config').session.cookieName+'='+token },
  });
  const messages=[]; socket.on('message',data=>messages.push(JSON.parse(data)));
  const closed = new Promise(resolve=>socket.once('close',code=>resolve(code)));
  try {
    await new Promise((resolve,reject)=>{socket.once('message',resolve);socket.once('error',reject);});
    expect([...server.clients.values()][0].sessionHash).toBe(sha256(token));
    expect(JSON.stringify([...server.clients.values()])).not.toContain(token);
    auth.logout(token);
    if(direction==='input') socket.send(JSON.stringify({type:'ping'}));
    else server._localBroadcastAll('private',{secret:'not-delivered'});
    let timeout;
    try { expect(await Promise.race([closed,new Promise(resolve=>{timeout=setTimeout(()=>resolve('not-closed'),1000);})])).toBe(4003); }
    finally { clearTimeout(timeout); }
    expect(messages.map(message=>message.type)).toEqual(['connected']);
  } finally {
    socket.terminate();
    for(const ws of server.wss.clients) ws.terminate();
    await new Promise(resolve=>server.wss.close(resolve));
    await new Promise(resolve=>http.close(resolve));
  }
});
