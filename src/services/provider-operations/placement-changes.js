'use strict';

const config = require('../../config');
const { getDb } = require('../../db');
const { encrypt, decrypt, sha256, generateToken } = require('../../utils/crypto');
const registrySingleton = require('../provider-sdk/registry');
const advisorySingleton = require('../provider-sdk/placement-advisory');
const vmMigrationSingleton = require('./vm-migration');
const policySingleton = require('./policy');
const nativeSingleton = require('./placement-change-provider');

const CHANGE_KINDS = Object.freeze(['ha_policy', 'affinity_rule', 'rebalance_apply']);
const RULE_KINDS = Object.freeze(['vm_vm_affinity', 'vm_vm_anti_affinity', 'vm_host_affinity', 'vm_host_anti_affinity', 'home_host_preference']);
const RESTART_POLICIES = Object.freeze(['disabled', 'best_effort', 'guaranteed']);
const RESTART_PRIORITIES = Object.freeze(['default', 'lowest', 'low', 'medium', 'high', 'highest']);
const SAFE_CHANGE_ID = /^pcr_[a-f0-9]{26}$/;
const SAFE_VM_ID = /^ddr_vm_[a-f0-9]{26}$/;
const SAFE_HOST_ID = /^ddr_host_[a-f0-9]{26}$/;
const SAFE_CLUSTER_ID = /^ddr_cluster_[a-f0-9]{26}$/;
const TERMINAL = new Set(['succeeded', 'rejected', 'cancelled', 'failed', 'unknown', 'rolled_back', 'rollback_failed']);
const CHILD_TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);

class PlacementChangeError extends Error {
  constructor(message, code = 'PLACEMENT_CHANGE_ERROR', status = 400, details = null) {
    super(message); this.name = 'PlacementChangeError'; this.code = code; this.status = status; this.details = details;
  }
}

function _database(options) { return options.database || getDb(); }
function _now() { return new Date().toISOString(); }
function _text(value, max = 240) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}
function _json(value, fallback = null) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function _boundedInteger(value, name, min, max, optional = false) {
  if ((value === undefined || value === null || value === '') && optional) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new PlacementChangeError(`${name} must be an integer between ${min} and ${max}`, 'INVALID_PLACEMENT_CHANGE_INPUT');
  }
  return number;
}

function _featureFor(kind) {
  return { ha_policy: 'cluster.ha.policy.mutate', affinity_rule: 'placement.affinity.mutate', rebalance_apply: 'placement.rebalance.apply' }[kind];
}

function _enabledFor(kind, options = {}) {
  if (options.enabled !== undefined) return options.enabled === true;
  return kind === 'ha_policy' ? config.features.providerHaPolicyMutation
    : (kind === 'affinity_rule' ? config.features.providerAffinityMutation : config.features.providerRebalanceApply);
}

function _baseInput(value = {}) {
  const changeKind = String(value.changeKind || '');
  if (!CHANGE_KINDS.includes(changeKind)) throw new PlacementChangeError('Placement change kind is invalid', 'INVALID_PLACEMENT_CHANGE_KIND');
  return { changeKind };
}

function _haInput(value) {
  if (!SAFE_VM_ID.test(String(value.vmId || ''))) throw new PlacementChangeError('Canonical VM is required', 'INVALID_PLACEMENT_CHANGE_INPUT');
  if (value.clusterId !== undefined && value.clusterId !== null && !SAFE_CLUSTER_ID.test(String(value.clusterId))) {
    throw new PlacementChangeError('Canonical cluster is invalid', 'INVALID_PLACEMENT_CHANGE_INPUT');
  }
  const policy = value.policy && typeof value.policy === 'object' && !Array.isArray(value.policy) ? value.policy : {};
  const allowed = new Set(['restartPolicy', 'restartPriority', 'maxRestarts', 'maxRelocations', 'startOrder', 'startDelaySeconds']);
  const unknown = Object.keys(policy).filter(key => !allowed.has(key));
  if (unknown.length || !Object.keys(policy).length) throw new PlacementChangeError('HA policy contains unknown fields or is empty', 'INVALID_HA_POLICY');
  if (policy.restartPolicy !== undefined && !RESTART_POLICIES.includes(String(policy.restartPolicy))) {
    throw new PlacementChangeError('HA restart policy is invalid', 'INVALID_HA_POLICY');
  }
  if (policy.restartPriority !== undefined && !RESTART_PRIORITIES.includes(String(policy.restartPriority))) {
    throw new PlacementChangeError('HA restart priority is invalid', 'INVALID_HA_POLICY');
  }
  return {
    vmId: String(value.vmId), clusterId: value.clusterId ? String(value.clusterId) : null,
    policy: {
      ...(policy.restartPolicy !== undefined ? { restartPolicy: String(policy.restartPolicy) } : {}),
      ...(policy.restartPriority !== undefined ? { restartPriority: String(policy.restartPriority) } : {}),
      ...(['maxRestarts', 'maxRelocations'].reduce((out, key) => policy[key] === undefined ? out
        : { ...out, [key]: _boundedInteger(policy[key], key, 0, 20) }, {})),
      ...(policy.startOrder !== undefined ? { startOrder: _boundedInteger(policy.startOrder, 'startOrder', 0, 10000) } : {}),
      ...(policy.startDelaySeconds !== undefined ? { startDelaySeconds: _boundedInteger(policy.startDelaySeconds, 'startDelaySeconds', 0, 86400) } : {}),
    },
  };
}

function _ids(values, regex, name, max) {
  if (!Array.isArray(values) || values.length > max) throw new PlacementChangeError(`${name} must be a bounded array`, 'INVALID_AFFINITY_RULE');
  const result = [...new Set(values.map(String))];
  if (result.some(value => !regex.test(value))) throw new PlacementChangeError(`${name} contains an invalid canonical ID`, 'INVALID_AFFINITY_RULE');
  return result;
}

