'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS git_credentials (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      auth_type       TEXT NOT NULL CHECK(auth_type IN ('token', 'basic', 'ssh_key')),
      username        TEXT,
      password_encrypted TEXT,
      ssh_private_key_encrypted TEXT,
      ssh_public_key  TEXT,
      created_by      INTEGER NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);
};
