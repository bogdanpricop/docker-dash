'use strict';

const PERMISSIONS = [
  ['edge_sites.manage', 'edge_site', 'manage', 'Manage edge sites, connectivity policies and cached evidence'],
  ['edge_intents.manage', 'edge_intent', 'manage', 'Manage signed offline intents and store-and-forward synchronization'],
  ['edge_agents.manage', 'edge_agent', 'manage', 'Manage edge agent allowlists, signed runbooks and update rings'],
  ['edge_content.manage', 'edge_content', 'manage', 'Manage verified air-gap bootstrap and mirror manifests'],
];

const UPDATE_RINGS = [
  ['canary', 'Canary', 10, 1, 1],
  ['stable', 'Stable', 100, 1, 1],
  ['held', 'Held', 0, 1, 0],
];

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS edge_sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      timezone TEXT NOT NULL,
      region TEXT NOT NULL,
      jurisdiction TEXT NOT NULL,
      local_owner TEXT NOT NULL,
      trust_roots_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','maintenance','retired')),
      config_hash TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_site_hosts (
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('control_plane','worker','storage','gateway','standalone','other')),
      PRIMARY KEY(site_id,host_id),
      UNIQUE(host_id)
    );

    CREATE TABLE IF NOT EXISTS edge_connectivity_policies (
      site_id INTEGER PRIMARY KEY REFERENCES edge_sites(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK(mode IN ('always_online','intermittent','disconnected')),
      max_staleness_seconds INTEGER NOT NULL CHECK(max_staleness_seconds BETWEEN 30 AND 2592000),
      cache_ttl_seconds INTEGER NOT NULL CHECK(cache_ttl_seconds BETWEEN 30 AND 7776000),
      mutation_mode TEXT NOT NULL CHECK(mutation_mode IN ('deny','queue')),
      expected_offline_until TEXT,
      policy_hash TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_read_cache_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      provider_ref TEXT NOT NULL,
      resource_kind TEXT NOT NULL,
      resource_ref TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_offline_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      action_key TEXT NOT NULL,
      target_ref TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      prerequisites_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','expired','revalidation_required','ready_for_agent','cancelled')),
      intent_hash TEXT NOT NULL UNIQUE,
      signature TEXT NOT NULL,
      signature_algorithm TEXT NOT NULL DEFAULT 'hmac-sha256-v1',
      revalidation_json TEXT,
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_heartbeats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK(sequence >= 0),
      status TEXT NOT NULL CHECK(status IN ('healthy','degraded','maintenance')),
      version TEXT,
      capabilities_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      evidence_hash TEXT NOT NULL UNIQUE,
      received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(site_id,agent_id,sequence)
    );

    CREATE TABLE IF NOT EXISTS edge_sync_policies (
      site_id INTEGER PRIMARY KEY REFERENCES edge_sites(id) ON DELETE CASCADE,
      bandwidth_kbps INTEGER NOT NULL CHECK(bandwidth_kbps BETWEEN 8 AND 10000000),
      max_batch_bytes INTEGER NOT NULL CHECK(max_batch_bytes BETWEEN 1024 AND 1073741824),
      priority_order_json TEXT NOT NULL,
      compression TEXT NOT NULL DEFAULT 'deflate-raw' CHECK(compression='deflate-raw'),
      policy_hash TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_event_buffer (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('inventory','event','metric','artifact')),
      occurred_at TEXT NOT NULL,
      compressed_payload BLOB NOT NULL,
      raw_bytes INTEGER NOT NULL CHECK(raw_bytes BETWEEN 2 AND 262144),
      compressed_bytes INTEGER NOT NULL CHECK(compressed_bytes BETWEEN 1 AND 262144),
      payload_hash TEXT NOT NULL,
      event_hash TEXT NOT NULL UNIQUE,
      delivered_at TEXT,
      received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_sync_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      event_ids_json TEXT NOT NULL,
      first_cursor INTEGER,
      last_cursor INTEGER,
      total_bytes INTEGER NOT NULL,
      priority_order_json TEXT NOT NULL,
      plan_hash TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('planned','acknowledged')),
      acknowledged_at TEXT,
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      certificate_fingerprint TEXT NOT NULL,
      runbook_allowlist_json TEXT NOT NULL,
      update_ring TEXT NOT NULL REFERENCES edge_update_rings(slug) ON DELETE RESTRICT,
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','held','revoked')),
      last_sequence INTEGER,
      last_seen_at TEXT,
      version TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(site_id,agent_id)
    );

    CREATE TABLE IF NOT EXISTS edge_runbook_envelopes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL REFERENCES edge_agents(id) ON DELETE CASCADE,
      runbook_key TEXT NOT NULL,
      target_ref TEXT NOT NULL,
      parameters_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      envelope_hash TEXT NOT NULL UNIQUE,
      signature TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'issued' CHECK(state IN ('issued','expired','reported')),
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_update_rings (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      rollout_percent INTEGER NOT NULL CHECK(rollout_percent BETWEEN 0 AND 100),
      require_healthy INTEGER NOT NULL DEFAULT 1,
      automatic_rollback INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_update_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL REFERENCES edge_agents(id) ON DELETE CASCADE,
      ring_slug TEXT NOT NULL REFERENCES edge_update_rings(slug) ON DELETE RESTRICT,
      current_version TEXT,
      target_version TEXT NOT NULL,
      bundle_json TEXT NOT NULL,
      rollback_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      plan_hash TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('planned','blocked')),
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_bootstrap_manifests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      artifacts_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      manifest_hash TEXT NOT NULL UNIQUE,
      signature TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('ready','blocked')),
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_content_mirror_manifests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      source_mirror_ref TEXT NOT NULL,
      items_json TEXT NOT NULL,
      total_bytes INTEGER NOT NULL CHECK(total_bytes BETWEEN 0 AND 109951162777600),
      manifest_hash TEXT NOT NULL UNIQUE,
      signature TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('ready','blocked')),
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_edge_cache_site ON edge_read_cache_entries(site_id,expires_at);
    CREATE INDEX IF NOT EXISTS idx_edge_intents_site ON edge_offline_intents(site_id,state,expires_at);
    CREATE INDEX IF NOT EXISTS idx_edge_heartbeats_site ON edge_heartbeats(site_id,agent_id,sequence);
    CREATE INDEX IF NOT EXISTS idx_edge_events_pending ON edge_event_buffer(site_id,delivered_at,category,id);
  `);

  const permissionInsert = db.prepare(`INSERT OR IGNORE INTO governance_permissions
    (permission_key,resource_type,verb,description) VALUES (?,?,?,?)`);
  for (const permission of PERMISSIONS) permissionInsert.run(...permission);
  const siteAdmin = db.prepare("SELECT id FROM governance_roles WHERE slug='site-admin'").get();
  if (siteAdmin) {
    const grant = db.prepare('INSERT OR IGNORE INTO governance_role_permissions (role_id,permission_key) VALUES (?,?)');
    for (const permission of PERMISSIONS) grant.run(siteAdmin.id, permission[0]);
  }
  const ringInsert = db.prepare(`INSERT OR IGNORE INTO edge_update_rings
    (slug,name,rollout_percent,require_healthy,automatic_rollback) VALUES (?,?,?,?,?)`);
  for (const ring of UPDATE_RINGS) ringInsert.run(...ring);
};

exports._PERMISSIONS = PERMISSIONS;
exports._UPDATE_RINGS = UPDATE_RINGS;
