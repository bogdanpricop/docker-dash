'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,159}$/;
const SAFE_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.:+/@ -]{0,299}$/;
const SECRET_KEY = /password|secret|token|credential|private.?key|authorization|cookie/i;

class LifecycleMaintenanceError extends Error {
  constructor(message, status = 400, code = 'LIFECYCLE_MAINTENANCE_ERROR', details) {
    super(message); this.name = 'LifecycleMaintenanceError'; this.status = status; this.code = code; this.details = details;
  }
}

const fail = (message, status, code, details) => new LifecycleMaintenanceError(message, status, code, details);
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const string = (value, key, max = 300, pattern) => {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || (pattern && !pattern.test(result))) throw fail(`${key} is invalid`);
  return result;
};
const optionalString = (value, key, max = 300, pattern) => value == null || value === '' ? null : string(value, key, max, pattern);
const integer = (value, key, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const result = Number(value); if (!Number.isSafeInteger(result) || result < min || result > max) throw fail(`${key} must be an integer between ${min} and ${max}`); return result;
};
function bounded(value, key, max = 512 * 1024) {
  let encoded; try { encoded = JSON.stringify(value); } catch { throw fail(`${key} must be JSON serializable`); }
  if (Buffer.byteLength(encoded) > max) throw fail(`${key} exceeds ${max} bytes`, 413, 'LIFECYCLE_DOCUMENT_TOO_LARGE');
}
function secretFree(value, path = 'evidence') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw fail(`${path}.${key} may not contain secret material`, 400, 'LIFECYCLE_SECRET_FIELD');
    secretFree(child, `${path}.${key}`);
  }
}
function timestamp(value, key, future = false) {
  const date = new Date(value); if (Number.isNaN(date.getTime())) throw fail(`${key} must be an ISO timestamp`);
  if (future && date.getTime() <= Date.now()) throw fail(`${key} must be in the future`);
  return date.toISOString();
}
function timezone(value) {
  const result = string(value, 'timezone', 100);
  try { new Intl.DateTimeFormat('en', { timeZone: result }).format(); } catch { throw fail('timezone is not a supported IANA timezone'); }
  return result;
}
function httpsUrl(value, key = 'sourceUrl') {
  const result = string(value, key, 1000); let parsed;
  try { parsed = new URL(result); } catch { throw fail(`${key} must be a valid URL`); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) throw fail(`${key} must be credential-free HTTPS`);
  return parsed.toString();
}
function strings(value, key, max = 100) {
  if (!Array.isArray(value) || !value.length || value.length > max) throw fail(`${key} must contain 1-${max} values`);
  return [...new Set(value.map((item, index) => string(item, `${key}[${index}]`, 300, SAFE_REF)))];
}
function planRow(row) { return row && { id: row.id, name: row.name, scopeType: row.scope_type, scopeKey: row.scope_key,
  startsAt: row.starts_at, timezone: row.timezone, durationMinutes: row.duration_minutes, waveSize: row.wave_size,
  evacuation: parse(row.evacuation_json, {}), ownerConstraints: parse(row.owner_constraints_json, {}),
  conflicts: parse(row.conflicts_json, []), state: row.state, planHash: row.plan_hash, approvedAt: row.approved_at, createdAt: row.created_at }; }
function waveRow(row) { return row && { id: row.id, planId: row.plan_id, waveNumber: row.wave_number,
  startsAt: row.starts_at, endsAt: row.ends_at, targets: parse(row.targets_json, []), owners: parse(row.owners_json, []),
  evacuation: parse(row.evacuation_json, {}), state: row.state, evidence: parse(row.evidence_json, {}) }; }
function campaignRow(row) { return row && { id: row.id, kind: row.campaign_kind, name: row.name,
  maintenancePlanId: row.maintenance_plan_id, targetVersion: row.target_version, state: row.state,
  currentStage: row.current_stage, gates: parse(row.gates_json, {}), rollbackPolicy: parse(row.rollback_policy_json, {}),
  planHash: row.plan_hash, pauseReason: row.pause_reason, approvedAt: row.approved_at, createdAt: row.created_at }; }
function targetRow(row) { return row && { id: row.id, campaignId: row.campaign_id, targetRef: row.target_ref,
  providerHostId: row.provider_host_id, stage: row.stage, currentVersion: row.current_version,
  targetVersion: row.target_version, state: row.state, precheck: parse(row.precheck_json, {}),
  protection: parse(row.protection_json, {}), operationId: row.operation_id,
  verification: parse(row.verification_json, {}), rollbackOperationId: row.rollback_operation_id,
  updatedAt: row.updated_at }; }

