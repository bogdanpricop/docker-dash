'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,159}$/;
const SAFE_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.:+/@ -]{0,499}$/;
const SAFE_FIELD = /^[a-zA-Z0-9_[\].*-]{1,300}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const OPERATION_ID = /^op_[a-f0-9]{26}$/;
const SECRET_KEY = /password|secret|token|credential|private.?key|authorization|cookie|license.?key/i;
const VALIDATION_CATEGORIES = ['api', 'ha', 'migration', 'storage', 'network', 'vm'];

class LifecycleAssuranceError extends Error {
  constructor(message, status = 400, code = 'LIFECYCLE_ASSURANCE_ERROR', details) {
    super(message); this.name = 'LifecycleAssuranceError'; this.status = status; this.code = code; this.details = details;
  }
}

const fail = (message, status, code, details) => new LifecycleAssuranceError(message, status, code, details);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const string = (value, key, max = 500, pattern) => {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || (pattern && !pattern.test(result))) throw fail(`${key} is invalid`);
  return result;
};
const integer = (value, key, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const result = Number(value); if (!Number.isSafeInteger(result) || result < min || result > max) throw fail(`${key} must be an integer between ${min} and ${max}`); return result;
};
const number = (value, key, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const result = Number(value); if (!Number.isFinite(result) || result < min || result > max) throw fail(`${key} must be between ${min} and ${max}`); return result;
};
function bounded(value, key, max = 1024 * 1024) {
  let encoded; try { encoded = JSON.stringify(value); } catch { throw fail(`${key} must be JSON serializable`); }
  if (Buffer.byteLength(encoded) > max) throw fail(`${key} exceeds ${max} bytes`, 413, 'LIFECYCLE_DOCUMENT_TOO_LARGE');
}
function secretFree(value, path = 'document') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw fail(`${path}.${key} may not contain secret material`, 400, 'LIFECYCLE_SECRET_FIELD');
    secretFree(child, `${path}.${key}`);
  }
}
function redactSecrets(value, path = '', redacted = []) {
  if (Array.isArray(value)) return value.map((item, index) => redactSecrets(item, `${path}[${index}]`, redacted));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (SECRET_KEY.test(key)) { result[key] = '[REDACTED]'; redacted.push(childPath); }
    else result[key] = redactSecrets(child, childPath, redacted);
  }
  return result;
}
function timestamp(value, key, future = false) {
  const date = new Date(value); if (Number.isNaN(date.getTime())) throw fail(`${key} must be an ISO timestamp`);
  if (future && date.getTime() <= Date.now()) throw fail(`${key} must be in the future`);
  return date.toISOString();
}
function httpsUrl(value, key = 'sourceUrl') {
  const result = string(value, key, 1000); let parsed;
  try { parsed = new URL(result); } catch { throw fail(`${key} must be a valid URL`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) throw fail(`${key} must be credential-free HTTPS`);
  return parsed.toString();
}
function locationReference(value, key) {
  const result = string(value, key, 500, /^[a-zA-Z0-9/_.:@+ -]+$/);
  if (result.split('/').includes('..')) throw fail(`${key} may not traverse parent directories`);
  return result;
}
function list(value, key, max = 100, allowEmpty = false, pattern = SAFE_REF) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > max) throw fail(`${key} must contain ${allowEmpty ? '0' : '1'}-${max} values`);
  return [...new Set(value.map((item, index) => string(item, `${key}[${index}]`, 500, pattern)))];
}
function flatten(value, prefix = '', output = new Map()) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (!keys.length && prefix) output.set(prefix, {});
    for (const key of keys) flatten(value[key], prefix ? `${prefix}.${key}` : key, output);
  } else if (prefix) output.set(prefix, canonical(value));
  return output;
}
function configurationDiff(before, after) {
  const left = flatten(before); const right = flatten(after); const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  return paths.flatMap(path => {
    if (!left.has(path)) return [{ path, change: 'added', before: null, after: right.get(path) }];
    if (!right.has(path)) return [{ path, change: 'removed', before: left.get(path), after: null }];
    return stable(left.get(path)) === stable(right.get(path)) ? [] : [{ path, change: 'changed', before: left.get(path), after: right.get(path) }];
  });
}
function globMatch(pattern, value) {
  const escaped = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}
function getPath(document, path) {
  return path.split('.').reduce((value, key) => value == null ? undefined : value[key], document);
}

