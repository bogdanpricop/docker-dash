'use strict';

exports.up = function (db) {
  // Add auth_source column to users table (local | ldap)
  // Add auth_source column so we can distinguish local vs LDAP users
  db.exec(`ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local';`);
};

exports.down = function (db) {
  // SQLite does not support DROP COLUMN before version 3.35
  // Settings table removal
  db.exec(`DROP TABLE IF EXISTS settings;`);
};
