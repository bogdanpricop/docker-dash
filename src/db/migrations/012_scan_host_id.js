'use strict';

exports.up = function (db) {
  // Add host_id to scan_results for multi-host filtering
  try {
    db.exec(`ALTER TABLE scan_results ADD COLUMN host_id INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column may already exist
  }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_scan_results_host ON scan_results(host_id, scanned_at)`);
  } catch {}
};
