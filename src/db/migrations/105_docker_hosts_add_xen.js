'use strict';

// Extend the strict docker_hosts.daemon_type domain with the unified Xen
// provider. Runtime compatibility (XO / XAPI JSON or XML / raw libxl) lives in
// daemon_config and is capability-detected by src/services/xen.js.

exports.up = function (db) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='docker_hosts'`).get();
  if (!row || !row.sql || row.sql.includes(`'xen'`)) return;
  if (!/CHECK\(\s*daemon_type\s+IN/i.test(row.sql)) return;

  const oldDomain = /CHECK\(\s*daemon_type\s+IN\s*\(\s*'docker',\s*'podman',\s*'incus',\s*'proxmox',\s*'kubernetes',\s*'lxd',\s*'nomad',\s*'vsphere'\s*\)\s*\)/i;
  const newSql = row.sql.replace(oldDomain,
    `CHECK(daemon_type IN ('docker', 'podman', 'incus', 'proxmox', 'kubernetes', 'lxd', 'nomad', 'vsphere', 'xen'))`
  );
  if (newSql === row.sql) throw new Error('105: current docker_hosts daemon_type constraint was not recognized');

  const escapedSql = newSql.replace(/'/g, `''`);
  const hadUnsafeMode = typeof db.unsafeMode === 'function';
  if (hadUnsafeMode) db.unsafeMode(true);
  const schemaCookie = db.prepare('PRAGMA schema_version').get();
  const nextCookie = (schemaCookie?.schema_version || 0) + 1;
  db.exec('PRAGMA writable_schema = ON;');
  try {
    db.exec(`UPDATE sqlite_master SET sql = '${escapedSql}' WHERE type = 'table' AND name = 'docker_hosts';`);
    db.exec(`PRAGMA schema_version = ${nextCookie};`);
  } finally {
    db.exec('PRAGMA writable_schema = OFF;');
    if (hadUnsafeMode) db.unsafeMode(false);
  }

  const verify = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='docker_hosts'`).get();
  if (!verify?.sql?.includes(`'xen'`)) throw new Error('105: Xen daemon type was not persisted');
  const integrity = db.prepare('PRAGMA integrity_check').get();
  if (integrity?.integrity_check !== 'ok') {
    throw new Error(`105: integrity_check failed: ${JSON.stringify(integrity)}`);
  }
};