class LifecycleMaintenanceService {
  constructor(dbProvider = getDb, options = {}) { this._dbProvider = dbProvider; this._livePatchAdapters = options.livePatchAdapters || {}; }
  _db() { return this._dbProvider(); }
  _admin(actor) {
    if (!actor?.id) throw fail('Authenticated user is required', 401, 'AUTH_REQUIRED');
    if (actor.role !== 'admin') throw fail('Administrator permission is required', 403, 'GOVERNANCE_FORBIDDEN');
  }
  _targets(value) {
    if (!Array.isArray(value) || !value.length || value.length > 1000) throw fail('targets must contain 1-1000 entries');
    const seen = new Set(); return value.map((item, index) => {
      const target = { ref: string(item?.ref, `targets[${index}].ref`, 300, SAFE_REF),
        providerHostId: integer(item?.providerHostId ?? 0, `targets[${index}].providerHostId`),
        owner: string(item?.owner, `targets[${index}].owner`, 160, SAFE_NAME),
        availabilityGroup: optionalString(item?.availabilityGroup, `targets[${index}].availabilityGroup`, 160, SAFE_REF),
        evacuationRequired: item?.evacuationRequired === true, evacuable: item?.evacuable !== false,
        estimatedMinutes: integer(item?.estimatedMinutes ?? 30, `targets[${index}].estimatedMinutes`, 1, 1440) };
      if (seen.has(target.ref)) throw fail(`Duplicate target ${target.ref}`); seen.add(target.ref); return target;
    });
  }
  createMaintenancePlan(body = {}, actor) {
    this._admin(actor); const targets = this._targets(body.targets); const scopeType = body.scopeType;
    if (!['host', 'cluster', 'site', 'fleet'].includes(scopeType)) throw fail('scopeType is invalid');
    const startsAt = timestamp(body.startsAt, 'startsAt', true); const durationMinutes = integer(body.durationMinutes, 'durationMinutes', 15, 10080);
    const waveSize = integer(body.waveSize ?? 1, 'waveSize', 1, 100); const maxPerOwner = integer(body.maxConcurrentPerOwner ?? 1, 'maxConcurrentPerOwner', 1, 100);
    const evacuation = { capacityVerified: body.evacuation?.capacityVerified === true,
      destinationRefs: Array.isArray(body.evacuation?.destinationRefs) && body.evacuation.destinationRefs.length
        ? strings(body.evacuation.destinationRefs, 'evacuation.destinationRefs', 100) : [] };
    const conflicts = [];
    for (const target of targets) if (target.evacuationRequired && (!target.evacuable || !evacuation.capacityVerified)) conflicts.push({
      code: target.evacuable ? 'EVACUATION_CAPACITY_UNVERIFIED' : 'TARGET_NOT_EVACUABLE', targetRef: target.ref,
      owner: target.owner, message: 'Required evacuation is not ready' });
    const waves = [];
    for (const target of targets) {
      let chosen = waves.find(wave => wave.targets.length < waveSize
        && wave.targets.filter(item => item.owner === target.owner).length < maxPerOwner
        && (!target.availabilityGroup || !wave.targets.some(item => item.availabilityGroup === target.availabilityGroup)));
      if (!chosen) { chosen = { targets: [] }; waves.push(chosen); }
      chosen.targets.push(target);
    }
    const requiredMinutes = waves.reduce((total, wave) => total + Math.max(...wave.targets.map(target => target.estimatedMinutes)), 0);
    if (requiredMinutes > durationMinutes) conflicts.push({ code: 'WINDOW_TOO_SHORT', requiredMinutes, durationMinutes,
      message: 'Estimated wave duration exceeds the maintenance window' });
    const normalized = { name: string(body.name, 'name', 160, SAFE_NAME), scopeType,
      scopeKey: string(body.scopeKey, 'scopeKey', 300, SAFE_REF), startsAt, timezone: timezone(body.timezone || 'UTC'),
      durationMinutes, waveSize, evacuation, ownerConstraints: { maxConcurrentPerOwner: maxPerOwner }, targets, conflicts };
    const planHash = hash(normalized); const db = this._db();
    try {
      return db.transaction(() => {
        const saved = db.prepare(`INSERT INTO lifecycle_maintenance_plans
          (name,scope_type,scope_key,starts_at,timezone,duration_minutes,wave_size,evacuation_json,owner_constraints_json,
           conflicts_json,state,plan_hash,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(normalized.name, scopeType,
          normalized.scopeKey, startsAt, normalized.timezone, durationMinutes, waveSize, stable(evacuation),
          stable(normalized.ownerConstraints), stable(conflicts), conflicts.length ? 'planned' : 'ready', planHash, actor.id);
        const planId = Number(saved.lastInsertRowid); let offset = 0;
        for (const [index, wave] of waves.entries()) {
          const minutes = Math.max(...wave.targets.map(target => target.estimatedMinutes));
          const waveStart = new Date(Date.parse(startsAt) + offset * 60000).toISOString();
          const waveEnd = new Date(Date.parse(waveStart) + minutes * 60000).toISOString(); offset += minutes;
          db.prepare(`INSERT INTO lifecycle_maintenance_waves
            (plan_id,wave_number,starts_at,ends_at,targets_json,owners_json,evacuation_json,state) VALUES (?,?,?,?,?,?,?,?)`)
            .run(planId, index + 1, waveStart, waveEnd, stable(wave.targets), stable([...new Set(wave.targets.map(target => target.owner))]),
              stable(evacuation), conflicts.some(conflict => wave.targets.some(target => target.ref === conflict.targetRef)) ? 'blocked' : 'ready');
        }
        return { plan: planRow(db.prepare('SELECT * FROM lifecycle_maintenance_plans WHERE id=?').get(planId)),
          waves: db.prepare('SELECT * FROM lifecycle_maintenance_waves WHERE plan_id=? ORDER BY wave_number').all(planId).map(waveRow),
          providerMutationsStarted: 0 };
      })();
    } catch (error) {
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) throw fail('Maintenance plan name or hash already exists', 409, 'MAINTENANCE_PLAN_EXISTS');
      throw error;
    }
  }
  maintenancePlans(actor) { this._admin(actor); const db = this._db(); return db.prepare('SELECT * FROM lifecycle_maintenance_plans ORDER BY starts_at DESC,id DESC').all()
    .map(row => ({ ...planRow(row), waves: db.prepare('SELECT * FROM lifecycle_maintenance_waves WHERE plan_id=? ORDER BY wave_number').all(row.id).map(waveRow) })); }
  approveMaintenance(id, body = {}, actor) {
    this._admin(actor); const db = this._db(); const plan = planRow(db.prepare('SELECT * FROM lifecycle_maintenance_plans WHERE id=?').get(integer(id, 'planId', 1)));
    if (!plan) throw fail('Maintenance plan not found', 404, 'MAINTENANCE_PLAN_NOT_FOUND');
    if (plan.state !== 'ready' || plan.conflicts.length) throw fail('Maintenance plan has unresolved conflicts', 409, 'MAINTENANCE_PLAN_BLOCKED', { conflicts: plan.conflicts });
    if (body.planHash !== plan.planHash || body.confirmation !== `APPROVE MAINTENANCE ${plan.id}`) throw fail('Plan hash or typed confirmation does not match', 409, 'MAINTENANCE_CONFIRMATION_MISMATCH');
    db.prepare("UPDATE lifecycle_maintenance_plans SET state='approved',approved_by=?,approved_at=datetime('now'),updated_at=datetime('now') WHERE id=?").run(actor.id, plan.id);
    return { ...planRow(db.prepare('SELECT * FROM lifecycle_maintenance_plans WHERE id=?').get(plan.id)), providerMutationsStarted: 0 };
  }
  _campaignPrecheck(kind, input) {
    const evidence = object(input.precheck); const protection = object(input.protection); secretFree(evidence); secretFree(protection);
    const failures = [];
    if (evidence.healthReady !== true) failures.push('health');
    if (evidence.compatible !== true) failures.push('compatibility');
    if (kind === 'rolling_cluster' && evidence.haReady !== true) failures.push('ha');
    if (kind === 'rolling_cluster' && evidence.evacuationReady !== true) failures.push('evacuation');
    if (kind === 'guest_tools' && evidence.guestResponsive !== true) failures.push('guest_tools');
    if (kind === 'vm_hardware' && protection.backupVerified !== true && protection.snapshotVerified !== true) failures.push('protection');
    return { evidence: canonical(evidence), protection: canonical(protection), failures };
  }
  createCampaign(body = {}, actor) {
    this._admin(actor); const kind = body.kind;
    if (!['rolling_cluster', 'guest_tools', 'vm_hardware'].includes(kind)) throw fail('kind is invalid');
    const targets = this._targets(body.targets); const targetVersion = string(body.targetVersion, 'targetVersion', 160, SAFE_REF);
    const waveSize = integer(body.waveSize ?? 1, 'waveSize', 1, 100); const maintenancePlanId = body.maintenancePlanId == null ? null : integer(body.maintenancePlanId, 'maintenancePlanId', 1);
    const db = this._db(); if (maintenancePlanId && !db.prepare("SELECT 1 FROM lifecycle_maintenance_plans WHERE id=? AND state='approved'").get(maintenancePlanId)) throw fail('Approved maintenance plan not found', 409, 'APPROVED_MAINTENANCE_REQUIRED');
    const normalizedTargets = targets.map((target, index) => { const source = body.targets[index]; const check = this._campaignPrecheck(kind, source);
      return { ...target, stage: Math.floor(index / waveSize) + 1, currentVersion: optionalString(source.currentVersion, `targets[${index}].currentVersion`, 160, SAFE_REF),
        targetVersion, ...check }; });
    const gates = { stageSize: waveSize, requireHealth: true, requireCompatibility: true,
      requireHa: kind === 'rolling_cluster', requireGuestResponse: kind === 'guest_tools', requireProtection: kind === 'vm_hardware' };
    const rollbackPolicy = { mode: body.rollbackPolicy?.mode || 'pause', requireOperationEvidence: true };
    if (!['pause', 'explicit_rollback'].includes(rollbackPolicy.mode)) throw fail('rollbackPolicy.mode is invalid');
    const normalized = { kind, name: string(body.name, 'name', 160, SAFE_NAME), maintenancePlanId,
      targetVersion, gates, rollbackPolicy, targets: normalizedTargets }; const planHash = hash(normalized);
    try {
      return db.transaction(() => {
        const saved = db.prepare(`INSERT INTO lifecycle_change_campaigns
          (campaign_kind,name,maintenance_plan_id,target_version,state,gates_json,rollback_policy_json,plan_hash,created_by)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(kind, normalized.name, maintenancePlanId, targetVersion,
          normalizedTargets.some(target => target.failures.length) ? 'planned' : 'ready', stable(gates), stable(rollbackPolicy), planHash, actor.id);
        const campaignId = Number(saved.lastInsertRowid);
        const insert = db.prepare(`INSERT INTO lifecycle_campaign_targets
          (campaign_id,target_ref,provider_host_id,stage,current_version,target_version,state,precheck_json,protection_json) VALUES (?,?,?,?,?,?,?,?,?)`);
        for (const target of normalizedTargets) insert.run(campaignId, target.ref, target.providerHostId || 0, target.stage,
          target.currentVersion, targetVersion, target.failures.length ? 'blocked' : 'prechecked',
          stable({ ...target.evidence, failures: target.failures }), stable(target.protection));
        return this._campaign(campaignId, actor);
      })();
    } catch (error) {
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) throw fail('Campaign name or hash already exists', 409, 'CAMPAIGN_EXISTS');
      throw error;
    }
  }
  _campaign(id, actor) {
    this._admin(actor); const db = this._db(); const campaign = campaignRow(db.prepare('SELECT * FROM lifecycle_change_campaigns WHERE id=?').get(integer(id, 'campaignId', 1)));
    if (!campaign) throw fail('Lifecycle campaign not found', 404, 'CAMPAIGN_NOT_FOUND');
    return { ...campaign, targets: db.prepare('SELECT * FROM lifecycle_campaign_targets WHERE campaign_id=? ORDER BY stage,id').all(campaign.id).map(targetRow),
      providerOperationsCreated: 0 };
  }
  campaigns(actor) { this._admin(actor); return this._db().prepare('SELECT id FROM lifecycle_change_campaigns ORDER BY id DESC').all().map(row => this._campaign(row.id, actor)); }
  approveCampaign(id, body = {}, actor) {
    const campaign = this._campaign(id, actor); if (campaign.state !== 'ready') throw fail('Every campaign target must pass precheck', 409, 'CAMPAIGN_PRECHECK_BLOCKED');
    if (body.planHash !== campaign.planHash || body.confirmation !== `APPROVE CAMPAIGN ${campaign.id}`) throw fail('Campaign hash or typed confirmation does not match', 409, 'CAMPAIGN_CONFIRMATION_MISMATCH');
    this._db().prepare("UPDATE lifecycle_change_campaigns SET state='approved',approved_by=?,approved_at=datetime('now'),updated_at=datetime('now') WHERE id=?").run(actor.id, campaign.id);
    return this._campaign(campaign.id, actor);
  }
  advanceCampaign(id, body = {}, actor) {
    const campaign = this._campaign(id, actor); if (!['approved', 'running'].includes(campaign.state)) throw fail('Campaign is not approved/running', 409, 'CAMPAIGN_NOT_ACTIVE');
    const remaining = campaign.targets.filter(target => target.state !== 'verified' && target.state !== 'skipped');
    if (!remaining.length) return campaign;
    const nextStage = Math.min(...remaining.map(target => target.stage)); const stageTargets = remaining.filter(target => target.stage === nextStage);
    const target = stageTargets.find(item => item.id === integer(body.targetId, 'targetId', 1));
    if (!target) throw fail('Target is not in the current stage', 409, 'CAMPAIGN_STAGE_ORDER');
    const operationId = string(body.operationId, 'operationId', 80, /^op_[a-f0-9]{26}$/); const db = this._db();
    const operation = db.prepare('SELECT * FROM provider_operations WHERE id=?').get(operationId);
    if (!operation) throw fail('Durable provider operation not found', 404, 'OPERATION_NOT_FOUND');
    if (target.providerHostId && operation.host_id !== target.providerHostId) throw fail('Operation host does not match campaign target', 409, 'OPERATION_HOST_MISMATCH');
    const verification = object(body.verification); bounded(verification, 'verification'); secretFree(verification);
    if (operation.state !== 'succeeded' || verification.passed !== true) {
      db.prepare(`UPDATE lifecycle_campaign_targets SET state='failed',operation_id=?,verification_json=?,updated_at=datetime('now') WHERE id=?`)
        .run(operationId, stable({ ...verification, operationState: operation.state }), target.id);
      db.prepare("UPDATE lifecycle_change_campaigns SET state='paused',pause_reason=?,updated_at=datetime('now') WHERE id=?")
        .run(operation.state !== 'succeeded' ? `operation ${operationId} is ${operation.state}` : 'post-verification failed', campaign.id);
      return this._campaign(campaign.id, actor);
    }
    db.prepare(`UPDATE lifecycle_campaign_targets SET state='verified',operation_id=?,verification_json=?,updated_at=datetime('now') WHERE id=?`)
      .run(operationId, stable({ ...verification, operationState: operation.state }), target.id);
    const pending = db.prepare("SELECT COUNT(*) count FROM lifecycle_campaign_targets WHERE campaign_id=? AND state NOT IN ('verified','skipped')").get(campaign.id).count;
    const stagePending = db.prepare("SELECT COUNT(*) count FROM lifecycle_campaign_targets WHERE campaign_id=? AND stage=? AND state NOT IN ('verified','skipped')").get(campaign.id, nextStage).count;
    db.prepare(`UPDATE lifecycle_change_campaigns SET state=?,current_stage=?,pause_reason=NULL,updated_at=datetime('now') WHERE id=?`)
      .run(pending ? 'running' : 'completed', stagePending ? nextStage : nextStage + 1, campaign.id);
    return this._campaign(campaign.id, actor);
  }
  async livePatch(body = {}, actor) {
    this._admin(actor); const providerType = string(body.providerType, 'providerType', 80, SAFE_NAME).toLowerCase();
    const providerHostId = integer(body.providerHostId ?? 0, 'providerHostId'); const targetRef = string(body.targetRef, 'targetRef', 300, SAFE_REF);
    const patchId = string(body.patchId, 'patchId', 160, SAFE_REF); const phase = body.phase || 'inventory';
    if (!['inventory', 'apply', 'verify'].includes(phase)) throw fail('phase must be inventory, apply or verify'); const request = object(body.request);
    bounded(request, 'request'); secretFree(request, 'request'); const adapter = this._livePatchAdapters[providerType]; let result; let storedPhase;
    if (!adapter) { result = { supported: false, reason: `No live-patch adapter is registered for ${providerType}` }; storedPhase = 'unsupported'; }
    else {
      if (phase === 'apply' || phase === 'verify') {
        if (body.confirmation !== `APPLY LIVE PATCH ${patchId} ${targetRef}`) throw fail('Typed live-patch confirmation does not match');
        const operationId = string(body.operationId, 'operationId', 80, /^op_[a-f0-9]{26}$/);
        const approvalId = integer(body.approvalId, 'approvalId', 1);
        const db = this._db(); const operation = db.prepare('SELECT * FROM provider_operations WHERE id=?').get(operationId);
        const approval = db.prepare(`SELECT * FROM infrastructure_approval_requests
          WHERE id=? AND state='approved' AND action_key='live_patch.apply' AND target_id=?`).get(approvalId, targetRef);
        if (!operation || (providerHostId && operation.host_id !== providerHostId)) throw fail('Matching durable operation is required', 409, 'DURABLE_OPERATION_REQUIRED');
        if (!approval || approval.payload_hash !== hash({ providerType, providerHostId, targetRef, patchId, operationId })) {
          throw fail('Matching approved live-patch request is required', 409, 'APPROVED_LIVE_PATCH_REQUIRED');
        }
      }
      try { result = object(await adapter({ phase, providerHostId, targetRef, patchId, request: canonical(request) }));
        storedPhase = result.supported === false ? 'unsupported' : phase === 'inventory' ? 'inventory'
          : phase === 'verify' ? result.verified === true ? 'verified' : 'failed'
            : result.verified === true ? 'verified' : 'applied';
      } catch (error) { result = { supported: true, error: String(error.message || error).slice(0, 600) }; storedPhase = 'failed'; }
    }
    bounded(result, 'result'); secretFree(result, 'result'); const operationId = phase === 'apply' || phase === 'verify' ? body.operationId : null;
    const saved = this._db().prepare(`INSERT INTO lifecycle_live_patch_evidence
      (provider_type,provider_host_id,target_ref,patch_id,phase,request_hash,evidence_json,operation_id,created_by) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(providerType, providerHostId, targetRef, patchId, storedPhase, hash(request), stable(result), operationId, actor.id);
    return { id: Number(saved.lastInsertRowid), providerType, providerHostId, targetRef, patchId, phase: storedPhase,
      evidence: result, operationId, implicitRebootScheduled: false };
  }
  livePatchEvidence(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM lifecycle_live_patch_evidence ORDER BY id DESC LIMIT 500').all()
    .map(row => ({ id: row.id, providerType: row.provider_type, providerHostId: row.provider_host_id,
      targetRef: row.target_ref, patchId: row.patch_id, phase: row.phase, requestHash: row.request_hash,
      evidence: parse(row.evidence_json, {}), operationId: row.operation_id, createdAt: row.created_at })); }
  recordRebootSignal(body = {}, actor) {
    this._admin(actor); if (!['kernel', 'hypervisor', 'toolstack', 'vendor'].includes(body.signalSource)) throw fail('signalSource is invalid');
    if (!['required', 'not_required', 'unknown'].includes(body.requiredState)) throw fail('requiredState is invalid');
    const evidence = object(body.evidence); bounded(evidence, 'evidence'); secretFree(evidence); const values = [
      integer(body.providerHostId ?? 0, 'providerHostId'), string(body.targetRef, 'targetRef', 300, SAFE_REF), body.signalSource,
      string(body.signalKey, 'signalKey', 160, SAFE_REF), body.requiredState,
      optionalString(body.currentVersion, 'currentVersion', 160, SAFE_REF), optionalString(body.pendingVersion, 'pendingVersion', 160, SAFE_REF),
      string(body.guidance, 'guidance', 1000), hash(evidence), timestamp(body.observedAt || new Date(), 'observedAt'), actor.id]; const db = this._db();
    db.prepare(`INSERT INTO lifecycle_reboot_signals
      (provider_host_id,target_ref,signal_source,signal_key,required_state,current_version,pending_version,guidance,evidence_hash,observed_at,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider_host_id,target_ref,signal_source,signal_key) DO UPDATE SET
      required_state=excluded.required_state,current_version=excluded.current_version,pending_version=excluded.pending_version,
      guidance=excluded.guidance,evidence_hash=excluded.evidence_hash,observed_at=excluded.observed_at,created_by=excluded.created_by,
      created_at=datetime('now')`).run(...values);
    return this.rebootStatus(values[0], values[1], actor);
  }
  rebootStatus(hostId, targetRef, actor) {
    this._admin(actor); const rows = this._db().prepare(`SELECT * FROM lifecycle_reboot_signals WHERE provider_host_id=? AND target_ref=? ORDER BY signal_source,signal_key`)
      .all(integer(hostId, 'providerHostId'), string(targetRef, 'targetRef', 300, SAFE_REF)).map(row => ({ id: row.id,
        source: row.signal_source, key: row.signal_key, state: row.required_state, currentVersion: row.current_version,
        pendingVersion: row.pending_version, guidance: row.guidance, evidenceHash: row.evidence_hash, observedAt: row.observed_at }));
    const requiredState = rows.some(row => row.state === 'required') ? 'required' : rows.some(row => row.state === 'unknown') ? 'unknown' : rows.length ? 'not_required' : 'unknown';
    return { providerHostId: Number(hostId), targetRef, requiredState, signals: rows, rebootScheduled: false };
  }
  rebootSignals(actor) { this._admin(actor); const db = this._db(); return db.prepare('SELECT DISTINCT provider_host_id,target_ref FROM lifecycle_reboot_signals ORDER BY provider_host_id,target_ref').all()
    .map(row => this.rebootStatus(row.provider_host_id, row.target_ref, actor)); }
  saveFirmware(body = {}, actor) {
    this._admin(actor); if (!['bios', 'bmc', 'nic', 'storage', 'gpu'].includes(body.componentType)) throw fail('componentType is invalid');
    const releases = strings(body.compatibleHostReleases, 'compatibleHostReleases', 100); const metadata = object(body.metadata);
    bounded(metadata, 'metadata'); secretFree(metadata); const severity = body.severity || 'info'; if (!['info', 'recommended', 'critical'].includes(severity)) throw fail('severity is invalid');
    const sourceUrl = httpsUrl(body.sourceUrl); const values = [string(body.vendor, 'vendor', 160, SAFE_NAME), string(body.deviceModel, 'deviceModel', 160, SAFE_NAME),
      body.componentType, string(body.firmwareVersion, 'firmwareVersion', 160, SAFE_REF), stable(releases),
      optionalString(body.minimumDriverVersion, 'minimumDriverVersion', 160, SAFE_REF), severity, sourceUrl,
      timestamp(body.publishedAt, 'publishedAt'), hash({ sourceUrl, releases, metadata }), stable(metadata), actor.id]; const db = this._db();
    db.prepare(`INSERT INTO lifecycle_firmware_catalog
      (vendor,device_model,component_type,firmware_version,compatible_host_releases_json,minimum_driver_version,severity,
       source_url,published_at,source_digest,metadata_json,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(vendor,device_model,component_type,firmware_version) DO UPDATE SET compatible_host_releases_json=excluded.compatible_host_releases_json,
      minimum_driver_version=excluded.minimum_driver_version,severity=excluded.severity,source_url=excluded.source_url,
      published_at=excluded.published_at,source_digest=excluded.source_digest,metadata_json=excluded.metadata_json,created_by=excluded.created_by,
      created_at=datetime('now')`).run(...values);
    return this._firmwareRow(db.prepare(`SELECT * FROM lifecycle_firmware_catalog WHERE vendor=? AND device_model=? AND component_type=? AND firmware_version=?`).get(...values.slice(0, 4)));
  }
  _firmwareRow(row) { return row && { id: row.id, vendor: row.vendor, deviceModel: row.device_model,
    componentType: row.component_type, firmwareVersion: row.firmware_version,
    compatibleHostReleases: parse(row.compatible_host_releases_json, []), minimumDriverVersion: row.minimum_driver_version,
    severity: row.severity, sourceUrl: row.source_url, publishedAt: row.published_at, sourceDigest: row.source_digest,
    metadata: parse(row.metadata_json, {}) }; }
  firmwareCatalog(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM lifecycle_firmware_catalog ORDER BY published_at DESC,id DESC').all().map(row => this._firmwareRow(row)); }
  saveDriverCompatibility(body = {}, actor) {
    this._admin(actor); if (!['supported', 'deprecated', 'blocked'].includes(body.status)) throw fail('status is invalid');
    const normalized = { vendor: string(body.vendor, 'vendor', 160, SAFE_NAME), deviceModel: string(body.deviceModel, 'deviceModel', 160, SAFE_NAME),
      driverName: string(body.driverName, 'driverName', 160, SAFE_NAME), driverVersion: string(body.driverVersion, 'driverVersion', 160, SAFE_REF),
      firmwareVersion: string(body.firmwareVersion, 'firmwareVersion', 160, SAFE_REF), hostRelease: string(body.hostRelease, 'hostRelease', 160, SAFE_REF),
      status: body.status, notes: String(body.notes || '').trim().slice(0, 1000), sourceUrl: httpsUrl(body.sourceUrl) };
    bounded(normalized, 'driverCompatibility'); secretFree(normalized, 'driverCompatibility');
    const values = [normalized.vendor, normalized.deviceModel, normalized.driverName, normalized.driverVersion,
      normalized.firmwareVersion, normalized.hostRelease, normalized.status, normalized.notes, normalized.sourceUrl,
      hash(normalized), actor.id]; const db = this._db();
    db.prepare(`INSERT INTO lifecycle_driver_compatibility
      (vendor,device_model,driver_name,driver_version,firmware_version,host_release,status,notes,source_url,source_digest,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(vendor,device_model,driver_name,driver_version,firmware_version,host_release)
      DO UPDATE SET status=excluded.status,notes=excluded.notes,source_url=excluded.source_url,source_digest=excluded.source_digest,
      created_by=excluded.created_by,created_at=datetime('now')`).run(...values);
    return this._driverRow(db.prepare(`SELECT * FROM lifecycle_driver_compatibility WHERE vendor=? AND device_model=? AND driver_name=?
      AND driver_version=? AND firmware_version=? AND host_release=?`).get(...values.slice(0, 6)));
  }
  _driverRow(row) { return row && { id: row.id, vendor: row.vendor, deviceModel: row.device_model,
    driverName: row.driver_name, driverVersion: row.driver_version, firmwareVersion: row.firmware_version,
    hostRelease: row.host_release, status: row.status, notes: row.notes, sourceUrl: row.source_url, sourceDigest: row.source_digest }; }
  driverMatrix(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM lifecycle_driver_compatibility ORDER BY vendor,device_model,driver_name').all().map(row => this._driverRow(row)); }
  checkDriver(body = {}, actor) {
    this._admin(actor); const query = [string(body.vendor, 'vendor', 160, SAFE_NAME), string(body.deviceModel, 'deviceModel', 160, SAFE_NAME),
      string(body.driverName, 'driverName', 160, SAFE_NAME), string(body.driverVersion, 'driverVersion', 160, SAFE_REF),
      string(body.firmwareVersion, 'firmwareVersion', 160, SAFE_REF), string(body.hostRelease, 'hostRelease', 160, SAFE_REF)];
    const row = this._db().prepare(`SELECT * FROM lifecycle_driver_compatibility WHERE vendor=? AND device_model=?
      AND driver_name=? AND driver_version=? AND firmware_version=? AND host_release=?`).get(...query);
    return { match: this._driverRow(row), status: row ? row.status : 'unknown', compatible: row ? row.status === 'supported' : null,
      remediationScheduled: false };
  }
  saveCertificateOwnership(body = {}, actor) {
    this._admin(actor); const certificateId = body.certificateId == null ? null : integer(body.certificateId, 'certificateId', 1); const db = this._db();
    if (certificateId && !db.prepare('SELECT 1 FROM tracked_certificates WHERE id=?').get(certificateId)) throw fail('Tracked certificate not found', 404, 'CERTIFICATE_NOT_FOUND');
    if (!['endpoint', 'service', 'host'].includes(body.resourceType)) throw fail('resourceType is invalid');
    const environment = body.environment || 'production'; if (!['production', 'nonproduction'].includes(environment)) throw fail('environment is invalid');
    const escalation = body.escalationUserId == null ? null : integer(body.escalationUserId, 'escalationUserId', 1);
    if (escalation && !db.prepare("SELECT 1 FROM users WHERE id=? AND is_active=1 AND role='admin'").get(escalation)) throw fail('Active escalation administrator not found', 404);
    const maintenancePlanId = body.maintenancePlanId == null ? null : integer(body.maintenancePlanId, 'maintenancePlanId', 1);
    if (maintenancePlanId && !db.prepare('SELECT 1 FROM lifecycle_maintenance_plans WHERE id=?').get(maintenancePlanId)) throw fail('Maintenance plan not found', 404, 'MAINTENANCE_PLAN_NOT_FOUND');
    const values = [certificateId, string(body.inventoryKey, 'inventoryKey', 300, SAFE_REF),
      body.endpoint ? httpsUrl(body.endpoint, 'endpoint') : null, body.resourceType,
      string(body.resourceRef, 'resourceRef', 300, SAFE_REF), string(body.owner, 'owner', 160, SAFE_NAME), escalation,
      maintenancePlanId, environment, actor.id];
    db.prepare(`INSERT INTO lifecycle_certificate_ownership
      (certificate_id,inventory_key,endpoint,resource_type,resource_ref,owner,escalation_user_id,maintenance_plan_id,environment,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(inventory_key) DO UPDATE SET certificate_id=excluded.certificate_id,endpoint=excluded.endpoint,
      resource_type=excluded.resource_type,resource_ref=excluded.resource_ref,owner=excluded.owner,
      escalation_user_id=excluded.escalation_user_id,maintenance_plan_id=excluded.maintenance_plan_id,environment=excluded.environment,
      created_by=excluded.created_by,updated_at=datetime('now')`).run(...values);
    return this.certificateInventory(actor).find(item => item.inventoryKey === values[1]);
  }
  certificateInventory(actor) {
    this._admin(actor); return this._db().prepare(`SELECT o.*,c.name certificate_name,c.subject,c.issuer,c.sans,c.not_before,c.not_after,
      c.fingerprint_sha256,c.self_signed,c.last_checked_at,c.last_error FROM lifecycle_certificate_ownership o
      LEFT JOIN tracked_certificates c ON c.id=o.certificate_id ORDER BY c.not_after,o.inventory_key`).all().map(row => ({
      id: row.id, certificateId: row.certificate_id, inventoryKey: row.inventory_key, endpoint: row.endpoint,
      resourceType: row.resource_type, resourceRef: row.resource_ref, owner: row.owner,
      escalationUserId: row.escalation_user_id, maintenancePlanId: row.maintenance_plan_id, environment: row.environment,
      name: row.certificate_name, subject: row.subject, issuer: row.issuer, sans: row.sans, notBefore: row.not_before,
      notAfter: row.not_after, fingerprintSha256: row.fingerprint_sha256, selfSigned: !!row.self_signed,
      lastCheckedAt: row.last_checked_at, lastError: row.last_error,
      daysRemaining: row.not_after ? Math.ceil((Date.parse(row.not_after) - Date.now()) / 86400000) : null }));
  }
  saveReminderPolicy(body = {}, actor) {
    this._admin(actor); if (!Array.isArray(body.thresholdDays)) throw fail('thresholdDays must be an array');
    const thresholds = [...new Set(body.thresholdDays.map((value, index) => integer(value, `thresholdDays[${index}]`, 0, 3650)))].sort((a, b) => b - a);
    if (!thresholds.length || thresholds.length > 20) throw fail('thresholdDays must contain 1-20 values'); const environment = body.environment || 'all';
    if (!['production', 'nonproduction', 'all'].includes(environment)) throw fail('environment is invalid'); const db = this._db();
    const escalationUserId = body.escalationUserId == null ? null : integer(body.escalationUserId, 'escalationUserId', 1);
    if (escalationUserId && !db.prepare("SELECT 1 FROM users WHERE id=? AND is_active=1 AND role='admin'").get(escalationUserId)) throw fail('Active escalation administrator not found', 404);
    const result = db.prepare(`INSERT INTO lifecycle_certificate_reminder_policies
      (name,thresholds_json,environment,require_maintenance_window,escalation_user_id,enabled,created_by) VALUES (?,?,?,?,?,?,?)`)
      .run(string(body.name, 'name', 160, SAFE_NAME), stable(thresholds), environment, body.requireMaintenanceWindow === false ? 0 : 1,
        escalationUserId, body.enabled === false ? 0 : 1, actor.id);
    return this._reminderPolicy(db.prepare('SELECT * FROM lifecycle_certificate_reminder_policies WHERE id=?').get(result.lastInsertRowid));
  }
  _reminderPolicy(row) { return row && { id: row.id, name: row.name, thresholdDays: parse(row.thresholds_json, []),
    environment: row.environment, requireMaintenanceWindow: !!row.require_maintenance_window,
    escalationUserId: row.escalation_user_id, enabled: !!row.enabled }; }
  reminderPolicies(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM lifecycle_certificate_reminder_policies ORDER BY name').all().map(row => this._reminderPolicy(row)); }
  evaluateCertificateReminders(actor) {
    this._admin(actor); const db = this._db(); const ownership = this.certificateInventory(actor); let created = 0;
    for (const policyRow of db.prepare('SELECT * FROM lifecycle_certificate_reminder_policies WHERE enabled=1').all()) {
      const policy = this._reminderPolicy(policyRow);
      for (const item of ownership.filter(entry => entry.notAfter && (policy.environment === 'all' || policy.environment === entry.environment))) {
        const threshold = policy.thresholdDays.slice().sort((a, b) => a - b).find(days => item.daysRemaining <= days); if (threshold == null) continue;
        const severity = item.daysRemaining < 0 ? 'expired' : item.daysRemaining <= 7 ? 'critical' : item.daysRemaining <= 30 ? 'warning' : 'info';
        const maintenanceDependency = policy.requireMaintenanceWindow && !item.maintenancePlanId ? 'approved maintenance plan required before renewal' : null;
        const result = db.prepare(`INSERT OR IGNORE INTO lifecycle_certificate_reminders
          (policy_id,ownership_id,certificate_id,threshold_days,expires_at,state,severity,owner,escalation_user_id,
           maintenance_dependency,evidence_json) VALUES (?,?,?,?,?,'open',?,?,?,?,?)`).run(policy.id, item.id, item.certificateId,
          threshold, item.notAfter, severity, item.owner, item.escalationUserId || policy.escalationUserId,
          maintenanceDependency, stable({ daysRemaining: item.daysRemaining, inventoryKey: item.inventoryKey,
            fingerprintSha256: item.fingerprintSha256 || null }));
        created += result.changes;
      }
    }
    return { created, reminders: this.certificateReminders(actor), renewalsStarted: 0 };
  }
  certificateReminders(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM lifecycle_certificate_reminders ORDER BY expires_at,id DESC').all()
    .map(row => ({ id: row.id, policyId: row.policy_id, ownershipId: row.ownership_id,
      certificateId: row.certificate_id, thresholdDays: row.threshold_days, expiresAt: row.expires_at,
      state: row.state, severity: row.severity, owner: row.owner, escalationUserId: row.escalation_user_id,
      maintenanceDependency: row.maintenance_dependency, evidence: parse(row.evidence_json, {}) })); }
  overview(actor) {
    this._admin(actor); const maintenancePlans = this.maintenancePlans(actor); const campaigns = this.campaigns(actor);
    const certificates = this.certificateInventory(actor); const reminders = this.certificateReminders(actor);
    return { capabilities: { maintenanceWindowPlanner: true, rollingUpgradeOrchestration: true,
      livePatchAdapters: true, rebootRequiredSignals: true, firmwareCatalog: true, driverCompatibility: true,
      guestToolsCampaigns: true, vmHardwareCampaigns: true, certificateOwnershipInventory: true,
      certificateRenewalReminders: true }, maintenancePlans, campaigns, livePatchEvidence: this.livePatchEvidence(actor),
    rebootSignals: this.rebootSignals(actor), firmwareCatalog: this.firmwareCatalog(actor), driverMatrix: this.driverMatrix(actor),
    certificates, reminderPolicies: this.reminderPolicies(actor), reminders, summary: {
      plannedWindows: maintenancePlans.filter(item => !['completed', 'cancelled'].includes(item.state)).length,
      activeCampaigns: campaigns.filter(item => ['approved', 'running', 'paused'].includes(item.state)).length,
      rebootRequired: this.rebootSignals(actor).filter(item => item.requiredState === 'required').length,
      expiringCertificates: certificates.filter(item => item.daysRemaining != null && item.daysRemaining <= 30).length,
      openReminders: reminders.filter(item => item.state === 'open').length } };
  }
}

const service = new LifecycleMaintenanceService();
module.exports = service;
module.exports.LifecycleMaintenanceService = LifecycleMaintenanceService;
module.exports.LifecycleMaintenanceError = LifecycleMaintenanceError;
module.exports._internals = { canonical, stable, hash, planRow, waveRow, campaignRow, targetRow };
