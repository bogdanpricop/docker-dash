'use strict';
Object.assign(process.env, { APP_ENV: 'test', DB_PATH: ':memory:', APP_SECRET: 'external-identity-fixture', ENCRYPTION_KEY: 'external-identity-fixture-key-32c' });
const { getDb, closeDb } = require('../db'), auth = require('../services/auth');
const audit = require('../services/audit'), bcrypt = require('bcrypt');
const reset = require('../services/password-reset'), { sha256 } = require('../utils/crypto');
const config = require('../config');
let db, serial = 0;
const oidc = (subject, extra = {}) => ({ identity: { source: 'oidc', issuer: 'https://identity.example.test', subject }, ...extra });
const provision = (username, subject, extra = {}) => auth.findOrCreateSsoUser(username, 'viewer', '', oidc(subject, extra));
beforeAll(() => { db = getDb(); });
afterEach(() => jest.restoreAllMocks());
afterAll(() => closeDb());
function local(username, source = 'local', hash = 'fixture-hash') {
  return Number(db.prepare("INSERT INTO users(username,password_hash,role,auth_source) VALUES (?,?,'admin',?)").run(username,hash,source).lastInsertRowid);
}
test.each(['local','ldap','scim'])('OIDC cannot take over an existing %s username, even with different case', source => {
  const name = 'owned-' + source, id = local(name,source);
  const result = provision(name.toUpperCase(), 'collision-' + source);
  expect(result).toBeTruthy(); expect(result.id).not.toBe(id); expect(result.role).toBe('viewer');
  expect(db.prepare('SELECT role,auth_source FROM users WHERE id=?').get(id)).toEqual({role:'admin',auth_source:source});
});
test('trusted proxy cannot take over a local account', () => {
  const id = local('proxy-collision');
  const result = auth.findOrCreateSsoUser('proxy-collision','viewer','');
  expect(result.id).not.toBe(id); expect(result.role).toBe('viewer');
});
test('a stable subject keeps its user and permissions when profile username changes', () => {
  const first = provision('profile-first','stable-subject');
  db.prepare("UPDATE users SET role='operator' WHERE id=?").run(first.id);
  const second = provision('profile-renamed','stable-subject');
  expect(second.id).toBe(first.id); expect(second.username).toBe(first.username); expect(second.role).toBe('operator');
});
test('distinct subjects with the same username never share a user', () => {
  const first = provision('shared-name','subject-one'), second = provision('shared-name','subject-two');
  expect(first.id).not.toBe(second.id);
  expect(provision('shared-name','subject-two').id).toBe(second.id);
});
test('issuer and subject comparisons are exact and case-sensitive', () => {
  const name='issuer-collision', first=provision(name,'Subject');
  const changedCase=provision(name,'subject');
  const other=auth.findOrCreateSsoUser(name,'viewer','', { identity:{source:'oidc',issuer:'https://other.example.test',subject:'Subject'} });
  expect(new Set([first.id,changedCase.id,other.id]).size).toBe(3);
});
test('OIDC and proxy headers cannot cross-claim each other', () => {
  const first=provision('cross-source','proxy-subject');
  const second=auth.findOrCreateSsoUser('cross-source','viewer','');
  expect(second.id).not.toBe(first.id);
});
test('legacy SSO records are preserved and never claimed by matching profile fields', () => {
  const id=local('legacy-unbound','sso_legacy','SSO_NO_PASSWORD');
  const result=provision('legacy-unbound','legacy-new-subject');
  expect(result.id).not.toBe(id);
  expect(db.prepare('SELECT role,password_hash FROM users WHERE id=?').get(id)).toEqual({role:'admin',password_hash:'SSO_NO_PASSWORD'});
});
test('inactive identity cannot create another user under a renamed profile', () => {
  const first=provision('inactive-identity','inactive-subject');
  db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(first.id);
  expect(provision('inactive-renamed','inactive-subject')).toBeNull();
});
test('email collisions and unverified email never associate accounts', () => {
  const first=auth.findOrCreateSsoUser('email-first','viewer','shared@example.test',oidc('email-first',{emailVerified:true}));
  const second=auth.findOrCreateSsoUser('email-second','viewer','shared@example.test',oidc('email-second',{emailVerified:true}));
  const third=auth.findOrCreateSsoUser('email-unverified','viewer','unverified@example.test',oidc('email-third'));
  expect(second.id).not.toBe(first.id);
  for(const id of [second.id,third.id]) expect(db.prepare('SELECT email FROM users WHERE id=?').get(id).email).toBeNull();
});
test('audit failure rolls back user and identity provisioning', () => {
  jest.spyOn(audit,'log').mockImplementation(()=>{throw Error('fixture audit failure');});
  expect(()=>provision('rollback-identity','rollback-subject')).toThrow('fixture audit failure');
  expect(db.prepare("SELECT id FROM users WHERE external_subject='rollback-subject'").get()).toBeUndefined();
});
test('source changes keep the old identity reserved and refuse its authentication', () => {
  const first=provision('changed-source','changed-source');
  db.prepare("UPDATE users SET auth_source='scim' WHERE id=?").run(first.id);
  expect(provision('changed-source','changed-source')).toBeNull();
});
test('trusted-proxy namespaces are independent and group demotion is applied', () => {
  const saved=process.env.SSO_IDENTITY_NAMESPACE;
  try {
    process.env.SSO_IDENTITY_NAMESPACE='fixture-proxy-one';
    const first=auth.findOrCreateSsoUser('namespaced-proxy','admin','',{updateRole:true});
    expect(auth.findOrCreateSsoUser('namespaced-proxy','viewer','',{updateRole:true})).toMatchObject({id:first.id,role:'viewer'});
    process.env.SSO_IDENTITY_NAMESPACE='fixture-proxy-two';
    expect(auth.findOrCreateSsoUser('namespaced-proxy','viewer','').id).not.toBe(first.id);
  } finally { if(saved===undefined) delete process.env.SSO_IDENTITY_NAMESPACE; else process.env.SSO_IDENTITY_NAMESPACE=saved; }
});
test('migration preserves legacy data but revokes unbound SSO credentials', () => {
  const Database=require('better-sqlite3'), legacy=new Database(':memory:');
  try {
    legacy.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,role TEXT,password_hash TEXT,auth_source TEXT,is_active INTEGER,totp_secret TEXT,totp_enabled INTEGER);
      CREATE TABLE sessions(user_id INTEGER,is_valid INTEGER);
      CREATE TABLE mfa_tokens(user_id INTEGER);
      CREATE TABLE password_reset_tokens(user_id INTEGER,used_at TEXT);`);
    require('../db/migrations/179_auth_credential_version').up(legacy);
    legacy.exec(`INSERT INTO users(id,username,role,password_hash,auth_source,is_active) VALUES (1,'legacy','admin','SSO_NO_PASSWORD','local',1),(2,'local','admin','local-hash','local',1);
      INSERT INTO sessions VALUES (1,1),(2,1); INSERT INTO mfa_tokens VALUES (1),(2); INSERT INTO password_reset_tokens VALUES (1,NULL),(2,NULL);`);
    require('../db/migrations/181_external_identities').up(legacy);
    expect(legacy.prepare('SELECT username,role,password_hash,auth_source,external_subject FROM users WHERE id=1').get()).toEqual({username:'legacy',role:'admin',password_hash:'SSO_NO_PASSWORD',auth_source:'sso_legacy',external_subject:null});
    expect(legacy.prepare('SELECT is_valid FROM sessions WHERE user_id=1').get().is_valid).toBe(0);
    expect(legacy.prepare('SELECT COUNT(*) n FROM mfa_tokens WHERE user_id=1').get().n).toBe(0);
    expect(legacy.prepare('SELECT used_at FROM password_reset_tokens WHERE user_id=1').get().used_at).toBeTruthy();
    expect(legacy.prepare('SELECT is_valid FROM sessions WHERE user_id=2').get().is_valid).toBe(1);
    expect(legacy.prepare('SELECT COUNT(*) n FROM mfa_tokens WHERE user_id=2').get().n).toBe(1);
  } finally { legacy.close(); }
});
test('changing external identity revokes sessions, MFA proofs and reset links', () => {
  const first=provision('binding-change','binding-before');
  const token=auth._createSession(first,'127.0.0.1','fixture').token;
  db.prepare("INSERT INTO mfa_tokens(token_hash,user_id,expires_at) VALUES (?,?,datetime('now','+1 minute'))").run(sha256('binding-mfa'),first.id);
  db.prepare("INSERT INTO password_reset_tokens(token_hash,user_id,type,expires_at) VALUES (?,?,'reset',datetime('now','+1 minute'))").run(sha256('binding-reset'),first.id);
  const before=db.prepare('SELECT auth_version FROM users WHERE id=?').get(first.id).auth_version;
  db.prepare("UPDATE users SET external_subject='binding-after' WHERE id=?").run(first.id);
  expect(auth.validateSession(token)).toBeNull();
  expect(db.prepare('SELECT COUNT(*) n FROM mfa_tokens WHERE user_id=?').get(first.id).n).toBe(0);
  expect(db.prepare('SELECT used_at FROM password_reset_tokens WHERE user_id=?').get(first.id).used_at).toBeTruthy();
  expect(db.prepare('SELECT auth_version FROM users WHERE id=?').get(first.id).auth_version).toBe(before+1);
});
test.each(['oidc','proxy','sso_legacy','ldap','scim'])('%s credentials cannot be replaced by local recovery or local login', async source => {
  const username='no-local-'+source, password='FixtureSecret123!', hash=bcrypt.hashSync(password,4);
  const id=local(username,source,hash), email=username+'@example.test';
  db.prepare('UPDATE users SET email=? WHERE id=?').run(email,id);
  const oldSmtp=config.smtp.host; config.smtp.host='fixture.invalid';
  try { expect(()=>reset.issue(db,id,'reset',60000,email)).toThrow(/local/i); } finally { config.smtp.host=oldSmtp; }
  const token=String(++serial).padStart(64,'a');
  db.prepare("INSERT INTO password_reset_tokens(token_hash,user_id,type,expires_at) VALUES (?,?,'reset',datetime('now','+1 minute'))").run(sha256(token),id);
  expect(reset.find(db,token)).toBeNull();
  expect((await auth.changePassword(id,password,'OtherSecret123!')).error).toMatch(/local/i);
  expect((await auth.resetPassword(id,'OtherSecret123!')).error).toMatch(/local/i);
  if(source!=='ldap') expect((await auth.login(username,password,'192.0.2.'+serial,'fixture')).error).toBeTruthy();
  expect(db.prepare('SELECT password_hash FROM users WHERE id=?').get(id).password_hash).toBe(hash);
});