function _affinityInput(value) {
  const action = String(value.action || '');
  if (!['create', 'update', 'delete'].includes(action)) throw new PlacementChangeError('Affinity action is invalid', 'INVALID_AFFINITY_RULE');
  if (action !== 'create' && !/^ddp_rule_[a-f0-9]{26}$/.test(String(value.ruleId || ''))) {
    throw new PlacementChangeError('Canonical placement rule is required', 'INVALID_AFFINITY_RULE');
  }
  if (action === 'delete') return { action, ruleId: String(value.ruleId) };
  const rule = value.rule && typeof value.rule === 'object' && !Array.isArray(value.rule) ? value.rule : {};
  const kind = String(rule.kind || '');
  const name = _text(rule.name, 80);
  if (!RULE_KINDS.includes(kind) || !name || !/^[a-zA-Z0-9][a-zA-Z0-9 _.:-]{0,79}$/.test(name)) {
    throw new PlacementChangeError('Affinity rule kind or name is invalid', 'INVALID_AFFINITY_RULE');
  }
  const vmIds = _ids(rule.vmIds || [], SAFE_VM_ID, 'vmIds', 64);
  const hostIds = _ids(rule.hostIds || [], SAFE_HOST_ID, 'hostIds', 64);
  if (['vm_vm_affinity', 'vm_vm_anti_affinity'].includes(kind) && vmIds.length < 2) {
    throw new PlacementChangeError('VM affinity rules require at least two VMs', 'INVALID_AFFINITY_RULE');
  }
  if (['vm_host_affinity', 'vm_host_anti_affinity'].includes(kind) && (!vmIds.length || !hostIds.length)) {
    throw new PlacementChangeError('VM-host rules require VM and host members', 'INVALID_AFFINITY_RULE');
  }
  if (kind === 'home_host_preference' && (vmIds.length !== 1 || hostIds.length !== 1)) {
    throw new PlacementChangeError('Home-host preference requires exactly one VM and one host', 'INVALID_AFFINITY_RULE');
  }
  const clusterId = rule.clusterId == null ? null : String(rule.clusterId);
  if (clusterId && !SAFE_CLUSTER_ID.test(clusterId)) throw new PlacementChangeError('Canonical cluster is invalid', 'INVALID_AFFINITY_RULE');
  return { action, ruleId: action === 'update' ? String(value.ruleId) : null,
    rule: { name, kind, vmIds, hostIds, clusterId, enabled: rule.enabled !== false, mandatory: rule.mandatory === true } };
}

function _rebalanceInput(value) {
  const waveSize = _boundedInteger(value.waveSize ?? config.providerPlacementChanges.concurrency,
    'waveSize', 1, config.providerPlacementChanges.concurrency);
  const rollbackOf = value.rollbackOf == null ? null : String(value.rollbackOf);
  if (rollbackOf && !SAFE_CHANGE_ID.test(rollbackOf)) throw new PlacementChangeError('Rollback source is invalid', 'INVALID_REBALANCE_PLAN_HASH');
  const maxMoves = _boundedInteger(value.maxMoves ?? config.providerPlacementChanges.maxMoves,
    'maxMoves', 1, config.providerPlacementChanges.maxMoves);
  const sourceThresholdPercent = value.sourceThresholdPercent === undefined ? 85 : Number(value.sourceThresholdPercent);
  const targetThresholdPercent = value.targetThresholdPercent === undefined ? 75 : Number(value.targetThresholdPercent);
  const advisoryPlanHash = rollbackOf ? null : String(value.advisoryPlanHash || '');
  if (!rollbackOf && !/^[a-f0-9]{64}$/.test(advisoryPlanHash)) throw new PlacementChangeError('V2.5 advisory plan hash is required', 'INVALID_REBALANCE_PLAN_HASH');
  let windowEndsAt = null;
  if (value.windowEndsAt) {
    windowEndsAt = new Date(value.windowEndsAt).toISOString();
    if (Date.parse(windowEndsAt) <= Date.now()) throw new PlacementChangeError('Maintenance window already ended', 'INVALID_MAINTENANCE_WINDOW');
  }
  return { waveSize, maxMoves, sourceThresholdPercent, targetThresholdPercent, advisoryPlanHash, windowEndsAt, rollbackOf };
}

function _diff(before, desired) {
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(desired || {})])].sort();
  return keys.filter(key => JSON.stringify(before?.[key] ?? null) !== JSON.stringify(desired?.[key] ?? null))
    .map(key => ({ path: key, before: before?.[key] ?? null, after: desired?.[key] ?? null }));
}

function _semantic(plan) {
  return {
    schemaVersion: plan.schemaVersion, endpointId: plan.provider.endpointId,
    changeKind: plan.changeKind, action: plan.action,
    resource: plan.resource, capability: { state: plan.capability.state, constraints: plan.capability.constraints || null },
    before: plan.before, desired: plan.desired, diff: plan.diff,
    moves: (plan.moves || []).map(item => ({ vmId: item.vm.id, sourceHostId: item.sourceHostId,
      targetHostId: item.targetHostId, mode: item.mode })),
    blockers: plan.blockers, warnings: plan.warnings,
  };
}

function _publicPlan(plan) {
  const { _native, ...safe } = plan;
  return safe;
}

function _capabilityAllowed(capability) { return ['supported', 'conditional'].includes(capability?.state); }

