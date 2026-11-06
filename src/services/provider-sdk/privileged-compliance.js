'use strict';

const config = require('../../config');
const { getDb } = require('../../db');
const authService = require('../auth');
const governance = require('../governance');
const { generateToken, sha256, hmacSign } = require('../../utils/crypto');

const SCHEMA_VERSION = '1.0';
const CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'];
const FRAMEWORKS = new Set(['CIS', 'NIST', 'ISO27001', 'SOC2', 'DORA']);
const FACTOR_STATES = new Set(['verified', 'failed', 'unknown', 'not_applicable']);
const ELEVATABLE = new Set([
  'privileged.break_glass.request', 'privileged.session_recording.read',
  'data.classification.manage', 'compliance.evidence.export',
  'compliance.mapping.manage', 'recovery.ransomware_posture.manage',
  'provider.vm.power.force', 'provider.vm.snapshot.revert',
  'provider.vm.snapshot.delete', 'provider.vm.migration.execute',
]);
const CRITICAL_OPERATIONS = Object.freeze({
  'provider.vm.power.force': Object.freeze({ permissionKey: 'provider.vm.power.force' }),
  'provider.vm.snapshot.revert': Object.freeze({ permissionKey: 'provider.vm.snapshot.revert' }),
  'provider.vm.snapshot.delete': Object.freeze({ permissionKey: 'provider.vm.snapshot.delete' }),
  'provider.vm.migration.execute': Object.freeze({ permissionKey: 'provider.vm.migration.execute' }),
});
const SAFE_TEXT = /^[^\u0000-\u001f\u007f<>]{1,600}$/;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,299}$/;
const RESOURCE_PATTERNS = Object.freeze({
  host: /^ddr_host_[a-f0-9]{26}$/,
  virtualMachine: /^ddr_vm_[a-f0-9]{26}$/,
  artifact: /^dda_art_[a-f0-9]{26}$/,
  recoveryPoint: /^ddr_rp_[a-f0-9]{26}$/,
});
const POLICY = Object.freeze({
  public: { backup: 'allowed', evidenceExport: 'full', telemetry: 'standard' },
  internal: { backup: 'allowed', evidenceExport: 'metadata', telemetry: 'standard' },
  confidential: { backup: 'encrypted_required', evidenceExport: 'redacted', telemetry: 'minimized' },
  restricted: { backup: 'immutable_encrypted_required', evidenceExport: 'hashes_only', telemetry: 'disabled' },
});

class PrivilegedComplianceError extends Error {
  constructor(message, code = 'PRIVILEGED_COMPLIANCE_ERROR', status = 400, details = null) {
    super(message); this.name = 'PrivilegedComplianceError'; this.code = code;
    this.status = status; this.details = details;
  }
}

