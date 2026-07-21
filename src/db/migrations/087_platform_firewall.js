'use strict';

// v8.11 — Platform (hypervisor) firewall WRITE, Phase A (Proxmox).
//
// Hypervisor hosts (Proxmox/ESXi/Incus) don't use iptables/nftables, so their
// mutations can't live in `firewall_rules` (iptables-shaped). Instead every
// platform firewall mutation is recorded here, alongside a pre-mutation entry
// in `firewall_snapshots` (backend='proxmox') that is the rollback source.
//
// The critical safety property is COMMIT-CONFIRMED auto-revert (the
// network-engineer "reload in 5" pattern): a mutation is applied as
// 'provisional' with a `revert_at` deadline. Unless an admin explicitly
// confirms it (state → 'confirmed', revert_at cleared) the sweep job reverts it
// from the pre-state snapshot — so a change that locks us out un-does itself.
//
// Guarded with a PRAGMA table_info check so re-running during dev is safe
// (mirrors 086_host_connection_health.js).

exports.up = function (db) {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='platform_firewall_changes'"
  ).get();

  if (!exists) {
    db.exec(`
      CREATE TABLE platform_firewall_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
        platform TEXT NOT NULL,                 -- proxmox (esxi/incus in later phases)
        scope TEXT,                             -- 'cluster' | 'node:<node>'
        operation TEXT NOT NULL,                -- 'add-rule' | 'remove-rule' | 'set-options'
        spec TEXT,                              -- JSON of the mutation (normalized rule / options)
        pre_snapshot_id INTEGER REFERENCES firewall_snapshots(id) ON DELETE SET NULL,
        state TEXT NOT NULL DEFAULT 'provisional'
          CHECK(state IN ('provisional', 'confirmed', 'reverted', 'failed')),
        applied_by TEXT,
        applied_at TEXT DEFAULT (datetime('now')),
        revert_at TEXT,                         -- commit-confirmed deadline (NULL once confirmed/terminal)
        confirmed_at TEXT,
        reverted_at TEXT,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_platform_fw_changes_sweep
        ON platform_firewall_changes(state, revert_at);
      CREATE INDEX IF NOT EXISTS idx_platform_fw_changes_host
        ON platform_firewall_changes(host_id, state);
    `);
  }
};