async function preflightForHost(host, value = {}, options = {}) {
  if (!host || !Number.isInteger(Number(host.id))) throw new PlacementChangeError('Provider endpoint was not found', 'INVALID_OPERATION_HOST', 404);
  const { changeKind } = _baseInput(value);
  const database = _database(options); const registry = options.registry || registrySingleton;
  const capabilities = await registry.capabilitiesForHost(host);
  const capability = capabilities.features?.[_featureFor(changeKind)] || { state: 'unknown', reason: 'No capability evidence' };
  const blockers = []; const warnings = [];
  if (!_capabilityAllowed(capability)) blockers.push({ type: 'CAPABILITY_UNSUPPORTED', reason: capability.reason || 'Mutation capability is unavailable', source: 'provider' });
  if (!_enabledFor(changeKind, options)) blockers.push({ type: 'RELEASE_DISABLED', reason: 'This placement mutation release flag is disabled', source: 'release' });
  if (options.canOperate !== true) blockers.push({ type: 'PERMISSION_DENIED', reason: 'Administrator endpoint operate permission is required', source: 'rbac' });
  const decision = (options.policy || policySingleton).evaluate({ providerType: host.daemon_type, hostId: Number(host.id) });
  if (!decision.allowed) blockers.push({ type: decision.code || 'OPERATION_POLICY_BLOCKED', reason: decision.reason, source: 'policy' });
  const expiresAt = new Date(Date.now() + config.providerPlacementChanges.approvalTtlMs).toISOString();
  let plan;
  if (changeKind === 'rebalance_apply') {
    const input = _rebalanceInput(value);
    let advisory;
    if (input.rollbackOf) {
      const original = database.prepare('SELECT * FROM provider_placement_changes WHERE id = ? AND host_id = ?').get(input.rollbackOf, Number(host.id));
      if (!original || original.change_kind !== 'rebalance_apply' || original.state !== 'succeeded') {
        throw new PlacementChangeError('Only a succeeded rebalance can produce a rollback plan', 'PLACEMENT_CHANGE_ROLLBACK_UNAVAILABLE', 409);
      }
      const succeeded = database.prepare(`SELECT * FROM provider_placement_change_items
        WHERE change_id = ? AND state = 'succeeded' ORDER BY sequence`).all(original.id).slice(0, input.maxMoves);
      const reverse = [];
      for (const item of succeeded) {
        try {
          const child = await (options.vmMigration || vmMigrationSingleton).preflightForHost(host, item.vm_id,
            { targetId: item.source_host_id, mode: item.mode }, { database, canOperate: true, enabled: true });
          if (child.sourceTargetId !== item.target_host_id) {
            blockers.push({ type: 'ROLLBACK_SOURCE_DRIFT', reason: `${item.vm_name} is no longer on the V2.6 destination`, source: 'placement' });
            continue;
          }
          if (!child.allowed) {
            blockers.push({ type: 'ROLLBACK_PREFLIGHT_BLOCKED', reason: `${item.vm_name} cannot safely return to its original host`, source: 'migration' });
            continue;
          }
          reverse.push({ vm: { id: item.vm_id, displayName: item.vm_name },
            sourceHostId: item.target_host_id, targetHostId: item.source_host_id, mode: item.mode,
            score: null, confidence: 'live_preflight', policyEvidence: [] });
        } catch (err) {
          blockers.push({ type: 'ROLLBACK_PREFLIGHT_BLOCKED', reason: `${item.vm_name}: ${_text(err.message, 160)}`, source: 'migration' });
        }
      }
      advisory = { planHash: sha256(JSON.stringify(reverse.map(move => [move.vm.id, move.sourceHostId, move.targetHostId, move.mode]))),
        moves: reverse, skipped: [], rollbackOf: original.id };
      if (!reverse.length) blockers.push({ type: 'NO_REBALANCE_MOVES', reason: 'No succeeded move can be safely reversed', source: 'placement' });
    } else {
      advisory = await (options.advisory || advisorySingleton).rebalancePlanForHost(host, {
        sourceThresholdPercent: input.sourceThresholdPercent, targetThresholdPercent: input.targetThresholdPercent,
        maxMoves: input.maxMoves,
      }, { database, enabled: options.advisoryEnabled === undefined ? true : options.advisoryEnabled });
      if (advisory.planHash !== input.advisoryPlanHash) blockers.push({ type: 'ADVISORY_PLAN_STALE', reason: 'The placement advisory changed; review the new dry-run', source: 'placement' });
      if (!advisory.moves.length) blockers.push({ type: 'NO_REBALANCE_MOVES', reason: 'The current advisory has no safe moves to apply', source: 'placement' });
    }
    if (input.windowEndsAt && Date.parse(input.windowEndsAt) <= Date.now()) blockers.push({ type: 'MAINTENANCE_WINDOW_CLOSED', reason: 'The maintenance window is closed', source: 'schedule' });
    const moves = advisory.moves.map((move, index) => ({ ...move, sequence: index, wave: Math.floor(index / input.waveSize) + 1 }));
    const first = moves[0];
    plan = {
      schemaVersion: '1.0', generatedAt: _now(), expiresAt,
      provider: { type: host.daemon_type, endpointId: Number(host.id), endpointName: _text(host.name, 160) },
      changeKind, action: input.rollbackOf ? 'rollback' : 'apply', capability,
      resource: { kind: 'virtualMachine', id: first?.vm.id || 'ddr_vm_00000000000000000000000000', displayName: host.name || `Endpoint ${host.id}` },
      before: { advisoryPlanHash: input.advisoryPlanHash, rollbackOf: input.rollbackOf },
      desired: { sourceThresholdPercent: input.sourceThresholdPercent, targetThresholdPercent: input.targetThresholdPercent,
        maxMoves: input.maxMoves, waveSize: input.waveSize, windowEndsAt: input.windowEndsAt, rollbackOf: input.rollbackOf },
      diff: moves.map(move => ({ path: `vm.${move.vm.id}.host`, before: move.sourceHostId, after: move.targetHostId })),
      moves, blockers, warnings: [...warnings, ...(advisory.skipped.length ? [{ type: 'SKIPPED_WORKLOADS', reason: `${advisory.skipped.length} workload(s) were not eligible`, source: 'placement' }] : [])],
      _native: {}, advisory,
    };
  } else {
    const input = changeKind === 'ha_policy' ? _haInput(value) : _affinityInput(value);
    const native = options.native || nativeSingleton; const target = await native.open(host, database);
    try {
      const snapshot = await native.snapshot(target, changeKind, input);
      if (changeKind === 'ha_policy') {
        if (host.daemon_type === 'vsphere' && !input.clusterId) {
          throw new PlacementChangeError('vSphere HA policy requires a canonical cluster', 'PROVIDER_CLUSTER_NOT_FOUND', 400);
        }
        const writable = new Set(capability.constraints?.fields || []);
        for (const key of Object.keys(input.policy)) if (!writable.has(key)) blockers.push({ type: 'FIELD_UNSUPPORTED', reason: `${key} is not writable on this endpoint`, source: 'provider' });
        const desired = { ...snapshot.portable, ...input.policy };
        const vmEnvelope = await registry.resourcesForHost(host, 'virtual-machines', { limit: 500, database });
        const vm = vmEnvelope.items.find(item => item.id === input.vmId);
        if (!vm) throw new PlacementChangeError('Virtual machine was not found', 'PROVIDER_VM_NOT_FOUND', 404);
        plan = {
          schemaVersion: '1.0', generatedAt: _now(), expiresAt,
          provider: { type: host.daemon_type, endpointId: Number(host.id), endpointName: _text(host.name, 160) },
          changeKind, action: 'update', capability,
          resource: { kind: 'virtualMachine', id: input.vmId, displayName: vm.displayName },
          before: snapshot.portable, desired, diff: _diff(snapshot.portable, desired), blockers, warnings,
          _native: { before: snapshot.native },
        };
      } else {
        const desired = input.action === 'delete' ? null
          : (input.action === 'update' && !input.rule.clusterId && snapshot.portable?.clusterId
            ? { ...input.rule, clusterId: snapshot.portable.clusterId } : input.rule);
        const effectiveKind = desired?.kind || snapshot.portable?.kind;
        if (!(capability.constraints?.kinds || []).includes(effectiveKind)) blockers.push({ type: 'RULE_KIND_UNSUPPORTED', reason: `${effectiveKind} is not writable on this endpoint`, source: 'provider' });
        if (host.daemon_type === 'vsphere' && input.action === 'create' && !desired.clusterId) blockers.push({ type: 'CLUSTER_SCOPE_REQUIRED', reason: 'vSphere rule creation requires a canonical cluster', source: 'provider' });
        if (host.daemon_type === 'vsphere' && input.action === 'update'
          && desired.clusterId !== snapshot.portable.clusterId) blockers.push({ type: 'RULE_RESCOPE_UNSUPPORTED', reason: 'Move the rule to another cluster through a delete/create workflow', source: 'provider' });
        if (host.daemon_type === 'xen' && input.action === 'update' && desired.name !== snapshot.portable.name) blockers.push({ type: 'RULE_RENAME_UNSUPPORTED', reason: 'XAPI VM-group rename is not enabled in this batch', source: 'provider' });
        if (host.daemon_type === 'xen' && desired && (desired.enabled !== true || desired.mandatory !== false)) blockers.push({ type: 'RULE_ATTRIBUTE_UNSUPPORTED', reason: 'XAPI affinity rules are always enabled advisory preferences', source: 'provider' });
        const member = desired?.vmIds?.[0] || snapshot.portable?.vmIds?.[0];
        if (!member) blockers.push({ type: 'RULE_MEMBERS_UNRESOLVED', reason: 'At least one canonical VM member is required', source: 'identity' });
        plan = {
          schemaVersion: '1.0', generatedAt: _now(), expiresAt,
          provider: { type: host.daemon_type, endpointId: Number(host.id), endpointName: _text(host.name, 160) },
          changeKind, action: input.action, capability,
          resource: { kind: 'virtualMachine', id: member || 'ddr_vm_00000000000000000000000000', displayName: desired?.name || snapshot.portable?.name || 'Placement rule' },
          before: snapshot.portable, desired, diff: _diff(snapshot.portable, desired), blockers, warnings,
          _native: { before: snapshot.native },
        };
      }
    } finally { await native.close(target); }
  }
  if (!plan.diff.length) plan.blockers.push({ type: 'NO_SEMANTIC_CHANGE', reason: 'Desired state already matches current provider state', source: 'common' });
  plan.allowed = plan.blockers.length === 0;
  plan.approval = { required: true, mode: 'four_eyes', requesterCannotApprove: true };
  plan.confirmation = { required: true, mode: 'typed_name', expected: plan.resource.displayName };
  plan.planHash = sha256(JSON.stringify(_semantic(plan)));
  return options.includeNative === true ? plan : _publicPlan(plan);
}

