'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');
const { generateToken, sha256 } = require('../utils/crypto');
const { globMatches } = require('./governance-approvals');

const SERVICE_SCOPES = new Set(['scim.read', 'scim.write', 'governance.read', 'governance.write', 'api.read', 'api.write']);
const PROTOCOLS = new Set(['oidc', 'saml']);
const IDENTITY_KINDS = new Set(['oidc', 'spiffe', 'aws', 'azure', 'gcp']);

class IdentityGovernanceError extends Error {
  constructor(message, status = 400, code = 'IDENTITY_GOVERNANCE_ERROR', details) {
    super(message); this.name = 'IdentityGovernanceError'; this.status = status; this.code = code; this.details = details;
  }
}
function fail(message, status, code, details) { throw new IdentityGovernanceError(message, status, code, details); }
function clean(value, field, max = 200) {
  const result = String(value || '').trim().replace(/[\r\n\t]+/g, ' ');
  if (!result) fail(`${field} is required`);
  if (result.length > max) fail(`${field} is too long`);
  return result;
}
function int(value, field, min, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail(`${field} is invalid`);
  return parsed;
}
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function b64json(part, field) {
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { fail(`Assertion ${field} is invalid`, 401, 'ASSERTION_INVALID'); }
}
function safeScopes(input) {
  if (!Array.isArray(input) || !input.length) fail('At least one service scope is required');
  const scopes = [...new Set(input.map(value => String(value || '').trim()))];
  if (scopes.some(scope => !SERVICE_SCOPES.has(scope))) fail('One or more service scopes are invalid');
  return scopes.sort();
}
function safeUrl(value, field, { relative = false } = {}) {
  const result = clean(value, field, 1000);
  if (relative && /^\/[a-z0-9/_?&=.%:-]*$/i.test(result) && !result.startsWith('//')) return result;
  let url;
  try { url = new URL(result); } catch { fail(`${field} must be a valid URL`); }
  if (url.protocol !== 'https:') fail(`${field} must use HTTPS`);
  if (url.username || url.password) fail(`${field} must not contain credentials`);
  return url.toString();
}
function slug(value) {
  const result = clean(value, 'slug', 80).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/.test(result)) fail('slug must contain 3–80 lowercase letters, digits, or hyphens');
  return result;
}
function domain(value) {
  const result = clean(value, 'domain', 253).toLowerCase().replace(/^@/, '');
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(result)) fail(`Invalid email domain: ${result}`);
  return result;
}

class IdentityGovernanceService {
  constructor(dbProvider = getDb) { this._dbProvider = dbProvider; }
  _db() { return this._dbProvider(); }
  _admin(actor) { if (actor?.role !== 'admin') fail('Administrator access required', 403, 'ADMIN_REQUIRED'); }

  listRealms({ publicOnly = false } = {}) {
    const where = publicOnly ? 'WHERE r.enabled=1' : '';
    return this._db().prepare(`SELECT r.*,(SELECT group_concat(domain, ',') FROM governance_identity_realm_domains d WHERE d.realm_id=r.id) AS domains_csv
      FROM governance_identity_realms r ${where} ORDER BY r.name`).all().map(item => ({ ...item,
      domains: item.domains_csv ? item.domains_csv.split(',') : [],
      ...(publicOnly ? { issuer_url: undefined, metadata_url: undefined, entity_id: undefined, created_by: undefined } : {}) }));
  }

