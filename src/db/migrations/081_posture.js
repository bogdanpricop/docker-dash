'use strict';

// v8.9.37-alpha.1 — Security Posture. Findings are computed LIVE from existing
// signals (never persisted, to avoid drifting from reality). We persist only:
//   • posture_snapshots — score history for the trend sparkline (like 079).
//   • posture_mutes      — acknowledged/accepted findings (removed from the
//                          score, audited, optionally expiring).

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS posture_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER,                       -- NULL = global rollup
      score INTEGER NOT NULL,
      grade TEXT NOT NULL,
      critical INTEGER NOT NULL DEFAULT 0,
      high INTEGER NOT NULL DEFAULT 0,
      medium INTEGER NOT NULL DEFAULT 0,
      low INTEGER NOT NULL DEFAULT 0,
      captured_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_posture_snapshots_time
      ON posture_snapshots(host_id, captured_at);

    CREATE TABLE IF NOT EXISTS posture_mutes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      finding_key TEXT NOT NULL UNIQUE,      -- stable hash of checkId+hostId+subject
      host_id INTEGER,
      check_id TEXT,
      reason TEXT,
      muted_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_posture_mutes_expiry
      ON posture_mutes(expires_at);
  `);
};
