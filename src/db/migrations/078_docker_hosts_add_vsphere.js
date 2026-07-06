'use strict';

// v8.9.11-alpha.1 — Add 'vsphere' to docker_hosts.daemon_type CHECK.
// Covers both standalone ESXi and vCenter Server — same SOAP API surface.
// Same writable_schema pattern as 071/072.

exports.up = function (db) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='docker_hosts'`).get();
  if (!row || !row.sql) return;
  if (row.sql.includes(`'vsphere'`)) return;
  if (!/CHECK\(\s*daemon_type\s+IN/i.test(row.sql)) return;

  const newSql = row.sql.replace(
    /CHECK\(\s*daemon_type\s+IN\s*\(\s*'docker',\s*'podman',\s*'incus',\s*'proxmox',\s*'kubernetes',\s*'lxd',\s*'nomad'\s*\)\s*\)/i,
    `CHECK(daemon_type IN ('docker', 'podman', 'incus', 'proxmox', 'kubernetes', 'lxd', 'nomad', 'vsphere'))`
  );
  if (newSql === row.sql) return;

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
  if (!verifyRow || !verifyRow.sql.includes(`'vsphere'`)) {
    throw new Error('078: writable_schema update did not persist');
  }
  const integrity = db.prepare('PRAGMA integrity_check').get();
  if (!integrity || integrity.integrity_check !== 'ok') {
    throw new Error(`078: integrity_check failed: ${JSON.stringify(integrity)}`);
  }
};
