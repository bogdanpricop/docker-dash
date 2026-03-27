'use strict';

exports.up = function (db) {
  // Multi-file compose support
  try { db.exec(`ALTER TABLE git_stacks ADD COLUMN additional_files TEXT`); } catch {}
  // additional_files: JSON array of compose file paths, e.g. ["docker-compose.yml","docker-compose.prod.yml"]
  // When set, takes precedence over compose_path for -f flags
};
