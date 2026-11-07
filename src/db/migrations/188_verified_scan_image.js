'use strict';

exports.up = db => {
  db.exec(`ALTER TABLE scan_results ADD COLUMN verified_image_id TEXT;
    CREATE INDEX idx_scan_results_verified_image ON scan_results(host_id, verified_image_id, scanned_at);`);
};
