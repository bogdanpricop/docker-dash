'use strict';

// V4.6c lifecycle controls (B196-B200).  These are control-plane records:
// expiry and revocation are surfaced for an operator; no provider resource is
// deleted or changed as a side effect.
const crypto = require('crypto');
const { getDb } = require('../db');

class LifecycleError extends Error {
  constructor(message, status = 400, code, details) {
    super(message); this.name = 'LifecycleError'; this.status = status; this.code = code; this.details = details;
  }
}
const fail = (message, status, code, details) => new LifecycleError(message, status, code, details);
const int = (value, name, min = 1) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) throw fail(`${name} must be a valid integer`);
  return n;
};
const str = (value, name, max = 160, required = true) => {
  const result = String(value || '').trim().replace(/[\r\n\t]+/g, ' ');
  if (required && !result) throw fail(`${name} is required`);
  if (result.length > max) throw fail(`${name} is too long`);
  return result || null;
};
const future = (value, name) => {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || date.valueOf() <= Date.now()) throw fail(`${name} must be a future timestamp`);
  return date.toISOString();
};
const json = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };

class GovernanceLifecycleService {
  constructor(dbProvider = getDb) { this._dbProvider = dbProvider; }
  _db() { return this._dbProvider(); }
  _authenticated(actor) { if (!actor?.id) throw fail('Authenticated user is required', 401); return actor; }
  _admin(actor) { if (!actor?.id) throw fail('Authenticated user is required', 401); if (actor.role !== 'admin') throw fail('Administrator permission is required', 403, 'GOVERNANCE_FORBIDDEN'); }
  _project(id) { const project = this._db().prepare('SELECT * FROM tenants WHERE id=?').get(int(id, 'tenantId')); if (!project) throw fail('Project not found', 404); return project; }
  _resource(id) { const resource = this._db().prepare('SELECT * FROM governance_project_resources WHERE id=?').get(int(id, 'resourceId')); if (!resource) throw fail('Project resource not found', 404); return resource; }

