'use strict';
const assert=require('node:assert/strict'),https=require('node:https'),fs=require('node:fs');
const {fetchJson,MAX_BYTES,MAX_IN_FLIGHT,DEADLINE_MS}=require('/app/src/utils/oidc-http');
const fixture=name=>fs.readFileSync('/app/src/__tests__/fixtures/provider-tls/'+name);
async function main() {
 const checks=[],held=[],timers=new Set();let redirectTarget=0,slowChunks=0,slowClosed=false,wrongRequests=0;
 const server=https.createServer({key:fixture('server.key'),cert:fixture('server.pem')},(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/large'){res.end(JSON.stringify({value:'x'.repeat(MAX_BYTES)}));return;}
  if(req.url==='/redirect'){res.writeHead(302,{Location:'/target'});res.end('{}');return;}
  if(req.url==='/target')redirectTarget++;
  if(req.url==='/slow'){
   res.write('{"value":"');const timer=setInterval(()=>{slowChunks++;res.write('x');},200);timers.add(timer);
   res.on('close',()=>{clearInterval(timer);timers.delete(timer);slowClosed=true;});return;
  }
  if(req.url==='/hold'){held.push(res);return;}
  const body=Buffer.from('{"name":"é"}'),split=body.indexOf(0xc3)+1;res.write(body.subarray(0,split));res.end(body.subarray(split));
 });
 const wrong=https.createServer({key:fixture('server.key'),cert:fixture('wrong-name.pem')},(_req,res)=>{wrongRequests++;res.end('{}');});
 wrong.on('tlsClientError',()=>{});
 await Promise.all([server,wrong].map(s=>new Promise(resolve=>s.listen(0,'127.0.0.1',resolve))));
 const base='https://127.0.0.1:'+server.address().port;
 const waitUntil=async condition=>{const end=Date.now()+2000;while(!condition()){assert.ok(Date.now()<end,'fixture observation timeout');await new Promise(resolve=>setTimeout(resolve,10));}};
 try {
  assert.deepEqual((await fetchJson(base)).body,{name:'é'});checks.push('native-oidc-verified-tls-and-split-utf8');
  await assert.rejects(fetchJson(base+'/large'),/too large/);checks.push('native-oidc-chunked-response-byte-limit');
  await assert.rejects(fetchJson(base+'/redirect'),/status/);assert.equal(redirectTarget,0);checks.push('native-oidc-redirect-not-followed');
  await assert.rejects(fetchJson('https://127.0.0.1:'+wrong.address().port),/request failed/);assert.equal(wrongRequests,0);checks.push('native-oidc-wrong-certificate-denied-before-http');
  const pending=Array.from({length:MAX_IN_FLIGHT},()=>fetchJson(base+'/hold'));const all=Promise.all(pending);
  await waitUntil(()=>held.length===MAX_IN_FLIGHT);await assert.rejects(fetchJson(base),/busy/);
  for(const res of held)res.end('{}');await all;assert.equal((await fetchJson(base)).status,200);checks.push('native-oidc-concurrency-cap-and-slot-recovery');
  const start=performance.now();await assert.rejects(fetchJson(base+'/slow'),/deadline/);const elapsed=performance.now()-start;
  assert.ok(elapsed>=DEADLINE_MS-250&&elapsed<DEADLINE_MS+2500);assert.ok(slowChunks>5);await waitUntil(()=>slowClosed);
  checks.push('native-oidc-active-stream-stopped-at-absolute-deadline');
  console.log(JSON.stringify({checks,elapsedDeadlineMs:Math.round(elapsed)}));
 } finally {
  for(const timer of timers)clearInterval(timer);
  for(const s of [server,wrong]){s.closeAllConnections();await new Promise(resolve=>s.close(resolve));}
 }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
