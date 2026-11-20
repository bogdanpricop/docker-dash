'use strict';

exports.up = db => db.exec("ALTER TABLE ai_compute_hosts ADD COLUMN connection_info_json TEXT NOT NULL DEFAULT '{}'");