function _database(options = {}) { return options.database || getDb(); }
function _enabled(options = {}) {
  return options.enabled === undefined ? config.features.providerPrivilegedCompliance : options.enabled === true;
}
function _assertEnabled(options) {
  if (!_enabled(options)) throw new PrivilegedComplianceError(
    'Privileged access and compliance controls are disabled by release policy',
    'PRIVILEGED_COMPLIANCE_DISABLED', 404);
}
function _canonical(value) {
  if (Array.isArray(value)) return `[${value.map(_canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${_canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function _json(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function _table(database, name) {
  return !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function _text(value, label, max = 600) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || !SAFE_TEXT.test(result)) throw new PrivilegedComplianceError(
    `${label} is invalid`, 'INVALID_PRIVILEGED_COMPLIANCE_INPUT');
  return result;
}
function _key(value, label, max = 300) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || !SAFE_KEY.test(result)) throw new PrivilegedComplianceError(
    `${label} is invalid`, 'INVALID_PRIVILEGED_COMPLIANCE_INPUT');
  return result;
}
function _integer(value, label, min, max) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new PrivilegedComplianceError(
    `${label} must be an integer between ${min} and ${max}`, 'INVALID_PRIVILEGED_COMPLIANCE_INPUT');
  return result;
}
function _list(value, label, { min = 0, max = 100 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new PrivilegedComplianceError(
    `${label} must contain ${min}-${max} values`, 'INVALID_PRIVILEGED_COMPLIANCE_INPUT');
  return [...new Set(value.map((item, index) => _key(item, `${label}[${index}]`)))];
}
function _timestamp(value, label, future = false) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime()) || (future && date.getTime() <= Date.now())) {
    throw new PrivilegedComplianceError(`${label} is invalid`, 'INVALID_PRIVILEGED_COMPLIANCE_INPUT');
  }
  return date.toISOString();
}
function _host(database, hostId) {
  const id = Number(hostId);
  const row = Number.isInteger(id) && id > 0
    ? database.prepare('SELECT * FROM docker_hosts WHERE id=? AND is_active=1').get(id) : null;
  if (!row) throw new PrivilegedComplianceError(
    'Provider endpoint was not found', 'PROVIDER_ENDPOINT_NOT_FOUND', 404);
  return row;
}
function _actor(actor) {
  if (!actor?.id) throw new PrivilegedComplianceError(
    'Authenticated user is required', 'AUTHENTICATION_REQUIRED', 401);
  return actor;
}
function _scope(database, scopeId, hostId) {
  const id = _integer(scopeId, 'scopeId', 1, Number.MAX_SAFE_INTEGER);
  const row = database.prepare('SELECT * FROM governance_scopes WHERE id=?').get(id);
  if (!row) throw new PrivilegedComplianceError('Governance scope was not found', 'GOVERNANCE_SCOPE_NOT_FOUND', 404);
  const seen = new Set(); let current = row; let providerBinding = null;
  while (current) {
    if (seen.has(current.id)) throw new PrivilegedComplianceError(
      'Governance scope hierarchy contains a cycle', 'GOVERNANCE_SCOPE_CYCLE', 409);
    seen.add(current.id);
    const metadata = _json(current.metadata_json, {});
    const bound = Number(metadata.providerHostId ?? metadata.provider_host_id);
    if (Number.isInteger(bound) && bound > 0) providerBinding = bound;
    if (current.scope_type === 'provider' && /^provider-host:\d+$/.test(current.scope_key)) {
      providerBinding = Number(current.scope_key.split(':')[1]);
    }
    current = current.parent_id == null ? null
      : database.prepare('SELECT * FROM governance_scopes WHERE id=?').get(current.parent_id);
  }
  if (providerBinding !== null && providerBinding !== Number(hostId)) throw new PrivilegedComplianceError(
    'Governance scope belongs to another provider endpoint', 'GOVERNANCE_SCOPE_HOST_MISMATCH', 409);
  return row;
}
function _authorize(actor, scopeId, permission, options = {}) {
  _actor(actor);
  if (actor.role === 'admin') return true;
  const governanceService = options.governanceService || governance;
  if (!governanceService.can(actor, Number(scopeId), permission)) throw new PrivilegedComplianceError(
    `Governance permission ${permission} is required`, 'GOVERNANCE_PERMISSION_REQUIRED', 403,
    { scopeId: Number(scopeId), permission });
  return true;
}
function _refresh(database) {
  database.prepare(`UPDATE provider_privileged_elevation_grants SET state='expired'
    WHERE state IN ('pending','active') AND julianday(expires_at)<=julianday('now')`).run();
  database.prepare(`UPDATE provider_break_glass_requests SET state='expired',closed_at=COALESCE(closed_at,datetime('now'))
    WHERE state IN ('pending','approved','active') AND julianday(expires_at)<=julianday('now')`).run();
}
function _elevation(row) {
  return row ? { schemaVersion: SCHEMA_VERSION, id: row.id, hostId: Number(row.host_id),
    scopeId: Number(row.scope_id), permissionKey: row.permission_key,
    requestedBy: Number(row.requested_by), reason: row.reason, mfaVerifiedAt: row.mfa_verified_at,
    expiresAt: row.expires_at, state: row.state, approvedBy: row.approved_by == null ? null : Number(row.approved_by),
    approvedAt: row.approved_at, claimed: !!row.claimed_at, claimedAt: row.claimed_at,
    revokedBy: row.revoked_by == null ? null : Number(row.revoked_by), revokedAt: row.revoked_at,
    grantHash: row.grant_hash, createdAt: row.created_at } : null;
}
function _breakGlass(row) {
  return row ? { schemaVersion: SCHEMA_VERSION, id: row.id, temporaryIdentity: `break-glass:${row.id}`,
    hostId: Number(row.host_id), scopeId: Number(row.scope_id), requestedBy: Number(row.requested_by),
    reason: row.reason, ticketRef: row.ticket_ref, notificationRefs: _json(row.notification_refs_json, []),
    recordingPolicy: row.recording_policy, recordingPolicyRef: row.recording_policy_ref,
    recordingConsentAt: row.recording_consent_at, expiresAt: row.expires_at, state: row.state,
    approvedBy: row.approved_by == null ? null : Number(row.approved_by), approvedAt: row.approved_at,
    activated: !!row.activated_at, activatedAt: row.activated_at,
    closedBy: row.closed_by == null ? null : Number(row.closed_by), closedAt: row.closed_at,
    reviewOutcome: row.review_outcome, reviewNotes: row.review_notes,
    reviewedBy: row.reviewed_by == null ? null : Number(row.reviewed_by), reviewedAt: row.reviewed_at,
    requestHash: row.request_hash, createdAt: row.created_at } : null;
}

function requestElevation(host, input = {}, actor, options = {}) {
  _assertEnabled(options); const database = _database(options); _host(database, host.id); _actor(actor);
  const scope = _scope(database, input.scopeId, host.id);
  _authorize(actor, scope.id, 'privileged.elevation.request', options);
  const permissionKey = String(input.permissionKey || '');
  if (!ELEVATABLE.has(permissionKey)) throw new PrivilegedComplianceError(
    'Requested permission is not in the JIT elevation allowlist', 'JIT_PERMISSION_NOT_ALLOWLISTED', 400);
  if (!database.prepare('SELECT 1 FROM governance_permissions WHERE permission_key=?').get(permissionKey)) {
    throw new PrivilegedComplianceError('Requested permission is not in the catalog', 'JIT_PERMISSION_UNKNOWN', 400);
  }
  const reason = _text(input.reason, 'reason');
  const ttlSeconds = _integer(input.ttlSeconds ?? 900, 'ttlSeconds', 60, 3600);
  database.prepare(`DELETE FROM provider_privileged_step_up_attempts
    WHERE julianday(attempted_at)<julianday('now','-1 day')`).run();
  const failures = Number(database.prepare(`SELECT COUNT(*) AS count
    FROM provider_privileged_step_up_attempts WHERE host_id=? AND user_id=? AND succeeded=0
      AND julianday(attempted_at)>julianday('now','-10 minutes')`).get(Number(host.id), Number(actor.id)).count);
  if (failures >= 5) throw new PrivilegedComplianceError(
    'Too many failed step-up attempts; retry after the cooldown', 'STEP_UP_RATE_LIMITED', 429);
  const verifier = options.verifyTotp || ((userId, code) => authService.verifyStepUpMfa(userId, code));
  const verified = verifier(actor.id, String(input.totpCode || ''));
  database.prepare(`INSERT INTO provider_privileged_step_up_attempts
    (host_id,user_id,succeeded) VALUES (?,?,?)`).run(Number(host.id), Number(actor.id), verified?.success ? 1 : 0);
  if (!verified?.success) throw new PrivilegedComplianceError(
    verified?.error || 'A valid local TOTP step-up is required', 'STEP_UP_MFA_REQUIRED', 403);
  const mfaVerifiedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const semantic = { schemaVersion: SCHEMA_VERSION, hostId: Number(host.id), scopeId: Number(scope.id),
    permissionKey, requestedBy: Number(actor.id), reason, mfaVerifiedAt, expiresAt };
  const grantHash = sha256(_canonical(semantic)); const id = `ppjg_${generateToken(13)}`;
  database.prepare(`INSERT INTO provider_privileged_elevation_grants
    (id,host_id,scope_id,permission_key,requested_by,reason,mfa_verified_at,expires_at,grant_hash)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, Number(host.id), scope.id, permissionKey, actor.id,
    reason, mfaVerifiedAt, expiresAt, grantHash);
  return { grant: _elevation(database.prepare(
    'SELECT * FROM provider_privileged_elevation_grants WHERE id=?').get(id)), tokenIssued: false };
}

function approveElevation(host, grantId, input = {}, actor, options = {}) {
  _assertEnabled(options); const database = _database(options); _host(database, host.id); _actor(actor); _refresh(database);
  const row = database.prepare(`SELECT * FROM provider_privileged_elevation_grants
    WHERE id=? AND host_id=?`).get(String(grantId), Number(host.id));
  if (!row) throw new PrivilegedComplianceError('JIT grant was not found', 'JIT_GRANT_NOT_FOUND', 404);
  _authorize(actor, row.scope_id, 'privileged.elevation.approve', options);
  if (Number(row.requested_by) === Number(actor.id)) throw new PrivilegedComplianceError(
    'JIT approval must be performed by an independent user', 'JIT_FOUR_EYES_REQUIRED', 409);
  if (row.state !== 'pending') throw new PrivilegedComplianceError(
    'Only a pending JIT grant can be approved', 'JIT_GRANT_NOT_PENDING', 409);
  if (String(input.confirmation || '') !== `APPROVE JIT ${row.id}`) throw new PrivilegedComplianceError(
    `Type APPROVE JIT ${row.id} to approve`, 'JIT_CONFIRMATION_REQUIRED', 409);
  database.prepare(`UPDATE provider_privileged_elevation_grants SET state='active',approved_by=?,
    approved_at=datetime('now') WHERE id=? AND state='pending'`).run(actor.id, row.id);
  return { grant: _elevation(database.prepare(
    'SELECT * FROM provider_privileged_elevation_grants WHERE id=?').get(row.id)), tokenIssued: false };
}

function claimElevation(host, grantId, actor, options = {}) {
  _assertEnabled(options); const database = _database(options); _host(database, host.id); _actor(actor); _refresh(database);
  const row = database.prepare(`SELECT * FROM provider_privileged_elevation_grants
    WHERE id=? AND host_id=?`).get(String(grantId), Number(host.id));
  if (!row) throw new PrivilegedComplianceError('JIT grant was not found', 'JIT_GRANT_NOT_FOUND', 404);
  if (Number(row.requested_by) !== Number(actor.id)) throw new PrivilegedComplianceError(
    'Only the requesting user can claim a JIT grant', 'JIT_GRANT_SUBJECT_MISMATCH', 403);
  if (row.state !== 'active' || row.token_hash || Date.parse(row.expires_at) <= Date.now()) {
    throw new PrivilegedComplianceError('JIT grant cannot be claimed', 'JIT_GRANT_NOT_CLAIMABLE', 409);
  }
  const token = generateToken(32);
  const claimed = database.prepare(`UPDATE provider_privileged_elevation_grants SET token_hash=?,claimed_at=datetime('now')
    WHERE id=? AND token_hash IS NULL AND state='active'`).run(sha256(token), row.id);
  if (claimed.changes !== 1) throw new PrivilegedComplianceError(
    'JIT grant cannot be claimed', 'JIT_GRANT_NOT_CLAIMABLE', 409);
  return { grant: _elevation(database.prepare(
    'SELECT * FROM provider_privileged_elevation_grants WHERE id=?').get(row.id)), token, tokenShownOnce: true };
}

