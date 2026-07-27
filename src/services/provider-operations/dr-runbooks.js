'use strict';

const config = require('../../config');
const { getDb } = require('../../db');
const { generateToken, sha256, decrypt } = require('../../utils/crypto');
const registrySingleton = require('../provider-sdk/registry');
const policySingleton = require('./policy');
const { fromHostRow } = require('../proxmox');

const SCHEMA_VERSION = '1.0';
const SAFE_GROUP_ID = /^pdrg_[a-f0-9]{26}$/;
const SAFE_VM_ID = /^ddr_vm_[a-f0-9]{26}$/;
const SAFE_RESOURCE_ID = /^ddr_(host|cluster|storage|network)_[a-f0-9]{26}$/;
const SAFE_BACKUP_POLICY_ID = /^pbp_[a-f0-9]{26}$/;
const SAFE_DRILL_POLICY_ID = /^pdrp_[a-f0-9]{26}$/;
const STRATEGIES = new Set(['provider_replication', 'backup_restore', 'hybrid']);
const SOURCES = new Set(['replication', 'backup']);
const MODES = new Set(['planned_failover', 'unplanned_failover', 'failback', 'test']);

class DrRunbookError extends Error {
  constructor(message, code = 'DR_RUNBOOK_ERROR', status = 400, details = null) {
    super(message); this.name = 'DrRunbookError'; this.code = code;
    this.status = status; this.details = details;
  }
}

