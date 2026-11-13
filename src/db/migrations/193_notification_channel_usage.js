'use strict';

exports.up = function (db) {
  db.exec(`ALTER TABLE notification_channels ADD COLUMN usage TEXT NOT NULL DEFAULT 'all'
    CHECK(usage IN ('all', 'general', 'scheduled_scans'))`);
};
