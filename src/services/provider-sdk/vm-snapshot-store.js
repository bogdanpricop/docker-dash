'use strict';

const { getDb } = require('../../db');
const { encrypt, decrypt, sha256 } = require('../../utils/crypto');

const SAFE_VM_ID = /^ddr_vm_[a-f0-9]{26}$/;
const SAFE_SNAPSHOT_ID = /^dds_snap_[a-f0-9]{26}$/;
const SAFE_PROVIDER = /^[a-z][a-z0-9_-]{1,39}$/;
const CONSISTENCIES = new Set(['crash', 'quiesced', 'unknown']);
const MAX_SNAPSHOTS = 500;

function _text(value, max) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

function _timestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function _input(context, raw, observedAt) {
  const nativeRef = _text(raw?.nativeRef ?? raw?.ref ?? raw?.id, 2048);
  const name = _text(raw?.name, 160);
  if (!nativeRef || !name) throw new Error('Provider snapshot requires nativeRef and name');
  const uuid = _text(raw?.uuid, 512);
  const nativeRefHash = sha256(`${context.hostId}|${context.vmId}|${nativeRef}`);
  const stableIdentity = uuid || nativeRef;
  return {
    canonicalId: `dds_snap_${sha256(`${context.hostId}|${context.vmId}|${stableIdentity}`).slice(0, 26)}`,
    nativeRef, nativeRefHash, uuid, name,
    description: _text(raw?.description, 1000), createdAt: _timestamp(raw?.createdAt),
    parentRef: _text(raw?.parentRef, 2048), isCurrent: raw?.isCurrent === true,
    consistency: CONSISTENCIES.has(raw?.consistency) ? raw.consistency : 'unknown',
    observedAt,
  };
}

function _context(input) {
  const hostId = Number(input?.hostId);
  const vmId = String(input?.vmId || '');
  const providerType = String(input?.providerType || '').toLowerCase();
  if (!Number.isInteger(hostId) || hostId <= 0 || !SAFE_VM_ID.test(vmId) || !SAFE_PROVIDER.test(providerType)) {
    throw new Error('Provider snapshot context is invalid');
  }
  return { hostId, vmId, providerType };
}

function _integrity(items) {
  const byId = new Map(items.map(item => [item.canonicalId, item]));
  const states = new Map();
  const visit = (item, path = new Set()) => {
    if (states.has(item.canonicalId)) return states.get(item.canonicalId);
    if (item.parentMissing) { states.set(item.canonicalId, 'orphan_parent'); return 'orphan_parent'; }
    if (!item.parentCanonicalId) { states.set(item.canonicalId, 'valid'); return 'valid'; }
    if (!byId.has(item.parentCanonicalId)) { states.set(item.canonicalId, 'orphan_parent'); return 'orphan_parent'; }
    if (path.has(item.canonicalId)) {
      for (const id of path) states.set(id, 'cycle');
      states.set(item.canonicalId, 'cycle');
      return 'cycle';
    }
    const next = new Set(path); next.add(item.canonicalId);
    const parentState = visit(byId.get(item.parentCanonicalId), next);
    const state = parentState === 'cycle' ? 'cycle' : 'valid';
    states.set(item.canonicalId, state);
    return state;
  };
  for (const item of items) visit(item);
  return states;
}

