'use strict';

const { getDb } = require('../../db');
const { encrypt, decrypt, generateToken, sha256 } = require('../../utils/crypto');

const SAFE_ID = /^ddv_vol_[a-f0-9]{26}$/;
const SAFE_DISK_ID = /^ddh_disk_[a-f0-9]{26}$/;
const STATES = new Set(['creating', 'attached', 'detached', 'moving', 'deleting', 'deleted', 'unknown']);

function _text(value, max) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function _public(row) {
  if (!row) return null;
  return {
    schemaVersion: row.schema_version,
    id: row.id,
    hostId: Number(row.host_id),
    vmId: row.vm_id,
    providerType: row.provider_type,
    diskId: row.disk_id || null,
    label: row.label,
    storageId: row.storage_id || null,
    bus: row.bus || null,
    unit: row.unit_number === null ? null : Number(row.unit_number),
    capacityBytes: Number(row.capacity_bytes),
    state: row.lifecycle_state,
    ownership: { managed: true, scope: 'docker_dash_created' },
    createOperationId: row.create_operation_id || null,
    lastOperationId: row.last_operation_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    detachedAt: row.detached_at || null,
    deletedAt: row.deleted_at || null,
  };
}

function create(input, database) {
  const db = database || getDb();
  const hostId = Number(input?.hostId);
  const vmId = String(input?.vmId || '');
  const providerType = String(input?.providerType || '');
  const nativeRef = String(input?.nativeRef || '');
  const label = _text(input?.label, 160);
  const capacityBytes = Number(input?.capacityBytes);
  const state = String(input?.state || 'creating');
  if (!Number.isInteger(hostId) || hostId <= 0 || !/^ddr_vm_[a-f0-9]{26}$/.test(vmId)
    || !/^[a-z][a-z0-9_-]{1,39}$/.test(providerType) || !nativeRef || nativeRef.length > 2048
    || !label || !Number.isSafeInteger(capacityBytes) || capacityBytes <= 0 || !STATES.has(state)) {
    throw new Error('Managed volume input is invalid');
  }
  const id = `ddv_vol_${generateToken(16).slice(0, 26)}`;
  const nativeHash = sha256(`${hostId}|${providerType}|${nativeRef}`);
  db.prepare(`INSERT INTO provider_managed_volumes
    (id, host_id, vm_id, provider_type, native_ref_hash, native_ref_enc,
     disk_id, label, storage_id, bus, unit_number, capacity_bytes, lifecycle_state,
     create_operation_id, last_operation_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, hostId, vmId, providerType, nativeHash, encrypt(nativeRef),
      SAFE_DISK_ID.test(String(input.diskId || '')) ? input.diskId : null,
      label, input.storageId || null, _text(input.bus, 40),
      Number.isInteger(Number(input.unit)) ? Number(input.unit) : null,
      capacityBytes, state, input.operationId || null, input.operationId || null,
      Number.isInteger(Number(input.createdBy)) ? Number(input.createdBy) : null);
  return get(id, { hostId }, db);
}

function get(id, scope = {}, database) {
  const db = database || getDb();
  const hostId = Number(scope.hostId);
  if (!SAFE_ID.test(String(id || '')) || !Number.isInteger(hostId) || hostId <= 0) return null;
  return _public(db.prepare('SELECT * FROM provider_managed_volumes WHERE id=? AND host_id=?').get(id, hostId));
}

function resolve(id, scope = {}, database) {
  const db = database || getDb();
  const hostId = Number(scope.hostId);
  if (!SAFE_ID.test(String(id || '')) || !Number.isInteger(hostId) || hostId <= 0) return null;
  const row = db.prepare('SELECT * FROM provider_managed_volumes WHERE id=? AND host_id=?').get(id, hostId);
  if (!row) return null;
  return { ..._public(row), nativeRef: decrypt(row.native_ref_enc), nativeRefHash: row.native_ref_hash };
}

function findForDisk(hostIdInput, vmId, diskId, database) {
  const db = database || getDb();
  const hostId = Number(hostIdInput);
  if (!Number.isInteger(hostId) || !/^ddr_vm_[a-f0-9]{26}$/.test(String(vmId || ''))
    || !SAFE_DISK_ID.test(String(diskId || ''))) return null;
  return _public(db.prepare(`SELECT * FROM provider_managed_volumes
    WHERE host_id=? AND vm_id=? AND disk_id=? AND lifecycle_state != 'deleted'
    ORDER BY updated_at DESC LIMIT 1`).get(hostId, vmId, diskId));
}

function list(hostIdInput, options = {}, database) {
  const db = database || getDb();
  const hostId = Number(hostIdInput);
  const limit = Math.min(500, Math.max(1, Number(options.limit) || 200));
  if (!Number.isInteger(hostId) || hostId <= 0) return [];
  const where = ['host_id=?']; const values = [hostId];
  if (options.vmId) { where.push('vm_id=?'); values.push(String(options.vmId)); }
  if (options.state && STATES.has(String(options.state))) { where.push('lifecycle_state=?'); values.push(String(options.state)); }
  if (options.includeDeleted !== true) where.push("lifecycle_state != 'deleted'");
  return db.prepare(`SELECT * FROM provider_managed_volumes WHERE ${where.join(' AND ')}
    ORDER BY updated_at DESC LIMIT ?`).all(...values, limit).map(_public);
}

function transition(id, scope = {}, nextState, values = {}, database) {
  const db = database || getDb();
  const hostId = Number(scope.hostId);
  if (!SAFE_ID.test(String(id || '')) || !Number.isInteger(hostId) || !STATES.has(String(nextState))) return null;
  const diskId = values.diskId === undefined ? null
    : (SAFE_DISK_ID.test(String(values.diskId || '')) ? values.diskId : null);
  const result = db.prepare(`UPDATE provider_managed_volumes SET
    lifecycle_state=?, disk_id=CASE WHEN ? THEN ? ELSE disk_id END,
    storage_id=CASE WHEN ? THEN ? ELSE storage_id END,
    capacity_bytes=CASE WHEN ? THEN ? ELSE capacity_bytes END,
    last_operation_id=COALESCE(?, last_operation_id),
    detached_at=CASE WHEN ?='detached' THEN datetime('now') ELSE detached_at END,
    deleted_at=CASE WHEN ?='deleted' THEN datetime('now') ELSE deleted_at END,
    updated_at=datetime('now') WHERE id=? AND host_id=?`)
    .run(nextState,
      values.diskId !== undefined ? 1 : 0, diskId,
      values.storageId !== undefined ? 1 : 0, values.storageId || null,
      values.capacityBytes !== undefined ? 1 : 0, Number(values.capacityBytes) || 0,
      values.operationId || null, nextState, nextState, id, hostId);
  return result.changes ? get(id, { hostId }, db) : null;
}

module.exports = {
  SAFE_ID, STATES, create, get, resolve, findForDisk, list, transition,
  _internals: { _text, _public },
};
