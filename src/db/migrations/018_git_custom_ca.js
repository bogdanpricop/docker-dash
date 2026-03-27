'use strict';

exports.up = function (db) {
  // Custom CA certificate for self-hosted Git servers (alternative to tls_skip_verify)
  try { db.exec(`ALTER TABLE git_stacks ADD COLUMN custom_ca_cert TEXT`); } catch {}
};
