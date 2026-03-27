'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      token_hash TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL DEFAULT 'reset',
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_reset_tokens_hash ON password_reset_tokens(token_hash);
    CREATE INDEX idx_reset_tokens_user ON password_reset_tokens(user_id);
  `);
};
