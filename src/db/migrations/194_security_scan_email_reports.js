'use strict';

exports.up = function (db) {
  db.exec(`
    ALTER TABLE security_scan_schedules ADD COLUMN report_format TEXT NOT NULL DEFAULT 'summary'
      CHECK(report_format IN ('summary', 'detailed'));
    ALTER TABLE security_scan_runs ADD COLUMN report_format TEXT NOT NULL DEFAULT 'summary'
      CHECK(report_format IN ('summary', 'detailed'));
  `);
};
