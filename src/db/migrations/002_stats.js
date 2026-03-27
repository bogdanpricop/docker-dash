'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE container_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER DEFAULT 0,
      container_id TEXT NOT NULL,
      container_name TEXT,
      cpu_percent REAL,
      mem_usage INTEGER,
      mem_limit INTEGER,
      mem_percent REAL,
      net_rx INTEGER,
      net_tx INTEGER,
      blk_read INTEGER,
      blk_write INTEGER,
      pids INTEGER,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_stats_container ON container_stats(container_id, recorded_at);
    CREATE INDEX idx_stats_time ON container_stats(recorded_at);

    CREATE TABLE container_stats_1m (
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
    CREATE INDEX idx_stats1m_container ON container_stats_1m(container_id, bucket);
    CREATE INDEX idx_stats1m_bucket ON container_stats_1m(bucket);

    CREATE TABLE container_stats_1h (
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
    CREATE INDEX idx_stats1h_container ON container_stats_1h(container_id, bucket);
    CREATE INDEX idx_stats1h_bucket ON container_stats_1h(bucket);

    CREATE TABLE health_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER DEFAULT 0,
      container_id TEXT NOT NULL,
      container_name TEXT,
      status TEXT NOT NULL,
      output TEXT,
      exit_code INTEGER,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_health_container ON health_events(container_id, recorded_at);
  `);
};
