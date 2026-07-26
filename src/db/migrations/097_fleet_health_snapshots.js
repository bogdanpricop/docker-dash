'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fleet_health_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bucket TEXT NOT NULL UNIQUE,
      total_hosts INTEGER NOT NULL,
      connected INTEGER NOT NULL,
      degraded INTEGER NOT NULL,
      disconnected INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_fleet_health_created
      ON fleet_health_snapshots(created_at DESC);
  `);
};
