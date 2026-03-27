'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      username TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      details TEXT,
      ip TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_audit_user ON audit_log(user_id, created_at);
    CREATE INDEX idx_audit_action ON audit_log(action, created_at);
    CREATE INDEX idx_audit_target ON audit_log(target_type, target_id);
    CREATE INDEX idx_audit_time ON audit_log(created_at);
  `);
};