function _database(options = {}) { return options.database || getDb(); }
function _registry(options = {}) { return options.registry || registrySingleton; }
function _now() { return new Date().toISOString(); }
function _parseJson(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function _canonical(value) {
  if (Array.isArray(value)) return `[${value.map(_canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${_canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function _text(value, max = 240) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) || null;
}
function _integer(value, label, min, max, fallback) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new DrRunbookError(`${label} must be an integer between ${min} and ${max}`,
      'INVALID_DR_PROTECTION_GROUP');
  }
  return number;
}
function _timestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  const date = Number.isFinite(number) ? new Date(number > 100000000000 ? number : number * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function _ageSeconds(value, now = Date.now()) {
  const time = Date.parse(value || 0);
  return Number.isFinite(time) && now >= time ? Math.floor((now - time) / 1000) : null;
}
function _host(database, id, code = 'DR_RECOVERY_ENDPOINT_NOT_FOUND') {
  const hostId = Number(id);
  if (!Number.isInteger(hostId) || hostId <= 0) throw new DrRunbookError(
    'Recovery endpoint is invalid', 'INVALID_DR_PROTECTION_GROUP');
  const row = database.prepare('SELECT * FROM docker_hosts WHERE id = ? AND is_active = 1').get(hostId);
  if (!row) throw new DrRunbookError('Recovery endpoint was not found', code, 404);
  return row;
}
function _identity(database, id, hostId, kind, required = true) {
  const value = String(id || '');
  if (!SAFE_RESOURCE_ID.test(value) && !SAFE_VM_ID.test(value)) {
    if (!required && !value) return null;
    throw new DrRunbookError('Canonical recovery resource is invalid', 'INVALID_DR_PROTECTION_GROUP');
  }
  const row = database.prepare(`SELECT i.canonical_id, i.resource_kind, s.display_name, s.observed_at
    FROM provider_resource_identities i
    LEFT JOIN provider_resource_snapshots s ON s.canonical_id = i.canonical_id
    WHERE i.canonical_id = ? AND i.host_id = ? AND i.resource_kind = ?`).get(value, Number(hostId), kind);
  if (!row && required) throw new DrRunbookError(
    `Canonical ${kind} is not owned by the expected endpoint`, 'DR_RESOURCE_SCOPE_MISMATCH', 409);
  return row || null;
}
function _optionalIdentity(database, value, hostId, kind) {
  return value === undefined || value === null || value === '' ? null
    : _identity(database, String(value), hostId, kind, true).canonical_id;
}

function _contacts(input = {}) {
  const out = {
    owner: _text(input.owner, 120), service: _text(input.service, 120),
    incidentChannel: _text(input.incidentChannel, 160), runbookUrl: _text(input.runbookUrl, 500),
  };
  if (out.runbookUrl) {
    let url;
    try { url = new URL(out.runbookUrl); } catch { /* validated below */ }
    if (!url || url.protocol !== 'https:' || url.username || url.password) throw new DrRunbookError(
      'Runbook URL must be an HTTPS URL without embedded credentials', 'INVALID_DR_PROTECTION_GROUP');
  }
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== null));
}

function _placement(input = {}, recoveryHostId, database) {
  return {
    clusterId: _optionalIdentity(database, input.clusterId, recoveryHostId, 'cluster'),
    nodeId: _optionalIdentity(database, input.nodeId, recoveryHostId, 'host'),
    storageId: _optionalIdentity(database, input.storageId, recoveryHostId, 'storage'),
  };
}

function _networkMappings(input, primaryHostId, recoveryHostId, database) {
  const mappings = input || [];
  if (!Array.isArray(mappings)) throw new DrRunbookError(
    'Network mappings must be an array', 'INVALID_DR_PROTECTION_GROUP');
  if (mappings.length > 32) throw new DrRunbookError(
    'A protection group may contain at most 32 network mappings', 'INVALID_DR_PROTECTION_GROUP');
  const seen = new Set();
  return mappings.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new DrRunbookError(
      'Network mapping is invalid', 'INVALID_DR_PROTECTION_GROUP');
    const sourceNetworkId = _identity(database, item.sourceNetworkId, primaryHostId, 'network').canonical_id;
    if (seen.has(sourceNetworkId)) throw new DrRunbookError(
      'Each source network may be mapped only once', 'INVALID_DR_PROTECTION_GROUP');
    seen.add(sourceNetworkId);
    return {
      sequence: index, sourceNetworkId,
      targetNetworkId: _identity(database, item.targetNetworkId, recoveryHostId, 'network').canonical_id,
      testNetworkId: item.testNetworkId
        ? _identity(database, item.testNetworkId, recoveryHostId, 'network').canonical_id : null,
    };
  });
}

function _policyLink(database, id, hostId, table, regex, label) {
  if (id === undefined || id === null || id === '') return null;
  const value = String(id);
  if (!regex.test(value) || !database.prepare(`SELECT id FROM ${table} WHERE id = ? AND host_id = ? AND deleted_at IS NULL`)
    .get(value, Number(hostId))) throw new DrRunbookError(
    `${label} is not owned by this endpoint`, 'DR_RESOURCE_SCOPE_MISMATCH', 409);
  return value;
}

function _sortMembers(members) {
  const byId = new Map(members.map(member => [member.vmId, member]));
  const indegree = new Map(members.map(member => [member.vmId, 0]));
  const outgoing = new Map(members.map(member => [member.vmId, []]));
  for (const member of members) {
    for (const dependency of member.dependsOn) {
      if (dependency === member.vmId) throw new DrRunbookError(
        'A workload cannot depend on itself', 'INVALID_DR_DEPENDENCY_GRAPH');
      const target = byId.get(dependency);
      if (!target) throw new DrRunbookError(
        'A workload dependency is not a member of the protection group', 'INVALID_DR_DEPENDENCY_GRAPH');
      if (target.bootStage > member.bootStage) throw new DrRunbookError(
        'A dependency cannot have a later boot stage', 'INVALID_DR_DEPENDENCY_GRAPH');
      outgoing.get(dependency).push(member.vmId);
      indegree.set(member.vmId, indegree.get(member.vmId) + 1);
    }
  }
  const compare = (left, right) => left.bootStage - right.bootStage
    || left.vmName.localeCompare(right.vmName) || left.vmId.localeCompare(right.vmId);
  const ready = members.filter(member => indegree.get(member.vmId) === 0).sort(compare);
  const result = [];
  while (ready.length) {
    const current = ready.shift(); result.push(current);
    for (const nextId of outgoing.get(current.vmId).sort()) {
      indegree.set(nextId, indegree.get(nextId) - 1);
      if (indegree.get(nextId) === 0) {
        ready.push(byId.get(nextId)); ready.sort(compare);
      }
    }
  }
  if (result.length !== members.length) throw new DrRunbookError(
    'Protection-group dependencies contain a cycle', 'INVALID_DR_DEPENDENCY_GRAPH');
  return result.map((member, sequence) => ({ ...member, sequence }));
}

function _members(input, context) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 64) throw new DrRunbookError(
    'A protection group requires 1-64 workloads', 'INVALID_DR_PROTECTION_GROUP');
  const seen = new Set();
  const members = input.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !SAFE_VM_ID.test(String(item.vmId || ''))) {
      throw new DrRunbookError('Protection-group workload is invalid', 'INVALID_DR_PROTECTION_GROUP');
    }
    const vmId = String(item.vmId);
    if (seen.has(vmId)) throw new DrRunbookError(
      'Protection-group workloads must be unique', 'INVALID_DR_PROTECTION_GROUP');
    seen.add(vmId);
    const identity = _identity(context.database, vmId, context.primaryHostId, 'virtualMachine');
    if (!identity.display_name) throw new DrRunbookError(
      'Refresh provider inventory before adding this workload', 'DR_RESOURCE_STALE', 409);
    const source = context.strategy === 'provider_replication' ? 'replication'
      : (context.strategy === 'backup_restore' ? 'backup' : String(item.recoverySource || ''));
    if (!SOURCES.has(source)) throw new DrRunbookError(
      'Hybrid protection groups require an explicit recovery source per workload', 'INVALID_DR_PROTECTION_GROUP');
    if (!Array.isArray(item.dependsOn || [])) throw new DrRunbookError(
      'Workload dependencies must be an array', 'INVALID_DR_DEPENDENCY_GRAPH');
    const dependsOn = [...new Set((item.dependsOn || []).map(String))];
    if (dependsOn.length > 63 || dependsOn.some(id => !SAFE_VM_ID.test(id))) throw new DrRunbookError(
      'Workload dependencies contain an invalid canonical ID', 'INVALID_DR_DEPENDENCY_GRAPH');
    const target = item.recoveryTarget && typeof item.recoveryTarget === 'object'
      && !Array.isArray(item.recoveryTarget) ? item.recoveryTarget : {};
    return {
      vmId, vmName: identity.display_name, bootStage: _integer(item.bootStage, 'Boot stage', 1, 20, 1),
      dependsOn, recoverySource: source,
      backupPolicyId: _policyLink(context.database, item.backupPolicyId, context.primaryHostId,
        'provider_backup_policies', SAFE_BACKUP_POLICY_ID, 'Backup policy'),
      drillPolicyId: _policyLink(context.database, item.drillPolicyId, context.primaryHostId,
        'provider_restore_drill_policies', SAFE_DRILL_POLICY_ID, 'Restore-drill policy'),
      recoveryTarget: {
        nodeId: _optionalIdentity(context.database, target.nodeId, context.recoveryHostId, 'host'),
        storageId: _optionalIdentity(context.database, target.storageId, context.recoveryHostId, 'storage'),
      },
    };
  });
  return _sortMembers(members);
}

function _normalizeGroup(host, input, options = {}, existing = null) {
  const database = _database(options); const primaryHostId = Number(host.id);
  const name = _text(input.name ?? existing?.name, 100);
  if (!name || !/^[^<>]{1,100}$/.test(name)) throw new DrRunbookError(
    'Protection-group name is invalid', 'INVALID_DR_PROTECTION_GROUP');
  const strategy = String(input.strategy ?? existing?.strategy ?? 'backup_restore');
  if (!STRATEGIES.has(strategy)) throw new DrRunbookError(
    'Protection-group strategy is invalid', 'INVALID_DR_PROTECTION_GROUP');
  const recoveryHostId = Number(input.recoveryHostId ?? existing?.recoveryHostId ?? primaryHostId);
  _host(database, recoveryHostId);
  const enabled = input.enabled === undefined ? (existing?.enabled === true) : input.enabled === true;
  if (enabled && input.authorization !== `AUTHORIZE DR ${name}`) throw new DrRunbookError(
    `Type AUTHORIZE DR ${name} to enable this protection group`, 'DR_GROUP_AUTHORIZATION_REQUIRED');
  const rawMembers = input.members ?? existing?.members;
  const placementInput = input.placement ?? existing?.placement ?? {};
  const networksInput = input.networkMappings ?? existing?.networkMappings ?? [];
  const normalized = {
    name, strategy, enabled, primaryHostId, recoveryHostId,
    rpoTargetSeconds: _integer(input.rpoTargetSeconds ?? existing?.rpoTargetSeconds,
      'RPO target', 60, 31536000, 86400),
    rtoTargetSeconds: _integer(input.rtoTargetSeconds ?? existing?.rtoTargetSeconds,
      'RTO target', 30, 86400, 3600),
    placement: _placement(placementInput, recoveryHostId, database),
    networkMappings: _networkMappings(networksInput, primaryHostId, recoveryHostId, database),
    contacts: _contacts(input.contacts ?? existing?.contacts ?? {}),
  };
  normalized.members = _members(rawMembers, { ...normalized, database });
  return normalized;
}

function _publicMember(row) {
  return {
    vmId: row.vm_id, vmName: row.vm_name, sequence: Number(row.sequence),
    bootStage: Number(row.boot_stage), dependsOn: _parseJson(row.depends_on_json, []),
    recoverySource: row.recovery_source, backupPolicyId: row.backup_policy_id || null,
    drillPolicyId: row.drill_policy_id || null,
    recoveryTarget: _parseJson(row.recovery_target_json, {}),
  };
}
function _publicGroup(row, members = []) {
  if (!row) return null;
  const authorization = _parseJson(row.authorization_json, {});
  return {
    schemaVersion: row.schema_version || SCHEMA_VERSION, id: row.id,
    primaryHostId: Number(row.primary_host_id), recoveryHostId: Number(row.recovery_host_id),
    name: row.name, strategy: row.strategy, enabled: !!row.enabled, revision: Number(row.revision),
    rpoTargetSeconds: Number(row.rpo_target_seconds), rtoTargetSeconds: Number(row.rto_target_seconds),
    placement: _parseJson(row.placement_json, {}),
    networkMappings: _parseJson(row.network_mappings_json, []),
    contacts: _parseJson(row.contacts_json, {}),
    authorization: { enabledAt: authorization.enabledAt || null, enabledBy: authorization.enabledBy || null },
    members, createdBy: row.created_by || null, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function getGroup(hostId, groupId, options = {}) {
  if (!SAFE_GROUP_ID.test(String(groupId || ''))) return null;
  const database = _database(options);
  const row = database.prepare(`SELECT * FROM provider_dr_protection_groups
    WHERE id = ? AND primary_host_id = ? AND deleted_at IS NULL`).get(String(groupId), Number(hostId));
  if (!row) return null;
  const members = database.prepare(`SELECT * FROM provider_dr_group_members
    WHERE group_id = ? ORDER BY sequence`).all(row.id).map(_publicMember);
  return _publicGroup(row, members);
}
function listGroups(hostId, options = {}) {
  const database = _database(options); const limit = _integer(options.limit, 'Group limit', 1, 200, 100);
  return database.prepare(`SELECT * FROM provider_dr_protection_groups
    WHERE primary_host_id = ? AND deleted_at IS NULL ORDER BY lower(name) LIMIT ?`)
    .all(Number(hostId), limit).map(row => _publicGroup(row, database.prepare(`SELECT *
      FROM provider_dr_group_members WHERE group_id = ? ORDER BY sequence`).all(row.id).map(_publicMember)));
}
function _storeMembers(database, groupId, members) {
  const insert = database.prepare(`INSERT INTO provider_dr_group_members
    (group_id, sequence, vm_id, vm_name, boot_stage, depends_on_json, recovery_source,
     backup_policy_id, drill_policy_id, recovery_target_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const member of members) insert.run(groupId, member.sequence, member.vmId, member.vmName,
    member.bootStage, JSON.stringify(member.dependsOn), member.recoverySource,
    member.backupPolicyId, member.drillPolicyId, JSON.stringify(member.recoveryTarget));
}
function upsertGroup(host, input = {}, options = {}) {
  const database = _database(options); const existing = input.id ? getGroup(host.id, input.id, { database }) : null;
  if (input.id && !existing) throw new DrRunbookError('Protection group was not found', 'DR_GROUP_NOT_FOUND', 404);
  const normalized = _normalizeGroup(host, input, { ...options, database }, existing);
  const id = existing?.id || `pdrg_${generateToken(13)}`; const now = _now();
  const authorization = normalized.enabled ? { enabledAt: now, enabledBy: options.createdBy || null } : {};
  try {
    database.transaction(() => {
      if (existing) {
        database.prepare(`UPDATE provider_dr_protection_groups SET recovery_host_id = ?, name = ?,
          strategy = ?, enabled = ?, revision = revision + 1, rpo_target_seconds = ?, rto_target_seconds = ?,
          placement_json = ?, network_mappings_json = ?, contacts_json = ?, authorization_json = ?,
          updated_at = ? WHERE id = ?`).run(normalized.recoveryHostId, normalized.name,
          normalized.strategy, normalized.enabled ? 1 : 0, normalized.rpoTargetSeconds,
          normalized.rtoTargetSeconds, JSON.stringify(normalized.placement),
          JSON.stringify(normalized.networkMappings), JSON.stringify(normalized.contacts),
          JSON.stringify(authorization), now, id);
        database.prepare('DELETE FROM provider_dr_group_members WHERE group_id = ?').run(id);
      } else {
        database.prepare(`INSERT INTO provider_dr_protection_groups
          (id, primary_host_id, recovery_host_id, name, strategy, enabled, rpo_target_seconds,
           rto_target_seconds, placement_json, network_mappings_json, contacts_json,
           authorization_json, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, normalized.primaryHostId, normalized.recoveryHostId, normalized.name,
            normalized.strategy, normalized.enabled ? 1 : 0, normalized.rpoTargetSeconds,
            normalized.rtoTargetSeconds, JSON.stringify(normalized.placement),
            JSON.stringify(normalized.networkMappings), JSON.stringify(normalized.contacts),
            JSON.stringify(authorization), options.createdBy || null, now, now);
      }
      _storeMembers(database, id, normalized.members);
    })();
  } catch (err) {
    if (/provider_dr_group_name/.test(String(err?.message || '')) || err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new DrRunbookError('Protection-group name already exists on this endpoint', 'DR_GROUP_NAME_CONFLICT', 409);
    }
    throw err;
  }
  return { group: getGroup(host.id, id, { database }), created: !existing };
}
function removeGroup(hostId, groupId, options = {}) {
  const database = _database(options); const group = getGroup(hostId, groupId, { database });
  if (!group) throw new DrRunbookError('Protection group was not found', 'DR_GROUP_NOT_FOUND', 404);
  database.prepare(`UPDATE provider_dr_protection_groups SET enabled = 0,
    deleted_at = ?, updated_at = ? WHERE id = ?`).run(_now(), _now(), group.id);
  return group;
}

function _canonicalVmMaps(database, hostId) {
  const rows = database.prepare(`SELECT i.canonical_id, i.native_ref_enc, s.display_name
    FROM provider_resource_identities i LEFT JOIN provider_resource_snapshots s
      ON s.canonical_id = i.canonical_id
    WHERE i.host_id = ? AND i.resource_kind = 'virtualMachine'`).all(Number(hostId));
  const map = new Map();
  for (const row of rows) {
    try {
      const ref = String(decrypt(row.native_ref_enc));
      const match = /(?:^|\/)(\d+)$/.exec(ref);
      if (match) map.set(Number(match[1]), { id: row.canonical_id, displayName: row.display_name || row.canonical_id });
    } catch { /* an unreadable identity is omitted, not exposed */ }
  }
  return map;
}
function _canonicalHostMaps(database, hostId) {
  const rows = database.prepare(`SELECT i.canonical_id, i.native_ref_enc, s.display_name
    FROM provider_resource_identities i LEFT JOIN provider_resource_snapshots s
      ON s.canonical_id = i.canonical_id
    WHERE i.host_id = ? AND i.resource_kind = 'host'`).all(Number(hostId));
  const map = new Map();
  for (const row of rows) {
    try { map.set(String(decrypt(row.native_ref_enc)), { id: row.canonical_id, displayName: row.display_name || row.canonical_id }); }
    catch { /* omitted */ }
  }
  return map;
}
async function listReplicationsForHost(host, options = {}) {
  const registry = _registry(options); const database = _database(options);
  const capabilities = await registry.capabilitiesForHost(host);
  const capability = capabilities.features?.['replication.read']
    || { state: 'unknown', source: 'fallback', reason: 'Replication capability evidence is missing', constraints: {} };
  if (host.daemon_type !== 'proxmox' || !['supported', 'conditional'].includes(capability.state)) {
    return { schemaVersion: SCHEMA_VERSION, provider: capabilities.provider,
      observedAt: _now(), capability, count: 0, items: [] };
  }
  const client = options.proxmoxClient || fromHostRow(host);
  try {
    const jobs = await client.listStorageReplicationJobs();
    if (!Array.isArray(jobs) || jobs.length > 1000) throw new DrRunbookError(
      'Provider returned an invalid replication inventory', 'INVALID_PROVIDER_REPLICATION_RESPONSE', 502);
    const vmMap = _canonicalVmMaps(database, host.id); const hostMap = _canonicalHostMaps(database, host.id);
    const now = Date.now();
    const items = await Promise.all(jobs.slice(0, 500).map(async job => {
      const nativeId = _text(job.id, 160); const source = _text(job.source, 128);
      let status = null;
      if (nativeId && source && typeof client.getStorageReplicationStatus === 'function') {
        try { status = await client.getStorageReplicationStatus(source, nativeId); }
        catch { status = { _unavailable: true }; }
      }
      const vmid = Number(job.guest ?? job.vmid ?? String(nativeId || '').split('-')[0]);
      const vm = vmMap.get(vmid) || null; const target = hostMap.get(String(job.target || '')) || null;
      const sourceHost = hostMap.get(String(source || '')) || null;
      const lastSyncAt = _timestamp(status?.last_sync ?? status?.lastSync ?? job.last_sync);
      return {
        id: `pdrrep_${sha256(`${host.id}|${nativeId || vmid}|${job.target || ''}`).slice(0, 26)}`,
        workloadId: vm?.id || null, workloadName: vm?.displayName || `VM ${Number.isFinite(vmid) ? vmid : 'unknown'}`,
        sourceHostId: sourceHost?.id || null, targetHostId: target?.id || null,
        enabled: !(job.disable === 1 || job.disable === true), scope: 'intra_cluster',
        mode: 'asynchronous', consistency: 'crash', schedule: _text(job.schedule, 120),
        rateMiBps: Number.isFinite(Number(job.rate)) ? Number(job.rate) : null,
        lastSyncAt, rpoAgeSeconds: lastSyncAt ? _ageSeconds(lastSyncAt, now) : null,
        health: status?._unavailable ? 'unknown'
          : (Number(status?.fail_count || status?.failCount || 0) > 0 || status?.error ? 'failed'
            : (lastSyncAt ? 'healthy' : 'unknown')),
        evidence: { source: 'pve_storage_replication', statusAvailable: !status?._unavailable },
      };
    }));
    return { schemaVersion: SCHEMA_VERSION, provider: capabilities.provider,
      observedAt: _now(), capability, count: items.length, items };
  } catch (err) {
    if (err instanceof DrRunbookError) throw err;
    throw new DrRunbookError('Provider replication inventory could not be read',
      'PROVIDER_REPLICATION_READ_FAILED', 502);
  } finally { if (!options.proxmoxClient) client._agent?.destroy?.(); }
}

function _latestRecoveryPoint(database, hostId, vmId) {
  const rows = database.prepare(`SELECT canonical_id, recovery_point_json, created_at, observed_at
    FROM provider_recovery_points WHERE host_id = ? AND workload_id = ?
    ORDER BY created_at DESC, observed_at DESC LIMIT 200`).all(Number(hostId), vmId);
  for (const row of rows) {
    const point = _parseJson(row.recovery_point_json, {});
    if (point?.verification?.state === 'verified') return {
      id: row.canonical_id, createdAt: point.createdAt || row.created_at || null,
      verification: { state: 'verified', method: _text(point.verification.method, 80) },
    };
  }
  return null;
}
function _latestDrills(database, hostId, vmId) {
  const rows = database.prepare(`SELECT r.* FROM provider_restore_drill_runs r
    JOIN provider_recovery_points p ON p.canonical_id = r.recovery_point_id
    WHERE r.host_id = ? AND p.workload_id = ? ORDER BY r.created_at DESC LIMIT 100`)
    .all(Number(hostId), vmId);
  return {
    latest: rows[0] || null,
    succeeded: rows.find(row => row.state === 'succeeded' && row.rto_seconds !== null) || null,
  };
}
function _memberCompliance(member) {
  if (member.drill.latest && ['failed', 'cancelled'].includes(member.drill.latest.state)) return 'failed';
  if (member.drill.latest?.state === 'unknown') return 'unknown';
  if (!member.drill.succeeded) return 'never_tested';
  if (member.rpoAgeSeconds === null || member.rtoSeconds === null) return 'unknown';
  if (member.rpoAgeSeconds > member.rpoTargetSeconds || member.rtoSeconds > member.rtoTargetSeconds) return 'breached';
  return 'met';
}
function _groupCompliance(members) {
  const states = new Set(members.map(member => member.compliance));
  for (const state of ['failed', 'never_tested', 'unknown', 'breached', 'met']) if (states.has(state)) return state;
  return 'unknown';
}
function _mappingBlockers(group, database) {
  const blockers = [];
  for (const [key, kind] of [['clusterId', 'cluster'], ['nodeId', 'host'], ['storageId', 'storage']]) {
    const id = group.placement?.[key];
    if (id && !_identity(database, id, group.recoveryHostId, kind, false)) blockers.push({
      code: 'DR_TARGET_MAPPING_STALE', memberId: null, reason: `Recovery ${kind} mapping is stale`,
    });
  }
  for (const mapping of group.networkMappings) {
    if (!_identity(database, mapping.sourceNetworkId, group.primaryHostId, 'network', false)
      || !_identity(database, mapping.targetNetworkId, group.recoveryHostId, 'network', false)
      || (mapping.testNetworkId && !_identity(database, mapping.testNetworkId, group.recoveryHostId, 'network', false))) {
      blockers.push({ code: 'DR_NETWORK_MAPPING_STALE', memberId: null,
        reason: 'A canonical network mapping is stale or out of scope' });
    }
  }
  return blockers;
}
async function _collectEvidence(host, group, options = {}) {
  const database = _database(options); const now = Date.now();
  let replications = options.replications;
  if (!replications) {
    try { replications = await listReplicationsForHost(host, { ...options, database }); }
    catch (err) { replications = { capability: { state: 'unknown', reason: err.code || 'Replication read failed' }, items: [] }; }
  }
  const blockers = _mappingBlockers(group, database); const warnings = [];
  const members = group.members.map(member => {
    const point = _latestRecoveryPoint(database, group.primaryHostId, member.vmId);
    const drills = _latestDrills(database, group.primaryHostId, member.vmId);
    const replication = (replications.items || []).find(item => item.workloadId === member.vmId) || null;
    let rpoAgeSeconds = member.recoverySource === 'replication'
      ? replication?.rpoAgeSeconds ?? null : (point ? _ageSeconds(point.createdAt, now) : null);
    const rtoSeconds = drills.succeeded?.rto_seconds ?? null;
    const evidence = {
      vmId: member.vmId, vmName: member.vmName, recoverySource: member.recoverySource,
      recoveryPoint: point, replication,
      drill: {
        latest: drills.latest ? { id: drills.latest.id, state: drills.latest.state,
          completedAt: drills.latest.completed_at || null } : null,
        succeeded: drills.succeeded ? { id: drills.succeeded.id, state: 'succeeded',
          rtoSeconds: Number(drills.succeeded.rto_seconds), completedAt: drills.succeeded.completed_at } : null,
      },
      rpoAgeSeconds, rtoSeconds,
      rpoTargetSeconds: group.rpoTargetSeconds, rtoTargetSeconds: group.rtoTargetSeconds,
    };
    if (member.recoverySource === 'replication' && !replication) blockers.push({
      code: 'DR_REPLICATION_EVIDENCE_MISSING', memberId: member.vmId,
      reason: `${member.vmName} has no matching replication evidence`,
    });
    if (member.recoverySource === 'replication' && replication && replication.health !== 'healthy') blockers.push({
      code: 'DR_REPLICATION_UNHEALTHY', memberId: member.vmId,
      reason: `${member.vmName} replication health is ${replication.health}`,
    });
    if (member.recoverySource === 'backup' && !point) blockers.push({
      code: 'DR_VERIFIED_RECOVERY_POINT_MISSING', memberId: member.vmId,
      reason: `${member.vmName} has no verified recovery point`,
    });
    if (rpoAgeSeconds === null) blockers.push({ code: 'DR_RPO_UNKNOWN', memberId: member.vmId,
      reason: `${member.vmName} has no measurable RPO evidence` });
    else if (rpoAgeSeconds > group.rpoTargetSeconds) warnings.push({ code: 'DR_RPO_BREACHED',
      memberId: member.vmId, reason: `${member.vmName} exceeds the RPO target` });
    if (!drills.succeeded) blockers.push({ code: 'DR_AUTOMATED_TEST_MISSING', memberId: member.vmId,
      reason: `${member.vmName} has no successful automated restore drill` });
    else if (rtoSeconds > group.rtoTargetSeconds) warnings.push({ code: 'DR_RTO_BREACHED',
      memberId: member.vmId, reason: `${member.vmName} exceeds the RTO target` });
    evidence.compliance = _memberCompliance(evidence);
    return evidence;
  });
  return {
    observedAt: _now(), replicationCapability: replications.capability,
    members, blockers, warnings, compliance: _groupCompliance(members),
    rpoMaxSeconds: members.some(member => member.rpoAgeSeconds === null) ? null
      : Math.max(...members.map(member => member.rpoAgeSeconds)),
    rtoMaxSeconds: members.some(member => member.rtoSeconds === null) ? null
      : Math.max(...members.map(member => member.rtoSeconds)),
  };
}

function _step(id, phase, stage, owner, mutation, needs, evidence) {
  return { id, phase, stage, owner, mutation, needs: [...new Set(needs || [])].sort(),
    requiredEvidence: evidence || [] };
}
function _compileSteps(group, mode) {
  const members = [...group.members].sort((a, b) => a.sequence - b.sequence);
  const reverse = [...members].reverse(); const steps = [
    _step('precheck', 'precheck', 1, 'docker_dash', false, [],
      ['endpoint_reachable', 'dependency_graph_valid', 'rpo_rto_evidence', 'mapping_scope']),
  ];
  const addMemberWave = (prefix, phase, baseStage, owner, mutation, source, dependencies = true) => {
    for (const member of source) {
      const dependencySteps = dependencies
        ? member.dependsOn.map(id => `${prefix}_${id.replace(/^ddr_vm_/, '')}`) : [];
      steps.push(_step(`${prefix}_${member.vmId.replace(/^ddr_vm_/, '')}`, phase,
        baseStage + member.bootStage, owner, mutation, ['source_isolated', ...dependencySteps],
        ['canonical_vm', 'native_task', 'post_state']));
    }
  };
  if (mode === 'planned_failover') {
    steps.push(_step('final_sync', 'synchronize', 10, 'provider', true, ['precheck'], ['replication_current']));
    for (const member of reverse) steps.push(_step(`stop_${member.vmId.replace(/^ddr_vm_/, '')}`,
      'source_shutdown', 30 + (21 - member.bootStage), 'provider', true, ['final_sync'], ['source_stopped']));
    steps.push(_step('source_isolated', 'fencing', 60, 'operator', true,
      reverse.map(member => `stop_${member.vmId.replace(/^ddr_vm_/, '')}`), ['source_fenced']));
    addMemberWave('promote', 'promote', 70, 'provider', true, members);
  } else if (mode === 'unplanned_failover') {
    steps.push(_step('source_isolated', 'fencing', 20, 'operator', true, ['precheck'],
      ['incident_declared', 'source_fenced']));
    addMemberWave('promote', 'promote', 30, 'provider', true, members);
  } else if (mode === 'failback') {
    steps.push(_step('reverse_sync', 'synchronize', 10, 'provider', true, ['precheck'], ['reverse_protection_healthy']));
    for (const member of reverse) steps.push(_step(`stop_recovery_${member.vmId.replace(/^ddr_vm_/, '')}`,
      'recovery_shutdown', 30 + (21 - member.bootStage), 'provider', true, ['reverse_sync'], ['recovery_stopped']));
    steps.push(_step('source_isolated', 'fencing', 60, 'operator', true,
      reverse.map(member => `stop_recovery_${member.vmId.replace(/^ddr_vm_/, '')}`), ['recovery_site_fenced']));
    addMemberWave('recover', 'recover_primary', 70, 'provider', true, members);
  } else {
    steps.push(_step('bubble_network', 'isolate_test', 10, 'provider', true, ['precheck'],
      ['isolated_network_owned', 'production_routes_absent']));
    steps.push(_step('source_isolated', 'test_boundary', 20, 'docker_dash', false, ['bubble_network'],
      ['production_unchanged']));
    addMemberWave('test', 'restore_test', 30, 'provider', true, members);
  }
  const actionPrefix = mode === 'failback' ? 'recover' : (mode === 'test' ? 'test' : 'promote');
  for (const member of members) steps.push(_step(`validate_${member.vmId.replace(/^ddr_vm_/, '')}`,
    'validate', 110 + member.bootStage, 'docker_dash', false,
    [`${actionPrefix}_${member.vmId.replace(/^ddr_vm_/, '')}`,
      ...member.dependsOn.map(id => `validate_${id.replace(/^ddr_vm_/, '')}`)],
    ['boot_assertion', 'guest_signal', 'dependency_ready']));
  if (mode === 'test') steps.push(_step('cleanup_test', 'cleanup', 150, 'provider', true,
    members.map(member => `validate_${member.vmId.replace(/^ddr_vm_/, '')}`),
    ['ownership_marker', 'targets_stopped', 'bubble_removed']));
  else steps.push(_step('reverse_protection', 'protect_active_site', 150, 'provider', true,
    members.map(member => `validate_${member.vmId.replace(/^ddr_vm_/, '')}`), ['replication_direction_verified']));
  steps.push(_step('notify', 'notify', 160, 'operator', false,
    [mode === 'test' ? 'cleanup_test' : 'reverse_protection'], ['stakeholders_notified', 'incident_record']));
  return steps;
}
function _semanticPlan(plan) {
  const stableEvidence = plan.evidence.members.map(member => ({
    vmId: member.vmId,
    recoverySource: member.recoverySource,
    recoveryPoint: member.recoveryPoint ? {
      id: member.recoveryPoint.id,
      createdAt: member.recoveryPoint.createdAt,
      verificationState: member.recoveryPoint.verificationState,
    } : null,
    replication: member.replication ? {
      id: member.replication.id,
      lastSyncAt: member.replication.lastSyncAt,
      health: member.replication.health,
      targetHostId: member.replication.targetHostId,
    } : null,
    drill: member.drill ? {
      latest: member.drill.latest ? { id: member.drill.latest.id, state: member.drill.latest.state,
        completedAt: member.drill.latest.completedAt } : null,
      succeeded: member.drill.succeeded ? { id: member.drill.succeeded.id,
        completedAt: member.drill.succeeded.completedAt,
        rtoSeconds: member.drill.succeeded.rtoSeconds } : null,
    } : null,
    rpoTargetSeconds: member.rpoTargetSeconds,
    rtoTargetSeconds: member.rtoTargetSeconds,
    rtoSeconds: member.rtoSeconds,
    compliance: member.compliance,
  }));
  return {
    schemaVersion: plan.schemaVersion, group: plan.group, mode: plan.mode,
    executionType: plan.executionType, incident: plan.incident, providers: plan.providers,
    capability: plan.capability, members: stableEvidence,
    placement: plan.placement, networkMappings: plan.networkMappings,
    steps: plan.steps, blockers: plan.blockers, warnings: plan.warnings,
  };
}
async function preflightForHost(host, groupId, input = {}, options = {}) {
  const database = _database(options); const group = getGroup(host.id, groupId, { database });
  if (!group) throw new DrRunbookError('Protection group was not found', 'DR_GROUP_NOT_FOUND', 404);
  const mode = String(input.mode || 'test');
  if (!MODES.has(mode)) throw new DrRunbookError('DR runbook mode is invalid', 'INVALID_DR_RUNBOOK_MODE');
  const executionType = options.executionType === 'rehearsal' ? 'rehearsal' : 'real';
  const registry = _registry(options); const capabilities = await registry.capabilitiesForHost(host);
  const capabilityKey = mode === 'failback' ? 'dr.failback' : (mode === 'test' ? 'dr.test' : 'dr.failover');
  const capability = capabilities.features?.[capabilityKey]
    || { state: 'unknown', reason: 'DR capability evidence is missing', constraints: {} };
  const evidence = await _collectEvidence(host, group, { ...options, database });
  const blockers = [...evidence.blockers]; const warnings = [...evidence.warnings];
  if (!group.enabled) blockers.push({ code: 'DR_GROUP_DISABLED', memberId: null,
    reason: 'Protection group is disabled' });
  const enabled = options.enabled === undefined ? config.features.providerDrRunbooks : options.enabled === true;
  if (!enabled) blockers.push({ code: 'DR_RUNBOOKS_DISABLED', memberId: null,
    reason: 'DR runbooks are disabled by release policy' });
  if (options.canOperate !== true) blockers.push({ code: 'DR_PERMISSION_DENIED', memberId: null,
    reason: 'Administrator operate permission is required' });
  const policy = (options.policy || policySingleton).evaluate({ providerType: host.daemon_type, hostId: Number(host.id) });
  if (!policy.allowed) blockers.push({ code: policy.code || 'OPERATION_POLICY_BLOCKED', memberId: null,
    reason: policy.reason });
  if (mode === 'test' && group.networkMappings.some(mapping => !mapping.testNetworkId)) blockers.push({
    code: 'DR_TEST_NETWORK_MISSING', memberId: null,
    reason: 'Every production network mapping requires an isolated test network',
  });
  if (mode === 'unplanned_failover' && !_text(input.incidentReason, 500)) blockers.push({
    code: 'DR_INCIDENT_REASON_REQUIRED', memberId: null,
    reason: 'Unplanned failover requires a bounded incident reason',
  });
  const mutationBlockers = [];
  if (!['supported', 'conditional'].includes(capability.state)) mutationBlockers.push({
    code: 'DR_PROVIDER_MUTATION_UNAVAILABLE', memberId: null,
    reason: capability.reason || `${capabilityKey} is unavailable`,
  });
  mutationBlockers.push({ code: 'DR_AUTOMATIC_EXECUTION_NOT_RELEASED', memberId: null,
    reason: 'This release compiles and rehearses DR plans but cannot submit provider mutations' });
  if (executionType === 'real') blockers.push(...mutationBlockers);
  else warnings.push(...mutationBlockers);
  const recoveryHost = _host(database, group.recoveryHostId);
  const plan = {
    schemaVersion: SCHEMA_VERSION, generatedAt: _now(),
    group: { id: group.id, name: group.name, revision: group.revision, strategy: group.strategy,
      rpoTargetSeconds: group.rpoTargetSeconds, rtoTargetSeconds: group.rtoTargetSeconds },
    mode, executionType,
    incident: mode === 'unplanned_failover' ? { reason: _text(input.incidentReason, 500) } : null,
    providers: {
      primary: { endpointId: group.primaryHostId, type: host.daemon_type, name: _text(host.name, 160) },
      recovery: { endpointId: group.recoveryHostId, type: recoveryHost.daemon_type, name: _text(recoveryHost.name, 160) },
    },
    capability: { key: capabilityKey, state: capability.state, source: capability.source || null,
      reason: capability.reason || null, constraints: capability.constraints || {} },
    placement: group.placement, networkMappings: group.networkMappings,
    evidence, steps: _compileSteps(group, mode), blockers, warnings,
    authorization: executionType === 'real'
      ? { required: true, mode: 'four_eyes', requesterCannotApprove: true,
        fencingRequired: mode === 'unplanned_failover' }
      : { required: false, mode: 'typed_rehearsal', expected: `REHEARSE ${group.name}` },
  };
  plan.allowed = blockers.length === 0;
  plan.planHash = sha256(_canonical(_semanticPlan(plan)));
  return plan;
}

function _publicRun(row) {
  if (!row) return null;
  return {
    schemaVersion: SCHEMA_VERSION, id: row.id, groupId: row.group_id,
    primaryHostId: Number(row.primary_host_id), groupRevision: Number(row.group_revision),
    executionType: row.execution_type, mode: row.runbook_mode, state: row.state,
    planHash: row.plan_hash, evidence: _parseJson(row.evidence_json, {}),
    evidenceHash: row.evidence_hash, compliance: row.compliance,
    rpoMaxSeconds: row.rpo_max_seconds ?? null, rtoMaxSeconds: row.rto_max_seconds ?? null,
    blockerCount: Number(row.blocker_count), warningCount: Number(row.warning_count),
    createdBy: row.created_by || null, createdAt: row.created_at, completedAt: row.completed_at,
  };
}
async function rehearseForHost(host, groupId, input = {}, options = {}) {
  const database = _database(options);
  const plan = await preflightForHost(host, groupId, input, { ...options, database, executionType: 'rehearsal' });
  if (!/^[a-f0-9]{64}$/.test(String(input.planHash || '')) || input.planHash !== plan.planHash) {
    throw new DrRunbookError('DR plan changed; review the current rehearsal plan', 'DR_PLAN_STALE', 409);
  }
  if (input.confirm !== true || input.confirmationText !== `REHEARSE ${plan.group.name}`) {
    throw new DrRunbookError(`Type REHEARSE ${plan.group.name} to record this rehearsal`,
      'DR_REHEARSAL_CONFIRMATION_REQUIRED');
  }
  const state = plan.allowed ? 'succeeded' : 'blocked'; const id = `pdrun_${generateToken(13)}`;
  const completedAt = _now();
  const evidence = {
    schemaVersion: SCHEMA_VERSION, executionType: 'rehearsal', mode: plan.mode, incident: plan.incident,
    group: plan.group, observedAt: plan.evidence.observedAt,
    members: plan.evidence.members, steps: plan.steps.map(step => ({
      id: step.id, phase: step.phase, stage: step.stage, mutation: step.mutation,
      verdict: step.mutation ? 'not_executed' : (plan.allowed ? 'evaluated' : 'blocked'),
    })), blockers: plan.blockers, warnings: plan.warnings,
    compliance: plan.evidence.compliance, completedAt,
  };
  const evidenceHash = sha256(_canonical({ planHash: plan.planHash, ...evidence }));
  database.prepare(`INSERT INTO provider_dr_runs
    (id, group_id, primary_host_id, group_revision, runbook_mode, state, plan_hash,
     evidence_json, evidence_hash, compliance, rpo_max_seconds, rto_max_seconds,
     blocker_count, warning_count, created_by, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, groupId, Number(host.id), plan.group.revision, plan.mode, state, plan.planHash,
      JSON.stringify(evidence), evidenceHash, plan.evidence.compliance,
      plan.evidence.rpoMaxSeconds, plan.evidence.rtoMaxSeconds,
      plan.blockers.length, plan.warnings.length, options.createdBy || null, completedAt, completedAt);
  return { plan, run: _publicRun(database.prepare('SELECT * FROM provider_dr_runs WHERE id = ?').get(id)) };
}
function listRuns(hostId, options = {}) {
  const database = _database(options); const limit = _integer(options.limit, 'Run limit', 1, 200, 50);
  const groupId = options.groupId ? String(options.groupId) : null;
  if (groupId && !SAFE_GROUP_ID.test(groupId)) throw new DrRunbookError('Run group filter is invalid', 'INVALID_DR_RUN_FILTER');
  const rows = groupId ? database.prepare(`SELECT * FROM provider_dr_runs
    WHERE primary_host_id = ? AND group_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(Number(hostId), groupId, limit) : database.prepare(`SELECT * FROM provider_dr_runs
    WHERE primary_host_id = ? ORDER BY created_at DESC LIMIT ?`).all(Number(hostId), limit);
  return rows.map(_publicRun);
}
async function overviewForHost(host, options = {}) {
  const database = _database(options); const groups = listGroups(host.id, { database, limit: options.limit || 100 });
  let replications;
  try { replications = await listReplicationsForHost(host, { ...options, database }); }
  catch (err) { replications = { capability: { state: 'unknown', reason: err.code || 'read_failed' }, items: [] }; }
  const items = [];
  for (const group of groups) {
    const evidence = await _collectEvidence(host, group, { ...options, database, replications });
    const lastRun = database.prepare(`SELECT * FROM provider_dr_runs
      WHERE group_id = ? ORDER BY created_at DESC LIMIT 1`).get(group.id);
    items.push({ group, compliance: evidence.compliance,
      rpoMaxSeconds: evidence.rpoMaxSeconds, rtoMaxSeconds: evidence.rtoMaxSeconds,
      blockerCount: evidence.blockers.length, warningCount: evidence.warnings.length,
      memberStates: Object.fromEntries(['met', 'breached', 'failed', 'unknown', 'never_tested']
        .map(state => [state, evidence.members.filter(member => member.compliance === state).length])),
      lastRun: _publicRun(lastRun) });
  }
  const counts = Object.fromEntries(['met', 'breached', 'failed', 'unknown', 'never_tested']
    .map(state => [state, items.filter(item => item.compliance === state).length]));
  return { schemaVersion: SCHEMA_VERSION, generatedAt: _now(), count: items.length,
    counts, replication: { capability: replications.capability, count: replications.items.length }, items };
}

module.exports = {
  DrRunbookError, upsertGroup, removeGroup, getGroup, listGroups,
  listReplicationsForHost, preflightForHost, rehearseForHost, listRuns, overviewForHost,
  _internals: { _sortMembers, _compileSteps, _canonical, _groupCompliance, _memberCompliance },
};
