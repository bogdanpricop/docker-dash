'use strict';

// v8.9.5-alpha.1 — Sprint 10: extend docker_hosts.daemon_type CHECK to
// allow 'nomad'. Same writable_schema in-place edit pattern as 071
// (LXD) — the RENAME + rebuild pattern would corrupt the migration_jobs
// FK from v8.9.2-alpha.1.

exports.up = function (db) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='docker_hosts'`).get();
  if (!row || !row.sql) return;
  if (row.sql.includes(`'nomad'`)) return; // already migrated
  if (!/CHECK\(\s*daemon_type\s+IN/i.test(row.sql)) return;

  // The 071 migration already widened the set to include 'lxd', so the
  // pattern we match here is the post-071 shape.
  const newSql = row.sql.replace(
    /CHECK\(\s*daemon_type\s+IN\s*\(\s*'docker',\s*'podman',\s*'incus',\s*'proxmox',\s*'kubernetes',\s*'lxd'\s*\)\s*\)/i,
    `CHECK(daemon_type IN ('docker', 'podman', 'incus', 'proxmox', 'kubernetes', 'lxd', 'nomad'))`
  );

  if (newSql === row.sql) return; // shape didn't match — safer to no-op than to corrupt

  const escapedSql = newSql.replace(/'/g, `''`);
  const hadUnsafeMode = typeof db.unsafeMode === 'function';
  if (hadUnsafeMode) db.unsafeMode(true);
  const schemaCookie = db.prepare('PRAGMA schema_version').get();
  const newCookie = (schemaCookie && schemaCookie.schema_version || 0) + 1;
  db.exec('PRAGMA writable_schema = ON;');
  try {
    db.exec(`UPDATE sqlite_master SET sql = '${escapedSql}' WHERE type = 'table' AND name = 'docker_hosts';`);
    db.exec(`PRAGMA schema_version = ${newCookie};`);
  } finally {
    db.exec('PRAGMA writable_schema = OFF;');
    if (hadUnsafeMode) db.unsafeMode(false);
  }

  const verifyRow = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='docker_hosts'`).get();
  if (!verifyRow || !verifyRow.sql.includes(`'nomad'`)) {
    throw new Error('072_docker_hosts_add_nomad: writable_schema update did not persist the widened CHECK');
  }
  const integrity = db.prepare('PRAGMA integrity_check').get();
  if (!integrity || integrity.integrity_check !== 'ok') {
    throw new Error(`072_docker_hosts_add_nomad: integrity_check failed: ${JSON.stringify(integrity)}`);
  }
};
