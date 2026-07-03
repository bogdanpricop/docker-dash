'use strict';

// v8.9.3-alpha.1 — Sprint 8: extend docker_hosts.daemon_type CHECK to
// allow 'lxd'.
//
// LXD (Canonical) and Incus (community fork) share the same REST API
// almost entirely — divergence only on features added AFTER the 2024
// fork. Every Incus endpoint we already call (/1.0, /1.0/instances,
// /1.0/operations/{id}/wait, snapshots, projects) works identically on
// LXD. So we reuse IncusClient parametrized with a daemonType flag;
// only the CHECK constraint on daemon_type has to be widened for the
// row to persist.
//
// Why writable_schema and not RENAME + CREATE + INSERT SELECT?
// Because migration_jobs (added in 070) has an FK to docker_hosts(id).
// SQLite ≥ 3.25 rewrites FK targets when we RENAME the referenced
// table, and even with PRAGMA legacy_alter_table = ON the rewrite
// happens under better-sqlite3's build. Result: after the rename dance,
// migration_jobs' FK points at the dropped intermediate table.
//
// PRAGMA writable_schema = 1 lets us edit the docker_hosts CREATE TABLE
// text in sqlite_master directly. No table motion, no FKs disturbed.
// SQLite documents this as safe when the schema shape stays semantically
// compatible — which widening a CHECK IN(...) list absolutely is
// (nothing already persisted becomes invalid).

exports.up = function (db) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='docker_hosts'`).get();
  if (!row || !row.sql) return;
  if (row.sql.includes(`'lxd'`)) return; // already migrated

  if (!/CHECK\(\s*daemon_type\s+IN/i.test(row.sql)) return; // defensive: migration 069 missing → skip

  const newSql = row.sql.replace(
    /CHECK\(\s*daemon_type\s+IN\s*\(\s*'docker',\s*'podman',\s*'incus',\s*'proxmox',\s*'kubernetes'\s*\)\s*\)/i,
    `CHECK(daemon_type IN ('docker', 'podman', 'incus', 'proxmox', 'kubernetes', 'lxd'))`
  );

  if (newSql === row.sql) return;

  // Fetch the current schema_version — writable_schema edits invalidate
  // SQLite's cached schema, so we bump the version to force a reparse.
  const schemaCookie = db.prepare('PRAGMA schema_version').get();
  const newCookie = (schemaCookie && schemaCookie.schema_version || 0) + 1;

  // better-sqlite3 requires unsafeMode(true) before it will let ANY
  // statement touch sqlite_master, even under writable_schema. We flip
  // it on for the duration of this one edit and hard-reset it after.
  // Escape single quotes for inline embedding.
  const escapedSql = newSql.replace(/'/g, `''`);
  const hadUnsafeMode = typeof db.unsafeMode === 'function';
  if (hadUnsafeMode) db.unsafeMode(true);
  db.exec('PRAGMA writable_schema = ON;');
  try {
    db.exec(`UPDATE sqlite_master SET sql = '${escapedSql}' WHERE type = 'table' AND name = 'docker_hosts';`);
    db.exec(`PRAGMA schema_version = ${newCookie};`);
  } finally {
    db.exec('PRAGMA writable_schema = OFF;');
    if (hadUnsafeMode) db.unsafeMode(false);
  }

  // Verify by re-reading sqlite_master and running integrity_check.
  const verifyRow = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='docker_hosts'`).get();
  if (!verifyRow || !verifyRow.sql.includes(`'lxd'`)) {
    throw new Error('071_docker_hosts_add_lxd: writable_schema update did not persist the widened CHECK');
  }
  const integrity = db.prepare('PRAGMA integrity_check').get();
  if (!integrity || integrity.integrity_check !== 'ok') {
    throw new Error(`071_docker_hosts_add_lxd: integrity_check failed after writable_schema edit: ${JSON.stringify(integrity)}`);
  }
};
