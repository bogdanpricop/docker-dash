'use strict';

const { getDb } = require('../../db');
const { encrypt, decrypt, sha256 } = require('../../utils/crypto');
const { resourceKind } = require('./resource-catalog');

const SAFE_PROVIDER = /^[a-z][a-z0-9_-]{1,39}$/;
const SAFE_CANONICAL_ID = /^ddr_(vm|host|cluster|storage|network|task)_[a-f0-9]{26}$/;
const STABILITIES = new Set(['stable', 'derived', 'transient']);

function _text(value, max) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).slice(0, max);
}

function remember(input, database) {
  const db = database || getDb();
  const hostId = Number(input?.hostId);
  const providerType = String(input?.providerType || '').toLowerCase();
  const kindInfo = resourceKind(input?.kind);
  const nativeRef = _text(input?.nativeRef, 2048);
  const stability = String(input?.stability || 'derived');
  if (!Number.isInteger(hostId) || hostId <= 0) throw new Error('Resource identity requires a valid endpoint ID');
  if (!SAFE_PROVIDER.test(providerType)) throw new Error('Resource identity requires a safe provider type');
  if (!kindInfo) throw new Error('Resource identity kind is invalid');
  if (!nativeRef) throw new Error('Resource identity requires a native reference');
  if (!STABILITIES.has(stability)) throw new Error('Resource identity stability is invalid');

  const providerUuid = stability === 'transient' ? null : _text(input?.uuid, 512);
  const nativeRefHash = sha256(`${hostId}|${input.kind}|${nativeRef}`);
  const stableIdentity = providerUuid || nativeRef;
  const canonicalId = `ddr_${kindInfo.prefix}_${sha256(`${hostId}|${input.kind}|${stableIdentity}`).slice(0, 26)}`;
  const encryptedRef = encrypt(nativeRef);

  const findUuid = db.prepare(`SELECT canonical_id, native_ref_hash FROM provider_resource_identities
    WHERE host_id = ? AND resource_kind = ? AND provider_uuid = ?`);
  const findRef = db.prepare(`SELECT canonical_id FROM provider_resource_identities
    WHERE host_id = ? AND resource_kind = ? AND native_ref_hash = ?`);
  const update = db.prepare(`UPDATE provider_resource_identities
    SET provider_type = ?, provider_uuid = COALESCE(?, provider_uuid), native_ref_hash = ?,
        native_ref_enc = ?, identity_stability = ?, last_seen_at = datetime('now')
    WHERE canonical_id = ?`);
  const insert = db.prepare(`INSERT INTO provider_resource_identities
    (canonical_id, host_id, provider_type, resource_kind, provider_uuid,
     native_ref_hash, native_ref_enc, identity_stability)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  const storedId = db.transaction(() => {
    const existing = providerUuid ? findUuid.get(hostId, input.kind, providerUuid) : null;
    const byRef = existing || findRef.get(hostId, input.kind, nativeRefHash);
    if (byRef) {
      update.run(providerType, providerUuid, nativeRefHash, encryptedRef, stability, byRef.canonical_id);
      return byRef.canonical_id;
    }
    insert.run(canonicalId, hostId, providerType, input.kind, providerUuid,
      nativeRefHash, encryptedRef, stability);
    return canonicalId;
  })();

  return { id: storedId, uuid: providerUuid, stability };
}

function resolveCanonical(canonicalId, scope = {}, database) {
  const db = database || getDb();
  const hostId = Number(scope.hostId);
  if (!SAFE_CANONICAL_ID.test(String(canonicalId || '')) || !Number.isInteger(hostId) || !resourceKind(scope.kind)) {
    return null;
  }
  const row = db.prepare(`SELECT canonical_id, provider_type, provider_uuid, native_ref_enc, identity_stability
    FROM provider_resource_identities WHERE canonical_id = ? AND host_id = ? AND resource_kind = ?`)
    .get(canonicalId, hostId, scope.kind);
  if (!row) return null;
  return {
    id: row.canonical_id,
    providerType: row.provider_type,
    uuid: row.provider_uuid,
    stability: row.identity_stability,
    nativeRef: decrypt(row.native_ref_enc),
  };
}

module.exports = { remember, resolveCanonical, _internals: { SAFE_CANONICAL_ID } };