function validateElevation(hostId, actor, scopeId, permissionKey, token, options = {}) {
  _assertEnabled(options); const database = _database(options); _actor(actor); _refresh(database);
  const raw = String(token || '');
  if (!/^[a-f0-9]{64}$/.test(raw)) throw new PrivilegedComplianceError(
    'A current JIT grant token is required', 'JIT_GRANT_REQUIRED', 403);
  const row = database.prepare(`SELECT * FROM provider_privileged_elevation_grants
    WHERE token_hash=? AND host_id=? AND scope_id=? AND requested_by=? AND permission_key=? AND state='active'
      AND claimed_at IS NOT NULL AND julianday(expires_at)>julianday('now')`).get(
    sha256(raw), Number(hostId), Number(scopeId), Number(actor.id), String(permissionKey));
  if (!row) throw new PrivilegedComplianceError(
    'JIT grant is invalid, expired or outside the requested scope', 'JIT_GRANT_REQUIRED', 403);
  return _elevation(row);
}

function revokeElevation(host, grantId, actor, options = {}) {
  _assertEnabled(options); const database = _database(options); _host(database, host.id); _actor(actor);
  const row = database.prepare(`SELECT * FROM provider_privileged_elevation_grants
    WHERE id=? AND host_id=?`).get(String(grantId), Number(host.id));
  if (!row) throw new PrivilegedComplianceError('JIT grant was not found', 'JIT_GRANT_NOT_FOUND', 404);
  if (actor.role !== 'admin' && Number(row.requested_by) !== Number(actor.id)) {
    _authorize(actor, row.scope_id, 'privileged.elevation.approve', options);
  }
  database.prepare(`UPDATE provider_privileged_elevation_grants SET state='revoked',revoked_by=?,
    revoked_at=datetime('now'),token_hash=NULL WHERE id=? AND state IN ('pending','active')`).run(actor.id, row.id);
  return _elevation(database.prepare('SELECT * FROM provider_privileged_elevation_grants WHERE id=?').get(row.id));
}

function _operationPermission(hostId, actor, scopeId, permission, grantToken, options) {
  if (actor?.role === 'admin') return { mode: 'global_admin', scopeId: Number(scopeId) };
  const governanceService = options.governanceService || governance;
  if (governanceService.can(actor, Number(scopeId), permission)) return { mode: 'delegated_role', scopeId: Number(scopeId) };
  try { return { mode: 'jit', grant: validateElevation(hostId, actor, scopeId, permission, grantToken, options) }; }
  catch (error) {
    if (error?.code !== 'JIT_GRANT_REQUIRED') throw error;
    return { mode: 'break_glass', request: validateBreakGlass(
      hostId, actor, scopeId, grantToken, options) };
  }
}

function authorizeCriticalOperation(host, input = {}, actor, options = {}) {
  _assertEnabled(options); const database = _database(options); _host(database, host.id); _actor(actor);
  const operationKey = String(input.operationKey || '');
  const definition = CRITICAL_OPERATIONS[operationKey];
  if (!definition) throw new PrivilegedComplianceError(
    'Critical provider operation is not in the authorization allowlist',
    'CRITICAL_OPERATION_NOT_ALLOWLISTED', 400);
  if (actor.role === 'admin') return { schemaVersion: SCHEMA_VERSION, operationKey,
    permissionKey: definition.permissionKey, mode: 'global_admin', scopeId: null,
    grantId: null, expiresAt: null };
  if (!Number.isInteger(Number(input.scopeId)) || Number(input.scopeId) <= 0) {
    throw new PrivilegedComplianceError(
      'Select an organization or provider scope and supply a current JIT or break-glass grant',
      'CRITICAL_OPERATION_JIT_REQUIRED', 403, {
        operationKey, permissionKey: definition.permissionKey,
        allowedScopeTypes: ['organization', 'provider'],
      });
  }
  const scope = _scope(database, input.scopeId, host.id);
  if (!['organization', 'provider'].includes(scope.scope_type)) throw new PrivilegedComplianceError(
    'Critical provider operations require an organization or provider scope',
    'CRITICAL_OPERATION_SCOPE_REQUIRED', 409,
    { operationKey, permissionKey: definition.permissionKey, allowedScopeTypes: ['organization', 'provider'] });
  let authorization;
  try {
    authorization = _operationPermission(host.id, actor, scope.id,
      definition.permissionKey, input.grantToken, options);
  } catch (error) {
    if (!['JIT_GRANT_REQUIRED', 'PRIVILEGED_GRANT_REQUIRED'].includes(error?.code)) throw error;
    throw new PrivilegedComplianceError(
      'A current scope-bound JIT or break-glass grant is required for this critical operation',
      'CRITICAL_OPERATION_JIT_REQUIRED', 403, {
        operationKey, permissionKey: definition.permissionKey, scopeId: Number(scope.id),
      });
  }
  const evidence = authorization.grant || authorization.request || null;
  return { schemaVersion: SCHEMA_VERSION, operationKey, permissionKey: definition.permissionKey,
    mode: authorization.mode, scopeId: Number(scope.id), grantId: evidence?.id || null,
    expiresAt: evidence?.expiresAt || null };
}