  saveLeasePolicy(tenantId, body, actor) {
    this._admin(actor); this._project(tenantId);
    const type = str(body.resourceType, 'resourceType', 80).toLowerCase();
    const ttl = int(body.maxTtlSeconds, 'maxTtlSeconds', 300); if (ttl > 31536000) throw fail('maxTtlSeconds is too large');
    const mode = ['holder', 'cleanup_owner', 'admin'].includes(body.renewalMode) ? body.renewalMode : 'holder';
    const renewals = int(body.maxRenewals ?? 12, 'maxRenewals', 0); if (renewals > 10000) throw fail('maxRenewals is too large');
    const owner = int(body.cleanupOwnerUserId, 'cleanupOwnerUserId');
    if (!this._db().prepare('SELECT 1 FROM users WHERE id=? AND is_active=1').get(owner)) throw fail('Cleanup owner must be an active user');
    this._db().prepare(`INSERT INTO governance_lease_policies (tenant_id,resource_type,max_ttl_seconds,renewal_mode,max_renewals,cleanup_owner_user_id,enabled,created_by)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,resource_type) DO UPDATE SET max_ttl_seconds=excluded.max_ttl_seconds,renewal_mode=excluded.renewal_mode,max_renewals=excluded.max_renewals,cleanup_owner_user_id=excluded.cleanup_owner_user_id,enabled=excluded.enabled,updated_at=datetime('now')`)
      .run(int(tenantId, 'tenantId'), type, ttl, mode, renewals, owner, body.enabled === false ? 0 : 1, actor.id);
    return this._db().prepare('SELECT * FROM governance_lease_policies WHERE tenant_id=? AND resource_type=?').get(tenantId, type);
  }
  listLeasePolicies(tenantId, actor) { this._admin(actor); this._project(tenantId); return this._db().prepare('SELECT * FROM governance_lease_policies WHERE tenant_id=? ORDER BY resource_type').all(tenantId); }
  createLease(tenantId, body, actor) {
    this._admin(actor); const resource = this._resource(body.resourceId); if (resource.tenant_id !== int(tenantId, 'tenantId')) throw fail('Resource belongs to another project', 409);
    const policy = this._db().prepare('SELECT * FROM governance_lease_policies WHERE tenant_id=? AND resource_type=? AND enabled=1').get(tenantId, str(body.resourceType || resource.resource_type, 'resourceType', 80).toLowerCase());
    if (!policy) throw fail('No enabled lease policy exists for this resource type', 409, 'LEASE_POLICY_REQUIRED');
    const expiry = future(body.expiresAt, 'expiresAt');
    if (Date.parse(expiry) - Date.now() > policy.max_ttl_seconds * 1000) throw fail('Lease exceeds the policy TTL', 409, 'LEASE_TTL_EXCEEDED');
    const holder = int(body.holderUserId, 'holderUserId');
    const result = this._db().prepare(`INSERT INTO governance_resource_leases (tenant_id,resource_id,policy_id,holder_user_id,cleanup_owner_user_id,expires_at,created_by)
      VALUES (?,?,?,?,?,?,?)`).run(tenantId, resource.id, policy.id, holder, policy.cleanup_owner_user_id, expiry, actor.id);
    return this._db().prepare('SELECT * FROM governance_resource_leases WHERE id=?').get(result.lastInsertRowid);
  }
  renewLease(leaseId, body, actor) {
    this._authenticated(actor); const lease = this._db().prepare(`SELECT l.*,p.max_ttl_seconds,p.max_renewals,p.renewal_mode FROM governance_resource_leases l JOIN governance_lease_policies p ON p.id=l.policy_id WHERE l.id=?`).get(int(leaseId, 'leaseId'));
    if (!lease || lease.state !== 'active') throw fail('Active lease not found', 404);
    const allowed = actor.role === 'admin'
      || (lease.renewal_mode === 'holder' && lease.holder_user_id === actor.id)
      || (lease.renewal_mode === 'cleanup_owner' && lease.cleanup_owner_user_id === actor.id);
    if (!allowed) throw fail('Lease renewal rights do not allow this principal', 403, 'LEASE_RENEWAL_FORBIDDEN');
    if (lease.renewal_count >= lease.max_renewals) throw fail('Lease renewal limit reached', 409, 'LEASE_RENEWAL_LIMIT');
    const ttl = typeof body === 'number' ? body : body?.ttlSeconds;
    const expiry = ttl != null ? new Date(Date.now() + int(ttl, 'ttlSeconds', 300) * 1000).toISOString() : future(body?.expiresAt, 'expiresAt');
    if (Date.parse(expiry) - Date.now() > lease.max_ttl_seconds * 1000) throw fail('Lease exceeds the policy TTL', 409, 'LEASE_TTL_EXCEEDED');
    this._db().prepare(`UPDATE governance_resource_leases SET expires_at=?,renewal_count=renewal_count+1,last_renewed_by=?,updated_at=datetime('now') WHERE id=?`).run(expiry, actor.id, lease.id);
    return this._db().prepare('SELECT * FROM governance_resource_leases WHERE id=?').get(lease.id);
  }
  reconcileLeases(actor) { if (actor) this._admin(actor); const result = this._db().prepare(`UPDATE governance_resource_leases SET state='cleanup_pending',updated_at=datetime('now') WHERE state='active' AND datetime(expires_at)<=datetime('now')`).run(); return { flaggedForCleanup: result.changes }; }

  listLeases(query, actor) {
    this._admin(actor); this.reconcileLeases(); const where=[]; const args=[];
    if (query?.tenantId) { where.push('l.tenant_id=?'); args.push(int(query.tenantId,'tenantId')); }
    if (query?.state) { where.push('l.state=?'); args.push(str(query.state,'state',40)); }
    return this._db().prepare(`SELECT l.*,r.resource_type,r.resource_key,r.display_name,
      h.username holder_username,c.username cleanup_owner_username FROM governance_resource_leases l
      JOIN governance_project_resources r ON r.id=l.resource_id JOIN users h ON h.id=l.holder_user_id
      JOIN users c ON c.id=l.cleanup_owner_user_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY l.created_at DESC`).all(...args);
  }