class LifecycleAssuranceService {
  constructor(dbProvider = getDb, options = {}) {
    this._dbProvider = dbProvider; this._renewalAdapters = options.renewalAdapters || {};
    this._mirrorAdapters = options.mirrorAdapters || {}; this._supportCollectors = options.supportCollectors || {};
    this._validationAdapters = options.validationAdapters || {};
  }
  _db() { return this._dbProvider(); }
  _admin(actor) {
    if (!actor?.id) throw fail('Authenticated user is required', 401, 'AUTH_REQUIRED');
    if (actor.role !== 'admin') throw fail('Administrator permission is required', 403, 'GOVERNANCE_FORBIDDEN');
  }
  _ownership(id) {
    const row = this._db().prepare(`SELECT o.*,c.name certificate_name,c.fingerprint_sha256,c.not_after
      FROM lifecycle_certificate_ownership o LEFT JOIN tracked_certificates c ON c.id=o.certificate_id WHERE o.id=?`).get(integer(id, 'ownershipId', 1));
    if (!row) throw fail('Certificate ownership not found', 404, 'CERTIFICATE_OWNERSHIP_NOT_FOUND');
    return { id: row.id, certificateId: row.certificate_id, inventoryKey: row.inventory_key, resourceType: row.resource_type,
      resourceRef: row.resource_ref, owner: row.owner, environment: row.environment, maintenancePlanId: row.maintenance_plan_id,
      certificateName: row.certificate_name, fingerprintSha256: row.fingerprint_sha256, notAfter: row.not_after };
  }
  _renewalRow(row) { return row && { id: row.id, ownershipId: row.ownership_id, adapterKey: row.adapter_key,
    maintenancePlanId: row.maintenance_plan_id, state: row.state, planHash: row.plan_hash,
    rollbackOnFailure: !!row.rollback_on_failure, operationId: row.operation_id, approvalId: row.approval_id,
    previousFingerprint: row.previous_fingerprint, renewedFingerprint: row.renewed_fingerprint,
    evidence: parse(row.evidence_json, {}), approvedAt: row.approved_at, completedAt: row.completed_at, createdAt: row.created_at }; }
  planRenewal(body = {}, actor) {
    this._admin(actor); const ownership = this._ownership(body.ownershipId);
    if (!ownership.certificateId) throw fail('A tracked certificate is required before renewal', 409, 'TRACKED_CERTIFICATE_REQUIRED');
    const adapterKey = string(body.adapterKey, 'adapterKey', 120, SAFE_NAME).toLowerCase();
    const maintenancePlanId = body.maintenancePlanId == null ? ownership.maintenancePlanId : integer(body.maintenancePlanId, 'maintenancePlanId', 1);
    if (maintenancePlanId && !this._db().prepare("SELECT 1 FROM lifecycle_maintenance_plans WHERE id=? AND state='approved'").get(maintenancePlanId)) {
      throw fail('Approved maintenance plan is required', 409, 'APPROVED_MAINTENANCE_REQUIRED');
    }
    const normalized = { ownershipId: ownership.id, adapterKey, maintenancePlanId: maintenancePlanId || null,
      previousFingerprint: ownership.fingerprintSha256 || null, notAfter: ownership.notAfter || null,
      rollbackOnFailure: body.rollbackOnFailure !== false };
    const planHash = hash(normalized); const supported = typeof this._renewalAdapters[adapterKey] === 'function'; const db = this._db();
    try {
      const saved = db.prepare(`INSERT INTO lifecycle_certificate_renewal_jobs
        (ownership_id,adapter_key,maintenance_plan_id,state,plan_hash,rollback_on_failure,previous_fingerprint,evidence_json,created_by)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(ownership.id, adapterKey, normalized.maintenancePlanId, supported ? 'ready' : 'unsupported',
        planHash, normalized.rollbackOnFailure ? 1 : 0, normalized.previousFingerprint,
        stable(supported ? { supported: true } : { supported: false, reason: `No renewal adapter is registered for ${adapterKey}` }), actor.id);
      return { ...this._renewalRow(db.prepare('SELECT * FROM lifecycle_certificate_renewal_jobs WHERE id=?').get(saved.lastInsertRowid)), applyStarted: false };
    } catch (error) {
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) throw fail('Identical renewal plan already exists', 409, 'RENEWAL_PLAN_EXISTS');
      throw error;
    }
  }
  renewalJobs(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM lifecycle_certificate_renewal_jobs ORDER BY id DESC').all().map(row => this._renewalRow(row)); }
  approveRenewal(id, body = {}, actor) {
    this._admin(actor); const db = this._db(); const job = this._renewalRow(db.prepare('SELECT * FROM lifecycle_certificate_renewal_jobs WHERE id=?').get(integer(id, 'renewalJobId', 1)));
    if (!job) throw fail('Renewal job not found', 404, 'RENEWAL_JOB_NOT_FOUND');
    if (job.state !== 'ready') throw fail('Renewal job is not ready', 409, 'RENEWAL_NOT_READY');
    if (body.planHash !== job.planHash || body.confirmation !== `APPROVE RENEWAL ${job.id}`) throw fail('Renewal hash or typed confirmation does not match', 409, 'RENEWAL_CONFIRMATION_MISMATCH');
    db.prepare("UPDATE lifecycle_certificate_renewal_jobs SET state='approved',approved_by=?,approved_at=datetime('now'),updated_at=datetime('now') WHERE id=?").run(actor.id, job.id);
    return { ...this._renewalRow(db.prepare('SELECT * FROM lifecycle_certificate_renewal_jobs WHERE id=?').get(job.id)), applyStarted: false };
  }
  async executeRenewal(id, body = {}, actor) {
    this._admin(actor); const db = this._db(); let job = this._renewalRow(db.prepare('SELECT * FROM lifecycle_certificate_renewal_jobs WHERE id=?').get(integer(id, 'renewalJobId', 1)));
    if (!job) throw fail('Renewal job not found', 404, 'RENEWAL_JOB_NOT_FOUND');
    if (job.state !== 'approved') throw fail('Approved renewal job is required', 409, 'RENEWAL_NOT_APPROVED');
    if (body.confirmation !== `EXECUTE RENEWAL ${job.id}`) throw fail('Typed execution confirmation does not match');
    const operationId = string(body.operationId, 'operationId', 80, OPERATION_ID); const approvalId = integer(body.approvalId, 'approvalId', 1);
    const operation = db.prepare('SELECT id,state FROM provider_operations WHERE id=?').get(operationId);
    const approval = db.prepare(`SELECT id,payload_hash FROM infrastructure_approval_requests
      WHERE id=? AND state='approved' AND action_key='certificate.renew' AND target_id=?`).get(approvalId, String(job.id));
    const approvalHash = hash({ renewalJobId: job.id, planHash: job.planHash });
    if (!operation) throw fail('Durable provider operation not found', 404, 'OPERATION_NOT_FOUND');
    if (!['queued','running','reconciling','succeeded'].includes(operation.state)) throw fail('Durable provider operation is not active/succeeded', 409, 'OPERATION_STATE_INVALID');
    if (!approval || approval.payload_hash !== approvalHash) throw fail('Matching certificate renewal approval is required', 409, 'RENEWAL_APPROVAL_REQUIRED');
    const adapter = this._renewalAdapters[job.adapterKey]; if (!adapter) throw fail('Renewal adapter is unavailable', 409, 'RENEWAL_ADAPTER_UNAVAILABLE');
    const ownership = this._ownership(job.ownershipId); const request = object(body.request); bounded(request, 'request'); secretFree(request, 'request');
    db.prepare("UPDATE lifecycle_certificate_renewal_jobs SET state='applying',operation_id=?,approval_id=?,updated_at=datetime('now') WHERE id=?").run(operationId, approvalId, job.id);
    const evidence = { apply: null, verify: null, rollback: null };
    try {
      evidence.apply = object(await adapter({ phase: 'apply', job, ownership, request: canonical(request) })); bounded(evidence.apply, 'applyEvidence'); secretFree(evidence.apply, 'applyEvidence');
      db.prepare("UPDATE lifecycle_certificate_renewal_jobs SET state='verifying',evidence_json=?,updated_at=datetime('now') WHERE id=?").run(stable(evidence), job.id);
      evidence.verify = object(await adapter({ phase: 'verify', job, ownership, request: canonical(request), applyEvidence: evidence.apply }));
      bounded(evidence.verify, 'verifyEvidence'); secretFree(evidence.verify, 'verifyEvidence');
      if (evidence.verify.verified !== true) throw fail('Renewed certificate verification failed', 409, 'RENEWAL_VERIFY_FAILED');
      const fingerprint = string(evidence.verify.fingerprintSha256, 'verifyEvidence.fingerprintSha256', 64, DIGEST);
      const notAfter = timestamp(evidence.verify.notAfter, 'verifyEvidence.notAfter', true);
      db.transaction(() => {
        db.prepare("UPDATE tracked_certificates SET fingerprint_sha256=?,not_after=?,last_checked_at=datetime('now'),last_error='',updated_at=datetime('now') WHERE id=?")
          .run(fingerprint, notAfter, ownership.certificateId);
        db.prepare("UPDATE lifecycle_certificate_renewal_jobs SET state='succeeded',renewed_fingerprint=?,evidence_json=?,completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?")
          .run(fingerprint, stable(evidence), job.id);
      })();
    } catch (error) {
      evidence.error = { code: error.code || 'RENEWAL_FAILED', message: String(error.message || error).slice(0, 600) };
      let state = 'rollback_required';
      if (job.rollbackOnFailure) {
        try { db.prepare("UPDATE lifecycle_certificate_renewal_jobs SET state='rolling_back',evidence_json=?,updated_at=datetime('now') WHERE id=?").run(stable(evidence), job.id);
          evidence.rollback = object(await adapter({ phase: 'rollback', job, ownership, request: canonical(request), applyEvidence: evidence.apply }));
          bounded(evidence.rollback, 'rollbackEvidence'); secretFree(evidence.rollback, 'rollbackEvidence');
          state = evidence.rollback.rolledBack === true ? 'rolled_back' : 'rollback_required';
        } catch (rollbackError) { evidence.rollback = { rolledBack: false, error: String(rollbackError.message || rollbackError).slice(0, 600) }; state = 'rollback_required'; }
      }
      db.prepare("UPDATE lifecycle_certificate_renewal_jobs SET state=?,evidence_json=?,completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?")
        .run(state, stable(evidence), job.id);
    }
    job = this._renewalRow(db.prepare('SELECT * FROM lifecycle_certificate_renewal_jobs WHERE id=?').get(job.id));
    return { ...job, operationState: operation.state, implicitRebootScheduled: false };
  }

  _entitlementRow(row) { return row && { id: row.id, vendor: row.vendor, product: row.product, edition: row.edition,
    entitlementReference: row.entitlement_reference, entitlementHash: row.entitlement_hash, metric: row.metric,
    capacity: row.capacity, unit: row.unit, startsAt: row.starts_at, expiresAt: row.expires_at,
    supportExpiresAt: row.support_expires_at, sourceUrl: row.source_url, metadata: parse(row.metadata_json, {}) }; }
  saveEntitlement(body = {}, actor) {
    this._admin(actor); if (!['host','socket','core','vm','capacity','subscription'].includes(body.metric)) throw fail('metric is invalid');
    const reference = string(body.entitlementReference, 'entitlementReference', 500, SAFE_REF);
    if (SECRET_KEY.test(reference)) throw fail('Use an opaque entitlement reference, never a license key', 400, 'LICENSE_KEY_FORBIDDEN');
    const metadata = object(body.metadata); bounded(metadata, 'metadata'); secretFree(metadata);
    const startsAt = body.startsAt ? timestamp(body.startsAt, 'startsAt') : null;
    const expiresAt = body.expiresAt ? timestamp(body.expiresAt, 'expiresAt') : null;
    const supportExpiresAt = body.supportExpiresAt ? timestamp(body.supportExpiresAt, 'supportExpiresAt') : null;
    const values = [string(body.vendor, 'vendor', 160, SAFE_NAME), string(body.product, 'product', 160, SAFE_NAME),
      string(body.edition, 'edition', 160, SAFE_NAME), reference, hash(reference), body.metric,
      number(body.capacity, 'capacity', 0), string(body.unit, 'unit', 80, SAFE_NAME), startsAt, expiresAt, supportExpiresAt,
      httpsUrl(body.sourceUrl), stable(metadata), actor.id]; const db = this._db();
    db.prepare(`INSERT INTO license_entitlements
      (vendor,product,edition,entitlement_reference,entitlement_hash,metric,capacity,unit,starts_at,expires_at,support_expires_at,source_url,metadata_json,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(entitlement_hash) DO UPDATE SET vendor=excluded.vendor,product=excluded.product,
      edition=excluded.edition,metric=excluded.metric,capacity=excluded.capacity,unit=excluded.unit,starts_at=excluded.starts_at,
      expires_at=excluded.expires_at,support_expires_at=excluded.support_expires_at,source_url=excluded.source_url,
      metadata_json=excluded.metadata_json,created_by=excluded.created_by,updated_at=datetime('now')`).run(...values);
    return this._entitlementRow(db.prepare('SELECT * FROM license_entitlements WHERE entitlement_hash=?').get(values[4]));
  }
  entitlements(actor) { this._admin(actor); const db = this._db(); return db.prepare('SELECT * FROM license_entitlements ORDER BY vendor,product,edition').all().map(row => ({
    ...this._entitlementRow(row), assignments: db.prepare('SELECT * FROM license_assignments WHERE entitlement_id=? ORDER BY resource_type,resource_ref').all(row.id)
      .map(item => ({ id: item.id, resourceType: item.resource_type, resourceRef: item.resource_ref, assignedCapacity: item.assigned_capacity, owner: item.owner, environment: item.environment })),
    latestUsage: this._usageRow(db.prepare('SELECT * FROM license_usage_observations WHERE entitlement_id=? ORDER BY observed_at DESC,id DESC LIMIT 1').get(row.id)),
  })); }
  assignEntitlement(id, body = {}, actor) {
    this._admin(actor); const db = this._db(); const entitlementId = integer(id, 'entitlementId', 1);
    if (!db.prepare('SELECT 1 FROM license_entitlements WHERE id=?').get(entitlementId)) throw fail('Entitlement not found', 404, 'ENTITLEMENT_NOT_FOUND');
    if (!['production','nonproduction'].includes(body.environment)) throw fail('environment is invalid');
    const values = [entitlementId, string(body.resourceType, 'resourceType', 100, SAFE_NAME), string(body.resourceRef, 'resourceRef', 500, SAFE_REF),
      number(body.assignedCapacity, 'assignedCapacity', 0), string(body.owner, 'owner', 160, SAFE_NAME), body.environment, actor.id];
    db.prepare(`INSERT INTO license_assignments (entitlement_id,resource_type,resource_ref,assigned_capacity,owner,environment,created_by)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(entitlement_id,resource_type,resource_ref) DO UPDATE SET assigned_capacity=excluded.assigned_capacity,
      owner=excluded.owner,environment=excluded.environment,created_by=excluded.created_by,updated_at=datetime('now')`).run(...values);
    return this.entitlements(actor).find(item => item.id === entitlementId);
  }
  _usageRow(row) { return row && { id: row.id, entitlementId: row.entitlement_id, usedCapacity: row.used_capacity,
    assignedCapacity: row.assigned_capacity, evidenceHash: row.evidence_hash, evidence: parse(row.evidence_json, {}), observedAt: row.observed_at }; }
  recordLicenseUsage(id, body = {}, actor) {
    this._admin(actor); const db = this._db(); const entitlementId = integer(id, 'entitlementId', 1);
    if (!db.prepare('SELECT 1 FROM license_entitlements WHERE id=?').get(entitlementId)) throw fail('Entitlement not found', 404, 'ENTITLEMENT_NOT_FOUND');
    const evidence = object(body.evidence); bounded(evidence, 'evidence'); secretFree(evidence); const observedAt = timestamp(body.observedAt || new Date(), 'observedAt');
    const used = number(body.usedCapacity, 'usedCapacity', 0); const assigned = number(body.assignedCapacity, 'assignedCapacity', 0);
    const digest = hash({ entitlementId, used, assigned, evidence });
    db.prepare(`INSERT OR IGNORE INTO license_usage_observations
      (entitlement_id,used_capacity,assigned_capacity,evidence_hash,evidence_json,observed_at,created_by) VALUES (?,?,?,?,?,?,?)`)
      .run(entitlementId, used, assigned, digest, stable(evidence), observedAt, actor.id);
    return this._usageRow(db.prepare('SELECT * FROM license_usage_observations WHERE entitlement_id=? AND observed_at=? AND evidence_hash=?').get(entitlementId, observedAt, digest));
  }
  saveLicenseAlertPolicy(body = {}, actor) {
    this._admin(actor); const entitlementId = body.entitlementId == null ? null : integer(body.entitlementId, 'entitlementId', 1); const db = this._db();
    if (entitlementId && !db.prepare('SELECT 1 FROM license_entitlements WHERE id=?').get(entitlementId)) throw fail('Entitlement not found', 404);
    const saved = db.prepare(`INSERT INTO license_alert_policies
      (name,entitlement_id,over_percent,under_percent,expiry_days,forecast_days,enabled,created_by) VALUES (?,?,?,?,?,?,?,?)`)
      .run(string(body.name, 'name', 160, SAFE_NAME), entitlementId, number(body.overPercent ?? 100, 'overPercent', 1, 1000),
        number(body.underPercent ?? 20, 'underPercent', 0, 100), integer(body.expiryDays ?? 60, 'expiryDays', 0, 3650),
        integer(body.forecastDays ?? 30, 'forecastDays', 1, 365), body.enabled === false ? 0 : 1, actor.id);
    return this._licensePolicy(db.prepare('SELECT * FROM license_alert_policies WHERE id=?').get(saved.lastInsertRowid));
  }
  _licensePolicy(row) { return row && { id: row.id, name: row.name, entitlementId: row.entitlement_id,
    overPercent: row.over_percent, underPercent: row.under_percent, expiryDays: row.expiry_days,
    forecastDays: row.forecast_days, enabled: !!row.enabled }; }
  licensePolicies(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM license_alert_policies ORDER BY name').all().map(row => this._licensePolicy(row)); }
  evaluateLicenseAlerts(actor) {
    this._admin(actor); const db = this._db(); let created = 0;
    for (const policyRow of db.prepare('SELECT * FROM license_alert_policies WHERE enabled=1').all()) {
      const policy = this._licensePolicy(policyRow); const entitlements = db.prepare(`SELECT * FROM license_entitlements ${policy.entitlementId ? 'WHERE id=?' : ''}`).all(...(policy.entitlementId ? [policy.entitlementId] : []));
      for (const entitlementRow of entitlements) {
        const entitlement = this._entitlementRow(entitlementRow); const observations = db.prepare('SELECT * FROM license_usage_observations WHERE entitlement_id=? ORDER BY observed_at DESC,id DESC LIMIT 2').all(entitlement.id).map(row => this._usageRow(row));
        const latest = observations[0]; const assigned = db.prepare('SELECT COALESCE(SUM(assigned_capacity),0) total FROM license_assignments WHERE entitlement_id=?').get(entitlement.id).total;
        const candidates = [];
        if (entitlement.capacity > 0 && assigned / entitlement.capacity * 100 > policy.overPercent) candidates.push(['over_assignment','critical',`Assigned ${assigned} exceeds entitlement capacity ${entitlement.capacity}`, { assigned, capacity: entitlement.capacity }]);
        if (latest && entitlement.capacity > 0 && latest.usedCapacity / entitlement.capacity * 100 > policy.overPercent) candidates.push(['over_usage','critical',`Observed use ${latest.usedCapacity} exceeds configured threshold`, { usageId: latest.id, used: latest.usedCapacity, capacity: entitlement.capacity }]);
        if (entitlement.capacity > 0 && assigned / entitlement.capacity * 100 < policy.underPercent) candidates.push(['under_assignment','info',`Only ${assigned} of ${entitlement.capacity} is assigned`, { assigned, capacity: entitlement.capacity }]);
        const expiryDays = entitlement.expiresAt ? Math.ceil((Date.parse(entitlement.expiresAt) - Date.now()) / 86400000) : null;
        if (expiryDays != null && expiryDays <= policy.expiryDays) candidates.push(['expiry',expiryDays <= 7 ? 'critical' : 'warning',`Entitlement expires in ${expiryDays} days`, { expiryDays, expiresAt: entitlement.expiresAt }]);
        if (observations.length === 2 && entitlement.capacity > 0) {
          const days = (Date.parse(observations[0].observedAt) - Date.parse(observations[1].observedAt)) / 86400000;
          const slope = days > 0 ? (observations[0].usedCapacity - observations[1].usedCapacity) / days : 0;
          const daysToCapacity = slope > 0 ? (entitlement.capacity - observations[0].usedCapacity) / slope : Infinity;
          if (daysToCapacity >= 0 && daysToCapacity <= policy.forecastDays) candidates.push(['forecast','warning',`Usage may reach capacity in ${Math.ceil(daysToCapacity)} days`, { slopePerDay: slope, daysToCapacity }]);
        }
        for (const [type, severity, message, evidence] of candidates) {
          const evidenceHash = hash({ type, entitlementId: entitlement.id, evidence });
          created += db.prepare(`INSERT OR IGNORE INTO license_alerts
            (policy_id,entitlement_id,alert_type,severity,message,evidence_hash,evidence_json) VALUES (?,?,?,?,?,?,?)`)
            .run(policy.id, entitlement.id, type, severity, message, evidenceHash, stable(evidence)).changes;
        }
      }
    }
    return { created, alerts: this.licenseAlerts(actor), licenseChangesApplied: 0 };
  }
  licenseAlerts(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM license_alerts ORDER BY id DESC').all().map(row => ({
    id: row.id, policyId: row.policy_id, entitlementId: row.entitlement_id, type: row.alert_type,
    severity: row.severity, state: row.state, message: row.message, evidenceHash: row.evidence_hash,
    evidence: parse(row.evidence_json, {}), createdAt: row.created_at })); }

  _snapshotRow(row) { return row && { id: row.id, providerHostId: row.provider_host_id, scopeRef: row.scope_ref,
    sourceKind: row.source_kind, configuration: parse(row.configuration_json, {}), configurationHash: row.configuration_hash,
    redactedPaths: parse(row.redacted_paths_json, []), observedAt: row.observed_at, createdAt: row.created_at }; }
  saveConfigurationSnapshot(body = {}, actor) {
    this._admin(actor); if (!['actual','desired','imported'].includes(body.sourceKind)) throw fail('sourceKind is invalid');
    if (!body.configuration || typeof body.configuration !== 'object' || Array.isArray(body.configuration)) throw fail('configuration must be an object');
    const raw = body.configuration; bounded(raw, 'configuration', 2 * 1024 * 1024); const redactedPaths = [];
    const configuration = canonical(redactSecrets(raw, '', redactedPaths)); bounded(configuration, 'redactedConfiguration', 2 * 1024 * 1024);
    const values = [integer(body.providerHostId ?? 0, 'providerHostId'), string(body.scopeRef, 'scopeRef', 500, SAFE_REF),
      body.sourceKind, stable(configuration), hash(configuration), stable(redactedPaths), timestamp(body.observedAt || new Date(), 'observedAt'), actor.id]; const db = this._db();
    db.prepare(`INSERT OR IGNORE INTO host_configuration_snapshots
      (provider_host_id,scope_ref,source_kind,configuration_json,configuration_hash,redacted_paths_json,observed_at,created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(...values);
    return this._snapshotRow(db.prepare(`SELECT * FROM host_configuration_snapshots
      WHERE provider_host_id=? AND scope_ref=? AND source_kind=? AND configuration_hash=?`).get(values[0], values[1], values[2], values[4]));
  }
  snapshots(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM host_configuration_snapshots ORDER BY observed_at DESC,id DESC LIMIT 500').all().map(row => this._snapshotRow(row)); }
  _diffRow(row) { return row && { id: row.id, fromSnapshotId: row.from_snapshot_id, toSnapshotId: row.to_snapshot_id,
    changes: parse(row.changes_json, []), summary: parse(row.summary_json, {}), diffHash: row.diff_hash, createdAt: row.created_at }; }
  createConfigurationDiff(body = {}, actor) {
    this._admin(actor); const db = this._db(); const from = this._snapshotRow(db.prepare('SELECT * FROM host_configuration_snapshots WHERE id=?').get(integer(body.fromSnapshotId, 'fromSnapshotId', 1)));
    const to = this._snapshotRow(db.prepare('SELECT * FROM host_configuration_snapshots WHERE id=?').get(integer(body.toSnapshotId, 'toSnapshotId', 1)));
    if (!from || !to) throw fail('Both snapshots are required', 404, 'SNAPSHOT_NOT_FOUND');
    if (from.providerHostId !== to.providerHostId || from.scopeRef !== to.scopeRef) throw fail('Snapshots must describe the same host and scope', 409, 'SNAPSHOT_SCOPE_MISMATCH');
    const changes = configurationDiff(from.configuration, to.configuration); if (changes.length > 10000) throw fail('Configuration diff exceeds 10000 changes', 413, 'DIFF_TOO_LARGE');
    const summary = { added: changes.filter(item => item.change === 'added').length, changed: changes.filter(item => item.change === 'changed').length,
      removed: changes.filter(item => item.change === 'removed').length, redactedPaths: [...new Set([...from.redactedPaths, ...to.redactedPaths])].sort() };
    const digest = hash({ from: from.configurationHash, to: to.configurationHash, changes });
    db.prepare(`INSERT OR IGNORE INTO host_configuration_diffs
      (from_snapshot_id,to_snapshot_id,changes_json,summary_json,diff_hash,created_by) VALUES (?,?,?,?,?,?)`)
      .run(from.id, to.id, stable(changes), stable(summary), digest, actor.id);
    return { ...this._diffRow(db.prepare('SELECT * FROM host_configuration_diffs WHERE from_snapshot_id=? AND to_snapshot_id=? AND diff_hash=?').get(from.id, to.id, digest)), remediationStarted: false };
  }
  diffs(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM host_configuration_diffs ORDER BY id DESC LIMIT 500').all().map(row => this._diffRow(row)); }
  saveDriftPolicy(body = {}, actor) {
    this._admin(actor); const rules = object(body.rules); const normalized = {
      allowed: list(rules.allowed || [], 'rules.allowed', 500, true, SAFE_FIELD),
      denied: list(rules.denied || [], 'rules.denied', 500, true, SAFE_FIELD),
      ignored: list(rules.ignored || [], 'rules.ignored', 500, true, SAFE_FIELD),
    }; const db = this._db();
    const saved = db.prepare(`INSERT INTO host_drift_policies
      (name,provider_host_id,scope_pattern,owner,rules_json,enabled,created_by) VALUES (?,?,?,?,?,?,?)`)
      .run(string(body.name, 'name', 160, SAFE_NAME), integer(body.providerHostId ?? 0, 'providerHostId'),
        string(body.scopePattern, 'scopePattern', 300, SAFE_FIELD), string(body.owner, 'owner', 160, SAFE_NAME),
        stable(normalized), body.enabled === false ? 0 : 1, actor.id);
    return this._driftPolicy(db.prepare('SELECT * FROM host_drift_policies WHERE id=?').get(saved.lastInsertRowid));
  }
  _driftPolicy(row) { return row && { id: row.id, name: row.name, providerHostId: row.provider_host_id,
    scopePattern: row.scope_pattern, owner: row.owner, rules: parse(row.rules_json, {}), enabled: !!row.enabled }; }
  driftPolicies(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM host_drift_policies ORDER BY name').all().map(row => this._driftPolicy(row)); }
  evaluateDrift(policyId, diffId, actor) {
    this._admin(actor); const db = this._db(); const policy = this._driftPolicy(db.prepare('SELECT * FROM host_drift_policies WHERE id=?').get(integer(policyId, 'policyId', 1)));
    const diff = this._diffRow(db.prepare('SELECT * FROM host_configuration_diffs WHERE id=?').get(integer(diffId, 'diffId', 1)));
    if (!policy || !diff) throw fail('Drift policy and diff are required', 404, 'DRIFT_INPUT_NOT_FOUND');
    const classifications = diff.changes.map(change => { const match = patterns => patterns.some(pattern => globMatch(pattern, change.path));
      return { ...change, disposition: match(policy.rules.ignored) ? 'ignored' : match(policy.rules.denied) ? 'denied' : match(policy.rules.allowed) ? 'allowed' : 'review' }; });
    const state = classifications.some(item => item.disposition === 'denied') ? 'denied' : classifications.some(item => item.disposition === 'review') ? 'review' : 'compliant';
    const evidenceHash = hash({ policyId: policy.id, diffId: diff.id, classifications });
    db.prepare(`INSERT OR IGNORE INTO host_drift_assessments
      (policy_id,diff_id,state,classifications_json,evidence_hash,created_by) VALUES (?,?,?,?,?,?)`)
      .run(policy.id, diff.id, state, stable(classifications), evidenceHash, actor.id);
    return { policy, diffId: diff.id, state, classifications, evidenceHash, remediationStarted: false };
  }
  saveHostProfile(body = {}, actor) {
    this._admin(actor); const baseline = object(body.baseline); bounded(baseline, 'baseline'); secretFree(baseline, 'baseline');
    const normalized = canonical(Object.fromEntries(Object.entries(baseline).map(([path, expected]) => [string(path, `baseline.${path}`, 300, SAFE_FIELD), expected])));
    const severity = body.severity || 'warning'; if (!['info','warning','critical'].includes(severity)) throw fail('severity is invalid'); const db = this._db();
    const saved = db.prepare(`INSERT INTO host_profiles
      (name,version,scope_pattern,baseline_json,baseline_hash,severity,created_by) VALUES (?,?,?,?,?,?,?)`)
      .run(string(body.name, 'name', 160, SAFE_NAME), string(body.version, 'version', 80, SAFE_REF),
        string(body.scopePattern, 'scopePattern', 300, SAFE_FIELD), stable(normalized), hash(normalized), severity, actor.id);
    return this._profileRow(db.prepare('SELECT * FROM host_profiles WHERE id=?').get(saved.lastInsertRowid));
  }
  _profileRow(row) { return row && { id: row.id, name: row.name, version: row.version, scopePattern: row.scope_pattern,
    baseline: parse(row.baseline_json, {}), baselineHash: row.baseline_hash, severity: row.severity }; }
  profiles(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM host_profiles ORDER BY name,version DESC').all().map(row => this._profileRow(row)); }
  assessHostProfile(profileId, snapshotId, actor) {
    this._admin(actor); const db = this._db(); const profile = this._profileRow(db.prepare('SELECT * FROM host_profiles WHERE id=?').get(integer(profileId, 'profileId', 1)));
    const snapshot = this._snapshotRow(db.prepare('SELECT * FROM host_configuration_snapshots WHERE id=?').get(integer(snapshotId, 'snapshotId', 1)));
    if (!profile || !snapshot) throw fail('Profile and snapshot are required', 404, 'PROFILE_INPUT_NOT_FOUND');
    if (!globMatch(profile.scopePattern, snapshot.scopeRef)) throw fail('Profile does not match snapshot scope', 409, 'PROFILE_SCOPE_MISMATCH');
    const findings = Object.entries(profile.baseline).map(([path, expected]) => { const actual = getPath(snapshot.configuration, path);
      return { path, expected, actual: actual === undefined ? null : actual, state: actual === undefined ? 'unknown' : stable(actual) === stable(expected) ? 'compliant' : 'noncompliant' }; });
    const state = findings.some(item => item.state === 'noncompliant') ? 'noncompliant' : findings.some(item => item.state === 'unknown') ? 'unknown' : 'compliant';
    const remediation = findings.filter(item => item.state !== 'compliant').map(item => ({ path: item.path, desired: item.expected,
      reason: item.state, action: 'review_and_apply_through_durable_operation' })); const evidenceHash = hash({ profile: profile.baselineHash, snapshot: snapshot.configurationHash, findings });
    db.prepare(`INSERT OR IGNORE INTO host_profile_assessments
      (profile_id,snapshot_id,state,findings_json,evidence_hash,remediation_plan_json,created_by) VALUES (?,?,?,?,?,?,?)`)
      .run(profile.id, snapshot.id, state, stable(findings), evidenceHash, stable(remediation), actor.id);
    return { profile, snapshotId: snapshot.id, state, findings, remediationPlan: remediation, evidenceHash, remediationStarted: false };
  }

  _mirrorRow(row) { return row && { id: row.id, name: row.name, siteRef: row.site_ref, adapterKey: row.adapter_key,
    rootReference: row.root_reference, trustRoots: parse(row.trust_roots_json, []), maxBytes: row.max_bytes,
    state: row.state, createdAt: row.created_at }; }
  saveMirror(body = {}, actor) {
    this._admin(actor); const trustRoots = list(body.trustRoots, 'trustRoots', 100); const db = this._db();
    const saved = db.prepare(`INSERT INTO airgap_mirrors
      (name,site_ref,adapter_key,root_reference,trust_roots_json,max_bytes,state,created_by) VALUES (?,?,?,?,?,?,'ready',?)`)
      .run(string(body.name, 'name', 160, SAFE_NAME), string(body.siteRef, 'siteRef', 300, SAFE_REF),
        string(body.adapterKey, 'adapterKey', 120, SAFE_NAME).toLowerCase(), locationReference(body.rootReference, 'rootReference'),
        stable(trustRoots), integer(body.maxBytes, 'maxBytes', 1, 1099511627776), actor.id);
    return this._mirrorRow(db.prepare('SELECT * FROM airgap_mirrors WHERE id=?').get(saved.lastInsertRowid));
  }
  mirrors(actor) { this._admin(actor); const db = this._db(); return db.prepare('SELECT * FROM airgap_mirrors ORDER BY name').all().map(row => ({
    ...this._mirrorRow(row), artifacts: db.prepare('SELECT * FROM airgap_mirror_artifacts WHERE mirror_id=? ORDER BY artifact_kind,artifact_name,artifact_version').all(row.id)
      .map(item => ({ id: item.id, kind: item.artifact_kind, name: item.artifact_name, version: item.artifact_version,
        digest: item.digest, signatureIdentity: item.signature_identity, signatureVerified: !!item.signature_verified,
        byteSize: item.byte_size, localReference: item.local_reference, sourceUrl: item.source_url, metadata: parse(item.metadata_json, {}) })) })); }
  async syncMirror(id, body = {}, actor) {
    this._admin(actor); const db = this._db(); const mirror = this._mirrorRow(db.prepare('SELECT * FROM airgap_mirrors WHERE id=?').get(integer(id, 'mirrorId', 1)));
    if (!mirror) throw fail('Air-gap mirror not found', 404, 'MIRROR_NOT_FOUND');
    if (mirror.state === 'disabled') throw fail('Air-gap mirror is disabled', 409, 'MIRROR_DISABLED');
    if (!Array.isArray(body.artifacts) || !body.artifacts.length || body.artifacts.length > 1000) throw fail('artifacts must contain 1-1000 entries');
    const requested = body.artifacts.map((item, index) => { if (!['package','image','advisory'].includes(item.kind)) throw fail(`artifacts[${index}].kind is invalid`);
      return { kind: item.kind, name: string(item.name, `artifacts[${index}].name`, 300, SAFE_REF), version: string(item.version, `artifacts[${index}].version`, 160, SAFE_REF),
        digest: string(item.digest, `artifacts[${index}].digest`, 64, DIGEST), signatureIdentity: string(item.signatureIdentity, `artifacts[${index}].signatureIdentity`, 300, SAFE_REF),
        sourceUrl: httpsUrl(item.sourceUrl, `artifacts[${index}].sourceUrl`) }; });
    bounded(requested, 'artifacts'); const run = db.prepare(`INSERT INTO airgap_mirror_runs
      (mirror_id,state,requested_json,created_by) VALUES (?,?,?,?)`).run(mirror.id, this._mirrorAdapters[mirror.adapterKey] ? 'running' : 'unsupported', stable(requested), actor.id);
    const runId = Number(run.lastInsertRowid); const adapter = this._mirrorAdapters[mirror.adapterKey];
    if (!adapter) return { runId, state: 'unsupported', artifactsAdded: 0, bytesAdded: 0, reason: `No mirror adapter is registered for ${mirror.adapterKey}` };
    db.prepare("UPDATE airgap_mirrors SET state='syncing',updated_at=datetime('now') WHERE id=?").run(mirror.id);
    let response;
    try { response = object(await adapter({ mirror, requested })); } catch (error) { response = { artifacts: [], error: String(error.message || error).slice(0, 600) }; }
    const returned = Array.isArray(response.artifacts) ? response.artifacts : []; const failures = []; const accepted = [];
    for (const item of returned) {
      try {
        const match = requested.find(candidate => candidate.kind === item.kind && candidate.name === item.name && candidate.version === item.version && candidate.digest === item.digest);
        if (!match) throw fail('Adapter returned an unrequested artifact');
        if (item.signatureVerified !== true || !mirror.trustRoots.includes(item.signatureIdentity) || item.signatureIdentity !== match.signatureIdentity) throw fail('Artifact signature trust failed');
        const metadata = object(item.metadata); bounded(metadata, 'artifact.metadata'); secretFree(metadata, 'artifact.metadata');
        accepted.push({ ...match, signatureVerified: true, byteSize: integer(item.byteSize, 'artifact.byteSize', 0),
          localReference: locationReference(item.localReference, 'artifact.localReference'), metadata });
      } catch (error) { failures.push({ name: item?.name || 'unknown', error: String(error.message || error).slice(0, 300) }); }
    }
    let bytesAdded = accepted.reduce((total, item) => total + item.byteSize, 0); const existing = db.prepare('SELECT COALESCE(SUM(byte_size),0) total FROM airgap_mirror_artifacts WHERE mirror_id=?').get(mirror.id).total;
    if (existing + bytesAdded > mirror.maxBytes) { failures.push({ error: 'Mirror capacity would be exceeded' }); accepted.length = 0; bytesAdded = 0; }
    const state = accepted.length === requested.length && !failures.length ? 'succeeded' : accepted.length ? 'partial' : 'failed';
    let artifactsAdded = 0; db.transaction(() => {
      const insert = db.prepare(`INSERT OR IGNORE INTO airgap_mirror_artifacts
        (mirror_id,artifact_kind,artifact_name,artifact_version,digest,signature_identity,signature_verified,byte_size,local_reference,source_url,metadata_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      bytesAdded = 0; for (const item of accepted) { const result = insert.run(mirror.id, item.kind, item.name, item.version, item.digest, item.signatureIdentity, 1, item.byteSize, item.localReference, item.sourceUrl, stable(item.metadata));
        artifactsAdded += result.changes; if (result.changes) bytesAdded += item.byteSize; }
      db.prepare("UPDATE airgap_mirror_runs SET state=?,result_json=?,bytes_added=?,completed_at=datetime('now') WHERE id=?")
        .run(state, stable({ accepted: accepted.length, failures }), bytesAdded, runId);
      db.prepare("UPDATE airgap_mirrors SET state=?,updated_at=datetime('now') WHERE id=?").run(state === 'succeeded' ? 'ready' : 'degraded', mirror.id);
    })();
    return { runId, state, artifactsAdded, bytesAdded, failures, unsignedArtifactsAccepted: 0 };
  }

  async collectSupportBundle(body = {}, actor) {
    this._admin(actor); const targets = list(body.targetRefs, 'targetRefs', 50); const sections = list(body.sections, 'sections', 20);
    const allowed = ['logs','configuration','metrics','tasks','events']; if (sections.some(item => !allowed.includes(item))) throw fail('sections contains an unsupported value');
    const adapterKey = string(body.adapterKey, 'adapterKey', 120, SAFE_NAME).toLowerCase(); const expiresAt = timestamp(body.expiresAt, 'expiresAt', true);
    const redaction = { secretKeys: true, maxNodeBytes: integer(body.maxNodeBytes ?? 10 * 1024 * 1024, 'maxNodeBytes', 1024, 100 * 1024 * 1024) };
    const adapter = this._supportCollectors[adapterKey]; const db = this._db(); const saved = db.prepare(`INSERT INTO support_bundle_requests
      (name,adapter_key,state,target_refs_json,requested_sections_json,redaction_json,expires_at,created_by) VALUES (?,?,?,?,?,?,?,?)`)
      .run(string(body.name, 'name', 160, SAFE_NAME), adapterKey, adapter ? 'collecting' : 'unsupported', stable(targets), stable(sections), stable(redaction), expiresAt, actor.id);
    const requestId = Number(saved.lastInsertRowid);
    if (!adapter) return { requestId, state: 'unsupported', nodes: [], reason: `No support collector is registered for ${adapterKey}` };
    const nodes = [];
    for (const targetRef of targets) {
      try {
        const raw = object(await adapter({ targetRef, sections, maxBytes: redaction.maxNodeBytes })); bounded(raw, `collector.${targetRef}`, redaction.maxNodeBytes);
        const redactedPaths = []; const evidence = canonical(redactSecrets(raw.evidence || raw, '', redactedPaths)); bounded(evidence, `collector.${targetRef}.redacted`, redaction.maxNodeBytes);
        const byteSize = Buffer.byteLength(stable(evidence)); nodes.push({ targetRef, state: 'collected', evidence: { data: evidence, redactedPaths }, byteSize });
      } catch (error) { nodes.push({ targetRef, state: 'failed', evidence: { error: String(error.message || error).slice(0, 600) }, byteSize: 0 }); }
    }
    const manifest = { requestId, adapterKey, sections, nodes: nodes.map(item => ({ targetRef: item.targetRef, state: item.state,
      evidenceHash: hash(item.evidence), byteSize: item.byteSize })), expiresAt }; const checksum = hash(manifest); const byteSize = nodes.reduce((total, item) => total + item.byteSize, 0);
    const state = nodes.every(item => item.state === 'collected') ? 'ready' : nodes.some(item => item.state === 'collected') ? 'partial' : 'failed';
    db.transaction(() => {
      const insert = db.prepare(`INSERT INTO support_bundle_nodes
        (request_id,target_ref,state,evidence_json,evidence_hash,byte_size) VALUES (?,?,?,?,?,?)`);
      for (const node of nodes) insert.run(requestId, node.targetRef, node.state, stable(node.evidence), hash(node.evidence), node.byteSize);
      db.prepare(`UPDATE support_bundle_requests SET state=?,manifest_json=?,checksum_sha256=?,byte_size=?,artifact_reference=?,completed_at=datetime('now') WHERE id=?`)
        .run(state, stable(manifest), checksum, byteSize, `support-bundle:${requestId}:${checksum}`, requestId);
    })();
    return { requestId, state, nodes: manifest.nodes, checksumSha256: checksum, byteSize,
      artifactReference: `support-bundle:${requestId}:${checksum}`, expiresAt, secretsReturned: false };
  }
  supportBundles(actor) { this._admin(actor); const db = this._db(); const now = Date.now(); return db.prepare('SELECT * FROM support_bundle_requests ORDER BY id DESC').all().map(row => ({
    id: row.id, name: row.name, adapterKey: row.adapter_key, state: Date.parse(row.expires_at) <= now ? 'expired' : row.state,
    targetRefs: parse(row.target_refs_json, []), sections: parse(row.requested_sections_json, []), redaction: parse(row.redaction_json, {}),
    manifest: parse(row.manifest_json, {}), checksumSha256: row.checksum_sha256, byteSize: row.byte_size,
    artifactReference: row.artifact_reference, expiresAt: row.expires_at, createdAt: row.created_at })); }

  saveValidationPack(body = {}, actor) {
    this._admin(actor); if (!Array.isArray(body.checks) || !body.checks.length || body.checks.length > 100) throw fail('checks must contain 1-100 entries');
    const seen = new Set(); const checks = body.checks.map((item, index) => {
      const key = string(item.key, `checks[${index}].key`, 120, SAFE_NAME); if (seen.has(key)) throw fail(`Duplicate check ${key}`); seen.add(key);
      const category = item.category; if (!VALIDATION_CATEGORIES.includes(category)) throw fail(`checks[${index}].category is invalid`);
      const config = object(item.config); bounded(config, `checks[${index}].config`); secretFree(config, `checks[${index}].config`);
      return { key, category, adapterKey: string(item.adapterKey, `checks[${index}].adapterKey`, 120, SAFE_NAME).toLowerCase(), required: item.required !== false, config: canonical(config) };
    });
    const normalized = { name: string(body.name, 'name', 160, SAFE_NAME), version: string(body.version, 'version', 80, SAFE_REF), checks };
    const db = this._db(); const saved = db.prepare(`INSERT INTO post_upgrade_validation_packs
      (name,version,checks_json,pack_hash,created_by) VALUES (?,?,?,?,?)`).run(normalized.name, normalized.version, stable(checks), hash(normalized), actor.id);
    return this._validationPack(db.prepare('SELECT * FROM post_upgrade_validation_packs WHERE id=?').get(saved.lastInsertRowid));
  }
  _validationPack(row) { return row && { id: row.id, name: row.name, version: row.version,
    checks: parse(row.checks_json, []), packHash: row.pack_hash, createdAt: row.created_at }; }
  validationPacks(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM post_upgrade_validation_packs ORDER BY name,version DESC').all().map(row => this._validationPack(row)); }
  async runValidationPack(id, body = {}, actor) {
    this._admin(actor); const db = this._db(); const pack = this._validationPack(db.prepare('SELECT * FROM post_upgrade_validation_packs WHERE id=?').get(integer(id, 'packId', 1)));
    if (!pack) throw fail('Validation pack not found', 404, 'VALIDATION_PACK_NOT_FOUND');
    const campaignId = body.campaignId == null ? null : integer(body.campaignId, 'campaignId', 1);
    if (campaignId && !db.prepare("SELECT 1 FROM lifecycle_change_campaigns WHERE id=? AND state='completed'").get(campaignId)) throw fail('Completed lifecycle campaign not found', 409, 'COMPLETED_CAMPAIGN_REQUIRED');
    const targetRef = string(body.targetRef, 'targetRef', 500, SAFE_REF); const context = object(body.context); bounded(context, 'context'); secretFree(context, 'context');
    const results = [];
    for (const check of pack.checks) {
      const adapter = this._validationAdapters[check.adapterKey]; if (!adapter) { results.push({ key: check.key, category: check.category, required: check.required, state: 'unsupported', evidence: {} }); continue; }
      try { const evidence = object(await adapter({ check, targetRef, campaignId, context: canonical(context) })); bounded(evidence, `validation.${check.key}`); secretFree(evidence, `validation.${check.key}`);
        results.push({ key: check.key, category: check.category, required: check.required, state: evidence.passed === true ? 'passed' : 'failed', evidence });
      } catch (error) { results.push({ key: check.key, category: check.category, required: check.required, state: 'failed', evidence: { error: String(error.message || error).slice(0, 600) } }); }
    }
    const state = results.some(item => item.required && item.state !== 'passed') ? 'failed' : results.some(item => item.state === 'unsupported') ? 'partial' : 'passed';
    const evidenceHash = hash({ packHash: pack.packHash, campaignId, targetRef, results }); const completedAt = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO post_upgrade_validation_runs
      (pack_id,campaign_id,target_ref,state,results_json,evidence_hash,created_by,completed_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(pack.id, campaignId, targetRef, state, stable(results), evidenceHash, actor.id, completedAt);
    return { pack, campaignId, targetRef, state, results, evidenceHash, completedAt, providerMutationsStarted: 0 };
  }
  validationRuns(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM post_upgrade_validation_runs ORDER BY id DESC LIMIT 500').all().map(row => ({
    id: row.id, packId: row.pack_id, campaignId: row.campaign_id, targetRef: row.target_ref,
    state: row.state, results: parse(row.results_json, []), evidenceHash: row.evidence_hash, completedAt: row.completed_at })); }

  overview(actor) {
    this._admin(actor); const renewals = this.renewalJobs(actor); const entitlements = this.entitlements(actor);
    const alerts = this.licenseAlerts(actor); const snapshots = this.snapshots(actor); const diffs = this.diffs(actor);
    const mirrors = this.mirrors(actor); const bundles = this.supportBundles(actor); const validationRuns = this.validationRuns(actor);
    return { capabilities: { automatedCertificateRenewal: true, licenseEntitlementInventory: true, licenseUsageAlerts: true,
      redactedConfigurationSnapshots: true, configurationDiff: true, driftPolicy: true, hostProfileCompliance: true,
      airGapContentMirror: true, supportBundleOrchestration: true, postUpgradeValidation: true }, renewals, entitlements,
    licensePolicies: this.licensePolicies(actor), licenseAlerts: alerts, snapshots, diffs, driftPolicies: this.driftPolicies(actor),
    profiles: this.profiles(actor), mirrors, supportBundles: bundles, validationPacks: this.validationPacks(actor), validationRuns,
    summary: { renewalAttention: renewals.filter(item => ['rollback_required','failed','unsupported'].includes(item.state)).length,
      openLicenseAlerts: alerts.filter(item => item.state === 'open').length, configurationSnapshots: snapshots.length,
      deniedDrift: this._db().prepare("SELECT COUNT(*) count FROM host_drift_assessments WHERE state='denied'").get().count,
      degradedMirrors: mirrors.filter(item => item.state === 'degraded').length,
      activeBundles: bundles.filter(item => ['collecting','ready','partial'].includes(item.state)).length,
      failedValidations: validationRuns.filter(item => item.state === 'failed').length } };
  }
}

const service = new LifecycleAssuranceService();
module.exports = service;
module.exports.LifecycleAssuranceService = LifecycleAssuranceService;
module.exports.LifecycleAssuranceError = LifecycleAssuranceError;
module.exports._internals = { canonical, stable, hash, redactSecrets, configurationDiff, globMatch, flatten };