function requestBreakGlass(host, input = {}, actor, options = {}) {
  _assertEnabled(options); const database = _database(options); _host(database, host.id); _actor(actor);
  const scope = _scope(database, input.scopeId, host.id);
  _operationPermission(host.id, actor, scope.id, 'privileged.break_glass.request', input.grantToken, options);
  const reason = _text(input.reason, 'reason'); const ticketRef = _key(input.ticketRef, 'ticketRef');
  const notificationRefs = _list(input.notificationRefs, 'notificationRefs', { min: 1, max: 10 });
  const recordingPolicy = input.recordingPolicy === 'screen' ? 'screen' : 'metadata';
  if (recordingPolicy === 'screen' && input.recordingConsent !== true) throw new PrivilegedComplianceError(
    'Screen recording requires explicit legal/policy consent', 'SCREEN_RECORDING_CONSENT_REQUIRED', 409);
  const recordingPolicyRef = recordingPolicy === 'screen'
    ? _key(input.recordingPolicyRef, 'recordingPolicyRef') : null;
  const recordingConsentAt = recordingPolicy === 'screen' ? new Date().toISOString() : null;
  const ttlSeconds = _integer(input.ttlSeconds ?? 900, 'ttlSeconds', 300, 3600);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const semantic = { schemaVersion: SCHEMA_VERSION, hostId: Number(host.id), scopeId: Number(scope.id),
    requestedBy: Number(actor.id), reason, ticketRef, notificationRefs, recordingPolicy,
    recordingPolicyRef, recordingConsentAt, expiresAt };
  const requestHash = sha256(_canonical(semantic)); const id = `ppbg_${generateToken(13)}`;
  database.prepare(`INSERT INTO provider_break_glass_requests
    (id,host_id,scope_id,requested_by,reason,ticket_ref,notification_refs_json,recording_policy,
      recording_policy_ref,recording_consent_at,expires_at,request_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, Number(host.id), scope.id, actor.id, reason, ticketRef, JSON.stringify(notificationRefs),
      recordingPolicy, recordingPolicyRef, recordingConsentAt, expiresAt, requestHash);
  return { request: _breakGlass(database.prepare(
    'SELECT * FROM provider_break_glass_requests WHERE id=?').get(id)), activationIssued: false,
    notificationsDispatched: false };
}

function approveBreakGlass(host, requestId, input = {}, actor, options = {}) {
  _assertEnabled(options); const database = _database(options); _host(database, host.id); _actor(actor); _refresh(database);
  const row = database.prepare(`SELECT * FROM provider_break_glass_requests
    WHERE id=? AND host_id=?`).get(String(requestId), Number(host.id));
  if (!row) throw new PrivilegedComplianceError('Break-glass request was not found', 'BREAK_GLASS_NOT_FOUND', 404);
  _authorize(actor, row.scope_id, 'privileged.break_glass.approve', options);
  if (Number(row.requested_by) === Number(actor.id)) throw new PrivilegedComplianceError(
    'Break-glass approval must be performed by an independent user', 'BREAK_GLASS_FOUR_EYES_REQUIRED', 409);
  if (row.state !== 'pending') throw new PrivilegedComplianceError(
    'Only a pending break-glass request can be approved', 'BREAK_GLASS_NOT_PENDING', 409);
  if (String(input.confirmation || '') !== `APPROVE BREAK GLASS ${row.id}`) throw new PrivilegedComplianceError(
    `Type APPROVE BREAK GLASS ${row.id} to approve`, 'BREAK_GLASS_CONFIRMATION_REQUIRED', 409);
  database.prepare(`UPDATE provider_break_glass_requests SET state='approved',approved_by=?,
    approved_at=datetime('now') WHERE id=? AND state='pending'`).run(actor.id, row.id);
  return { request: _breakGlass(database.prepare(
    'SELECT * FROM provider_break_glass_requests WHERE id=?').get(row.id)), activationIssued: false };
}

function activateBreakGlass(host, requestId, input = {}, actor, options = {}) {
  _assertEnabled(options); const database = _database(options); _host(database, host.id); _actor(actor); _refresh(database);
  const row = database.prepare(`SELECT * FROM provider_break_glass_requests
    WHERE id=? AND host_id=?`).get(String(requestId), Number(host.id));
  if (!row) throw new PrivilegedComplianceError('Break-glass request was not found', 'BREAK_GLASS_NOT_FOUND', 404);
  if (Number(row.requested_by) !== Number(actor.id)) throw new PrivilegedComplianceError(
    'Only the requesting user can activate break-glass access', 'BREAK_GLASS_SUBJECT_MISMATCH', 403);
  if (row.state !== 'approved' || row.activation_token_hash || Date.parse(row.expires_at) <= Date.now()) {
    throw new PrivilegedComplianceError('Break-glass request cannot be activated', 'BREAK_GLASS_NOT_ACTIVATABLE', 409);
  }
  if (String(input.confirmation || '') !== `ACTIVATE BREAK GLASS ${row.id}`) throw new PrivilegedComplianceError(
    `Type ACTIVATE BREAK GLASS ${row.id} to activate`, 'BREAK_GLASS_CONFIRMATION_REQUIRED', 409);
  const token = generateToken(32);
  const activated = database.prepare(`UPDATE provider_break_glass_requests SET state='active',activation_token_hash=?,
    activated_at=datetime('now') WHERE id=? AND state='approved'`).run(sha256(token), row.id);
  if (activated.changes !== 1) throw new PrivilegedComplianceError(
    'Break-glass request cannot be activated', 'BREAK_GLASS_NOT_ACTIVATABLE', 409);
  return { request: _breakGlass(database.prepare(
    'SELECT * FROM provider_break_glass_requests WHERE id=?').get(row.id)), token,
    tokenShownOnce: true, temporaryAccountCreated: false };
}

function validateBreakGlass(hostId, actor, scopeId, token, options = {}) {
  _assertEnabled(options); const database = _database(options); _actor(actor); _refresh(database);
  const raw = String(token || '');
  if (!/^[a-f0-9]{64}$/.test(raw)) throw new PrivilegedComplianceError(
    'A current JIT or break-glass token is required', 'PRIVILEGED_GRANT_REQUIRED', 403);
  const row = database.prepare(`SELECT * FROM provider_break_glass_requests
    WHERE activation_token_hash=? AND host_id=? AND scope_id=? AND requested_by=? AND state='active'
      AND activated_at IS NOT NULL AND julianday(expires_at)>julianday('now')`).get(
    sha256(raw), Number(hostId), Number(scopeId), Number(actor.id));
  if (!row) throw new PrivilegedComplianceError(
    'Break-glass token is invalid, expired or outside the requested scope', 'PRIVILEGED_GRANT_REQUIRED', 403);
  return _breakGlass(row);
}

function closeBreakGlass(host, requestId, actor, options = {}) {
  _assertEnabled(options); const database = _database(options); _host(database, host.id); _actor(actor); _refresh(database);
  const row = database.prepare(`SELECT * FROM provider_break_glass_requests
    WHERE id=? AND host_id=?`).get(String(requestId), Number(host.id));
  if (!row) throw new PrivilegedComplianceError('Break-glass request was not found', 'BREAK_GLASS_NOT_FOUND', 404);
  if (actor.role !== 'admin' && Number(row.requested_by) !== Number(actor.id)) {
    _authorize(actor, row.scope_id, 'privileged.break_glass.review', options);
  }
  if (!['approved', 'active', 'expired'].includes(row.state)) throw new PrivilegedComplianceError(
    'Break-glass request is not open', 'BREAK_GLASS_NOT_OPEN', 409);
  database.prepare(`UPDATE provider_break_glass_requests SET state='closed',activation_token_hash=NULL,
    closed_by=?,closed_at=COALESCE(closed_at,datetime('now')) WHERE id=?`).run(actor.id, row.id);
  return _breakGlass(database.prepare('SELECT * FROM provider_break_glass_requests WHERE id=?').get(row.id));
}

function reviewBreakGlass(host, requestId, input = {}, actor, options = {}) {
  _assertEnabled(options); const database = _database(options); _host(database, host.id); _actor(actor); _refresh(database);
  const row = database.prepare(`SELECT * FROM provider_break_glass_requests
    WHERE id=? AND host_id=?`).get(String(requestId), Number(host.id));
  if (!row) throw new PrivilegedComplianceError('Break-glass request was not found', 'BREAK_GLASS_NOT_FOUND', 404);
  _authorize(actor, row.scope_id, 'privileged.break_glass.review', options);
  if (Number(row.requested_by) === Number(actor.id)) throw new PrivilegedComplianceError(
    'Break-glass review must be performed by an independent user', 'BREAK_GLASS_REVIEW_INDEPENDENCE_REQUIRED', 409);
  if (!['closed', 'expired'].includes(row.state)) throw new PrivilegedComplianceError(
    'Break-glass access must be closed before review', 'BREAK_GLASS_REVIEW_NOT_READY', 409);
  const outcome = String(input.outcome || '');
  if (!['expected', 'needs_follow_up', 'policy_violation'].includes(outcome)) throw new PrivilegedComplianceError(
    'Review outcome is invalid', 'INVALID_PRIVILEGED_COMPLIANCE_INPUT');
  const notes = _text(input.notes, 'notes');
  database.prepare(`UPDATE provider_break_glass_requests SET state='reviewed',review_outcome=?,
    review_notes=?,reviewed_by=?,reviewed_at=datetime('now') WHERE id=?`).run(outcome, notes, actor.id, row.id);
  return _breakGlass(database.prepare('SELECT * FROM provider_break_glass_requests WHERE id=?').get(row.id));
}

function _resource(database, hostId, kindInput, idInput) {
  const kind = String(kindInput || ''); const id = String(idInput || '');
  if (kind === 'endpoint' && id === `endpoint:${Number(hostId)}`) return { kind, id };
  const pattern = RESOURCE_PATTERNS[kind];
  if (!pattern || !pattern.test(id)) throw new PrivilegedComplianceError(
    'Classification resource is invalid', 'CLASSIFICATION_RESOURCE_INVALID', 400);
  let found = false;
  if (kind === 'host' || kind === 'virtualMachine') found = !!database.prepare(`SELECT 1
    FROM provider_resource_identities WHERE canonical_id=? AND host_id=? AND resource_kind=?`).get(id, Number(hostId), kind);
  if (kind === 'artifact') found = !!database.prepare(
    'SELECT 1 FROM provider_artifact_catalog WHERE canonical_id=? AND host_id=?').get(id, Number(hostId));
  if (kind === 'recoveryPoint') found = !!database.prepare(
    'SELECT 1 FROM provider_recovery_points WHERE canonical_id=? AND host_id=?').get(id, Number(hostId));
  if (!found) throw new PrivilegedComplianceError(
    'Classification resource is outside the provider endpoint', 'CLASSIFICATION_RESOURCE_SCOPE_MISMATCH', 409);
  return { kind, id };
}
function _classification(row) {
  return row ? { schemaVersion: SCHEMA_VERSION, id: row.id, hostId: Number(row.host_id),
    scopeId: Number(row.scope_id), resourceKind: row.resource_kind, resourceId: row.resource_id,
    classification: row.classification, policy: _json(row.policy_json, {}),
    classificationHash: row.classification_hash, createdBy: row.created_by,
    createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

function upsertClassification(host, input = {}, actor, options = {}) {
  _assertEnabled(options); const database = _database(options); _host(database, host.id); _actor(actor);
  const scope = _scope(database, input.scopeId, host.id);
  const authorization = _operationPermission(host.id, actor, scope.id,
    'data.classification.manage', input.grantToken, options);
  const resource = _resource(database, host.id, input.resourceKind, input.resourceId);
  const classification = String(input.classification || '');
  if (!CLASSIFICATIONS.includes(classification)) throw new PrivilegedComplianceError(
    'classification must be public, internal, confidential or restricted', 'INVALID_DATA_CLASSIFICATION');
  const policy = POLICY[classification];
  const semantic = { schemaVersion: SCHEMA_VERSION, hostId: Number(host.id), scopeId: Number(scope.id),
    resourceKind: resource.kind, resourceId: resource.id, classification, policy };
  const classificationHash = sha256(_canonical(semantic));
  const existing = database.prepare(`SELECT id FROM provider_resource_classifications
    WHERE host_id=? AND resource_kind=? AND resource_id=?`).get(Number(host.id), resource.kind, resource.id);
  const id = existing?.id || `pprc_${generateToken(13)}`;
  database.prepare(`INSERT INTO provider_resource_classifications
    (id,host_id,scope_id,resource_kind,resource_id,classification,policy_json,classification_hash,created_by)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(host_id,resource_kind,resource_id) DO UPDATE SET
      scope_id=excluded.scope_id,classification=excluded.classification,policy_json=excluded.policy_json,
      classification_hash=excluded.classification_hash,created_by=excluded.created_by,updated_at=datetime('now')`)
    .run(id, Number(host.id), scope.id, resource.kind, resource.id, classification,
      JSON.stringify(policy), classificationHash, actor.id);
  return { classification: _classification(database.prepare(
    'SELECT * FROM provider_resource_classifications WHERE id=?').get(id)), created: !existing,
    authorization, providerMutationsStarted: 0 };
}

function _subjectExists(database, hostId, kind, key) {
  const sources = {
    security_finding: ['provider_security_findings', 'id'],
    classification: ['provider_resource_classifications', 'id'],
    ransomware_posture: ['provider_ransomware_posture_observations', 'id'],
    remote_session: ['provider_console_sessions', 'id'],
  };
  if (kind === 'privileged_access') return !!database.prepare(`SELECT 1 FROM (
    SELECT id,host_id FROM provider_privileged_elevation_grants UNION ALL
    SELECT id,host_id FROM provider_break_glass_requests) WHERE id=? AND host_id=?`).get(key, Number(hostId));
  const source = sources[kind];
  return !!source && _table(database, source[0])
    && !!database.prepare(`SELECT 1 FROM ${source[0]} WHERE ${source[1]}=? AND host_id=?`).get(key, Number(hostId));
}

function importMappings(host, input = {}, actor, options = {}) {
  _assertEnabled(options); const database = _database(options); _host(database, host.id); _actor(actor);
  const scope = _scope(database, input.scopeId, host.id);
  const authorization = _operationPermission(host.id, actor, scope.id,
    'compliance.mapping.manage', input.grantToken, options);
  if (!Array.isArray(input.mappings) || !input.mappings.length || input.mappings.length > 200) {
    throw new PrivilegedComplianceError('mappings must contain 1-200 entries', 'INVALID_COMPLIANCE_MAPPING');
  }
  const normalized = input.mappings.map((item, index) => {
    const subjectKind = String(item?.subjectKind || ''); const subjectKey = _key(item?.subjectKey, `mappings[${index}].subjectKey`);
    const framework = String(item?.framework || '').toUpperCase();
    const controlRef = _key(item?.controlRef, `mappings[${index}].controlRef`);
    const rationale = _text(item?.rationale, `mappings[${index}].rationale`);
    if (!['security_finding', 'classification', 'ransomware_posture', 'privileged_access', 'remote_session'].includes(subjectKind)
      || !FRAMEWORKS.has(framework)) throw new PrivilegedComplianceError(
      `mappings[${index}] has an invalid subject or framework`, 'INVALID_COMPLIANCE_MAPPING');
    if (!_subjectExists(database, host.id, subjectKind, subjectKey)) throw new PrivilegedComplianceError(
      `mappings[${index}] subject was not found`, 'COMPLIANCE_MAPPING_SUBJECT_NOT_FOUND', 404);
    return { subjectKind, subjectKey, framework, controlRef, rationale };
  });
  const unique = new Map(normalized.map(item => [
    `${item.subjectKind}|${item.subjectKey}|${item.framework}|${item.controlRef}`, item]));
  const insert = database.prepare(`INSERT INTO provider_compliance_control_mappings
    (host_id,scope_id,subject_kind,subject_key,framework,control_ref,rationale,mapping_hash,created_by)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(host_id,subject_kind,subject_key,framework,control_ref)
    DO UPDATE SET scope_id=excluded.scope_id,rationale=excluded.rationale,
      mapping_hash=excluded.mapping_hash,created_by=excluded.created_by`);
  database.transaction(() => {
    for (const item of unique.values()) {
      const mappingHash = sha256(_canonical({ schemaVersion: SCHEMA_VERSION, hostId: Number(host.id),
        scopeId: Number(scope.id), ...item }));
      insert.run(Number(host.id), scope.id, item.subjectKind, item.subjectKey,
        item.framework, item.controlRef, item.rationale, mappingHash, actor.id);
    }
  })();
  const items = database.prepare(`SELECT id,scope_id AS scopeId,subject_kind AS subjectKind,
    subject_key AS subjectKey,framework,control_ref AS controlRef,rationale,mapping_hash AS mappingHash,
    created_at AS createdAt FROM provider_compliance_control_mappings WHERE host_id=?
    ORDER BY subject_kind,subject_key,framework,control_ref LIMIT 1000`).all(Number(host.id));
  return { schemaVersion: SCHEMA_VERSION, count: items.length, items, authorization,
    duplicatedFindingsCreated: 0, providerMutationsStarted: 0 };
}

function _posture(row) {
  return row ? { schemaVersion: SCHEMA_VERSION, id: row.id, hostId: Number(row.host_id),
    scopeId: Number(row.scope_id), source: row.source, factors: _json(row.factors_json, {}),
    score: Number(row.score), confidence: row.confidence, evidenceHash: row.evidence_hash,
    observedAt: row.observed_at, createdAt: row.created_at } : null;
}
function recordRansomwarePosture(host, input = {}, actor, options = {}) {
  _assertEnabled(options); const database = _database(options); _host(database, host.id); _actor(actor);
  const scope = _scope(database, input.scopeId, host.id);
  const authorization = _operationPermission(host.id, actor, scope.id,
    'recovery.ransomware_posture.manage', input.grantToken, options);
  const source = input.source === 'provider' ? 'provider' : 'imported_evidence';
  const factorInput = input.factors && typeof input.factors === 'object' && !Array.isArray(input.factors)
    ? input.factors : {};
  const factors = {};
  for (const key of ['immutability', 'isolation', 'restoreTests', 'credentialSeparation']) {
    const raw = factorInput[key] && typeof factorInput[key] === 'object' ? factorInput[key] : {};
    const state = String(raw.state || '');
    if (!FACTOR_STATES.has(state)) throw new PrivilegedComplianceError(
      `${key}.state is invalid`, 'INVALID_RANSOMWARE_POSTURE');
    factors[key] = { state, evidenceRef: _key(raw.evidenceRef, `${key}.evidenceRef`),
      observedAt: _timestamp(raw.observedAt || input.observedAt, `${key}.observedAt`) };
  }
  const applicable = Object.values(factors).filter(item => item.state !== 'not_applicable');
  const verified = applicable.filter(item => item.state === 'verified').length;
  const score = applicable.length ? Math.round(verified * 100 / applicable.length) : 0;
  const known = applicable.filter(item => item.state !== 'unknown').length;
  const confidence = known === applicable.length ? 'high' : known >= Math.ceil(applicable.length / 2) ? 'medium' : 'low';
  const observedAt = _timestamp(input.observedAt || new Date().toISOString(), 'observedAt');
  const semantic = { schemaVersion: SCHEMA_VERSION, hostId: Number(host.id), scopeId: Number(scope.id),
    source, factors, score, confidence, observedAt };
  const evidenceHash = sha256(_canonical(semantic)); const id = `pprp_${generateToken(13)}`;
  database.prepare(`INSERT OR IGNORE INTO provider_ransomware_posture_observations
    (id,host_id,scope_id,source,factors_json,score,confidence,evidence_hash,observed_at,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, Number(host.id), scope.id, source,
    JSON.stringify(factors), score, confidence, evidenceHash, observedAt, actor.id);
  const row = database.prepare('SELECT * FROM provider_ransomware_posture_observations WHERE evidence_hash=?').get(evidenceHash);
  return { posture: _posture(row), authorization, scoreModel: 'equal-weight-applicable-factors',
    providerMutationsStarted: 0 };
}

function _mappingIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    const key = `${row.subject_kind}:${row.subject_key}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ framework: row.framework, controlRef: row.control_ref,
      rationale: row.rationale, mappingHash: row.mapping_hash });
  }
  return index;
}
function _maxClassification(items) {
  let rank = 0;
  for (const item of items) rank = Math.max(rank, CLASSIFICATIONS.indexOf(item.classification));
  return CLASSIFICATIONS[Math.max(0, rank)];
}
function _pdf(lines) {
  const safe = lines.slice(0, 48).map(line => String(line).replace(/[^\x20-\x7e]/g, '?')
    .replace(/([\\()])/g, '\\$1').slice(0, 105));
  const commands = ['BT', '/F1 10 Tf', '48 790 Td'];
  safe.forEach((line, index) => { if (index) commands.push('0 -15 Td'); commands.push(`(${line}) Tj`); });
  commands.push('ET'); const stream = commands.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body); body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index++) body += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'ascii');
}

function createComplianceExport(host, input = {}, actor, options = {}) {
  _assertEnabled(options); const database = _database(options); _host(database, host.id); _actor(actor);
  const scope = _scope(database, input.scopeId, host.id);
  if (!['organization', 'provider'].includes(scope.scope_type)) throw new PrivilegedComplianceError(
    'Endpoint compliance exports require an organization or provider scope',
    'COMPLIANCE_EXPORT_SCOPE_TOO_NARROW', 409, { scopeId: Number(scope.id) });
  const authorization = _operationPermission(host.id, actor, scope.id,
    'compliance.evidence.export', input.grantToken, options);
  const format = input.format === 'pdf' ? 'pdf' : 'json';
  const mappings = database.prepare(`SELECT * FROM provider_compliance_control_mappings
    WHERE host_id=? ORDER BY subject_kind,subject_key,framework,control_ref LIMIT 2000`).all(Number(host.id));
  const mappingIndex = _mappingIndex(mappings);
  const classifications = database.prepare(`SELECT * FROM provider_resource_classifications
    WHERE host_id=? ORDER BY resource_kind,resource_id LIMIT 1000`).all(Number(host.id));
  const findings = _table(database, 'provider_security_findings') ? database.prepare(`SELECT
    id,advisory_id,cve_ids_json,severity,priority_score,confidence,evidence_hash,state,observed_at
    FROM provider_security_findings WHERE host_id=? ORDER BY priority_score DESC,id LIMIT 1000`).all(Number(host.id)) : [];
  const postureRow = database.prepare(`SELECT * FROM provider_ransomware_posture_observations
    WHERE host_id=? ORDER BY observed_at DESC,id DESC LIMIT 1`).get(Number(host.id));
  const governanceService = options.governanceService || governance;
  const canReadSessionEvidence = actor.role === 'admin'
    || governanceService.can(actor, Number(scope.id), 'privileged.session_recording.read');
  const sessions = canReadSessionEvidence ? database.prepare(`SELECT id,resource_id,provider_type,protocol,user_id,created_at,
    connected_at,closed_at,close_code,recording_policy,recording_policy_ref,recording_consent_at,recording_state
    FROM provider_console_sessions WHERE host_id=? ORDER BY created_at DESC LIMIT 500`).all(Number(host.id)) : [];
  const grants = database.prepare(`SELECT id,scope_id,permission_key,requested_by,state,expires_at,grant_hash,
    approved_by,approved_at,claimed_at FROM provider_privileged_elevation_grants
    WHERE host_id=? ORDER BY created_at DESC LIMIT 500`).all(Number(host.id));
  const breakGlass = database.prepare(`SELECT id,scope_id,requested_by,ticket_ref,recording_policy,
    recording_policy_ref,recording_consent_at,state,
    expires_at,approved_by,approved_at,activated_at,closed_at,review_outcome,reviewed_by,reviewed_at,request_hash
    FROM provider_break_glass_requests WHERE host_id=? ORDER BY created_at DESC LIMIT 500`).all(Number(host.id));
  const audits = _table(database, 'audit_log') ? database.prepare(`SELECT id,action,target_type,target_id,
    created_at,entry_hash FROM audit_log WHERE target_type='provider_host' AND target_id=?
    ORDER BY id DESC LIMIT 500`).all(String(host.id)) : [];
  const generatedAt = new Date().toISOString();
  const classification = _maxClassification(classifications);
  const exportMode = POLICY[classification].evidenceExport;
  const controlsFor = (kind, id) => (mappingIndex.get(`${kind}:${id}`) || []).map(control =>
    exportMode === 'hashes_only' ? { framework: control.framework, controlRef: control.controlRef,
      mappingHash: control.mappingHash } : control);
  const findingItems = findings.map(row => exportMode === 'hashes_only'
    ? { id: row.id, evidenceHash: row.evidence_hash, controls: controlsFor('security_finding', row.id) }
    : exportMode === 'redacted'
      ? { id: row.id, severity: row.severity, priorityScore: Number(row.priority_score),
        confidence: row.confidence, state: row.state, evidenceHash: row.evidence_hash,
        observedAt: row.observed_at, controls: controlsFor('security_finding', row.id) }
      : { id: row.id, advisoryId: row.advisory_id, cveIds: _json(row.cve_ids_json, []),
        severity: row.severity, priorityScore: Number(row.priority_score), confidence: row.confidence,
        state: row.state, evidenceHash: row.evidence_hash, observedAt: row.observed_at,
        controls: controlsFor('security_finding', row.id) });
  const classificationItems = classifications.map(row => exportMode === 'hashes_only'
    ? { id: row.id, classification: row.classification, classificationHash: row.classification_hash,
      controls: controlsFor('classification', row.id) }
    : exportMode === 'redacted'
      ? { id: row.id, resourceKind: row.resource_kind, classification: row.classification,
        policy: _json(row.policy_json, {}), classificationHash: row.classification_hash,
        controls: controlsFor('classification', row.id) }
      : { id: row.id, resourceKind: row.resource_kind, resourceId: row.resource_id,
        classification: row.classification, policy: _json(row.policy_json, {}),
        classificationHash: row.classification_hash, controls: controlsFor('classification', row.id) });
  const posture = postureRow ? { ..._posture(postureRow), controls: controlsFor('ransomware_posture', postureRow.id) } : null;
  const postureItem = posture && exportMode === 'hashes_only' ? { id: posture.id, score: posture.score,
    confidence: posture.confidence, evidenceHash: posture.evidenceHash, controls: posture.controls } : posture;
  const privilegedAccess = exportMode === 'hashes_only'
    ? { grants: grants.map(row => ({ id: row.id, state: row.state, grantHash: row.grant_hash,
      controls: controlsFor('privileged_access', row.id) })),
    breakGlass: breakGlass.map(row => ({ id: row.id, state: row.state, requestHash: row.request_hash,
      controls: controlsFor('privileged_access', row.id) })) }
    : { grants: grants.map(row => ({ ...row, controls: controlsFor('privileged_access', row.id) })),
    breakGlass: breakGlass.map(row => ({ ...row, controls: controlsFor('privileged_access', row.id) })) };
  const remoteSessions = exportMode === 'hashes_only' ? [] : sessions.map(row => exportMode === 'redacted'
    ? { id: row.id, provider_type: row.provider_type, protocol: row.protocol,
      created_at: row.created_at, connected_at: row.connected_at, closed_at: row.closed_at,
      recording_policy: row.recording_policy, recording_state: row.recording_state,
      controls: controlsFor('remote_session', row.id) }
    : { ...row, controls: controlsFor('remote_session', row.id) });
  const auditLinks = exportMode === 'hashes_only'
    ? audits.map(row => ({ id: row.id, entryHash: row.entry_hash })) : audits;
  const bundle = { schemaVersion: SCHEMA_VERSION, kind: 'docker-dash-compliance-evidence', generatedAt,
    provider: { hostId: Number(host.id), type: String(host.daemon_type), scopeId: Number(scope.id) },
    classification, exportMode, findings: findingItems, classifications: classificationItems,
    ransomwarePosture: postureItem, privilegedAccess, remoteSessions,
    remoteSessionSummary: exportMode === 'hashes_only' ? { count: sessions.length } : null,
    auditLinks,
    safety: { rawConfigurationStored: false, secretMaterialStored: false,
      sessionScreenContentStored: false, sessionEvidenceWithheld: !canReadSessionEvidence,
      providerNetworkCallsStarted: 0 } };
  const bundleHash = sha256(_canonical(bundle));
  const signingSecret = options.signingSecret || config.security.encryptionKey;
  if (!signingSecret) throw new PrivilegedComplianceError(
    'ENCRYPTION_KEY is required to sign compliance evidence', 'COMPLIANCE_SIGNING_KEY_REQUIRED', 503);
  const signature = hmacSign(`docker-dash-compliance-v1:${bundleHash}`, signingSecret);
  const id = `ppce_${generateToken(13)}`;
  const summary = { findingCount: findings.length, classificationCount: classifications.length,
    mappingCount: mappings.length, sessionCount: sessions.length,
    auditLinkCount: bundle.auditLinks.length, ransomwarePostureIncluded: !!bundle.ransomwarePosture };
  database.prepare(`INSERT INTO provider_compliance_exports
    (id,host_id,scope_id,format,classification,bundle_hash,signature,summary_json,created_by)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, Number(host.id), scope.id, format, bundle.classification,
    bundleHash, signature, JSON.stringify(summary), actor.id);
  const exported = { schemaVersion: SCHEMA_VERSION, id, hostId: Number(host.id), scopeId: Number(scope.id),
    format, classification: bundle.classification, bundleHash, signature,
    signatureAlgorithm: 'HMAC-SHA256', summary, generatedAt, authorization };
  if (format === 'pdf') {
    const content = _pdf(['Docker Dash Compliance Evidence', `Export: ${id}`, `Generated: ${generatedAt}`,
      `Provider: ${exportMode === 'full' || exportMode === 'metadata' ? (host.name || host.id) : host.id} (${host.daemon_type})`,
      `Classification: ${bundle.classification}`, `Export policy: ${exportMode}`,
      `Findings: ${summary.findingCount}`, `Classified resources: ${summary.classificationCount}`,
      `Control mappings: ${summary.mappingCount}`, `Remote sessions: ${summary.sessionCount}`,
      `Audit links: ${summary.auditLinkCount}`, `Bundle SHA-256: ${bundleHash}`,
      `HMAC-SHA256: ${signature}`, 'Screen/session payload and secret material are not included.']);
    return { export: exported, content, contentType: 'application/pdf', bundleStored: false };
  }
  return { export: exported, bundle: { ...bundle, integrity: { bundleHash, signature,
    signatureAlgorithm: 'HMAC-SHA256', signingScope: 'installation-local' } }, bundleStored: false };
}

