'use strict';

// Runs only an isolated container from an already-built image: no Docker socket,
// host mounts, published ports or external network. Requires Docker access.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Writable } = require('node:stream');
const Docker = require('dockerode');
const url = process.env.DD_SMOKE_DOCKER_URL ? new URL(process.env.DD_SMOKE_DOCKER_URL) : null;
const docker = new Docker(url ? { host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
  protocol: url.protocol.slice(0, -1), timeout: 30000 } : { socketPath: '/var/run/docker.sock', timeout: 30000 });
const run = `dd-production-smoke-${crypto.randomBytes(6).toString('hex')}`;

async function execute(container, code, env = [], throughEntrypoint = false) {
  const command = await container.exec({ Cmd: [...(throughEntrypoint ? ['/app/entrypoint.sh'] : []), 'node', '-e', code],
    Env: env, AttachStdout: true, AttachStderr: true });
  const stream = await command.start({});
  let output = '';
  const sink = new Writable({ write(chunk, encoding, callback) {
    output += chunk.toString(); callback(output.length > 65536 ? new Error('Smoke output too large') : null);
  } });
  await new Promise((resolve, reject) => {
    sink.on('error', reject); stream.on('error', reject); stream.on('end', resolve);
    docker.modem.demuxStream(stream, sink, sink);
  });
  assert.equal((await command.inspect()).ExitCode, 0, 'Production smoke command failed');
  return output.trim();
}

async function ready(container) {
  await execute(container, `let n=0;async function check(){try{
    const r=await fetch('http://127.0.0.1:8101/api/health',{signal:AbortSignal.timeout(1000)});
    if(r.status===200&&(await r.json()).status==='ok')process.exit(0);
  }catch{}if(++n>100)process.exit(1);setTimeout(check,200)}check()`);
}

const snapshot = `const fs=require('fs'),crypto=require('crypto'),assert=require('assert/strict');
  const file='/data/.env',data=require('dotenv').parse(fs.readFileSync(file));
  for(const k of ['APP_SECRET','ENCRYPTION_KEY'])assert.match(data[k],/^[a-f0-9]{64}$/);
  assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(fs.existsSync(file+'.bak'),false);
  console.log(crypto.createHash('sha256').update(data.APP_SECRET+'|'+data.ENCRYPTION_KEY).digest('hex'))`;