  releaseLease(leaseId, body, actor) {
    this._authenticated(actor); const lease=this._db().prepare('SELECT * FROM governance_resource_leases WHERE id=?').get(int(leaseId,'leaseId'));
    if (!lease) throw fail('Lease not found',404);
    const cleaned=body?.cleaned===true; const allowed=actor.role==='admin'||lease.holder_user_id===actor.id||lease.cleanup_owner_user_id===actor.id;
    if (!allowed) throw fail('Lease release rights do not allow this principal',403,'LEASE_RELEASE_FORBIDDEN');
    if (cleaned && actor.role!=='admin' && lease.cleanup_owner_user_id!==actor.id) throw fail('Only the cleanup owner can attest cleanup',403,'LEASE_CLEANUP_FORBIDDEN');
    const state=cleaned?'cleaned':'released'; this._db().prepare(`UPDATE governance_resource_leases SET state=?,
      released_at=COALESCE(released_at,datetime('now')),cleaned_at=CASE WHEN ?='cleaned' THEN datetime('now') ELSE cleaned_at END,
      updated_at=datetime('now') WHERE id=?`).run(state,state,lease.id);
    return this._db().prepare('SELECT * FROM governance_resource_leases WHERE id=?').get(lease.id);
  }

  ownershipPolicy(tenantId, body, actor) {
    this._admin(actor); this._project(tenantId);
    this._db().prepare(`INSERT INTO governance_ownership_policies (tenant_id,enforce_production,require_owner,require_service,require_cost_center,enabled,updated_by)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET enforce_production=excluded.enforce_production,require_owner=excluded.require_owner,require_service=excluded.require_service,require_cost_center=excluded.require_cost_center,enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=datetime('now')`)
      .run(tenantId, body.enforceProduction === false ? 0 : 1, body.requireOwner === false ? 0 : 1, body.requireService === false ? 0 : 1, body.requireCostCenter === false ? 0 : 1, body.enabled === false ? 0 : 1, actor.id);
    return this._db().prepare('SELECT * FROM governance_ownership_policies WHERE tenant_id=?').get(tenantId);
  }
  getOwnershipPolicy(tenantId, actor) { this._admin(actor); this._project(tenantId); return this._db().prepare('SELECT * FROM governance_ownership_policies WHERE tenant_id=?').get(tenantId)||null; }
  setOwnership(tenantId, resourceId, body, actor) {
    this._admin(actor); const resource = this._resource(resourceId); if (resource.tenant_id !== int(tenantId, 'tenantId')) throw fail('Resource belongs to another project', 409);
    const environment = body.environment === 'production' ? 'production' : 'nonproduction'; const policy = this._db().prepare('SELECT * FROM governance_ownership_policies WHERE tenant_id=?').get(tenantId);
    const owner = body.ownerUserId == null || body.ownerUserId === '' ? null : int(body.ownerUserId, 'ownerUserId'); const service = str(body.serviceName, 'serviceName', 160, false); const cost = str(body.costCenter, 'costCenter', 120, false);
    const incomplete = environment === 'production' && policy?.enabled && ((policy.require_owner && !owner) || (policy.require_service && !service) || (policy.require_cost_center && !cost));
    this._db().prepare(`INSERT INTO governance_resource_ownership (resource_id,tenant_id,owner_user_id,service_name,cost_center,environment,completeness_state,updated_by)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET owner_user_id=excluded.owner_user_id,service_name=excluded.service_name,cost_center=excluded.cost_center,environment=excluded.environment,completeness_state=excluded.completeness_state,updated_by=excluded.updated_by,updated_at=datetime('now')`)
      .run(resource.id, tenantId, owner, service, cost, environment, incomplete ? 'incomplete' : 'complete', actor.id);
    return this._db().prepare('SELECT * FROM governance_resource_ownership WHERE resource_id=?').get(resource.id);
  }
  ownershipReport(tenantId, actor) { this._admin(actor); return this._db().prepare(`SELECT r.*,o.owner_user_id,o.service_name,o.cost_center,o.environment,o.completeness_state FROM governance_project_resources r LEFT JOIN governance_resource_ownership o ON o.resource_id=r.id WHERE r.tenant_id=? ORDER BY o.completeness_state DESC,r.resource_key`).all(tenantId); }

