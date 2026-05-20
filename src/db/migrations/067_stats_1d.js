'use strict';

// v8.4.0 — 4th stats tier: daily rollup for 30d+ metric ranges.
// Before this, the '30d' query range pointed at container_stats_1h, which is
// purged at 7 days — so 30d charts silently returned only 7 days of data.
// This adds container_stats_1d (rolled up from 1h, retained 90 days) and the
// '30d' range now reads from it.

exports.up = function (db) {
  db.exec(`
    CREATE TABLE container_stats_1d (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER DEFAULT 0,
      container_id TEXT NOT NULL,
      container_name TEXT,
      cpu_avg REAL, cpu_max REAL,
      mem_avg INTEGER, mem_max INTEGER, mem_limit INTEGER,
      net_rx_total INTEGER, net_tx_total INTEGER,
      blk_read_total INTEGER, blk_write_total INTEGER,
      pids_avg REAL,
      sample_count INTEGER NOT NULL DEFAULT 0,
      bucket TEXT NOT NULL
    );
    CREATE INDEX idx_stats1d_bucket ON container_stats_1d(bucket);
    CREATE UNIQUE INDEX idx_stats1d_container_bucket ON container_stats_1d(container_id, bucket);
  `);
};
