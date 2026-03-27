'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'POST',
      headers TEXT DEFAULT '{}',
      secret TEXT,
      events TEXT NOT NULL DEFAULT '["*"]',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_id INTEGER NOT NULL REFERENCES webhooks(id),
      event TEXT NOT NULL,
      payload TEXT,
      response_code INTEGER,
      response_body TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      success INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      delivered_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_wh_deliveries ON webhook_deliveries(webhook_id, delivered_at);
  `);
};