  separationReport(actor) {
    this._admin(actor); const db=this._db();
    const rules=db.prepare(`SELECT r.*,l.slug left_role,rr.slug right_role FROM governance_sod_rules r
      JOIN governance_roles l ON l.id=r.left_role_id JOIN governance_roles rr ON rr.id=r.right_role_id WHERE r.enabled=1`).all();
    const scopes=db.prepare('SELECT id,parent_id FROM governance_scopes').all(); const parents=new Map(scopes.map(x=>[x.id,x.parent_id]));
    const ancestor=(a,b)=>{const seen=new Set();let x=b;while(x!=null&&!seen.has(x)){if(x===a)return true;seen.add(x);x=parents.get(x);}return false;};
    const assignments=db.prepare(`SELECT b.id binding_id,b.role_id,b.scope_id,u.id user_id,u.username,'direct' source,NULL team_name
      FROM governance_role_bindings b JOIN users u ON u.id=b.user_id WHERE b.user_id IS NOT NULL AND datetime(COALESCE(b.expires_at,'9999-12-31'))>datetime('now')
      UNION ALL SELECT b.id,b.role_id,b.scope_id,u.id,u.username,'team',t.name FROM governance_role_bindings b
      JOIN team_members tm ON tm.team_id=b.team_id JOIN users u ON u.id=tm.user_id JOIN teams t ON t.id=b.team_id
      WHERE b.team_id IS NOT NULL AND datetime(COALESCE(b.expires_at,'9999-12-31'))>datetime('now')`).all();
    const findings=[];
    for(const rule of rules){const users=new Set(assignments.map(x=>x.user_id));for(const userId of users){const rows=assignments.filter(x=>x.user_id===userId);
      for(const left of rows.filter(x=>x.role_id===rule.left_role_id))for(const right of rows.filter(x=>x.role_id===rule.right_role_id)){
        if(!(ancestor(left.scope_id,right.scope_id)||ancestor(right.scope_id,left.scope_id)))continue;
        if(rule.scope_id&&!(ancestor(rule.scope_id,left.scope_id)&&ancestor(rule.scope_id,right.scope_id)))continue;
        findings.push({rule_id:rule.id,ruleName:rule.name,severity:rule.severity,user_id:userId,username:left.username,
          left_role:rule.left_role,right_role:rule.right_role,leftBindingId:left.binding_id,rightBindingId:right.binding_id,
          scope_id:ancestor(left.scope_id,right.scope_id)?right.scope_id:left.scope_id,sources:[left.source,right.source],teams:[left.team_name,right.team_name].filter(Boolean)});
      }} }
    return findings;
  }
  sodReport(actor) { const findings=this.separationReport(actor); return { generatedAt:new Date().toISOString(),findings }; }
  saveSodRule(body, actor) { this._admin(actor); const result = this._db().prepare(`INSERT INTO governance_sod_rules (name,left_role_id,right_role_id,scope_id,severity,enabled,created_by) VALUES (?,?,?,?,?,?,?)`).run(str(body.name,'name'),int(body.leftRoleId,'leftRoleId'),int(body.rightRoleId,'rightRoleId'),body.scopeId == null ? null : int(body.scopeId,'scopeId'),['low','medium','high','critical'].includes(body.severity) ? body.severity : 'high',body.enabled === false ? 0 : 1,actor.id); return this._db().prepare('SELECT * FROM governance_sod_rules WHERE id=?').get(result.lastInsertRowid); }