async function main() {
  assert.ok(process.env.DD_SMOKE_APP_IMAGE, 'Set DD_SMOKE_APP_IMAGE to an already-built image');
  const container = await docker.createContainer({
    name: run, Image: process.env.DD_SMOKE_APP_IMAGE, Labels: { 'com.docker-dash.smoke': run },
    Env: ['APP_ENV=production', 'APP_PORT=8101', 'LOG_LEVEL=error', 'DOCKER_SOCKET=/nonexistent/docker.sock',
      `ADMIN_PASSWORD=${crypto.randomBytes(32).toString('hex')}`],
    HostConfig: { NetworkMode: 'none', Memory: 536870912, NanoCpus: 1000000000, PidsLimit: 128,
      CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'] },
  });
  try {
    await container.start(); await ready(container);
    const first = await execute(container, snapshot);
    console.log('PASS production startup, native SQLite migrations and HTTP health');
    await execute(container, `const cp=require('child_process'),assert=require('assert/strict');
      assert.match(cp.execFileSync('docker',['--version'],{encoding:'utf8',timeout:10000}),/Docker version 29\\.7\\.2\\+dd\\.1,/);
      assert.equal(cp.execFileSync('docker',['compose','version','--short'],{encoding:'utf8',timeout:10000}).trim(),'5.5.1');
      const input='services:\\n  smoke:\\n    image: alpine:3.24\\n    read_only: true\\n    cap_drop: [ALL]\\n';
      const result=JSON.parse(cp.execFileSync('docker',['compose','-f','-','config','--format','json'],{input,encoding:'utf8',timeout:10000}));
      assert.equal(result.services.smoke.read_only,true);assert.deepEqual(result.services.smoke.cap_drop,['ALL']);
      cp.execFileSync('curl',['--fail','--silent','--max-time','4','http://localhost:8101/api/health'],{timeout:5000});`);
    console.log('PASS pinned Compose plugin parses configuration offline and curl health probe succeeds');
    await execute(container, `
      const assert=require('node:assert/strict'),fs=require('node:fs'),{Server,utils}=require('ssh2');
      const git=require('simple-git'),{createSession}=require('./src/utils/git-ssh');
      const {generateKeyPair}=require('./src/services/ssh-keygen');
      const host=generateKeyPair({type:'ed25519'}),identity=generateKeyPair({type:'ed25519'});
      const expected=utils.parseKey(identity.privateKey),clients=new Set();let auth=0,commands=0;
      const server=new Server({hostKeys:[host.privateKey]},client=>{
        clients.add(client);client.on('close',()=>clients.delete(client));client.on('error',()=>{});
        client.on('authentication',ctx=>{auth++;
          if(ctx.method==='publickey'&&ctx.key.data.equals(expected.getPublicSSH())&&
            (!ctx.signature||expected.verify(ctx.blob,ctx.signature,ctx.hashAlgo)))ctx.accept();
          else ctx.reject(['publickey']);
        });
        client.on('ready',()=>client.on('session',accept=>accept().on('exec',(acceptExec,reject,info)=>{
          if(info.command!=="git-upload-pack '/fixture.git'")return reject();
          commands++;const ch=acceptExec();ch.write('0000');ch.exit(0);ch.end();
        })));
      });
      (async()=>{
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        const port=server.address().port,url='ssh://fixture@127.0.0.1:'+port+'/fixture.git';
        try{
          for(const trusted of [true,false]){
            auth=0;commands=0;
            const pub=(trusted?host:identity).publicKey.split(' ').slice(0,2).join(' ');
            const session=createSession({privateKey:identity.privateKey,knownHosts:'[127.0.0.1]:'+port+' '+pub});
            try{
              assert.equal(fs.statSync(session.directory).mode&0o777,0o700);
              assert.equal(fs.statSync(session.directory+'/identity').mode&0o777,0o600);
              const probe=git({timeout:{block:15000},unsafe:{allowUnsafeSshCommand:true,allowUnsafeConfigPaths:true}})
                .env(session.env).listRemote(['--heads',url]);
              if(trusted){assert.equal(await probe,'');assert.ok(auth>0);assert.equal(commands,1);}
              else{await assert.rejects(probe,/HOST IDENTIFICATION HAS CHANGED/);assert.equal(auth,0);assert.equal(commands,0);}
            }finally{session.dispose();}
            assert.equal(fs.existsSync(session.directory),false);
          }
        }finally{for(const client of clients)client.end();await new Promise(resolve=>server.close(resolve));}
      })().catch(error=>{console.error(error);process.exitCode=1;});
    `);
    console.log('PASS real Linux Git/OpenSSH verifies server identity before authentication and removes private session files');
    await execute(container, `
      const assert=require('node:assert/strict'),fs=require('node:fs'),https=require('node:https');
      const fixture=file=>fs.readFileSync('/app/src/__tests__/fixtures/provider-tls/'+file,'utf8');
      const {IncusClient}=require('./src/services/incus');
      const ca=fixture('ca.pem');let received=0;
      const server=https.createServer({key:fixture('server.key'),cert:fixture('server.pem'),
        ca,requestCert:true,rejectUnauthorized:true},(req,res)=>{
          received++;assert.equal(req.socket.authorized,true);res.end(JSON.stringify({metadata:{ok:true}}));
        });
      server.on('tlsClientError',()=>{});
      (async()=>{
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        const endpoint='https://127.0.0.1:'+server.address().port;
        try{
          for(const trusted of [true,false]){
            received=0;
            const client=new IncusClient({transport:'https',endpoint,cert:fixture('client.pem'),key:fixture('client.key'),
              caCert:trusted?ca:fixture('wrong-ca.pem')});
            try{
              if(trusted){assert.deepEqual((await client.info()).metadata,{ok:true});assert.equal(received,1);}
              else{await assert.rejects(client.info(),/certificate/i);assert.equal(received,0);}
            }finally{client._agent.destroy();}
          }
        }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
      })().catch(error=>{console.error(error);process.exitCode=1;});
    `, [], true);
    console.log('PASS Linux provider mTLS accepts verified private CA and rejects wrong CA before HTTP authentication');
    await execute(container, `
      const assert=require('node:assert/strict');
      const ldap=require('./src/services/ldap');
      const {createLdapServer,fixture}=require('./src/__tests__/helpers/ldap-server');
      (async()=>{
        for(const ldaps of [false,true]){
          const server=await createLdapServer({ldaps});
          const cfg={host:'127.0.0.1',port:server.port,tls:ldaps,caCert:fixture('ca.pem'),
            bindDn:'cn=service,dc=fixture',bindPassword:'service-password',baseDn:'dc=fixture'};
          try{
            assert.equal((await ldap.testConnection(cfg)).ok,true);
            assert.equal(server.binds.length,1);assert.equal(server.binds[0].encrypted,true);
            await assert.rejects(ldap.testConnection({...cfg,caCert:fixture('wrong-ca.pem')}),/certificate/i);
            assert.equal(server.binds.length,1);
          }finally{await server.close();}
        }
      })().catch(error=>{console.error(error);process.exitCode=1;});
    `, [], true);
    console.log('PASS Linux LDAP StartTLS and LDAPS verify certificates before bind and reject wrong CA without sending passwords');
    await execute(container, `
      const assert=require('node:assert/strict'),fs=require('node:fs'),Database=require('better-sqlite3');
      const history=require('./src/services/container-history');
      const migration=require('./src/db/migrations/176_encrypt_rollback_snapshots');
      const db=new Database(':memory:');require('./src/db/migrations/026_rollback_history').up(db);
      const legacy=JSON.stringify({Env:['TOKEN=public-migration-fixture']});
      db.prepare("INSERT INTO container_image_history(container_name,container_id,image_name,image_id,config_snapshot) VALUES ('fixture','fixture','fixture','fixture',?)").run(legacy);
      db.transaction(()=>migration.up(db))();
      const row=db.prepare('SELECT * FROM container_image_history').get();
      assert.ok(!row.config_snapshot.includes('public-migration-fixture'));
      assert.deepEqual(history.readSnapshot(row).Env,['TOKEN=public-migration-fixture']);db.close();
      const id=history.record({inspect:{Name:'/history-smoke',Id:'history-smoke-id',Image:'sha256:history-smoke',
        Config:{Image:'smoke:fixture',Env:['TOKEN=public-restart-fixture']},State:{Running:false},HostConfig:{}},action:'smoke'});
      fs.writeFileSync('/data/history-smoke-id',String(id));
    `, [], true);
    console.log('PASS Linux SQLite migration encrypts existing rollback snapshots and preserves recovery');
    await container.restart({ t: 10 }); await ready(container);
    assert.equal(await execute(container, snapshot), first, 'Restart changed persisted encryption/session secrets');
    await execute(container, `const assert=require('node:assert/strict'),fs=require('node:fs');
      const db=require('./src/db').getDb(),history=require('./src/services/container-history');
      const row=db.prepare('SELECT * FROM container_image_history WHERE id=?').get(Number(fs.readFileSync('/data/history-smoke-id','utf8')));
      assert.ok(!row.config_snapshot.includes('public-restart-fixture'));
      assert.deepEqual(history.readSnapshot(row).Env,['TOKEN=public-restart-fixture']);
      assert.throws(()=>history.readSnapshot({...row,host_id:99}),/identity mismatch/);
    `, [], true);
    console.log('PASS encrypted rollback snapshot survives restart and rejects another host identity');
    console.log('PASS generated secrets persist across restart with mode 0600 and no backup copy');
    // Verify dotenv is parsed as data, including command-like quoted values.
    await execute(container, `require('fs').writeFileSync('/data/quoted.env',
      'APP_SECRET="literal-$(touch /data/shell-executed)-secret"\\nENCRYPTION_KEY="persisted-key-with-spaces-and-32-chars"\\n',{mode:0o600})`);
    await execute(container, `const assert=require('assert/strict'),fs=require('fs');
      assert.equal(process.env.APP_SECRET,'literal-$(touch /data/shell-executed)-secret');
      assert.equal(process.env.ENCRYPTION_KEY,'persisted-key-with-spaces-and-32-chars');
      assert.equal(fs.existsSync('/data/shell-executed'),false)`,
    ['ENV_FILE=/data/quoted.env', 'APP_SECRET=', 'ENCRYPTION_KEY='], true);
    console.log('PASS quoted persisted secrets are read without shell execution');
    await execute(container, `const assert=require('assert/strict');assert.equal(process.env.APP_SECRET,'explicit-env-secret');
      assert.equal(process.env.ENCRYPTION_KEY,'explicit-env-key')`,
    ['ENV_FILE=/data/quoted.env', 'APP_SECRET=explicit-env-secret', 'ENCRYPTION_KEY=explicit-env-key'], true);
    console.log('PASS explicit environment secrets retain precedence');
  } finally {
    const info = await container.inspect();
    assert.equal(info.Config.Labels['com.docker-dash.smoke'], run, 'Refuse cleanup of unrelated container');
    await container.remove({ force: true, v: true });
    console.log(`Cleaned up ${run}`);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
