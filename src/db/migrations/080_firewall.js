'use strict';

// v8.9.22-alpha.1 — Firewall management (MVP1). Per-host, whitelisted, audited,
// reversible host-OS firewall rules driven from the Firewall page.
// - firewall_rules: app-managed rules (the DB is the source of truth; each rule is
//   tagged on the host with `APPFW uuid=<rule_uuid>` so it can be found/removed
//   idempotently and drift can be detected later).
// - firewall_snapshots: a full backend ruleset dump taken BEFORE every mutation,
//   so a bad change can be rolled back.
// Audit trail reuses the existing tamper-evident auditService (firewall_* actions).

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS firewall_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_uuid TEXT NOT NULL UNIQUE,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      backend TEXT NOT NULL,                 -- iptables | firewalld | ufw | nftables
      scope TEXT NOT NULL,                   -- host | docker | container
      action TEXT NOT NULL,                  -- allow | block
      source_ip TEXT,                        -- IPv4/IPv6/CIDR (nullable = any)
      destination_ip TEXT,
      destination_port INTEGER,              -- 1..65535 (nullable = any)
      protocol TEXT,                         -- tcp | udp | icmp
      chain_name TEXT,                       -- e.g. DOCKER-USER / INPUT
      rule_expression TEXT,                  -- the exact command/expression applied
      comment_tag TEXT,                      -- APPFW uuid=<uuid> ...
      reason TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,                       -- for temporary rules (MVP2 cleanup)
      is_temporary INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      removed_by TEXT,
      removed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_firewall_rules_host_active
      ON firewall_rules(host_id, is_active);
    CREATE INDEX IF NOT EXISTS idx_firewall_rules_expires
      ON firewall_rules(is_active, is_temporary, expires_at);

    CREATE TABLE IF NOT EXISTS firewall_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      backend TEXT NOT NULL,
      snapshot_content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT NOT NULL,
      reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_firewall_snapshots_host_time
      ON firewall_snapshots(host_id, created_at);
  `);
};