  createReviewCampaign(body, actor) {
    this._admin(actor); const tenantId = body.tenantId == null ? null : int(body.tenantId, 'tenantId'); if (tenantId) this._project(tenantId);
    const db = this._db(); const scopeId = body.scopeId == null ? null : int(body.scopeId, 'scopeId');
    if (scopeId && !db.prepare('SELECT 1 FROM governance_scopes WHERE id=?').get(scopeId)) throw fail('Scope not found', 404);
    const result = db.prepare(`INSERT INTO governance_access_review_campaigns (name,tenant_id,scope_id,review_kind,due_at,created_by) VALUES (?,?,?,?,?,?)`)
      .run(str(body.name, 'name'), tenantId, scopeId, ['access','service_accounts','all'].includes(body.reviewKind) ? body.reviewKind : 'all', future(body.dueAt, 'dueAt'), actor.id);
    const campaignId = Number(result.lastInsertRowid); const campaign = db.prepare('SELECT * FROM governance_access_review_campaigns WHERE id=?').get(campaignId);
    const bindingFilter = ["datetime(COALESCE(b.expires_at,'9999-12-31'))>datetime('now')"]; const bindingArgs = [];
    if (scopeId) { bindingFilter.push('b.scope_id=?'); bindingArgs.push(scopeId); }
    if (tenantId) { bindingFilter.push('b.scope_id IN (SELECT id FROM governance_scopes WHERE tenant_id=?)'); bindingArgs.push(tenantId); }
    const bindings = db.prepare(`SELECT b.id,'user' subject_type,CAST(b.user_id AS TEXT) subject_key,u.username subject_label,b.role_id,b.scope_id
      FROM governance_role_bindings b JOIN users u ON u.id=b.user_id WHERE b.user_id IS NOT NULL AND ${bindingFilter.join(' AND ')}
      UNION ALL SELECT b.id,'team',CAST(b.team_id AS TEXT),t.name,b.role_id,b.scope_id FROM governance_role_bindings b
      JOIN teams t ON t.id=b.team_id WHERE b.team_id IS NOT NULL AND ${bindingFilter.join(' AND ')}`).all(...bindingArgs, ...bindingArgs);
    const tokens = db.prepare(`SELECT id,principal,name,scopes_json FROM governance_service_tokens
      WHERE revoked_at IS NULL AND datetime(expires_at)>datetime('now') ${tenantId ? 'AND tenant_id=?' : ''}`).all(...(tenantId ? [tenantId] : []));
    const insert = db.prepare(`INSERT INTO governance_access_review_items (campaign_id,subject_type,subject_key,subject_label,binding_id,service_token_id,role_id,scope_id,evidence_json) VALUES (?,?,?,?,?,?,?,?,?)`);
    if (campaign.review_kind !== 'service_accounts') for (const binding of bindings) insert.run(campaignId,binding.subject_type,binding.subject_key,binding.subject_label,binding.id,null,binding.role_id,binding.scope_id,JSON.stringify({ source:'role_binding' }));
    if (campaign.review_kind !== 'access') for (const token of tokens) insert.run(campaignId,'service_account',token.principal || String(token.id),token.name,null,token.id,null,null,JSON.stringify({ source:'service_token',scopes:json(token.scopes_json) }));
    return { ...campaign, itemCount: db.prepare('SELECT COUNT(*) count FROM governance_access_review_items WHERE campaign_id=?').get(campaignId).count };
  }
  listReviewCampaigns(actor) { this._admin(actor); return this._db().prepare(`SELECT c.*,COUNT(i.id) item_count,SUM(i.decision='pending') pending_count FROM governance_access_review_campaigns c LEFT JOIN governance_access_review_items i ON i.campaign_id=c.id GROUP BY c.id ORDER BY c.created_at DESC`).all(); }
  reviewItems(campaignId, actor) { this._admin(actor); return this._db().prepare('SELECT * FROM governance_access_review_items WHERE campaign_id=? ORDER BY decision,subject_label').all(int(campaignId,'campaignId')).map(item => ({ ...item, evidence:json(item.evidence_json) })); }
  decideReviewItem(itemId, body, actor) {
    this._admin(actor); const item = this._db().prepare('SELECT * FROM governance_access_review_items WHERE id=?').get(int(itemId,'itemId')); if (!item) throw fail('Review item not found',404);
    const decision = ['keep','revoke'].includes(body.decision) ? body.decision : null; if (!decision) throw fail('decision must be keep or revoke'); const db=this._db();
    return db.transaction(() => { if (decision === 'revoke' && item.binding_id) db.prepare("UPDATE governance_role_bindings SET expires_at=datetime('now') WHERE id=?").run(item.binding_id); if (decision === 'revoke' && item.service_token_id) db.prepare("UPDATE governance_service_tokens SET revoked_at=datetime('now') WHERE id=?").run(item.service_token_id); db.prepare(`UPDATE governance_access_review_items SET decision=?,reviewed_by=?,comment=?,reviewed_at=datetime('now') WHERE id=?`).run(decision,actor.id,str(body.comment,'comment',600,false),item.id); return db.prepare('SELECT * FROM governance_access_review_items WHERE id=?').get(item.id); })();
  }

