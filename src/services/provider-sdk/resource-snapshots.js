'use strict';

const { getDb } = require('../../db');
const { validateResource } = require('./resource-schema');

const MAX_SNAPSHOT_BYTES = 64 * 1024;
const MAX_SEARCH_QUERY = 120;

function _database(database) { return database || getDb(); }

function _serialize(resource) {
  validateResource(resource);
  const json = JSON.stringify(resource);
  if (Buffer.byteLength(json) > MAX_SNAPSHOT_BYTES) {
    throw new Error(`Normalized provider resource exceeds ${MAX_SNAPSHOT_BYTES} bytes`);
  }
  return json;
}

function rememberMany(resources, database) {
  if (!Array.isArray(resources)) throw new Error('Provider resource snapshots require an array');
  if (!resources.length) return 0;
  const db = _database(database);
  const upsert = db.prepare(`INSERT INTO provider_resource_snapshots
    (canonical_id, host_id, provider_type, resource_kind, display_name, power_state,
     resource_json, observed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(canonical_id) DO UPDATE SET
      host_id = excluded.host_id,
      provider_type = excluded.provider_type,
      resource_kind = excluded.resource_kind,
      display_name = excluded.display_name,
      power_state = excluded.power_state,
      resource_json = excluded.resource_json,
      observed_at = excluded.observed_at,
      updated_at = datetime('now')`);
  for (const resource of resources) {
    const json = _serialize(resource);
    upsert.run(
      resource.id, resource.provider.endpointId, resource.provider.type, resource.kind,
      resource.displayName, resource.status?.powerState || null, json, resource.observedAt
    );
  }
  return resources.length;
}

function get(canonicalId, hostId, resourceKind, database) {
  const id = String(canonicalId || '');
  const endpointId = Number(hostId);
  if (!/^ddr_(vm|host|cluster|storage|network|task)_[a-f0-9]{26}$/.test(id)
      || !Number.isInteger(endpointId) || endpointId <= 0) return null;
  const row = _database(database).prepare(`SELECT resource_json
    FROM provider_resource_snapshots
    WHERE canonical_id = ? AND host_id = ? AND resource_kind = ?`).get(id, endpointId, resourceKind);
  if (!row || Buffer.byteLength(row.resource_json || '') > MAX_SNAPSHOT_BYTES) return null;
  try {
    const resource = JSON.parse(row.resource_json);
    validateResource(resource);
    if (resource.id !== id || resource.provider.endpointId !== endpointId || resource.kind !== resourceKind) return null;
    return resource;
  } catch {
    return null;
  }
}

function search(query, hostIds, limit = 20, database) {
  const term = String(query || '').trim().slice(0, MAX_SEARCH_QUERY);
  const ids = [...new Set((hostIds || []).map(Number)
    .filter(id => Number.isInteger(id) && id > 0))].slice(0, 500);
  const boundedLimit = Math.min(50, Math.max(1, Number(limit) || 20));
  if (term.length < 2 || !ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return _database(database).prepare(`SELECT canonical_id, host_id, provider_type,
      display_name, power_state, observed_at
    FROM provider_resource_snapshots
    WHERE resource_kind = 'virtualMachine'
      AND host_id IN (${placeholders})
      AND display_name LIKE ? ESCAPE '\\' COLLATE NOCASE
    ORDER BY display_name COLLATE NOCASE, host_id
    LIMIT ?`).all(...ids, `%${term.replace(/[\\%_]/g, '\\$&')}%`, boundedLimit)
    .map(row => ({
      id: row.canonical_id, hostId: row.host_id, providerType: row.provider_type,
      displayName: row.display_name, powerState: row.power_state || 'unknown',
      observedAt: row.observed_at,
    }));
}

module.exports = { rememberMany, get, search, MAX_SNAPSHOT_BYTES, MAX_SEARCH_QUERY };
