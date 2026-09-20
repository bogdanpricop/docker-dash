'use strict';
const assert = require('node:assert/strict');
module.exports = async (db, checks) => {
  const express = require('express'), auth = require('/app/src/services/auth');
  const { apiKeys } = require('/app/src/services/misc'), config = require('/app/src/config');
  const { sha256 } = require('/app/src/utils/crypto');
  const id = Number(db.prepare("INSERT INTO users(username,password_hash,role,must_change_password) VALUES ('native-api-key','fixture','operator',0)").run().lastInsertRowid);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  const key = apiKeys.create(id,{name:'native',permissions:['read','write']}).key;
  const session = auth._createSession(user,'127.0.0.1','native-api-key').token;
  const app = express(); app.use(express.json()); app.use(require('cookie-parser')());
  app.use('/api/api-keys',require('/app/src/routes/misc-api-keys'));
  app.get('/api/private',require('/app/src/middleware/auth').requireAuth,(_req,res)=>res.json({ok:true}));
  const server = app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  const base = 'http://127.0.0.1:'+server.address().port;
  const call = async (path,token,method='GET',body) => {
    const response = await fetch(base+path,{method,headers:{authorization:token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
    await response.text(); return response.status;
  };
  const priorAge=config.security.passwordMaxAgeDays, priorTz=process.env.TZ;
  try {
    for(const expiry of ['', 'invalid',new Date(Date.now()-10000).toISOString()]) {
      db.prepare('UPDATE api_keys SET expires_at=? WHERE key_hash=?').run(expiry,sha256(key));
      assert.equal(await call('/api/private','ApiKey '+key),401);
    }
    checks.push('native-api-key-invalid-and-expired-lifetime-denied');
    db.prepare('UPDATE api_keys SET expires_at=NULL WHERE key_hash=?').run(sha256(key));
    assert.equal(await call('/api/private','ApiKey '+key),200);
    db.prepare('UPDATE users SET must_change_password=1 WHERE id=?').run(id);
    assert.equal(await call('/api/private','ApiKey '+key),403);
    db.prepare('UPDATE users SET must_change_password=0 WHERE id=?').run(id);
    assert.equal(await call('/api/api-keys','ApiKey '+key,'POST',{name:'derived',permissions:['*']}),403);
    checks.push('native-api-key-password-policy-and-credential-management');
    config.security.passwordMaxAgeDays=1;
    db.prepare("UPDATE users SET password_changed_at=datetime('now','-23 hours') WHERE id=?").run(id);
    for(const tz of ['UTC','Europe/Bucharest','America/Los_Angeles']) {
      process.env.TZ=tz;
      assert.equal(apiKeys.validate(key).mustChangePassword,false);
      assert.equal(auth.validateSession(session).mustChangePassword,false);
    }
    checks.push('native-password-age-independent-of-process-timezone');
    const created=apiKeys.create(id,{name:'revocation'}).key;
    const row=db.prepare('SELECT id FROM api_keys WHERE key_hash=?').get(sha256(created));
    assert.equal(await call('/api/api-keys/'+row.id,'Bearer '+session,'DELETE'),200);
    assert.equal(apiKeys.validate(created),null);
    assert.ok(db.prepare("SELECT id FROM audit_log WHERE action='apikey_revoke' AND target_id=?").get(String(row.id)));
    db.prepare("UPDATE users SET password_hash='changed' WHERE id=?").run(id);
    assert.equal(apiKeys.validate(key),null);
    checks.push('native-api-key-owned-revocation-audit-and-password-trigger');
  } finally {
    config.security.passwordMaxAgeDays=priorAge;
    if(priorTz===undefined) delete process.env.TZ; else process.env.TZ=priorTz;
    await new Promise(resolve=>server.close(resolve));
  }
};