  completeReviewCampaign(campaignId, actor) { this._admin(actor); const id=int(campaignId,'campaignId'); const db=this._db();
    const campaign=db.prepare('SELECT * FROM governance_access_review_campaigns WHERE id=?').get(id); if(!campaign)throw fail('Campaign not found',404);
    const pending=db.prepare("SELECT COUNT(*) count FROM governance_access_review_items WHERE campaign_id=? AND decision='pending'").get(id).count;
    if(pending)throw fail('Every campaign item must be reviewed before completion',409,'ACCESS_REVIEW_INCOMPLETE',{pending});
    db.prepare("UPDATE governance_access_review_campaigns SET state='completed',completed_by=?,completed_at=datetime('now') WHERE id=? AND state='active'").run(actor.id,id);
    return db.prepare('SELECT * FROM governance_access_review_campaigns WHERE id=?').get(id);
  }

  exportTenant(tenantId, actor) {
    this._admin(actor); const tenant=this._project(tenantId); const db=this._db();
    const exists=table=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    const manifest={schema:'docker-dash/tenant-export/v1',version:1,tenant,exportedAt:new Date().toISOString(),tables:{}};
    const tenantTables=['tenant_settings','tenant_modules','tenant_entities','tenant_entity_relations','governance_project_resources',
      'governance_project_quotas','governance_project_extended_quotas','governance_project_capacity_allocations','governance_quota_requests',
      'governance_quota_grants','governance_resource_ownership','governance_lease_policies','governance_resource_leases'];
    for(const table of tenantTables)if(exists(table))manifest.tables[table]=db.prepare(`SELECT * FROM ${table} WHERE tenant_id=? ORDER BY rowid`).all(tenant.id);
    if(exists('user_tenants'))manifest.tables.memberships=db.prepare('SELECT * FROM user_tenants WHERE tenant_id=? ORDER BY user_id').all(tenant.id);
    if(exists('governance_scopes'))manifest.tables.governance_scopes=db.prepare('SELECT scope_type,scope_key,display_name,parent_id,metadata_json,created_at,updated_at FROM governance_scopes WHERE tenant_id=? ORDER BY id').all(tenant.id);
    if(exists('governance_service_tokens'))manifest.tables.service_tokens=db.prepare(`SELECT name,principal,token_prefix,scopes_json,expires_at,last_used_at,revoked_at,issued_via,created_at
      FROM governance_service_tokens WHERE tenant_id=? ORDER BY id`).all(tenant.id);
    if(exists('governance_workload_identity_trusts'))manifest.tables.workload_trusts=db.prepare(`SELECT name,issuer,audience,subject_pattern,identity_kind,jwks_json,scopes_json,
      token_ttl_seconds,max_assertion_ttl_seconds,enabled,created_at,updated_at FROM governance_workload_identity_trusts WHERE tenant_id=? ORDER BY id`).all(tenant.id);
    const serialized=JSON.stringify(manifest);const bytes=Buffer.byteLength(serialized);if(bytes>10*1024*1024)throw fail('Tenant export exceeds the 10 MiB inline export limit',413,'TENANT_EXPORT_TOO_LARGE');
    const checksum=crypto.createHash('sha256').update(serialized).digest('hex'); const expiry=new Date(Date.now()+7*86400000).toISOString(); const result=db.prepare('INSERT INTO governance_tenant_exports (tenant_id,tenant_slug,manifest_json,checksum_sha256,byte_size,expires_at,created_by) VALUES (?,?,?,?,?,?,?)').run(tenantId,tenant.slug,serialized,checksum,bytes,expiry,actor.id);
    return { id:Number(result.lastInsertRowid), tenantId:tenant.id, tenantSlug:tenant.slug, manifest, checksumSha256:checksum, byteSize:bytes, expiresAt:expiry };
  }
  getTenantExport(exportId,actor){this._admin(actor);const row=this._db().prepare('SELECT * FROM governance_tenant_exports WHERE id=?').get(int(exportId,'exportId'));if(!row)throw fail('Tenant export not found',404);if(Date.parse(row.expires_at)<=Date.now())throw fail('Tenant export expired',410,'TENANT_EXPORT_EXPIRED');return {id:row.id,tenantId:row.tenant_id,tenantSlug:row.tenant_slug,checksumSha256:row.checksum_sha256,byteSize:row.byte_size,expiresAt:row.expires_at,manifest:json(row.manifest_json)};}
  _offboardingBlockers(tenant,exportId){const db=this._db(),blockers=[];
    if(tenant.is_default)blockers.push({code:'DEFAULT_TENANT',message:'The default tenant cannot be deleted'});
    if(tenant.status!=='suspended')blockers.push({code:'TENANT_NOT_SUSPENDED',message:'Suspend the tenant before offboarding'});
    const leases=db.prepare("SELECT COUNT(*) count FROM governance_resource_leases WHERE tenant_id=? AND state IN ('active','cleanup_pending')").get(tenant.id).count;
    if(leases)blockers.push({code:'ACTIVE_LEASES',count:leases,message:'Active or cleanup-pending leases remain'});
    const incomplete=db.prepare(`SELECT COUNT(*) count FROM governance_project_resources r LEFT JOIN governance_resource_ownership o ON o.resource_id=r.id
      WHERE r.tenant_id=? AND (o.resource_id IS NULL OR o.completeness_state='incomplete')`).get(tenant.id).count;
    if(incomplete)blockers.push({code:'OWNERSHIP_INCOMPLETE',count:incomplete,message:'Resource ownership is incomplete'});
    const reviews=db.prepare("SELECT COUNT(*) count FROM governance_access_review_campaigns WHERE tenant_id=? AND state='active'").get(tenant.id).count;
    if(reviews)blockers.push({code:'ACCESS_REVIEW_ACTIVE',count:reviews,message:'An access review is still active'});
    const exportRow=exportId?db.prepare("SELECT * FROM governance_tenant_exports WHERE id=? AND tenant_id=? AND datetime(expires_at)>datetime('now')").get(exportId,tenant.id):null;
    if(!exportRow)blockers.push({code:'VALID_EXPORT_REQUIRED',message:'A non-expired tenant export is required'});return {blockers,exportRow};}
  planOffboarding(tenantId, body, actor) { this._admin(actor); const tenant=this._project(tenantId);const exportId=body?.exportId==null?null:int(body.exportId,'exportId');
    const {blockers,exportRow}=this._offboardingBlockers(tenant,exportId);const state=blockers.length?'planned':'ready';
    const result=this._db().prepare('INSERT INTO governance_tenant_offboarding_requests (tenant_id,tenant_slug,export_id,state,blockers_json,requested_by) VALUES (?,?,?,?,?,?)').run(tenant.id,tenant.slug,exportRow?.id||null,state,JSON.stringify(blockers),actor.id);
    const row=this._db().prepare('SELECT * FROM governance_tenant_offboarding_requests WHERE id=?').get(result.lastInsertRowid);
    return {...row,blockers,requiredConfirmation:`DELETE ${tenant.slug}`}; }
  completeOffboarding(requestId,body,actor){this._admin(actor);const db=this._db();const request=db.prepare('SELECT * FROM governance_tenant_offboarding_requests WHERE id=?').get(int(requestId,'requestId'));if(!request)throw fail('Offboarding request not found',404);if(request.state==='completed'||!request.tenant_id)throw fail('Offboarding request is no longer active',409);
    const tenant=this._project(request.tenant_id),check=this._offboardingBlockers(tenant,request.export_id);if(check.blockers.length)throw fail('Tenant offboarding is blocked',409,'TENANT_OFFBOARDING_BLOCKED',{blockers:check.blockers});
    if(body.confirmation!==`DELETE ${tenant.slug}`)throw fail(`confirmation must be exactly DELETE ${tenant.slug}`);
    const checksum=String(body.checksumSha256||'');if(!/^[a-f0-9]{64}$/i.test(checksum)||!crypto.timingSafeEqual(Buffer.from(checksum.toLowerCase()),Buffer.from(check.exportRow.checksum_sha256)))throw fail('Export checksum confirmation does not match',409,'EXPORT_CHECKSUM_MISMATCH');
    return db.transaction(()=>{db.prepare("UPDATE governance_tenant_offboarding_requests SET state='completed',blockers_json='[]',completed_by=?,completed_at=datetime('now') WHERE id=?").run(actor.id,request.id);db.prepare('DELETE FROM tenants WHERE id=? AND is_default=0').run(tenant.id);return {completed:true,tenantId:tenant.id,tenantSlug:tenant.slug,exportId:check.exportRow.id,checksumSha256:check.exportRow.checksum_sha256};})();}
}

const service = new GovernanceLifecycleService();
module.exports = service;
module.exports.GovernanceLifecycleService = GovernanceLifecycleService;
module.exports.LifecycleError = LifecycleError;
module.exports.GovernanceLifecycleError = LifecycleError;
