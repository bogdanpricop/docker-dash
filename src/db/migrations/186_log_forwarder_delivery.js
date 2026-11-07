'use strict';

exports.up = db => db.exec(`
  ALTER TABLE log_forwarders ADD COLUMN last_delivery_at TEXT;
  ALTER TABLE log_forwarders ADD COLUMN last_delivery_error_at TEXT;
  ALTER TABLE log_forwarders ADD COLUMN last_delivery_error_json TEXT;
`);
