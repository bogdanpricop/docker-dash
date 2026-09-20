'use strict';

const config = require('../../config');
const { getDb } = require('../../db');

const SAFE_VM_ID = /^ddr_vm_[a-f0-9]{26}$/;
const MAX_REASON_LENGTH = 500;

function _override() {
  const value = String(config.providerConsole?.accessOverride || 'managed').trim().toLowerCase();
  return ['allow', 'deny'].includes(value) ? value : 'managed';
}

function _reason(value) {
  return String(value || '').trim().slice(0, MAX_REASON_LENGTH);
}

function normalizeHostId(value) {
  const raw = String(value || '');
  if (!/^\d+$/.test(raw)) throw Object.assign(new Error('hostId must be a positive integer'), { status: 400 });
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw Object.assign(new Error('hostId must be a positive integer'), { status: 400 });
  }
  return id;
}

function normalizeResourceId(value) {
  const id = String(value || '');
  if (!SAFE_VM_ID.test(id)) {
    throw Object.assign(new Error('Virtual machine was not found'), { status: 404, code: 'PROVIDER_VM_NOT_FOUND' });
  }
  return id;
}

function _row(scopeKey, database = getDb()) {
  return database.prepare(`
    SELECT l.scope_key, l.host_id, l.resource_id, l.reason, l.updated_by, l.updated_at,
           u.username AS updated_by_username
    FROM provider_console_access_locks l
    LEFT JOIN users u ON u.id = l.updated_by
    WHERE l.scope_key = ?
  `).get(scopeKey) || null;
}

function _serialize(row) {
  if (!row) return { locked: false, reason: '', updatedBy: null, updatedAt: null };
  return {
    locked: true,
    reason: row.reason || '',
    updatedBy: row.updated_by_username || null,
    updatedAt: row.updated_at || null,
  };
}

function effective(hostId, resourceId = null, database = getDb()) {
  const resolvedHostId = normalizeHostId(hostId);
  const resolvedResourceId = resourceId === null ? null : normalizeResourceId(resourceId);
  if (!config.features.providerVmConsole) {
    return {
      locked: true, source: 'feature_flag', hostId: resolvedHostId,
      resourceId: resolvedResourceId, reason: 'DD_PROVIDER_VM_CONSOLE=false',
    };
  }
  const override = _override();
  if (override === 'deny') {
    return {
      locked: true, source: 'environment', hostId: resolvedHostId,
      resourceId: resolvedResourceId, reason: 'DD_PROVIDER_VM_CONSOLE_ACCESS_OVERRIDE=deny',
    };
  }
  if (override === 'allow') {
    return {
      locked: false, source: 'environment_recovery', hostId: resolvedHostId,
      resourceId: resolvedResourceId, reason: 'DD_PROVIDER_VM_CONSOLE_ACCESS_OVERRIDE=allow',
    };
  }
  const global = _row('global', database);
  if (global) return {
    locked: true, source: 'global', hostId: resolvedHostId,
    resourceId: resolvedResourceId, reason: global.reason || '',
  };
  const host = _row(`host:${resolvedHostId}`, database);
  if (host) return {
    locked: true, source: 'host', hostId: resolvedHostId,
    resourceId: resolvedResourceId, reason: host.reason || '',
  };
  const vm = resolvedResourceId ? _row(`vm:${resolvedHostId}:${resolvedResourceId}`, database) : null;
  if (vm) return {
    locked: true, source: 'virtualMachine', hostId: resolvedHostId,
    resourceId: resolvedResourceId, reason: vm.reason || '',
  };
  return {
    locked: false, source: 'managed', hostId: resolvedHostId,
    resourceId: resolvedResourceId, reason: '',
  };
}

function status(hostId = null, resourceId = null, database = getDb()) {
  const rows = database.prepare(`
    SELECT l.scope_key, l.host_id, l.resource_id, l.reason, l.updated_by, l.updated_at,
           u.username AS updated_by_username
    FROM provider_console_access_locks l
    LEFT JOIN users u ON u.id = l.updated_by
    ORDER BY CASE WHEN l.scope_key = 'global' THEN 0 WHEN l.resource_id IS NULL THEN 1 ELSE 2 END,
             l.host_id, l.resource_id
  `).all();
  const global = rows.find(row => row.scope_key === 'global') || null;
  const response = {
    featureEnabled: !!config.features.providerVmConsole,
    override: _override(),
    global: _serialize(global),
    hosts: rows.filter(row => row.host_id !== null && row.resource_id === null).map(row => ({
      hostId: row.host_id, ..._serialize(row),
    })),
    virtualMachines: rows.filter(row => row.resource_id !== null).map(row => ({
      hostId: row.host_id, resourceId: row.resource_id, ..._serialize(row),
    })),
  };
  if (hostId !== null) response.effective = effective(hostId, resourceId, database);
  return response;
}

function _set(scopeKey, hostId, resourceId, locked, reason, userId, database = getDb()) {
  if (locked) {
    database.prepare(`
      INSERT INTO provider_console_access_locks
        (scope_key, host_id, resource_id, reason, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(scope_key) DO UPDATE SET
        reason = excluded.reason, updated_by = excluded.updated_by,
        updated_at = datetime('now')
    `).run(scopeKey, hostId, resourceId, _reason(reason), userId || null);
  } else {
    database.prepare('DELETE FROM provider_console_access_locks WHERE scope_key = ?').run(scopeKey);
  }
}

function _assertHost(hostId, database = getDb()) {
  const id = normalizeHostId(hostId);
  if (!database.prepare('SELECT 1 FROM docker_hosts WHERE id = ?').get(id)) {
    throw Object.assign(new Error('Provider host not found'), { status: 404 });
  }
  return id;
}

function setGlobal({ locked, reason, userId }, database) {
  _set('global', null, null, !!locked, reason, userId, database);
  return status(null, null, database || getDb());
}

function setHost(hostId, { locked, reason, userId }, database = getDb()) {
  const id = _assertHost(hostId, database);
  _set(`host:${id}`, id, null, !!locked, reason, userId, database);
  return status(id, null, database);
}

function setVirtualMachine(hostId, resourceId, { locked, reason, userId }, database = getDb()) {
  const id = _assertHost(hostId, database);
  const vmId = normalizeResourceId(resourceId);
  if (!database.prepare(`SELECT 1 FROM provider_resource_identities
      WHERE canonical_id = ? AND host_id = ? AND resource_kind = 'virtualMachine'`).get(vmId, id)) {
    throw Object.assign(new Error('Virtual machine was not found'), { status: 404 });
  }
  _set(`vm:${id}:${vmId}`, id, vmId, !!locked, reason, userId, database);
  return status(id, vmId, database);
}

module.exports = {
  SAFE_VM_ID, MAX_REASON_LENGTH, normalizeHostId, normalizeResourceId,
  effective, status, setGlobal, setHost, setVirtualMachine,
  _internals: { _override, _reason, _row, _serialize },
};
