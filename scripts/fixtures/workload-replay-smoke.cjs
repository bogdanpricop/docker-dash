'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
module.exports=async(db,checks,raceRedeem)=>{
 const identity=require('/app/src/services/identity-governance'),config=require('/app/src/config');
 const keys=crypto.generateKeyPairSync('ec',{namedCurve:'P-256'}),actor={id:null,role:'admin'};
 const input={name:'native-workload',issuer:'https://workload.example.test',audience:'dashboard',subjectPattern:'job:*',
  identityKind:'oidc',jwks:{keys:[keys.publicKey.export({format:'jwk'})]},scopes:['api.read'],tokenTtlSeconds:300};
 const trust=identity.saveTrust(null,input,actor),now=Math.floor(Date.now()/1000);
 const sign=(jti,extra={})=>{
  const data=Buffer.from(JSON.stringify({alg:'ES256'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({
   iss:input.issuer,aud:input.audience,sub:'job:fixture',iat:now,exp:now+300,jti,...extra})).toString('base64url');
  return data+'.'+crypto.sign('sha256',Buffer.from(data),{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
 };
 const first=sign('native-once');identity.exchange(first);
 assert.throws(()=>identity.exchange(first+'='));
 const parts=first.split('.'),signature=Buffer.from(parts[2],'base64url');
 const order=BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
 parts[2]=Buffer.concat([signature.subarray(0,32),Buffer.from((order-BigInt('0x'+signature.subarray(32).toString('hex'))).toString(16).padStart(64,'0'),'hex')]).toString('base64url');
 assert.throws(()=>identity.exchange(parts.join('.')),{code:'ASSERTION_REPLAY'});
 assert.throws(()=>identity.exchange(sign('native-once',{sub:'job:other'})),{code:'ASSERTION_REPLAY'});
 identity.deleteTrust(trust.id,actor);identity.saveTrust(null,input,actor);
 assert.throws(()=>identity.exchange(first),{code:'ASSERTION_REPLAY'});
 checks.push('native-workload-replay-survives-signature-change-and-trust-recreation');
 const code=`const identity=require('/app/src/services/identity-governance'),db=require('/app/src/db').getDb();
  process.stdin.once('data',()=>{let result;try{identity.exchange(process.env.WORKLOAD_PROOF);result={accepted:true}}catch(error){result={accepted:false,code:error.code}}
   console.log('RESULT:'+JSON.stringify(result));db.close();process.exit(0)});console.log('READY');`;
 const proof=sign('native-race'),results=await raceRedeem(code,[{WORKLOAD_PROOF:proof},{WORKLOAD_PROOF:proof}]);
 assert.equal(results.filter(row=>row.accepted).length,1);assert.equal(results.find(row=>!row.accepted).code,'ASSERTION_REPLAY');
 checks.push('native-cross-process-workload-single-redemption');
 const express=require('express'),app=express();app.use(express.json());app.use('/workload',require('/app/src/routes/workload-identity'));
 app.use((_error,_req,res,_next)=>res.status(500).json({error:'fixture'}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const prior=config.features.governance;config.features.governance=true;const httpProof=sign('native-http');
 const call=async()=>{
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/workload/exchange',{method:'POST',
   headers:{'content-type':'application/json'},body:JSON.stringify({assertion:httpProof}),signal:AbortSignal.timeout(2500)});
  return {status:response.status,cache:response.headers.get('cache-control'),body:await response.json()};
 };
 try {
  config.features.readOnly=true;assert.equal((await call()).status,403);config.features.readOnly=false;
  db.exec("CREATE TEMP TRIGGER fail_native_workload_audit BEFORE INSERT ON audit_log WHEN NEW.action='workload_identity_exchange' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  try {assert.equal((await call()).status,500);}finally{db.exec('DROP TRIGGER fail_native_workload_audit');}
  const response=await call();assert.equal(response.status,200);assert.equal(response.cache,'no-store');
  const event=db.prepare("SELECT details FROM audit_log WHERE action='workload_identity_exchange' ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual(JSON.parse(event.details).scopes,['api.read']);assert.equal((await call()).status,409);
  checks.push('native-workload-http-audit-atomicity-and-readonly');
 }finally{config.features.governance=prior;config.features.readOnly=false;await new Promise(resolve=>server.close(resolve));}
};
