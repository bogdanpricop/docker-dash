'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
module.exports=async(db,checks,raceRedeem)=>{
 const identity=require('/app/src/services/identity-governance'),auth=require('/app/src/services/auth'),config=require('/app/src/config');
 const id=db.prepare("INSERT INTO users(username,password_hash,role,must_change_password) VALUES ('native-token-admin','fixture','admin',0)").run().lastInsertRowid;
 const actor=db.prepare('SELECT * FROM users WHERE id=?').get(id);
 const issue=()=>identity.issueToken({name:'native',principal:'fixture',scopes:['api.read'],ttlSeconds:300},actor);
 const code=`const identity=require('/app/src/services/identity-governance'),db=require('/app/src/db').getDb();
  process.stdin.once('data',()=>{let result;try{const actor={id:Number(process.env.ACTOR_ID),role:'admin'};
   const token=process.env.OPERATION==='revoke'?identity.revokeToken(Number(process.env.TOKEN_ID),actor):identity.rotateToken(Number(process.env.TOKEN_ID),{},actor);
   result={accepted:true,id:token.id||null};}catch(error){result={accepted:false,status:error.status}}
   console.log('RESULT:'+JSON.stringify(result));db.close();process.exit(0)});console.log('READY');`;
 const first=issue(),environment={ACTOR_ID:String(id),TOKEN_ID:String(first.id)};
 const rotations=await raceRedeem(code,[environment,environment]);assert.equal(rotations.filter(row=>row.accepted).length,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM governance_service_tokens WHERE rotated_from=?').get(first.id).n,1);
 checks.push('native-cross-process-service-token-single-rotation');
 const original=issue(),raceEnv={ACTOR_ID:String(id),TOKEN_ID:String(original.id)};
 const revokeRace=await raceRedeem(code,[raceEnv,{...raceEnv,OPERATION:'revoke'}]);
 assert.equal(revokeRace[1].accepted,true);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM governance_service_tokens WHERE (id=? OR rotated_from=?) AND revoked_at IS NULL').get(original.id,original.id).n,0);
 checks.push('native-cross-process-service-revocation-covers-concurrent-rotation');
 const keys=crypto.generateKeyPairSync('ed25519'),input={name:'native-lineage',issuer:'https://lineage.example.test',audience:'dashboard',
  subjectPattern:'job:*',identityKind:'oidc',jwks:{keys:[keys.publicKey.export({format:'jwk'})]},scopes:['api.read'],tokenTtlSeconds:300};
 const trust=identity.saveTrust(null,input,actor),now=Math.floor(Date.now()/1000);
 const data=Buffer.from(JSON.stringify({alg:'EdDSA'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({
  iss:input.issuer,aud:input.audience,sub:'job:fixture',iat:now,exp:now+300})).toString('base64url');
 const proof=data+'.'+crypto.sign(null,Buffer.from(data),keys.privateKey).toString('base64url'),workload=identity.exchange(proof);
 const workloadId=identity.validateToken(workload.accessToken).serviceTokenId;
 assert.throws(()=>identity.rotateToken(workloadId,{scopes:['api.write']},actor));
 const rotation=identity.rotateToken(workloadId,{ttlSeconds:86400},actor);assert.ok(Date.parse(rotation.expires_at)<=Date.parse(workload.expiresAt));
 identity.saveTrust(trust.id,{...input,enabled:false},actor);assert.equal(identity.validateToken(rotation.token),null);
 checks.push('native-workload-lineage-expiry-scopes-and-trust-revocation');
 const express=require('express'),app=express();app.use(express.json());app.use(require('cookie-parser')());
 app.use('/api/governance/controls',require('/app/src/routes/governance-controls'));
 app.use((_error,_req,res,_next)=>res.status(500).json({error:'fixture'}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const prior=config.features.governance;config.features.governance=true;
 const session=auth._createSession(actor,'127.0.0.1','fixture').token;
 const call=async(authorization)=>{
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/governance/controls/service-tokens',{method:'POST',
   headers:{authorization,'content-type':'application/json'},body:JSON.stringify({name:'http',principal:'fixture',scopes:['api.read'],ttlSeconds:300}),signal:AbortSignal.timeout(2500)});
  return {status:response.status,cache:response.headers.get('cache-control'),body:await response.json()};
 };
 try{
  const key=require('/app/src/services/misc').apiKeys.create(id,{name:'fixture',permissions:['write']}).key;
  assert.equal((await call('ApiKey '+key)).status,403);
  const before=db.prepare('SELECT COUNT(*) n FROM governance_service_tokens').get().n;
  db.exec("CREATE TEMP TRIGGER fail_native_issue_audit BEFORE INSERT ON audit_log WHEN NEW.action='service_token_issue' BEGIN SELECT RAISE(ABORT,'fixture'); END");
  try{assert.equal((await call('Bearer '+session)).status,500);}finally{db.exec('DROP TRIGGER fail_native_issue_audit');}
  assert.equal(db.prepare('SELECT COUNT(*) n FROM governance_service_tokens').get().n,before);
  const response=await call('Bearer '+session);assert.equal(response.status,201);assert.equal(response.cache,'no-store');
  assert.ok(db.prepare("SELECT id FROM audit_log WHERE action='service_token_issue' AND target_id=?").get(String(response.body.token.id)));
  checks.push('native-service-token-user-auth-and-audit-atomicity');
 }finally{config.features.governance=prior;await new Promise(resolve=>server.close(resolve));}
};