function overview(host, actor, options = {}) {
  _assertEnabled(options); const database = _database(options); _host(database, host.id); _actor(actor); _refresh(database);
  const governanceService = options.governanceService || governance;
  const permissionKeys = [
    'privileged.elevation.request', 'privileged.elevation.approve',
    'privileged.break_glass.request', 'privileged.break_glass.approve',
    'privileged.break_glass.review', 'privileged.session_recording.read',
    'data.classification.manage', 'compliance.evidence.export',
    'compliance.mapping.manage', 'recovery.ransomware_posture.manage',
  ];
  let actorPermissions = actor.role === 'admin' ? [...permissionKeys] : [];
  if (actor.role !== 'admin') {
    try {
      const scopes = governanceService.listScopes(actor);
      actorPermissions = permissionKeys.filter(permission => scopes.some(scope =>
        governanceService.can(actor, scope.id, permission)));
    } catch { actorPermissions = []; }
  }
  const allowed = new Set(actorPermissions);
  const canReadGrants = actor.role === 'admin' || allowed.has('privileged.elevation.approve');
  const canReadBreakGlass = actor.role === 'admin' || allowed.has('privileged.break_glass.approve')
    || allowed.has('privileged.break_glass.review');
  const canReadSessions = actor.role === 'admin' || allowed.has('privileged.session_recording.read');
  const grants = database.prepare(`SELECT * FROM provider_privileged_elevation_grants WHERE host_id=?
    ORDER BY created_at DESC LIMIT 100`).all(Number(host.id))
    .filter(row => canReadGrants || Number(row.requested_by) === Number(actor.id)).map(_elevation);
  const requests = database.prepare(`SELECT * FROM provider_break_glass_requests WHERE host_id=?
    ORDER BY created_at DESC LIMIT 100`).all(Number(host.id))
    .filter(row => canReadBreakGlass || Number(row.requested_by) === Number(actor.id)).map(_breakGlass);
  const classifications = database.prepare(`SELECT * FROM provider_resource_classifications WHERE host_id=?
    ORDER BY updated_at DESC LIMIT 500`).all(Number(host.id)).map(_classification);
  const mappings = database.prepare(`SELECT id,scope_id AS scopeId,subject_kind AS subjectKind,
    subject_key AS subjectKey,framework,control_ref AS controlRef,rationale,mapping_hash AS mappingHash,
    created_at AS createdAt FROM provider_compliance_control_mappings WHERE host_id=?
    ORDER BY created_at DESC LIMIT 500`).all(Number(host.id));
  const exports = database.prepare(`SELECT id,scope_id AS scopeId,format,classification,
    bundle_hash AS bundleHash,signature,signature_algorithm AS signatureAlgorithm,
    summary_json AS summary,created_by AS createdBy,created_at AS createdAt
    FROM provider_compliance_exports WHERE host_id=? ORDER BY created_at DESC LIMIT 100`).all(Number(host.id))
    .map(row => ({ ...row, summary: _json(row.summary, {}) }));
  const postures = database.prepare(`SELECT * FROM provider_ransomware_posture_observations WHERE host_id=?
    ORDER BY observed_at DESC LIMIT 100`).all(Number(host.id)).map(_posture);
  const sessions = canReadSessions ? database.prepare(`SELECT id,resource_id AS resourceId,provider_type AS providerType,
    protocol,user_id AS userId,created_at AS createdAt,connected_at AS connectedAt,closed_at AS closedAt,
    close_code AS closeCode,recording_policy AS recordingPolicy,recording_policy_ref AS recordingPolicyRef,
    recording_consent_at AS recordingConsentAt,recording_state AS recordingState
    FROM provider_console_sessions WHERE host_id=? ORDER BY created_at DESC LIMIT 100`).all(Number(host.id)) : [];
  const permissionCount = database.prepare(`SELECT COUNT(*) AS count FROM governance_permissions
    WHERE permission_key IN (${[...Array(10)].map(() => '?').join(',')})`).get(
    'privileged.elevation.request', 'privileged.elevation.approve', 'privileged.break_glass.request',
    'privileged.break_glass.approve', 'privileged.break_glass.review', 'privileged.session_recording.read',
    'data.classification.manage', 'compliance.evidence.export', 'compliance.mapping.manage',
    'recovery.ransomware_posture.manage').count;
  const customRoleCount = database.prepare(`SELECT COUNT(DISTINCT rp.role_id) AS count
    FROM governance_role_permissions rp JOIN governance_roles r ON r.id=rp.role_id
    WHERE r.is_builtin=0 AND rp.permission_key IN (
      'privileged.elevation.request','privileged.elevation.approve','privileged.break_glass.request',
      'privileged.break_glass.approve','privileged.break_glass.review','privileged.session_recording.read',
      'data.classification.manage','compliance.evidence.export','compliance.mapping.manage',
      'recovery.ransomware_posture.manage')`).get().count;
  return { schemaVersion: SCHEMA_VERSION, hostId: Number(host.id), capabilities: {
    B169: 'step-up-mfa-four-eyes-jit', B170: 'temporary-scoped-break-glass-envelope',
    B171: 'metadata-recording-and-screen-consent-policy', B172: 'classification-policy-projection',
    B173: 'signed-json-pdf-evidence', B174: 'deduplicated-control-mapping',
    B175: 'evidence-based-ransomware-score', B176: 'permission-catalog-integrated',
    B177: 'custom-role-integrated', B178: 'scope-hierarchy-integrated' },
  governanceIntegration: { permissionCount: Number(permissionCount), customRoleCount: Number(customRoleCount),
    actorPermissions,
    scopeTypes: ['organization', 'site', 'provider', 'cluster', 'project', 'resource'] },
  grants, breakGlass: requests, remoteSessions: sessions, classifications, mappings,
  ransomwarePostures: postures, exports,
  counts: { grants: grants.length, activeGrants: grants.filter(item => item.state === 'active').length,
    breakGlass: requests.length, activeBreakGlass: requests.filter(item => item.state === 'active').length,
    unreviewedBreakGlass: requests.filter(item => ['closed', 'expired'].includes(item.state)).length,
    remoteSessions: sessions.length, classifications: classifications.length, mappings: mappings.length,
    ransomwarePostures: postures.length, exports: exports.length },
  safety: { providerMutationsStarted: 0, externalNotificationsDispatched: false,
    temporaryAccountCreated: false, screenRecordingStored: false, evidenceBundleStored: false },
  limitations: [
    'Break-glass creates a scoped temporary access envelope, not a standalone login account.',
    'Screen recording requires policy and consent, but this release stores metadata only and has no media recorder.',
    'Framework mappings are organization-authored references and are not a certification verdict.',
    'Compliance signatures are installation-local HMAC-SHA256, not a public-key attestation.',
  ] };
}

module.exports = {
  SCHEMA_VERSION, CLASSIFICATIONS, FRAMEWORKS, ELEVATABLE, CRITICAL_OPERATIONS, POLICY,
  PrivilegedComplianceError,
  requestElevation, approveElevation, claimElevation, validateElevation, revokeElevation,
  authorizeCriticalOperation,
  requestBreakGlass, approveBreakGlass, activateBreakGlass, validateBreakGlass,
  closeBreakGlass, reviewBreakGlass,
  upsertClassification, importMappings, recordRansomwarePosture, createComplianceExport, overview,
  _internals: { _canonical, _scope, _resource, _pdf, _maxClassification, _operationPermission },
};