function _assertSubmission(plan, input) {
  if (!plan.allowed) throw new PlacementChangeError('Placement change preflight is blocked', 'PLACEMENT_CHANGE_PREFLIGHT_BLOCKED', 409, plan.blockers);
  if (String(input.planHash || '') !== plan.planHash) throw new PlacementChangeError('Placement change plan changed; review the new plan', 'PLACEMENT_CHANGE_PLAN_STALE', 409);
  if (Date.parse(plan.expiresAt) <= Date.now()) throw new PlacementChangeError('Placement change plan expired', 'PLACEMENT_CHANGE_PLAN_STALE', 409);
  if (input.confirm !== true || input.confirmName !== plan.resource.displayName) throw new PlacementChangeError('Exact resource name confirmation is required', 'PLACEMENT_CHANGE_TYPED_CONFIRMATION_REQUIRED');
  if (!/^[\x21-\x7e]{8,200}$/.test(String(input.idempotencyKey || ''))) throw new PlacementChangeError('Idempotency key must contain 8-200 visible ASCII characters', 'INVALID_IDEMPOTENCY_KEY');
}

function _event(database, changeId, type, fields = {}) {
  database.prepare(`INSERT INTO provider_placement_change_events
    (change_id, event_type, state, phase, message, details_json, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(changeId, _text(type, 80), _text(fields.state, 40), _text(fields.phase, 80), _text(fields.message, 240),
      fields.details ? JSON.stringify(fields.details) : null, fields.actorId || null);
}

async function createForHost(host, value = {}, options = {}) {
  const database = _database(options); const requestedBy = Number(options.createdBy);
  if (!Number.isInteger(requestedBy) || requestedBy <= 0) throw new PlacementChangeError('Authenticated requester is required', 'INVALID_CHANGE_REQUESTER', 401);
  const key = String(value.idempotencyKey || '');
  if (!/^[\x21-\x7e]{8,200}$/.test(key)) throw new PlacementChangeError('Idempotency key must contain 8-200 visible ASCII characters', 'INVALID_IDEMPOTENCY_KEY');
  const idempotencyHash = sha256(`${Number(host.id)}|placement.change|${key}`);
  const existing = database.prepare('SELECT id, request_hash FROM provider_placement_changes WHERE host_id = ? AND idempotency_key_hash = ?').get(Number(host.id), idempotencyHash);
  const request = { ...value }; delete request.planHash; delete request.confirm; delete request.confirmName; delete request.idempotencyKey;
  const requestJson = JSON.stringify(request); const requestHash = sha256(requestJson);
  if (existing) {
    if (existing.request_hash !== requestHash) throw new PlacementChangeError('Idempotency key was used for a different request', 'IDEMPOTENCY_KEY_CONFLICT', 409);
    return { change: get(existing.id, { database }), deduplicated: true };
  }
  const plan = await preflightForHost(host, request, { ...options, database, includeNative: true });
  _assertSubmission(plan, value);
  const changeId = `pcr_${generateToken(16).slice(0, 26)}`;
  database.transaction(() => {
    database.prepare(`INSERT INTO provider_placement_changes
      (id, host_id, provider_type, change_kind, action, resource_kind, resource_id, resource_name,
       plan_hash, plan_enc, request_hash, request_enc, before_enc, rollback_enc,
       idempotency_key_hash, requested_by, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(changeId, Number(host.id), host.daemon_type, plan.changeKind, plan.action,
        plan.resource.kind, plan.resource.id, plan.resource.displayName, plan.planHash,
        encrypt(JSON.stringify(plan)), requestHash, encrypt(requestJson), encrypt(JSON.stringify(plan.before)),
        encrypt(JSON.stringify({ changeKind: plan.changeKind, action: 'rollback', before: plan.before })),
        idempotencyHash, requestedBy, plan.expiresAt);
    if (plan.changeKind === 'rebalance_apply') {
      const insert = database.prepare(`INSERT INTO provider_placement_change_items
        (change_id, sequence, wave_number, vm_id, vm_name, source_host_id, target_host_id, mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const item of plan.moves) insert.run(changeId, item.sequence, item.wave, item.vm.id, item.vm.displayName,
        item.sourceHostId, item.targetHostId, item.mode);
    }
    _event(database, changeId, 'requested', { state: 'pending_approval', phase: 'approval',
      message: 'Placement change requested', actorId: requestedBy, details: { changeKind: plan.changeKind, planHash: plan.planHash } });
  })();
  return { plan: _publicPlan(plan), change: get(changeId, { database }), deduplicated: false };
}

function _item(row) {
  return { sequence: Number(row.sequence), wave: Number(row.wave_number), vm: { id: row.vm_id, displayName: row.vm_name },
    sourceHostId: row.source_host_id, targetHostId: row.target_host_id, mode: row.mode,
    state: row.state, operationId: row.operation_id || null,
    error: row.error_code ? { code: row.error_code, message: row.error_message || null } : null,
    startedAt: row.started_at || null, completedAt: row.completed_at || null, updatedAt: row.updated_at };
}

function _public(row, database, includeEvents = true) {
  if (!row) return null;
  const items = row.change_kind === 'rebalance_apply' ? database.prepare('SELECT * FROM provider_placement_change_items WHERE change_id = ? ORDER BY sequence').all(row.id).map(_item) : [];
  const events = includeEvents ? database.prepare(`SELECT id, event_type, state, phase, message, details_json, actor_id, created_at
    FROM provider_placement_change_events WHERE change_id = ? ORDER BY id DESC LIMIT 200`).all(row.id).reverse().map(item => ({
    id: item.id, type: item.event_type, state: item.state, phase: item.phase, message: item.message,
    details: _json(item.details_json), actorId: item.actor_id, createdAt: item.created_at,
  })) : undefined;
  return {
    schemaVersion: row.schema_version, id: row.id, provider: { type: row.provider_type, endpointId: Number(row.host_id) },
    changeKind: row.change_kind, action: row.action,
    resource: { kind: row.resource_kind, id: row.resource_id, displayName: row.resource_name },
    state: row.state, planHash: row.plan_hash, operationId: row.operation_id || null,
    approval: { requestedBy: row.requested_by, approvedBy: row.approved_by || null, rejectedBy: row.rejected_by || null,
      comment: row.approval_comment || null, rejectionReason: row.rejection_reason || null,
      expiresAt: row.expires_at, approvedAt: row.approved_at || null },
    items, counts: Object.fromEntries(['pending', 'submitted', 'succeeded', 'deferred', 'failed', 'cancelled', 'unknown']
      .map(state => [state, items.filter(item => item.state === state).length])),
    error: row.error_code ? { code: row.error_code, message: row.error_message || null } : null,
    permissions: { canApprove: row.state === 'pending_approval', canReject: row.state === 'pending_approval',
      canPause: ['approved', 'applying'].includes(row.state), canResume: row.state === 'paused',
      canCancel: ['approved', 'applying', 'paused'].includes(row.state), canRollback: row.state === 'succeeded' },
    createdAt: row.created_at, startedAt: row.started_at || null, completedAt: row.completed_at || null, updatedAt: row.updated_at,
    ...(includeEvents ? { events } : {}),
  };
}

function get(idInput, options = {}) {
  const id = String(idInput || ''); const database = _database(options);
  if (!SAFE_CHANGE_ID.test(id)) return null;
  return _public(database.prepare('SELECT * FROM provider_placement_changes WHERE id = ?').get(id), database, options.includeEvents !== false);
}

function listForHost(hostIdInput, options = {}) {
  const hostId = Number(hostIdInput); const database = _database(options);
  const limit = Math.min(200, Math.max(1, Number(options.limit) || 50));
  if (!Number.isInteger(hostId) || hostId <= 0) return [];
  return database.prepare('SELECT * FROM provider_placement_changes WHERE host_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(hostId, limit).map(row => _public(row, database, false));
}

function _row(id, database) {
  const row = database.prepare('SELECT * FROM provider_placement_changes WHERE id = ?').get(id);
  if (!row) throw new PlacementChangeError('Placement change was not found', 'PLACEMENT_CHANGE_NOT_FOUND', 404);
  return row;
}

async function approveForHost(host, idInput, options = {}) {
  const database = _database(options); const id = String(idInput || ''); const actorId = Number(options.actorId);
  const row = _row(id, database);
  if (Number(row.host_id) !== Number(host.id)) throw new PlacementChangeError('Placement change was not found', 'PLACEMENT_CHANGE_NOT_FOUND', 404);
  if (row.state !== 'pending_approval') {
    if (row.approved_by === actorId && row.operation_id) return { change: get(id, { database }), operation: (options.operations || require('./index')).get(row.operation_id), deduplicated: true };
    throw new PlacementChangeError('Placement change is not pending approval', 'INVALID_PLACEMENT_CHANGE_STATE', 409);
  }
  if (Number(row.requested_by) === actorId) throw new PlacementChangeError('Requester cannot approve their own change', 'FOUR_EYES_APPROVAL_REQUIRED', 403);
  if (Date.parse(row.expires_at) <= Date.now()) throw new PlacementChangeError('Placement change approval expired', 'PLACEMENT_CHANGE_PLAN_STALE', 409);
  const request = JSON.parse(decrypt(row.request_enc));
  const current = await preflightForHost(host, request, { ...options, database, canOperate: true, includeNative: true });
  if (!current.allowed || current.planHash !== row.plan_hash) throw new PlacementChangeError('Provider state changed; create a new approval request', 'PLACEMENT_CHANGE_PLAN_STALE', 409, current.blockers);
  const operations = options.operations || require('./index');
  const operation = database.transaction(() => {
    const updated = database.prepare(`UPDATE provider_placement_changes SET state = 'approved', approved_by = ?, approval_comment = ?,
      approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND state = 'pending_approval' AND requested_by != ?`)
      .run(actorId, _text(options.comment, 240), id, actorId);
    if (!updated.changes) throw new PlacementChangeError('Approval race changed this request', 'INVALID_PLACEMENT_CHANGE_STATE', 409);
    database.prepare('UPDATE provider_placement_changes SET plan_enc = ?, expires_at = ? WHERE id = ?')
      .run(encrypt(JSON.stringify(current)), current.expiresAt, id);
    const created = operations.create({
      type: 'placement.change', providerType: host.daemon_type, hostId: Number(host.id),
      resourceKind: current.resource.kind, resourceId: current.resource.id, action: `${current.changeKind}.${current.action}`,
      idempotencyKey: `placement-change:${id}`, request: { changeId: id, planHash: current.planHash },
      lockScopes: [`resource:${current.resource.id}`, `placement:${Number(host.id)}`], createdBy: row.requested_by,
    });
    database.prepare('UPDATE provider_placement_changes SET operation_id = ?, updated_at = datetime(\'now\') WHERE id = ?').run(created.id, id);
    _event(database, id, 'approved', { state: 'approved', phase: 'approved', message: 'Placement change approved and queued', actorId,
      details: { operationId: created.id, planHash: current.planHash } });
    return created;
  })();
  return { change: get(id, { database }), operation, deduplicated: false };
}

function rejectForHost(host, idInput, options = {}) {
  const database = _database(options); const row = _row(String(idInput), database); const actorId = Number(options.actorId);
  if (Number(row.host_id) !== Number(host.id)) throw new PlacementChangeError('Placement change was not found', 'PLACEMENT_CHANGE_NOT_FOUND', 404);
  if (row.state !== 'pending_approval') throw new PlacementChangeError('Placement change is not pending approval', 'INVALID_PLACEMENT_CHANGE_STATE', 409);
  if (Number(row.requested_by) === actorId) throw new PlacementChangeError('Requester cannot reject their own change', 'FOUR_EYES_APPROVAL_REQUIRED', 403);
  const reason = _text(options.reason, 240);
  if (!reason) throw new PlacementChangeError('Rejection reason is required', 'PLACEMENT_CHANGE_REJECTION_REASON_REQUIRED');
  database.prepare(`UPDATE provider_placement_changes SET state = 'rejected', rejected_by = ?, rejection_reason = ?,
    completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(actorId, reason, row.id);
  _event(database, row.id, 'rejected', { state: 'rejected', phase: 'approval', message: 'Placement change rejected', actorId });
  return get(row.id, { database });
}

function controlForHost(host, idInput, action, options = {}) {
  const database = _database(options); const row = _row(String(idInput), database); const actorId = Number(options.actorId);
  if (Number(row.host_id) !== Number(host.id) || row.change_kind !== 'rebalance_apply') throw new PlacementChangeError('Rebalance change was not found', 'PLACEMENT_CHANGE_NOT_FOUND', 404);
  if (action === 'pause') {
    if (!['approved', 'applying'].includes(row.state)) throw new PlacementChangeError('Rebalance cannot be paused in its current state', 'INVALID_PLACEMENT_CHANGE_STATE', 409);
    database.prepare(`UPDATE provider_placement_changes SET state = 'paused', pause_requested_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(row.id);
  } else if (action === 'resume') {
    if (row.state !== 'paused') throw new PlacementChangeError('Only a paused rebalance can resume', 'INVALID_PLACEMENT_CHANGE_STATE', 409);
    const attention = database.prepare(`SELECT COUNT(*) AS count FROM provider_placement_change_items
      WHERE change_id = ? AND state IN ('failed','cancelled','unknown')`).get(row.id).count;
    if (attention) throw new PlacementChangeError('Resolve failed, cancelled, or unknown child migrations before resume', 'CHILD_OPERATION_UNRESOLVED', 409);
    database.prepare(`UPDATE provider_placement_changes SET state = 'applying', pause_requested_at = NULL,
      error_code = NULL, error_message = NULL, updated_at = datetime('now') WHERE id = ?`).run(row.id);
  } else if (action === 'cancel') {
    if (!['approved', 'applying', 'paused'].includes(row.state)) throw new PlacementChangeError('Rebalance cannot be cancelled in its current state', 'INVALID_PLACEMENT_CHANGE_STATE', 409);
    database.prepare(`UPDATE provider_placement_changes SET cancel_requested_at = datetime('now'),
      state = CASE WHEN state = 'paused' THEN 'applying' ELSE state END, updated_at = datetime('now') WHERE id = ?`).run(row.id);
  } else throw new PlacementChangeError('Unknown rebalance control', 'INVALID_PLACEMENT_CHANGE_ACTION');
  _event(database, row.id, action, { state: action === 'pause' ? 'paused' : 'applying', phase: 'operator-control',
    message: `Rebalance ${action} requested`, actorId });
  return get(row.id, { database });
}

function _setState(database, id, state, phase, message, error = null) {
  const terminal = TERMINAL.has(state);
  database.prepare(`UPDATE provider_placement_changes SET state = ?, error_code = ?, error_message = ?,
    started_at = COALESCE(started_at, datetime('now')), completed_at = CASE WHEN ? THEN datetime('now') ELSE completed_at END,
    updated_at = datetime('now') WHERE id = ?`).run(state, error?.code || null, _text(error?.message, 240), terminal ? 1 : 0, id);
  _event(database, id, 'state', { state, phase, message, details: error ? { code: error.code } : null });
}

function _sameDesired(observed, desired) {
  if (desired === null) return observed === null;
  if (!observed) return false;
  return Object.entries(desired).every(([key, value]) => JSON.stringify(observed[key] ?? null) === JSON.stringify(value ?? null));
}

async function _verifyPolicy(row, plan, database, native) {
  const host = database.prepare('SELECT * FROM docker_hosts WHERE id = ? AND is_active = 1').get(row.host_id);
  const target = await native.open(host, database);
  try {
    const request = JSON.parse(decrypt(row.request_enc));
    const observed = await native.snapshot(target, plan.changeKind,
      plan.changeKind === 'affinity_rule' ? { action: 'create' } : request);
    if (plan.changeKind === 'affinity_rule') {
      if (plan.action === 'create') {
        return observed.rules?.some(item => _sameDesired(item.portable, plan.desired)) === true;
      }
      const found = observed.rules?.find(item => item.portable.id === plan.before?.id);
      if (plan.action === 'delete') return !found;
      return !!found && _sameDesired(found.portable, plan.desired);
    }
    return _sameDesired(observed.portable, plan.desired);
  } finally { await native.close(target); }
}

async function planRollbackForHost(host, idInput, options = {}) {
  const database = _database(options); const row = _row(String(idInput), database);
  if (Number(row.host_id) !== Number(host.id) || row.state !== 'succeeded') {
    throw new PlacementChangeError('Only a succeeded placement change can be rolled back', 'PLACEMENT_CHANGE_ROLLBACK_UNAVAILABLE', 409);
  }
  const originalPlan = JSON.parse(decrypt(row.plan_enc));
  let request;
  if (row.change_kind === 'rebalance_apply') {
    request = { changeKind: 'rebalance_apply', rollbackOf: row.id,
      waveSize: Number(options.waveSize || originalPlan.desired.waveSize || 2),
      maxMoves: originalPlan.moves.length, windowEndsAt: options.windowEndsAt || null };
  } else if (row.change_kind === 'ha_policy') {
    const before = originalPlan.before;
    const policy = { ...before }; delete policy.vmId; delete policy.clusterId;
    request = { changeKind: 'ha_policy', vmId: before.vmId,
      ...(before.clusterId ? { clusterId: before.clusterId } : {}), policy, rollbackOf: row.id };
  } else {
    if (row.action === 'create') {
      const native = options.native || nativeSingleton; const target = await native.open(host, database);
      try {
        const current = await native.snapshot(target, 'affinity_rule', { action: 'create' });
        const found = current.rules.find(item => item.portable.name === originalPlan.desired.name
          && item.portable.kind === originalPlan.desired.kind);
        if (!found) throw new PlacementChangeError('Created rule is no longer present', 'PLACEMENT_CHANGE_ROLLBACK_UNAVAILABLE', 409);
        request = { changeKind: 'affinity_rule', action: 'delete', ruleId: found.portable.id, rollbackOf: row.id };
      } finally { await native.close(target); }
    } else if (row.action === 'delete') {
      request = { changeKind: 'affinity_rule', action: 'create', rule: originalPlan.before, rollbackOf: row.id };
    } else {
      request = { changeKind: 'affinity_rule', action: 'update', ruleId: originalPlan.before.id,
        rule: originalPlan.before, rollbackOf: row.id };
    }
  }
  const plan = await preflightForHost(host, request, { ...options, database, canOperate: true });
  return { schemaVersion: '1.0', rollbackOf: row.id, request, plan };
}

async function _policyStep(row, plan, context, options) {
  const database = _database(options); const native = options.native || nativeSingleton;
  const host = database.prepare('SELECT * FROM docker_hosts WHERE id = ? AND is_active = 1').get(row.host_id);
  if (!host) throw new PlacementChangeError('Provider endpoint is unavailable', 'INVALID_OPERATION_HOST', 404);
  if (context.nativeTaskRef) {
    const target = await native.open(host, database);
    try {
      const task = native.parseTask(context.nativeTaskRef, row.provider_type);
      if (!task) return { state: 'unknown', result: { changeId: row.id, reason: 'Native task reference is invalid' } };
      const outcome = native.taskOutcome(await native.taskStatus(target, task));
      if (outcome.failed) { _setState(database, row.id, 'failed', 'native-task', 'Provider placement task failed', { code: 'PROVIDER_TASK_FAILED', message: outcome.message }); throw Object.assign(new Error(outcome.message), { code: 'PROVIDER_TASK_FAILED' }); }
      if (outcome.pending) return { state: 'reconciling', phase: 'native-task', delayMs: 2000 };
    } finally { await native.close(target); }
    _setState(database, row.id, 'verifying', 'post-read', 'Native task completed; verifying provider state');
  } else if (row.state === 'approved') {
    const request = JSON.parse(decrypt(row.request_enc));
    const fresh = await preflightForHost(host, request, { ...options, database, canOperate: true, includeNative: true });
    if (!fresh.allowed || fresh.planHash !== row.plan_hash) {
      _setState(database, row.id, 'failed', 'revalidation', 'Approved plan became stale', { code: 'PLACEMENT_CHANGE_PLAN_STALE', message: 'Provider state changed before execution' });
      throw Object.assign(new Error('Provider state changed before execution'), { code: 'PLACEMENT_CHANGE_PLAN_STALE' });
    }
    _setState(database, row.id, 'applying', 'native-submit', 'Submitting approved provider placement change');
    const target = await native.open(host, database);
    try {
      const result = await native.apply(target, fresh);
      const ref = native.taskRef(target, result);
      if (ref) return { state: 'reconciling', nativeTaskRef: ref, nativeTaskState: 'pending', phase: 'native-task', delayMs: 1500 };
    } finally { await native.close(target); }
    _setState(database, row.id, 'verifying', 'post-read', 'Provider call completed; verifying state');
  }
  const verified = await _verifyPolicy(_row(row.id, database), plan, database, native);
  if (!verified) {
    _setState(database, row.id, 'unknown', 'post-read', 'Provider state does not prove the approved result', { code: 'PLACEMENT_CHANGE_POSTCHECK_FAILED', message: 'Observed state differs from desired state' });
    return { state: 'unknown', result: { changeId: row.id, verified: false } };
  }
  _setState(database, row.id, 'succeeded', 'verified', 'Placement change verified');
  return { state: 'succeeded', phase: 'verified', result: { changeId: row.id, verified: true } };
}

function _reconcileChildren(row, database, operations) {
  const items = database.prepare(`SELECT * FROM provider_placement_change_items WHERE change_id = ? AND state = 'submitted' ORDER BY sequence`).all(row.id);
  let attention = null;
  for (const item of items) {
    const operation = operations.get(item.operation_id);
    if (!operation || !CHILD_TERMINAL.has(operation.state)) continue;
    const state = operation.state;
    database.prepare(`UPDATE provider_placement_change_items SET state = ?, error_code = ?, error_message = ?,
      completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
      .run(state, operation.error?.code || (state === 'unknown' ? 'CHILD_OPERATION_UNKNOWN' : null),
        _text(operation.error?.message || null), item.id);
    _event(database, row.id, 'child_terminal', { state: row.state, phase: 'rebalance', message: `${item.vm_name} migration is ${state}`,
      details: { vmId: item.vm_id, operationId: item.operation_id, childState: state } });
    if (state !== 'succeeded') attention = { code: `CHILD_MIGRATION_${state.toUpperCase()}`, message: `${item.vm_name} migration is ${state}` };
  }
  return attention;
}

async function _rebalanceStep(row, plan, context, options) {
  const database = _database(options); const operations = options.operations || require('./index');
  const migration = options.vmMigration || vmMigrationSingleton;
  if (row.state === 'approved') _setState(database, row.id, 'applying', 'rebalance', 'Approved rebalance started');
  row = _row(row.id, database);
  if (row.state === 'paused') return { state: 'reconciling', phase: 'paused', delayMs: 5000 };
  const attention = _reconcileChildren(row, database, operations);
  if (attention) {
    _setState(database, row.id, 'paused', 'child-attention', 'Rebalance auto-paused for child operation attention', attention);
    return { state: 'reconciling', phase: 'paused', delayMs: 5000 };
  }
  const active = Number(database.prepare(`SELECT COUNT(*) AS count FROM provider_placement_change_items
    WHERE change_id = ? AND state = 'submitted'`).get(row.id).count);
  if (row.cancel_requested_at) {
    const children = database.prepare(`SELECT operation_id FROM provider_placement_change_items
      WHERE change_id = ? AND state = 'submitted' AND operation_id IS NOT NULL`).all(row.id);
    for (const child of children) { try { operations.requestCancel(child.operation_id); } catch { /* terminal */ } }
    if (active) return { state: 'reconciling', phase: 'cancelling', delayMs: 2000 };
    database.prepare(`UPDATE provider_placement_change_items SET state = 'cancelled', completed_at = datetime('now'),
      updated_at = datetime('now') WHERE change_id = ? AND state IN ('pending','deferred')`).run(row.id);
    _setState(database, row.id, 'cancelled', 'cancelled', 'Rebalance cancelled; completed moves were retained');
    return { state: 'succeeded', phase: 'cancelled', result: { changeId: row.id, cancelled: true } };
  }
  if (plan.desired.windowEndsAt && Date.parse(plan.desired.windowEndsAt) <= Date.now()) {
    _setState(database, row.id, 'paused', 'window-closed', 'Rebalance auto-paused because the maintenance window closed', { code: 'MAINTENANCE_WINDOW_CLOSED', message: 'Maintenance window closed' });
    return { state: 'reconciling', phase: 'paused', delayMs: 5000 };
  }
  const available = Math.max(0, Number(plan.desired.waveSize) - active);
  if (available > 0) {
    const nextWave = database.prepare(`SELECT MIN(wave_number) AS wave FROM provider_placement_change_items
      WHERE change_id = ? AND state != 'succeeded'`).get(row.id).wave;
    const pending = database.prepare(`SELECT * FROM provider_placement_change_items
      WHERE change_id = ? AND state = 'pending' AND wave_number = ? ORDER BY sequence LIMIT ?`)
      .all(row.id, nextWave, available);
    const host = database.prepare('SELECT * FROM docker_hosts WHERE id = ? AND is_active = 1').get(row.host_id);
    for (const item of pending) {
      try {
        const childPlan = await migration.preflightForHost(host, item.vm_id, { targetId: item.target_host_id, mode: item.mode },
          { database, canOperate: true, enabled: true, operations });
        if (childPlan.sourceTargetId === item.target_host_id) {
          database.prepare(`UPDATE provider_placement_change_items SET state = 'succeeded', completed_at = datetime('now'),
            updated_at = datetime('now') WHERE id = ?`).run(item.id); continue;
        }
        if (childPlan.sourceTargetId !== item.source_host_id) throw Object.assign(new Error('VM source placement changed after approval'), { code: 'VM_MIGRATION_SOURCE_CHANGED' });
        const result = await migration.submitForHost(host, item.vm_id, {
          targetId: item.target_host_id, mode: item.mode, planHash: childPlan.planHash,
          confirm: true, confirmName: childPlan.vm.displayName, idempotencyKey: `rebalance:${row.id}:${item.vm_id}`,
        }, { database, canOperate: true, enabled: true, createdBy: row.requested_by, operations });
        database.prepare(`UPDATE provider_placement_change_items SET state = 'submitted', operation_id = ?,
          started_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(result.operation.id, item.id);
        _event(database, row.id, 'child_submitted', { state: 'applying', phase: 'rebalance', message: `Migration queued for ${item.vm_name}`,
          details: { vmId: item.vm_id, operationId: result.operation.id, wave: item.wave_number } });
      } catch (err) {
        database.prepare(`UPDATE provider_placement_change_items SET state = 'deferred', error_code = ?, error_message = ?,
          updated_at = datetime('now') WHERE id = ?`).run(_text(err.code || 'CHILD_PREFLIGHT_BLOCKED', 80), _text(err.message), item.id);
        _setState(database, row.id, 'paused', 'revalidation-blocked', 'Rebalance auto-paused because a child preflight changed', { code: err.code || 'CHILD_PREFLIGHT_BLOCKED', message: err.message });
        return { state: 'reconciling', phase: 'paused', delayMs: 5000 };
      }
    }
  }
  const remaining = database.prepare(`SELECT state, COUNT(*) AS count FROM provider_placement_change_items
    WHERE change_id = ? AND state != 'succeeded' GROUP BY state`).all(row.id);
  const done = database.prepare(`SELECT COUNT(*) AS count FROM provider_placement_change_items
    WHERE change_id = ? AND state = 'succeeded'`).get(row.id).count;
  context.reportProgress(plan.moves.length ? Math.min(95, Math.round(done / plan.moves.length * 95)) : 95,
    'rebalance', `${done} of ${plan.moves.length} approved migrations verified`);
  if (remaining.length) return { state: 'reconciling', phase: 'rebalance', delayMs: 1500 };
  const host = database.prepare('SELECT * FROM docker_hosts WHERE id = ? AND is_active = 1').get(row.host_id);
  const inventory = await (options.registry || registrySingleton).resourcesForHost(host, 'virtual-machines', { limit: 500, database });
  const byId = new Map(inventory.items.map(item => [item.id, item]));
  const mismatches = plan.moves.filter(move => byId.get(move.vm.id)?.relationships?.host !== move.targetHostId);
  if (mismatches.length) {
    _setState(database, row.id, 'unknown', 'post-read', 'Rebalance children completed but placement verification disagrees', { code: 'REBALANCE_POSTCHECK_FAILED', message: `${mismatches.length} VM placements differ` });
    return { state: 'unknown', result: { changeId: row.id, verified: false, mismatchCount: mismatches.length } };
  }
  _setState(database, row.id, 'succeeded', 'verified', 'Approved rebalance verified');
  return { state: 'succeeded', phase: 'verified', result: { changeId: row.id, verified: true, moved: plan.moves.length } };
}

async function executeOperation(changeIdInput, context, options = {}) {
  const database = _database(options); const row = _row(String(changeIdInput), database);
  if (row.plan_hash !== context.request.planHash) throw new PlacementChangeError('Stored placement plan integrity check failed', 'PLACEMENT_CHANGE_PLAN_STALE', 409);
  const plan = JSON.parse(decrypt(row.plan_enc));
  if (row.change_kind === 'rebalance_apply') return _rebalanceStep(row, plan, context, options);
  return _policyStep(row, plan, context, options);
}

async function cancelOperation(changeIdInput, options = {}) {
  const database = _database(options); const row = _row(String(changeIdInput), database);
  if (row.change_kind !== 'rebalance_apply') return { confirmed: false, reason: 'Native policy mutation cannot be safely cancelled after submission' };
  database.prepare(`UPDATE provider_placement_changes SET state = 'cancelled', cancel_requested_at = datetime('now'),
    completed_at = datetime('now'), error_code = 'CANCELLED', error_message = 'Parent operation cancellation requested',
    updated_at = datetime('now') WHERE id = ?`).run(row.id);
  const operations = options.operations || require('./index');
  const children = database.prepare(`SELECT id, operation_id FROM provider_placement_change_items
    WHERE change_id = ? AND state = 'submitted'`).all(row.id);
  for (const child of children) {
    try { operations.requestCancel(child.operation_id); } catch { /* terminal */ }
    database.prepare(`UPDATE provider_placement_change_items SET state = 'unknown', error_code = 'PARENT_CANCELLED',
      error_message = 'Child cancellation requested; verify provider placement', updated_at = datetime('now') WHERE id = ?`).run(child.id);
  }
  database.prepare(`UPDATE provider_placement_change_items SET state = 'cancelled', completed_at = datetime('now'),
    updated_at = datetime('now') WHERE change_id = ? AND state IN ('pending','deferred')`).run(row.id);
  _event(database, row.id, 'cancelled', { state: 'cancelled', phase: 'parent-cancel', message: 'Parent cancelled; submitted children require their own evidence' });
  return { confirmed: true, result: { changeId: row.id, completedMovesRetained: true } };
}

module.exports = {
  CHANGE_KINDS, RULE_KINDS, PlacementChangeError,
  preflightForHost, createForHost, approveForHost, rejectForHost, controlForHost,
  get, listForHost, planRollbackForHost, executeOperation, cancelOperation,
  _internals: { _baseInput, _haInput, _affinityInput, _rebalanceInput, _diff, _semantic,
    _publicPlan, _assertSubmission, _sameDesired, _reconcileChildren },
};
