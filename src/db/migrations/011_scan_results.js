'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_id TEXT NOT NULL,
      image_name TEXT NOT NULL,
      scanner TEXT NOT NULL,
      summary_critical INTEGER DEFAULT 0,
      summary_high INTEGER DEFAULT 0,
      summary_medium INTEGER DEFAULT 0,
      summary_low INTEGER DEFAULT 0,
      summary_total INTEGER DEFAULT 0,
      fixable_count INTEGER DEFAULT 0,
      results_json TEXT,
      recommendations_json TEXT,
      scanned_by INTEGER REFERENCES users(id),
      scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_scan_image ON scan_results(image_name, scanned_at);
    CREATE INDEX IF NOT EXISTS idx_scan_time ON scan_results(scanned_at);
  `);
};
