'use strict';

// v8.9.13-alpha.1 — vSphere host metric history for the Trends tab.
// A lightweight poller (src/services/vsphere-history.js) inserts one row per
// vSphere host every poll interval; the Trends UI renders an SVG sparkline.
// Modeled on the SOS ESXi Monitor's snapshot table (which feeds ITS chart);
// SOS does not use vSphere PerformanceManager/QueryPerf and neither do we.

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vsphere_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      esxi_host TEXT,              -- ESXi host name (vCenter can have many)
      cpu_pct REAL,
      mem_pct REAL,
      mem_used_mb INTEGER,
      mem_total_mb INTEGER,
      vm_total INTEGER,
      vm_running INTEGER,
      ds_total_gb REAL,
      ds_used_gb REAL,
      uptime_sec INTEGER,
      captured_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_vsphere_snapshots_host_time
      ON vsphere_snapshots(host_id, captured_at);
  `);
};