  saveRealm(id, input, actor) {
    this._admin(actor);
    const realmSlug = slug(input.slug);
    const name = clean(input.name, 'name', 120);
    const protocol = String(input.protocol || '').toLowerCase();
    if (!PROTOCOLS.has(protocol)) fail('protocol must be oidc or saml');
    const loginUrl = safeUrl(input.loginUrl, 'loginUrl', { relative: true });
    const domains = [...new Set((input.domains || []).map(domain))];
    if (!domains.length) fail('At least one routing domain is required');
    const defaultRole = ['admin', 'operator', 'viewer'].includes(input.defaultRole) ? input.defaultRole : 'viewer';
    const issuerUrl = input.issuerUrl ? safeUrl(input.issuerUrl, 'issuerUrl') : null;
    const metadataUrl = input.metadataUrl ? safeUrl(input.metadataUrl, 'metadataUrl') : null;
    const entityId = input.entityId ? clean(input.entityId, 'entityId', 500) : null;
    if (protocol === 'oidc' && !issuerUrl) fail('issuerUrl is required for OIDC realms');
    if (protocol === 'saml' && !metadataUrl && !entityId) fail('metadataUrl or entityId is required for SAML realms');
    const db = this._db();
    return db.transaction(() => {
      let realmId;
      if (id) {
        realmId = int(id, 'id', 1, Number.MAX_SAFE_INTEGER);
        const updated = db.prepare(`UPDATE governance_identity_realms SET slug=?,name=?,protocol=?,login_url=?,issuer_url=?,metadata_url=?,entity_id=?,
          default_role=?,enabled=?,updated_at=datetime('now') WHERE id=?`).run(realmSlug, name, protocol, loginUrl, issuerUrl, metadataUrl,
          entityId, defaultRole, input.enabled === false ? 0 : 1, realmId);
        if (!updated.changes) fail('Identity realm not found', 404);
        db.prepare('DELETE FROM governance_identity_realm_domains WHERE realm_id=?').run(realmId);
      } else {
        realmId = Number(db.prepare(`INSERT INTO governance_identity_realms
          (slug,name,protocol,login_url,issuer_url,metadata_url,entity_id,default_role,enabled,created_by)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(realmSlug, name, protocol, loginUrl, issuerUrl, metadataUrl, entityId,
          defaultRole, input.enabled === false ? 0 : 1, actor.id).lastInsertRowid);
      }
      const insert = db.prepare('INSERT INTO governance_identity_realm_domains (domain,realm_id) VALUES (?,?)');
      try { for (const item of domains) insert.run(item, realmId); } catch (error) {
        if (/UNIQUE/.test(error.message)) fail('An email domain is already routed to another realm', 409, 'DOMAIN_ALREADY_ROUTED');
        throw error;
      }
      return this.listRealms().find(item => item.id === realmId);
    })();
  }

  deleteRealm(id, actor) {
    this._admin(actor);
    const result = this._db().prepare('DELETE FROM governance_identity_realms WHERE id=?').run(int(id, 'id', 1, Number.MAX_SAFE_INTEGER));
    if (!result.changes) fail('Identity realm not found', 404);
    return { deleted: true };
  }

  resolveRealm(emailOrDomain) {
    const raw = clean(emailOrDomain, 'emailOrDomain', 320).toLowerCase();
    const routedDomain = domain(raw.includes('@') ? raw.split('@').pop() : raw);
    const item = this._db().prepare(`SELECT r.id,r.slug,r.name,r.protocol,r.login_url,r.default_role FROM governance_identity_realm_domains d
      JOIN governance_identity_realms r ON r.id=d.realm_id WHERE d.domain=? AND r.enabled=1`).get(routedDomain);
    if (!item) fail('No identity realm is configured for this domain', 404, 'REALM_NOT_FOUND');
    return { ...item, domain: routedDomain };
  }

  _issueToken({ name, principal, scopes, tenantId, ttlSeconds, issuedVia, rotatedFrom, createdBy }) {
    const ttl = int(ttlSeconds, 'ttlSeconds', 60, issuedVia === 'workload_exchange' ? 3600 : 86400);
    const raw = `ddst_${generateToken(32)}`;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const result = this._db().prepare(`INSERT INTO governance_service_tokens
      (name,principal,token_prefix,token_hash,scopes_json,tenant_id,expires_at,rotated_from,issued_via,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(clean(name, 'name', 120), clean(principal, 'principal', 300), raw.slice(0, 13), sha256(raw),
      JSON.stringify(safeScopes(scopes)), tenantId == null ? null : int(tenantId, 'tenantId', 1, Number.MAX_SAFE_INTEGER),
      expiresAt, rotatedFrom || null, issuedVia || 'manual', createdBy || null);
    return { ...this.tokenInfo(result.lastInsertRowid), token: raw };
  }

  issueToken(input, actor) {
    this._admin(actor);
    return this._issueToken({ name: input.name, principal: input.principal, scopes: input.scopes,
      tenantId: input.tenantId, ttlSeconds: input.ttlSeconds || 3600, issuedVia: 'manual', createdBy: actor.id });
  }

  tokenInfo(id) {
    const item = this._db().prepare(`SELECT id,name,principal,token_prefix,scopes_json,tenant_id,expires_at,last_used_at,revoked_at,
      rotated_from,issued_via,created_by,created_at FROM governance_service_tokens WHERE id=?`).get(Number(id));
    if (!item) fail('Service token not found', 404);
    return { ...item, scopes: parseJson(item.scopes_json, []) };
  }

  listTokens(actor) {
    this._admin(actor);
    return this._db().prepare(`SELECT id,name,principal,token_prefix,scopes_json,tenant_id,expires_at,last_used_at,revoked_at,
      rotated_from,issued_via,created_by,created_at FROM governance_service_tokens ORDER BY created_at DESC`).all()
      .map(item => ({ ...item, scopes: parseJson(item.scopes_json, []) }));
  }

  revokeToken(id, actor) {
    this._admin(actor);
    const result = this._db().prepare("UPDATE governance_service_tokens SET revoked_at=datetime('now') WHERE id=? AND revoked_at IS NULL")
      .run(int(id, 'id', 1, Number.MAX_SAFE_INTEGER));
    if (!result.changes) fail('Active service token not found', 404);
    return { revoked: true };
  }

  rotateToken(id, input, actor) {
    this._admin(actor);
    const previous = this.tokenInfo(id);
    if (previous.revoked_at || Date.parse(previous.expires_at) <= Date.now()) fail('Service token is not active', 409);
    return this._db().transaction(() => {
      const replacement = this._issueToken({ name: input.name || previous.name, principal: previous.principal,
        scopes: input.scopes || previous.scopes, tenantId: previous.tenant_id,
        ttlSeconds: input.ttlSeconds || 3600, issuedVia: 'rotation', rotatedFrom: previous.id, createdBy: actor.id });
      this._db().prepare("UPDATE governance_service_tokens SET revoked_at=datetime('now') WHERE id=?").run(previous.id);
      return replacement;
    })();
  }

  validateToken(raw) {
    if (!String(raw || '').startsWith('ddst_')) return null;
    const item = this._db().prepare(`SELECT * FROM governance_service_tokens WHERE token_hash=? AND revoked_at IS NULL
      AND datetime(expires_at)>datetime('now')`).get(sha256(raw));
    if (!item) return null;
    this._db().prepare("UPDATE governance_service_tokens SET last_used_at=datetime('now') WHERE id=?").run(item.id);
    return { id: null, username: item.principal, displayName: item.name, role: 'viewer', serviceToken: true,
      serviceTokenId: item.id, scopes: parseJson(item.scopes_json, []), tenantId: item.tenant_id, mustChangePassword: false };
  }

  requireScope(user, scope) {
    if (!user?.serviceToken) return true;
    const scopes = new Set(user.scopes || []);
    const allowed = scopes.has(scope) || (scope.endsWith('.read') && scopes.has('api.read')) ||
      (scope.endsWith('.write') && scopes.has('api.write'));
    if (!allowed) fail(`Service token lacks ${scope} scope`, 403, 'SERVICE_SCOPE_DENIED');
    return true;
  }

  listTrusts(actor) {
    this._admin(actor);
    return this._db().prepare(`SELECT id,name,issuer,audience,subject_pattern,identity_kind,scopes_json,tenant_id,
      token_ttl_seconds,max_assertion_ttl_seconds,enabled,created_by,created_at,updated_at FROM governance_workload_identity_trusts ORDER BY name`)
      .all().map(item => ({ ...item, scopes: parseJson(item.scopes_json, []) }));
  }

  saveTrust(id, input, actor) {
    this._admin(actor);
    const name = clean(input.name, 'name', 120);
    const issuer = clean(input.issuer, 'issuer', 500);
    const audience = clean(input.audience, 'audience', 300);
    const subjectPattern = clean(input.subjectPattern, 'subjectPattern', 500);
    const kind = String(input.identityKind || '').toLowerCase();
    if (!IDENTITY_KINDS.has(kind)) fail('identityKind is invalid');
    const jwks = input.jwks?.keys ? input.jwks : { keys: input.jwks };
    if (!Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.length > 20) fail('jwks.keys must contain 1–20 public keys');
    for (const key of jwks.keys) {
      if (key.d || key.p || key.q || key.dp || key.dq || key.qi) fail('Private JWK material is not allowed');
      try { crypto.createPublicKey({ key, format: 'jwk' }); } catch { fail('jwks contains an invalid public key'); }
    }
    const scopes = safeScopes(input.scopes);
    const tokenTtl = int(input.tokenTtlSeconds ?? 900, 'tokenTtlSeconds', 60, 3600);
    const assertionTtl = int(input.maxAssertionTtlSeconds ?? 3600, 'maxAssertionTtlSeconds', 60, 86400);
    const tenantId = input.tenantId == null ? null : int(input.tenantId, 'tenantId', 1, Number.MAX_SAFE_INTEGER);
    const db = this._db();
    if (id) {
      const trustId = int(id, 'id', 1, Number.MAX_SAFE_INTEGER);
      const result = db.prepare(`UPDATE governance_workload_identity_trusts SET name=?,issuer=?,audience=?,subject_pattern=?,identity_kind=?,
        jwks_json=?,scopes_json=?,tenant_id=?,token_ttl_seconds=?,max_assertion_ttl_seconds=?,enabled=?,updated_at=datetime('now') WHERE id=?`)
        .run(name, issuer, audience, subjectPattern, kind, JSON.stringify(jwks), JSON.stringify(scopes), tenantId, tokenTtl, assertionTtl,
          input.enabled === false ? 0 : 1, trustId);
      if (!result.changes) fail('Workload identity trust not found', 404);
      return this.listTrusts(actor).find(item => item.id === trustId);
    }
    const result = db.prepare(`INSERT INTO governance_workload_identity_trusts
      (name,issuer,audience,subject_pattern,identity_kind,jwks_json,scopes_json,tenant_id,token_ttl_seconds,max_assertion_ttl_seconds,enabled,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(name, issuer, audience, subjectPattern, kind, JSON.stringify(jwks), JSON.stringify(scopes),
      tenantId, tokenTtl, assertionTtl, input.enabled === false ? 0 : 1, actor.id);
    return this.listTrusts(actor).find(item => item.id === Number(result.lastInsertRowid));
  }

  deleteTrust(id, actor) {
    this._admin(actor);
    const result = this._db().prepare('DELETE FROM governance_workload_identity_trusts WHERE id=?').run(int(id, 'id', 1, Number.MAX_SAFE_INTEGER));
    if (!result.changes) fail('Workload identity trust not found', 404);
    return { deleted: true };
  }

  _verifyAssertion(assertion) {
    const parts = String(assertion || '').split('.');
    if (parts.length !== 3 || !parts.every(Boolean)) fail('Assertion must be a signed JWT', 401, 'ASSERTION_INVALID');
    const header = b64json(parts[0], 'header');
    const claims = b64json(parts[1], 'claims');
    if (!['RS256', 'ES256', 'EdDSA'].includes(header.alg)) fail('Assertion algorithm is not allowed', 401, 'ASSERTION_ALGORITHM_DENIED');
    const trusts = this._db().prepare('SELECT * FROM governance_workload_identity_trusts WHERE enabled=1 AND issuer=?').all(String(claims.iss || ''));
    const trust = trusts.find(item => {
      const audiences = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud || '')];
      return audiences.includes(item.audience) && globMatches(item.subject_pattern, String(claims.sub || ''));
    });
    if (!trust) fail('No workload identity trust matches this assertion', 401, 'WORKLOAD_TRUST_NOT_FOUND');
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || !claims.sub) fail('Assertion requires sub, iat and exp claims', 401, 'ASSERTION_CLAIMS_INVALID');
    if (claims.iat > now + 60 || claims.exp <= now || claims.exp <= claims.iat || (claims.nbf && claims.nbf > now + 60)) fail('Assertion is not currently valid', 401, 'ASSERTION_TIME_INVALID');
    if (claims.exp - claims.iat > trust.max_assertion_ttl_seconds) fail('Assertion lifetime exceeds trust policy', 401, 'ASSERTION_TTL_EXCEEDED');
    const keys = parseJson(trust.jwks_json, {}).keys || [];
    const candidates = header.kid ? keys.filter(key => key.kid === header.kid) : keys;
    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], 'base64url');
    const verified = candidates.some(jwk => {
      try {
        const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
        if (header.alg === 'ES256') return crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
        if (header.alg === 'EdDSA') return crypto.verify(null, data, key, signature);
        return crypto.verify('RSA-SHA256', data, key, signature);
      } catch { return false; }
    });
    if (!verified) fail('Assertion signature is invalid', 401, 'ASSERTION_SIGNATURE_INVALID');
    return { trust, claims };
  }

  exchange(assertion) {
    const { trust, claims } = this._verifyAssertion(assertion);
    const hash = sha256(assertion);
    const subjectHash = sha256(String(claims.sub));
    const db = this._db();
    return db.transaction(() => {
      db.prepare("DELETE FROM governance_workload_assertions WHERE datetime(expires_at)<=datetime('now')").run();
      try {
        db.prepare('INSERT INTO governance_workload_assertions (assertion_hash,trust_id,subject_hash,expires_at) VALUES (?,?,?,?)')
          .run(hash, trust.id, subjectHash, new Date(claims.exp * 1000).toISOString());
      } catch (error) {
        if (/UNIQUE/.test(error.message)) fail('Assertion has already been exchanged', 409, 'ASSERTION_REPLAY');
        throw error;
      }
      const token = this._issueToken({ name: trust.name, principal: `workload:${claims.sub}`, scopes: parseJson(trust.scopes_json, []),
        tenantId: trust.tenant_id, ttlSeconds: Math.min(trust.token_ttl_seconds, claims.exp - Math.floor(Date.now() / 1000)),
        issuedVia: 'workload_exchange', createdBy: null });
      return { accessToken: token.token, tokenType: 'Bearer', expiresAt: token.expires_at, scopes: token.scopes, tenantId: token.tenant_id };
    })();
  }
}

const service = new IdentityGovernanceService();
module.exports = service;
module.exports.IdentityGovernanceService = IdentityGovernanceService;
module.exports.IdentityGovernanceError = IdentityGovernanceError;
module.exports.SERVICE_SCOPES = SERVICE_SCOPES;
