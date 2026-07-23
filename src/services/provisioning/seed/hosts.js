'use strict';

// v8.17.0 (Onboarding — Phase 3) — synthetic docker_hosts + host_groups.
//
// SYNTHETIC-ONLY CHOKEPOINTS (onboarding-security.md §3, TC-12):
//   * every address comes from `rng.rfc1918()` — a demo host can never map to a
//     reachable machine;
//   * every FQDN ends in `.test` (RFC 6761) — it cannot resolve;
//   * every credential is a fake string written through the REAL crypto path
//     (`encryptSshConfig` → AES-256-GCM), so no plaintext-secret column ever
//     holds a bare value even in demo mode.
//
// Seeded hosts are `is_default = 0` and carry `seed_run_id`, which is exactly the
// tag the mock docker adapter (seed/mock-docker.js) keys on. Real hosts (NULL)
// are never routed to the mock.

const { encryptSshConfig } = require('../../host-config-crypto');
const { encrypt } = require('../../../utils/crypto');
const { HOST_ROLES, HOST_GROUP_NAMES } = require('./words');

const GROUP_COLORS = ['#6366f1', '#0ea5e9', '#22c55e', '#f59e0b', '#ef4444', '#a855f7'];
const GROUP_ICONS = ['fa-server', 'fa-industry', 'fa-network-wired', 'fa-shield-halved'];

function _uniqueName(db, table, column, base) {
  const stmt = db.prepare(`SELECT 1 AS ok FROM ${table} WHERE ${column} = ? COLLATE NOCASE`);
  let name = base;
  let n = 1;
  while (stmt.get(name)) { n += 1; name = `${base}-${n}`; }
  return name;
}

function generate(ctx) {
  const { db, rng, datasetId, profile, scenario, org, pool } = ctx;

  const ins = db.prepare(`
    INSERT INTO docker_hosts (
      name, connection_type, socket_path, host, port, tls_config, ssh_config,
      is_active, is_default, last_seen_at, created_at, updated_at,
      daemon_type, daemon_config,
      conn_state, conn_failures, conn_last_error, conn_last_error_at,
      conn_reachable, conn_paused, conn_paused_reason, conn_paused_at,
      seed_run_id
    ) VALUES (?, 'ssh', '/var/run/docker.sock', ?, NULL, NULL, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const hosts = [];
  const roles = rng.shuffle(HOST_ROLES);
  for (let i = 0; i < profile.hosts; i++) {
    const role = roles[i % roles.length];
    const idx = String(Math.floor(i / roles.length) + 1).padStart(2, '0');
    const name = _uniqueName(db, 'docker_hosts', 'name', `${role}-${idx}`);
    const fqdn = `${name}.${org.slug}.test`;              // RFC 6761 reserved TLD
    const ip = rng.rfc1918();                              // RFC 1918 chokepoint
    const daemonType = rng.weighted(scenario.daemonMix.map(([v, w]) => [v, w]));
    const connState = i === 0 ? 'ok' : rng.weighted(scenario.connStates.map(([v, w]) => [v, w]));
    const reachable = connState === 'ok' ? 1 : 0;
    const paused = connState === 'auth_failed' ? 1 : 0;
    const createdAt = rng.dateBetween(ctx.nowMs - 400 * 864e5, ctx.nowMs - 20 * 864e5);
    const lastSeen = connState === 'ok'
      ? rng.dateBetween(ctx.nowMs - 6 * 36e5, ctx.nowMs)
      : rng.dateBetween(ctx.nowMs - 9 * 864e5, ctx.nowMs - 36e5);

    // Fake credential → REAL crypto path (AES-256-GCM), never plaintext at rest.
    const sshConfig = encryptSshConfig({
      host: ip,
      port: 22,
      username: 'demo-ops',
      password: `placeholder-${rng.hex(16)}`,   // non-functional by construction
      dockerSocket: '/var/run/docker.sock',
    });
    // daemon_config stays parseable JSON (the incus/proxmox services read it);
    // the only secret inside it is itself encrypted.
    const daemonConfig = JSON.stringify({
      seeded: true,
      fqdn,
      site: rng.pick(pool.cities),
      apiTokenEnc: encrypt(`placeholder-token-${rng.hex(12)}`),
    });

    const id = Number(ins.run(
      name, ip, sshConfig, lastSeen, createdAt, createdAt,
      daemonType, daemonConfig,
      connState,
      connState === 'ok' ? 0 : rng.int(1, 9),
      connState === 'ok' ? null : `demo: ${connState.replace('_', ' ')}`,
      connState === 'ok' ? null : lastSeen,
      reachable, paused,
      paused ? 'credentials rejected (demo)' : null,
      paused ? lastSeen : null,
      datasetId,
    ).lastInsertRowid);

    hosts.push({ id, name, fqdn, ip, daemonType, connState, createdAt });
  }
  ctx.count('docker_hosts', hosts.length);
  ctx.refs.hosts = hosts;
  return { count: hosts.length };
}

/** host_groups + host_group_members (runs after hosts + users). */
function generateGroups(ctx) {
  const { db, rng, datasetId, profile, refs } = ctx;
  if (!refs.hosts.length) return { count: 0 };
  const createdBy = refs.users.length ? rng.pick(refs.users).id : null;

  // Timestamps are written EXPLICITLY everywhere (never left to the
  // datetime('now') DEFAULT), so the dataset never depends on wall-clock.
  const insGroup = db.prepare(`
    INSERT INTO host_groups (name, description, color, icon, sort_order, created_by, created_at, updated_at, seed_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insMember = db.prepare(
    'INSERT OR IGNORE INTO host_group_members (group_id, host_id, added_at, seed_run_id) VALUES (?, ?, ?, ?)',
  );

  const groups = [];
  const names = rng.shuffle(HOST_GROUP_NAMES);
  for (let i = 0; i < profile.hostGroups; i++) {
    const name = _uniqueName(db, 'host_groups', 'name', names[i % names.length]);
    const at = rng.dateBetween(ctx.nowMs - 300 * 864e5, ctx.nowMs - 20 * 864e5);
    const id = Number(insGroup.run(
      name, `Synthetic demo group (${name})`,
      GROUP_COLORS[i % GROUP_COLORS.length], GROUP_ICONS[i % GROUP_ICONS.length], i, createdBy, at, at, datasetId,
    ).lastInsertRowid);
    groups.push({ id, name, at });
  }

  // Round-robin so every host belongs to exactly one group (deterministic).
  let members = 0;
  refs.hosts.forEach((h, i) => {
    const g = groups[i % groups.length];
    const r = insMember.run(g.id, h.id, g.at, datasetId);
    if (r.changes) members += 1;
  });

  ctx.count('host_groups', groups.length);
  ctx.count('host_group_members', members);
  ctx.refs.hostGroups = groups;
  return { count: groups.length + members };
}

module.exports = { generate, generateGroups };