function rememberMany(contextInput, rawItems, database) {
  const db = database || getDb();
  const context = _context(contextInput);
  if (!Array.isArray(rawItems) || rawItems.length > MAX_SNAPSHOTS) {
    throw new Error(`Provider snapshot inventory must contain at most ${MAX_SNAPSHOTS} items`);
  }
  const observedAt = new Date().toISOString();
  const items = rawItems.map(raw => _input(context, raw, observedAt));
  const refs = new Map(items.map(item => [item.nativeRef, item.canonicalId]));
  for (const item of items) {
    item.parentCanonicalId = item.parentRef ? refs.get(item.parentRef) || null : null;
    item.parentMissing = !!item.parentRef && !item.parentCanonicalId;
  }
  const integrity = _integrity(items);
  const markAbsent = db.prepare(`UPDATE provider_vm_snapshots SET is_present = 0, is_current = 0, updated_at = datetime('now')
    WHERE host_id = ? AND vm_id = ?`);
  const upsert = db.prepare(`INSERT INTO provider_vm_snapshots
    (canonical_id, host_id, vm_id, provider_type, native_ref_hash, native_ref_enc,
     snapshot_uuid, snapshot_name, description, created_at, parent_id, is_current,
     consistency, integrity_state, is_present, observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?)
    ON CONFLICT(canonical_id) DO UPDATE SET
      provider_type=excluded.provider_type, native_ref_hash=excluded.native_ref_hash,
      native_ref_enc=excluded.native_ref_enc, snapshot_uuid=COALESCE(excluded.snapshot_uuid, snapshot_uuid),
      snapshot_name=excluded.snapshot_name, description=excluded.description,
      created_at=COALESCE(excluded.created_at, created_at), parent_id=NULL,
      is_current=excluded.is_current, consistency=excluded.consistency,
      integrity_state=excluded.integrity_state, is_present=1, observed_at=excluded.observed_at,
      updated_at=datetime('now')`);
  const setParent = db.prepare(`UPDATE provider_vm_snapshots SET parent_id = ?, updated_at = datetime('now')
    WHERE canonical_id = ? AND host_id = ? AND vm_id = ?`);
  db.transaction(() => {
    markAbsent.run(context.hostId, context.vmId);
    for (const item of items) {
      upsert.run(item.canonicalId, context.hostId, context.vmId, context.providerType,
        item.nativeRefHash, encrypt(item.nativeRef), item.uuid, item.name, item.description,
        item.createdAt, item.isCurrent ? 1 : 0,
        item.consistency, integrity.get(item.canonicalId) || 'unknown', item.observedAt);
    }
    // Provider APIs do not guarantee parent-before-child ordering. Insert the
    // complete inventory first, then attach edges so immediate SQLite foreign
    // keys cannot reject a valid tree returned in child-first order.
    for (const item of items) {
      if (item.parentCanonicalId) {
        setParent.run(item.parentCanonicalId, item.canonicalId, context.hostId, context.vmId);
      }
    }
  })();
  return list(context.hostId, context.vmId, db);
}

function _public(row) {
  return {
    schemaVersion: '1.0', id: row.canonical_id, vmId: row.vm_id,
    provider: { type: row.provider_type, endpointId: row.host_id },
    name: row.snapshot_name, description: row.description || null,
    createdAt: row.created_at || null, parentId: row.parent_id || null,
    childCount: Number(row.child_count || 0), isCurrent: !!row.is_current,
    consistency: row.consistency, integrity: { state: row.integrity_state },
    protection: {
      isBackup: false, failureDomain: 'provider_storage',
      warning: 'A snapshot is not an independent backup and can be lost with the VM or provider storage',
    },
    observedAt: row.observed_at,
  };
}

function list(hostIdInput, vmIdInput, database) {
  const db = database || getDb();
  const hostId = Number(hostIdInput); const vmId = String(vmIdInput || '');
  if (!Number.isInteger(hostId) || !SAFE_VM_ID.test(vmId)) return [];
  return db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM provider_vm_snapshots child
      WHERE child.parent_id = s.canonical_id AND child.is_present = 1) AS child_count
    FROM provider_vm_snapshots s WHERE s.host_id = ? AND s.vm_id = ? AND s.is_present = 1
    ORDER BY COALESCE(s.created_at, s.first_seen_at) DESC, s.snapshot_name COLLATE NOCASE`).all(hostId, vmId).map(_public);
}

function resolve(snapshotIdInput, scope = {}, database) {
  const db = database || getDb();
  const snapshotId = String(snapshotIdInput || '');
  const hostId = Number(scope.hostId); const vmId = String(scope.vmId || '');
  if (!SAFE_SNAPSHOT_ID.test(snapshotId) || !Number.isInteger(hostId) || !SAFE_VM_ID.test(vmId)) return null;
  const row = db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM provider_vm_snapshots child
      WHERE child.parent_id = s.canonical_id AND child.is_present = 1) AS child_count
    FROM provider_vm_snapshots s WHERE s.canonical_id = ? AND s.host_id = ? AND s.vm_id = ? AND s.is_present = 1`)
    .get(snapshotId, hostId, vmId);
  if (!row) return null;
  return { ..._public(row), nativeRef: decrypt(row.native_ref_enc), uuid: row.snapshot_uuid || null };
}

module.exports = {
  rememberMany, list, resolve, MAX_SNAPSHOTS,
  _internals: { SAFE_SNAPSHOT_ID, _text, _timestamp, _input, _integrity, _public },
};
